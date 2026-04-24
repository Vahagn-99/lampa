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
 * Opt-in: disabled by default. Flip "Включить" in Настройки → Сборщик логов
 * + enter endpoint URL. Restart Lampa to capture boot-time logs from
 * other plugins.
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
                log_collector_off_toast:    { ru: 'Сборщик логов ВЫКЛ',           en: 'Log collector OFF' }
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
