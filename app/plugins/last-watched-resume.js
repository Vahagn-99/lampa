/*!
 * Last Watched Resume — one-click resume row on the Lampa main screen.
 *
 * Records the source-restore context (online balanser OR TorrServer hash + file
 * path) for every eligible Player.start, deduped by card_id, capped at 5 MRU
 * slots per profile. Renders a row at the top of the main screen ("Последние
 * просмотры" / "Last watched") whose card metadata is hydrated on-demand from
 * Lampa.Favorite('history') — the plugin stores only ids, not full TMDB objects.
 *
 * Click on a row card bypasses the card screen and dispatches a source-aware
 * resume:
 *   - online  → Activity.push(component:'online') + DOM MutationObserver
 *               waits up to 3 s for the matching episode and synthesises
 *               'hover:enter' on it.
 *   - torrent → Lampa.Torrent.open(hash, card) + one-shot listener on
 *               Lampa.Listener('torrent_file', list_open) finds the file by
 *               saved path and synthesises 'hover:enter'.
 * On 3-second timeout the auto-click is abandoned cleanly — user is left on
 * the rendered list with manual selection available.
 *
 * Diagnostics: every state transition is a single console.log line prefixed
 * '[LastWatchedResume]', picked up by app/support/log-collector.js via its
 * prefix-based routing — no plugin-side networking.
 *
 * Storage namespace: last_watched_resume_*
 * Log prefix:        [LastWatchedResume]
 * Global guard:      window.__vahagnLastWatchedResumeLoaded
 */
