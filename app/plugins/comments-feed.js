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

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG);
            console.log.apply(console, args);
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
            // TODO: вернуть дефолт 'rezka' после визуального теста
            var id = Lampa.Storage.get(KEY.source, 'mock') || 'mock';
            return map[id] || map.mock || map.rezka || null;
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

            Transport.get(url, function (html) {
                var newsId = null;
                try {
                    var $items = $('<div></div>').append($.parseHTML(html || '')).find('.b-content__inline_item');
                    if ($items.length) {
                        var raw = $items.first().attr('data-id');
                        if (raw) newsId = String(raw).replace(/[^0-9]/g, '') || null;
                    }
                } catch (e) { log('find parse error', e); }
                log('find', name, year, '->', newsId);
                cb(newsId);
            }, function (status) {
                log('find request failed', status);
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
                try {
                    var json = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    html = (json && json.comments) || '';
                } catch (e) { log('comments json error', e); }
                var list = RezkaSource._parse(html);
                log('comments page', page, '->', list.length);
                cb({ list: list, hasMore: list.length > 0 });
            }, function (status) {
                log('comments request failed', status);
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

        var CSS =
            '.comments-feed{position:absolute;left:0;right:0;bottom:0;height:70%;z-index:60;' +
            'background:linear-gradient(180deg,rgba(8,11,20,0) 0%,rgba(8,11,20,.92) 18%,#080b14 40%);' +
            'transform:translateY(100%);transition:transform .3s ease;padding:2em 3em 1em;box-sizing:border-box;' +
            'overflow:hidden;display:flex;flex-direction:column;}' +
            '.comments-feed.is-visible{transform:translateY(0);}' +
            '.comments-feed__head{color:#fff;font-size:1.4em;font-weight:600;margin-bottom:.7em;flex:none;}' +
            '.comments-feed__list{overflow:hidden;flex:1 1 auto;}' +
            '.comments-feed__item{display:flex;gap:.8em;padding:.7em;border-radius:.6em;margin-bottom:.4em;}' +
            '.comments-feed__item.focus{background:rgba(255,255,255,.12);}' +
            '.comments-feed__ava{width:2.4em;height:2.4em;border-radius:50%;background:#2b3852;flex:none;' +
            'background-size:cover;background-position:center;}' +
            '.comments-feed__body{flex:1 1 auto;color:#cdd6e3;}' +
            '.comments-feed__name{color:#7da2d8;font-weight:600;font-size:.95em;}' +
            '.comments-feed__date{color:#6b7686;font-size:.8em;margin-left:.6em;}' +
            '.comments-feed__text{margin-top:.25em;font-size:.95em;line-height:1.4;}' +
            '.comments-feed__reply{margin-top:.5em;padding-left:1em;border-left:2px solid #2a3550;}' +
            '.comments-feed__more{color:#8b96a6;text-align:center;padding:.8em;flex:none;}';

        function injectStyles() {
            if (document.getElementById('comments-feed-style')) return;
            var s = document.createElement('style');
            s.id = 'comments-feed-style';
            s.textContent = CSS;
            document.body.appendChild(s);
        }

        function commentNode(c, isReply) {
            var $n = $('<div class="comments-feed__item' + (isReply ? ' comments-feed__reply' : '') + ' selector"></div>');
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
            $root = $('<div class="comments-feed"><div class="comments-feed__head">Комментарии</div>' +
                      '<div class="comments-feed__list"></div>' +
                      '<div class="comments-feed__more"></div></div>');
            $('.player').append($root);
            return $root;
        }

        function appendComments(list) {
            if (!$root) return;
            var $list = $root.find('.comments-feed__list');
            for (var i = 0; i < list.length; i++) {
                var c = list[i];
                $list.append(commentNode(c, false));
                if (c.replies && c.replies.length) {
                    for (var j = 0; j < c.replies.length; j++) $list.append(commentNode(c.replies[j], true));
                }
            }
        }

        function setLoading(on) {
            if ($root) $root.find('.comments-feed__more').text(on ? 'Загрузка…' : '');
        }

        function message(text) {
            if ($root) $root.find('.comments-feed__more').text(text || '');
        }

        function clear() {
            if ($root) { $root.remove(); $root = null; }
            var s = document.getElementById('comments-feed-style');
            if (s && s.parentNode) s.parentNode.removeChild(s);
        }

        function root() { return $root; }

        return {
            build: build, appendComments: appendComments, setLoading: setLoading,
            message: message, clear: clear, root: root
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
            param: { name: KEY.source, type: 'select', values: values, default: 'mock' },
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

        var S = { card: null, ref: null, page: 0, loading: false, hasMore: true, focus: 0, open: false };

        function prepare(card) {
            S.card = card; S.ref = null; S.page = 0; S.hasMore = true; S.focus = 0;
            var src = CommentSources.active();
            if (!src || !card) return;
            src.find(card, function (ref) { S.ref = ref; log('prepared ref', ref); });
        }

        function items() {
            var r = Feed.root();
            return r ? r.find('.comments-feed__item') : $();
        }

        function setFocus(idx) {
            var $it = items();
            if (!$it.length) return;
            idx = Math.max(0, Math.min(idx, $it.length - 1));
            S.focus = idx;
            $it.removeClass('focus');
            var el = $it.eq(idx).addClass('focus').get(0);
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
            if (idx >= $it.length - 3) loadMore();
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
                if (res.list.length) Feed.appendComments(res.list);
                if (!items().length && !S.hasMore) Feed.message('Комментариев нет');
            });
        }

        function openFeed() {
            if (S.open || !isEnabled() || !$('.player').length) return;
            if (!S.ref) { try { Lampa.Noty.show('Комментарии не найдены'); } catch (e) {} return; }
            S.open = true; S.focus = 0;
            Feed.build();
            Lampa.Controller.add('comments_feed', {
                invisible: true,
                toggle: function () { setFocus(S.focus); },
                up: function () { if (S.focus <= 0) closeFeed(); else setFocus(S.focus - 1); },
                down: function () { setFocus(S.focus + 1); },
                back: closeFeed
            });
            loadMore();
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
