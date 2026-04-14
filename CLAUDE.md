# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

Collection of standalone plugins for the **Lampa** media-center web app. Each plugin lives in its own top-level directory and is a single browser-side JavaScript file — there is **no package manager, no build system, no test runner, and no lint config** in this repo. Do not create one unless asked.

Current contents:

- `series_auto_skip/` — the `skip-intro.js` plugin (source) plus its hand-shipped `skip-intro.min.js`. The minified file is the distributable artifact; keep it in sync manually when editing the source.
- `kino_pub/` — only a Russian specification document (`ТЗ_KinoPub_appleTV_final.docx`) for a future tvOS/AppleTV KinoPub client. No code yet.
- `openspec/` — spec-driven change workflow (OpenSpec). `openspec/changes/archive/` holds historical changes; `openspec/specs/` is the live spec folder. `openspec/config.yaml` is intentionally mostly empty — fill `context:` there if the project grows a tech stack worth documenting globally.
- `.claude/skills/openspec-*` + `.claude/commands/opsx/*` — the OpenSpec workflow is wired up as Claude skills/commands. Prefer invoking them (e.g. `/opsx:propose`, `/opsx:apply`) for non-trivial changes rather than ad-hoc edits.
- `.claude/skills/lampa-plugin-development/` — **use this skill (`lampa-plugin-development`) whenever authoring or editing a Lampa plugin in this repo.** It contains the bootstrap/IIFE pattern, ES5-on-TV constraints, a `Lampa.*` API reference (see `api-reference.md`), settings/storage/player patterns, and a pointer map of the external plugin ecosystem. Read it before touching `skip-intro.js` or starting a new plugin.
- `.claude/skills/lampa-plugin-browser-testing/` — **use this skill (`lampa-plugin-browser-testing`) whenever verifying a plugin against a ТЗ / requirements checklist.** Drives the local Lampa dev server + Playwright MCP to produce a per-requirement PASS/FAIL report with evidence. Template at `verification-report-template.md`.
- `lampa-source/` — vendored copy of `yumata/lampa-source` (gitignored). Run `cd lampa-source && npm install` once, then `npm run start` → Lampa at `http://localhost:3000`. Used by the browser-testing skill; not shipped with the repo.

## Commands

There is nothing to build, lint, or test. Common operations:

- **Edit the plugin**: modify `series_auto_skip/skip-intro.js`.
- **Re-minify after editing** (no tooling committed — use whichever JS minifier is locally available, e.g. `npx terser skip-intro.js -c -m -o skip-intro.min.js`). The repo just needs both files to match; pick a minifier, don't add it as a dependency.
- **Load into Lampa for manual testing**: Lampa loads plugins by URL. Host the `.js` (or `.min.js`) on any static server (e.g. `python3 -m http.server`) and add it via Lampa's *Settings → Extensions* using the raw URL. There is no automated test harness — verification is manual in the Lampa player.

## skip-intro.js architecture

Single IIFE guarded by `window.__skipIntroLoaded`. It is organized into cooperating object modules inside the closure — treat them as separate concerns even though they share the file:

- **`Settings`** — registers the `skip_intro` settings component via `Lampa.SettingsApi`; reads flags through `Lampa.Storage.field(...)`. Add new user-facing toggles here.
- **`SmartSkipMemory`** — per-series+segment-type memory of "the user already confirmed skipping this once", persisted as a JSON blob under `skip_intro_smart` in `Lampa.Storage`. Drives the auto-countdown UX.
- **`Cache`** — `localStorage`-backed segment cache keyed by `(tmdb_id, season, episode)`, 7-day TTL (`CACHE_TTL`).
- **`ApiClient`** — fetches segment data with XHR + timeout. Primary source: **TheIntroDB** (`api.theintrodb.org/v2`, returns per-type arrays). Fallback: **IntroDB** (`api.introdb.app`, only `intro`+`credits`). `load()` implements: cache → TheIntroDB → IntroDB → `[]`. Keep this fallback order when editing; normalizers must output `{type, start, end}` objects in seconds.
- **`SkipButton`** — DOM UI; injects its CSS once (`skip-intro-css`), mounts into `.player` (or `body`), supports two modes: `showNormal(label, onSkip)` and `showCountdown(label, onSkip, onCancel)`. Handles keyboard (Enter/Space to skip, Backspace/Esc to cancel) for remote-control use. Don't leak instances — always pair create with `hide()`/`destroy()`.
- **`SegmentChecker.findActive`** — pure function matching current playback time to a segment.
- **`SkipIntroPlugin`** — orchestrator. Hooks:
  - `Lampa.Player.listener.follow('start')` → `_onPlayerStart`: extracts `tmdb_id/imdb_id/season/episode` via `_extractMeta` (card fields, `data.title` regex `SxxExx`, and playlist lookup), then loads segments.
  - `Lampa.PlayerVideo.listener.follow('timeupdate')` → `_onTimeUpdate`: finds an active segment; chooses normal vs countdown button based on `SmartSkipMemory.hasSkipped`; or auto-skips immediately if the global "always auto-skip" setting is on.
  - `Lampa.Player.listener.follow('destroy')` → cleanup.
- **Bootstrap** (bottom of file): polls for `window.Lampa` + `Lampa.Listener`, then starts on the `app:ready` event with a 1s safety fallback. Preserve this pattern — Lampa load order is not guaranteed.

### Editing rules specific to this plugin

- Only add a segment type by updating **both** `SEGMENT_TYPES`, `SEGMENT_LABELS`, the `Settings.init` registrations, and the normalizers in `ApiClient`.
- Any new user setting must default to a sane value and be read through `Lampa.Storage.field(...) !== false` (or `=== true`) to behave correctly on first run before the key exists.
- Keep the code ES5-compatible and avoid ES modules / arrow functions / `const`/`let` / template strings — Lampa runs on older WebViews (including smart-TV browsers). Existing code uses `var` and function expressions throughout; match that.
- Don't introduce new runtime dependencies. The plugin must remain a single self-contained file.
- The file logs with the `[SkipIntro]` prefix; keep that convention for new diagnostics.