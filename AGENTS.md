# AGENTS

A Firefox WebExtension (Manifest V3). Its UI is a full-page tab manager opened in
a normal tab. Active plan: `PLAN.md` — read it first; it's the living spec.

## Build / run

No bundler, no dependencies. Load unpacked: `about:debugging#/runtime/this-firefox`
→ **Load Temporary Add-on** → pick `manifest.json`. Reload from that page after
edits. See `README.md` for install and usage.

## Test

- `npm test` — unit tests for the pure logic (`node --test test/logic.test.js`).
- `npm run test:ui` — drives the real UI headless via Playwright. Needs
  Playwright plus a browser binary; point `PW_MODULE` at an installed
  `playwright/index.mjs` if it isn't resolvable locally. Regenerate the harness
  after UI edits: `npm run harness`.

Run `npm test` before declaring any logic change done.

## Lint / format

`uvx pre-commit install` once per clone. Everything runs at commit, `npm test`
included — measured 1.2s for the whole gate, of which the tests are 150ms, so
there's no stage worth splitting. Prettier is the only formatter and owns
js/css/html/json/md — don't add a second one. Hooks that rewrite files fail the
first commit by design; re-stage and commit again. Fix the underlying issue rather
than passing `--no-verify`; to skip one hook for one commit, use
`SKIP=<hook-id> git commit`.

`npm run test:ui` is deliberately **not** in the gate: it needs Playwright plus a
browser binary and takes ~40s. Run it yourself before calling a UI change done.

## Conventions (look wrong, are intentional)

- **The pure/UI split is the core invariant.** All tab-organization logic lives in
  `src/logic.js` as browser-free pure functions (no `browser.*`), so it's
  unit-testable under Node. `browser.*` calls appear **only** in `src/manager.js`
  and `src/background.js`. Keep new logic pure and in `logic.js`; keep DOM and API
  glue in `manager.js`. Don't import `logic.js` into the background script.
- Views return a uniform shape: `[{ label, tabs, windowId? }]`. `windowId` is set
  only by `groupByWindow`, which is what lets Apply treat that view as a no-op.
- **Two grouping inputs, not three.** Domain reads the host; Title reads the page
  title plus the URL path. Title matches on both but labels only from the title,
  because path words are machine slugs (`acme`, `billing`, `watch`) — a column
  named from a slug reads as noise. Path was once its own view and earned removal:
  its labels were unreadable and it duplicated what Title already covered.
- `clusterByTokens` seeds groups per domain before merging, which is what keeps it
  O(domains²) — per-tab seeding measured 7.2s at 1000 tabs, versus ~5ms seeded.
- Never label a column from the host: the view would impersonate Domain whenever a
  cluster happens to be single-site.
- Column drag reorders `state.columns` only — board sugar that must never issue a
  `browser.*` call. Card drag is the one that changes what Apply will do.
- Search filters in `rebuildColumns`, so a hidden tab leaves the model and Dedupe,
  Save and Apply all act on exactly what's on screen.
- `state.searches` accumulates: each Enter appends a query, and `groupBySearches`
  gives each its own column in order, consuming tabs as it goes so an earlier
  search always keeps them. The live query filters only the ungrouped remainder,
  which is why switching view or typing again never disturbs a banked group.
- Fuzzy matching is deliberately constrained on two axes, and loosening either
  brings back a measured false positive: subsequence hits must land within 1.5x
  the query length (else `cart` matches "AsyncRusTbook"), and one-edit hits must
  start at a word boundary (else `kube` matches "you**tube**"). Both are tested.
- Thumbnail priority comes from a live `IntersectionObserver`, never a one-shot
  `getBoundingClientRect` sweep: a card grows ~4x taller once it has a thumbnail,
  so any single measurement prioritizes a layout the thumbnails then invalidate.
  `EAGER_LIMIT` caps stored thumbnails, not attempts.
- A capture timeout is **not** a verdict. Firefox renders a discarded tab before
  capturing it, so a slow first attempt says nothing; only a rejection from
  Firefox is final. Timeouts escalate (`CAPTURE_TIMEOUT_MS`) and retries use their
  own queue that bypasses `EAGER_LIMIT` — counting stored thumbnails would
  otherwise strand every retry once the cap was reached.
- Per-card reload replaces one card, never `rebuildColumns`: a redirect can change
  the URL and so the grouping, and regrouping under the cursor would discard the
  arrangement being built. The fresh node must be re-`observe`d or it drops out of
  the thumbnail queue, and the recapture goes on `retryQueue` so `EAGER_LIMIT`
  can't leave a reloaded card permanently blank.
- `tabs.reload` resolves before the page has loaded, so the new title, favicon and
  URL don't exist yet; `settledTab` polls `status` out of `loading` first. Reading
  the tab any earlier just re-renders the stale card.
- `reportThumbProgress` won't overwrite an error banner. Progress keeps arriving
  for as long as the board is open, so it otherwise erases every failure before
  it's read.
- Saved sessions carry `{ version, groups: [{ label, tabs: [{ url, title }] }] }`
  and no browser ids; ids mean nothing in a later session. `parseSession` accepts
  looser shapes so a hand-edited file still imports, and keeps `http(s)` only.
- Plain ES modules loaded by the browser — no transpile step. `import` works from
  `moz-extension://` but **not** `file://` (opaque origin); the UI driver serves
  over `http://` for that reason.

## Style

Clean, professional, minimal: bordered card columns on a light-grey board, one
blue accent (`--accent`), red (`--danger`) reserved for destructive/duplicate
signals. All colors go through the CSS custom properties at the top of
`manager.css`, which carry a `prefers-color-scheme: dark` override — add a token
there rather than hard-coding a hex in a rule.

## Don't touch

- `_harness.html` is generated by `test/make_harness.mjs` (gitignored). Never edit
  it by hand or commit it.
- Permissions in `manifest.json` are deliberately minimal (`tabs` only);
  `<all_urls>` is _optional_ and requested at runtime when Visual mode is enabled.
  Don't promote it to a required permission.

## Standing preferences

- **Minimal code.** Smallest change that works; reuse before adding. No new
  dependency, abstraction, or build step without surfacing it first. This add-on
  is intentionally dependency-free.
- **Commit regularly, straight to `main`.** Personal repo — no branch-per-change,
  no hedging. Commit each verified unit (green `npm test`).
- **Verify by driving, not asserting.** A UI change isn't done until it's
  exercised in a browser (the Playwright driver, or a manual load). "Tests pass"
  ≠ "the feature works."
- **Surgical edits.** Touch only what the task needs; match local style; flag
  pre-existing dead code rather than delete it.
- **No comments.** Names and tests carry the meaning. Reach for a clearer name or
  a smaller function instead of a comment; never narrate an edit.
- **README is instructions, not a pitch.** Terse: how to install, what each
  control does, how to run the tests. No feature-selling, no rationale, no
  explaining the algorithms — that belongs here in `AGENTS.md`.
- Honest, direct, calibrated — say what was verified vs. assumed. Not sycophantic.
