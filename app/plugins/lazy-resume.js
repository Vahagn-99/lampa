/*!
 * Lazy Resume — One-Click Resume for Lampa
 *
 * Single-file browser plugin. ES5-only, no build step, no dependencies.
 * Records the last "real" playback (card + source + position via Lampa.Timeline)
 * and injects one card at the top of the main screen that resumes playback in
 * a single click, bypassing the card screen / source selection flow.
 *
 * Storage namespace: lazy_resume_*
 * Log prefix:        [LazyResume]
 * Global guard:      window.__lazyResumeLoaded
 */
(function(){
    'use strict';

    if (window.__lazyResumeLoaded) return;
    window.__lazyResumeLoaded = true;

    // ========================================================================
    // Constants
    // ========================================================================

    var PROMOTE_THRESHOLD   = 60;     // seconds of playback before a draft promotes
    var COMPLETION_THRESHOLD = 0.95;  // progress ratio considered "completed"
    var FALLBACK_WINDOW_MS  = 15000;  // window after Player.play during which errors trigger fallback
    var LOG_PREFIX          = '[LazyResume]';
    var NS                  = 'lazy_resume_';

    var _initialized = false;

    // ========================================================================
    // Logger
    // ========================================================================

    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(LOG_PREFIX);
        try { console.log.apply(console, args); } catch (e) {}
    }
    function warn() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(LOG_PREFIX);
        try { console.warn.apply(console, args); } catch (e) {}
    }
    function err() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(LOG_PREFIX);
        try { console.error.apply(console, args); } catch (e) {}
    }

    // ========================================================================
    // Store — profile-scoped session and draft storage
    // ========================================================================

    var Store = {
        profileId: function() {
            try {
                if (Lampa.Account && Lampa.Account.Permit && Lampa.Account.Permit.sync &&
                    Lampa.Account.Permit.account && Lampa.Account.Permit.account.profile) {
                    return Lampa.Account.Permit.account.profile.id;
                }
            } catch (e) {}
            return null;
        },
        scope: function(key) {
            var pid = this.profileId();
            return pid ? (key + '_' + pid) : key;
        },
        _get: function(key) {
            try {
                var v = Lampa.Storage.get(this.scope(key), '');
                if (!v || v === '') return null;
                if (typeof v === 'string') {
                    try { return JSON.parse(v); } catch (e) { return null; }
                }
                return v;
            } catch (e) { return null; }
        },
        _set: function(key, obj) {
            try { Lampa.Storage.set(this.scope(key), obj); } catch (e) { err('Storage.set failed', key, e); }
        },
        _del: function(key) {
            try { Lampa.Storage.set(this.scope(key), ''); } catch (e) {}
        },
        getSession: function() { return this._get(NS + 'session'); },
        setSession: function(obj) { this._set(NS + 'session', obj); },
        delSession: function() { this._del(NS + 'session'); },
        getDraft:   function() { return this._get(NS + 'session_draft'); },
        setDraft:   function(obj) { this._set(NS + 'session_draft', obj); },
        delDraft:   function() { this._del(NS + 'session_draft'); },
        clearAll:   function() { this.delSession(); this.delDraft(); }
    };

    // ========================================================================
    // Hash — mirror Lampa.Utils.hash for reading Timeline.view() keys
    // ========================================================================

    function hashStr(str) {
        if (Lampa.Utils && typeof Lampa.Utils.hash === 'function') return Lampa.Utils.hash(str);
        var s = (str || '') + '';
        var h = 0;
        if (s.length === 0) return h + '';
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            h = ((h << 5) - h) + c;
            h = h & h;
        }
        return Math.abs(h) + '';
    }

    function cardHash(card, season, episode) {
        card = card || {};
        if (season && episode) {
            var sep = season > 10 ? ':' : '';
            var name = card.original_name || card.original_title || '';
            return hashStr(season + sep + episode + name);
        }
        return hashStr(card.original_title || '');
    }

    // ========================================================================
    // Session recorder
    // ========================================================================

    var _hasDraft     = false;  // current playback produced a draft not yet promoted
    var _promoted     = false;  // draft was promoted in this playback
    var _advancedKey  = null;   // guard against double-advance in one playback

    function ineligibleReason(data) {
        if (!data) return 'no_data';
        if (data.iptv) return 'iptv';
        if (data.trailer) return 'trailer';
        if (!data.timeline) return 'no_timeline';
        if (!data.card) return 'no_card';
        return null;
    }

    function detectSource(data) {
        if (data.torrent_hash) {
            return { kind: 'torrent', balanser: null, torrent_hash: data.torrent_hash };
        }
        var balanser = null;
        try { balanser = Lampa.Storage.get('online_balanser', '') || null; } catch (e) {}
        if (balanser) return { kind: 'online', balanser: balanser, torrent_hash: null };
        return { kind: 'other', balanser: null, torrent_hash: null };
    }

    function buildSession(data) {
        var season  = data.season  || (data.card && data.card.season)  || null;
        var episode = data.episode || (data.card && data.card.episode) || null;
        var src     = detectSource(data);

        return {
            type: (season && episode) ? 'episode' : 'movie',
            card: data.card,
            season: season,
            episode: episode,
            source: {
                url:          data.url,
                kind:         src.kind,
                balanser:     src.balanser,
                torrent_hash: src.torrent_hash,
                quality:      data.quality    || null,
                voiceovers:   data.voiceovers || null,
                subtitles:    data.subtitles  || null,
                playlist:     data.playlist   || null,
                title:        data.title      || null
            },
            saved_at: Date.now()
        };
    }

    function onPlayerStart(data) {
        if (!isEnabled()) { resetPlaybackState(); return; }

        var reason = ineligibleReason(data);
        if (reason) {
            log('start skipped:', reason);
            resetPlaybackState();
            return;
        }

        var session = buildSession(data);
        Store.setDraft(session);
        _hasDraft    = true;
        _promoted    = false;
        _advancedKey = null;
        log('draft written', session.type, (session.card && session.card.id), session.season || '', session.episode || '');
    }

    function resetPlaybackState() {
        _hasDraft    = false;
        _promoted    = false;
        _advancedKey = null;
    }

    function onTimeUpdate(e) {
        if (!isEnabled())                return;
        if (!e || typeof e.current !== 'number') return;

        // Promotion
        if (_hasDraft && !_promoted && e.current >= PROMOTE_THRESHOLD) {
            var draft = Store.getDraft();
            if (draft) {
                Store.setSession(draft);
                Store.delDraft();
                _promoted = true;
                log('promoted', draft.type, (draft.card && draft.card.id));
            } else {
                _hasDraft = false;
            }
        }

        // Completion-driven advance / clear
        if (_promoted && e.duration > 0) {
            var progress = e.current / e.duration;
            if (progress >= COMPLETION_THRESHOLD) {
                var session = Store.getSession();
                if (!session || !session.card) return;
                var currentKey = (session.card.id) + ':' + (session.season || '') + ':' + (session.episode || '');
                if (_advancedKey === currentKey) return;
                _advancedKey = currentKey;
                handleCompletion(session);
            }
        }
    }

    function handleCompletion(session) {
        if (session.type === 'movie') {
            Store.delSession();
            log('movie completed, session cleared');
            return;
        }

        var playlist = session.source && session.source.playlist;
        if (!playlist || !playlist.length) {
            Store.delSession();
            log('episode completed, no playlist, session cleared');
            return;
        }

        var idx = -1;
        for (var i = 0; i < playlist.length; i++) {
            var it = playlist[i];
            if (!it) continue;
            if ((it.url && it.url === session.source.url) ||
                ((it.season || it.s) == session.season && (it.episode || it.e) == session.episode)) {
                idx = i;
                break;
            }
        }

        var next = idx >= 0 ? playlist[idx + 1] : null;
        if (!next) {
            Store.delSession();
            log('episode completed, end of playlist, session cleared');
            return;
        }

        session.source.url   = next.url   || session.source.url;
        session.source.title = next.title || session.source.title;
        session.season       = next.season  || next.s || session.season;
        session.episode      = next.episode || next.e || (session.episode ? session.episode + 1 : session.episode);
        session.saved_at     = Date.now();
        Store.setSession(session);
        log('advanced to next episode', session.season + 'x' + session.episode);
    }

    function onPlayerDestroy() {
        if (_hasDraft && !_promoted) {
            Store.delDraft();
            log('destroyed before promotion, draft dropped');
        }
        resetPlaybackState();
    }

    // ========================================================================
    // Click interception (capture phase on document.body)
    //
    // Lampa fires 'hover:enter' via Utils.trigger -> native dispatchEvent with
    // cancelable:true. A capture-phase listener on body sees the event before
    // the target-phase listener that opens the card screen, so we can
    // stopImmediatePropagation and hijack the click to our resume flow.
    // ========================================================================

    function isOurCardEl(el) {
        while (el && el !== document.body) {
            if (el.card_data && el.card_data.__lazy_resume_hack) return el.card_data;
            el = el.parentNode;
        }
        return null;
    }

    function onGlobalHoverEnter(e) {
        if (!isEnabled()) return;
        var data = isOurCardEl(e.target);
        if (!data) return;
        try { e.stopImmediatePropagation(); e.preventDefault(); } catch (ex) {}
        resumeFromSession();
    }

    function onGlobalClick(e) {
        if (!isEnabled()) return;
        var data = isOurCardEl(e.target);
        if (!data) return;
        try { e.stopImmediatePropagation(); e.preventDefault(); } catch (ex) {}
        resumeFromSession();
    }

    // ========================================================================
    // Resume flow
    // ========================================================================

    var _errorHandler = null;
    var _errorTimer   = null;

    function resumeFromSession() {
        var session = Store.getSession();
        if (!session || !session.card) {
            warn('resume requested but no session');
            return;
        }

        var card = session.card;
        var hash = cardHash(card, session.season, session.episode);
        var timeline = null;
        try {
            if (Lampa.Timeline && typeof Lampa.Timeline.view === 'function') {
                timeline = Lampa.Timeline.view(hash);
            }
        } catch (e) {}

        var playData = {
            url:        session.source.url,
            title:      session.source.title || card.title || card.name || '',
            card:       card,
            timeline:   timeline || undefined,
            quality:    session.source.quality    || undefined,
            subtitles:  session.source.subtitles  || undefined,
            voiceovers: session.source.voiceovers || undefined,
            playlist:   session.source.playlist   || undefined
        };
        if (session.source.torrent_hash) playData.torrent_hash = session.source.torrent_hash;

        log('resume', card.id, session.season || '-', session.episode || '-', 'kind=' + session.source.kind);

        armFallback(card);

        try {
            Lampa.Player.play(playData);
            if (session.source.playlist && Lampa.Player.playlist) {
                try { Lampa.Player.playlist(session.source.playlist); } catch (pl) {}
            }
        } catch (ex) {
            err('Player.play threw', ex && ex.message);
            disarmFallback();
            runFallback(card);
        }
    }

    function armFallback(card) {
        disarmFallback();
        if (!Lampa.PlayerVideo || !Lampa.PlayerVideo.listener) return;

        _errorHandler = function(evt) {
            err('player error during fallback window', evt && evt.error);
            disarmFallback();
            runFallback(card);
        };
        try { Lampa.PlayerVideo.listener.follow('error', _errorHandler); } catch (e) {}
        _errorTimer = setTimeout(disarmFallback, FALLBACK_WINDOW_MS);
    }

    function disarmFallback() {
        if (_errorHandler && Lampa.PlayerVideo && Lampa.PlayerVideo.listener &&
            typeof Lampa.PlayerVideo.listener.remove === 'function') {
            try { Lampa.PlayerVideo.listener.remove('error', _errorHandler); } catch (e) {}
        }
        _errorHandler = null;
        if (_errorTimer) {
            clearTimeout(_errorTimer);
            _errorTimer = null;
        }
    }

    function runFallback(card) {
        log('fallback triggered for card', card && card.id);
        try { if (Lampa.Player && Lampa.Player.close) Lampa.Player.close(); } catch (e) {}
        try {
            if (Lampa.Noty && Lampa.Noty.show) {
                Lampa.Noty.show(Lampa.Lang.translate('lazy_resume_expired'));
            }
        } catch (e) {}
        if (!card || !card.id) return;

        var method = 'movie';
        if (card.name || card.number_of_seasons || card.first_air_date) method = 'tv';
        if (card.type === 'tv') method = 'tv';

        try {
            Lampa.Activity.push({
                url:       card.url || '',
                component: 'full',
                id:        card.id,
                method:    method,
                card:      card,
                source:    card.source || 'tmdb'
            });
        } catch (e) { err('fallback Activity.push failed', e && e.message); }
    }

    // ========================================================================
    // Row provider (main screen)
    // ========================================================================

    function buildRowCardData(session) {
        var src = session.card || {};
        var out = {};
        for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k]; }
        out.__lazy_resume_hack = true;
        return out;
    }

    function registerRow() {
        if (!Lampa.ContentRows || typeof Lampa.ContentRows.add !== 'function') {
            warn('ContentRows unavailable, row not registered');
            return;
        }
        var ver = (Lampa.Manifest && typeof Lampa.Manifest.app_digital === 'number') ? Lampa.Manifest.app_digital : 0;
        if (ver < 300) {
            warn('app_digital=' + ver + ' < 300, row not registered (recording continues)');
            return;
        }

        Lampa.ContentRows.add({
            name:   'lazy_resume',
            title:  Lampa.Lang.translate('lazy_resume_row_title'),
            index:  -1000,
            screen: ['main'],
            call:   function(/* params, screen */) {
                if (!isEnabled()) return;
                var session = Store.getSession();
                if (!session || !session.card) return;

                return function(cb) {
                    var cardData = buildRowCardData(session);
                    cb({
                        title:   Lampa.Lang.translate('lazy_resume_row_title'),
                        results: [cardData]
                    });
                };
            }
        });
        log('row registered (app_digital=' + ver + ')');
    }

    // ========================================================================
    // Settings
    // ========================================================================

    function isEnabled() {
        try { return Lampa.Storage.field('lazy_resume_enabled') !== false; } catch (e) { return true; }
    }

    function registerSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'lazy_resume',
            name:      Lampa.Lang.translate('lazy_resume_title'),
            icon: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                    '<path d="M8 5V19L19 12L8 5Z" fill="currentColor"/>' +
                    '<path d="M3 7V17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
                  '</svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'lazy_resume',
            param: { name: 'lazy_resume_enabled', type: 'trigger', default: true },
            field: {
                name:        Lampa.Lang.translate('lazy_resume_toggle'),
                description: Lampa.Lang.translate('lazy_resume_toggle_desc')
            },
            onChange: function(value) {
                log('enabled changed ->', value);
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'lazy_resume',
            param: { name: 'lazy_resume_clear', type: 'button' },
            field: {
                name:        Lampa.Lang.translate('lazy_resume_clear'),
                description: Lampa.Lang.translate('lazy_resume_clear_desc')
            },
            onChange: function() {
                Store.clearAll();
                try {
                    if (Lampa.Noty && Lampa.Noty.show) {
                        Lampa.Noty.show(Lampa.Lang.translate('lazy_resume_cleared'));
                    }
                } catch (e) {}
                log('session cleared by user');
            }
        });
    }

    // ========================================================================
    // i18n
    // ========================================================================

    function registerLang() {
        Lampa.Lang.add({
            lazy_resume_title: {
                ru: 'Продолжить одним кликом',
                en: 'One-Click Resume'
            },
            lazy_resume_row_title: {
                ru: 'Продолжить одним кликом',
                en: 'One-Click Resume'
            },
            lazy_resume_toggle: {
                ru: 'Включить плагин',
                en: 'Enable plugin'
            },
            lazy_resume_toggle_desc: {
                ru: 'Показывать карточку последнего просмотра сверху главного экрана',
                en: 'Show last-watched card at the top of the main screen'
            },
            lazy_resume_clear: {
                ru: 'Сбросить запомненное',
                en: 'Clear saved'
            },
            lazy_resume_clear_desc: {
                ru: 'Удалить запись о последнем просмотре для текущего профиля',
                en: 'Remove last-watched record for the current profile'
            },
            lazy_resume_expired: {
                ru: 'Источник устарел, откройте заново',
                en: 'Source expired, please reopen'
            },
            lazy_resume_cleared: {
                ru: 'Запомненное удалено',
                en: 'Saved entry cleared'
            }
        });
    }

    // ========================================================================
    // Init
    // ========================================================================

    function registerManifest() {
        try {
            Lampa.Manifest.plugins = {
                type:        'video',
                version:     '0.1.0',
                name:        'One-Click Resume',
                description: 'Remembers the last watched movie/series together with its source and resumes playback in one click from the main screen.'
            };
        } catch (e) {}
    }

    function init() {
        if (_initialized) return;
        _initialized = true;

        registerLang();
        registerManifest();
        registerSettings();
        registerRow();

        if (Lampa.Player && Lampa.Player.listener) {
            Lampa.Player.listener.follow('start',   onPlayerStart);
            Lampa.Player.listener.follow('destroy', onPlayerDestroy);
        }
        if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener) {
            Lampa.PlayerVideo.listener.follow('timeupdate', onTimeUpdate);
        }

        document.body.addEventListener('hover:enter', onGlobalHoverEnter, true);
        document.body.addEventListener('click',       onGlobalClick,      true);

        log('initialized (profile=' + (Store.profileId() || 'none') + ', version=0.1.0)');
    }

    // ========================================================================
    // Bootstrap — four-layer pattern from lampa-plugin-development skill
    // ========================================================================

    function start() {
        if (window.Lampa && Lampa.SettingsApi && Lampa.Storage && Lampa.Player &&
            Lampa.PlayerVideo && Lampa.Listener && Lampa.Lang && Lampa.Utils) {
            init();
        } else {
            setTimeout(start, 500);
        }
    }

    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function(e) { if (e && e.type === 'ready') start(); });
        setTimeout(start, 1000);
    } else {
        var readyInterval = setInterval(function() {
            if (window.Lampa && Lampa.Listener) {
                clearInterval(readyInterval);
                Lampa.Listener.follow('app', function(e) { if (e && e.type === 'ready') start(); });
                setTimeout(start, 1000);
            }
        }, 300);
    }
})();
