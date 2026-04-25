/*!
 * SegmentSource — feeds Lampa's segments engine with intro / recap / credits / preview timestamps
 *
 * Data provider for the built-in segments engine in Lampa core
 * (vendor/lampa-source/src/interaction/player/segments.js, requires Lampa
 * 3.0.0+, app_digital >= 300). The plugin owns no UI of its own — the
 * per-show toggle lives in the native player gear menu under
 * "Сегменты" → "Пропуск" (Авто / Вручную / Откл). Lampa core handles the
 * time-based skip, the timeline marker, and the "Пропущено" toast; we are
 * just the data source.
 *
 * Three tiers of detection, fastest-to-slowest, applied in order:
 *
 *   Tier 1  semantic MKV chapter labels       (Opening / OP / Recap / End Credits / …)
 *   Tier 2  embedded subtitle track heuristics ("Previously on" + opening-gap)
 *   Tier 3  TheIntroDB v2 metadata API        (api.theintrodb.org/v2/media)
 *
 * Scope:
 *   • TorrServe streams only — non-torrent backends are a silent no-op.
 *   • MKV / WebM containers; MP4 chapter parsing not yet supported.
 *
 * Single ES5 IIFE, no build step, no runtime dependencies beyond
 * window.Lampa. Single-file plugin per the lampa-plugins repo conventions.
 */
