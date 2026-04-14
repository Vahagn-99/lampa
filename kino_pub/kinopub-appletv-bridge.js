/* KinoPub × AppleTV.js — Lampa bridge plugin
 *
 * Purpose:
 *   When the user clicks a series episode inside the Netflix-style episode
 *   list rendered by appleTV.js, open the z01 lampac_z component with
 *   KinoPub preselected as the balancer — instead of whatever Lampa's
 *   default routing would do.
 *
 * Upstream plugins required (install via Lampa Settings → Extensions):
 *   - appleTV.js   https://tvigl.github.io/plugins/appleTV.js
 *   - online.js    http://z01.online/online.js   (Z01 Premium with KinoPub)
 *
 * Markers this bridge relies on:
 *   - "appleTV.js is loaded":  any body class beginning with "applecation"
 *     (the plugin emits "applecation--hide-ratings" / "applecation--ratings-card"
 *     from init eagerly, and plain "applecation" when a full card is open),
 *     OR any <style data-id="applecation*"> present in the document.
 *   - "z01 lampac_z is registered":  Lampa.Component.get('lampac_z') resolves.
 *   - "KinoPub balancer id":  the string 'kinopub' (z01's balanserName() lower-cases).
 *   - "z01 balancer-selection precedence" (from reconnaissance of online.js):
 *        object.balanser (push arg)
 *        > online_last_balanser[movie.id] (Storage cache)
 *        > online_balanser (Storage global)
 *        > first source in list
 *     => Passing balanser:'kinopub' in the push arg is enough. This bridge
 *        does NOT touch Lampa.Storage so the user's global default balancer
 *        and per-series cache are preserved.
 *
 * Interception strategy:
 *   Wrap Lampa.Activity.push and Lampa.Player.play (Lampa-core APIs; not
 *   upstream-plugin APIs). Both mouse-click and TV-remote Enter paths
 *   converge on these calls, whereas a DOM "click" listener would miss
 *   remote-control input (Lampa core fires jQuery "hover:enter", not a
 *   native click — see lampa-source/src/core/controller.js:94-100).
 *
 * Guards (all must pass to intercept):
 *   1. body has class "applecation"              (appleTV is active)
 *   2. Lampa.Activity.active().component=='full' (we're on a full card)
 *   3. active().card is a series (name set, or number_of_seasons>0)
 *   4. !Lampa.Player.opened()                    (not mid-playback)
 *   5. obj.component !== 'lampac_z'              (no re-entry)
 *   6. season + episode derivable from obj/obj.movie/obj.card
 *
 * Any thrown error or failed guard -> fall through to the saved original
 * with unmodified arguments. Bias: never break navigation.
 *
 * Double-install guard: window.__kinoPubAppleTvBridgeLoaded
 * Diagnostic prefix:    [KinoPubBridge]
 *
 * License: same as this repo. Single-file ES5 plugin, no runtime deps.
 */