(function () {
    'use strict';

    if (window.__vahagnLastWatchedResumeLoaded) return;
    window.__vahagnLastWatchedResumeLoaded = true;

    // ========================================================================
    // Constants
    // ========================================================================

    var LOG_PREFIX           = '[LastWatchedResume]';
    var NS                   = 'last_watched_resume_';
    var QUEUE_KEY            = NS + 'queue';
    var ENABLED_KEY          = NS + 'enabled';
    var CLEAR_KEY            = NS + 'clear';
    var ROW_NAME             = 'last_watched_resume';
    var MAX_QUEUE            = 5;
    var AUTOCLICK_TIMEOUT_MS = 3000;
    var MIN_APP_DIGITAL      = 300;

    var _initialized        = false;
    var _captureBound       = false;
    var _activeAutoclick    = null; // current OnlineAutoclick / TorrentAutoclick

    // ========================================================================
    // Logging helpers — single prefix, sub-event in first message word
    // ========================================================================

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG_PREFIX);
            console.log.apply(console, args);
        } catch (e) {}
    }
    function warn() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG_PREFIX);
            console.warn.apply(console, args);
        } catch (e) {}
    }
    function err() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG_PREFIX);
            console.error.apply(console, args);
        } catch (e) {}
    }

    // ========================================================================
    // Profile-scoped storage
    // ========================================================================

    var Store = {
        profileId: function () {
            try {
                if (window.Lampa && Lampa.Account && Lampa.Account.Permit && Lampa.Account.Permit.sync &&
                    Lampa.Account.Permit.account && Lampa.Account.Permit.account.profile) {
                    return Lampa.Account.Permit.account.profile.id;
                }
            } catch (e) {}
            return null;
        },
        scope: function (key) {
            var pid = Store.profileId();
            return pid ? (key + '_' + pid) : (key + '_local');
        },
        getQueue: function () {
            try {
                var raw = Lampa.Storage.get(Store.scope(QUEUE_KEY), '[]');
                if (raw && typeof raw === 'object' && raw.length === undefined) {
                    // Lampa returned an object (shouldn't happen for [] default but be safe)
                    return [];
                }
                if (typeof raw === 'string') {
                    try { raw = JSON.parse(raw); } catch (e) { raw = []; }
                }
                if (!raw || raw.length === undefined) return [];
                return raw;
            } catch (e) { return []; }
        },
        setQueue: function (arr) {
            try { Lampa.Storage.set(Store.scope(QUEUE_KEY), arr || []); }
            catch (e) { err('storage:write fail', e && e.message); }
        },
        clearQueue: function () {
            Store.setQueue([]);
        },
        upsert: function (entry) {
            var queue = Store.getQueue();
            var existingIdx = -1;
            var i;
            for (i = 0; i < queue.length; i++) {
                if (queue[i] && queue[i].card_id === entry.card_id) { existingIdx = i; break; }
            }
            var action = existingIdx >= 0 ? 'update' : 'insert';
            if (existingIdx >= 0) queue.splice(existingIdx, 1);
            queue.unshift(entry);
            var evicted = null;
            if (queue.length > MAX_QUEUE) {
                evicted = queue[queue.length - 1];
                queue = queue.slice(0, MAX_QUEUE);
            }
            Store.setQueue(queue);
            log('queue:write', 'action=' + action,
                'card_id=' + entry.card_id,
                'S' + (entry.season || '-') + 'E' + (entry.episode || '-'),
                'kind=' + entry.source.kind,
                'queue.length=' + queue.length);
            if (evicted) {
                log('queue:evict', 'card_id=' + evicted.card_id, 'reason=cap');
            }
        }
    };

    // ========================================================================
    // Recording pipeline
    // ========================================================================

    function eligibleReason(data) {
        if (!data) return 'no_data';
        if (data.iptv === true) return 'iptv';
        if (data.trailer === true) return 'trailer';
        if (!data.card) return 'no_card';
        if (!data.timeline) return 'no_timeline';
        return null;
    }

    function detectSource(data) {
        if (data.torrent_hash) {
            return {
                kind:         'torrent',
                torrent_hash: data.torrent_hash,
                file_path:    extractFilePath(data)
            };
        }
        var balanser = '';
        try { balanser = Lampa.Storage.get('online_balanser', '') || ''; } catch (e) {}
        if (balanser) {
            return { kind: 'online', balanser: balanser };
        }
        return { kind: 'other' };
    }

    function extractFilePath(data) {
        // Lampa's torrent.js Arrays.extend the file element with `path` (file
        // path within torrent) before Player.play(element). Fall back to URL
        // parsing for older builds where `path` may not have propagated.
        if (data.path && typeof data.path === 'string') return data.path;
        if (data.url && typeof data.url === 'string') {
            // Torserver stream URL pattern: ...?link=<hash>&index=<id>&path=<path>
            var m = data.url.match(/[?&]path=([^&]+)/);
            if (m) {
                try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
            }
        }
        return '';
    }

    function onPlayerStart(data, evt) {
        var reason = eligibleReason(data);
        if (reason) {
            log('player:start', 'evt=' + evt, 'skip', 'reason=' + reason);
            return;
        }
        var source = detectSource(data);
        var entry = {
            card_id:  data.card.id,
            season:   data.season   || (data.card && data.card.season)  || null,
            episode:  data.episode  || (data.card && data.card.episode) || null,
            source:   source,
            saved_at: Date.now()
        };
        log('player:start',
            'evt=' + evt,
            'card_id=' + entry.card_id,
            'S' + (entry.season || '-') + 'E' + (entry.episode || '-'),
            'kind=' + source.kind,
            (source.kind === 'online'  ? 'balanser=' + source.balanser :
             source.kind === 'torrent' ? 'hash=' + (source.torrent_hash || '').slice(0, 8) + ' path=' + (source.file_path || '<none>') :
             'other'));
        Store.upsert(entry);
    }

    // ========================================================================
    // Card hydration from Lampa.Favorite('history')
    // ========================================================================

    function historyMap() {
        var idx = {};
        try {
            if (!Lampa.Favorite || typeof Lampa.Favorite.get !== 'function') return idx;
            var hist = Lampa.Favorite.get('history') || [];
            var i;
            for (i = 0; i < hist.length; i++) {
                if (hist[i] && hist[i].id != null) idx[hist[i].id] = hist[i];
            }
        } catch (e) {}
        return idx;
    }

    function hydrateAndPrune(queue) {
        var hist = historyMap();
        var visible = [];
        var orphans = [];
        var kept    = [];
        var i;
        for (i = 0; i < queue.length; i++) {
            var entry = queue[i];
            if (!entry || entry.card_id == null) { orphans.push(entry && entry.card_id); continue; }
            var card = hist[entry.card_id];
            if (card) {
                visible.push({ entry: entry, card: card });
                kept.push(entry);
            } else {
                orphans.push(entry.card_id);
            }
        }
        if (orphans.length) {
            for (i = 0; i < orphans.length; i++) {
                log('queue:orphan', 'card_id=' + orphans[i], 'reason=not_in_history');
            }
            Store.setQueue(kept);
        }
        return visible;
    }

    // ========================================================================
    // Row registration (main screen)
    // ========================================================================

    function isEnabled() {
        try { return Lampa.Storage.field(ENABLED_KEY) !== false; } catch (e) { return true; }
    }

    function buildRowCard(entry, card) {
        // Shallow clone so our marker doesn't pollute Lampa.Favorite('history').
        var out = {};
        var k;
        for (k in card) {
            if (Object.prototype.hasOwnProperty.call(card, k)) out[k] = card[k];
        }
        out.__last_watched_resume = true;
        out.__lwr_entry = entry; // attached for click handler lookup
        return out;
    }

    function buildPlaceholderCard() {
        return {
            __last_watched_resume: true,
            __last_watched_resume_placeholder: true,
            id:    null,
            title: tr('lwr_empty_title'),
            name:  tr('lwr_empty_title'),
            release_date: '',
            first_air_date: '',
            poster_path: '',
            background_image: '',
            // Lampa expects vote_average for the rating badge; use 0 so it's hidden.
            vote_average: 0,
            // No img — Card class will fall back to its broken-image placeholder.
            img: ''
        };
    }

    function registerRow() {
        var ver = (Lampa.Manifest && typeof Lampa.Manifest.app_digital === 'number')
                  ? Lampa.Manifest.app_digital : 0;
        if (ver < MIN_APP_DIGITAL) {
            log('init', 'version_too_low', 'app_digital=' + ver, 'row=skipped');
            return;
        }
        if (!Lampa.ContentRows || typeof Lampa.ContentRows.add !== 'function') {
            log('init', 'content_rows_api_missing', 'row=skipped');
            return;
        }
        Lampa.ContentRows.add({
            name:   ROW_NAME,
            title:  tr('lwr_row_title'),
            index:  -1000,
            screen: ['main'],
            call:   function (/* params, screen */) {
                if (!isEnabled()) return; // undefined → row not rendered
                var queue   = Store.getQueue();
                var visible = hydrateAndPrune(queue);
                if (!visible.length) {
                    log('row:empty', 'placeholder=true');
                    var ph = buildPlaceholderCard();
                    return function (cb) {
                        cb({ title: tr('lwr_row_title'), results: [ph] });
                    };
                }
                log('row:render', 'count=' + visible.length);
                var results = [];
                var i;
                for (i = 0; i < visible.length; i++) {
                    results.push(buildRowCard(visible[i].entry, visible[i].card));
                }
                return function (cb) {
                    cb({ title: tr('lwr_row_title'), results: results });
                };
            }
        });
        log('init', 'row=registered', 'app_digital=' + ver);
    }

    // ========================================================================
    // Click interception — capture-phase on document.body
    // ========================================================================

    function findOurCardData(el) {
        var node = el;
        while (node && node !== document.body && node !== document) {
            if (node.card_data && node.card_data.__last_watched_resume === true) {
                return node.card_data;
            }
            node = node.parentNode;
        }
        return null;
    }

    function onCaptureEvent(e) {
        if (!isEnabled()) return;
        var data = findOurCardData(e.target);
        if (!data) return;
        try { e.stopImmediatePropagation(); } catch (ex) {}
        try { e.preventDefault(); } catch (ex) {}

        if (data.__last_watched_resume_placeholder) {
            log('click', 'placeholder=true');
            return;
        }

        var entry = data.__lwr_entry;
        if (!entry) {
            warn('click', 'intercepted=true', 'entry_missing=true', 'card_id=' + (data.id || '?'));
            return;
        }
        log('click', 'intercepted=true',
            'card_id=' + entry.card_id,
            'kind=' + entry.source.kind,
            'S' + (entry.season || '-') + 'E' + (entry.episode || '-'));
        dispatchResume(entry, data);
    }

    function bindCaptureHandlers() {
        if (_captureBound) return;
        document.body.addEventListener('hover:enter', onCaptureEvent, true);
        document.body.addEventListener('click',       onCaptureEvent, true);
        _captureBound = true;
    }

    // ========================================================================
    // Resume dispatch — pick path by source.kind
    // ========================================================================

    function dispatchResume(entry, card) {
        // Cancel any in-flight auto-click before starting a new one.
        if (_activeAutoclick && typeof _activeAutoclick.abort === 'function') {
            try { _activeAutoclick.abort('superseded'); } catch (e) {}
            _activeAutoclick = null;
        }
        if (entry.source.kind === 'online')        dispatchOnlineResume(entry, card);
        else if (entry.source.kind === 'torrent')  dispatchTorrentResume(entry, card);
        else                                       dispatchFallbackToFull(entry, card, 'unknown_kind');
    }

    function dispatchFallbackToFull(entry, card, reason) {
        log('resume:fallback', 'reason=' + reason, 'card_id=' + entry.card_id);
        try {
            var method = 'movie';
            if (card.name || card.number_of_seasons || card.first_air_date) method = 'tv';
            if (card.type === 'tv') method = 'tv';
            Lampa.Activity.push({
                url:       card.url || '',
                component: 'full',
                id:        card.id,
                method:    method,
                card:      card,
                source:    card.source || 'tmdb'
            });
        } catch (e) { err('fallback', 'Activity.push fail', e && e.message); }
    }

    // ========================================================================
    // Online resume — Activity.push to online + DOM MutationObserver
    // ========================================================================

    function dispatchOnlineResume(entry, card) {
        log('resume:dispatch', 'target=online',
            'balanser=' + (entry.source.balanser || '?'),
            'autoclick=true');
        try {
            Lampa.Activity.push({
                url:        '',
                title:      Lampa.Lang.translate('title_online'),
                component:  'online',
                search:     card.title,
                search_one: card.title,
                search_two: card.original_title || card.original_name || card.title,
                movie:      card,
                page:       1
            });
        } catch (e) {
            err('resume:online', 'Activity.push fail', e && e.message);
            return;
        }
        OnlineAutoclick.start(entry);
    }

    var OnlineAutoclick = {
        _observer: null,
        _timer:    null,
        _started:  0,

        start: function (entry) {
            OnlineAutoclick.abort('restart');
            OnlineAutoclick._started = Date.now();
            log('resume:online', 'waiting_dom=true', 'season=' + (entry.season || '-'),
                'episode=' + (entry.episode || '-'));

            var tryMatch = function () {
                var $matches = $('.online__item').filter(function () {
                    return OnlineAutoclick._matches(this, entry);
                });
                if ($matches.length) {
                    OnlineAutoclick._fire($matches.eq(0)[0], 'season_episode');
                    return true;
                }
                return false;
            };

            // Immediate try in case the list is already rendered (warm cache).
            if (tryMatch()) return;

            try {
                OnlineAutoclick._observer = new MutationObserver(function () {
                    tryMatch();
                });
                OnlineAutoclick._observer.observe(document.body, {
                    childList: true,
                    subtree:   true
                });
            } catch (e) {
                warn('resume:online', 'MutationObserver fail', e && e.message);
            }

            OnlineAutoclick._timer = setTimeout(function () {
                OnlineAutoclick.abort('timeout');
            }, AUTOCLICK_TIMEOUT_MS);
            _activeAutoclick = OnlineAutoclick;
        },

        _matches: function (itemEl, entry) {
            // Lampa renders online items via online_folder/online templates.
            // For series items, the title prefix is "S<season> / Серия <ep>".
            // Parse from the rendered text (more robust than data attributes,
            // which differ across community balanser plugins).
            var $it = $(itemEl);
            var title = ($it.find('.online__title').text() || $it.text() || '').trim();
            if (!title) return false;
            if (entry.season && entry.episode) {
                var sRe = new RegExp('(?:^|[^0-9])S\\s*' + entry.season + '(?:[^0-9]|$)', 'i');
                var eRe = new RegExp('(?:^|[^0-9])(?:E|Серия|Episode)\\s*' + entry.episode + '(?:[^0-9]|$)', 'i');
                return sRe.test(title) && eRe.test(title);
            }
            // Movie: any rendered item is a candidate; trigger first one.
            return true;
        },

        _fire: function (el, matchedBy) {
            var dt = Date.now() - OnlineAutoclick._started;
            log('autoclick:hit', 'kind=online', 'dt_ms=' + dt, 'matched=' + matchedBy);
            OnlineAutoclick.abort('hit');
            try {
                var ev = document.createEvent('Event');
                ev.initEvent('hover:enter', false, true);
                el.dispatchEvent(ev);
            } catch (e) {
                err('autoclick:fire', 'fail', e && e.message);
            }
        },

        abort: function (reason) {
            if (OnlineAutoclick._observer) {
                try { OnlineAutoclick._observer.disconnect(); } catch (e) {}
                OnlineAutoclick._observer = null;
            }
            if (OnlineAutoclick._timer) {
                clearTimeout(OnlineAutoclick._timer);
                OnlineAutoclick._timer = null;
            }
            if (reason !== 'hit' && reason !== 'restart' && reason !== 'superseded') {
                log('autoclick:miss', 'kind=online', 'reason=' + reason);
            }
            if (_activeAutoclick === OnlineAutoclick) _activeAutoclick = null;
        }
    };

    // ========================================================================
    // Torrent resume — Lampa.Torrent.open + listener on 'torrent_file'
    // ========================================================================

    function dispatchTorrentResume(entry, card) {
        if (!Lampa.Torrent || typeof Lampa.Torrent.open !== 'function') {
            err('resume:torrent', 'fail', 'reason=api_missing');
            dispatchFallbackToFull(entry, card, 'torrent_api_missing');
            return;
        }
        log('resume:dispatch', 'target=torrent',
            'hash=' + (entry.source.torrent_hash || '').slice(0, 8),
            'autoclick=true');
        TorrentAutoclick.start(entry);
        try {
            Lampa.Torrent.open(entry.source.torrent_hash, card);
        } catch (e) {
            err('resume:torrent', 'Torrent.open fail', e && e.message);
            TorrentAutoclick.abort('open_fail');
            dispatchFallbackToFull(entry, card, 'torrent_open_fail');
        }
    }

    var TorrentAutoclick = {
        _handler: null,
        _timer:   null,
        _started: 0,
        _entry:   null,

        start: function (entry) {
            TorrentAutoclick.abort('restart');
            TorrentAutoclick._started = Date.now();
            TorrentAutoclick._entry   = entry;
            log('resume:torrent', 'waiting_event=torrent_file',
                'path=' + (entry.source.file_path || '<none>'));

            TorrentAutoclick._handler = function (e) {
                if (!e || e.type !== 'list_open') return;
                var items = e.items || [];
                var i;
                var matchedIdx = -1;
                if (entry.source.file_path) {
                    for (i = 0; i < items.length; i++) {
                        if (items[i] && items[i].path === entry.source.file_path) { matchedIdx = i; break; }
                    }
                }
                // Fall back to season/episode match if path didn't hit
                // (release re-encoded, file renamed, but episode preserved).
                if (matchedIdx === -1 && entry.season && entry.episode) {
                    for (i = 0; i < items.length; i++) {
                        if (items[i] && (items[i].season == entry.season) && (items[i].episode == entry.episode)) {
                            matchedIdx = i;
                            break;
                        }
                    }
                }
                if (matchedIdx === -1) {
                    log('autoclick:miss', 'kind=torrent', 'reason=no_match',
                        'items=' + items.length);
                    TorrentAutoclick.abort('no_match');
                    return;
                }
                var matchedBy = (entry.source.file_path && items[matchedIdx].path === entry.source.file_path)
                                ? 'path' : 'season_episode';
                TorrentAutoclick._fire(items[matchedIdx], matchedBy);
            };

            try { Lampa.Listener.follow('torrent_file', TorrentAutoclick._handler); }
            catch (e) { err('resume:torrent', 'follow fail', e && e.message); }

            TorrentAutoclick._timer = setTimeout(function () {
                TorrentAutoclick.abort('timeout');
            }, AUTOCLICK_TIMEOUT_MS);
            _activeAutoclick = TorrentAutoclick;
        },

        _fire: function (item, matchedBy) {
            var dt = Date.now() - TorrentAutoclick._started;
            // Find the rendered DOM element for this file in the torrent file
            // picker. Files are rendered into `.torrent-files` (or similar);
            // walk the modal DOM looking for the element bound to this `item`.
            var el = TorrentAutoclick._findItemEl(item);
            if (!el) {
                log('autoclick:miss', 'kind=torrent', 'reason=dom_not_found');
                TorrentAutoclick.abort('dom_not_found');
                return;
            }
            log('autoclick:hit', 'kind=torrent', 'dt_ms=' + dt, 'matched=' + matchedBy);
            TorrentAutoclick.abort('hit');
            try {
                var ev = document.createEvent('Event');
                ev.initEvent('hover:enter', false, true);
                el.dispatchEvent(ev);
            } catch (e) {
                err('autoclick:fire', 'kind=torrent fail', e && e.message);
            }
        },

        _findItemEl: function (item) {
            // Lampa's torrent.js sets `path` on the bound element via Arrays.extend;
            // the rendered DOM is .torrent-files > .selector with an attached
            // jQuery-data link to the items array. Easiest stable lookup:
            // match by visible text containing item.path's basename or full path.
            var path = item && item.path ? item.path : '';
            if (!path) return null;
            var basename = path.split('/').pop();
            var $candidates = $('.torrent-item, .torrent-files .selector, .selector.torrent-item');
            var found = null;
            $candidates.each(function () {
                var t = ($(this).text() || '').trim();
                if (t && (t.indexOf(path) >= 0 || t.indexOf(basename) >= 0)) {
                    found = this;
                    return false; // break
                }
            });
            return found;
        },

        abort: function (reason) {
            if (TorrentAutoclick._handler) {
                try { Lampa.Listener.remove('torrent_file', TorrentAutoclick._handler); } catch (e) {}
                TorrentAutoclick._handler = null;
            }
            if (TorrentAutoclick._timer) {
                clearTimeout(TorrentAutoclick._timer);
                TorrentAutoclick._timer = null;
            }
            if (reason !== 'hit' && reason !== 'restart' && reason !== 'superseded' &&
                reason !== 'no_match' && reason !== 'dom_not_found') {
                log('autoclick:miss', 'kind=torrent', 'reason=' + reason);
            }
            TorrentAutoclick._entry = null;
            if (_activeAutoclick === TorrentAutoclick) _activeAutoclick = null;
        }
    };

    // ========================================================================
    // i18n
    // ========================================================================

    function tr(key) {
        try { return Lampa.Lang.translate(key); } catch (e) { return key; }
    }

    function registerLang() {
        try {
            Lampa.Lang.add({
                lwr_row_title: {
                    ru: 'Последние просмотры',
                    en: 'Last watched'
                },
                lwr_empty_title: {
                    ru: 'Тут будут последние просмотры',
                    en: 'Your recent watches will appear here'
                },
                lwr_settings_title: {
                    ru: 'Продолжить одним кликом',
                    en: 'Last Watched Resume'
                },
                lwr_enabled: {
                    ru: 'Включить',
                    en: 'Enable'
                },
                lwr_enabled_desc: {
                    ru: 'Показывать ряд "Последние просмотры" сверху главного экрана',
                    en: 'Show the "Last watched" row at the top of the main screen'
                },
                lwr_clear: {
                    ru: 'Сбросить запомненное',
                    en: 'Clear saved'
                },
                lwr_clear_desc: {
                    ru: 'Очистить очередь последних просмотров для текущего профиля',
                    en: 'Clear the recently-watched queue for the current profile'
                },
                lwr_cleared_noty: {
                    ru: 'Запомненное удалено',
                    en: 'Saved entries cleared'
                }
            });
        } catch (e) { err('i18n', 'register fail', e && e.message); }
    }

    // ========================================================================
    // Settings
    // ========================================================================

    function registerSettings() {
        try {
            Lampa.SettingsApi.addComponent({
                component: 'last_watched_resume',
                name:      tr('lwr_settings_title'),
                icon: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                        '<path d="M8 5V19L19 12L8 5Z" fill="currentColor"/>' +
                        '<path d="M3 7V17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
                      '</svg>'
            });
            Lampa.SettingsApi.addParam({
                component: 'last_watched_resume',
                param:     { name: ENABLED_KEY, type: 'trigger', default: true },
                field:     {
                    name:        tr('lwr_enabled'),
                    description: tr('lwr_enabled_desc')
                },
                onChange:  function (value) {
                    log('settings:enabled', 'value=' + value);
                }
            });
            Lampa.SettingsApi.addParam({
                component: 'last_watched_resume',
                param:     { name: CLEAR_KEY, type: 'button' },
                field:     {
                    name:        tr('lwr_clear'),
                    description: tr('lwr_clear_desc')
                },
                onChange:  function () {
                    Store.clearQueue();
                    try {
                        if (Lampa.Noty && Lampa.Noty.show) {
                            Lampa.Noty.show(tr('lwr_cleared_noty'));
                        }
                    } catch (e) {}
                    log('settings:cleared');
                }
            });
        } catch (e) { err('settings', 'register fail', e && e.message); }
    }

    // ========================================================================
    // Manifest
    // ========================================================================

    function registerManifest() {
        try {
            Lampa.Manifest.plugins = {
                type:        'video',
                version:     '0.1.0',
                name:        'Last Watched Resume',
                description: 'One-click resume — last 5 watched titles row on the main screen, online + torrent.'
            };
        } catch (e) {}
    }

    // ========================================================================
    // Init
    // ========================================================================

    function init() {
        if (_initialized) return;
        _initialized = true;

        registerLang();
        registerManifest();
        registerSettings();
        registerRow();

        // Subscribe to BOTH 'start' (inner Lampa player) and 'external'
        // (native Tizen AVPlay / WebOS / Android / iOS handoff). On Tizen,
        // torrent playback often routes via the native player and Lampa
        // emits 'external' instead of 'start' — without this, recording is
        // silently a no-op for half the user base.
        try { Lampa.Player.listener.follow('start',    function (d) { onPlayerStart(d, 'start'); }); }
        catch (e) { err('init', "Player.listener.follow('start') fail", e && e.message); }
        try { Lampa.Player.listener.follow('external', function (d) { onPlayerStart(d, 'external'); }); }
        catch (e) { err('init', "Player.listener.follow('external') fail", e && e.message); }

        bindCaptureHandlers();

        var ver = (Lampa.Manifest && Lampa.Manifest.app_digital) || 'n/a';
        var pid = Store.profileId();
        var qlen = Store.getQueue().length;
        log('init', 'profile=' + (pid || 'local'), 'ver=' + ver, 'queue.length=' + qlen);
    }

    // ========================================================================
    // Bootstrap — four-layer pattern (lampa-plugin-development skill)
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
        Lampa.Listener.follow('app', function (e) { if (e && e.type === 'ready') start(); });
        setTimeout(start, 1000);
    } else {
        var readyInterval = setInterval(function () {
            if (window.Lampa && Lampa.Listener) {
                clearInterval(readyInterval);
                Lampa.Listener.follow('app', function (e) { if (e && e.type === 'ready') start(); });
                setTimeout(start, 1000);
            }
        }, 300);
    }
})();
