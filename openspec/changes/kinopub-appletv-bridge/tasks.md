## 1. Environment reconnaissance

> Original plan was to run against the customer's CUB account and a booted `lampa-source` dev server. Because live credentials aren't available in this session, 1.1–1.4 are completed by **static analysis** of the upstream plugins and of `lampa-source/src`. Findings are consolidated in the top-of-file comment of `kino_pub/kinopub-appletv-bridge.js` and in `design.md` Decisions 1–3. Task 7.5 (install on the customer's device) is the real-environment validation step.

- [x] 1.1 Boot `lampa-source` locally and log into Lampa with customer credentials. → Substituted by reading `lampa-source/src/**` directly (already vendored under `./lampa-source`) and confirming `appleTV.js` / `z01/online.js` load paths from their URLs; live-env run deferred to task 7.5.
- [x] 1.2 Capture the DOM structure and click path of an appleTV episode row. → `lampa-source/src/interaction/episode/module/small.js` + `appleTV.js` Template override show `<div class="full-episode selector layer--visible">` with `.full-episode__num` text; remote-control Enter path is `Utils.trigger(elem, 'hover:enter')` per `lampa-source/src/core/controller.js:94-100` (NOT native click). Episode rows carry **no** `data-season` / `data-episode` attributes — metadata lives on the Callback closure only.
- [x] 1.3 Identify the z01 balancer storage key and KinoPub identifier. → `online_balanser` (global) + `online_last_balanser[movie.id]` (per-series cache); KinoPub id = `'kinopub'` (lowercased first word of `balanserName()`); `lampac_z` reads `object.balanser` from the push with higher priority than either storage key.
- [x] 1.4 Record a stable marker for "appleTV.js is loaded". → `$('body').addClass('applecation')` AND `<style data-id="applecation_css">`. Either suffices; the plugin checks both for resilience.

## 2. Plugin skeleton (`kino_pub/kinopub-appletv-bridge.js`)

- [x] 2.1 Create `kino_pub/kinopub-appletv-bridge.js` as a single IIFE guarded by `window.__kinoPubAppleTvBridgeLoaded`; on repeat load, return early without re-wrapping.
- [x] 2.2 Implement a bootstrap block that polls for `window.Lampa` + `Lampa.Listener` (short interval, bounded retries), then runs init on the `app:ready` event with a ~1 s safety-fallback `setTimeout` — match the pattern at the bottom of `series_auto_skip/skip-intro.js`.
- [x] 2.3 Add a top-of-file block comment documenting: purpose, upstream plugins & URLs, the applecation markers, the z01 balancer keys and the KinoPub id, the intercepted Lampa-core APIs, and the `[KinoPubBridge]` log prefix.
- [x] 2.4 Centralize logging through a small `log(...)` helper that always prefixes `[KinoPubBridge]`.

## 3. Feature detection and init gating

- [x] 3.1 Implement `isAppleTvLoaded()` → true if `$('body').hasClass('applecation')` OR `document.querySelector('style[data-id="applecation_css"]')`. On negative result, log `[KinoPubBridge] disabled: appleTV not detected` and skip wrap install.
- [x] 3.2 Implement `isLampacZRegistered()` by probing `Lampa.Component` (support whichever accessor the current Lampa exposes: `Lampa.Component.get`, or iterating a `_components` / registry map). On negative result, log `[KinoPubBridge] disabled: lampac_z not registered` and skip wrap install.
- [x] 3.3 Poll `isLampacZRegistered()` on a bounded retry schedule (e.g., 10× at 500ms) after `app:ready`, since `online.js` may load later than this bridge. If still absent after the budget, log disabled and exit.

## 4. Wrap `Lampa.Activity.push` and `Lampa.Player.play`

- [x] 4.1 Capture originals once: `origPush = Lampa.Activity.push; origPlay = Lampa.Player.play;` — both stored in module-scoped `var`s so the wrapper has a stable reference regardless of who else wraps later.
- [x] 4.2 Implement `shouldIntercept(obj)` predicate returning `true` only when ALL guards pass: body has `.applecation`; `Lampa.Activity.active()` component is `'full'`; card is a series (`card.name` OR `card.number_of_seasons > 0`); `obj.component !== 'lampac_z'`; season + episode derivable from `obj` / `obj.movie` / `obj.card`.
- [x] 4.3 Implement `rewriteForKinoPub(obj)` that returns a new object with `component: 'lampac_z'`, `movie`, `card`, `search` (title/name), `season`, `episode`, `balanser: 'kinopub'`, `source: 'kinopub'`, and preserves `url: ''`, `title`. Does not mutate `obj`.
- [x] 4.4 Replace `Lampa.Activity.push` with a wrapper that: wraps the guards in `try/catch`; on thrown error, logs + falls through to `origPush.apply(Lampa.Activity, arguments)`; on `shouldIntercept` true, calls `origPush.call(Lampa.Activity, rewriteForKinoPub(obj))`; otherwise passes through.
- [x] 4.5 Replace `Lampa.Player.play` with an analogous wrapper. When it triggers, push `lampac_z` via the saved `origPush` (with the rewritten object) INSTEAD of starting the player directly — letting `lampac_z` resolve the actual stream via its KinoPub balancer.
- [x] 4.6 Log each intercept event once at `console.log` level with the relevant `{season, episode, source_component}` — handy for customer diagnostics without spamming.

## 5. Resilience and edge cases

- [x] 5.1 Guard against double-install: `window.__kinoPubAppleTvBridgeLoaded` flag set BEFORE any wrap; early-return on second IIFE execution. Additionally, in the wrapper creation step, check `origPush.__kinopub_wrapped` to avoid re-wrap if some other plugin shares our hot path.
- [x] 5.2 Wrapper error isolation: every wrapper body wrapped in `try/catch`; no exception from the wrapper may propagate. Always fall through to the saved original on any anomaly.
- [x] 5.3 Confirm pass-through behavior for: non-series cards, calls from settings/search/main-menu, `lampac_z` already targeted, calls from environments without `.applecation` (appleTV settings off or other UI plugin).
- [x] 5.4 Confirm no mutation of `Lampa.Storage` keys `online_balanser` or `online_last_balanser` — grep the source for those keys post-edit to verify.

## 6. Packaging and hand-off

- [x] 6.1 Produce `kino_pub/kinopub-appletv-bridge.min.js` with a locally-available minifier (e.g. `npx terser kinopub-appletv-bridge.js -c -m -o kinopub-appletv-bridge.min.js`); do not commit the minifier as a dependency.
- [x] 6.2 Verify the source file has no `let` / `const` / arrow functions / template literals / `class` / ES modules (grep check); fix any that slipped in.
- [x] 6.3 Write a short install note (top of source file, or `kino_pub/README.md` if the customer needs it): host the `.min.js` on any static server, add the URL via Lampa *Settings → Extensions*; requires `appleTV.js`, `z01/online.js`, and Z01 Premium with KinoPub.
- [ ] 6.4 Manual acceptance run via the `lampa-plugin-browser-testing` skill: for each requirement in `specs/kinopub-appletv-bridge/spec.md`, record a PASS/FAIL with evidence (console log + DOM snapshot / screenshot).
- [ ] 6.5 Install the plugin on the customer's CUB account, reproduce the golden path on their device, collect a short demo capture if possible, and confirm acceptance.
