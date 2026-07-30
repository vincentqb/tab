# Tab Organizer

A Firefox add-on that opens a full-page tab manager in its own tab.

![Purpose view](test/screenshots/03-purpose.png)

## Install

Temporary add-ons load instantly and stay until you restart Firefox.

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` in this folder.
4. Click the **Tab Organizer** toolbar button to open the manager.

After editing the code, click **Reload** next to the add-on on that same page.

To keep it across restarts on Developer Edition, Nightly, or ESR: set
`xpinstall.signatures.required` to `false` in `about:config`, zip this folder's
_contents_, rename the `.zip` to `.xpi`, and install it from `about:addons` →
gear → _Install Add-on From File_. Release Firefox refuses unsigned add-ons
whatever that setting says; for those, submit the add-on to
[addons.mozilla.org](https://addons.mozilla.org/developers/) for signing.

## Views

Each button regroups the same tabs. Nothing moves in the browser until you click
**Apply**.

| Button  | Grouping                                                                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current | Your windows as they are right now. Applying it changes nothing                                                                                                                                                       |
| Domain  | One column per site, subdomains folded together (`mail.` + `docs.google.com` → `google.com`)                                                                                                                          |
| Purpose | Named buckets — Work, Communication, Docs & Writing, Reading, Reference, Media, Social, Search. Gmail, Slack and Outlook share a column even though they share no words. Sites outside the list fall through to Topic |
| Topic   | Clusters tabs whose titles and URLs share words, so a Rust doc, a Rust Stack Overflow answer and a Rust video group across sites. Labels and cluster count depend on what you have open                               |

## Tabs

Each card shows favicon, title, and host. Double-click it to jump to that tab;
the `×` closes it.

Drag a card to another column to regroup it, or within a column to reorder it.
Drag a column header to move the whole column — that rearranges the board only
and never touches your tabs.

## Buttons

**Visual** adds a page thumbnail to each card. On-screen cards are captured
first, then the queue fills to 100 tabs; past that they load as you scroll.
Firefox blocks capture on `about:` and add-on pages, so those cards keep their
favicon. The toggle asks for content-access permission only when you turn it on,
so a default install stays minimal-permission.

**Dedupe** closes tabs with a repeated URL, keeping the leftmost of each set.
`www.`, trailing slashes, fragments, and tracking params like `utm_*` are ignored
when comparing. Duplicates carry a red edge before you click.

**Save** writes the board to a JSON file, one group per column.

**Import** reads that file back, opening each group as a new window and leaving
your current windows alone. Only `http(s)` URLs restore — Firefox won't let an
add-on reopen `about:` or `file:` pages. Clear any duplicates it brings in with
**Dedupe**.

**Apply** rearranges your real windows to match the board. A column reuses the
window already holding most of its tabs, so Current applies as a no-op; leftover
columns take the remaining windows, then spill into new ones. The window count
follows the column count, since Firefox closes a window when its last tab leaves.

**Refresh** reloads the tab list from the browser.

## Development

```sh
npm test         # unit tests for the pure logic
npm run test:ui  # drives the real UI headless, and regenerates the screenshots
```

`npm run test:ui` needs Playwright and a browser binary. It builds
`_harness.html` (the real page wired to a mocked `browser` API seeded with 120
fake tabs), drives it, and writes `test/screenshots/`, including the image at the
top of this file. Point `PW_MODULE` at an installed `playwright/index.mjs` if it
isn't resolvable locally:

```sh
PW_MODULE=/path/to/node_modules/playwright/index.mjs npm run test:ui
```

See `AGENTS.md` for conventions and the pure/UI split.
