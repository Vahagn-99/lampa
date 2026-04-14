## ADDED Requirements

### Requirement: Plugin bootstrap and environment detection

The bridge plugin SHALL initialize inside a single IIFE guarded by `window.__kinoPubAppleTvBridgeLoaded`, poll for `window.Lampa` and `Lampa.Listener`, and complete initialization on the Lampa `app:ready` event with a safety fallback timer of at least one second. Before installing any interceptor, it SHALL feature-detect the presence of the `lampac_z` component (via `Lampa.Component`) and the presence of `appleTV.js` (via the `applecation` body class or the `applecation_css` style tag). If either dependency is absent, the bridge SHALL log a single diagnostic line prefixed with `[KinoPubBridge]` and install no wrappers.

#### Scenario: Loaded in a compatible environment
- **WHEN** `appleTV.js`, `z01/online.js` (Z01 Premium), and the bridge plugin are all loaded into a Lampa instance
- **THEN** after `app:ready` the bridge replaces `Lampa.Activity.push` and `Lampa.Player.play` with its wrappers (preserving references to the originals) and logs an initialization line prefixed with `[KinoPubBridge]`

#### Scenario: Loaded without the source plugin
- **WHEN** the `lampac_z` component is not registered in `Lampa.Component`
- **THEN** the bridge MUST NOT wrap any Lampa-core API and MUST log `[KinoPubBridge] disabled: lampac_z not registered` exactly once

#### Scenario: Loaded without the UI plugin
- **WHEN** `appleTV.js` has not been loaded (no marker detected)
- **THEN** the bridge MUST NOT wrap any Lampa-core API and MUST log `[KinoPubBridge] disabled: appleTV not detected` exactly once

#### Scenario: Loaded twice
- **WHEN** the bridge script is injected into Lampa twice within the same session
- **THEN** the second execution MUST exit immediately without re-wrapping Lampa core, and `window.__kinoPubAppleTvBridgeLoaded` MUST remain `true`

### Requirement: Intercept episode playback by wrapping Lampa-core entry points

The bridge SHALL wrap `Lampa.Activity.push` and `Lampa.Player.play` (preserving references to the originals) so that both user inputs — mouse clicks AND TV-remote Enter presses (which fire `hover:enter` jQuery events, not native `click`) — are covered uniformly. Each wrapper SHALL inspect the call's argument object and the current UI state; it MUST rewrite the call target to `lampac_z` with KinoPub preselected ONLY when all of the following are true: (1) the DOM body carries the `applecation` class (confirming `appleTV.js` is active); (2) `Lampa.Activity.active().component === 'full'` (the call originates from a full card); (3) the active card represents a TV series (has `name` set, or `number_of_seasons > 0`); (4) the call's argument carries `season` + `episode` (directly or via `argument.movie` / `argument.card`); (5) the target `component` is not already `lampac_z`. When any guard fails, the wrapper MUST call the saved original with the unmodified arguments and MUST NOT alter control flow. Any exception inside the wrapper MUST be caught and result in a fall-through to the saved original.

#### Scenario: Series episode triggered via TV remote
- **WHEN** the user presses Enter on an episode row inside a series card rendered by `appleTV.js` (which fires `hover:enter` and ends in a `Lampa.Activity.push` or `Lampa.Player.play` call)
- **THEN** the bridge rewrites the call target to `component: 'lampac_z'` with KinoPub preselected for the same series with the same season and episode

#### Scenario: Series episode triggered via mouse click
- **WHEN** the user clicks an episode row with a mouse inside a series card rendered by `appleTV.js`
- **THEN** the bridge rewrites the call target identically to the remote-Enter scenario

#### Scenario: Call from a movie card
- **WHEN** `Lampa.Activity.push` or `Lampa.Player.play` is invoked from a full card whose content is a movie (no season/episode metadata)
- **THEN** the bridge MUST NOT rewrite the call and the saved original MUST be invoked with the original arguments

#### Scenario: Call from outside a full card
- **WHEN** `Lampa.Activity.push` or `Lampa.Player.play` is invoked while the active activity is not `component: 'full'` (e.g., from search results, settings, main menu)
- **THEN** the bridge MUST NOT rewrite the call and the saved original MUST be invoked with the original arguments

#### Scenario: Call without appleTV.js active
- **WHEN** `Lampa.Activity.push` or `Lampa.Player.play` is invoked while the DOM body does NOT carry the `applecation` class
- **THEN** the bridge MUST NOT rewrite the call and the saved original MUST be invoked with the original arguments

