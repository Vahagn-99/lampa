/*!
 * SegmentSource — feeds Lampa's segments engine with intro / recap / credits / preview timestamps
 *
 * Data provider for Lampa core's built-in segments engine
 * (vendor/lampa-source/src/interaction/player/segments.js, requires Lampa
 * 3.0.0+, app_digital >= 300). The plugin owns no UI of its own — the
 * per-show toggle lives in the native player gear menu under
 * "Сегменты" → "Пропуск" (Авто / Вручную / Откл).
 *
 * Source: TheIntroDB v2 (api.theintrodb.org/v2/media). Public, no auth,
 * CORS-open. Covers Western TV and anime via TMDB id, returning intro /
 * recap / credits / preview windows in one call.
 *
 * For Tizen / WebOS / Orsay native players a small Skipper module
 * replicates the auto-skip via Lampa.PlayerVideo.listener('timeupdate') —
 * Lampa core's native skipper is wired to the DOM 'timeupdate' on <video>
 * which native player objects don't dispatch.
 *
 * Single ES5 IIFE, no build step, no runtime dependencies beyond
 * window.Lampa.
 */
(function () {
    "use strict";

    if (window.__segmentSourceLoaded) return;
    window.__segmentSourceLoaded = true;

    var Const = {
        MIN_APP_DIGITAL: 300,
        API_URL:         "https://api.theintrodb.org/v2/media",
        API_TIMEOUT_MS:  5000,
        CACHE_TTL_MS:    30 * 24 * 3600 * 1000,
        CACHE_PREFIX:    "segsrc_api_",
        SE_TITLE_RX:     /[Ss](\d+)[Ee](\d+)/
    };

    /* ---------- per (tmdb_id, season, episode) cache ---------- */

    var Cache = {
        key: function (tmdbId, s, e) {
            return Const.CACHE_PREFIX + tmdbId + "_s" + (s || 0) + "_e" + (e || 0);
        },
        get: function (k) {
            try {
                var raw = localStorage.getItem(k);
                if (!raw) return null;
                var obj = JSON.parse(raw);
                if (!obj || typeof obj._ts !== "number") return null;
                if (Date.now() - obj._ts > Const.CACHE_TTL_MS) {
                    localStorage.removeItem(k);
                    return null;
                }
                return obj.segments == null ? [] : obj.segments;
            } catch (_) { return null; }
        },
        set: function (k, segments) {
            try {
                localStorage.setItem(k, JSON.stringify({
                    segments: segments || [], _ts: Date.now()
                }));
            } catch (_) {}
        }
    };

    /* ---------- TMDB id / season / episode extraction ---------- */

    function extractMeta(data) {
        var out = { tmdb_id: null, season: null, episode: null };
        if (!data) return out;

        var card = data.card || null;
        if (!card) {
            try {
                var act = Lampa.Activity.active();
                if (act) card = act.card || act.movie || null;
            } catch (_) {}
        }
        if (card) out.tmdb_id = card.id || null;

        if (data.season  != null) out.season  = parseInt(data.season,  10);
        if (data.episode != null) out.episode = parseInt(data.episode, 10);

        if ((out.season == null || out.episode == null) && data.title) {
            var m = ("" + data.title).match(Const.SE_TITLE_RX);
            if (m) {
                if (out.season  == null) out.season  = parseInt(m[1], 10);
                if (out.episode == null) out.episode = parseInt(m[2], 10);
            }
        }

        if (data.playlist && data.playlist.length) {
            for (var i = 0; i < data.playlist.length; i++) {
                var p = data.playlist[i];
                if (!p) continue;
                if (p.url === data.url || i === 0) {
                    if (p.season  != null && out.season  == null) out.season  = parseInt(p.season,  10);
                    if (p.episode != null && out.episode == null) out.episode = parseInt(p.episode, 10);
                    if (p.s != null && out.season  == null) out.season  = parseInt(p.s, 10);
                    if (p.e != null && out.episode == null) out.episode = parseInt(p.e, 10);
                    if (p.url === data.url) break;
                }
            }
        }
        return out;
    }

    /* ---------- TheIntroDB v2 client ----------
     * Response (verified):
     *   { intro: [{start_ms, end_ms|null}], recap: [...],
     *     credits: [...], preview: [...] }
     * end_ms = null means "until end of file" — represented as MAX_SAFE_INTEGER
     * here, then clamped by the Skipper's Math.min(seg.end, video.duration).
     */

    var END_CAP   = Number.MAX_SAFE_INTEGER || 9007199254740991;
    var API_TYPES = ["intro", "recap", "credits", "preview"];

    function fetchApi(tmdbId, season, episode) {
        return new Promise(function (resolve) {
            if (!tmdbId || season == null || episode == null) { resolve([]); return; }
            var url = Const.API_URL
                + "?tmdb_id=" + encodeURIComponent(tmdbId)
                + "&season="  + encodeURIComponent(season)
                + "&episode=" + encodeURIComponent(episode);
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
                resolve([]);
            }, Const.API_TIMEOUT_MS);
            xhr.onload = function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (xhr.status < 200 || xhr.status >= 300) { resolve([]); return; }
                var json = null;
                try { json = JSON.parse(xhr.responseText); }
                catch (_) { resolve([]); return; }
                resolve(normaliseApi(json));
            };
            xhr.onerror = function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve([]);
            };
            try { xhr.send(); }
            catch (_) { done = true; clearTimeout(timer); resolve([]); }
        });
    }

    function normaliseApi(json) {
        var out = [];
        if (!json) return out;
        for (var ti = 0; ti < API_TYPES.length; ti++) {
            var arr = json[API_TYPES[ti]];
            if (!arr || !arr.length) continue;
            for (var j = 0; j < arr.length; j++) {
                var seg = arr[j];
                /* TheIntroDB convention: start_ms=null means "from start of
                 * file" (treat as 0); end_ms=null means "to end of file"
                 * (treat as MAX_SAFE_INTEGER, Skipper clamps to video
                 * duration). Common for recap-from-zero and credits-to-end. */
                var s = (seg.start_ms === null) ? 0
                      : (seg.start_ms != null ? seg.start_ms / 1000
                      : (seg.start == null ? 0 : seg.start));
                var e = (seg.end_ms === null) ? END_CAP
                      : (seg.end_ms != null ? seg.end_ms / 1000
                      : (seg.end == null ? END_CAP : seg.end));
                if (!isFinite(s) || s < 0) continue;
                if (e <= s) continue;
                out.push({ start: s, end: e });
            }
        }
        return out;
    }

    /* ---------- Skipper — universal seek for native (non-HTML5) players ----------
     * Lampa core wires Segments.update to a DOM 'timeupdate' event on
     * <video> (vendor/lampa-source/src/interaction/player/video.js:284).
     * Tizen / WebOS / Orsay use objects that don't dispatch DOM events;
     * they fan out via Lampa.PlayerVideo.listener instead. We subscribe to
     * the universal channel so the seek works on every platform. On HTML5
     * this duplicates the native skip harmlessly (both target seg.end).
     */

    var skipperSegments = [];
    var skipperSubscribed = false;

    function skipperActivate(skip) {
        skipperSegments = (skip || []).map(function (s) {
            return { start: s.start, end: s.end, fired: false };
        });
        if (skipperSubscribed) return;
        skipperSubscribed = true;
        try {
            Lampa.PlayerVideo.listener.follow("timeupdate", skipperOnTime);
            Lampa.Player.listener.follow("destroy", function () { skipperSegments = []; });
        } catch (_) {}
    }

    function skipperOnTime() {
        if (!skipperSegments.length) return;
        var mode;
        try { mode = Lampa.Storage.get("player_segments_skip", "auto"); }
        catch (_) { mode = "auto"; }
        if (mode !== "auto") return;
        var v;
        try { v = Lampa.PlayerVideo.video(); } catch (_) { return; }
        if (!v) return;
        var t = v.currentTime;
        if (typeof t !== "number" || isNaN(t) || !isFinite(t)) return;
        for (var i = 0; i < skipperSegments.length; i++) {
            var seg = skipperSegments[i];
            if (seg.fired) continue;
            if (t >= seg.start && t < seg.end) {
                seg.fired = true;
                var dur = (typeof v.duration === "number" && v.duration > 0) ? v.duration : seg.end;
                try { v.currentTime = Math.min(seg.end, dur); } catch (_) {}
                return;
            }
        }
    }

    /* ---------- pipeline: cache → API → cache, return skip[] ---------- */

    function loadSegments(data) {
        return new Promise(function (resolve) {
            var meta = extractMeta(data);
            if (!meta.tmdb_id || meta.season == null || meta.episode == null) {
                resolve(null);
                return;
            }
            var ckey = Cache.key(meta.tmdb_id, meta.season, meta.episode);
            var cached = Cache.get(ckey);
            /* Use cache only when it has actual segments. Empty results are
             * intentionally NOT cached so a "no data" verdict from the API
             * gets retried on next play — community DBs add labels over time. */
            if (cached !== null && cached.length > 0) { resolve(cached); return; }
            fetchApi(meta.tmdb_id, meta.season, meta.episode).then(function (skip) {
                if (skip.length) Cache.set(ckey, skip);
                resolve(skip);
            });
        });
    }

    /* ---------- bootstrap ---------- */

    var initialised = false;

    function init() {
        if (initialised) return;
        initialised = true;
        var ver = (Lampa.Manifest && typeof Lampa.Manifest.app_digital === "number")
                  ? Lampa.Manifest.app_digital : 0;
        if (ver < Const.MIN_APP_DIGITAL) return;
        try { Lampa.Player.listener.follow("create", onPlayerCreate); } catch (_) {}
    }

    function onPlayerCreate(e) {
        if (!e || !e.data) return;
        try {
            loadSegments(e.data).then(function (skip) {
                if (skip == null) return;       /* no TMDB metadata — silent */
                /* Notify only when the user has actually opted into auto-skip,
                 * so we don't spam users who keep the native toggle on "Откл". */
                var mode;
                try { mode = Lampa.Storage.get("player_segments_skip", "auto"); }
                catch (_) { mode = "auto"; }
                if (mode === "auto" && !skip.length) {
                    try { Lampa.Noty.show("Источник сегментов: для этого эпизода нет таймкодов"); }
                    catch (_) {}
                }
                if (!skip.length) return;
                if (!e.data.segments) e.data.segments = {};
                e.data.segments.skip = skip;
                skipperActivate(skip);
            });
        } catch (_) {}
    }

    function whenReady(cb) {
        if (window.Lampa && Lampa.Player && Lampa.Storage
            && Lampa.Player.listener && Lampa.Manifest) cb();
        else setTimeout(function () { whenReady(cb); }, 500);
    }

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
})();
