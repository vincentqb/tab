const { chromium } = await import(process.env.PW_MODULE || "playwright");
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "test", "screenshots");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(req.url.split("?")[0]));
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/_harness.html`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  acceptDownloads: true,
});
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(url);
await page.waitForSelector(".card", { timeout: 5000 });

let cards = await page.locator(".card").count();
let cols = await page.locator(".column").count();
check("current view renders all 120 tabs", cards === 120, `${cards} cards`);
check("current view has 4 columns", cols === 4, `${cols} columns`);
const viewNames = await page.locator(".view-btn").allTextContents();
check(
  "views are named Current/Domain/Path/Title",
  viewNames.map((t) => t.trim()).join(",") === "Current,Domain,Path,Title",
  viewNames.map((t) => t.trim()).join(","),
);
const stat = await page.locator("#stat").textContent();
check("stat line reports totals", /120 tabs/.test(stat), stat.trim());
await page.screenshot({ path: join(shots, "01-current.png") });

await page.click('[data-view="domain"]');
await page.waitForTimeout(150);
cols = await page.locator(".column").count();
const firstLabel = await page.locator(".column-label").first().textContent();
check("domain view groups into domain columns", cols >= 5, `${cols} columns`);
check("largest domain column is labeled", firstLabel.includes("."), firstLabel);
await page.screenshot({ path: join(shots, "02-domain.png") });

await page.click('[data-view="path"]');
await page.waitForTimeout(250);
const pathCols = await page.locator(".column").count();
const pathCards = await page.locator(".card").count();
const pathLabels = await page.locator(".column-label").allTextContents();
check("path view preserves all tabs", pathCards === 120, `${pathCards} cards`);
check("path view produces columns", pathCols >= 2, `${pathCols} columns`);
check(
  "path labels come from the URL, not the host",
  pathLabels.every((l) => !l.includes(".")),
  pathLabels.join(", "),
);
await page.screenshot({ path: join(shots, "03-path.png") });

await page.click('[data-view="title"]');
await page.waitForTimeout(250);
const titleCols = await page.locator(".column").count();
const titleCards = await page.locator(".card").count();
check("title view preserves all tabs", titleCards === 120, `${titleCards} cards`);
check("title view produces columns", titleCols >= 2, `${titleCols} columns`);
await page.screenshot({ path: join(shots, "04-title.png") });

await page.click('[data-view="window"]');
await page.waitForTimeout(150);
const before = await page.locator(".card").count();
const dupHighlights = await page.locator(".card.dup").count();
check("duplicates are highlighted", dupHighlights > 0, `${dupHighlights} dup cards`);
await page.click("#dedupe-btn");
await page.waitForTimeout(200);
const after = await page.locator(".card").count();
check("remove duplicates shrinks the board", after < before, `${before} -> ${after}`);

const srcCard = page.locator(".column").nth(0).locator(".card").first();
const dstList = page.locator(".column").nth(1).locator(".tablist");
const col1Before = await page.locator(".column").nth(0).locator(".card").count();
const col2Before = await page.locator(".column").nth(1).locator(".card").count();
await srcCard.dragTo(dstList);
await page.waitForTimeout(200);
const col1After = await page.locator(".column").nth(0).locator(".card").count();
const col2After = await page.locator(".column").nth(1).locator(".card").count();
check(
  "drag moves a tab across columns",
  col1After === col1Before - 1 && col2After === col2Before + 1,
  `col1 ${col1Before}->${col1After}, col2 ${col2Before}->${col2After}`,
);
await page.screenshot({ path: join(shots, "05-after-drag.png") });

const col0 = page.locator(".column").nth(0);
const titleAt = (i) => col0.locator(".card-title").nth(i).textContent();
const countBefore = await col0.locator(".card").count();
const firstBefore = await titleAt(0);
const movedTitle = await titleAt(3);
await col0.locator(".card").nth(3).dragTo(col0.locator(".card").nth(0));
await page.waitForTimeout(200);
const firstAfter = await titleAt(0);
const countAfter = await col0.locator(".card").count();
check(
  "dragging within a column reorders it",
  firstAfter === movedTitle && firstAfter !== firstBefore && countAfter === countBefore,
  `"${movedTitle.trim()}" to front; first ${firstBefore.trim()} -> ${firstAfter.trim()}; ${countBefore} -> ${countAfter} cards`,
);

const labels = () => page.locator(".column-label").allTextContents();
const labelsBefore = await labels();
await page.evaluate(() => (window.__calls = []));
await page
  .locator(".column")
  .nth(0)
  .locator(".column-head")
  .dragTo(page.locator(".column").nth(2).locator(".column-head"));
await page.waitForTimeout(200);
const labelsAfter = await labels();
check(
  "dragging a column header reorders the board",
  labelsAfter[2] === labelsBefore[0] && labelsAfter.length === labelsBefore.length,
  `${labelsBefore.join(",")} -> ${labelsAfter.join(",")}`,
);
const colDragCalls = await page.evaluate(() => window.__calls.length);
check("reordering columns touches no browser tabs", colDragCalls === 0, `${colDragCalls} calls`);
const cardsAfterColDrag = await page.locator(".card").count();
check("reordering columns keeps every tab", cardsAfterColDrag === after, `${cardsAfterColDrag}`);

const [download] = await Promise.all([page.waitForEvent("download"), page.click("#save-btn")]);
const saved = JSON.parse(await readFile(await download.path(), "utf8"));
const savedCount = saved.groups.reduce((n, g) => n + g.tabs.length, 0);
check(
  "save downloads a .json file",
  /\.json$/.test(download.suggestedFilename()),
  download.suggestedFilename(),
);
check(
  "saved file carries every tab, grouped as shown",
  saved.version === 1 && saved.groups.length === labelsAfter.length && savedCount === after,
  `${saved.groups.length} groups, ${savedCount} tabs`,
);
check(
  "saved groups keep the on-screen order and labels",
  saved.groups.map((g) => g.label).join(",") === labelsAfter.join(","),
  saved.groups.map((g) => g.label).join(","),
);

const importPath = join(root, "test", "_imported.json");
await writeFile(
  importPath,
  JSON.stringify({
    version: 1,
    groups: [
      { label: "One", tabs: [{ url: "https://x.com/1" }, { url: "https://x.com/2" }] },
      { label: "Two", tabs: [{ url: "https://y.com/1" }, { url: "about:config" }] },
    ],
  }),
);
await page.evaluate(() => (window.__calls = []));
await page.setInputFiles("#import-file", importPath);
await page.waitForTimeout(600);
const importCalls = await page.evaluate(() => window.__calls);
const winCreates = importCalls.filter((c) => c.name === "windows.create");
const tabCreates = importCalls.filter((c) => c.name === "tabs.create");
check(
  "import opens one new window per saved group",
  winCreates.length === 2,
  `${winCreates.length} windows`,
);
check(
  "import adds the remaining tabs to those windows",
  tabCreates.length === 1,
  `${tabCreates.length} tabs.create (about:config skipped)`,
);
const importBanner = await page.locator("#banner").textContent();
check("import reports what it opened", /Imported 3 tabs/.test(importBanner), importBanner.trim());

const badPath = join(root, "test", "_bad.json");
await writeFile(badPath, "totally not json");
await page.setInputFiles("#import-file", badPath);
await page.waitForTimeout(300);
const badBanner = await page.locator("#banner").textContent();
check("bad import file shows an error banner", /Import failed/.test(badBanner), badBanner.trim());
await rm(importPath, { force: true });
await rm(badPath, { force: true });

await page.evaluate(() => (window.__calls = []));
await page.click("#apply-btn");
await page.waitForTimeout(400);
const calls = await page.evaluate(() => window.__calls);
const moved = calls.filter((c) => c.name === "tabs.move");
check("apply issues tabs.move calls", moved.length > 0, `${moved.length} move calls`);
const applyBanner = await page.locator("#banner").textContent();
check("apply reports completion", /applied/i.test(applyBanner), applyBanner.trim());

await page.evaluate(() => (window.__calls = []));
const total = await page.locator(".card").count();
const visibleIds = await page.evaluate(() => {
  const bottom = document.getElementById("board").getBoundingClientRect().bottom;
  return [...document.querySelectorAll(".card")]
    .filter((c) => {
      const b = c.getBoundingClientRect();
      return b.top < bottom && b.bottom > 0;
    })
    .map((c) => Number(c.dataset.tabId));
});
await page.click("#visual-toggle");
// The queue must settle even though some captures never resolve; without the
// per-capture timeout this waits forever on the "Capturing N thumbnails…" text.
await page.waitForFunction(
  () =>
    /^Captured \d+ of \d+ thumbnails[^\u2026]*\.$/.test(
      document.getElementById("banner").textContent.trim(),
    ),
  null,
  { timeout: 15000 },
);
const boardHasVisual = await page.evaluate(() =>
  document.getElementById("board").classList.contains("visual"),
);
check("visual toggle enables visual board mode", boardHasVisual);
const settledBanner = await page.locator("#banner").textContent();
check(
  "the queue settles despite captures that never resolve",
  /^Captured \d+ of \d+ thumbnails/.test(settledBanner.trim()) && !/Capturing/.test(settledBanner),
  settledBanner.trim(),
);
const hungAttempts = await page.evaluate(
  () => window.__calls.filter((c) => c.name === "tabs.captureTab" && c.arg % 23 === 0).length,
);
check(
  "tabs that hang are attempted and then abandoned",
  hungAttempts > 0,
  `${hungAttempts} hung captures attempted`,
);
const capturedIds = () =>
  page.evaluate(() => window.__calls.filter((c) => c.name === "tabs.captureTab").map((c) => c.arg));

// The harness makes every 17th tab throw and every 23rd hang forever, mimicking
// a privileged page and a discarded tab that captureTab never answers for.
const visibleWithoutThumb = () =>
  page.evaluate(() => {
    const vh = innerHeight;
    const vw = innerWidth;
    const missing = [];
    let visible = 0;
    for (const card of document.querySelectorAll(".card")) {
      const r = card.getBoundingClientRect();
      const list = card.closest(".tablist").getBoundingClientRect();
      const onScreen =
        r.bottom > 0 &&
        r.top < vh &&
        r.right > 0 &&
        r.left < vw &&
        r.bottom > list.top &&
        r.top < list.bottom;
      const id = Number(card.dataset.tabId);
      if (!onScreen || id % 17 === 0 || id % 23 === 0) continue;
      visible++;
      const thumb = card.querySelector(".thumb");
      if (!thumb || thumb.hidden || !thumb.src) missing.push(id);
    }
    return { visible, missing };
  });

let vis = await visibleWithoutThumb();
check(
  "every visible card has a thumbnail after the toggle",
  vis.missing.length === 0 && vis.visible > 0,
  `${vis.visible} visible, missing ${JSON.stringify(vis.missing)}`,
);

// The cap counts stored thumbnails, not attempts, so blocked pages don't consume
// a slot and the attempt count can exceed it.
const eager = await capturedIds();
const storedEager = await page.locator(".thumb:not([hidden])").count();
check(
  "the off-screen backfill stops at 100 stored thumbnails",
  storedEager <= 100 && eager.length < total,
  `${storedEager} stored from ${eager.length} attempts, ${total} cards`,
);
check(
  "no tab is captured twice",
  new Set(eager).size === eager.length,
  `${eager.length} calls, ${new Set(eager).size} distinct`,
);

for (const [label, scroll] of [
  [
    "a column is scrolled",
    () =>
      page
        .locator(".column")
        .nth(0)
        .locator(".tablist")
        .evaluate((el) => (el.scrollTop = 99999)),
  ],
  [
    "the board is scrolled sideways",
    () => page.evaluate(() => (document.getElementById("board").scrollLeft = 99999)),
  ],
  [
    "the last column is scrolled",
    () =>
      page
        .locator(".column")
        .last()
        .locator(".tablist")
        .evaluate((el) => (el.scrollTop = 99999)),
  ],
]) {
  await scroll();
  await page.waitForTimeout(1200);
  vis = await visibleWithoutThumb();
  check(
    `every visible card has a thumbnail after ${label}`,
    vis.missing.length === 0 && vis.visible > 0,
    `${vis.visible} visible, missing ${JSON.stringify(vis.missing)}`,
  );
}

const afterScroll = await capturedIds();
check(
  "scrolling captures more tabs lazily",
  afterScroll.length > eager.length,
  `${eager.length} -> ${afterScroll.length} captures`,
);
check(
  "lazy captures never re-request a tab",
  new Set(afterScroll).size === afterScroll.length,
  `${afterScroll.length} calls, ${new Set(afterScroll).size} distinct`,
);
const visualBanner = await page.locator("#banner").textContent();
check(
  "the banner accounts for captured, blocked, and pending",
  /Captured \d+ of \d+ thumbnails/.test(visualBanner),
  visualBanner.trim(),
);
await page.screenshot({ path: join(shots, "06-visual.png") });

check("no console/page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
server.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
