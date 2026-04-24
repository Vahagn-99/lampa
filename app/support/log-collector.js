/*!
 * Log Collector — stream Lampa plugin logs to a dev machine over LAN
 *
 * Companion to log-server.py (in the repo root). Intercepts console.log/
 * warn/error, window.error events, and Lampa.Listener('request_error'),
 * auto-extracts the "[PluginName]" prefix, batches entries, and ships
 * them to http://<dev-ip>:<port>/log.
 *
 * Universal across Android TV, Tizen, WebOS, Chromecast, desktop — uses
 * three fallback transports in order:
 *   1. XMLHttpRequest POST       — normal path, needs server CORS (it has)
 *   2. navigator.sendBeacon      — non-blocking, fire-and-forget POST
 *   3. <img src> GET (base64)    — bypasses some CORS / mixed-content
 *                                   checks on locked-down TV WebViews
 *
 * Mixed-content caveat: if Lampa is loaded over HTTPS and your dev server
 * runs over HTTP, TV WebView will block ALL three transports. Either run
 * Lampa from HTTP (Tizen widget typically does) or start log-server.py
 * with --tls and accept the self-signed cert on the TV side.
 *
 * Opt-in: disabled by default. In Настройки → Сборщик логов either press
 * «Найти log-server в сети» to auto-discover the dev-machine endpoint on
 * the LAN (HTTP probe of /health looking for "lampa-log-server"), or type
 * it in by hand. Then flip «Включить». Restart Lampa to capture boot-time
 * logs from other plugins.
 *
 * LAN discovery: explicit-trigger only (no scanning at app start, no auto
 * scanning on settings open). Strategy: own /24 first (from WebRTC or
 * Android bridge), then fallback subnets 192.168.0/1, 10.0.0, 192.168.100.
 * Probe timeout 1500 ms, concurrency 8 (4 on TV). Ported from torrserver-
 * discovery, adapted for log-server.py's single-port default (9999).
 *
 * Log prefix:   [LogCollector]
 * Global guard: window.__logCollectorLoaded
 * Storage ns:   log_collector_*
 */