(function () {
    "use strict";

    if (window.__segmentSourceLoaded) return;
    window.__segmentSourceLoaded = true;

    /* ====================================================================
     * Const  —  every magic number/string in one place
     * ================================================================== */

    var Const = {
        LOG_PREFIX:          "[SegmentSource]",
        MIN_APP_DIGITAL:     300,                       /* Lampa 3.0.0 introduces the segments engine */
        HEAD_RANGE_BYTES:    24 * 1024 * 1024,          /* covers ~4-5 min of cluster data — enough to see post-intro episode body subs */
        SAFETY_BYTES:        64 * 1024 * 1024,          /* abort if server ignored Range and floods past this */
        FETCH_TIMEOUT_MS:    22000,                     /* 24 MB over Wi-Fi: ~5-15s; 22s gives slack for slow links */
        API_TIMEOUT_MS:      5000,
        CACHE_TTL_MS:        30 * 24 * 3600 * 1000,     /* 30 days */
        CACHE_PREFIX:        "segsrc_ch_",              /* schema: { segments: [{start,end}], _ts: ms } */
        INTRODB_URL:         "https://api.theintrodb.org/v2/media",

        /* Subtitle-tier heuristics */
        SUB_SCAN_HORIZON_S:  300,                       /* ignore subs past 5 min of episode time */
        SUB_RECAP_REGEX:     /(previously\s+on|в\s+предыдущ|ранее\s+в\b|story\s+so\s+far|в\s+прошл[ыо][хм]\s+сери)/i,
        SUB_DENSE_GAP_S:     15,                        /* recap can have internal cuts of 5-15s between clips */
        SUB_RECAP_MIN_S:     5,
        SUB_RECAP_MAX_S:     180,                       /* full recap+intro merge can run up to 3 min */
        SUB_INTRO_GAP_MIN_S: 20,                        /* a quiet stretch ≥ 20s after recap = likely opening credits */
        SUB_INTRO_GAP_MAX_S: 120,
        SUB_INTRO_BEFORE_S:  180                        /* intro must start within first 3 min */
    };

    /* ====================================================================
     * Log  —  leveled, structured, correlation-aware
     *
     * Every line lands as:
     *   [SegmentSource] cid=ab12 op=mkv.chapters.found segments=5 duration_ms=43
     *
     * Log levels (info default; warn/error always shown):
     *   debug  detailed tracing, muted in normal use
     *   info   one-line per significant operation
     *   warn   recoverable anomaly (timeout, parse skipped)
     *   error  exception that broke a tier
     * ================================================================== */

    var Log = (function () {
        var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
        var minLevel = LEVELS.info;

        function safeStringify(v) {
            if (v == null) return "";
            if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
            if (typeof v === "object") {
                try { return JSON.stringify(v); } catch (_) { return "[object]"; }
            }
            return String(v);
        }

        function format(op, fields) {
            var parts = [Const.LOG_PREFIX, "op=" + op];
            if (fields) {
                for (var k in fields) {
                    if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
                    var v = fields[k];
                    if (v === undefined) continue;
                    parts.push(k + "=" + safeStringify(v));
                }
            }
            return parts.join(" ");
        }

        /* Direct shipper — POST to log-server.py at the endpoint stored
         * under `log_collector_endpoint`. We bypass the log-collector
         * plugin's console.log monkey-patch entirely because Lampa core
         * re-wraps console.log ~1s after boot
         * (vendor/lampa-source/src/interaction/console.js Timer.add(1000)),
         * which silently strips the patch. Without this direct path, only
         * the very first synchronous emit of the plugin lands in the log
         * file and everything async (every pipeline run) is invisible. */
        function ship(level, msg) {
            var endpoint = "";
            try { endpoint = Lampa.Storage.get("log_collector_endpoint", "") || ""; }
            catch (_) { return; }
            if (!endpoint || typeof endpoint !== "string") return;

            var url = endpoint.replace(/\/+$/, "") + "/log";
            var body = JSON.stringify({
                ts: Date.now(), level: level,
                prefix: Const.LOG_PREFIX, msg: msg
            });

            /* Beacon — fire-and-forget, doesn't block, survives unload. */
            try {
                if (navigator.sendBeacon) {
                    var blob = new Blob([body], { type: "application/json" });
                    if (navigator.sendBeacon(url, blob)) return;
                }
            } catch (_) {}
            /* XHR fallback for environments without sendBeacon. */
            try {
                var xhr = new XMLHttpRequest();
                xhr.open("POST", url, true);
                xhr.setRequestHeader("Content-Type", "application/json");
                xhr.send(body);
            } catch (_) {}
        }

        function emit(level, op, fields) {
            if (LEVELS[level] < minLevel) return;
            var line = format(op, fields);
            try {
                if (level === "error" || level === "warn") console.warn(line);
                else console.log(line);
            } catch (_) {}
            ship(level, line);
        }

        return {
            setLevel: function (name) { if (LEVELS[name] != null) minLevel = LEVELS[name]; },
            debug:    function (op, f) { emit("debug", op, f); },
            info:     function (op, f) { emit("info",  op, f); },
            warn:     function (op, f) { emit("warn",  op, f); },
            error:    function (op, f) { emit("error", op, f); },
            newCid:   function () { return Math.random().toString(36).slice(2, 8); }
        };
    })();

    /* ====================================================================
     * Storage  —  cache abstraction over localStorage
     *
     * Why not Lampa.Storage: Lampa.Storage entries surface in the user-
     * visible Settings export and are synced through Cube. A per-episode
     * chapter cache would balloon both. localStorage is private to the
     * device and ephemeral, which is exactly what we want.
     * ================================================================== */

    var Storage = (function () {
        function get(key) {
            try {
                var raw = localStorage.getItem(key);
                if (!raw) return null;
                var obj = JSON.parse(raw);
                if (!obj || typeof obj._ts !== "number") return null;
                if (Date.now() - obj._ts > Const.CACHE_TTL_MS) {
                    localStorage.removeItem(key);
                    return null;
                }
                return obj.segments == null ? [] : obj.segments;
            } catch (_) { return null; }
        }

        function set(key, segments) {
            try {
                localStorage.setItem(key, JSON.stringify({
                    segments: segments || [],
                    _ts: Date.now()
                }));
            } catch (e) {
                Log.warn("storage.write_failed", { key: key, err: e && e.message });
            }
        }

        function key(infohash, fileIndex) {
            return Const.CACHE_PREFIX + (infohash || "anon") + "_" + (fileIndex == null ? 0 : fileIndex);
        }

        return { get: get, set: set, key: key };
    })();

    /* ====================================================================
     * Url  —  TorrServe stream URL classification
     *
     * Reference: vendor/lampa-source/src/interaction/torserver.js:127
     *   `${host}/stream/${name}?link=${infohash}&index=${idx}&{preload|play}`
     *
     * We accept both `link=` and `hash=` query param names — different
     * TorrServe forks use either.
     * ================================================================== */

    var Url = (function () {
        var TORR_PATH_RX  = /^\/(?:stream|play)/i;
        var INFOHASH_RX   = /[?&](?:link|hash)=([^&#]+)/i;
        var INDEX_RX      = /[?&]index=(\d+)/i;
        var PRELOAD_TOKEN = "&preload";

        function classify(url) {
            var out = { kind: "other", infohash: null, fileIndex: null };
            if (!url || typeof url !== "string") return out;
            var pathMatch = url.match(/^https?:\/\/[^\/]+(\/[^?#]*)/i);
            var path = pathMatch ? pathMatch[1] : "";
            var hasTorrPath = TORR_PATH_RX.test(path);
            var infohashM = url.match(INFOHASH_RX);
            var indexM = url.match(INDEX_RX);
            if (hasTorrPath || infohashM) {
                out.kind = "torrserve";
                out.infohash = infohashM ? decodeURIComponent(infohashM[1]) : null;
                out.fileIndex = indexM ? parseInt(indexM[1], 10) : null;
            }
            return out;
        }

        /* TorrServe behaviour: a `&preload` flag tells the server "warm the
         * cache, don't stream". Response is HTTP 200 with a zero-byte body —
         * useless for byte-level reading. Rewrite to `&play` to receive real
         * stream bytes. */
        function toPlayable(url) {
            return url.indexOf(PRELOAD_TOKEN) !== -1
                ? url.replace(PRELOAD_TOKEN, "&play")
                : url;
        }

        return { classify: classify, toPlayable: toPlayable };
    })();

    /* ====================================================================
     * Ebml  —  pure parsing primitives over a DataView
     *
     * Variable-length integer (vint) per matroska spec: leading 1-bit marks
     * width (1..8 bytes); remaining bits + following bytes form the value.
     * Element IDs are vints with the leading marker bit *preserved* —
     * canonical IDs in the spec (0x1A45DFA3, 0x18538067, ...) include the
     * marker, which is how we match them.
     * ================================================================== */

    var Ebml = (function () {
        function readVint(view, offset, end) {
            if (offset >= end) return null;
            var first = view.getUint8(offset);
            if (first === 0) return null;
            var width = 1, mask = 0x80;
            while ((first & mask) === 0) {
                width++;
                mask >>= 1;
                if (width > 8 || mask === 0) return null;
            }
            if (offset + width > end) return null;
            var value = first & (mask - 1);
            for (var i = 1; i < width; i++) value = value * 256 + view.getUint8(offset + i);
            return { value: value, length: width };
        }

        function readId(view, offset, end) {
            if (offset >= end) return null;
            var first = view.getUint8(offset);
            if (first === 0) return null;
            var width = 1, mask = 0x80;
            while ((first & mask) === 0) {
                width++;
                mask >>= 1;
                if (width > 4 || mask === 0) return null;
            }
            if (offset + width > end) return null;
            var id = first;
            for (var i = 1; i < width; i++) id = id * 256 + view.getUint8(offset + i);
            return { id: id, length: width };
        }

        function readHeader(view, offset, end) {
            var idR = readId(view, offset, end);
            if (!idR) return null;
            var sizeR = readVint(view, offset + idR.length, end);
            if (!sizeR) return null;
            return {
                id: idR.id,
                dataStart: offset + idR.length + sizeR.length,
                dataLength: sizeR.value
            };
        }

        function readUint(view, offset, length) {
            var v = 0;
            for (var i = 0; i < length; i++) v = v * 256 + view.getUint8(offset + i);
            return v;
        }

        function readUtf8(view, offset, length) {
            var s = "";
            var i = 0;
            while (i < length) {
                var b = view.getUint8(offset + i);
                var code, take;
                if (b < 0x80) { code = b; take = 1; }
                else if ((b & 0xE0) === 0xC0) {
                    code = ((b & 0x1F) << 6) | (view.getUint8(offset + i + 1) & 0x3F);
                    take = 2;
                } else if ((b & 0xF0) === 0xE0) {
                    code = ((b & 0x0F) << 12)
                         | ((view.getUint8(offset + i + 1) & 0x3F) << 6)
                         | (view.getUint8(offset + i + 2) & 0x3F);
                    take = 3;
                } else if ((b & 0xF8) === 0xF0) {
                    code = ((b & 0x07) << 18)
                         | ((view.getUint8(offset + i + 1) & 0x3F) << 12)
                         | ((view.getUint8(offset + i + 2) & 0x3F) << 6)
                         | (view.getUint8(offset + i + 3) & 0x3F);
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

        /* Matroska element IDs we care about. */
        var Id = {
            EBML:           0x1A45DFA3,
            SEGMENT:        0x18538067,
            INFO:           0x1549A966,
            TIMECODE_SCALE: 0x2AD7B1,
            TRACKS:         0x1654AE6B,
            TRACK_ENTRY:    0xAE,
            TRACK_NUMBER:   0xD7,
            TRACK_TYPE:     0x83,
            CODEC_ID:       0x86,
            LANGUAGE:       0x22B59C,
            TRACK_NAME:     0x536E,
            CHAPTERS:       0x1043A770,
            EDITION_ENTRY:  0x45B9,
            CHAPTER_ATOM:   0xB6,
            CHAPTER_TIME_START: 0x91,
            CHAPTER_TIME_END:   0x92,
            CHAPTER_DISPLAY:    0x80,
            CHAP_STRING:        0x85,
            CLUSTER:        0x1F43B675,
            CLUSTER_TIMECODE: 0xE7,
            SIMPLE_BLOCK:   0xA3,
            BLOCK_GROUP:    0xA0,
            BLOCK:          0xA1,
            BLOCK_DURATION: 0x9B
        };

        /* Track types per matroska spec. */
        var TrackType = { VIDEO: 0x01, AUDIO: 0x02, SUBTITLE: 0x11 };

        /* Bootstrap a parse: return { view, segmentStart, segmentEnd, timecodeScale }
         * or null when the buffer doesn't even look like a usable MKV head. */
        function openSegment(buffer) {
            if (!buffer || buffer.byteLength < 16) return null;
            var view;
            try { view = new DataView(buffer); } catch (_) { return null; }
            var size = buffer.byteLength;

            var ebml = readHeader(view, 0, size);
            if (!ebml || ebml.id !== Id.EBML) return null;

            var pos = ebml.dataStart + ebml.dataLength;
            var seg = null;
            while (pos < size) {
                var h = readHeader(view, pos, size);
                if (!h) return null;
                if (h.id === Id.SEGMENT) { seg = h; break; }
                pos = h.dataStart + h.dataLength;
            }
            if (!seg) return null;

            var segStart = seg.dataStart;
            var segEnd = Math.min(size, seg.dataStart + seg.dataLength);
            var tcScale = findTimecodeScale(view, segStart, segEnd);
            return { view: view, segmentStart: segStart, segmentEnd: segEnd, timecodeScale: tcScale };
        }

        /* Walk Segment children up to the first Cluster, looking for Info →
         * TimecodeScale. Defaults to 1ms (1_000_000 ns) if absent. */
        function findTimecodeScale(view, segStart, segEnd) {
            var pos = segStart;
            while (pos < segEnd) {
                var h = readHeader(view, pos, segEnd);
                if (!h) break;
                if (h.id === Id.CLUSTER) break;
                if (h.id === Id.INFO) {
                    var ip = h.dataStart;
                    var iend = h.dataStart + h.dataLength;
                    while (ip < iend) {
                        var ih = readHeader(view, ip, iend);
                        if (!ih) break;
                        if (ih.id === Id.TIMECODE_SCALE) {
                            return readUint(view, ih.dataStart, ih.dataLength);
                        }
                        ip = ih.dataStart + ih.dataLength;
                    }
                    return 1000000;
                }
                pos = h.dataStart + h.dataLength;
            }
            return 1000000;
        }

        /* Find an element by ID at depth-1 inside Segment. Walks up to but
         * not into the first Cluster. Returns the header or null. */
        function findInSegment(view, segStart, segEnd, wantId) {
            var pos = segStart;
            while (pos < segEnd) {
                var h = readHeader(view, pos, segEnd);
                if (!h) return null;
                if (h.id === Id.CLUSTER) return null;       /* past the metadata head */
                if (h.id === wantId) return h;
                pos = h.dataStart + h.dataLength;
            }
            return null;
        }

        return {
            readVint: readVint,
            readId: readId,
            readHeader: readHeader,
            readUint: readUint,
            readUtf8: readUtf8,
            openSegment: openSegment,
            findInSegment: findInSegment,
            Id: Id,
            TrackType: TrackType
        };
    })();

    /* ====================================================================
     * MkvChapters  —  ChapterAtom extraction
     *
     * Returns [{ start: seconds, end: seconds | null, title: string }].
     * End times absent in the file are derived from the next sibling's
     * start (last sibling defaults to MAX_SAFE_INTEGER, which Lampa core
     * clamps to video.duration at skip time).
     * ================================================================== */

    var MkvChapters = (function () {
        var Id = Ebml.Id;

        function parse(buffer) {
            var open = Ebml.openSegment(buffer);
            if (!open) return [];
            var view = open.view;
            var size = view.byteLength;

            var chapters = Ebml.findInSegment(view, open.segmentStart, open.segmentEnd, Id.CHAPTERS);
            if (!chapters) return [];
            if (chapters.dataStart + chapters.dataLength > size) return [];   /* truncated — give up */

            var atoms = [];
            var cpos = chapters.dataStart;
            var cend = chapters.dataStart + chapters.dataLength;

            while (cpos < cend) {
                var ch = Ebml.readHeader(view, cpos, cend);
                if (!ch) break;
                if (ch.id === Id.EDITION_ENTRY) {
                    var ep = ch.dataStart;
                    var eend = Math.min(size, ch.dataStart + ch.dataLength);
                    while (ep < eend) {
                        var ea = Ebml.readHeader(view, ep, eend);
                        if (!ea) break;
                        if (ea.id === Id.CHAPTER_ATOM) {
                            var atom = parseAtom(view, ea.dataStart, ea.dataStart + ea.dataLength);
                            if (atom) atoms.push(atom);
                        }
                        ep = ea.dataStart + ea.dataLength;
                    }
                }
                cpos = ch.dataStart + ch.dataLength;
            }

            for (var k = 0; k < atoms.length; k++) {
                if (atoms[k].end == null) {
                    atoms[k].end = (k + 1 < atoms.length)
                        ? atoms[k + 1].start
                        : (Number.MAX_SAFE_INTEGER || 9007199254740991);
                }
            }
            return atoms;
        }

        function parseAtom(view, start, end) {
            var startTime = null, endTime = null, title = null;
            var pos = start;
            var SEC_PER_NS = 1e-9;
            while (pos < end) {
                var h = Ebml.readHeader(view, pos, end);
                if (!h) break;
                if (h.id === Id.CHAPTER_TIME_START)
                    startTime = Ebml.readUint(view, h.dataStart, h.dataLength) * SEC_PER_NS;
                else if (h.id === Id.CHAPTER_TIME_END)
                    endTime = Ebml.readUint(view, h.dataStart, h.dataLength) * SEC_PER_NS;
                else if (h.id === Id.CHAPTER_DISPLAY) {
                    var dend = h.dataStart + h.dataLength;
                    var dpos = h.dataStart;
                    while (dpos < dend) {
                        var dh = Ebml.readHeader(view, dpos, dend);
                        if (!dh) break;
                        if (dh.id === Id.CHAP_STRING && title === null)
                            title = Ebml.readUtf8(view, dh.dataStart, dh.dataLength);
                        dpos = dh.dataStart + dh.dataLength;
                    }
                }
                pos = h.dataStart + h.dataLength;
            }
            return startTime === null ? null : { start: startTime, end: endTime, title: title || "" };
        }

        return { parse: parse };
    })();

    /* ====================================================================
     * ChapterClassify  —  semantic label → segment type
     *
     * Discards generic structural labels ("Chapter 1", "Episode", "Act 2")
     * so we never skip inside the body of a show. Recognises the common
     * vocabulary used by anime fansubs (OP/ED/Eyecatch) and Western TV
     * release groups (Recap/Main Title/End Credits/Outro).
     * ================================================================== */

    var ChapterClassify = (function () {
        var GENERIC_RX = [
            /\bchapter\s*\d+\b/,
            /\bact\s*\d+\b/,
            /^\s*episode(\s+\d+)?\s*$/,
            /^\s*part\s*\d+\s*$/
        ];
        var INTRO_RX  = [/\b(opening|intro|main\s+title)\b/, /\bop\b/, /\bop\d+\b/];
        var CREDITS_RX = [/\b(end\s*credits|credits|ending|outro)\b/, /\bed\b/, /\bed\d+\b/];
        var RECAP_RX  = [/\b(recap|previously|story\s+so\s+far)\b/];
        var PREVIEW_RX = [/\b(preview|eyecatch|next\s+episode|next)\b/];

        function classify(title) {
            if (!title) return null;
            /* normalise: collapse runs of non-alphanum to single spaces, lowercase. */
            var t = (" " + title + " ").toLowerCase().replace(/[^a-z0-9]+/g, " ");
            if (t.length < 3) return null;

            /* Generic-only labels are discarded — UNLESS they accidentally include
             * one of our known keywords (e.g. "Chapter 1: Intro"). */
            var hasKeyword = INTRO_RX.concat(CREDITS_RX, RECAP_RX, PREVIEW_RX)
                .some(function (rx) { return rx.test(t); });
            for (var g = 0; g < GENERIC_RX.length; g++) {
                if (GENERIC_RX[g].test(t) && !hasKeyword) return null;
            }

            if (anyMatch(RECAP_RX, t))   return "recap";
            if (anyMatch(INTRO_RX, t))   return "intro";
            if (anyMatch(CREDITS_RX, t)) return "credits";
            if (anyMatch(PREVIEW_RX, t)) return "preview";
            return null;
        }

        function anyMatch(rxs, t) {
            for (var i = 0; i < rxs.length; i++) if (rxs[i].test(t)) return true;
            return false;
        }

        return { classify: classify };
    })();

    /* ====================================================================
     * MkvSubtitles  —  subtitle-track extraction from the head buffer
     *
     * We walk Tracks to find S_TEXT/* subtitle entries, pick the best one
     * (Russian → English → first), then walk Clusters to extract block
     * payloads for that track. Returns [{ time: seconds, text: string }].
     *
     * S_TEXT/UTF8 payloads are plain text; S_TEXT/ASS payloads are ASS
     * dialog rows with 8 metadata fields followed by the actual text —
     * cleanText() handles both.
     * ================================================================== */

    var MkvSubtitles = (function () {
        var Id = Ebml.Id;
        var TrackType = Ebml.TrackType;

        function findTracks(view, segStart, segEnd) {
            var tracks = Ebml.findInSegment(view, segStart, segEnd, Id.TRACKS);
            if (!tracks) return [];
            var size = view.byteLength;
            var entries = [];
            var p = tracks.dataStart;
            var end = Math.min(size, tracks.dataStart + tracks.dataLength);
            while (p < end) {
                var entry = Ebml.readHeader(view, p, end);
                if (!entry) break;
                if (entry.id === Id.TRACK_ENTRY) {
                    var t = parseTrackEntry(view, entry.dataStart, Math.min(size, entry.dataStart + entry.dataLength));
                    if (t.type === TrackType.SUBTITLE && t.codecID && t.codecID.indexOf("S_TEXT") === 0) {
                        entries.push(t);
                    }
                }
                p = entry.dataStart + entry.dataLength;
            }
            return entries;
        }

        function parseTrackEntry(view, start, end) {
            var t = { trackNumber: null, type: null, codecID: null, language: null, name: null };
            var p = start;
            while (p < end) {
                var h = Ebml.readHeader(view, p, end);
                if (!h) break;
                switch (h.id) {
                    case Id.TRACK_NUMBER: t.trackNumber = Ebml.readUint(view, h.dataStart, h.dataLength); break;
                    case Id.TRACK_TYPE:   t.type        = Ebml.readUint(view, h.dataStart, h.dataLength); break;
                    case Id.CODEC_ID:     t.codecID     = Ebml.readUtf8(view, h.dataStart, h.dataLength); break;
                    case Id.LANGUAGE:     t.language    = Ebml.readUtf8(view, h.dataStart, h.dataLength); break;
                    case Id.TRACK_NAME:   t.name        = Ebml.readUtf8(view, h.dataStart, h.dataLength); break;
                }
                p = h.dataStart + h.dataLength;
            }
            return t;
        }

        function pickBest(tracks) {
            if (!tracks.length) return null;
            var ru = null, en = null;
            for (var i = 0; i < tracks.length; i++) {
                var lang = (tracks[i].language || "").toLowerCase();
                if (!ru && (lang === "rus" || lang === "ru")) ru = tracks[i];
                if (!en && (lang === "eng" || lang === "en" || lang === "")) en = tracks[i];
            }
            return ru || en || tracks[0];
        }

        function cleanText(raw, codecID) {
            if (!raw) return "";
            var s = raw;
            if (codecID && codecID.indexOf("ASS") !== -1) {
                /* ASS dialog payload: 8 comma-separated metadata fields, then text. */
                var commas = 0, cut = 0;
                for (var i = 0; i < s.length && commas < 8; i++) {
                    if (s.charAt(i) === ",") { commas++; cut = i + 1; }
                }
                if (commas >= 8) s = s.substring(cut);
                s = s.replace(/\{[^}]*\}/g, "");        /* {\an8}, {\i1} markup */
                s = s.replace(/\\N/g, " ");
            }
            s = s.replace(/<[^>]*>/g, "");              /* HTML-style italics, fonts */
            s = s.replace(/\r\n|\r|\n/g, " ");
            s = s.replace(/\s+/g, " ").trim();
            return s;
        }

        function extractSamples(view, segStart, segEnd, trackNumber, codecID, tcScaleNs) {
            var size = view.byteLength;
            var horizonNs = Const.SUB_SCAN_HORIZON_S * 1e9;
            var samples = [];
            var pos = segStart;
            while (pos < segEnd && pos < size) {
                var h = Ebml.readHeader(view, pos, segEnd);
                if (!h) break;
                if (h.id === Id.CLUSTER) {
                    if (extractFromCluster(view, h, trackNumber, codecID, tcScaleNs, horizonNs, samples, size)) {
                        return samples;     /* horizon reached */
                    }
                }
                pos = h.dataStart + h.dataLength;
                if (pos > segEnd) break;
            }
            return samples;
        }

        /* Returns true when SUB_SCAN_HORIZON_S exceeded — caller should stop walking. */
        function extractFromCluster(view, cluster, trackNumber, codecID, tcScaleNs, horizonNs, samples, size) {
            var clEnd = Math.min(size, cluster.dataStart + cluster.dataLength);
            var cp = cluster.dataStart;
            var clusterTC = 0;
            while (cp < clEnd) {
                var bh = Ebml.readHeader(view, cp, clEnd);
                if (!bh) break;
                if (bh.id === Id.CLUSTER_TIMECODE) {
                    clusterTC = Ebml.readUint(view, bh.dataStart, bh.dataLength);
                } else if (bh.id === Id.SIMPLE_BLOCK) {
                    var s = parseBlock(view, bh.dataStart, bh.dataLength, clEnd, trackNumber);
                    if (s) {
                        var tNs = (clusterTC + s.relTC) * tcScaleNs;
                        if (tNs > horizonNs) return true;
                        appendSample(samples, s, tNs, codecID, view);
                    }
                } else if (bh.id === Id.BLOCK_GROUP) {
                    var bp = bh.dataStart;
                    var bend = Math.min(size, bh.dataStart + bh.dataLength);
                    while (bp < bend) {
                        var ih = Ebml.readHeader(view, bp, bend);
                        if (!ih) break;
                        if (ih.id === Id.BLOCK) {
                            var s2 = parseBlock(view, ih.dataStart, ih.dataLength, bend, trackNumber);
                            if (s2) {
                                var tNs2 = (clusterTC + s2.relTC) * tcScaleNs;
                                if (tNs2 > horizonNs) return true;
                                appendSample(samples, s2, tNs2, codecID, view);
                            }
                        }
                        bp = ih.dataStart + ih.dataLength;
                    }
                }
                cp = bh.dataStart + bh.dataLength;
            }
            return false;
        }

        function appendSample(samples, blockSample, tNs, codecID, view) {
            var raw = Ebml.readUtf8(view, blockSample.payloadStart, blockSample.payloadLen);
            var text = cleanText(raw, codecID);
            if (text) samples.push({ time: tNs / 1e9, text: text });
        }

        function parseBlock(view, blockDataStart, blockDataLength, capEnd, wantTrack) {
            var tn = Ebml.readVint(view, blockDataStart, capEnd);
            if (!tn || tn.value !== wantTrack) return null;
            var ds = blockDataStart + tn.length;
            if (ds + 3 > capEnd) return null;
            var rt = (view.getUint8(ds) << 8) | view.getUint8(ds + 1);
            if (rt & 0x8000) rt -= 0x10000;
            var payloadStart = ds + 3;
            var payloadLen = blockDataLength - tn.length - 3;
            if (payloadLen <= 0 || payloadLen > 4096) return null;
            return { relTC: rt, payloadStart: payloadStart, payloadLen: payloadLen };
        }

        function readSamples(buffer) {
            var open = Ebml.openSegment(buffer);
            if (!open) return { samples: [], track: null };
            var tracks = findTracks(open.view, open.segmentStart, open.segmentEnd);
            var picked = pickBest(tracks);
            if (!picked) return { samples: [], track: null };
            var samples = extractSamples(open.view, open.segmentStart, open.segmentEnd,
                                         picked.trackNumber, picked.codecID, open.timecodeScale);
            return { samples: samples, track: picked };
        }

        return { readSamples: readSamples };
    })();

    /* ====================================================================
     * SubtitleHeuristic  —  recap + intro detection from sub samples
     *
     * Recap  =  first sub matching the recap regex; window extends through
     *           the dense dialog block (gaps < SUB_DENSE_GAP_S) plus a 3s
     *           tail to cover trailing music.
     * Intro  =  the longest subtitle-free gap after recap (or from 0) that
     *           starts within the first 3 minutes and is 20–120s long.
     * ================================================================== */

    var SubtitleHeuristic = (function () {
        /* Recap detection — anchored on a sub matching the recap regex.
         *
         * Walks forward through samples while the gap to the next sample is
         * "dense" (< SUB_DENSE_GAP_S). Western-TV recaps are clip montages
         * with internal cuts of 5-15s, so the threshold has to tolerate
         * those gaps without breaking the block.
         *
         * After the dense block ends, we check the very next sample. If the
         * gap to it is in INTRO range (20-120s, signature of the opening
         * theme that has no dialogue), we extend the recap segment THROUGH
         * the intro silence to the start of the first episode-body line —
         * one combined skip rather than two adjacent ones. This also
         * correctly handles shows where the recap-then-credits flow has no
         * gap between them (some Netflix series).
         *
         * If we ran out of samples (likely intro extends past our fetched
         * window), we extend by a fixed conservative amount so the user
         * doesn't watch the opening theme in full. */
        function detectRecap(samples) {
            for (var i = 0; i < samples.length; i++) {
                if (!Const.SUB_RECAP_REGEX.test(samples[i].text)) continue;
                var startSec = Math.max(0, samples[i].time - 2);
                var lastDense = samples[i].time;
                var lastDenseIdx = i;
                for (var j = i + 1; j < samples.length; j++) {
                    if (samples[j].time - lastDense > Const.SUB_DENSE_GAP_S) break;
                    lastDense = samples[j].time;
                    lastDenseIdx = j;
                }
                var endSec = lastDense + 3;
                var nextIdx = lastDenseIdx + 1;
                if (nextIdx < samples.length) {
                    /* There IS a sample past the dense block — check the gap. */
                    var nextSample = samples[nextIdx];
                    var introGap = nextSample.time - lastDense;
                    if (introGap >= Const.SUB_INTRO_GAP_MIN_S
                        && introGap <= Const.SUB_INTRO_GAP_MAX_S
                        && nextSample.time <= Const.SUB_INTRO_BEFORE_S + lastDense) {
                        /* Opening theme between recap and episode body — merge. */
                        endSec = Math.max(endSec, nextSample.time - 1);
                    }
                } else if (lastDense < 90) {
                    /* No more samples in our window AND dense block ended in the
                     * first 90s of the episode — opening theme almost certainly
                     * extends past our fetched bytes. Extend by a conservative
                     * 60s to cover a typical opening sequence. The Skipper's
                     * Math.min(seg.end, video.duration) clamp keeps it bounded. */
                    endSec = lastDense + 60;
                }
                var dur = endSec - startSec;
                if (dur < Const.SUB_RECAP_MIN_S || dur > Const.SUB_RECAP_MAX_S) return null;
                return { start: startSec, end: endSec, type: "recap" };
            }
            return null;
        }

        /* Standalone intro — for shows that open with a cold-open + opening
         * theme (no recap). Looks for a 20-120s subtitle-free gap within
         * the first 3 minutes. Skipped when recap already merged the intro. */
        function detectIntro(samples, afterSec) {
            if (!samples.length) return null;
            var lastTime = afterSec || 0;
            for (var i = 0; i < samples.length; i++) {
                if (samples[i].time <= lastTime) continue;
                var gap = samples[i].time - lastTime;
                if (gap >= Const.SUB_INTRO_GAP_MIN_S
                    && gap <= Const.SUB_INTRO_GAP_MAX_S
                    && lastTime < Const.SUB_INTRO_BEFORE_S) {
                    return { start: lastTime, end: samples[i].time, type: "intro" };
                }
                lastTime = samples[i].time;
                if (lastTime > Const.SUB_SCAN_HORIZON_S) break;
            }
            return null;
        }

        function classify(samples) {
            var out = [];
            var recap = detectRecap(samples);
            if (recap) {
                out.push(recap);
                /* Recap already absorbs the opening — don't add a second
                 * intro segment that would just overlap. */
                return out;
            }
            var intro = detectIntro(samples, 0);
            if (intro) out.push(intro);
            return out;
        }

        return { classify: classify };
    })();

    /* ====================================================================
     * Range  —  HTTP Range fetch with timeout + safety bounds
     *
     * Returns the buffer or null. Errors never throw — they log and resolve
     * null so the caller can fall through to the next tier. The xhr.abort()
     * on timeout matters: TorrServe will keep streaming bytes otherwise.
     * ================================================================== */

    var Range = (function () {
        function fetch(url, byteLimit, timeoutMs, cid) {
            return new Promise(function (resolve) {
                var done = false;
                var t0 = Date.now();
                var xhr = new XMLHttpRequest();
                try {
                    xhr.open("GET", url, true);
                    xhr.responseType = "arraybuffer";
                    xhr.setRequestHeader("Range", "bytes=0-" + (byteLimit - 1));
                } catch (e) {
                    Log.error("range.open_failed", { cid: cid, err: e && e.message });
                    resolve(null);
                    return;
                }
                var timer = setTimeout(function () {
                    if (done) return;
                    done = true;
                    try { xhr.abort(); } catch (_) {}
                    Log.warn("range.timeout", { cid: cid, byte_limit: byteLimit, after_ms: Date.now() - t0 });
                    resolve(null);
                }, timeoutMs);

                xhr.onload = function () {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    var elapsed = Date.now() - t0;
                    if (xhr.status !== 206 && xhr.status !== 200) {
                        Log.warn("range.bad_status", { cid: cid, status: xhr.status, after_ms: elapsed });
                        resolve(null);
                        return;
                    }
                    var buf = xhr.response;
                    if (!buf || buf.byteLength === 0) {
                        Log.warn("range.empty_body", { cid: cid, status: xhr.status, after_ms: elapsed });
                        resolve(null);
                        return;
                    }
                    if (xhr.status === 200 && buf.byteLength > Const.SAFETY_BYTES) {
                        Log.warn("range.oversize", { cid: cid, bytes: buf.byteLength });
                        resolve(null);
                        return;
                    }
                    Log.debug("range.ok", { cid: cid, bytes: buf.byteLength, status: xhr.status, ms: elapsed });
                    resolve(buf);
                };
                xhr.onerror = function () {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    Log.warn("range.network_error", { cid: cid, after_ms: Date.now() - t0 });
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
                    Log.error("range.send_failed", { cid: cid, err: e && e.message });
                    resolve(null);
                }
            });
        }
        return { fetch: fetch };
    })();

    /* ====================================================================
     * IntroDb  —  TheIntroDB v2 client (Tier-3 fallback)
     *
     * Returns [{ start, end, type }] from the v2/media endpoint, or [] for
     * any failure / 404 / empty response. Network errors are logged once
     * and never throw to the caller.
     * ================================================================== */

    var IntroDb = (function () {
        function fetchSegments(tmdbId, season, episode, cid) {
            return new Promise(function (resolve) {
                if (!tmdbId || season == null || episode == null) {
                    resolve([]);
                    return;
                }
                var url = Const.INTRODB_URL
                    + "?tmdb_id=" + encodeURIComponent(tmdbId)
                    + "&season="  + encodeURIComponent(season)
                    + "&episode=" + encodeURIComponent(episode);
                var done = false;
                var t0 = Date.now();
                var xhr = new XMLHttpRequest();
                try {
                    xhr.open("GET", url, true);
                    xhr.setRequestHeader("Accept", "application/json");
                } catch (e) {
                    Log.error("introdb.open_failed", { cid: cid, err: e && e.message });
                    resolve([]);
                    return;
                }
                var timer = setTimeout(function () {
                    if (done) return;
                    done = true;
                    try { xhr.abort(); } catch (_) {}
                    Log.warn("introdb.timeout", { cid: cid });
                    resolve([]);
                }, Const.API_TIMEOUT_MS);
                xhr.onload = function () {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    var elapsed = Date.now() - t0;
                    if (xhr.status === 204 || xhr.status === 404) {
                        Log.debug("introdb.no_data", { cid: cid, status: xhr.status, ms: elapsed });
                        resolve([]);
                        return;
                    }
                    if (xhr.status < 200 || xhr.status >= 300) {
                        Log.warn("introdb.http_error", { cid: cid, status: xhr.status });
                        resolve([]);
                        return;
                    }
                    var json = null;
                    try { json = JSON.parse(xhr.responseText); }
                    catch (e) { Log.warn("introdb.parse_error", { cid: cid, err: e && e.message }); resolve([]); return; }
                    var seg = normalise(json);
                    Log.debug("introdb.ok", { cid: cid, segments: seg.length, ms: elapsed });
                    resolve(seg);
                };
                xhr.onerror = function () {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    Log.warn("introdb.network_error", { cid: cid });
                    resolve([]);
                };
                try { xhr.send(); }
                catch (e) { done = true; clearTimeout(timer); Log.error("introdb.send_failed", { cid: cid, err: e && e.message }); resolve([]); }
            });
        }

        var TYPES = ["intro", "recap", "credits", "preview"];

        function normalise(json) {
            if (!json) return [];
            var out = [];
            for (var ti = 0; ti < TYPES.length; ti++) {
                var key = TYPES[ti];
                var arr = json[key];
                if (!arr || !arr.length) continue;
                for (var j = 0; j < arr.length; j++) {
                    var seg = arr[j];
                    var s = seg.start_ms != null ? seg.start_ms / 1000 : seg.start;
                    var e = seg.end_ms   != null ? seg.end_ms   / 1000 : seg.end;
                    if (s == null || e == null || e <= s) continue;
                    out.push({ start: s, end: e, type: key });
                }
            }
            return out;
        }

        return { fetchSegments: fetchSegments };
    })();

    /* ====================================================================
     * Meta  —  TMDB id / season / episode extraction from player payload
     *
     * Lampa's `Player.play(data)` payload is inconsistent across sources;
     * we try `data.card.id`, `Lampa.Activity.active().card / .movie`,
     * direct `data.season|episode`, the title regex fallback, and finally
     * the matching playlist entry. First non-null wins for each field.
     * ================================================================== */

    var Meta = (function () {
        var SE_RX = /[Ss](\d+)[Ee](\d+)/;

        function extract(data) {
            var meta = { tmdb_id: null, season: null, episode: null };
            if (!data) return meta;

            var card = data.card || null;
            if (!card) {
                try {
                    var act = Lampa.Activity.active();
                    if (act) card = act.card || act.movie || null;
                } catch (_) {}
            }
            if (card) meta.tmdb_id = card.id || null;

            if (data.season  != null) meta.season  = parseInt(data.season,  10);
            if (data.episode != null) meta.episode = parseInt(data.episode, 10);

            if ((meta.season == null || meta.episode == null) && data.title) {
                var m = ("" + data.title).match(SE_RX);
                if (m) {
                    if (meta.season  == null) meta.season  = parseInt(m[1], 10);
                    if (meta.episode == null) meta.episode = parseInt(m[2], 10);
                }
            }

            if (data.playlist && data.playlist.length) {
                for (var i = 0; i < data.playlist.length; i++) {
                    var p = data.playlist[i];
                    if (!p) continue;
                    if (p.url === data.url || i === 0) {
                        if (p.season  != null && meta.season  == null) meta.season  = parseInt(p.season,  10);
                        if (p.episode != null && meta.episode == null) meta.episode = parseInt(p.episode, 10);
                        if (p.s != null && meta.season  == null) meta.season  = parseInt(p.s, 10);
                        if (p.e != null && meta.episode == null) meta.episode = parseInt(p.e, 10);
                        if (p.url === data.url) break;
                    }
                }
            }
            return meta;
        }
        return { extract: extract };
    })();

    /* ====================================================================
     * Visible  —  user-facing diagnostic surface
     *
     * Lampa core re-wraps console.log ~1s after boot
     * (vendor/lampa-source/src/interaction/console.js Timer.add(1000, …)),
     * which silently breaks the log-collector capture chain for everything
     * the plugin emits after that point. To stay observable on TVs without
     * remote DevTools, we surface every pipeline outcome two ways:
     *
     *   1. Bell.push toast — a brief on-screen line ("SegmentSource: t1=0
     *      t2=1 → 1 segments") at every playback start, identical visual
     *      treatment to Lampa's own "Пропущено" toast.
     *   2. Lampa.Storage  — last init + last run snapshot under stable keys
     *      (`segsrc_last_init`, `segsrc_last_run`). These ride along in the
     *      Cube sync, so a Storage dump on any device shows the latest run
     *      even if we never received a single log line.
     *
     * Toast is silent for the non-TorrServe branch — we don't want to
     * notify on every Kodik playback.
     * ================================================================== */

    var Visible = (function () {
        function noteInit(appDigital) {
            try {
                Lampa.Storage.set("segsrc_last_init", JSON.stringify({
                    ts: Date.now(),
                    app_digital: appDigital
                }));
            } catch (_) {}
        }

        function noteRun(snapshot) {
            try {
                Lampa.Storage.set("segsrc_last_run", JSON.stringify(snapshot));
            } catch (_) {}
            try {
                /* Lampa.Bell — same toast surface used by the segments
                 * engine for "Пропущено". Use Lampa.Noty as fallback for
                 * older builds that don't expose Bell. */
                var line = "SegmentSource: t1=" + snapshot.tier1
                         + " t2=" + snapshot.tier2
                         + " → " + snapshot.segments + " seg ("
                         + snapshot.reason + ")";
                if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(line);
                else if (Lampa.Bell && Lampa.Bell.push) Lampa.Bell.push({ text: line });
            } catch (_) {}
        }

        return { noteInit: noteInit, noteRun: noteRun };
    })();

    /* ====================================================================
     * Pipeline  —  tiered segment lookup
     *
     * Each tier produces typed segments [{start, end, type}] or empty.
     * Tiers are tried in order; the first non-empty wins. The result is
     * flattened to the {skip: [{start,end}]} shape Lampa core expects.
     *
     * Cache is per (infohash, fileIndex). Empty results are also cached
     * with TTL so we don't retry every play of an episode that has no data.
     * ================================================================== */

    /* ====================================================================
     * Skipper  —  fallback time-based seek for non-HTML5 players
     *
     * Lampa core wires the segments engine via the DOM `'timeupdate'` event
     * on the <video> element (vendor/lampa-source/src/interaction/player/
     * video.js:284). Tizen / WebOS / Orsay players use native objects
     * (avplay, etc.) that don't dispatch DOM events — they fan out via
     * Lampa.PlayerVideo.listener instead. Result: native auto-skip never
     * fires for those players, even with `player_segments_skip = "auto"`.
     *
     * We work around this in-plugin by subscribing to the universal
     * Lampa.PlayerVideo.listener('timeupdate') event and doing the seek
     * ourselves. This is fully idempotent with Lampa core's own skipper:
     * on HTML5 both fire, both seek to segment.end, second one is a no-op.
     *
     * The toggle still lives in the native menu — we read the same
     * `player_segments_skip` storage key Lampa core uses. So:
     *   "auto"  →  we seek + show toast
     *   "user"  →  silent (we don't impose; user chose manual control)
     *   "none"  →  silent (user disabled segment skipping)
     * ================================================================== */

    var Skipper = (function () {
        var current = [];           /* segments for the playback in flight */
        var subscribed = false;

        function activate(skip) {
            current = (skip || []).map(function (s) {
                return { start: s.start, end: s.end, fired: false };
            });
            if (subscribed) return;
            subscribed = true;
            try {
                Lampa.PlayerVideo.listener.follow("timeupdate", onTimeUpdate);
                Lampa.Player.listener.follow("destroy",       onPlayerDestroy);
            } catch (e) {
                Log.error("skipper.subscribe_failed", { err: e && e.message });
            }
        }

        function onTimeUpdate() {
            if (!current.length) return;
            var mode;
            try { mode = Lampa.Storage.get("player_segments_skip", "auto"); }
            catch (_) { mode = "auto"; }
            if (mode !== "auto") return;     /* user toggled to manual or off */

            var v;
            try { v = Lampa.PlayerVideo.video(); }
            catch (_) { return; }
            if (!v) return;
            var t = v.currentTime;
            if (typeof t !== "number" || isNaN(t) || !isFinite(t)) return;

            for (var i = 0; i < current.length; i++) {
                var seg = current[i];
                if (seg.fired) continue;
                if (t >= seg.start && t < seg.end) {
                    seg.fired = true;
                    var dur = (typeof v.duration === "number" && v.duration > 0) ? v.duration : seg.end;
                    var target = Math.min(seg.end, dur);
                    try { v.currentTime = target; }
                    catch (e) { Log.error("skipper.seek_failed", { err: e && e.message, target: target }); return; }
                    Log.info("skipper.skipped", {
                        from: t.toFixed(2), to: target.toFixed(2), span: (target - seg.start).toFixed(2)
                    });
                    try { Lampa.Noty.show("Пропущено"); } catch (_) {}
                    return;
                }
            }
        }

        function onPlayerDestroy() {
            current = [];
        }

        return { activate: activate };
    })();

    var Pipeline = (function () {
        function flattenToSkip(typed) {
            var out = [];
            if (!typed || !typed.length) return out;
            for (var i = 0; i < typed.length; i++) {
                var s = typed[i];
                if (!s || s.start == null || s.end == null) continue;
                if (typeof s.start !== "number" || typeof s.end !== "number") continue;
                if (!isFinite(s.start) || isNaN(s.start) || isNaN(s.end)) continue;
                if (s.end <= s.start) continue;
                out.push({ start: s.start, end: s.end });
            }
            return out;
        }

        function tier1Chapters(buf, cid) {
            var t0 = Date.now();
            var atoms;
            try { atoms = MkvChapters.parse(buf); }
            catch (e) {
                Log.error("tier1.parse_failed", { cid: cid, err: e && e.message });
                return [];
            }
            var typed = [];
            for (var i = 0; i < atoms.length; i++) {
                var t = ChapterClassify.classify(atoms[i].title);
                if (t) typed.push({ start: atoms[i].start, end: atoms[i].end, type: t });
            }
            Log.info("tier1.chapters", {
                cid: cid,
                atoms: atoms.length,
                classified: typed.length,
                ms: Date.now() - t0
            });
            return typed;
        }

        function tier2Subtitles(buf, cid) {
            var t0 = Date.now();
            var read;
            try { read = MkvSubtitles.readSamples(buf); }
            catch (e) {
                Log.error("tier2.parse_failed", { cid: cid, err: e && e.message });
                return [];
            }
            if (!read.track) {
                Log.debug("tier2.no_subtitle_track", { cid: cid });
                return [];
            }
            var typed = SubtitleHeuristic.classify(read.samples);
            Log.info("tier2.subtitles", {
                cid: cid,
                track: read.track.trackNumber,
                lang: read.track.language || "?",
                codec: read.track.codecID,
                samples: read.samples.length,
                detected: typed.length,
                types: typed.map(function (s) { return s.type; }).join(",") || "-",
                ms: Date.now() - t0
            });
            return typed;
        }

        function tier3Api(meta, cid) {
            return IntroDb.fetchSegments(meta.tmdb_id, meta.season, meta.episode, cid);
        }

        /**
         * Resolve a segment list for the given Player.play payload.
         * @returns Promise<Array<{start,end}>|null>  null when not torrent;
         *          empty array when torrent but no segments found.
         */
        function load(data) {
            var cid = Log.newCid();
            var t0 = Date.now();
            return new Promise(function (resolve) {
                var url = data && data.url;
                var cls = Url.classify(url);
                if (cls.kind !== "torrserve") {
                    Log.debug("pipeline.skip_non_torrserve", { cid: cid });
                    resolve(null);
                    return;
                }
                Log.info("pipeline.start", {
                    cid: cid, infohash: cls.infohash || "?", index: cls.fileIndex
                });

                var ckey = cls.infohash ? Storage.key(cls.infohash, cls.fileIndex) : null;
                if (ckey) {
                    var cached = Storage.get(ckey);
                    if (cached !== null) {
                        Log.info("pipeline.cache_hit", { cid: cid, segments: cached.length });
                        finish({ cid: cid, ckey: null, skip: cached, resolve: resolve, reason: "cache_hit",
                                 tier1: 0, tier2: 0, ms: Date.now() - t0, infohash: cls.infohash, index: cls.fileIndex });
                        return;
                    }
                }

                Range.fetch(Url.toPlayable(url), Const.HEAD_RANGE_BYTES, Const.FETCH_TIMEOUT_MS, cid)
                    .then(function (buf) {
                        if (!buf) {
                            finish({ cid: cid, ckey: ckey, skip: [], resolve: resolve, reason: "tier1.no_buffer",
                                     tier1: 0, tier2: 0, ms: Date.now() - t0, infohash: cls.infohash, index: cls.fileIndex });
                            return;
                        }

                        var t1 = tier1Chapters(buf, cid);
                        if (t1.length) {
                            finish({ cid: cid, ckey: ckey, skip: flattenToSkip(t1), resolve: resolve, reason: "tier1.success",
                                     tier1: t1.length, tier2: 0, ms: Date.now() - t0, infohash: cls.infohash, index: cls.fileIndex });
                            return;
                        }

                        var t2 = tier2Subtitles(buf, cid);
                        if (t2.length) {
                            finish({ cid: cid, ckey: ckey, skip: flattenToSkip(t2), resolve: resolve, reason: "tier2.success",
                                     tier1: 0, tier2: t2.length, ms: Date.now() - t0, infohash: cls.infohash, index: cls.fileIndex });
                            return;
                        }

                        var meta = Meta.extract(data);
                        if (!meta.tmdb_id || meta.season == null || meta.episode == null) {
                            Log.debug("tier3.skip_no_meta", { cid: cid, meta: meta });
                            finish({ cid: cid, ckey: ckey, skip: [], resolve: resolve, reason: "no_segments",
                                     tier1: 0, tier2: 0, ms: Date.now() - t0, infohash: cls.infohash, index: cls.fileIndex });
                            return;
                        }
                        tier3Api(meta, cid).then(function (apiSeg) {
                            finish({ cid: cid, ckey: ckey, skip: flattenToSkip(apiSeg), resolve: resolve,
                                     reason: apiSeg.length ? "tier3.success" : "no_segments",
                                     tier1: 0, tier2: 0, ms: Date.now() - t0, infohash: cls.infohash, index: cls.fileIndex });
                        });
                    });
            });
        }

        /* Single sink for "we're done with this playback":
         * - writes cache (so next play of same file is a synchronous hit)
         * - emits a structured log line (in case log-collector caught it)
         * - drops a Storage trace + Bell toast for users without log access
         * - resolves the awaiting Promise so Lampa core gets the segments. */
        function finish(ctx) {
            if (ctx.ckey) Storage.set(ctx.ckey, ctx.skip);
            Log.info("pipeline.finish", {
                cid: ctx.cid, segments: ctx.skip.length, reason: ctx.reason,
                tier1: ctx.tier1, tier2: ctx.tier2, ms: ctx.ms
            });
            Visible.noteRun({
                ts: Date.now(),
                cid: ctx.cid,
                infohash: ctx.infohash,
                index: ctx.index,
                tier1: ctx.tier1,
                tier2: ctx.tier2,
                segments: ctx.skip.length,
                reason: ctx.reason,
                ms: ctx.ms
            });
            ctx.resolve(ctx.skip);
        }

        return { load: load };
    })();

    /* ====================================================================
     * Bootstrap  —  Lampa boot wiring
     *
     * Four-layer pattern from the lampa-plugin-development skill: handles
     * being injected before, during, or after Lampa.Listener('app','ready').
     * The _initialised guard makes init() idempotent — both the app:ready
     * callback and the setTimeout safety net try to call it.
     * ================================================================== */

    var Bootstrap = (function () {
        var initialised = false;

        function init() {
            if (initialised) return;
            initialised = true;

            var ver = (Lampa.Manifest && typeof Lampa.Manifest.app_digital === "number")
                      ? Lampa.Manifest.app_digital : 0;
            if (ver < Const.MIN_APP_DIGITAL) {
                Log.warn("init.unsupported_lampa", { app_digital: ver, min: Const.MIN_APP_DIGITAL });
                return;
            }

            try {
                Lampa.Player.listener.follow("create", onPlayerCreate);
            } catch (e) {
                Log.error("init.player_hook_failed", { err: e && e.message });
                return;
            }
            Log.info("init.ok", { app_digital: ver });
            Visible.noteInit(ver);
        }

        /* `'create'` is the right hook (vs `'start'`) because it fires before
         * Lampa core's preload / Segments.set chain — see design D2.
         * Race-loss strategy: if our Range fetch loses to preload, this play
         * runs without segments. We never call e.abort() — making the player
         * wait on a metadata fetch is worse UX than first-play missing skips,
         * because the cache makes subsequent plays of the same file synchronous. */
        function onPlayerCreate(e) {
            if (!e || !e.data) return;
            try {
                Pipeline.load(e.data).then(function (skip) {
                    if (skip == null) return;       /* not a torrent stream */
                    if (!e.data.segments) e.data.segments = {};
                    e.data.segments.skip = skip;
                    /* Belt-and-suspenders: native segments engine fails on
                     * Tizen/WebOS/Orsay (DOM-event hook bypasses native players).
                     * Skipper does the seek itself via the universal listener.
                     * On HTML5 it duplicates Lampa core's seek harmlessly. */
                    Skipper.activate(skip);
                }, function (err) {
                    Log.error("hook.create_unhandled", { err: err && err.message });
                });
            } catch (err) {
                Log.error("hook.create_threw", { err: err && err.message });
            }
        }

        function whenReady(cb) {
            if (window.Lampa && Lampa.SettingsApi && Lampa.Player && Lampa.Storage
                && Lampa.Player.listener && Lampa.Manifest) {
                cb();
            } else {
                setTimeout(function () { whenReady(cb); }, 500);
            }
        }

        function start() {
            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.follow("app", function (evt) {
                    if (evt && evt.type === "ready") whenReady(init);
                });
                setTimeout(function () { whenReady(init); }, 1000);
            } else {
                var poll = setInterval(function () {
                    if (window.Lampa && Lampa.Listener) {
                        clearInterval(poll);
                        Lampa.Listener.follow("app", function (evt) {
                            if (evt && evt.type === "ready") whenReady(init);
                        });
                        setTimeout(function () { whenReady(init); }, 1000);
                    }
                }, 300);
            }
        }

        return { start: start };
    })();

    Bootstrap.start();
})();
