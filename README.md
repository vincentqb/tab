# Tab Organizer

A Firefox add-on that opens a full-page tab manager in its own tab. See every
open tab across every window, regroup them by window, site, purpose or topic,
drag tabs between windows, remove duplicates, save the arrangement to a file, and
**apply** it back to the browser.

![Purpose view](test/screenshots/03-smart.png)

## Why it's an add-on, not just a webpage

A normal web page can't read or move your browser tabs — only a WebExtension can
(`browser.tabs` / `browser.windows`). So this is a small Firefox add-on whose UI
_is_ a webpage: click the toolbar button and it opens the manager in a regular
tab.

## Install (temporary — no signing needed)

Temporary add-ons load instantly and stay until you restart Firefox.

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select the `manifest.json` file in this folder.
4. A **Tab Organizer** button appears in the toolbar. Click it to open the
   manager.

To reload after editing the code, click **Reload** next to the add-on on that
same `about:debugging` page.

### Install permanently (optional)

Temporary add-ons vanish on restart. To keep it:

- **Firefox Developer Edition / Nightly / ESR:** set
  `xpinstall.signatures.required` to `false` in `about:config`, then zip this
  folder's _contents_ (not the folder itself), rename the `.zip` to `.xpi`, and
  install via `about:addons` → gear → _Install Add-on From File_. Release Firefox
  refuses unsigned add-ons regardless of this setting.
- **Any Firefox:** submit the packaged add-on to
  [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing.

## Using it

**Views.** Each button regroups the same tabs; nothing moves in the browser until
you click _Apply layout_.

| View    | Grouping                                                                                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current | Your windows as they are right now. Applying it is a no-op                                                                                                                                                                                     |
| Domain  | One column per site, subdomains folded together (`mail.` + `docs.google.com`)                                                                                                                                                                  |
| Purpose | Named buckets by what a tab is for — Work, Communication, Docs & Writing, Reading, Reference, Media, Social, Search. Gmail, Slack and Outlook land in one column even though they share no words. Sites outside the list fall through to Topic |
| Topic   | Clusters tabs whose titles and URLs share words, so a rust doc, a rust Stack Overflow answer and a rust video group across sites. Labels and cluster count depend on what you have open                                                        |

Purpose reads a list of ~50 host patterns in `src/logic.js`; Topic computes word
overlap (Jaccard ≥ 0.26) and merges the closest pair until nothing else matches.
Both run locally — no network, no model.

**Each tab** shows favicon, title, and host. Double-click a card to jump to that
tab; the `×` closes it.

**Visual** adds a page thumbnail to each card. Everything on screen is captured
first, then the queue fills to 100 tabs whether or not they're visible; past that
the rest load as you scroll. Three captures run at a time so a hundred-tab board
stays responsive. Firefox blocks capture on `about:` and add-on pages, so those
cards keep the favicon, and the banner says how many it got. The toggle asks for
content-access permission only when you turn it on, so a default install stays
minimal-permission.

**Remove duplicates** finds tabs with the same URL — ignoring `www.`, trailing
slashes, fragments, and tracking params like `utm_*` — keeps the leftmost of each
set and closes the rest. Duplicates are flagged with a red edge before you click.

**Drag** a card into another column to regroup it, or within a column to reorder
it. Drag a column header to move the whole column; that rearranges the board
only and never touches your tabs.

**Save** writes the current grouping to a JSON file, one group per column.
**Import** reads that file back and opens each group as a new window, leaving
your existing windows alone. Import keeps `http(s)` URLs only — Firefox won't let
an add-on reopen `about:` or `file:` pages. Imported duplicates are yours to
clear with **Remove duplicates**.

**Apply layout** turns the columns into real Firefox windows. A column reuses the
window that already holds most of its tabs, so the Current view applies as a
no-op; leftover columns take the remaining windows, then spill into new ones. The
window count follows the column count — Firefox closes a window when its last tab
moves out, so grouping 4 windows into 2 columns leaves you with 2 windows.

## Development

```sh
npm test        # unit tests for the pure logic
npm run test:ui # optional: drives the real UI in a headless browser
```

All organization logic lives in `src/logic.js` as pure, browser-free functions,
so it's unit-tested directly under `node --test`. The UI (`src/manager.js`) is
the only part that touches the WebExtension APIs.

`npm run test:ui` builds `_harness.html` — the real page wired to a mocked
`browser` API seeded with 120 fake tabs — and drives it with Playwright to check
rendering, every view, dedupe, drag-and-drop, save, import, thumbnails, and
apply. It needs Playwright and a browser binary; skip it if you don't have them.

## Layout

```
manifest.json      add-on manifest (MV3, Firefox)
manager.html/css   the full-page UI
src/background.js   opens the manager when the toolbar button is clicked
src/manager.js      UI: rendering, drag/drop, actions, save/import, thumbnails
src/logic.js        pure logic: canonicalize, dedupe, views, intent, clustering, session, apply planner
test/               unit tests + the UI harness/driver
```

## Style

Clean, professional, minimal — card columns, one blue accent, red reserved for
destructive actions and duplicate flags. Colors live as CSS custom properties at
the top of `manager.css` and follow the system light/dark preference.
