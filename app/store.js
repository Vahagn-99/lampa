/*!
 * My Plugin Store — one URL, full marketplace
 *
 * Adds "Мои плагины" to Lampa's main settings. Clicking it opens Lampa's
 * native extensions store UI pointing at our extensions.json catalog,
 * with install / uninstall actions for every plugin we register.
 *
 * Also auto-installs the log-collector on first run so that log streaming
 * to the dev machine begins working without any manual step.
 *
 * Auto-install is idempotent: on every Lampa start we add missing URLs
 * to localStorage.plugins and reload only if something actually changed.
 *
 * Log prefix:   [Store]
 * Global guard: window.__vahagnStoreLoaded
 * Storage ns:   vahagn_store_*
 */
(function () {
    'use strict';

    if (window.__vahagnStoreLoaded) return;
    window.__vahagnStoreLoaded = true;

    // ========================================================================
    // Configuration — fill in at build time from plugins.yml. A tiny tool can
    // rewrite the CATALOG_URL / AUTO_INSTALL constants if we ever want to,
    // but they rarely change so hardcoded is fine.
    // ========================================================================

    var CATALOG_URL = 'https://vahagn-99.github.io/lampa/storage/extensions.json';

    // URLs that will be injected into localStorage.plugins on first run if
    // missing. Keep in sync with plugins.yml:auto_install.
    var AUTO_INSTALL = [
        'https://vahagn-99.github.io/lampa/app/plugins/log-collector.js'
    ];

    var STORE_COMPONENT = 'vahagn_store';
    var RELOAD_DELAY    = 3000;

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[Store]');
            console.log.apply(console, args);
        } catch (e) {}
    }

    // ========================================================================
    // Auto-install: idempotently ensure AUTO_INSTALL URLs are in plugins list
    // ========================================================================

    function ensureAutoInstalled() {
        try {
            var raw = localStorage.getItem('plugins') || '[]';
            var list;
            try { list = JSON.parse(raw); } catch (e) { list = []; }
            if (!list || list.constructor !== Array) list = [];

            var seen = {};
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].url) seen[list[i].url] = true;
            }

            var added = 0;
            for (var j = 0; j < AUTO_INSTALL.length; j++) {
                if (!seen[AUTO_INSTALL[j]]) {
                    list.push({ url: AUTO_INSTALL[j], status: true });
                    seen[AUTO_INSTALL[j]] = true;
                    added++;
                }
            }

            if (added === 0) {
                log('auto-install steady-state, nothing to add');
                return;
            }

            localStorage.setItem('plugins', JSON.stringify(list));
            try {
                if (window.Lampa && Lampa.Noty && Lampa.Noty.show) {
                    Lampa.Noty.show('[Store] auto-installed ' + added + ' plugin(s), reloading...', { time: RELOAD_DELAY });
                }
            } catch (e) {}
            log('auto-installed', added, 'plugin(s); reloading in', RELOAD_DELAY, 'ms');
            setTimeout(function () {
                try { window.location.reload(); } catch (e) {}
            }, RELOAD_DELAY);
        } catch (err) {
            try { console.error('[Store]', err); } catch (e) {}
        }
    }

    // ========================================================================
    // Settings entry — mimics skaztv.online/store.js shape
    // ========================================================================

    var STORE_ICON_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32" fill="none">' +
            '<path d="M3 7h18l-1.5 10.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5L3 7z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
            '<path d="M8 7V5a4 4 0 0 1 8 0v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '</svg>';

    function addStoreEntry() {
        try {
            if (!Lampa.Settings || !Lampa.Settings.main) return;
            var $main = Lampa.Settings.main().render();
            if ($main.find('[data-component="' + STORE_COMPONENT + '"]').length) return;

            var $anchor = $main.find('[data-component="more"]');
            var field =
                '<div class="settings-folder selector" data-component="' + STORE_COMPONENT + '" data-static="true">' +
                    '<div class="settings-folder__icon">' + STORE_ICON_SVG + '</div>' +
                    '<div class="settings-folder__name">' + Lampa.Lang.translate('vahagn_store_title') + '</div>' +
                '</div>';

            if ($anchor.length) $anchor.after(field);
            else $main.append(field);
            Lampa.Settings.main().update();
        } catch (e) {
            log('addStoreEntry failed', e && e.message);
        }
    }

    function openStore() {
        try {
            if (Lampa.Extensions && typeof Lampa.Extensions.show === 'function') {
                Lampa.Extensions.show({
                    store: CATALOG_URL,
                    with_installed: true
                });
            } else {
                if (Lampa.Noty && Lampa.Noty.show) {
                    Lampa.Noty.show(Lampa.Lang.translate('vahagn_store_no_api'));
                }
            }
        } catch (e) {
            log('openStore failed', e && e.message);
        }
    }

    // ========================================================================
    // Lang
    // ========================================================================

    function registerLang() {
        try {
            Lampa.Lang.add({
                vahagn_store_title:  { ru: 'Мои плагины',         en: 'My plugins' },
                vahagn_store_no_api: { ru: 'Ваша версия Lampa не поддерживает магазин расширений', en: 'This Lampa build does not support the extensions store' }
            });
        } catch (e) {}
    }

    // ========================================================================
    // Bind settings-open listener
    // ========================================================================

    function hookSettingsOpen() {
        try {
            Lampa.Settings.listener.follow('open', function (e) {
                if (e && e.name === 'main') {
                    try {
                        e.body.find('[data-component="' + STORE_COMPONENT + '"]')
                            .off('hover:enter click')
                            .on('hover:enter click', openStore);
                    } catch (ex) {}
                }
            });
        } catch (e) {}
    }

    // ========================================================================
    // Bootstrap
    // ========================================================================

    function init() {
        registerLang();
        addStoreEntry();
        hookSettingsOpen();
        ensureAutoInstalled();
    }

    function start() {
        if (window.Lampa && Lampa.Settings && Lampa.Settings.main && Lampa.Lang && Lampa.Noty) init();
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