(function () {
    'use strict';

    if (window.__logCollectorLoaded) return;
    window.__logCollectorLoaded = true;

    var NS                 = 'log_collector_';
    var SELF_TAG           = 'LogCollector';
    var BUFFER             = [];
    var BUFFER_HARD_CAP    = 500;
    var FLUSH_INTERVAL_MS  = 2000;
    var FLUSH_TRIGGER      = 20;
    var HTTP_TIMEOUT_MS    = 3000;
    var IMG_URL_MAX        = 1500;       // keep GET URL under 2 KB on TV

    var _flushTimer   = null;
    var _flushing     = false;
    var _initialised  = false;

    // ========================================================================
    // Storage accessors (safe pre-Lampa)
    // ========================================================================

    function storageEnabled() {
        try {
            if (!window.Lampa || !Lampa.Storage) return false;
            return Lampa.Storage.field(NS + 'enabled') === true;
        } catch (e) { return false; }
    }

    function storageEndpoint() {
        try {
            if (!window.Lampa || !Lampa.Storage) return '';
            var v = Lampa.Storage.get(NS + 'endpoint', '');
            return (v + '').replace(/\/+$/, '');
        } catch (e) { return ''; }
    }

    // ========================================================================
    // Record / buffer
    // ========================================================================

    function extractPrefix(args) {
        if (!args || !args.length) return 'unprefixed';
        var s = (args[0] == null) ? '' : String(args[0]);
        var m = s.match(/^\[([A-Za-z0-9_\-:.]+)\]/);
        return m ? m[1] : 'unprefixed';
    }

    function stringifyArgs(args) {
        var out = [];
        for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (a == null) { out.push(String(a)); continue; }
            if (a instanceof Error) {
                out.push(a.name + ': ' + a.message + (a.stack ? '\n' + a.stack : ''));
            } else if (typeof a === 'object') {
                try { out.push(JSON.stringify(a)); }
                catch (e) { out.push('[Object]'); }
            } else {
                out.push(String(a));
            }
        }
        return out.join(' ');
    }

    function record(level, args) {
        try {
            var prefix = extractPrefix(args);
            if (prefix === SELF_TAG) return;  // never recurse on our own output

            BUFFER.push({
                ts:     Date.now(),
                level:  level,
                prefix: prefix,
                msg:    stringifyArgs(args)
            });

            if (BUFFER.length > BUFFER_HARD_CAP) {
                BUFFER.splice(0, BUFFER.length - BUFFER_HARD_CAP);
            }
            if (BUFFER.length >= FLUSH_TRIGGER) flush();
        } catch (e) {}
    }

    // ========================================================================
    // Transport 1 — XMLHttpRequest POST
    // ========================================================================

    function sendXHR(url, payload, onDone) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', url, true);
            try { x.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
            x.timeout = HTTP_TIMEOUT_MS;
            var done = false;
            var finish = function (ok) { if (done) return; done = true; onDone(ok); };
            x.onload    = function () { finish(x.status >= 200 && x.status < 300); };
            x.onerror   = function () { finish(false); };
            x.ontimeout = function () { finish(false); };
            x.send(payload);
            return true;
        } catch (e) { return false; }
    }

    // ========================================================================
    // Transport 2 — navigator.sendBeacon
    // ========================================================================

    function sendBeacon(url, payload) {
        try {
            if (!navigator || typeof navigator.sendBeacon !== 'function') return false;
            var blob;
            try { blob = new Blob([payload], { type: 'application/json' }); }
            catch (e) { blob = payload; }
            return navigator.sendBeacon(url, blob) === true;
        } catch (e) { return false; }
    }

    // ========================================================================
    // Transport 3 — <img src> GET with base64 payload (lowest common denominator)
    // ========================================================================

    function utf8ToBase64(s) {
        try { return btoa(unescape(encodeURIComponent(s))); }
        catch (e) { return ''; }
    }

    function sendImage(url, payload) {
        try {
            var b64 = utf8ToBase64(payload);
            if (!b64) return false;
            var fullUrl = url + '?d=' + encodeURIComponent(b64);
            if (fullUrl.length > IMG_URL_MAX) return false;   // payload too big for one GET
            var img = new Image();
            img.src = fullUrl;
            return true;
        } catch (e) { return false; }
    }

    // ========================================================================
    // Split oversized payload into per-entry chunks (only needed for image transport)
    // ========================================================================

    function sendImageChunks(url, batch) {
        for (var i = 0; i < batch.length; i++) {
            var single = JSON.stringify(batch[i]);
            if (!sendImage(url, single)) return false;
        }
        return true;
    }

    // ========================================================================
    // Flush — try POST → Beacon → Image in that order
    // ========================================================================

    function flush() {
        if (_flushing) return;
        if (!BUFFER.length) return;

        if (!storageEnabled() || !storageEndpoint()) {
            BUFFER.length = 0;
            return;
        }

        var ep = storageEndpoint();
        var url = ep + '/log';
        var batch = BUFFER.slice();
        BUFFER.length = 0;
        _flushing = true;

        var payload = JSON.stringify(batch);

        // 1) XHR POST
        var started = sendXHR(url, payload, function (ok) {
            if (ok) { _flushing = false; return; }
            // 2) sendBeacon
            if (sendBeacon(url, payload)) { _flushing = false; return; }
            // 3) <img> GET
            if (payload.length < IMG_URL_MAX) {
                sendImage(url, payload);
            } else {
                sendImageChunks(url, batch);
            }
            _flushing = false;
        });

        if (!started) {
            // XHR couldn't even construct — skip straight to beacon/image
            if (sendBeacon(url, payload)) { _flushing = false; return; }
            if (payload.length < IMG_URL_MAX) sendImage(url, payload);
            else sendImageChunks(url, batch);
            _flushing = false;
        }
    }

    // ========================================================================
    // Console / error hooks — patched IMMEDIATELY (before Lampa ready)
    // ========================================================================

    var _origLog   = (typeof console !== 'undefined' && console.log)   ? console.log   : function(){};
    var _origInfo  = (typeof console !== 'undefined' && console.info)  ? console.info  : _origLog;
    var _origWarn  = (typeof console !== 'undefined' && console.warn)  ? console.warn  : _origLog;
    var _origError = (typeof console !== 'undefined' && console.error) ? console.error : _origLog;

    (function patchConsole() {
        if (typeof console === 'undefined') return;
        console.log = function () {
            try { record('info', arguments); } catch (e) {}
            try { return _origLog.apply(console, arguments); } catch (e) {}
        };
        console.info = function () {
            try { record('info', arguments); } catch (e) {}
            try { return _origInfo.apply(console, arguments); } catch (e) {}
        };
        console.warn = function () {
            try { record('warn', arguments); } catch (e) {}
            try { return _origWarn.apply(console, arguments); } catch (e) {}
        };
        console.error = function () {
            try { record('error', arguments); } catch (e) {}
            try { return _origError.apply(console, arguments); } catch (e) {}
        };
    })();

    try {
        window.addEventListener('error', function (e) {
            try {
                var loc = (e.filename || '?') + ':' + (e.lineno || '?') + ':' + (e.colno || '?');
                record('error', ['[window]', (e && e.message) || 'error', loc]);
            } catch (_) {}
        }, true);
        window.addEventListener('unhandledrejection', function (e) {
            try {
                var r = e && e.reason;
                record('error', ['[promise]', r && r.message ? r.message : String(r)]);
            } catch (_) {}
        });
    } catch (e) {}

    // ========================================================================
    // LAN scanner — auto-discover log-server.py on the local network.
    // Triggered only on explicit user action (settings button). Probe hits
    // GET http://<ip>:<port>/health and validates response body contains
    // "lampa-log-server" — log-server.py's self-identification string.
    // ========================================================================

    var SCAN_DEFAULT_PORT  = 9999;
    var SCAN_PROBE_TIMEOUT = 1500;
    var SCAN_SIGNATURE     = 'lampa-log-server';
    var LAST_FOUND_KEY     = NS + 'last_found';
    var PORTS_KEY          = NS + 'ports';
    var SUBNETS_KEY        = NS + 'extra_subnets';

    var Util = {
        parsePortsCSV: function (s) {
            if (!s) return [];
            var parts = String(s).split(',');
            var out = [];
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i].replace(/\s+/g, '');
                if (!p || !/^\d+$/.test(p)) continue;
                var n = parseInt(p, 10);
                if (!isNaN(n) && n >= 1 && n <= 65535 && out.indexOf(n) === -1) out.push(n);
            }
            return out;
        },
        parseSubnetsCSV: function (s) {
            if (!s) return [];
            var parts = String(s).split(',');
            var out = [];
            var re = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i].replace(/\s+/g, '');
                if (!p) continue;
                var m = p.match(re);
                if (!m) continue;
                var a = +m[1], b = +m[2], c = +m[3];
                if (a > 255 || b > 255 || c > 255) continue;
                var pref = a + '.' + b + '.' + c;
                if (out.indexOf(pref) === -1) out.push(pref);
            }
            return out;
        },
        prefix24: function (ip) {
            if (!ip) return null;
            var m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\./);
            return m ? (m[1] + '.' + m[2] + '.' + m[3]) : null;
        },
        lastOctet: function (ip) {
            var m = String(ip).match(/\.(\d{1,3})$/);
            return m ? parseInt(m[1], 10) : null;
        },
        ipFromUrl: function (u) {
            if (!u) return null;
            var m = String(u).match(/\/\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)(?::\d+)?/);
            return m ? m[1] : null;
        },
        isPrivateIPv4: function (ip) {
            var m = String(ip).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
            if (!m) return false;
            var a = +m[1], b = +m[2];
            if (a === 10) return true;
            if (a === 192 && b === 168) return true;
            if (a === 172 && b >= 16 && b <= 31) return true;
            return false;
        }
    };

    function diag() {
        try {
            var args = ['[' + SELF_TAG + ']'];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            console.log.apply(console, args);
        } catch (e) {}
    }

    function tr(key) {
        try { return Lampa.Lang.translate(key); } catch (e) { return key; }
    }

    // ------------------------------------------------------------------------
    // Local-IP detection — Android bridge first, WebRTC fallback.
    // ------------------------------------------------------------------------

    var LocalIP = {
        getLocalPrefix: function (cb) {
            try {
                if (window.Android) {
                    var methods = ['getLocalIp', 'getLocalIP', 'localIp', 'getIp'];
                    for (var i = 0; i < methods.length; i++) {
                        if (typeof window.Android[methods[i]] !== 'function') continue;
                        try {
                            var ip = window.Android[methods[i]]();
                            if (ip && Util.isPrivateIPv4(ip)) {
                                diag('local IP via Android.' + methods[i] + ':', ip);
                                return cb(Util.prefix24(ip));
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
            LocalIP._tryWebRTC(function (ip) {
                if (ip) diag('local IP via WebRTC:', ip);
                cb(ip ? Util.prefix24(ip) : null);
            });
        },
        _tryWebRTC: function (cb) {
            var RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
            if (!RTC) return cb(null);
            var pc = null, timer = null, done = false;
            function finish(ip) {
                if (done) return;
                done = true;
                if (timer) clearTimeout(timer);
                try { if (pc) pc.close(); } catch (e) {}
                cb(ip);
            }
            try {
                pc = new RTC({ iceServers: [] });
                pc.createDataChannel('');
                pc.onicecandidate = function (e) {
                    if (!e || !e.candidate || !e.candidate.candidate) return;
                    var c = e.candidate.candidate;
                    if (c.indexOf('.local') >= 0) return;
                    var ms = c.match(/(\d+\.\d+\.\d+\.\d+)/g);
                    if (!ms) return;
                    for (var i = 0; i < ms.length; i++) {
                        if (Util.isPrivateIPv4(ms[i])) return finish(ms[i]);
                    }
                };
                pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
                                 .catch(function () { finish(null); });
                timer = setTimeout(function () { finish(null); }, 1500);
            } catch (e) { finish(null); }
        }
    };

    // ------------------------------------------------------------------------
    // Candidate list — three-phase priority order. Deduped.
    // ------------------------------------------------------------------------

    function buildCandidates(lastIp, ownPrefix, extraPrefixes, ports) {
        var seen = {};
        var out  = [];
        function push(ip, phase) {
            for (var i = 0; i < ports.length; i++) {
                var key = ip + ':' + ports[i];
                if (!seen[key]) { seen[key] = true; out.push({ ip: ip, port: ports[i], phase: phase }); }
            }
        }
        function range(prefix, from, to, phase) {
            if (!prefix) return;
            for (var i = from; i <= to; i++) push(prefix + '.' + i, phase);
        }
        ports = (ports && ports.length) ? ports : [SCAN_DEFAULT_PORT];
        extraPrefixes = extraPrefixes || [];

        var lastPref = lastIp ? Util.prefix24(lastIp) : null;
        if (lastIp && lastPref) {
            var lo = Util.lastOctet(lastIp);
            if (lo !== null) range(lastPref, Math.max(1, lo - 10), Math.min(254, lo + 10), 1);
        }
        var phase1 = [];
        if (lastPref)  phase1.push(lastPref);
        if (ownPrefix && phase1.indexOf(ownPrefix) === -1) phase1.push(ownPrefix);
        for (var i = 0; i < phase1.length; i++) {
            var common = [1, 100, 200, 254];
            for (var j = 0; j < common.length; j++) push(phase1[i] + '.' + common[j], 1);
        }
        if (ownPrefix) range(ownPrefix, 1, 254, 2);

        var fallbacks = ['192.168.0', '192.168.1', '10.0.0', '192.168.100'];
        for (var k = 0; k < extraPrefixes.length; k++) {
            if (fallbacks.indexOf(extraPrefixes[k]) === -1) fallbacks.push(extraPrefixes[k]);
        }
        for (var m = 0; m < fallbacks.length; m++) range(fallbacks[m], 1, 254, 3);

        return out;
    }

    // ------------------------------------------------------------------------
    // Probe — GET /health, signature match.
    // ------------------------------------------------------------------------

    function probe(ip, port, onDone, onReq) {
        var url = 'http://' + ip + ':' + port + '/health';
        var r;
        try { r = new Lampa.Reguest(); }
        catch (e) { return onDone({ ok: false }); }
        if (typeof onReq === 'function') onReq(r);
        try { r.timeout(SCAN_PROBE_TIMEOUT); } catch (e) {}
        try {
            r.native(url, function (body) {
                var s = (typeof body === 'string') ? body : (body == null ? '' : String(body));
                onDone({ ok: s.indexOf(SCAN_SIGNATURE) >= 0 });
            }, function () {
                onDone({ ok: false });
            }, false, { dataType: 'text' });
        } catch (e) {
            onDone({ ok: false });
        }
    }

    function saveEndpoint(endpoint) {
        if (!endpoint) return;
        try {
            Lampa.Storage.set(NS + 'endpoint', endpoint);
            Lampa.Storage.set(LAST_FOUND_KEY, endpoint);
            diag('endpoint saved:', endpoint);
            try {
                var $slot = $('[data-name="' + NS + 'endpoint"]');
                if ($slot.length) $slot.find('.settings-param__value').text(endpoint);
            } catch (e) {}
            try {
                if (Lampa.Noty && Lampa.Noty.show) {
                    Lampa.Noty.show(tr('log_collector_lan_saved_noty') + endpoint, { time: 3500 });
                }
            } catch (e) {}
        } catch (e) {
            diag('saveEndpoint failed:', e && e.message);
        }
    }

    // ------------------------------------------------------------------------
    // CSS — injected on first modal open.
    // ------------------------------------------------------------------------

    function ensureCSS() {
        if (document.getElementById('log-collector-lan-css')) return;
        var css =
            '.log-collector-lan-modal { max-width: 640px; }' +
            '.log-collector-lan-status { padding: 0.8em 0; color: rgba(255,255,255,0.7); font-size: 0.9em; }' +
            '.log-collector-lan-list { margin: 0.5em 0; max-height: 50vh; overflow-y: auto; }' +
            '.log-collector-lan-item { padding: 0.9em 1em; margin: 0.3em 0; background: rgba(255,255,255,0.06); border: 2px solid transparent; border-radius: 0.5em; cursor: pointer; display: flex; align-items: center; justify-content: space-between; outline: none; transition: background 0.1s, border-color 0.1s; }' +
            '.log-collector-lan-item.focus, .log-collector-lan-item.hover, .log-collector-lan-item:hover { background: #ffb400; border-color: #ffb400; color: #000; }' +
            '.log-collector-lan-item.focus .log-collector-lan-item-url, .log-collector-lan-item.hover .log-collector-lan-item-url, .log-collector-lan-item:hover .log-collector-lan-item-url { color: #000; }' +
            '.log-collector-lan-item-url { font-family: monospace; font-size: 1em; color: #fff; }' +
            '.log-collector-lan-empty { padding: 2em 1em; text-align: center; color: rgba(255,255,255,0.7); }' +
            '.log-collector-lan-footer { margin-top: 1em; display: flex; gap: 0.5em; }' +
            '.log-collector-lan-btn { flex: 1; padding: 0.8em; text-align: center; background: rgba(255,255,255,0.08); border: 2px solid transparent; border-radius: 0.5em; cursor: pointer; outline: none; color: #fff; transition: background 0.1s, border-color 0.1s; }' +
            '.log-collector-lan-btn.focus, .log-collector-lan-btn.hover, .log-collector-lan-btn:hover { background: #ffb400; border-color: #ffb400; color: #000; }' +
            '.log-collector-lan-spinner { display: inline-block; width: 0.9em; height: 0.9em; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: log-collector-lan-spin 0.9s linear infinite; margin-right: 0.5em; vertical-align: middle; }' +
            '@keyframes log-collector-lan-spin { to { transform: rotate(360deg); } }';
        var el = document.createElement('style');
        el.id = 'log-collector-lan-css';
        el.textContent = css;
        document.head.appendChild(el);
    }

    // ------------------------------------------------------------------------
    // Modal — live-updating picker.
    // ------------------------------------------------------------------------

    var ScanModal = {
        _state: null,
        isOpen: function () { return !!ScanModal._state; },
        open: function (opts) {
            opts = opts || {};
            if (ScanModal._state) {
                ScanModal._state.onPick  = opts.onPick  || ScanModal._state.onPick;
                ScanModal._state.onAbort = opts.onAbort || ScanModal._state.onAbort;
                ScanModal._state.onRetry = opts.onRetry || ScanModal._state.onRetry;
                return ScanModal._state;
            }
            ensureCSS();
            var $root   = $('<div class="log-collector-lan-modal"></div>');
            var $status = $('<div class="log-collector-lan-status"><span class="log-collector-lan-spinner"></span><span class="log-collector-lan-status-text"></span></div>');
            $status.find('.log-collector-lan-status-text').text(tr('log_collector_lan_status_scanning'));
            var $list   = $('<div class="log-collector-lan-list"></div>');
            var $empty  = $('<div class="log-collector-lan-empty" style="display:none;"></div>').text(tr('log_collector_lan_modal_empty'));
            var $footer = $('<div class="log-collector-lan-footer"></div>');
            var $retry  = $('<div class="log-collector-lan-btn selector" tabindex="1" style="display:none;"></div>').text(tr('log_collector_lan_modal_retry'));
            var $cancel = $('<div class="log-collector-lan-btn selector" tabindex="1"></div>').text(tr('log_collector_lan_modal_cancel'));
            $footer.append($retry).append($cancel);
            $root.append($status).append($list).append($empty).append($footer);

            var state = {
                $root: $root, $list: $list, $status: $status,
                $empty: $empty, $retry: $retry, $cancel: $cancel,
                seen: {}, count: 0, done: false, closed: false,
                prevController: null,
                onPick:  opts.onPick  || function () {},
                onAbort: opts.onAbort || function () {},
                onRetry: opts.onRetry || null
            };
            ScanModal._state = state;

            try {
                var m = Lampa.Controller.enabled();
                state.prevController = m && (m.name || (typeof m === 'string' ? m : null));
            } catch (e) { state.prevController = null; }

            function doCancel() {
                if (state.closed) return;
                ScanModal.close();
                try { state.onAbort(); } catch (e) { diag('onAbort error:', e && e.message); }
            }
            function doRetry() {
                if (state.closed || !state.onRetry) return;
                state.done = false; state.count = 0; state.seen = {};
                $list.empty(); $empty.hide(); $retry.hide();
                $status.show().find('.log-collector-lan-status-text').text(tr('log_collector_lan_status_scanning'));
                try { state.onRetry(); } catch (e) { diag('onRetry error:', e && e.message); }
            }
            $cancel.on('hover:enter', doCancel).on('click', doCancel);
            $retry.on('hover:enter', doRetry).on('click', doRetry);

            Lampa.Modal.open({
                title: tr('log_collector_lan_modal_title'),
                html:  $root,
                size:  'medium',
                mask:  true,
                onBack: doCancel
            });
            Lampa.Controller.add('modal', {
                invisible: true,
                toggle: function () {
                    try {
                        Lampa.Controller.collectionSet($root);
                        Lampa.Controller.collectionFocus(false, $root);
                    } catch (e) {}
                },
                update: function () {
                    try { Lampa.Controller.collectionSet($root); } catch (e) {}
                },
                back: doCancel
            });
            try { Lampa.Controller.toggle('modal'); } catch (e) {}

            return state;
        },
        addResult: function (entry) {
            var state = ScanModal._state;
            if (!state || state.closed) return;
            var url = entry && entry.url;
            if (!url || state.seen[url]) return;
            state.seen[url] = true;
            state.count++;

            var $item = $('<div class="log-collector-lan-item selector" tabindex="1"></div>').attr('data-url', url);
            $item.append($('<span class="log-collector-lan-item-url"></span>').text(url));
            function pick() {
                diag('result picked:', url);
                try { state.onPick && state.onPick(url); }
                catch (e) { diag('onPick error:', e && e.message); }
                ScanModal.close();
            }
            $item.on('hover:enter', pick).on('click', pick);
            state.$list.append($item);

            try {
                if (state.count === 1) {
                    Lampa.Controller.collectionSet(state.$root);
                    Lampa.Controller.collectionFocus($item[0], state.$root);
                } else {
                    Lampa.Controller.collectionSet(state.$root);
                }
            } catch (e) {}
        },
        setDone: function (opts) {
            var state = ScanModal._state;
            if (!state || state.closed) return;
            state.done = true;
            state.$status.hide();
            if (state.count === 0 && !(opts && opts.cancelled)) {
                state.$empty.show();
                if (state.onRetry) {
                    state.$retry.show();
                    try {
                        Lampa.Controller.collectionSet(state.$root);
                        Lampa.Controller.collectionFocus(state.$retry[0], state.$root);
                    } catch (e) {}
                }
            } else if (state.count > 0) {
                state.$status.show();
                state.$status.find('.log-collector-lan-status-text').text(tr('log_collector_lan_status_done') + state.count);
                state.$status.find('.log-collector-lan-spinner').hide();
            }
        },
        close: function () {
            var state = ScanModal._state;
            if (!state || state.closed) return;
            state.closed = true;
            ScanModal._state = null;
            try { Lampa.Modal.close(); } catch (e) {}
            try {
                if (state.prevController) Lampa.Controller.toggle(state.prevController);
                else Lampa.Controller.toggle('content');
            } catch (e) {}
        }
    };

    // ------------------------------------------------------------------------
    // Scanner — builds candidates, runs a bounded pool of probes, feeds modal.
    // ------------------------------------------------------------------------

    var Scanner = {
        _scanning: false,
        _aborted:  false,
        _reqs:     [],
        start: function (source) {
            if (Scanner._scanning) { diag('scan in progress, ignoring trigger from', source); return; }
            if (!(window.Lampa && Lampa.Reguest && Lampa.Modal && Lampa.Controller)) {
                diag('Lampa not ready for scan');
                return;
            }
            Scanner._scanning = true;
            Scanner._aborted  = false;
            Scanner._reqs     = [];
            diag('scan started (source=' + source + ')');
            ScanModal.open({
                onPick:  function (url) { Scanner.abort(); saveEndpoint(url); },
                onAbort: function () { Scanner.abort(); },
                onRetry: function () { Scanner._aborted = false; Scanner._reqs = []; Scanner._run(); }
            });
            Scanner._run();
        },
        _run: function () {
            var last = (Lampa.Storage.get(LAST_FOUND_KEY, '') || '').toString();
            var lastIp = Util.ipFromUrl(last);
            var ports  = Util.parsePortsCSV(Lampa.Storage.field(PORTS_KEY) || '') ;
            if (!ports.length) ports = [SCAN_DEFAULT_PORT];
            var extras = Util.parseSubnetsCSV(Lampa.Storage.field(SUBNETS_KEY) || '');

            LocalIP.getLocalPrefix(function (prefix) {
                if (Scanner._aborted) return;
                var cands = buildCandidates(lastIp, prefix, extras, ports);
                diag('candidates:', cands.length, 'prefix:', prefix, 'lastIp:', lastIp);
                var concurrency = 8;
                try {
                    if (Lampa.Platform && Lampa.Platform.screen && Lampa.Platform.screen() === 'tv') concurrency = 4;
                } catch (e) {}
                Scanner._pool(cands, concurrency,
                    function (cand, res) {
                        if (Scanner._aborted || !res || !res.ok) return;
                        ScanModal.addResult({ url: 'http://' + cand.ip + ':' + cand.port });
                    },
                    function () {
                        var cancelled = Scanner._aborted;
                        Scanner._scanning = false;
                        Scanner._reqs = [];
                        if (!cancelled) ScanModal.setDone({ cancelled: false });
                        diag('scan finished (cancelled=' + cancelled + ')');
                    }
                );
            });
        },
        _pool: function (cands, limit, onFound, onDone) {
            if (!cands.length) return onDone();
            var idx = 0, inflight = 0, finished = false;
            function next() {
                if (finished) return;
                if (Scanner._aborted) {
                    if (inflight === 0) { finished = true; onDone(); }
                    return;
                }
                while (inflight < limit && idx < cands.length) {
                    var cand = cands[idx++]; inflight++;
                    (function (c) {
                        probe(c.ip, c.port, function (res) {
                            inflight--;
                            try { onFound(c, res); } catch (e) { diag('onFound error:', e && e.message); }
                            if (Scanner._aborted && inflight === 0) {
                                if (!finished) { finished = true; onDone(); }
                                return;
                            }
                            if (idx >= cands.length && inflight === 0 && !finished) {
                                finished = true; onDone();
                                return;
                            }
                            next();
                        }, function (r) { Scanner._reqs.push(r); });
                    })(cand);
                }
                if (idx >= cands.length && inflight === 0 && !finished) {
                    finished = true; onDone();
                }
            }
            next();
        },
        abort: function () {
            if (!Scanner._scanning && !Scanner._reqs.length) return;
            Scanner._aborted = true;
            for (var i = 0; i < Scanner._reqs.length; i++) {
                try { Scanner._reqs[i].clear(); } catch (e) {}
            }
            Scanner._reqs = [];
            Scanner._scanning = false;
            diag('scan aborted');
        }
    };

    // ========================================================================
    // Lampa-dependent init (settings, request_error hook, flush timer)
    // ========================================================================

    function hookLampaErrors() {
        try {
            if (window.Lampa && Lampa.Listener && typeof Lampa.Listener.follow === 'function') {
                Lampa.Listener.follow('request_error', function (e) {
                    try {
                        var url = (e && e.params && e.params.url) || '?';
                        var st  = (e && e.error  && e.error.status) || '?';
                        record('warn', ['[request_error]', 'status=' + st, 'url=' + url]);
                    } catch (_) {}
                });
            }
        } catch (_) {}
    }

    function registerLang() {
        try {
            Lampa.Lang.add({
                log_collector_title:        { ru: 'Сборщик логов',               en: 'Log collector' },
                log_collector_enabled:      { ru: 'Включить',                    en: 'Enable' },
                log_collector_enabled_desc: { ru: 'Отправлять логи на ПК через LAN', en: 'Stream logs over LAN to the dev machine' },
                log_collector_endpoint:     { ru: 'Endpoint',                    en: 'Endpoint' },
                log_collector_endpoint_desc:{ ru: 'http://192.168.x.x:9999 — адрес log-server.py',     en: 'http://192.168.x.x:9999 — log-server.py URL' },
                log_collector_ping:         { ru: 'Тест (отправить тест-запись)', en: 'Test (send a probe entry)' },
                log_collector_ping_desc:    { ru: 'Пишет тестовую запись в логи ПК', en: 'Writes a probe entry to the PC log' },
                log_collector_on_toast:     { ru: 'Сборщик логов ВКЛ',            en: 'Log collector ON' },
                log_collector_off_toast:    { ru: 'Сборщик логов ВЫКЛ',           en: 'Log collector OFF' },

                log_collector_lan_scan:            { ru: 'Найти log-server в сети',     en: 'Find log-server on network' },
                log_collector_lan_scan_desc:       { ru: 'Сканирует локальную сеть и предлагает найденные адреса', en: 'Scans the LAN and offers discovered endpoints' },
                log_collector_lan_ports:           { ru: 'Порты log-server',            en: 'log-server ports' },
                log_collector_lan_ports_desc:      { ru: 'Через запятую. По умолчанию: 9999', en: 'Comma-separated list. Default: 9999' },
                log_collector_lan_subnets:         { ru: 'Доп. подсети /24',             en: 'Extra /24 subnets' },
                log_collector_lan_subnets_desc:    { ru: 'Первые 3 октета через запятую. Пример: 192.168.50,10.1.1', en: 'First 3 octets, comma-separated. Example: 192.168.50,10.1.1' },

                log_collector_lan_modal_title:     { ru: 'Найденные log-server',         en: 'Found log-servers' },
                log_collector_lan_modal_empty:     { ru: 'Серверы не найдены',           en: 'No servers found' },
                log_collector_lan_modal_retry:     { ru: 'Повторить',                    en: 'Retry' },
                log_collector_lan_modal_cancel:    { ru: 'Отмена',                       en: 'Cancel' },
                log_collector_lan_status_scanning: { ru: 'Сканирование сети…',           en: 'Scanning network…' },
                log_collector_lan_status_done:     { ru: 'Найдено серверов: ',           en: 'Servers found: ' },
                log_collector_lan_saved_noty:      { ru: 'log-server сохранён: ',        en: 'log-server saved: ' }
            });
        } catch (e) {}
    }

    function registerSettings() {
        try {
            Lampa.SettingsApi.addComponent({
                component: 'log_collector',
                name: Lampa.Lang.translate('log_collector_title'),
                icon: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                        '<path d="M4 6H20M4 12H20M4 18H14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
                      '</svg>'
            });

            Lampa.SettingsApi.addParam({
                component: 'log_collector',
                param: { name: NS + 'scan', type: 'button' },
                field: {
                    name:        Lampa.Lang.translate('log_collector_lan_scan'),
                    description: Lampa.Lang.translate('log_collector_lan_scan_desc')
                },
                onChange: function () { Scanner.start('settings'); },
                onRender: function ($el) {
                    try { $el.on('hover:enter', function () { Scanner.start('settings'); }); }
                    catch (e) {}
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'log_collector',
                param: { name: NS + 'enabled', type: 'trigger', default: false },
                field: {
                    name:        Lampa.Lang.translate('log_collector_enabled'),
                    description: Lampa.Lang.translate('log_collector_enabled_desc')
                },
                onChange: function (value) {
                    try {
                        if (!window.Lampa || !Lampa.Noty) return;
                        Lampa.Noty.show(Lampa.Lang.translate(
                            (value === true || value === 'true') ? 'log_collector_on_toast' : 'log_collector_off_toast'
                        ));
                    } catch (e) {}
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'log_collector',
                param: { name: NS + 'endpoint', type: 'input', default: '' },
                field: {
                    name:        Lampa.Lang.translate('log_collector_endpoint'),
                    description: Lampa.Lang.translate('log_collector_endpoint_desc')
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'log_collector',
                param: { name: PORTS_KEY, type: 'input', default: '9999' },
                field: {
                    name:        Lampa.Lang.translate('log_collector_lan_ports'),
                    description: Lampa.Lang.translate('log_collector_lan_ports_desc')
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'log_collector',
                param: { name: SUBNETS_KEY, type: 'input', default: '' },
                field: {
                    name:        Lampa.Lang.translate('log_collector_lan_subnets'),
                    description: Lampa.Lang.translate('log_collector_lan_subnets_desc')
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'log_collector',
                param: { name: NS + 'ping', type: 'button' },
                field: {
                    name:        Lampa.Lang.translate('log_collector_ping'),
                    description: Lampa.Lang.translate('log_collector_ping_desc')
                },
                onChange: function () {
                    try {
                        record('info', ['[LogCollector:probe]',
                            'ping from ' + (navigator.userAgent || 'unknown'),
                            'ver=' + ((Lampa.Manifest && Lampa.Manifest.app_digital) || 'n/a'),
                            'platform=' + ((Lampa.Platform && typeof Lampa.Platform.screen === 'function') ? Lampa.Platform.screen() : 'unknown')
                        ]);
                        flush();
                        if (Lampa.Noty && Lampa.Noty.show) {
                            Lampa.Noty.show('[LogCollector] ping sent → ' + (storageEndpoint() || '<no endpoint>'));
                        }
                    } catch (e) {}
                }
            });
        } catch (e) {}
    }

    function init() {
        if (_initialised) return;
        _initialised = true;

        registerLang();
        registerSettings();
        hookLampaErrors();
        _flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    }

    function start() {
        if (window.Lampa && Lampa.SettingsApi && Lampa.Storage && Lampa.Lang) init();
        else setTimeout(start, 500);
    }

    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (e) { if (e && e.type === 'ready') start(); });
        setTimeout(start, 1000);
    } else {
        var ri = setInterval(function () {
            if (window.Lampa && Lampa.Listener) {
                clearInterval(ri);
                Lampa.Listener.follow('app', function (e) { if (e && e.type === 'ready') start(); });
                setTimeout(start, 1000);
            }
        }, 300);
    }
})();
