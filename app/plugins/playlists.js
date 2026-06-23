/*!
 * Playlists — user-named collections of films & series, cache-only.
 *
 * Adds a «Плейлисты» item to Lampa's native long-press («Действие») card menu
 * via the official Manifest.plugins onContextMenu/onContextLauch hook — no DOM
 * patching. Selecting it opens a checkbox Select listing every category
 * (checked = card is a member); checking adds, unchecking removes. A
 * «＋ Новая категория» row opens the keyboard to name a new category and adds
 * the current card to it.
 *
 * A «Плейлисты» entry in Lampa's side menu opens a custom component: a vertical
 * list of categories (icon + name + count) plus a «＋» row. Long-pressing a
 * category opens Открыть / Переименовать / Переместить / Удалить — reorder
 * (live ↑/↓) and delete-with-undo are modelled on last-watched-resume. Opening
 * a category reuses Lampa.InteractionCategory fed the stored cards directly
 * (no global Api.list monkey-patch).
 *
 * Four editable defaults are seeded on first run. Everything persists in
 * Lampa.Storage (cache, NO sync), profile-scoped exactly like
 * last-watched-resume.
 *
 * Storage namespace: playlists_*
 * Log prefix:        [Playlists]
 * Global guard:      window.__vahagnPlaylistsLoaded
 */
