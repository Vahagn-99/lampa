/*!
 * Comments Feed — лента комментариев поверх плеера, в стиле YouTube
 *
 * Во время просмотра по «вниз» (после обложки/панели) выезжает скроллируемая
 * лента комментариев к текущему тайтлу. Источники подключаются через паттерн
 * стратегии: v1 — Rezka, дальше Кинопоиск/Киного без правки UI. Запрос к
 * источнику по умолчанию идёт напрямую (как в референсном плагине, внутри
 * приложения LAMPA это проходит); поле «прокси» в настройках — опциональная
 * подмена для платформ, где нужен обход CORS.
 */
(function () {
    'use strict';

    if (window.__vahagnCommentsFeedLoaded) return;
    window.__vahagnCommentsFeedLoaded = true;

    var LOG = '[CommentsFeed]';

    var KEY = {
        enabled: 'comments_feed_enabled',
        source:  'comments_feed_source',
        proxy:   'comments_feed_proxy'
    };

    // Пусто = прямой запрос. Можно вписать свой прокси-префикс (с / на конце).
    var DEFAULTS = { proxy: '' };

    // Временная видимая отладка через тосты (когда логи не доходят). TODO: убрать.
    var DEBUG = true;

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG);
            console.log.apply(console, args);
        } catch (e) {}
    }

    function dbg() {
        if (!DEBUG) return;
        try {
            var a = Array.prototype.slice.call(arguments);
            Lampa.Noty.show('CF: ' + a.join(' '));
        } catch (e) {}
    }

    function isEnabled() {
        return Lampa.Storage.field(KEY.enabled) !== false;
    }

    // ----------------------------------------------------------------- Transport
    var Transport = (function () {
        var pending = [];

        function isAndroid() {
            try { return !!(Lampa.Platform && Lampa.Platform.is && Lampa.Platform.is('android')); }
            catch (e) { return false; }
        }

        function base() {
            var p = Lampa.Storage.get(KEY.proxy, DEFAULTS.proxy) || '';
            if (p && p.charAt(p.length - 1) !== '/') p += '/';
            return p;
        }

        function get(targetUrl, onOk, onErr, opts) {
            opts = opts || {};
            var net = new Lampa.Reguest();
            pending.push(net);
            net.timeout(15000);

            var ok  = function (data) { remove(net); onOk(data); };
            var err = function (xhr, status) { remove(net); if (onErr) onErr(status || (xhr && xhr.status) || 0); };
            var cfg = { dataType: opts.dataType || 'text', headers: opts.headers || {} };

            var finalUrl = base() + targetUrl; // base() пусто => прямой запрос

            if (isAndroid()) net.native(finalUrl, ok, err, false, cfg);
            else net.silent(finalUrl, ok, err, false, cfg);

            return net;
        }

        function remove(net) {
            var i = pending.indexOf(net);
            if (i !== -1) pending.splice(i, 1);
        }

        function abortAll() {
            for (var i = 0; i < pending.length; i++) { try { pending[i].clear(); } catch (e) {} }
            pending = [];
        }

        return { isAndroid: isAndroid, base: base, get: get, abortAll: abortAll };
    })();

    // ------------------------------------------------------- Comment + registry
    function mkComment(author, avatar, date, text, likes, replies) {
        return {
            author: author || 'Аноним',
            avatar: avatar || '',
            date:   date || '',
            text:   text || '',
            likes:  Math.max(0, parseInt(likes, 10) || 0),
            replies: replies || []
        };
    }

    var CommentSources = (function () {
        var map = {};
        var order = [];

        function register(strategy) {
            if (!strategy || !strategy.id) return;
            if (!map[strategy.id]) order.push(strategy.id);
            map[strategy.id] = strategy;
            log('source registered:', strategy.id);
        }

        function active() {
            var id = Lampa.Storage.get(KEY.source, 'rezka') || 'rezka';
            return map[id] || map.rezka || null;
        }

        function list() {
            var out = [];
            for (var i = 0; i < order.length; i++) out.push({ id: order[i], title: map[order[i]].title });
            return out;
        }

        return { register: register, active: active, list: list };
    })();

    // ------------------------------------------------------------- RezkaSource
    var RezkaSource = {
        id: 'rezka',
        title: 'Rezka',

        _year: function (card) {
            if (card.release_year) return String(card.release_year);
            var d = card.release_date || card.first_air_date || '';
            return d ? d.slice(0, 4) : '';
        },

        _query: function (card) {
            return card.original_title || card.original_name || card.title || card.name || '';
        },

        find: function (card, cb) {
            var name = this._query(card);
            if (!name) { cb(null); return; }
            var year = this._year(card);
            var q = encodeURIComponent(name) + (year ? '+' + year : '');
            var url = 'https://hdrezka.ag/search/?do=search&subaction=search&q=' + q;
            dbg('search', name, year);

            Transport.get(url, function (html) {
                var newsId = null;
                var items = 0;
                try {
                    var $items = $('<div></div>').append($.parseHTML(html || '')).find('.b-content__inline_item');
                    items = $items.length;
                    if ($items.length) {
                        var raw = $items.first().attr('data-id');
                        if (raw) newsId = String(raw).replace(/[^0-9]/g, '') || null;
                    }
                } catch (e) { log('find parse error', e); }
                log('find', name, year, '->', newsId);
                dbg('find resp len=' + (html || '').length, 'items=' + items, '-> id=' + (newsId || 'NULL'));
                cb(newsId);
            }, function (status) {
                log('find request failed', status);
                dbg('find FAIL http=' + status);
                cb(null);
            }, { dataType: 'text' });
        },

        _parseOne: function ($self) {
            var avatar = $self.find('.ava img').first().attr('data-src') ||
                         $self.find('.ava img').first().attr('src') || '';
            var author = $.trim($self.find('.name, .b-comment__user').first().text());
            var date   = $.trim($self.find('.date, .b-comment__time').first().text());
            var $text  = $self.find('.message .text, .text').first();
            var text   = $.trim($text.clone().children('.comments-tree-list').remove().end().text());
            var likes  = parseInt($.trim($self.find('.b-rgida__count, .comment-rating, .rating').first().text()), 10) || 0;
            return { avatar: avatar, author: author, date: date, text: text, likes: likes };
        },

        _parse: function (html) {
            var list = [];
            var $root = $('<div></div>').append($.parseHTML(html || ''));
            var $tops = $root.find('.comments-tree-list').first().children('.comment');
            if (!$tops.length) $tops = $root.find('.comment');

            $tops.each(function () {
                var $c = $(this);
                // .b-comment / .comments-tree-item is the node's own block (excludes nested replies)
                var $self = $c.children('.comments-tree-item, .b-comment').first();
                if (!$self.length) $self = $c;

                var b = RezkaSource._parseOne($self);
                var replies = [];
                var $replyList = $c.find('.comments-tree-list').first();
                if ($replyList.length) {
                    $replyList.children('.comment').each(function () {
                        var $r = $(this);
                        var $rs = $r.children('.comments-tree-item, .b-comment').first();
                        if (!$rs.length) $rs = $r;
                        var rr = RezkaSource._parseOne($rs);
                        if (rr.author || rr.text) replies.push(mkComment(rr.author, rr.avatar, rr.date, rr.text, rr.likes, []));
                    });
                }
                if (b.author || b.text) list.push(mkComment(b.author, b.avatar, b.date, b.text, b.likes, replies));
            });
            return list;
        },

        comments: function (ref, page, cb) {
            var url = 'https://rezka.ag/ajax/get_comments/?news_id=' + encodeURIComponent(ref) +
                      '&cstart=' + (page || 1) + '&type=0&comment_id=0&skin=hdrezka';
            Transport.get(url, function (raw) {
                var html = '';
                var jsonOk = false;
                try {
                    var json = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    html = (json && json.comments) || '';
                    jsonOk = true;
                } catch (e) { log('comments json error', e); }
                var list = RezkaSource._parse(html);
                log('comments page', page, '->', list.length);
                dbg('comments raw=' + (raw ? String(raw).length : 0),
                    'json=' + (jsonOk ? 'ok' : 'FAIL'),
                    'html=' + html.length, 'parsed=' + list.length);
                cb({ list: list, hasMore: list.length > 0 });
            }, function (status) {
                log('comments request failed', status);
                dbg('comments FAIL http=' + status);
                cb({ list: [], hasMore: false });
            }, { dataType: 'text' });
        }
    };

    CommentSources.register(RezkaSource);

    // ------------------------------------------------------------- MockSource
    // Демо-источник для проверки UI без сети. TODO: убрать перед релизом.
    var MockSource = {
        id: 'mock',
        title: 'Демо (тест)',
        find: function (card, cb) { cb('demo'); },
        comments: function (ref, page, cb) {
            if (page > 1) { cb({ list: [], hasMore: false }); return; }
            cb({
                hasMore: false,
                list: [
                    mkComment('Алексей', '', '2 часа назад',
                        'Визуально это шедевр — на большом экране оторваться невозможно. Звук в зале пробирал до мурашек.', 124, [
                        mkComment('Марина', '', '1 час назад', 'Полностью согласна, пересматривала уже дважды!', 18, [])
                    ]),
                    mkComment('Игорь', '', 'вчера',
                        'Саундтрек Ханса Циммера — отдельный вид искусства. Качал отдельно, слушаю в дороге.', 87, []),
                    mkComment('Ольга', '', '3 дня назад',
                        'Сюжет местами провисает, но картинка и атмосфера всё вытягивают. Рекомендую.', 41, []),
                    mkComment('Дмитрий', '', '5 дней назад',
                        'Кто ещё досидел до сцены после титров? Без спойлеров — оно того стоит.', 56, [
                        mkComment('Сергей', '', '4 дня назад', 'Досидел, в шоке до сих пор 😮', 9, [])
                    ]),
                    mkComment('Анна', '', 'неделю назад',
                        'Лучшее, что выходило за последний год. Жду продолжение.', 73, [])
                ]
            });
        }
    };
    CommentSources.register(MockSource);

    // -------------------------------------------------------------------- Feed
    var Feed = (function () {
        var $root = null;
        var scrollPos = 0;

        var CSS =
            '.comments-feed{position:absolute;left:0;right:0;bottom:0;height:74%;z-index:60;' +
            'background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,.82) 12%,rgba(0,0,0,.94) 32%);' +
            'transform:translateY(100%);transition:transform .3s ease;' +
            'padding:2.6em 3.4em 1.4em;box-sizing:border-box;display:flex;flex-direction:column;' +
            'font-family:inherit;}' +
            '.comments-feed.is-visible{transform:translateY(0);}' +
            '.comments-feed__head{color:#fff;font-size:1.5em;font-weight:600;margin-bottom:1em;flex:none;}' +
            '.comments-feed__head b{color:rgba(255,255,255,.45);font-weight:400;font-size:.7em;margin-left:.6em;}' +
            '.comments-feed__list{position:relative;overflow:hidden;flex:1 1 auto;}' +
            '.comments-feed__track{position:absolute;left:0;right:0;top:0;transition:transform .2s ease;}' +
            '.comments-feed__item{display:flex;gap:1em;padding:.95em 0;border-bottom:1px solid rgba(255,255,255,.08);}' +
            '.comments-feed__ava{width:2.7em;height:2.7em;border-radius:50%;background:rgba(255,255,255,.12);' +
            'flex:none;background-size:cover;background-position:center;}' +
            '.comments-feed__body{flex:1 1 auto;min-width:0;}' +
            '.comments-feed__name{color:#fff;font-weight:600;font-size:1em;}' +
            '.comments-feed__date{color:rgba(255,255,255,.4);font-size:.8em;margin-left:.7em;font-weight:400;}' +
            '.comments-feed__text{margin-top:.35em;font-size:1em;line-height:1.45;color:rgba(255,255,255,.82);' +
            'word-wrap:break-word;}' +
            '.comments-feed__reply{margin-top:.7em;padding:0 0 0 1.1em;border-bottom:none;' +
            'border-left:2px solid rgba(255,255,255,.14);}' +
            '.comments-feed__more{color:rgba(255,255,255,.5);text-align:center;padding:1em;flex:none;}';

        function injectStyles() {
            if (document.getElementById('comments-feed-style')) return;
            var s = document.createElement('style');
            s.id = 'comments-feed-style';
            s.textContent = CSS;
            document.body.appendChild(s);
        }

        function commentNode(c, isReply) {
            var $n = $('<div class="comments-feed__item' + (isReply ? ' comments-feed__reply' : '') + '"></div>');
            var $ava = $('<div class="comments-feed__ava"></div>');
            if (c.avatar) $ava.css('background-image', 'url(' + c.avatar + ')');
            var $body = $('<div class="comments-feed__body"></div>');
            $body.append($('<div class="comments-feed__name"></div>').text(c.author)
                 .append($('<span class="comments-feed__date"></span>').text(c.date)));
            $body.append($('<div class="comments-feed__text"></div>').text(c.text));
            $n.append($ava).append($body);
            return $n;
        }

        function build() {
            injectStyles();
            scrollPos = 0;
            $root = $('<div class="comments-feed"><div class="comments-feed__head">Комментарии</div>' +
                      '<div class="comments-feed__list"><div class="comments-feed__track"></div></div>' +
                      '<div class="comments-feed__more"></div></div>');
            $('.player').append($root);
            return $root;
        }

        function appendComments(list) {
            if (!$root) return;
            var $track = $root.find('.comments-feed__track');
            for (var i = 0; i < list.length; i++) {
                var c = list[i];
                $track.append(commentNode(c, false));
                if (c.replies && c.replies.length) {
                    for (var j = 0; j < c.replies.length; j++) $track.append(commentNode(c.replies[j], true));
                }
            }
        }

        function maxScroll() {
            if (!$root) return 0;
            var list  = $root.find('.comments-feed__list').get(0);
            var track = $root.find('.comments-feed__track').get(0);
            if (!list || !track) return 0;
            return Math.max(0, track.offsetHeight - list.clientHeight);
        }

        function step() {
            if (!$root) return 120;
            var list = $root.find('.comments-feed__list').get(0);
            return Math.max(90, (list ? list.clientHeight : 300) * 0.5);
        }

        function apply() {
            if ($root) $root.find('.comments-feed__track').css('transform', 'translateY(' + (-scrollPos) + 'px)');
        }

        // dir: -1 вверх, +1 вниз. Возвращает {atTop, atBottom}.
        function scroll(dir) {
            var max = maxScroll();
            scrollPos = Math.min(max, Math.max(0, scrollPos + dir * step()));
            apply();
            return { atTop: scrollPos <= 0, atBottom: scrollPos >= max - 1, max: max };
        }

        function atTop() { return scrollPos <= 0; }

        function setLoading(on) {
            if ($root) $root.find('.comments-feed__more').text(on ? 'Загрузка…' : '');
        }

        function message(text) {
            if ($root) $root.find('.comments-feed__more').text(text || '');
        }

        function clear() {
            if ($root) { $root.remove(); $root = null; }
            scrollPos = 0;
            var s = document.getElementById('comments-feed-style');
            if (s && s.parentNode) s.parentNode.removeChild(s);
        }

        function root() { return $root; }

        return {
            build: build, appendComments: appendComments, scroll: scroll, atTop: atTop,
            setLoading: setLoading, message: message, clear: clear, root: root
        };
    })();

    // -------------------------------------------------------------- Settings UI
    function registerSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'comments_feed',
            name: 'Комментарии под плеером',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'comments_feed',
            param: { name: KEY.enabled, type: 'trigger', default: true },
            field: { name: 'Включить', description: 'Лента комментариев поверх плеера' }
        });

        var values = {};
        var list = CommentSources.list();
        for (var i = 0; i < list.length; i++) values[list[i].id] = list[i].title;

        Lampa.SettingsApi.addParam({
            component: 'comments_feed',
            param: { name: KEY.source, type: 'select', values: values, default: 'rezka' },
            field: { name: 'Источник', description: 'Откуда тянуть комментарии' }
        });

        Lampa.SettingsApi.addParam({
            component: 'comments_feed',
            param: { name: KEY.proxy, type: 'input', values: '', default: DEFAULTS.proxy },
            field: { name: 'Прокси (опционально)', description: 'Префикс-обход CORS, если нужен. Пусто = прямой запрос' }
        });
    }

    // ------------------------------------------------------------------- Boot
    function boot() {
        registerSettings();

        var S = { card: null, ref: null, page: 0, loading: false, hasMore: true, loaded: [], open: false };

        function prepare(card) {
            S.card = card; S.ref = null; S.page = 0; S.hasMore = true; S.loaded = [];
            var src = CommentSources.active();
            if (!src || !card) return;
            src.find(card, function (ref) { S.ref = ref; log('prepared ref', ref); });
        }

        function loadMore() {
            if (S.loading || !S.hasMore || !S.ref) return;
            var src = CommentSources.active();
            if (!src) return;
            S.loading = true; Feed.setLoading(true);
            src.comments(S.ref, S.page + 1, function (res) {
                S.loading = false; Feed.setLoading(false);
                S.page += 1;
                S.hasMore = res.hasMore;
                if (res.list.length) {
                    for (var i = 0; i < res.list.length; i++) S.loaded.push(res.list[i]);
                    if (S.open) Feed.appendComments(res.list);
                }
                if (!S.loaded.length && !S.hasMore) Feed.message('Комментариев нет');
            });
        }

        function openFeed() {
            if (S.open || !isEnabled() || !$('.player').length) return;
            if (!S.ref) { try { Lampa.Noty.show('Комментарии не найдены'); } catch (e) {} return; }
            S.open = true;
            Feed.build();
            // Перерисовываем уже загруженное (фикс пустого блока при повторном открытии);
            // если ещё ничего нет — тянем первую страницу.
            if (S.loaded.length) Feed.appendComments(S.loaded);
            else loadMore();

            Lampa.Controller.add('comments_feed', {
                invisible: true,
                toggle: function () {},
                up: function () {
                    if (Feed.atTop()) closeFeed();
                    else Feed.scroll(-1);
                },
                down: function () {
                    var st = Feed.scroll(1);
                    if (st.atBottom) loadMore();
                },
                back: closeFeed
            });

            setTimeout(function () {
                var r = Feed.root();
                if (r) r.addClass('is-visible');
                Lampa.Controller.toggle('comments_feed');
            }, 30);
            log('feed opened');
        }

        function closeFeed() {
            if (!S.open) return;
            S.open = false;
            var r = Feed.root();
            if (r) r.removeClass('is-visible');
            setTimeout(function () { Feed.clear(); }, 300);
            try { Lampa.Controller.toggle('player_footer'); }
            catch (e) { try { Lampa.Controller.toggle('player'); } catch (e2) {} }
            log('feed closed');
        }

        function onKeyDown(e) {
            if (!isEnabled() || S.open) return;
            if (e.keyCode !== 40) return; // ArrowDown
            var act = '';
            try { act = Lampa.Controller.enabled().name || ''; } catch (err) {}
            if (act === 'player_footer_element' || act === 'player_footer') {
                e.stopImmediatePropagation();
                e.preventDefault();
                openFeed();
            }
        }
        window.addEventListener('keydown', onKeyDown, true);

        Lampa.Player.listener.follow('start', function (data) {
            if (!isEnabled()) return;
            if (!data.card) {
                try {
                    var a = Lampa.Activity.active();
                    if (a && a.movie && a.movie.id != null) data.card = a.movie;
                } catch (e) {}
            }
            if (data.card) prepare(data.card);
        });

        Lampa.Player.listener.follow('destroy', function () {
            var r = Feed.root();
            if (r) r.removeClass('is-visible');
            Feed.clear();
            Transport.abortAll();
            S.open = false; S.card = null; S.ref = null; S.page = 0;
        });

        log('init, enabled =', isEnabled(), 'android =', Transport.isAndroid());
    }

    function start() {
        if (window.Lampa && Lampa.SettingsApi && Lampa.Storage && Lampa.Player && Lampa.Controller) boot();
        else setTimeout(start, 500);
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
