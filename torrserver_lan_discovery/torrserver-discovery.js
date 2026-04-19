/*
 * TorrServer LAN Discovery — Lampa plugin
 *
 * Находит TorrServer в локальной сети и сохраняет выбранный адрес
 * в активный слот (torrserver_url / torrserver_url_two).
 *
 * Две точки входа:
 *   1. Кнопка «Найти в сети» в настройках сервера.
 *   2. Уведомление при двух подряд сетевых ошибках запросов к сохранённому
 *      TorrServer (OK во время уведомления — запуск поиска).
 *
 * Плагин single-file, ES5, без внешних зависимостей. Требует window.Lampa.
 */
(function () {
    'use strict';

    if (window.__torrserverLanDiscoveryLoaded) return;
    window.__torrserverLanDiscoveryLoaded = true;

    var LOG = '[TorrServerLAN]';

    function log() {
        try {
            var args = [LOG];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            console.log.apply(console, args);
        } catch (e) { /* noop */ }
    }

    /* ---------------------------------------------------------------------
     * Lang
     * ------------------------------------------------------------------- */
    function registerLang() {
        if (!window.Lampa || !Lampa.Lang || !Lampa.Lang.add) return;
        Lampa.Lang.add({
            torrserver_lan_settings_title: { ru: 'TorrServer в сети', en: 'TorrServer LAN Discovery' },
            torrserver_lan_settings_descr: { ru: 'Поиск TorrServer в локальной сети', en: 'Find TorrServer on the local network' },
            torrserver_lan_btn_scan: { ru: 'Найти в сети', en: 'Find on network' },
            torrserver_lan_btn_scan_descr: { ru: 'Просканировать локальную сеть и выбрать адрес TorrServer', en: 'Scan the local network and pick a TorrServer address' },
            torrserver_lan_param_enabled: { ru: 'Уведомление при ошибке подключения', en: 'Show notification on connection failure' },
            torrserver_lan_param_enabled_descr: { ru: 'Показывать на 4 секунды подсказку «OK — искать в сети»', en: 'Show 4-second "OK — search network" hint' },
            torrserver_lan_param_ports: { ru: 'Порты TorrServer', en: 'TorrServer ports' },
            torrserver_lan_param_ports_descr: { ru: 'Список через запятую. По умолчанию: 8090,8091', en: 'Comma-separated list. Defaults: 8090,8091' },
            torrserver_lan_param_subnets: { ru: 'Доп. подсети /24', en: 'Extra /24 subnets' },
            torrserver_lan_param_subnets_descr: { ru: 'Первые 3 октета через запятую. Пример: 192.168.50,10.1.1', en: 'First 3 octets, comma-separated. Example: 192.168.50,10.1.1' },
            torrserver_lan_noty_failed: { ru: 'Не могу подключиться к TorrServer. Нажмите OK чтобы поискать в сети', en: 'Cannot connect to TorrServer. Press OK to search the network' },
            torrserver_lan_modal_title: { ru: 'Найденные сервера', en: 'Found servers' },
            torrserver_lan_modal_empty: { ru: 'Серверы не найдены', en: 'No servers found' },
            torrserver_lan_modal_cancel: { ru: 'Отмена', en: 'Cancel' },
            torrserver_lan_modal_retry: { ru: 'Повторить', en: 'Retry' },
            torrserver_lan_status_scanning: { ru: 'Сканирование сети…', en: 'Scanning network…' },
            torrserver_lan_status_done: { ru: 'Найдено серверов: ', en: 'Servers found: ' },
            torrserver_lan_auth_required: { ru: 'требует авторизацию', en: 'auth required' },
            torrserver_lan_mixed_content_warning: {
                ru: 'Сканирование из браузера по HTTPS может не работать из-за ограничений mixed-content. В нативном приложении Lampa ограничение отсутствует.',
                en: 'Scanning from HTTPS browser may fail due to mixed-content restrictions. Native Lampa app is not affected.'
            }
        });
    }

    function T(key) {
        try { return Lampa.Lang.translate(key); } catch (e) { return key; }
    }

    /* ---------------------------------------------------------------------
     * CSS
     * ------------------------------------------------------------------- */
    function injectCSS() {
        if (document.getElementById('torrserver-lan-css')) return;
        var css =
            '.torrserver-lan-modal { max-width: 640px; }' +
            '.torrserver-lan-status { padding: 0.8em 0; color: rgba(255,255,255,0.7); font-size: 0.9em; }' +
            '.torrserver-lan-warning { padding: 0.8em 1em; margin-bottom: 0.8em; background: rgba(255,180,0,0.15); border-left: 3px solid #ffb400; color: #fff; font-size: 0.85em; border-radius: 4px; }' +
            '.torrserver-lan-list { margin: 0.5em 0; max-height: 50vh; overflow-y: auto; }' +
            '.torrserver-lan-item { padding: 0.9em 1em; margin: 0.3em 0; background: rgba(255,255,255,0.06); border-radius: 0.4em; cursor: pointer; display: flex; align-items: center; justify-content: space-between; outline: none; }' +
            '.torrserver-lan-item.focus, .torrserver-lan-item:hover { background: rgba(255,255,255,0.18); }' +
            '.torrserver-lan-item-url { font-family: monospace; font-size: 1em; color: #fff; }' +
            '.torrserver-lan-item-auth { font-size: 0.8em; color: #ffb400; margin-left: 1em; }' +
            '.torrserver-lan-empty { padding: 2em 1em; text-align: center; color: rgba(255,255,255,0.7); }' +
            '.torrserver-lan-footer { margin-top: 1em; display: flex; gap: 0.5em; }' +
            '.torrserver-lan-btn { flex: 1; padding: 0.8em; text-align: center; background: rgba(255,255,255,0.08); border-radius: 0.4em; cursor: pointer; outline: none; color: #fff; }' +
            '.torrserver-lan-btn.focus, .torrserver-lan-btn:hover { background: rgba(255,255,255,0.2); }' +
            '.torrserver-lan-spinner { display: inline-block; width: 0.9em; height: 0.9em; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: torrserver-lan-spin 0.9s linear infinite; margin-right: 0.5em; vertical-align: middle; }' +
            '@keyframes torrserver-lan-spin { to { transform: rotate(360deg); } }';
        var s = document.createElement('style');
        s.id = 'torrserver-lan-css';
        s.textContent = css;
        document.head.appendChild(s);
    }

    /* ---------------------------------------------------------------------
     * Util: CSV parsers, IP helpers
     * ------------------------------------------------------------------- */
    var Util = {
        parsePortsCSV: function (str) {
            if (!str) return [];
            var parts = String(str).split(',');
            var out = [];
            for (var i = 0; i < parts.length; i++) {
                var t = parts[i].replace(/\s+/g, '');
                if (!t) continue;
                if (!/^\d+$/.test(t)) continue;
                var n = parseInt(t, 10);
                if (isNaN(n) || n < 1 || n > 65535) continue;
                if (out.indexOf(n) === -1) out.push(n);
            }
            return out;
        },

        parseSubnetsCSV: function (str) {
            if (!str) return [];
            var parts = String(str).split(',');
            var out = [];
            var re = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
            for (var i = 0; i < parts.length; i++) {
                var t = parts[i].replace(/\s+/g, '');
                if (!t) continue;
                var m = t.match(re);
                if (!m) continue;
                var a = parseInt(m[1], 10), b = parseInt(m[2], 10), c = parseInt(m[3], 10);
                if (a > 255 || b > 255 || c > 255) continue;
                var norm = a + '.' + b + '.' + c;
                if (out.indexOf(norm) === -1) out.push(norm);
            }
            return out;
        },

        prefix24: function (ip) {
            if (!ip) return null;
            var m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\./);
            return m ? m[1] + '.' + m[2] + '.' + m[3] : null;
        },

        lastOctet: function (ip) {
            var m = String(ip).match(/\.(\d{1,3})$/);
            return m ? parseInt(m[1], 10) : null;
        },

        ipFromUrl: function (url) {
            if (!url) return null;
            var m = String(url).match(/\/\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)(?::\d+)?/);
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
        },

        activeSlotKey: function () {
            try {
                return Lampa.Storage.field('torrserver_use_link') === 'two'
                    ? 'torrserver_url_two'
                    : 'torrserver_url';
            } catch (e) { return 'torrserver_url'; }
        },

        activeTorrServerUrl: function () {
            try { return Lampa.Storage.get(Util.activeSlotKey()) || ''; } catch (e) { return ''; }
        }
    };

    /* ---------------------------------------------------------------------
     * NetworkInfo: best-effort discovery of local IPv4 prefix
     * ------------------------------------------------------------------- */
    var NetworkInfo = {
        getLocalPrefix: function (cb) {
            // 1) Android bridge, if Lampa's native shell exposes an IP getter.
            try {
                if (window.Android) {
                    var fns = ['getLocalIp', 'getLocalIP', 'localIp', 'getIp'];
                    for (var i = 0; i < fns.length; i++) {
                        if (typeof window.Android[fns[i]] === 'function') {
                            try {
                                var ip = window.Android[fns[i]]();
                                if (ip && Util.isPrivateIPv4(ip)) {
                                    log('local IP via Android.' + fns[i] + ':', ip);
                                    return cb(Util.prefix24(ip));
                                }
                            } catch (_e) { /* noop */ }
                        }
                    }
                }
            } catch (e) { /* noop */ }

            // 2) WebRTC candidate leak (may be blocked/mdns-masked on modern WVs).
            NetworkInfo._tryWebRTC(function (ip) {
                if (ip) log('local IP via WebRTC:', ip);
                cb(ip ? Util.prefix24(ip) : null);
            });
        },

        _tryWebRTC: function (done) {
            var RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
            if (!RTCPC) return done(null);
            var pc, finished = false, timer;
            function finish(ip) {
                if (finished) return;
                finished = true;
                if (timer) clearTimeout(timer);
                try { if (pc) pc.close(); } catch (e) { /* noop */ }
                done(ip);
            }
            try {
                pc = new RTCPC({ iceServers: [] });
                pc.createDataChannel('');
                pc.onicecandidate = function (e) {
                    if (!e || !e.candidate || !e.candidate.candidate) return;
                    var line = e.candidate.candidate;
                    if (line.indexOf('.local') >= 0) return; // mDNS-masked
                    var m = line.match(/(\d+\.\d+\.\d+\.\d+)/g);
                    if (!m) return;
                    for (var i = 0; i < m.length; i++) {
                        if (Util.isPrivateIPv4(m[i])) { finish(m[i]); return; }
                    }
                };
                pc.createOffer().then(function (desc) {
                    return pc.setLocalDescription(desc);
                })['catch'](function () { finish(null); });
                timer = setTimeout(function () { finish(null); }, 1500);
            } catch (e) {
                finish(null);
            }
        }
    };

    /* ---------------------------------------------------------------------
     * CandidateBuilder
     * ------------------------------------------------------------------- */
    var CandidateBuilder = {
        build: function (lastFoundIp, localPrefix, extraSubnets, ports) {
            var seen = {};
            var out = [];
            ports = ports && ports.length ? ports : [8090, 8091];
            extraSubnets = extraSubnets || [];

            function push(ip, phase) {
                for (var i = 0; i < ports.length; i++) {
                    var key = ip + ':' + ports[i];
                    if (seen[key]) continue;
                    seen[key] = true;
                    out.push({ ip: ip, port: ports[i], phase: phase });
                }
            }

            function pushRange(prefix, from, to, phase) {
                if (!prefix) return;
                for (var n = from; n <= to; n++) push(prefix + '.' + n, phase);
            }

            // Phase 1: hot addresses
            var hotPrefix = lastFoundIp ? Util.prefix24(lastFoundIp) : null;
            if (lastFoundIp && hotPrefix) {
                var last = Util.lastOctet(lastFoundIp);
                if (last !== null) {
                    var from = Math.max(1, last - 10);
                    var to = Math.min(254, last + 10);
                    pushRange(hotPrefix, from, to, 1);
                }
            }
            var hotPrefixes = [];
            if (hotPrefix) hotPrefixes.push(hotPrefix);
            if (localPrefix && hotPrefixes.indexOf(localPrefix) === -1) hotPrefixes.push(localPrefix);
            for (var pi = 0; pi < hotPrefixes.length; pi++) {
                var pref = hotPrefixes[pi];
                var typical = [1, 100, 200, 254];
                for (var ti = 0; ti < typical.length; ti++) push(pref + '.' + typical[ti], 1);
            }

            // Phase 2: full gateway /24 (if known)
            if (localPrefix) pushRange(localPrefix, 1, 254, 2);

            // Phase 3: fallback subnets + user-defined
            var fallback = ['192.168.0', '192.168.1', '10.0.0', '192.168.100'];
            for (var fi = 0; fi < extraSubnets.length; fi++) {
                if (fallback.indexOf(extraSubnets[fi]) === -1) fallback.push(extraSubnets[fi]);
            }
            for (var si = 0; si < fallback.length; si++) pushRange(fallback[si], 1, 254, 3);

            return out;
        }
    };

    /* ---------------------------------------------------------------------
     * Probe
     * ------------------------------------------------------------------- */
    var Probe = {
        check: function (ip, port, cb, trackNet) {
            var url = 'http://' + ip + ':' + port + '/echo';
            var net;
            try { net = new Lampa.Reguest(); }
            catch (e) { return cb({ ok: false }); }
            if (typeof trackNet === 'function') trackNet(net);
            try { net.timeout(1500); } catch (e) { /* noop */ }
            try {
                net.native(
                    url,
                    function (body) {
                        var text = (typeof body === 'string') ? body : (body == null ? '' : String(body));
                        if (text && text.toLowerCase().indexOf('matrix') !== -1) {
                            cb({ ok: true, status: 200, auth: false });
                        } else {
                            cb({ ok: false });
                        }
                    },
                    function (xhr) {
                        var st = xhr && typeof xhr.status === 'number' ? xhr.status : 0;
                        if (st === 401) cb({ ok: true, status: 401, auth: true });
                        else cb({ ok: false });
                    },
                    false,
                    { dataType: 'text' }
                );
            } catch (e) {
                cb({ ok: false });
            }
        }
    };

    /* ---------------------------------------------------------------------
     * StorageBridge: persist selected URL into the active TorrServer slot
     * ------------------------------------------------------------------- */
    var StorageBridge = {
        save: function (url) {
            if (!url) return;
            try {
                var slot = Util.activeSlotKey();
                Lampa.Storage.set(slot, url);
                Lampa.Storage.set('torrserver_lan_last_found', url);
                log('saved to', slot, url);
            } catch (e) {
                log('save failed:', e && e.message);
            }
        }
    };

    /* ---------------------------------------------------------------------
     * ResultsModal — the list UI (shared by both entry points)
     * ------------------------------------------------------------------- */
    var ResultsModal = {
        _state: null,

        isOpen: function () { return !!ResultsModal._state; },

        open: function (opts) {
            opts = opts || {};
            if (ResultsModal._state) {
                // Already open — re-arm with new callbacks, don't stack modals.
                ResultsModal._state.onPick = opts.onPick || ResultsModal._state.onPick;
                ResultsModal._state.onAbort = opts.onAbort || ResultsModal._state.onAbort;
                ResultsModal._state.onRetry = opts.onRetry || ResultsModal._state.onRetry;
                return ResultsModal._state;
            }

            injectCSS();

            var $root = $('<div class="torrserver-lan-modal"></div>');
            var showWarning = (window.location && window.location.protocol === 'https:')
                && !(Lampa.Platform && Lampa.Platform.is && (Lampa.Platform.is('android') || Lampa.Platform.is('tizen') || Lampa.Platform.is('webos')));
            if (showWarning) {
                $root.append('<div class="torrserver-lan-warning">' + esc(T('torrserver_lan_mixed_content_warning')) + '</div>');
            }
            var $status = $('<div class="torrserver-lan-status"><span class="torrserver-lan-spinner"></span><span class="torrserver-lan-status-text"></span></div>');
            $status.find('.torrserver-lan-status-text').text(T('torrserver_lan_status_scanning'));
            var $list = $('<div class="torrserver-lan-list"></div>');
            var $empty = $('<div class="torrserver-lan-empty" style="display:none"></div>').text(T('torrserver_lan_modal_empty'));
            var $footer = $('<div class="torrserver-lan-footer"></div>');
            var $retry = $('<div class="torrserver-lan-btn torrserver-lan-retry selector" tabindex="1" style="display:none"></div>').text(T('torrserver_lan_modal_retry'));
            var $cancel = $('<div class="torrserver-lan-btn torrserver-lan-cancel selector" tabindex="1"></div>').text(T('torrserver_lan_modal_cancel'));
            $footer.append($retry).append($cancel);
            $root.append($status).append($list).append($empty).append($footer);

            var state = {
                $root: $root,
                $list: $list,
                $status: $status,
                $empty: $empty,
                $retry: $retry,
                $cancel: $cancel,
                seen: {},
                count: 0,
                done: false,
                prevController: null,
                onPick: opts.onPick || function () {},
                onAbort: opts.onAbort || function () {},
                onRetry: opts.onRetry || null,
                closed: false
            };
            ResultsModal._state = state;

            try {
                var enabled = Lampa.Controller.enabled();
                state.prevController = enabled && (enabled.name || (typeof enabled === 'string' ? enabled : null));
            } catch (e) { state.prevController = null; }

            function doPick($item) {
                var url = $item.attr('data-url');
                if (!url || state.closed) return;
                ResultsModal.close();
                try { state.onPick(url); } catch (e) { log('onPick error:', e && e.message); }
            }

            function doAbort() {
                if (state.closed) return;
                ResultsModal.close();
                try { state.onAbort(); } catch (e) { log('onAbort error:', e && e.message); }
            }

            function doRetry() {
                if (state.closed || !state.onRetry) return;
                state.done = false;
                state.count = 0;
                state.seen = {};
                $list.empty();
                $empty.hide();
                $retry.hide();
                $status.show().find('.torrserver-lan-status-text').text(T('torrserver_lan_status_scanning'));
                try { state.onRetry(); } catch (e) { log('onRetry error:', e && e.message); }
            }

            $cancel.on('hover:enter', function () { doAbort(); }).on('click', function () { doAbort(); });
            $retry.on('hover:enter', function () { doRetry(); }).on('click', function () { doRetry(); });

            Lampa.Modal.open({
                title: T('torrserver_lan_modal_title'),
                html: $root,
                size: 'medium',
                mask: true,
                onBack: doAbort
            });

            // Override Lampa's built-in 'modal' controller AFTER Modal.open — Modal.open
            // internally calls Controller.add('modal', ...) with a default handler that
            // just closes on any key. We replace it so Enter on a focused .selector item
            // dispatches hover:enter (and reaches our per-item listener).
            // Pattern: see interaction/torserver.js error().
            Lampa.Controller.add('modal', {
                invisible: true,
                toggle: function () {
                    try {
                        Lampa.Controller.collectionSet($root);
                        // Pass `false` — Lampa auto-focuses the first `.selector` in the
                        // collection (the same call as interaction/torserver.js).
                        Lampa.Controller.collectionFocus(false, $root);
                    } catch (e) { /* noop */ }
                },
                update: function () {
                    try { Lampa.Controller.collectionSet($root); } catch (e) { /* noop */ }
                },
                back: doAbort
            });
            try { Lampa.Controller.toggle('modal'); } catch (e) { /* noop */ }

            return state;
        },

        addResult: function (entry) {
            var state = ResultsModal._state;
            if (!state || state.closed) return;
            var url = entry && entry.url;
            if (!url || state.seen[url]) return;
            state.seen[url] = true;
            state.count++;

            var $item = $('<div class="torrserver-lan-item selector" tabindex="1"></div>').attr('data-url', url);
            $item.append($('<span class="torrserver-lan-item-url"></span>').text(url));
            if (entry.auth) {
                $item.append($('<span class="torrserver-lan-item-auth"></span>').text('🔒 ' + T('torrserver_lan_auth_required')));
            }
            // Per-item listener (not delegation) + click for mouse users.
            function pick() {
                log('result picked:', url);
                try { state.onPick && state.onPick(url); } catch (e) { log('onPick error:', e && e.message); }
                ResultsModal.close();
            }
            $item.on('hover:enter', pick).on('click', pick);
            state.$list.append($item);

            // Re-seed the Controller collection so Lampa's focus navigation (up/down)
            // sees the new item and can move focus onto it.
            if (state.count === 1) {
                try {
                    Lampa.Controller.collectionSet(state.$root);
                    Lampa.Controller.collectionFocus($item[0], state.$root);
                } catch (e) { /* noop */ }
            } else {
                try { Lampa.Controller.collectionSet(state.$root); } catch (e) { /* noop */ }
            }
        },

        setDone: function (info) {
            var state = ResultsModal._state;
            if (!state || state.closed) return;
            state.done = true;
            var count = state.count;
            state.$status.hide();
            if (count === 0 && !(info && info.cancelled)) {
                state.$empty.show();
                if (state.onRetry) {
                    state.$retry.show();
                    try {
                        Lampa.Controller.collectionSet(state.$root);
                        Lampa.Controller.collectionFocus(state.$retry[0], state.$root);
                    } catch (e) { /* noop */ }
                }
            } else if (count > 0) {
                state.$status.show().find('.torrserver-lan-status-text').text(T('torrserver_lan_status_done') + count);
                state.$status.find('.torrserver-lan-spinner').hide();
            }
        },

        close: function () {
            var state = ResultsModal._state;
            if (!state || state.closed) return;
            state.closed = true;
            ResultsModal._state = null;
            try { Lampa.Modal.close(); } catch (e) { /* noop */ }
            try {
                if (state.prevController && Lampa.Controller.has && Lampa.Controller.has(state.prevController)) {
                    Lampa.Controller.toggle(state.prevController);
                } else if (state.prevController) {
                    // Best-effort fallback if has() not available.
                    try { Lampa.Controller.toggle(state.prevController); } catch (e) { /* noop */ }
                } else {
                    try { Lampa.Controller.toggle('content'); } catch (e) { /* noop */ }
                }
            } catch (e) { /* noop */ }
        }
    };

    function esc(s) {
        s = s == null ? '' : String(s);
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* ---------------------------------------------------------------------
     * Scanner — orchestrates the phased scan with a worker pool
     * ------------------------------------------------------------------- */
    var Scanner = {
        _scanning: false,
        _nets: [],
        _aborted: false,

        start: function (source) {
            if (Scanner._scanning) {
                log('scan already in progress, ignoring trigger from', source);
                if (!ResultsModal.isOpen()) {
                    // Shouldn't happen, but guard.
                }
                return;
            }
            Scanner._scanning = true;
            Scanner._aborted = false;
            Scanner._nets = [];
            log('scan started (source=' + source + ')');

            var modal = ResultsModal.open({
                onPick: function (url) {
                    Scanner.abort();
                    StorageBridge.save(url);
                },
                onAbort: function () { Scanner.abort(); },
                onRetry: function () {
                    // Retry reuses the same modal — relaunch internal scan.
                    Scanner._aborted = false;
                    Scanner._nets = [];
                    Scanner._runInternal();
                }
            });

            Scanner._runInternal();
        },

        _runInternal: function () {
            var lastFound = (Lampa.Storage.get('torrserver_lan_last_found', '') || '').toString();
            var lastIp = Util.ipFromUrl(lastFound);
            var ports = Util.parsePortsCSV(Lampa.Storage.field('torrserver_lan_ports') || '8090,8091');
            if (!ports.length) ports = [8090, 8091];
            var extra = Util.parseSubnetsCSV(Lampa.Storage.field('torrserver_lan_extra_subnets') || '');

            NetworkInfo.getLocalPrefix(function (prefix) {
                if (Scanner._aborted) return;
                var candidates = CandidateBuilder.build(lastIp, prefix, extra, ports);
                log('built candidates:', candidates.length, 'prefix:', prefix, 'lastIp:', lastIp);

                var concurrency = 8;
                try {
                    if (Lampa.Platform && Lampa.Platform.screen && Lampa.Platform.screen() === 'tv') concurrency = 4;
                } catch (e) { /* noop */ }

                Scanner._runPool(candidates, concurrency, function (cand, result) {
                    if (Scanner._aborted) return;
                    if (result && result.ok) {
                        var url = 'http://' + cand.ip + ':' + cand.port;
                        ResultsModal.addResult({ url: url, auth: !!result.auth });
                    }
                }, function () {
                    var cancelled = Scanner._aborted;
                    Scanner._scanning = false;
                    Scanner._nets = [];
                    if (!cancelled) ResultsModal.setDone({ cancelled: false });
                    log('scan finished (cancelled=' + cancelled + ')');
                });
            });
        },

        _runPool: function (candidates, concurrency, onFound, onDone) {
            var i = 0, inFlight = 0, finished = false;
            function next() {
                if (finished) return;
                if (Scanner._aborted) {
                    if (inFlight === 0) { finished = true; onDone(); }
                    return;
                }
                while (inFlight < concurrency && i < candidates.length) {
                    var cand = candidates[i++];
                    inFlight++;
                    (function (c) {
                        Probe.check(c.ip, c.port, function (res) {
                            inFlight--;
                            try { onFound(c, res); } catch (e) { log('onFound error:', e && e.message); }
                            if (Scanner._aborted && inFlight === 0) {
                                if (!finished) { finished = true; onDone(); }
                                return;
                            }
                            if (i >= candidates.length && inFlight === 0 && !finished) {
                                finished = true; onDone();
                                return;
                            }
                            next();
                        }, function (net) { Scanner._nets.push(net); });
                    })(cand);
                }
                if (i >= candidates.length && inFlight === 0 && !finished) {
                    finished = true; onDone();
                }
            }
            if (!candidates.length) { onDone(); return; }
            next();
        },

        abort: function () {
            if (!Scanner._scanning && !Scanner._nets.length) return;
            Scanner._aborted = true;
            for (var i = 0; i < Scanner._nets.length; i++) {
                try { Scanner._nets[i].clear(); } catch (e) { /* noop */ }
            }
            Scanner._nets = [];
            // Reset synchronously — net.clear() silences in-flight callbacks via
            // _calls.indexOf()===-1, so onDone would otherwise never fire.
            Scanner._scanning = false;
            log('scan aborted');
        }
    };

    /* ---------------------------------------------------------------------
     * ErrorWatcher — fallback notification on repeated TorrServer failures
     * ------------------------------------------------------------------- */
    var ErrorWatcher = {
        _hits: {}, // url → [timestamps]
        _installed: false,

        install: function () {
            if (ErrorWatcher._installed) return;
            ErrorWatcher._installed = true;
            if (!window.Lampa || !Lampa.Listener || !Lampa.Listener.follow) return;
            Lampa.Listener.follow('request_error', ErrorWatcher._onRequestError);
        },

        _onRequestError: function (evt) {
            try {
                if (Lampa.Storage.field('torrserver_lan_enabled') === false) return;
                var active = Util.activeTorrServerUrl();
                if (!active) return;
                var url = evt && evt.params && evt.params.url;
                if (!url) return;
                if (String(url).indexOf(active) !== 0) return;

                var xhr = evt.error || {};
                var exception = evt.exception || '';
                var status = typeof xhr.status === 'number' ? xhr.status : 0;
                if (!(status === 0 || exception === 'timeout')) return;

                var now = Date.now();
                var arr = ErrorWatcher._hits[active] || [];
                // keep only hits within last 10s
                arr = arr.filter(function (ts) { return now - ts <= 10000; });
                arr.push(now);
                ErrorWatcher._hits[active] = arr;
                if (arr.length < 2) return;

                // Reset — one notification per streak.
                ErrorWatcher._hits[active] = [];
                if (Notifier.isShowing() || Scanner._scanning || ResultsModal.isOpen()) {
                    log('debounce threshold hit but suppressed:',
                        'notifying=' + Notifier.isShowing(),
                        'scanning=' + Scanner._scanning,
                        'modalOpen=' + ResultsModal.isOpen());
                    return;
                }
                log('debounce triggered for', active, '- showing notifier');
                Notifier.show();
            } catch (e) {
                log('ErrorWatcher error:', e && e.message);
            }
        }
    };

    /* ---------------------------------------------------------------------
     * Notifier — 4-second noty + OK-capture via a transient Controller
     * ------------------------------------------------------------------- */
    var Notifier = {
        _armed: false,
        _timer: null,
        _$html: null,
        _prev: null,

        isShowing: function () { return Notifier._armed; },

        show: function () {
            if (Notifier._armed) return;
            Notifier._armed = true;

            // Lampa.Modal is the only reliable way to capture OK on the main screen:
            // Lampa's input pipeline routes Enter to the focused .selector inside an
            // open Modal. Without a Modal, Controller.toggle does not actually redirect
            // keys. This matches the pattern in interaction/torserver.js error modal
            // and series_auto_skip's countdown button (which runs inside the player
            // where focus routing is already modal-like).
            if (!document.getElementById('torrserver-lan-noty-css')) {
                var s = document.createElement('style');
                s.id = 'torrserver-lan-noty-css';
                s.textContent =
                    '.torrserver-lan-noty-modal{padding:0.5em 0.3em;max-width:560px;}' +
                    '.torrserver-lan-noty-text{font-size:1em;line-height:1.35;margin-bottom:1.2em;color:#fff;}' +
                    '.torrserver-lan-noty-buttons{display:flex;gap:0.6em;}' +
                    '.torrserver-lan-noty-btn{flex:1;padding:0.8em 1em;text-align:center;border-radius:0.4em;background:rgba(255,255,255,0.1);outline:none;cursor:pointer;color:#fff;font-weight:500;}' +
                    '.torrserver-lan-noty-btn.focus,.torrserver-lan-noty-btn:hover{background:#ffb400;color:#000;}';
                document.head.appendChild(s);
            }
            var $html = $('<div class="torrserver-lan-noty-modal"></div>');
            var $text = $('<div class="torrserver-lan-noty-text"></div>').text(T('torrserver_lan_noty_failed'));
            var $buttons = $('<div class="torrserver-lan-noty-buttons"></div>');
            var $ok = $('<div class="selector torrserver-lan-noty-btn torrserver-lan-noty-btn-ok" tabindex="1"></div>').text('OK');
            var $cancel = $('<div class="selector torrserver-lan-noty-btn torrserver-lan-noty-btn-cancel" tabindex="1"></div>').text(T('torrserver_lan_modal_cancel'));
            $buttons.append($ok).append($cancel);
            $html.append($text).append($buttons);

            $ok.on('hover:enter', Notifier._handleEnter);
            $cancel.on('hover:enter', Notifier._handleBack);

            try {
                var enabled = Lampa.Controller.enabled();
                Notifier._prev = enabled && (enabled.name || (typeof enabled === 'string' ? enabled : null));
            } catch (e) { Notifier._prev = null; }

            Notifier._$html = $html;

            try {
                Lampa.Modal.open({
                    title: '',
                    html: $html,
                    size: 'small',
                    mask: true,
                    onBack: Notifier._handleBack
                });
            } catch (e) { log('Modal.open error:', e && e.message); }

            // Override Lampa's 'modal' controller AFTER Modal.open — Modal.open internally
            // calls Controller.add('modal', ...) with its default handler; we replace it
            // with ours so Enter/Back route to our handlers. Pattern: see
            // interaction/torserver.js error() where Controller.add('modal', ...) comes
            // after Modal.update(temp).
            Lampa.Controller.add('modal', {
                invisible: true,
                toggle: function () {
                    try {
                        Lampa.Controller.collectionSet($html);
                        Lampa.Controller.collectionFocus($ok[0], $html);
                    } catch (e) { /* noop */ }
                },
                update: function () {
                    try { Lampa.Controller.collectionSet($html); } catch (e) { /* noop */ }
                },
                back: Notifier._handleBack
            });

            try { Lampa.Controller.toggle('modal'); } catch (e) { /* noop */ }
            // Explicit focus re-assignment — Lampa.Modal.open inserts html into the DOM
            // asynchronously on some builds, so the collectionFocus inside toggle() can
            // run before $html is actually in the layout tree. Re-apply on the next tick.
            setTimeout(function () {
                try {
                    Lampa.Controller.collectionSet($html);
                    Lampa.Controller.collectionFocus($ok[0], $html);
                } catch (e) { /* noop */ }
            }, 0);

            log('notifier modal shown, prev:', Notifier._prev);
            Notifier._timer = setTimeout(Notifier._expire, 4000);
        },

        _clearTimer: function () {
            if (Notifier._timer) { clearTimeout(Notifier._timer); Notifier._timer = null; }
        },

        _teardown: function () {
            if (Notifier._$html) {
                try { Notifier._$html.find('.selector').off('hover:enter'); } catch (e) { /* noop */ }
                Notifier._$html = null;
            }
            try { Lampa.Modal.close(); } catch (e) { /* noop */ }
            var prev = Notifier._prev;
            Notifier._prev = null;
            if (prev) {
                try { Lampa.Controller.toggle(prev); } catch (e) { /* noop */ }
            }
        },

        _handleEnter: function () {
            if (!Notifier._armed) return;
            Notifier._armed = false;
            Notifier._clearTimer();
            Notifier._teardown();
            Scanner.start('noty');
        },

        _handleBack: function () {
            if (!Notifier._armed) return;
            Notifier._armed = false;
            Notifier._clearTimer();
            Notifier._teardown();
        },

        _expire: function () {
            if (!Notifier._armed) return;
            Notifier._armed = false;
            Notifier._timer = null;
            Notifier._teardown();
        }
    };

    /* ---------------------------------------------------------------------
     * Settings (Lampa.SettingsApi)
     * ------------------------------------------------------------------- */
    var SETTINGS_REGISTERED = false;

    function registerSettings() {
        if (SETTINGS_REGISTERED) return;
        if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addParam) return;
        SETTINGS_REGISTERED = true;

        var icon = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<circle cx="12" cy="12" r="9"></circle>'
            + '<path d="M12 3a15 15 0 0 1 0 18"></path>'
            + '<path d="M12 3a15 15 0 0 0 0 18"></path>'
            + '<path d="M3 12h18"></path>'
            + '<circle cx="12" cy="12" r="2" fill="currentColor"></circle>'
            + '</svg>';

        Lampa.SettingsApi.addComponent({
            component: 'torrserver_lan_discovery',
            name: T('torrserver_lan_settings_title'),
            icon: icon
        });

        Lampa.SettingsApi.addParam({
            component: 'torrserver_lan_discovery',
            param: { name: 'torrserver_lan_enabled', type: 'trigger', 'default': true },
            field: {
                name: T('torrserver_lan_param_enabled'),
                description: T('torrserver_lan_param_enabled_descr')
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrserver_lan_discovery',
            param: { name: 'torrserver_lan_ports', type: 'input', 'default': '8090,8091' },
            field: {
                name: T('torrserver_lan_param_ports'),
                description: T('torrserver_lan_param_ports_descr')
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrserver_lan_discovery',
            param: { name: 'torrserver_lan_extra_subnets', type: 'input', 'default': '' },
            field: {
                name: T('torrserver_lan_param_subnets'),
                description: T('torrserver_lan_param_subnets_descr')
            }
        });

        // Scan button lives inside the existing `server` settings component.
        Lampa.SettingsApi.addParam({
            component: 'server',
            param: { name: 'torrserver_lan_scan_btn', type: 'button' },
            field: {
                name: T('torrserver_lan_btn_scan'),
                description: T('torrserver_lan_btn_scan_descr')
            },
            onChange: function () { Scanner.start('settings'); },
            onRender: function ($row) {
                try { $row.on('hover:enter', function () { Scanner.start('settings'); }); }
                catch (e) { /* noop */ }
            }
        });
    }

    /* ---------------------------------------------------------------------
     * Manifest
     * ------------------------------------------------------------------- */
    function registerManifest() {
        try {
            if (!Lampa.Manifest) return;
            Lampa.Manifest.plugins = {
                type: 'video',
                version: '0.1.0',
                name: 'TorrServer LAN Discovery',
                description: 'Поиск TorrServer в локальной сети и выбор адреса без ручного ввода'
            };
        } catch (e) { /* noop */ }
    }

    /* ---------------------------------------------------------------------
     * Init / Bootstrap
     * ------------------------------------------------------------------- */
    function init() {
        registerLang();
        injectCSS();
        registerManifest();
        registerSettings();
        ErrorWatcher.install();
        log('initialized v0.1.0');
    }

    function start() {
        if (window.Lampa && Lampa.SettingsApi && Lampa.Storage && Lampa.Listener && Lampa.Controller && Lampa.Modal) {
            init();
        } else {
            setTimeout(start, 500);
        }
    }

    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
        setTimeout(start, 1000);
    } else {
        var ri = setInterval(function () {
            if (window.Lampa && Lampa.Listener) {
                clearInterval(ri);
                Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
                setTimeout(start, 1000);
            }
        }, 300);
    }
})();
