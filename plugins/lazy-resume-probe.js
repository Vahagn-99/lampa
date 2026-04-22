/*!
 * Lazy Resume — Diagnostic Probe
 *
 * Standalone debug plugin. Install ALONGSIDE lazy-resume.js in
 * Настройки → Расширения → Добавить плагин. Fires Lampa.Noty toasts
 * on app:ready + player events so you can see on TV (no DevTools needed)
 * which of the 5 possible failure modes is actually happening.
 *
 * Remove after diagnosis.
 *
 * Log prefix:   [LR-PROBE]
 * Global guard: window.__lazyResumeProbeLoaded
 */
(function () {
    'use strict';

    if (window.__lazyResumeProbeLoaded) return;
    window.__lazyResumeProbeLoaded = true;

    var TAG       = '[LR-PROBE]';
    var TOAST_MS  = 12000;    // 12s — long enough to read on TV
    var GAP_MS    = 2500;     // stagger between the three probes

    // ---------- tiny helpers ------------------------------------------------

    function toast(msg) {
        try {
            if (window.Lampa && Lampa.Noty && Lampa.Noty.show) {
                Lampa.Noty.show(msg, { time: TOAST_MS });
            }
        } catch (e) {}
        try { console.log(TAG, msg); } catch (e) {}
    }

    function profileId() {
        try {
            if (Lampa.Account && Lampa.Account.Permit && Lampa.Account.Permit.sync &&
                Lampa.Account.Permit.account && Lampa.Account.Permit.account.profile) {
                return Lampa.Account.Permit.account.profile.id;
            }
        } catch (e) {}
        return null;
    }

    function scopedKey(key) {
        var pid = profileId();
        return pid ? (key + '_' + pid) : key;
    }

    function hasStored(key) {
        try {
            var v = Lampa.Storage.get(scopedKey(key), '');
            return !!v && v !== '' && v !== 'null' && v !== '{}';
        } catch (e) { return false; }
    }

    function rowInContentRows() {
        // Try several internal shapes — content_rows.js has a private array.
        // If none match, we return 'unknown' and rely on other signals.
        try {
            if (!Lampa.ContentRows) return 'NO_API';
            var candidates = [Lampa.ContentRows.list, Lampa.ContentRows.rows, Lampa.ContentRows._rows];
            for (var c = 0; c < candidates.length; c++) {
                var arr = candidates[c];
                if (arr && typeof arr.length === 'number') {
                    for (var i = 0; i < arr.length; i++) {
                        if (arr[i] && arr[i].name === 'lazy_resume') return 'yes';
                    }
                    return 'no(' + arr.length + ' rows total)';
                }
            }
            return 'unknown';
        } catch (e) { return 'err'; }
    }

    // ---------- probes ------------------------------------------------------

    function probeEnvironment() {
        var ver    = (Lampa.Manifest && typeof Lampa.Manifest.app_digital === 'number')
                        ? Lampa.Manifest.app_digital : 'n/a';
        var cr     = !!(Lampa.ContentRows && typeof Lampa.ContentRows.add === 'function');
        var tog    = Lampa.Storage.field('lazy_resume_enabled') !== false;
        toast(TAG + ' A  ver=' + ver + ' CR=' + (cr ? 'yes' : 'NO') +
              ' plug_on=' + (tog ? 'yes' : 'NO'));
    }

    function probeStorage() {
        var rowTog = Lampa.Storage.field('content_rows_lazy_resume') !== false;
        var ses    = hasStored('lazy_resume_session') ? 'yes' : 'NO';
        var drf    = hasStored('lazy_resume_session_draft') ? 'yes' : 'no';
        toast(TAG + ' B  row_on=' + (rowTog ? 'yes' : 'NO') +
              ' session=' + ses + ' draft=' + drf);
    }

    function probeRegistration() {
        var reg  = rowInContentRows();
        var prof = profileId() ? ('sync:' + String(profileId()).slice(0, 6)) : 'local';
        toast(TAG + ' C  row_reg=' + reg + ' profile=' + prof);
    }

    // ---------- player-event probes (live-recording diagnostics) ------------

    function onPlayerStart(data) {
        var reason = 'OK';
        if      (!data)           reason = 'no_data';
        else if (data.iptv)       reason = 'iptv';
        else if (data.trailer)    reason = 'trailer';
        else if (!data.timeline)  reason = 'no_timeline';
        else if (!data.card)      reason = 'no_card';

        var src = 'other';
        if (data && data.torrent_hash) src = 'torrent';
        else if (data) {
            var bal = null;
            try { bal = Lampa.Storage.get('online_balanser', '') || null; } catch (e) {}
            if (bal) src = 'online:' + bal;
        }

        toast(TAG + ' player:start cardId=' + (data && data.card && data.card.id) +
              ' eligible=' + reason + ' src=' + src);
    }

    var _seen60s = false;
    function onTimeUpdate(e) {
        if (!_seen60s && e && typeof e.current === 'number' && e.current >= 60) {
            _seen60s = true;
            var drf = hasStored('lazy_resume_session_draft');
            var ses = hasStored('lazy_resume_session');
            toast(TAG + ' 60s crossed — draft=' + (drf ? 'yes' : 'NO') +
                  ' session=' + (ses ? 'yes' : 'no — should flip to yes shortly'));
        }
    }

    function onPlayerDestroy() {
        _seen60s = false;
        var drf = hasStored('lazy_resume_session_draft');
        var ses = hasStored('lazy_resume_session');
        toast(TAG + ' player:destroy  draft=' + (drf ? 'yes' : 'no') +
              ' session=' + (ses ? 'yes' : 'no'));
    }

    // ---------- bootstrap ---------------------------------------------------

    var _ran = false;

    function runAll() {
        if (_ran) return;
        if (!window.Lampa || !Lampa.Noty || !Lampa.Storage) { setTimeout(runAll, 500); return; }
        _ran = true;

        probeEnvironment();
        setTimeout(probeStorage,      GAP_MS);
        setTimeout(probeRegistration, GAP_MS * 2);

        if (Lampa.Player && Lampa.Player.listener) {
            Lampa.Player.listener.follow('start',   onPlayerStart);
            Lampa.Player.listener.follow('destroy', onPlayerDestroy);
        }
        if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener) {
            Lampa.PlayerVideo.listener.follow('timeupdate', onTimeUpdate);
        }

        // Re-run env/storage probe on every main-screen entry so hot-install
        // users can see when (if ever) their row starts appearing in the list.
        try {
            Lampa.Listener.follow('activity', function (e) {
                if (e && e.type === 'archive') return;
                if (e && e.component === 'main' && e.type === 'start') {
                    setTimeout(probeRegistration, 400);
                }
            });
        } catch (e) {}
    }

    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (e) { if (e && e.type === 'ready') runAll(); });
        setTimeout(runAll, 1500);      // hot-install safety — app:ready already fired
    } else {
        var ri = setInterval(function () {
            if (window.Lampa && Lampa.Listener) {
                clearInterval(ri);
                Lampa.Listener.follow('app', function (e) { if (e && e.type === 'ready') runAll(); });
                setTimeout(runAll, 1500);
            }
        }, 300);
    }
})();
