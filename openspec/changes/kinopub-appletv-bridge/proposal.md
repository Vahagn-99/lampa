## Why

The customer (Лаврент, CUB 569452) uses two unrelated Lampa plugins: `appleTV.js` (Netflix-style UI that renders an episode list on series cards) and `z01.online/online.js` (source balancer with KinoPub available via Z01 Premium). Today, clicking an episode in the `appleTV.js` list triggers Lampa's default activity push and does **not** route the user into `lampac_z` with KinoPub preselected — so they have to manually navigate to the online component and pick KinoPub every time. We need a small bridge that intercepts the episode click and opens `lampac_z` with KinoPub as the default balancer, without forking either upstream plugin.

## What Changes

- Introduce a new standalone plugin `kinopub_appletv_bridge/kinopub-appletv-bridge.js` (single IIFE, ES5, no deps) that is loaded via Lampa *Settings → Extensions* alongside `appleTV.js` and `online.js`.
- On `app:ready`, the bridge waits for `window.Lampa` and for the `appleTV` + `lampac_z` plugins to be present, then installs an episode-click interceptor on the Netflix-style episode list rendered by `appleTV.js`.
- When a series episode is clicked, the bridge cancels the default activity push and instead calls `Lampa.Activity.push` with `component: 'lampac_z'`, passing the current card / TMDB id / season / episode, and ensures KinoPub is selected as the default balancer (via the Storage key `online_balanser` / the `lampac_z` component's default-balancer convention).
- Only activates for **series** cards — movies are ignored (the episode list doesn't exist for them in `appleTV.js`).
- Does **not** modify `appleTV.js` or `online.js`. Double-init guard via `window.__kinoPubAppleTvBridgeLoaded`.
- Hand-shipped minified sibling (`kinopub-appletv-bridge.min.js`) kept in sync, matching the repo's `skip-intro.js` / `skip-intro.min.js` convention.

## Capabilities

### New Capabilities
- `kinopub-appletv-bridge`: Intercepts episode clicks from the `appleTV.js` Netflix-style episode list and routes playback to the `lampac_z` component with KinoPub preselected as the default balancer, without modifying either upstream plugin.

### Modified Capabilities
<!-- None — no existing specs in openspec/specs/ to modify. -->

## Impact

- **New file**: `kino_pub/kinopub-appletv-bridge.js` (+ hand-shipped `kinopub-appletv-bridge.min.js`).
- **Runtime dependencies (external, not vendored)**: `appleTV.js` (tvigl.github.io) for the episode list DOM/selector and `online.js` (z01.online, Z01 Premium) for the `lampac_z` component and the KinoPub source. Both must be already installed in the target Lampa account; bridge is a no-op if either is missing.
- **No changes** to `series_auto_skip/skip-intro.js`, to `openspec/` tooling, or to any other part of the repo.
- **Third-party fragility**: upstream DOM changes in `appleTV.js` (selector drift) or API changes in `lampac_z` may break the interceptor; risk is explicitly accepted in the ТЗ (out-of-warranty rework).
- **No new build tooling**: plugin must stay ES5-compatible for smart-TV WebViews and remain a single self-contained file, matching the repo conventions in `CLAUDE.md`.