(function () {
    'use strict';

    if (window.__vahagnPlaylistsLoaded) return;
    window.__vahagnPlaylistsLoaded = true;

    // ========================================================================
    // Constants
    // ========================================================================

    var LOG_PREFIX      = '[Playlists]';
    var NS              = 'playlists_';
    var DATA_KEY        = NS + 'data';
    var ENABLED_KEY     = NS + 'enabled';
    var SETTINGS_COMP   = 'playlists';
    var LIST_COMPONENT  = 'playlists';
    var CARD_COMPONENT  = 'playlists_category';
    var SIDE_CLASS      = 'playlists-menu-item';
    var REORDER_CLASS   = 'playlists-reorder-active';
    var MIN_APP_DIGITAL = 300;
    var DELETE_UNDO_MS  = 4000;

    var _initialized    = false;
    var _stylesInjected = false;
    var _manifest       = null;

    var ICON_MENU =
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M3 6h12M3 12h12M3 18h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M17 13l5 3-5 3v-6z" fill="currentColor"/></svg>';
    var ICON_FOLDER =
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" ' +
        'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    var ICON_PLUS =
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    var ICON_SETTINGS =
        '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M4 6h10M4 12h10M4 18h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M17 13l5 3-5 3v-6z" fill="currentColor"/></svg>';

    // ========================================================================
    // Logging helpers — single prefix
    // ========================================================================

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG_PREFIX);
            console.log.apply(console, args);
        } catch (e) {}
    }
    function err() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG_PREFIX + ' ERROR');
            console.error.apply(console, args);
        } catch (e) {}
    }
    function tr(key) {
        try { return Lampa.Lang.translate(key); } catch (e) { return key; }
    }

    // ========================================================================
    // Storage — single profile-scoped blob { categories, cards, seeded }
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
        read: function () {
            var data;
            try {
                data = Lampa.Storage.get(Store.scope(DATA_KEY), '{}');
                if (typeof data === 'string') data = JSON.parse(data);
            } catch (e) { data = null; }
            if (!data || typeof data !== 'object' || data.length !== undefined) data = {};
            if (!data.categories || data.categories.length === undefined) data.categories = [];
            if (!data.cards || typeof data.cards !== 'object') data.cards = {};
            return data;
        },
        write: function (data) {
            try {
                normalizeOrder(data);
                Lampa.Storage.set(Store.scope(DATA_KEY), data || {});
            } catch (e) { err('storage:write', e && e.message); }
        }
    };

    function normalizeOrder(data) {
        if (!data || !data.categories) return;
        var i;
        for (i = 0; i < data.categories.length; i++) {
            if (data.categories[i]) data.categories[i].order = i;
        }
    }

    function genId() {
        return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    }

    // ------------------------------------------------------------------ model

    function findCategory(data, id) {
        var i;
        for (i = 0; i < data.categories.length; i++) {
            if (data.categories[i] && data.categories[i].id === id) return data.categories[i];
        }
        return null;
    }

    function categoryIndex(data, id) {
        var i;
        for (i = 0; i < data.categories.length; i++) {
            if (data.categories[i] && data.categories[i].id === id) return i;
        }
        return -1;
    }

    function listCategories() {
        return Store.read().categories.slice();
    }

    function getCategory(id) {
        return findCategory(Store.read(), id);
    }

    function createCategory(title, card) {
        var data = Store.read();
        var cat = { id: genId(), title: title, order: data.categories.length, items: [] };
        data.categories.push(cat);
        if (card && card.id != null) addCardTo(data, cat.id, card);
        Store.write(data);
        log('category:create', 'id=' + cat.id, 'title=' + title, 'withCard=' + !!(card && card.id != null));
        return cat;
    }

    function renameCategory(id, title) {
        var data = Store.read();
        var cat = findCategory(data, id);
        if (!cat) return false;
        cat.title = title;
        Store.write(data);
        log('category:rename', 'id=' + id, 'title=' + title);
        return true;
    }

    // Returns { removedCat, orphanCards } so a delete can be undone.
    function removeCategory(id) {
        var data = Store.read();
        var idx = categoryIndex(data, id);
        if (idx === -1) return null;
        var removed = data.categories.splice(idx, 1)[0];
        var orphan = collectOrphans(data, removed);
        gcCards(data);
        Store.write(data);
        log('category:remove', 'id=' + id, 'idx=' + idx, 'orphanCards=' + Object.keys(orphan).length);
        return { removedCat: removed, orphanCards: orphan, idx: idx };
    }

    function restoreCategory(removedCat, idx, orphanCards) {
        var data = Store.read();
        var at = Math.min(idx, data.categories.length);
        data.categories.splice(at, 0, removedCat);
        var id;
        for (id in orphanCards) {
            if (orphanCards.hasOwnProperty(id) && !data.cards[id]) data.cards[id] = orphanCards[id];
        }
        Store.write(data);
        log('category:restore', 'id=' + removedCat.id, 'at=' + at);
    }

    function moveCategory(id, delta) {
        var data = Store.read();
        var idx = categoryIndex(data, id);
        if (idx === -1) return -1;
        var newIdx = idx + delta;
        if (newIdx < 0 || newIdx >= data.categories.length) return -1;
        var tmp = data.categories[idx];
        data.categories[idx] = data.categories[newIdx];
        data.categories[newIdx] = tmp;
        Store.write(data);
        log('category:move', 'id=' + id, 'from=' + idx, 'to=' + newIdx);
        return newIdx;
    }

    // ------------------------------------------------------------- membership

    function isMember(catId, cardId) {
        var cat = findCategory(Store.read(), catId);
        return !!(cat && cat.items.indexOf(cardId) !== -1);
    }

    function addCardTo(data, catId, card) {
        var cat = findCategory(data, catId);
        if (!cat) return;
        var id = card.id;
        if (cat.items.indexOf(id) === -1) cat.items.unshift(id);
        if (!data.cards[id]) {
            var stored;
            try { stored = Lampa.Utils.clearCard(card); } catch (e) { stored = {}; }
            stored.id = id;
            if (card.source) stored.source = card.source;
            data.cards[id] = stored;
        }
    }

    function removeCardFrom(data, catId, cardId) {
        var cat = findCategory(data, catId);
        if (!cat) return;
        var pos = cat.items.indexOf(cardId);
        if (pos !== -1) cat.items.splice(pos, 1);
        gcCards(data);
    }

    function collectOrphans(data, removedCat) {
        var used = referencedIds(data);
        var orphan = {};
        var i, id;
        for (i = 0; i < (removedCat.items || []).length; i++) {
            id = removedCat.items[i];
            if (!used[id] && data.cards[id]) orphan[id] = data.cards[id];
        }
        return orphan;
    }

    function referencedIds(data) {
        var used = {};
        var i, j, items;
        for (i = 0; i < data.categories.length; i++) {
            items = (data.categories[i] && data.categories[i].items) || [];
            for (j = 0; j < items.length; j++) used[items[j]] = true;
        }
        return used;
    }

    function gcCards(data) {
        var used = referencedIds(data);
        var id;
        for (id in data.cards) {
            if (data.cards.hasOwnProperty(id) && !used[id]) delete data.cards[id];
        }
    }

    function getCategoryCards(catId) {
        var data = Store.read();
        var cat = findCategory(data, catId);
        if (!cat) return [];
        var out = [];
        var i, id, card;
        for (i = 0; i < cat.items.length; i++) {
            id = cat.items[i];
            card = data.cards[id];
            if (card) {
                try { out.push($.extend({}, card)); } catch (e) { out.push(card); }
            }
        }
        return out;
    }

    function toggleMembership(catId, card) {
        var data = Store.read();
        if (isMemberIn(data, catId, card.id)) {
            removeCardFrom(data, catId, card.id);
            log('membership:remove', 'cat=' + catId, 'card=' + card.id);
        } else {
            addCardTo(data, catId, card);
            log('membership:add', 'cat=' + catId, 'card=' + card.id);
        }
        Store.write(data);
    }

    function isMemberIn(data, catId, cardId) {
        var cat = findCategory(data, catId);
        return !!(cat && cat.items.indexOf(cardId) !== -1);
    }

    function seedDefaults() {
        var data = Store.read();
        if (data.seeded) return;
        var titles = [
            tr('playlists_def_favorites'),
            tr('playlists_def_later'),
            tr('playlists_def_evening'),
            tr('playlists_def_again')
        ];
        var i;
        for (i = 0; i < titles.length; i++) {
            data.categories.push({ id: genId(), title: titles[i], order: i, items: [] });
        }
        data.seeded = true;
        Store.write(data);
        log('seed', 'defaults=' + titles.length);
    }

    function clearAll() {
        try {
            Lampa.Storage.set(Store.scope(DATA_KEY), { categories: [], cards: {}, seeded: true });
            log('clear:all');
        } catch (e) { err('clear:all', e && e.message); }
    }

    // ========================================================================
    // Enabled state
    // ========================================================================

    function isEnabled() {
        return Lampa.Storage.field(ENABLED_KEY) !== false;
    }

    // ========================================================================
    // Card context menu — add / remove a card to/from playlists
    // ========================================================================

    function buildManifest() {
        return {
            type: 'video',
            version: '1.0.0',
            name: tr('playlists_menu'),
            description: tr('playlists_descr'),
            onContextMenu: function (card) { return { name: tr('playlists_menu'), description: '' }; },
            onContextLauch: function (card) { onAddToPlaylist(card); }
        };
    }

    function manifestIndex() {
        try {
            var arr = Lampa.Manifest && Lampa.Manifest.plugins;
            if (arr && typeof arr.indexOf === 'function' && _manifest) return arr.indexOf(_manifest);
        } catch (e) {}
        return -1;
    }

    function addManifest() {
        try {
            if (!_manifest) _manifest = buildManifest();
            if (manifestIndex() === -1) Lampa.Manifest.plugins = _manifest; // setter pushes
        } catch (e) { err('manifest:add', e && e.message); }
    }

    function removeManifest() {
        try {
            var idx = manifestIndex();
            if (idx > -1) Lampa.Manifest.plugins.splice(idx, 1);
        } catch (e) { err('manifest:remove', e && e.message); }
    }

    function onAddToPlaylist(card) {
        if (!card || card.id == null) {
            try { Lampa.Noty.show(tr('playlists_no_card')); } catch (e) {}
            return;
        }
        openAddMenu(card);
    }

    function openAddMenu(card) {
        var back = (Lampa.Controller.enabled && (Lampa.Controller.enabled() || {}).name) || 'content';
        var cats = listCategories();
        var items = [];
        var i;
        for (i = 0; i < cats.length; i++) {
            items.push({
                title: cats[i].title,
                checkbox: true,
                checked: isMember(cats[i].id, card.id),
                playlists_cat_id: cats[i].id
            });
        }
        items.push({ title: tr('playlists_new_category'), playlists_new: true, separator: cats.length > 0 });

        Lampa.Select.show({
            title: tr('playlists_add_title'),
            items: items,
            onBack: function () { restoreController(back); },
            onCheck: function (a) {
                if (a && a.playlists_cat_id) toggleMembership(a.playlists_cat_id, card);
            },
            onSelect: function (a) {
                if (a && a.playlists_new) {
                    createCategoryFlow(card, back, function () { openAddMenu(card); });
                    return;
                }
                restoreController(back);
            }
        });
    }

    function restoreController(name) {
        try { if (name) Lampa.Controller.toggle(name); } catch (e) {}
    }

    // ------------------------------------------------------- keyboard helpers

    function createCategoryFlow(card, back, onDone) {
        try {
            Lampa.Input.edit(
                { title: tr('playlists_new_category'), free: true, nosave: true, value: '' },
                function (value) {
                    var name = (value || '').trim();
                    if (!name) {
                        try { Lampa.Noty.show(tr('playlists_empty_name')); } catch (e) {}
                        if (onDone) onDone(null); else restoreController(back);
                        return;
                    }
                    var cat = createCategory(name, card || null);
                    if (onDone) onDone(cat); else restoreController(back);
                }
            );
        } catch (e) { err('input:create', e && e.message); restoreController(back); }
    }

    function renameCategoryFlow(catId, back, onDone) {
        var cat = getCategory(catId);
        if (!cat) { restoreController(back); return; }
        try {
            Lampa.Input.edit(
                { title: tr('playlists_rename'), free: true, nosave: true, value: cat.title },
                function (value) {
                    var name = (value || '').trim();
                    if (name) renameCategory(catId, name);
                    else try { Lampa.Noty.show(tr('playlists_empty_name')); } catch (e) {}
                    if (onDone) onDone(name || cat.title); else restoreController(back);
                }
            );
        } catch (e) { err('input:rename', e && e.message); restoreController(back); }
    }

    // ========================================================================
    // Side menu entry
    // ========================================================================

    function addMenuButton() {
        try {
            var $list = $('.menu .menu__list').eq(0);
            if (!$list.length) return;
            if ($list.find('.' + SIDE_CLASS).length) return;
            var $btn = $('<li class="menu__item selector ' + SIDE_CLASS + '">' +
                '<div class="menu__ico">' + ICON_MENU + '</div>' +
                '<div class="menu__text"></div></li>');
            $btn.find('.menu__text').text(tr('playlists_menu'));
            $btn.on('hover:enter', openPlaylists).on('click', openPlaylists);
            $list.append($btn);
            log('menu:add');
        } catch (e) { err('menu:add', e && e.message); }
    }

    function removeMenuButton() {
        try { $('.' + SIDE_CLASS).remove(); } catch (e) {}
    }

    function openPlaylists() {
        try {
            Lampa.Activity.push({ url: '', title: tr('playlists_title'), component: LIST_COMPONENT, page: 1 });
        } catch (e) { err('open:list', e && e.message); }
    }

    function openCategory(catId) {
        var cat = getCategory(catId);
        if (!cat) return;
        try {
            Lampa.Activity.push({
                url: '',
                title: cat.title,
                component: CARD_COMPONENT,
                playlists_id: catId,
                source: 'tmdb',
                page: 1
            });
        } catch (e) { err('open:category', e && e.message); }
    }

    // ========================================================================
    // List component — vertical list of categories (custom, 1-D navigation)
    // ========================================================================

    function PlaylistsListComponent(object) {
        var root   = document.createElement('div');
        var scroll = null;
        var bodyEl = null;
        var rows   = [];          // category-row DOM nodes (excludes the add row)
        var addRow = null;
        var focusIndex = 0;
        var self   = this;
        var moveActive = false;

        root.className = 'playlists';

        this.create = function () {
            redraw();
            return this.render();
        };

        function redraw() {
            try {
                if (scroll && scroll.destroy) scroll.destroy();
            } catch (e) {}
            root.innerHTML = '';
            rows = [];
            scroll = new Lampa.Scroll({ mask: true, over: true });
            bodyEl = document.createElement('div');
            bodyEl.className = 'playlists__body';

            var cats = listCategories();
            var i;
            for (i = 0; i < cats.length; i++) bodyEl.appendChild(buildRow(cats[i]));
            addRow = buildAddRow();
            bodyEl.appendChild(addRow);

            scroll.append(bodyEl);
            root.appendChild(scroll.render(true));

            if (focusIndex >= allSelectors().length) focusIndex = allSelectors().length - 1;
            if (focusIndex < 0) focusIndex = 0;

            try { if (self.activity) { self.activity.loader(false); self.activity.toggle(); } } catch (e) {}
        }

        function allSelectors() {
            return rows.concat([addRow]);
        }

        function buildRow(cat) {
            var node = document.createElement('div');
            node.className = 'playlists__row selector';
            node.setAttribute('data-id', cat.id);
            node.innerHTML =
                '<div class="playlists__row-ico">' + ICON_FOLDER + '</div>' +
                '<div class="playlists__row-title"></div>' +
                '<div class="playlists__row-count"></div>';
            $(node).find('.playlists__row-title').text(cat.title);
            $(node).find('.playlists__row-count').text(cat.items && cat.items.length ? String(cat.items.length) : '');
            $(node).on('hover:enter', function () { if (!moveActive) openCategory(cat.id); });
            $(node).on('hover:long', function () { if (!moveActive) openManageMenu(cat.id, node); });
            rows.push(node);
            return node;
        }

        function buildAddRow() {
            var node = document.createElement('div');
            node.className = 'playlists__row playlists__row--add selector';
            node.innerHTML =
                '<div class="playlists__row-ico">' + ICON_PLUS + '</div>' +
                '<div class="playlists__row-title"></div>';
            $(node).find('.playlists__row-title').text(tr('playlists_new_category'));
            $(node).on('hover:enter', function () {
                if (moveActive) return;
                createCategoryFlow(null, 'content', function () { focusIndex = rows.length - 1; redraw(); backToContent(); });
            });
            return node;
        }

        function focusCurrent() {
            var sel = allSelectors();
            if (focusIndex < 0) focusIndex = 0;
            if (focusIndex >= sel.length) focusIndex = sel.length - 1;
            var el = sel[focusIndex];
            if (!el) return;
            try {
                Lampa.Controller.collectionSet(root);
                Lampa.Controller.collectionFocus(el, root);
                if (scroll && scroll.update) scroll.update($(el));
            } catch (e) {}
        }

        function backToContent() {
            try { Lampa.Controller.toggle('content'); } catch (e) {}
        }

        // ---------------------------------------------------- manage a category

        function openManageMenu(catId, rowEl) {
            var cat = getCategory(catId);
            if (!cat) return;
            Lampa.Select.show({
                title: cat.title,
                items: [
                    { title: tr('playlists_open'),   pl_act: 'open' },
                    { title: tr('playlists_rename'), pl_act: 'rename' },
                    { title: tr('playlists_move'),   pl_act: 'move' },
                    { title: tr('playlists_delete'), pl_act: 'delete' }
                ],
                onBack: backToContent,
                onSelect: function (a) {
                    if (a.pl_act === 'open') { openCategory(catId); return; }
                    if (a.pl_act === 'rename') {
                        renameCategoryFlow(catId, 'content', function () {
                            var c = getCategory(catId);
                            if (c) $(rowEl).find('.playlists__row-title').text(c.title);
                            backToContent();
                        });
                        return;
                    }
                    if (a.pl_act === 'move') { enterMove(catId, rowEl); return; }
                    if (a.pl_act === 'delete') { backToContent(); handleDelete(catId, rowEl); return; }
                }
            });
        }

        // ------------------------------------------------------------ reorder

        function enterMove(catId, rowEl) {
            ensureStyles();
            moveActive = true;
            $(rowEl).addClass(REORDER_CLASS);
            focusIndex = rows.indexOf(rowEl);
            log('move:enter', 'id=' + catId);
            try {
                Lampa.Controller.add('playlists_reorder', {
                    invisible: true,
                    toggle: function () {
                        Lampa.Controller.collectionSet(root);
                        Lampa.Controller.collectionFocus(rowEl, root);
                    },
                    up:    function () { shift(catId, rowEl, -1); },
                    down:  function () { shift(catId, rowEl, +1); },
                    left:  function () { exitMove(catId, rowEl); },
                    right: function () { exitMove(catId, rowEl); },
                    enter: function () { exitMove(catId, rowEl); },
                    back:  function () { exitMove(catId, rowEl); }
                });
                Lampa.Controller.toggle('playlists_reorder');
            } catch (e) {
                err('move:enter', e && e.message);
                exitMove(catId, rowEl);
            }
        }

        function shift(catId, rowEl, delta) {
            var newIdx = moveCategory(catId, delta);
            if (newIdx === -1) return;
            var oldIdx = rows.indexOf(rowEl);
            var $row = $(rowEl);
            if (delta < 0) $row.prev('.playlists__row:not(.playlists__row--add)').before($row);
            else           $row.next('.playlists__row:not(.playlists__row--add)').after($row);
            rows.splice(oldIdx, 1);
            rows.splice(newIdx, 0, rowEl);
            focusIndex = newIdx;
            try {
                Lampa.Controller.collectionSet(root);
                Lampa.Controller.collectionFocus(rowEl, root);
                if (scroll && scroll.update) scroll.update($row);
            } catch (e) {}
        }

        function exitMove(catId, rowEl) {
            if (!moveActive) return;
            moveActive = false;
            try { $(rowEl).removeClass(REORDER_CLASS); } catch (e) {}
            log('move:exit', 'id=' + catId);
            backToContent();
        }

        // ------------------------------------------------------- delete + undo

        function handleDelete(catId, rowEl) {
            var res = removeCategory(catId);
            if (!res) return;

            var sel = allSelectors();
            var pos = rows.indexOf(rowEl);
            $(rowEl).remove();
            rows.splice(pos, 1);
            focusIndex = Math.min(pos, allSelectors().length - 1);
            focusCurrent();

            showUndoToast(res, rowEl);
        }

        function showUndoToast(res, rowEl) {
            var back = 'content';
            var label = res.removedCat.title;
            var undone = false;
            var autoClose;

            var undo = function () {
                if (undone) return;
                undone = true;
                restoreCategory(res.removedCat, res.idx, res.orphanCards);
                redraw();
                focusIndex = Math.min(res.idx, rows.length - 1);
                focusCurrent();
            };

            try { Lampa.Noty.show(tr('playlists_deleted_noty').replace('{title}', label)); } catch (e) {}

            try {
                Lampa.Select.show({
                    title: tr('playlists_deleted_noty').replace('{title}', label),
                    items: [{ title: tr('playlists_undo'), pl_undo: true }],
                    onBack: function () { if (autoClose) clearTimeout(autoClose); restoreController(back); },
                    onSelect: function (a) {
                        if (autoClose) clearTimeout(autoClose);
                        if (a && a.pl_undo) undo();
                        restoreController(back);
                    }
                });
                autoClose = setTimeout(function () {
                    try { if (Lampa.Select && Lampa.Select.close) Lampa.Select.close(); } catch (e) {}
                    restoreController(back);
                }, DELETE_UNDO_MS);
            } catch (e) { err('delete:undo', e && e.message); }
        }

        // -------------------------------------------------------- lifecycle

        this.start = function () {
            if (Lampa.Activity.active() && Lampa.Activity.active().activity !== this.activity) return;

            Lampa.Controller.add('content', {
                link: self,
                toggle: function () {
                    Lampa.Controller.collectionSet(root);
                    var sel = allSelectors();
                    Lampa.Controller.collectionFocus(sel[focusIndex] || false, root);
                },
                up: function () {
                    if (focusIndex > 0) { focusIndex--; focusCurrent(); }
                    else { try { Lampa.Controller.toggle('head'); } catch (e) {} }
                },
                down: function () {
                    if (focusIndex < allSelectors().length - 1) { focusIndex++; focusCurrent(); }
                },
                left: function () { try { Lampa.Controller.toggle('menu'); } catch (e) {} },
                right: function () {},
                back: function () { Lampa.Activity.backward(); }
            });
            Lampa.Controller.toggle('content');
        };

        this.pause   = function () {};
        this.stop    = function () {};
        this.render  = function (js) { return js ? root : $(root); };
        this.destroy = function () {
            try { if (scroll && scroll.destroy) scroll.destroy(); } catch (e) {}
            try { $(root).remove(); } catch (e) {}
            scroll = null; bodyEl = null; rows = []; addRow = null;
        };
    }

    // ========================================================================
    // Category component — cards of one playlist via Lampa.InteractionCategory
    // ========================================================================

    function PlaylistsCategoryComponent(object) {
        var comp = new Lampa.InteractionCategory(object);

        comp.create = function () {
            try { this.activity.loader(false); } catch (e) {}
            var cards = getCategoryCards(object.playlists_id);
            this.build({ results: cards, total_pages: 1, page: 1 });
            return this.render();
        };

        comp.nextPageReuest = function (object2, resolve, reject) {
            // Single-page: nothing more to fetch.
            resolve.call(comp, { results: [], total_pages: 1, page: 1 });
        };

        // Default card behaviour is exactly what we want: onEnter opens the
        // full card screen; the long-press card menu (Card.onMenu) already
        // includes our «Плейлисты» item, so unchecking removes the card.
        comp.cardRender = function (object2, element, card) {};

        return comp;
    }

    // ========================================================================
    // Styles
    // ========================================================================

    function ensureStyles() {
        if (_stylesInjected) return;
        _stylesInjected = true;
        try {
            var css = '' +
                '.playlists__body{padding:1.5em 0;max-width:60em;margin:0 auto;}' +
                '.playlists__row{display:-webkit-box;display:flex;-webkit-box-align:center;align-items:center;' +
                    'padding:1em 1.4em;margin:0 1.5em .6em;border-radius:.6em;background:rgba(255,255,255,.05);}' +
                '.playlists__row-ico{display:-webkit-box;display:flex;margin-right:1em;opacity:.85;}' +
                '.playlists__row-ico svg{width:1.5em;height:1.5em;}' +
                '.playlists__row-title{font-size:1.4em;-webkit-box-flex:1;flex:1;}' +
                '.playlists__row-count{font-size:1.2em;opacity:.5;padding-left:1em;}' +
                '.playlists__row--add{opacity:.8;}' +
                '.playlists__row.focus{background:#fff;color:#000;}' +
                '.playlists__row.focus .playlists__row-count{opacity:.6;}' +
                '.playlists__row.' + REORDER_CLASS + '{box-shadow:0 0 0 .15em #f5c518;background:#fff;color:#000;}';
            var style = document.createElement('style');
            style.setAttribute('data-playlists', '1');
            style.appendChild(document.createTextNode(css));
            document.head.appendChild(style);
        } catch (e) { err('styles', e && e.message); }
    }

    // ========================================================================
    // Settings
    // ========================================================================

    function registerSettings() {
        try {
            Lampa.SettingsApi.addComponent({
                component: SETTINGS_COMP,
                name: tr('playlists_settings_name'),
                icon: ICON_SETTINGS
            });
            Lampa.SettingsApi.addParam({
                component: SETTINGS_COMP,
                param: { name: ENABLED_KEY, type: 'trigger', default: true },
                field: { name: tr('playlists_enable'), description: tr('playlists_enable_desc') },
                onChange: function (value) { applyEnabled(value !== false && value !== 'false'); }
            });
            Lampa.SettingsApi.addParam({
                component: SETTINGS_COMP,
                param: { name: NS + 'clear_btn', type: 'button' },
                field: { name: tr('playlists_settings_clear'), description: tr('playlists_settings_clear_desc') },
                onChange: function () { confirmClear(); }
            });
        } catch (e) { err('settings', e && e.message); }
    }

    function confirmClear() {
        var back = (Lampa.Controller.enabled && (Lampa.Controller.enabled() || {}).name) || 'settings_component';
        try {
            Lampa.Select.show({
                title: tr('playlists_settings_clear'),
                items: [
                    { title: tr('playlists_confirm_yes'), pl_clear: true },
                    { title: tr('playlists_confirm_no') }
                ],
                onBack: function () { restoreController(back); },
                onSelect: function (a) {
                    if (a && a.pl_clear) {
                        clearAll();
                        try { Lampa.Noty.show(tr('playlists_cleared_noty')); } catch (e) {}
                    }
                    restoreController(back);
                }
            });
        } catch (e) { err('clear:confirm', e && e.message); }
    }

    function applyEnabled(enabled) {
        if (enabled) { addManifest(); addMenuButton(); }
        else { removeManifest(); removeMenuButton(); }
        log('enabled', enabled);
    }

    // ========================================================================
    // i18n
    // ========================================================================

    function registerLang() {
        try {
            Lampa.Lang.add({
                playlists_menu:            { ru: 'Плейлисты',           en: 'Playlists' },
                playlists_descr:           { ru: 'Пользовательские плейлисты', en: 'User playlists' },
                playlists_title:           { ru: 'Плейлисты',           en: 'Playlists' },
                playlists_settings_name:   { ru: 'Плейлисты',           en: 'Playlists' },
                playlists_add_title:       { ru: 'Добавить в плейлист',  en: 'Add to playlist' },
                playlists_new_category:    { ru: 'Новая категория',      en: 'New category' },
                playlists_open:            { ru: 'Открыть',              en: 'Open' },
                playlists_rename:          { ru: 'Переименовать',        en: 'Rename' },
                playlists_move:            { ru: 'Переместить',          en: 'Move' },
                playlists_delete:          { ru: 'Удалить',              en: 'Delete' },
                playlists_undo:            { ru: 'Отменить удаление',    en: 'Undo delete' },
                playlists_deleted_noty:    { ru: 'Удалено: {title}',     en: 'Deleted: {title}' },
                playlists_cleared_noty:    { ru: 'Все плейлисты очищены', en: 'All playlists cleared' },
                playlists_empty_name:      { ru: 'Введите название',      en: 'Enter a name' },
                playlists_no_card:         { ru: 'Нельзя добавить эту карточку', en: 'Cannot add this card' },
                playlists_enable:          { ru: 'Включить плагин',       en: 'Enable plugin' },
                playlists_enable_desc:     { ru: 'Пункт «Плейлисты» в меню карточки и боковом меню', en: 'Playlists item in card menu and side menu' },
                playlists_settings_clear:  { ru: 'Очистить все плейлисты', en: 'Clear all playlists' },
                playlists_settings_clear_desc: { ru: 'Удалить все категории и карточки', en: 'Remove all categories and cards' },
                playlists_confirm_yes:     { ru: 'Да, очистить',         en: 'Yes, clear' },
                playlists_confirm_no:      { ru: 'Отмена',               en: 'Cancel' },
                playlists_def_favorites:   { ru: 'Любимые фильмы',        en: 'Favorite movies' },
                playlists_def_later:       { ru: 'Посмотреть позже',      en: 'Watch later' },
                playlists_def_evening:     { ru: 'На вечер',              en: 'For the evening' },
                playlists_def_again:       { ru: 'Посмотреть ещё раз',    en: 'Watch again' }
            });
        } catch (e) { err('lang', e && e.message); }
    }

    // ========================================================================
    // Init + bootstrap
    // ========================================================================

    function init() {
        if (_initialized) return;
        _initialized = true;

        registerLang();
        registerSettings();
        ensureStyles();
        seedDefaults();

        try { Lampa.Component.add(LIST_COMPONENT, PlaylistsListComponent); } catch (e) { err('component:list', e && e.message); }

        if (Lampa.Manifest && Lampa.Manifest.app_digital >= MIN_APP_DIGITAL && typeof Lampa.InteractionCategory !== 'undefined') {
            try { Lampa.Component.add(CARD_COMPONENT, PlaylistsCategoryComponent); }
            catch (e) { err('component:category', e && e.message); }
        } else {
            log('init', 'InteractionCategory unavailable — category browsing disabled');
        }

        if (isEnabled()) { addManifest(); addMenuButton(); }

        try {
            Lampa.Storage.listener.follow('change', function (e) {
                if (e && e.name === ENABLED_KEY) applyEnabled(e.value !== false && e.value !== 'false');
            });
        } catch (e) { err('init:listener', e && e.message); }

        log('init', 'done', 'enabled=' + isEnabled());
    }

    function start() {
        if (window.Lampa && Lampa.SettingsApi && Lampa.Storage && Lampa.Component && Lampa.Controller && Lampa.Select) init();
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