(function(){
    'use strict';

    if (window.__kinoPubAppleTvBridgeLoaded) return;
    window.__kinoPubAppleTvBridgeLoaded = true;

    var LOG_PREFIX = '[KinoPubBridge]';
    var KINOPUB_ID = 'kinopub';
    var MAX_INIT_RETRIES = 20;      // ~10s total at 500ms each
    var INIT_RETRY_INTERVAL = 500;  // ms

    function log(){
        try {
            var args = [LOG_PREFIX];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            console.log.apply(console, args);
        } catch(e){}
    }

    function isAppleTvLoaded(){
        try {
            if (document.body && document.body.className && /\bapplecation(?:--|\s|$)/.test(document.body.className)) return true;
            if (document.querySelector) {
                var styles = document.querySelectorAll('style[data-id]');
                for (var i = 0; i < styles.length; i++) {
                    var id = styles[i].getAttribute('data-id') || '';
                    if (id.indexOf('applecation') === 0) return true;
                }
            }
            return false;
        } catch(e){ return false; }
    }

    function isLampacZRegistered(){
        try {
            if (!window.Lampa || !Lampa.Component) return false;
            if (typeof Lampa.Component.get === 'function') {
                try { if (Lampa.Component.get('lampac_z')) return true; } catch(ignored){}
            }
            var reg = Lampa.Component._components || Lampa.Component.list || Lampa.Component.all || Lampa.Component.components;
            if (reg) {
                if (typeof reg === 'function') {
                    try { var listed = reg(); if (listed && (listed.lampac_z || listed['lampac_z'])) return true; } catch(ignored2){}
                }
                if (reg.lampac_z || reg['lampac_z']) return true;
            }
            return false;
        } catch(e){ return false; }
    }

    function isPlayerOpen(){
        try {
            if (window.Lampa && Lampa.Player && typeof Lampa.Player.opened === 'function') {
                if (Lampa.Player.opened()) return true;
            }
            if (document.body && document.body.classList && document.body.classList.contains('player--viewing')) return true;
            return false;
        } catch(e){ return false; }
    }

    function getActiveCard(obj){
        if (obj) {
            if (obj.card)  return obj.card;
            if (obj.movie) return obj.movie;
        }
        try {
            var a = Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();
            if (a) return a.card || a.movie || null;
        } catch(e){}
        return null;
    }

    function isSeriesCard(card){
        if (!card) return false;
        if (card.name) return true;
        if (card.number_of_seasons && card.number_of_seasons > 0) return true;
        if (card.first_air_date) return true;
        return false;
    }

    function resolveSeasonEpisode(obj){
        var o = obj || {};
        var s = o.season != null ? o.season : null;
        var e = o.episode != null ? o.episode : null;
        if (s == null || e == null) {
            var m = o.movie || o.card;
            if (m) {
                if (s == null && m.season != null) s = m.season;
                if (e == null && m.episode != null) e = m.episode;
            }
        }
        if (s != null) { s = parseInt(s, 10); if (isNaN(s)) s = null; }
        if (e != null) { e = parseInt(e, 10); if (isNaN(e)) e = null; }
        return { season: s, episode: e };
    }

    function onSeriesFullCard(){
        try {
            if (!isAppleTvLoaded()) return false;
            if (isPlayerOpen()) return false;
            var a = Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();
            if (!a || a.component !== 'full') return false;
            if (!isSeriesCard(a.card || a.movie)) return false;
            return true;
        } catch(e){ return false; }
    }

    function shouldIntercept(obj){
        if (!obj || typeof obj !== 'object') return false;
        if (obj.component === 'lampac_z') return false;
        if (!onSeriesFullCard()) return false;
        var se = resolveSeasonEpisode(obj);
        if (se.season == null || se.episode == null) {
            log('skip intercept: missing season/episode', { component: obj.component });
            return false;
        }
        return true;
    }

    function rewriteForKinoPub(obj){
        var card = getActiveCard(obj) || {};
        var se = resolveSeasonEpisode(obj);
        var title = obj.title || card.title || card.name || '';
        var search = card.title || card.name || card.original_title || card.original_name || title;
        return {
            url: '',
            title: title,
            component: 'lampac_z',
            movie: card,
            card: card,
            id: card.id,
            imdb_id: card.imdb_id,
            search: search,
            search_one: card.title || card.name,
            search_two: card.original_title || card.original_name,
            page: 1,
            season: se.season,
            episode: se.episode,
            balanser: KINOPUB_ID,
            source: KINOPUB_ID
        };
    }

    function installWrappers(){
        if (!Lampa.Activity || typeof Lampa.Activity.push !== 'function') {
            log('disabled: Lampa.Activity.push unavailable');
            return;
        }
        if (Lampa.Activity.push.__kinopub_wrapped) {
            log('Activity.push already wrapped — skipping');
            return;
        }

        var origPush = Lampa.Activity.push;
        var origPlay = (Lampa.Player && typeof Lampa.Player.play === 'function') ? Lampa.Player.play : null;

        var wrappedPush = function(obj){
            try {
                if (shouldIntercept(obj)) {
                    var rewritten = rewriteForKinoPub(obj);
                    log('intercept push -> lampac_z+kinopub', { from: obj && obj.component, season: rewritten.season, episode: rewritten.episode });
                    return origPush.call(Lampa.Activity, rewritten);
                }
            } catch(err) {
                log('wrapper error (push):', err && err.message ? err.message : err);
            }
            return origPush.apply(Lampa.Activity, arguments);
        };
        wrappedPush.__kinopub_wrapped = true;
        Lampa.Activity.push = wrappedPush;

        if (origPlay && !origPlay.__kinopub_wrapped) {
            var wrappedPlay = function(obj){
                try {
                    if (shouldIntercept(obj)) {
                        var rewritten = rewriteForKinoPub(obj);
                        log('intercept play -> lampac_z+kinopub', { season: rewritten.season, episode: rewritten.episode });
                        return origPush.call(Lampa.Activity, rewritten);
                    }
                } catch(err) {
                    log('wrapper error (play):', err && err.message ? err.message : err);
                }
                return origPlay.apply(Lampa.Player, arguments);
            };
            wrappedPlay.__kinopub_wrapped = true;
            Lampa.Player.play = wrappedPlay;
        }

        log('v1.0 initialized — wrappers installed (Activity.push' + (origPlay ? ', Player.play' : '') + ')');
    }

    function tryInit(retries){
        if (retries == null) retries = MAX_INIT_RETRIES;
        var apple = isAppleTvLoaded();
        var zreg  = isLampacZRegistered();
        if (apple && zreg) { installWrappers(); return; }
        if (retries > 0) {
            setTimeout(function(){ tryInit(retries - 1); }, INIT_RETRY_INTERVAL);
            return;
        }
        if (!apple) log('disabled: appleTV not detected');
        if (!zreg)  log('disabled: lampac_z not registered');
    }

    function startPlugin(){
        if (window.Lampa && Lampa.Activity && Lampa.Component) {
            tryInit();
        } else {
            setTimeout(startPlugin, 500);
        }
    }

    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function(e){ if (e.type === 'ready') startPlugin(); });
        setTimeout(startPlugin, 1000);
    } else {
        var ri = setInterval(function(){
            if (window.Lampa && Lampa.Listener) {
                clearInterval(ri);
                Lampa.Listener.follow('app', function(e){ if (e.type === 'ready') startPlugin(); });
                setTimeout(startPlugin, 1000);
            }
        }, 300);
    }
})();
