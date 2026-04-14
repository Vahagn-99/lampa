## Context

Lampa plugins are browser-side IIFE scripts that attach to `window.Lampa`. Two upstream plugins are already in use on the customer's account (CUB 569452):

- **`appleTV.js`** (https://tvigl.github.io/plugins/appleTV.js) — renders Netflix-style card layouts and, on series cards, injects an episode list below the card when the user scrolls down. Clicking an episode triggers a standard Lampa `Activity.push` from a list item identified by a selector class. The plugin is closed for us — we cannot fork, only observe behavior through its DOM and through `Lampa.Listener` events.
- **`z01.online/online.js`** (Z01 Premium) — registers the `lampac_z` activity component. In premium mode, the balancer list exposed at `/lite/events` includes a **KinoPub** source backed by `kinopub.me`. The client UI (quality/voice picker, RCH, cache) is already complete; the balancer is selected by a stored default.

This repo's existing plugin (`series_auto_skip/skip-intro.js`) establishes the house pattern: single self-contained IIFE, ES5-only syntax (smart-TV WebViews), `window.__…Loaded` guard, bootstrap that polls for `window.Lampa` then hooks `app:ready`. The new bridge must follow the same shape — there is no package manager, build system, or test runner in the repo and we are not adding one (`CLAUDE.md`).

Target users: a single customer account; manual acceptance testing in the Lampa player. Budget is fixed ($100), timeline 1–2 working days. Any upstream API/DOM drift is explicitly treated as out-of-warranty rework.

## Goals / Non-Goals

**Goals:**
- When a **series episode** is clicked inside the `appleTV.js` Netflix-style list, open `lampac_z` with KinoPub preselected as the balancer.
- Leave movies and all non-episode interactions untouched.
- Do not modify, fork, or rebundle `appleTV.js` or `online.js` — the bridge is a third, standalone file loaded alongside them.
- Preserve the user's previous `online_balanser` preference: pre-selection of KinoPub must not permanently rewrite their default.
- Be a no-op if either upstream plugin is missing, and if `lampac_z` has been loaded without Z01 Premium / without KinoPub in its balancer list — in those cases fall back to the default (un-intercepted) behavior instead of breaking navigation.
- Stay within repo conventions: single IIFE file + hand-shipped `.min.js`, ES5, `[KinoPubBridge]` log prefix, `window.__kinoPubAppleTvBridgeLoaded` guard.

**Non-Goals:**
- Writing a new KinoPub API client. KinoPub comes from z01 premium; we only **select** it, we don't call it.
- Changing movie playback, subtitles, codec negotiation, or any balancer other than KinoPub.
- Building a settings UI. The customer wants KinoPub always-default for episode clicks; exposing toggles is out of scope (can be added later).
- Supporting Lampa platforms without `appleTV.js` or without `lampac_z` — those configurations are silently skipped.
- Guaranteed compatibility with future `appleTV.js` / `online.js` versions — explicitly listed as a risk in the ТЗ.

## Decisions

### Decision 1: Interception by wrapping `Lampa.Activity.push` and `Lampa.Player.play` (Lampa-core APIs)

At init, the bridge saves references to `Lampa.Activity.push` and `Lampa.Player.play`, then replaces them with wrappers. Each wrapper inspects the call arguments and the current UI state; when **all** guards pass, it rewrites the call target to `lampac_z` with KinoPub preselected, otherwise it falls through to the saved original.

Guards (positive — any mismatch passes through unchanged):
- `$('body').hasClass('applecation')` — confirms `appleTV.js` is active.
- `Lampa.Activity.active().component === 'full'` — we're invoked from a full card, not from elsewhere in the app.
- The active card represents a TV series (`card.name` set, or `card.number_of_seasons > 0`).
- The push/play call carries `season` + `episode` (directly or derivable from `object.movie`).
- The target `component` is not already `lampac_z` (avoid re-entrancy).

**Why over DOM event delegation:** `lampa-source/src/core/controller.js` fires remote-control Enter via `Utils.trigger(elem, 'hover:enter')` — a jQuery custom event, NOT a native `click`. A document-level `click` listener (even in capture phase) would miss every TV-remote interaction, which is the customer's primary input method. Wrapping Lampa-core APIs works uniformly for mouse, touch, and remote because all three input paths converge on `Activity.push` / `Player.play`.

**Alternatives considered:**
- DOM capture-phase `click` listener — rejected; doesn't fire for TV remotes (only mouse).
- jQuery delegated `hover:enter` listener — rejected; fires AFTER the Callback module's direct handler that already emits `'enter'` and triggers the default push/play. `stopImmediatePropagation` is too late at that point.
- `Lampa.Listener.follow('activity', 'push')` — rejected; fires *after* the push has been applied (reactive, not preventive), which produces a visible flash of the wrong activity.
- Patching `appleTV.js` / `online.js` internals — rejected; the ТЗ forbids it and their internals are not a stable API.

The spec's "MUST NOT modify `appleTV.js` or `online.js` at runtime" constraint is preserved: we wrap **Lampa-core** APIs (`Activity.push`, `Player.play`), not upstream plugin APIs.

### Decision 2: Preselect KinoPub by passing `balanser: 'kinopub'` in the push object (no Storage mutation)

Reconnaissance of `online.js` confirmed the balancer-selection precedence inside `lampac_z`:

1. `object.balanser` from the `Activity.push` argument — highest priority,
2. `online_last_balanser[movie.id]` — per-series cache (filled when the user picks a balancer manually),
3. `online_balanser` — global default,
4. first source in the balancer list.

Because (1) beats everything, the bridge can preselect KinoPub by simply including `balanser: 'kinopub'` (also `source: 'kinopub'` as an alias for older/newer z01 builds) in the rewritten push object. No `Lampa.Storage` snapshot, no restore-on-activity-start listener, no 5-second timeout.

**Why:** mutating `online_balanser` would override the user's **global** default — meaning every other online lookup initiated outside the bridge (from the main full-card "Watch online" button, from another plugin, etc.) would also start on KinoPub until the snapshot is restored. That is a real side-effect surface area. Passing the push param keeps the override scoped to the single `lampac_z` activity that the bridge itself opens, leaving the user's prefs untouched.

**Alternatives considered:**
- Snapshot & restore `online_balanser` — rejected; side-effects global state, needs lifecycle tracking.
- Permanently set `online_balanser = 'kinopub'` — rejected; overrides the user's global choice.
- Mutate `online_last_balanser[movie.id]` — rejected; overrides the user's per-series cache silently.

### Decision 3: Resolve episode metadata from the push-object arguments plus `Lampa.Activity.active()`

Reconnaissance established that `appleTV.js` does **not** add `data-season` / `data-episode` attributes to the episode row. It reuses Lampa's own `full_episode` template (re-registered with extra CSS), so episode metadata lives only on the jQuery `Callback` closure inside Lampa core — unreachable from outside.

Since Decision 1 intercepts at the `Activity.push` / `Player.play` layer (not at the DOM click), we receive the data through the call arguments themselves: Lampa core has already assembled a push object with `season`, `episode`, and `card` / `movie` by the time the wrapper fires. The bridge reads:

- `season`, `episode` — directly from the push/play object argument (`obj.season`, `obj.episode`);
- `card` / `movie` — from `obj.card || obj.movie || Lampa.Activity.active().card`;
- TMDB id / IMDb id / title — from the resolved card.

If `season` + `episode` are absent on the push object but present on `obj.movie` / `obj.card` (different z01/Lampa builds shape the object differently), the bridge looks them up there as fallback. If both sources come up empty, the wrapper falls through to the original (no intercept) — we never fabricate metadata.

### Decision 4: Guard rails — feature-detect before intercepting

On `app:ready`, the bridge checks that (a) `window.Lampa` is ready, (b) some evidence of `appleTV.js` being loaded (e.g., a style tag it injects, or a globally exposed symbol), and (c) `Lampa.Component` registry contains `lampac_z`. If any check fails, the bridge logs a single `[KinoPubBridge] disabled: <reason>` line and installs no listener. This prevents the bridge from eating clicks in environments where its target isn't installed.

### Decision 5: Ship as two files (`kinopub-appletv-bridge.js` + `.min.js`) under `kino_pub/`

Matches the `skip-intro.js` + `skip-intro.min.js` convention already in the repo. Minification is done ad-hoc with a locally available minifier (e.g. `npx terser`) per `CLAUDE.md`; no minifier is added as a committed dependency. Source is authoritative; min file is a hand-shipped mirror.

## Risks / Trade-offs

- **[Lampa-core API shape drift on `Activity.push` / `Player.play`]** → if a future Lampa version renames or restructures these entry points, our wrapper stops firing or sees an unfamiliar arg shape. **Mitigation:** feature-detect at init that both are plain functions; wrap defensively (`try/catch` around every guard); on thrown error inside the wrapper, always fall through to the saved original (bias toward not breaking navigation).
- **[`appleTV.js` marker changes]** → if upstream stops adding `body.applecation` or renames `style[data-id="applecation_css"]`, the bridge silently disables itself. **Mitigation:** check BOTH markers (either is sufficient) and log the disabled reason on init; documented in the top-of-file comment so the resolver is greppable.
- **[Double installation via two Extensions entries]** → `window.__kinoPubAppleTvBridgeLoaded` guard at IIFE entry; no-op on second load. Because we capture originals BEFORE wrapping and the guard returns early on re-load, the originals are not double-wrapped.
- **[Race on `app:ready` before `lampac_z` is registered]** → `lampac_z` is registered by `online.js` which may load at any point. The bootstrap polls `Lampa.Component.registry` (or equivalent) until `lampac_z` appears, up to a bounded retry count; if it never arrives, the bridge logs disabled and installs no wrappers.
- **[Over-intercepting the main "Watch online" button]** → the full card's top-level "Watch online" also goes through `Activity.push` from the same `full` component. Currently we intercept it too (same target, same desired result: KinoPub first). If the customer wants to keep the default `online_balanser` for that button, we add an extra guard that only triggers when the focused element is a `.full-episode` (tracked via a `hover:focus` delegate that records `lastFocusedEpisode`). Initially we leave this out; the default behavior of always preferring KinoPub is the ТЗ goal anyway.
- **[Customer environment: no Z01 Premium / KinoPub disappears]** → the init feature-detect checks for `lampac_z` but cannot check for KinoPub availability synchronously; if `lampac_z` opens and KinoPub is missing from its balancer list, z01 falls back to the next balancer per its own precedence — acceptable per ТЗ section 8.
- **[Multiple plugins wrapping the same API]** → if another plugin also wraps `Activity.push`, the order of wrapping matters. Because our wrapper always calls the captured original on any non-match, we remain composable: we only transform our narrow slice (series-episode pushes in appleTV context) and delegate otherwise.
