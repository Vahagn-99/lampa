/*!
 * SegmentSource — feeds Lampa's segments engine with intro / recap / credits / preview timestamps
 *
 * Data provider for Lampa's built-in segments engine
 * (vendor/lampa-source/src/interaction/player/segments.js, since Lampa 3.0.0).
 * No UI of its own — toggles live in the player's native gear menu under
 * "Сегменты" → "Пропуск" (Авто / Вручную / Откл).
 *
 * Tier 1: read MKV chapter metadata directly from the file via HTTP Range
 *         to the local TorrServe stream URL.
 * Tier 2: TheIntroDB v2 (api.theintrodb.org/v2/media) when chapters are absent.
 *
 * Replaces the legacy autoskip plugin; on first run it cleans up the v1
 * storage keys it leaves behind (skip_intro_*, skip_intro_smart, and the
 * per-episode localStorage cache).
 *
 * Scope:
 *   - TorrServe streams only (other backends are a no-op).
 *   - MKV containers only in v2.0; MP4 chapter parsing deferred to v2.1.
 *   - Requires Lampa.Manifest.app_digital >= 300.
 */
(function () {
    "use strict";

    if (window.__segmentSourceLoaded) return;
    window.__segmentSourceLoaded = true;

    /* ---------- constants ---------- */

    var LOG_PREFIX = "[SegmentSource]";
    var MIN_APP_DIGITAL = 300;
    var MKV_HEAD_BYTES = 3 * 1024 * 1024;       /* 3 MB Range window */
    var MKV_SAFETY_BYTES = 16 * 1024 * 1024;    /* abort if server ignores Range and floods us */
    var FETCH_TIMEOUT_MS = 5000;
    var API_TIMEOUT_MS = 5000;
    var CACHE_TTL_MS = 30 * 24 * 3600 * 1000;   /* 30 days */
    var CACHE_PREFIX = "segsrc_ch_";
    var MIGRATION_KEY = "segsrc_v1_purged";
    var INTRODB_BASE = "https://api.theintrodb.org/v2/media";

    var V1_STORAGE_KEYS = [
        "skip_intro_enabled",
        "skip_intro_auto",
        "skip_intro_type_intro",
        "skip_intro_type_recap",
        "skip_intro_type_credits",
        "skip_intro_type_preview",
        "skip_intro_smart"
    ];
    var V1_CACHE_REGEX = /^skip_\d+_s\d+_e\d+$/;

    /* ---------- logging ---------- */

    function log() {
        var args = [LOG_PREFIX];
        for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
        try { console.log.apply(console, args); } catch (e) {}
    }

    /* ---------- v1 -> v2 migration ---------- */

    function migrate() {
        try {
            var marker = Lampa.Storage.get(MIGRATION_KEY, "");
            if (marker === 1 || marker === "1") return;

            for (var i = 0; i < V1_STORAGE_KEYS.length; i++) {
                try { Lampa.Storage.set(V1_STORAGE_KEYS[i], ""); } catch (_) {}
            }

            var removed = 0;
            try {
                var purge = [];
                for (var k = 0; k < localStorage.length; k++) {
                    var key = localStorage.key(k);
                    if (key && V1_CACHE_REGEX.test(key)) purge.push(key);
                }
                for (var j = 0; j < purge.length; j++) {
                    localStorage.removeItem(purge[j]);
                    removed++;
                }
            } catch (_) {}

            Lampa.Storage.set(MIGRATION_KEY, 1);
            log("migration_done", "v1_keys", V1_STORAGE_KEYS.length, "ls_keys", removed);
        } catch (e) {
            log("migration_error", e && e.message);
        }
    }

    /* ---------- URL classifier ----------
     * TorrServe stream URL shape (from vendor/lampa-source/src/interaction/torserver.js:127):
     *   {host}/stream/{filename}?link={infohash}&index={fileIndex}&{preload|play}
     */

    function classifyUrl(url) {
        var out = { kind: "other", infohash: null, fileIndex: null };
        if (!url || typeof url !== "string") return out;

        var pathMatch = url.match(/^https?:\/\/[^\/]+(\/[^?#]*)/i);
        var path = pathMatch ? pathMatch[1] : "";
        var torrPath = path.indexOf("/stream") === 0 || path.indexOf("/play") === 0;

        var linkMatch = url.match(/[?&](?:link|hash)=([^&#]+)/i);
        var indexMatch = url.match(/[?&]index=(\d+)/i);

        if (torrPath || linkMatch) {
            out.kind = "torrserve";
            out.infohash = linkMatch ? decodeURIComponent(linkMatch[1]) : null;
            out.fileIndex = indexMatch ? parseInt(indexMatch[1], 10) : null;
        }
        return out;
    }

    /* ---------- EBML / MKV parser ----------
     * Element IDs include their leading marker bit, matching the canonical hex
     * values used in the matroska spec (e.g. 0x1A45DFA3 for the EBML header).
     */

    var ID_EBML              = 0x1A45DFA3;
    var ID_SEGMENT           = 0x18538067;
    var ID_INFO              = 0x1549A966;
    var ID_TIMECODE_SCALE    = 0x2AD7B1;
    var ID_CHAPTERS          = 0x1043A770;
    var ID_EDITION_ENTRY     = 0x45B9;
    var ID_CHAPTER_ATOM      = 0xB6;
    var ID_CHAPTER_TIME_START = 0x91;
    var ID_CHAPTER_TIME_END  = 0x92;
    var ID_CHAPTER_DISPLAY   = 0x80;
    var ID_CHAP_STRING       = 0x85;
    var ID_CLUSTER           = 0x1F43B675;

    function readVint(view, offset, end) {
        if (offset >= end) return null;
        var first = view.getUint8(offset);
        if (first === 0) return null;
        var width = 1;
        var mask = 0x80;
        while ((first & mask) === 0) {
            width++;
            mask = mask >> 1;
            if (width > 8 || mask === 0) return null;
        }
        if (offset + width > end) return null;
        var value = first & (mask - 1);
        for (var i = 1; i < width; i++) {
            value = value * 256 + view.getUint8(offset + i);
        }
        return { value: value, length: width };
    }

    function readElementId(view, offset, end) {
        if (offset >= end) return null;
        var first = view.getUint8(offset);
        if (first === 0) return null;
        var width = 1;
        var mask = 0x80;
        while ((first & mask) === 0) {
            width++;
            mask = mask >> 1;
            if (width > 4 || mask === 0) return null;
        }
        if (offset + width > end) return null;
        var id = first;
        for (var i = 1; i < width; i++) {
            id = id * 256 + view.getUint8(offset + i);
        }
        return { id: id, length: width };
    }

    function readElementHeader(view, offset, end) {
        var idR = readElementId(view, offset, end);
        if (!idR) return null;
        var sizeOffset = offset + idR.length;
        var sizeR = readVint(view, sizeOffset, end);
        if (!sizeR) return null;
        return {
            id: idR.id,
            dataStart: sizeOffset + sizeR.length,
            dataLength: sizeR.value,
            headerSize: idR.length + sizeR.length
        };
    }

    function readUint(view, offset, length) {
        var v = 0;
        for (var i = 0; i < length; i++) v = v * 256 + view.getUint8(offset + i);
        return v;
    }

    function readUtf8(view, offset, length) {
        var bytes = [];
        for (var i = 0; i < length; i++) bytes.push(view.getUint8(offset + i));
        return decodeUtf8(bytes);
    }

    function decodeUtf8(bytes) {
        var s = "";
        var i = 0;
        var n = bytes.length;
        while (i < n) {
            var b = bytes[i];
            var code, take;
            if (b < 0x80) { code = b; take = 1; }
            else if ((b & 0xE0) === 0xC0) {
                code = ((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
                take = 2;
            } else if ((b & 0xF0) === 0xE0) {
                code = ((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F);
                take = 3;
            } else if ((b & 0xF8) === 0xF0) {
                code = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) |
                       ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
                take = 4;
            } else { code = 0xFFFD; take = 1; }
            if (code <= 0xFFFF) s += String.fromCharCode(code);
            else {
                code -= 0x10000;
                s += String.fromCharCode(0xD800 | (code >> 10));
                s += String.fromCharCode(0xDC00 | (code & 0x3FF));
            }
            i += take;
        }
        return s;
    }

    /* ChapterTimeStart / End are stored in raw nanoseconds per matroska spec
     * ("Matroska Ticks"), independent of the cluster TimecodeScale. */
    var SEC_PER_NS = 1e-9;

    function parseChapters(buffer) {
        if (!buffer || buffer.byteLength < 16) return [];
        var view;
        try { view = new DataView(buffer); } catch (_) { return []; }
        var size = buffer.byteLength;

        /* skip EBML header */
        var hdr = readElementHeader(view, 0, size);
        if (!hdr || hdr.id !== ID_EBML) return [];
        var pos = hdr.dataStart + hdr.dataLength;

        /* find Segment */
        while (pos < size) {
            hdr = readElementHeader(view, pos, size);
            if (!hdr) return [];
            if (hdr.id === ID_SEGMENT) break;
            pos = hdr.dataStart + hdr.dataLength;
        }
        if (!hdr || hdr.id !== ID_SEGMENT) return [];

        var segmentStart = hdr.dataStart;
        var segmentEnd = Math.min(size, hdr.dataStart + hdr.dataLength);

        /* walk Segment children up to (but not into) Cluster */
        var chaptersRange = null;
        pos = segmentStart;
        while (pos < segmentEnd) {
            var h = readElementHeader(view, pos, segmentEnd);
            if (!h) break;
            if (h.id === ID_CLUSTER) break;
            if (h.id === ID_CHAPTERS) {
                if (h.dataStart + h.dataLength <= size) {
                    chaptersRange = { start: h.dataStart, end: h.dataStart + h.dataLength };
                    break;
                } else {
                    /* Chapters element extends past fetched window */
                    return [];
                }
            }
            pos = h.dataStart + h.dataLength;
            if (pos > segmentEnd) break;
        }

        if (!chaptersRange) return [];

        /* Chapters -> EditionEntry -> ChapterAtom */
        var atoms = [];
        var cpos = chaptersRange.start;
        var cend = chaptersRange.end;
        while (cpos < cend) {
            var ch = readElementHeader(view, cpos, cend);
            if (!ch) break;
            if (ch.id === ID_EDITION_ENTRY) {
                var eend = Math.min(size, ch.dataStart + ch.dataLength);
                var epos = ch.dataStart;
                while (epos < eend) {
                    var ea = readElementHeader(view, epos, eend);
                    if (!ea) break;
                    if (ea.id === ID_CHAPTER_ATOM) {
                        var atom = parseChapterAtom(view, ea.dataStart, ea.dataStart + ea.dataLength);
                        if (atom) atoms.push(atom);
                    }
                    epos = ea.dataStart + ea.dataLength;
                }
            }
            cpos = ch.dataStart + ch.dataLength;
        }

        /* Derive missing end times from next sibling; last gets MAX_SAFE_INTEGER. */
        for (var k = 0; k < atoms.length; k++) {
            if (atoms[k].end == null) {
                if (k + 1 < atoms.length) atoms[k].end = atoms[k + 1].start;
                else atoms[k].end = Number.MAX_SAFE_INTEGER || 9007199254740991;
            }
        }

        return atoms;
    }

    function parseChapterAtom(view, start, end) {
        var startTime = null, endTime = null, title = null;
        var pos = start;
        while (pos < end) {
            var h = readElementHeader(view, pos, end);
            if (!h) break;
            if (h.id === ID_CHAPTER_TIME_START) {
                startTime = readUint(view, h.dataStart, h.dataLength) * SEC_PER_NS;
            } else if (h.id === ID_CHAPTER_TIME_END) {
                endTime = readUint(view, h.dataStart, h.dataLength) * SEC_PER_NS;
            } else if (h.id === ID_CHAPTER_DISPLAY) {
                var dend = Math.min(end, h.dataStart + h.dataLength);
                var dpos = h.dataStart;
                while (dpos < dend) {
                    var dh = readElementHeader(view, dpos, dend);
                    if (!dh) break;
                    if (dh.id === ID_CHAP_STRING && title === null) {
                        title = readUtf8(view, dh.dataStart, dh.dataLength);
                    }
                    dpos = dh.dataStart + dh.dataLength;
                }
            }
            pos = h.dataStart + h.dataLength;
        }
        if (startTime === null) return null;
        return { start: startTime, end: endTime, title: title || "" };
    }

    /* ---------- Range fetch ---------- */

    function fetchHead(url, byteLimit, timeoutMs) {
        return new Promise(function (resolve) {
            var done = false;
            var xhr = new XMLHttpRequest();
            try {
                xhr.open("GET", url, true);
                xhr.responseType = "arraybuffer";
                xhr.setRequestHeader("Range", "bytes=0-" + (byteLimit - 1));
            } catch (_) {
                log("mkv_fetch_open_failed");
                resolve(null);
                return;
            }
            var timer = setTimeout(function () {
                if (done) return;
                done = true;
                try { xhr.abort(); } catch (_) {}
                log("mkv_fetch_timeout");
                resolve(null);
            }, timeoutMs);
            xhr.onload = function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                /* 206 partial content (expected) or 200 (server ignored Range) */
                if (xhr.status === 206 || xhr.status === 200) {
                    var buf = xhr.response;
                    if (!buf) { log("mkv_fetch_empty"); resolve(null); return; }
                    if (xhr.status === 200 && buf.byteLength > MKV_SAFETY_BYTES) {
                        log("mkv_fetch_oversize", buf.byteLength);
                        resolve(null);
                        return;
                    }
                    resolve(buf);
                } else {
                    log("mkv_fetch_http", xhr.status);
                    resolve(null);
                }
            };
            xhr.onerror = function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                log("mkv_fetch_network");
                resolve(null);
            };
            xhr.onabort = function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(null);
            };
            try { xhr.send(); }
            catch (e) {
                done = true;
                clearTimeout(timer);
                log("mkv_fetch_send_failed", e && e.message);
                resolve(null);
            }
        });
    }

    /* ---------- Chapter title classifier ----------
     * Case-insensitive whole-word containment. Matches common decorations
     * (OP1, OP_Theme, Opening Sequence, End Credits 2, Next Episode Preview, ...)
     * and discards generic / structural labels.
     */

    function classifyChapter(title) {
        if (!title) return null;
        /* Normalise: collapse non-alphanumeric runs to single spaces, lowercase. */
        var t = (" " + title + " ").toLowerCase().replace(/[^a-z0-9]+/g, " ");
        if (t.length < 3) return null;

        /* Discard generic patterns first so e.g. "Chapter 1" doesn't accidentally
         * match the 'p' in "op". */
        if (/\bchapter\s*\d+\b/.test(t) && !/\b(op|opening|intro|recap|ending|ed|credits|preview|eyecatch)\b/.test(t)) return null;
        if (/\bact\s*\d+\b/.test(t)) return null;
        if (/^\s*episode(\s+\d+)?\s*$/.test(t)) return null;
        if (/^\s*part\s*\d+\s*$/.test(t)) return null;

        /* Recognised types (ordered by specificity). */
        if (/\b(recap|previously|story\s+so\s+far)\b/.test(t)) return "recap";

        if (/\b(opening|intro|main\s+title)\b/.test(t)) return "intro";
        if (/\bop\b/.test(t)) return "intro";        /* OP, OP1, OP_Theme — alphanumeric collapse leaves "op" */
        if (/\bop\d+\b/.test(t)) return "intro";

        if (/\b(end\s*credits|credits|ending|outro)\b/.test(t)) return "credits";
        if (/\bed\b/.test(t)) return "credits";
        if (/\bed\d+\b/.test(t)) return "credits";

        if (/\b(preview|eyecatch|next\s+episode|next)\b/.test(t)) return "preview";

        return null;
    }

    /* ---------- TheIntroDB v2 fallback ---------- */

    function fetchIntroDb(tmdbId, season, episode, timeoutMs) {
        return new Promise(function (resolve) {
            if (!tmdbId || season == null || episode == null) {
                resolve([]);
                return;
            }
            var url = INTRODB_BASE + "?tmdb_id=" + encodeURIComponent(tmdbId) +
                      "&season=" + encodeURIComponent(season) +
                      "&episode=" + encodeURIComponent(episode);
            var done = false;
            var xhr = new XMLHttpRequest();
            try {
                xhr.open("GET", url, true);
                xhr.setRequestHeader("Accept", "application/json");
            } catch (_) { resolve([]); return; }
            var timer = setTimeout(function () {
                if (done) return;
                done = true;
                try { xhr.abort(); } catch (_) {}
                log("api_timeout");
                resolve([]);
            }, timeoutMs);
            xhr.onload = function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (xhr.status === 204 || xhr.status === 404) { resolve([]); return; }
                if (xhr.status < 200 || xhr.status >= 300) {
                    log("api_http", xhr.status);
                    resolve([]);
                    return;
                }
                var json;
                try { json = JSON.parse(xhr.responseText); }
                catch (e) { log("api_parse"); resolve([]); return; }
                resolve(normaliseIntroDb(json));
            };
            xhr.onerror = function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                log("api_network");
                resolve([]);
            };
            try { xhr.send(); }
            catch (e) { done = true; clearTimeout(timer); resolve([]); }
        });
    }

    function normaliseIntroDb(json) {
        var out = [];
        if (!json) return out;
        var types = ["intro", "recap", "credits", "preview"];
        for (var i = 0; i < types.length; i++) {
            var key = types[i];
            var arr = json[key];
            if (!arr || !arr.length) continue;
            for (var j = 0; j < arr.length; j++) {
                var seg = arr[j];
                /* Both shapes seen in real responses: start_ms/end_ms (v2 ms) and start/end (v1 sec). */
                var startSec = seg.start_ms != null ? seg.start_ms / 1000 : seg.start;
                var endSec = seg.end_ms != null ? seg.end_ms / 1000 : seg.end;
                if (startSec == null || endSec == null) continue;
                if (endSec <= startSec) continue;
                out.push({ start: startSec, end: endSec, type: key });
            }
        }
        return out;
    }

    /* ---------- per-(infohash, fileIndex) cache ---------- */

    function cacheKey(infohash, fileIndex) {
        var idx = (fileIndex == null) ? 0 : fileIndex;
        return CACHE_PREFIX + infohash + "_" + idx;
    }

    function cacheGet(key) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return null;
            var obj = JSON.parse(raw);
            if (!obj || !obj._ts) return null;
            if (Date.now() - obj._ts > CACHE_TTL_MS) {
                try { localStorage.removeItem(key); } catch (_) {}
                return null;
            }
            return obj.segments || [];
        } catch (e) { return null; }
    }

    function cacheSet(key, segments) {
        try {
            localStorage.setItem(key, JSON.stringify({
                segments: segments || [],
                _ts: Date.now()
            }));
        } catch (e) {
            log("cache_quota", e && e.message);
        }
    }

    /* ---------- meta extractor (TMDB id / season / episode) ---------- */

    function extractMeta(data) {
        var meta = { tmdb_id: null, season: null, episode: null };
        if (!data) return meta;

        var card = data.card || null;
        if (!card) {
            try {
                var act = Lampa.Activity.active();
                if (act) {
                    if (act.card) card = act.card;
                    else if (act.movie) card = act.movie;
                }
            } catch (_) {}
        }
        if (card) meta.tmdb_id = card.id || null;

        if (data.season != null) meta.season = parseInt(data.season, 10);
        if (data.episode != null) meta.episode = parseInt(data.episode, 10);

        if ((meta.season == null || meta.episode == null) && data.title) {
            var m = ("" + data.title).match(/[Ss](\d+)[Ee](\d+)/);
            if (m) {
                if (meta.season == null) meta.season = parseInt(m[1], 10);
                if (meta.episode == null) meta.episode = parseInt(m[2], 10);
            }
        }

        if (data.playlist && data.playlist.length) {
            for (var i = 0; i < data.playlist.length; i++) {
                var p = data.playlist[i];
                if (!p) continue;
                if (p.url === data.url || i === 0) {
                    if (p.season != null && meta.season == null) meta.season = parseInt(p.season, 10);
                    if (p.episode != null && meta.episode == null) meta.episode = parseInt(p.episode, 10);
                    if (p.s != null && meta.season == null) meta.season = parseInt(p.s, 10);
                    if (p.e != null && meta.episode == null) meta.episode = parseInt(p.e, 10);
                    if (p.url === data.url) break;
                }
            }
        }

        return meta;
    }

    /* ---------- pipeline ---------- */

    function flattenToSkip(typed) {
        var out = [];
        if (!typed || !typed.length) return out;
        for (var i = 0; i < typed.length; i++) {
            var s = typed[i];
            if (s == null || s.start == null || s.end == null) continue;
            if (!isFinite(s.start) || isNaN(s.start)) continue;
            if (typeof s.end !== "number" || isNaN(s.end)) continue;
            if (s.end <= s.start) continue;
            out.push({ start: s.start, end: s.end });
        }
        return out;
    }

    function loadSegments(data) {
        return new Promise(function (resolve) {
            var url = data && data.url;
            var cls = classifyUrl(url);
            if (cls.kind !== "torrserve") {
                resolve(null);
                return;
            }
            log("classify torrserve", "infohash", cls.infohash || "?",
                "index", cls.fileIndex == null ? "?" : cls.fileIndex);

            var ckey = null;
            if (cls.infohash) {
                ckey = cacheKey(cls.infohash, cls.fileIndex);
                var cached = cacheGet(ckey);
                if (cached !== null) {
                    log("cache_hit", cached.length);
                    resolve(cached);
                    return;
                }
            }

            /* Tier 1: MKV chapters via Range to TorrServe */
            fetchHead(url, MKV_HEAD_BYTES, FETCH_TIMEOUT_MS).then(function (buf) {
                var atoms = [];
                if (buf) {
                    try { atoms = parseChapters(buf); }
                    catch (e) { log("mkv_parse_error", e && e.message); atoms = []; }
                }
                var typed = [];
                for (var i = 0; i < atoms.length; i++) {
                    var t = classifyChapter(atoms[i].title);
                    if (t) typed.push({ start: atoms[i].start, end: atoms[i].end, type: t });
                }

                if (typed.length) {
                    log("mkv_chapters", typed.length);
                    var skip = flattenToSkip(typed);
                    if (ckey) cacheSet(ckey, skip);
                    resolve(skip);
                    return;
                }

                /* Tier 2: TheIntroDB fallback */
                var meta = extractMeta(data);
                if (!meta.tmdb_id || meta.season == null || meta.episode == null) {
                    log("no_segments");
                    if (ckey) cacheSet(ckey, []);
                    resolve([]);
                    return;
                }
                fetchIntroDb(meta.tmdb_id, meta.season, meta.episode, API_TIMEOUT_MS)
                    .then(function (apiTyped) {
                        var skip2 = flattenToSkip(apiTyped);
                        if (skip2.length) log("api_fallback", skip2.length);
                        else log("no_segments");
                        if (ckey) cacheSet(ckey, skip2);
                        resolve(skip2);
                    });
            });
        });
    }

    /* ---------- bootstrap ---------- */

    function init() {
        migrate();

        /* Feature-detect: segments engine shipped in Lampa core 3.0.0
         * (vendor/lampa-source commit 4c902df4, src/interaction/player/segments.js). */
        var ver = (Lampa.Manifest && typeof Lampa.Manifest.app_digital === "number")
                  ? Lampa.Manifest.app_digital : 0;
        if (ver < MIN_APP_DIGITAL) {
            log("segments_unsupported", "app_digital=" + ver);
            return;
        }

        Lampa.Player.listener.follow("create", function (e) {
            if (!e || !e.data) return;
            /* Race-loss design: design.md D8.
             * We start the fetch here and mutate e.data.segments when it resolves.
             * If Segments.set(data.segments) fires first (very fast preload paths),
             * this play has no segments injected; the cache populates and the next
             * play of the same (infohash, fileIndex) is a synchronous hit. We do
             * NOT call e.abort() — making the player wait on metadata is worse UX. */
            loadSegments(e.data).then(function (skip) {
                if (skip == null) return;
                if (!e.data.segments) e.data.segments = {};
                e.data.segments.skip = skip;
            });
        });

        log("init_ok", "app_digital=" + ver);
    }

    function bootWhenReady() {
        if (window.Lampa && Lampa.SettingsApi && Lampa.Player && Lampa.Storage &&
            Lampa.Player.listener && Lampa.Manifest) {
            init();
        } else {
            setTimeout(bootWhenReady, 500);
        }
    }

    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow("app", function (e) {
            if (e.type === "ready") bootWhenReady();
        });
        setTimeout(bootWhenReady, 1000);
    } else {
        var pollHandle = setInterval(function () {
            if (window.Lampa && Lampa.Listener) {
                clearInterval(pollHandle);
                Lampa.Listener.follow("app", function (e) {
                    if (e.type === "ready") bootWhenReady();
                });
                setTimeout(bootWhenReady, 1000);
            }
        }, 300);
    }
})();