#### Scenario: Call already targeting lampac_z
- **WHEN** the call's argument object already has `component: 'lampac_z'`
- **THEN** the bridge MUST NOT rewrite the call (preventing re-entrancy loops) and the saved original MUST be invoked with the original arguments

#### Scenario: Exception inside the wrapper
- **WHEN** the wrapper's guard logic throws for any reason
- **THEN** the bridge MUST catch the error, log it with the `[KinoPubBridge]` prefix, and invoke the saved original with the original arguments unchanged

### Requirement: Open lampac_z with KinoPub preselected as the default balancer

When the interceptor activates, the bridge SHALL call the saved original `Lampa.Activity.push` with a rewritten argument object targeting `component: 'lampac_z'` and carrying `balanser: 'kinopub'` and `source: 'kinopub'` (both keys, for compatibility across z01 builds). The rewritten object SHALL include `movie` (the card object) and preserve `season`, `episode`, and any TMDB id / IMDb id / title resolved from the original call. The bridge MUST NOT mutate `Lampa.Storage` keys such as `online_balanser` or `online_last_balanser`; preselection MUST rely solely on z01's documented precedence of `object.balanser > online_last_balanser[movie.id] > online_balanser > first source`.

#### Scenario: Rewritten push reaches lampac_z with kinopub preselected
- **WHEN** a wrapper activates on a series episode from an `appleTV.js` full card
- **THEN** the bridge invokes the saved original `Lampa.Activity.push` with an object of the form `{ url: '', title, component: 'lampac_z', movie: card, card: card, search: <title>, season: n, episode: m, balanser: 'kinopub', source: 'kinopub' }`, and the resulting `lampac_z` activity shows KinoPub as the selected balancer

#### Scenario: User's global default balancer is untouched
- **WHEN** the user had a non-KinoPub default balancer (e.g. `filmix`) before the interceptor fired
- **THEN** the value of `Lampa.Storage.get('online_balanser')` remains `filmix` during and after the intercepted push — the bridge MUST NOT read or write this storage key

#### Scenario: User's per-series cache is untouched
- **WHEN** the user previously picked a non-KinoPub balancer inside `lampac_z` for this series (so `online_last_balanser[card.id]` is set to that balancer)
- **THEN** the bridge MUST NOT mutate `online_last_balanser`; z01's push-param precedence ensures KinoPub is used for this bridge-initiated activity regardless of the cached value

#### Scenario: Missing season/episode on the call arguments
- **WHEN** a wrapper fires but the call's argument object has neither `season`/`episode` nor derivable values from `argument.movie` / `argument.card`
- **THEN** the bridge MUST NOT rewrite the call; the saved original MUST be invoked with the original arguments and a single diagnostic line MUST be logged with the `[KinoPubBridge]` prefix

### Requirement: Self-contained single-file ES5 plugin, following repo conventions

The plugin SHALL be delivered as a single self-contained browser JavaScript file compatible with older WebViews (no `let`/`const`/arrow functions/template literals/`class`/ES modules), with no runtime dependencies beyond `window.Lampa`, and SHALL be accompanied by a hand-shipped minified sibling kept in lock-step with the source. All diagnostic logging SHALL be prefixed with `[KinoPubBridge]`. The plugin MUST NOT modify `appleTV.js` or `online.js` at runtime (no function patching, no re-binding of their internals).

#### Scenario: ES5 compatibility
- **WHEN** the source file is inspected
- **THEN** it contains no `let`, `const`, arrow functions, template literals, `class` declarations, or ES module syntax

#### Scenario: Minified mirror kept in sync
- **WHEN** the plugin source `kinopub-appletv-bridge.js` is edited
- **THEN** the sibling `kinopub-appletv-bridge.min.js` is regenerated so both files represent the same logical build

#### Scenario: Diagnostic logging prefix
- **WHEN** the plugin emits any `console.log` / `console.warn` / `console.error`
- **THEN** the message begins with the literal prefix `[KinoPubBridge]`

#### Scenario: No runtime modification of upstream plugins
- **WHEN** the plugin is loaded alongside `appleTV.js` and `online.js`
- **THEN** it MUST NOT reassign, wrap, or mutate any function, object, or property belonging to those plugins (only reads from and dispatches against `window.Lampa` public APIs)
