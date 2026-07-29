// End-to-end UI check: load the real manager page (with mocked browser API),
// exercise every view + dedupe + drag, assert DOM state, and screenshot.
// Uses Playwright's cached Chromium; the app's browser.* calls are stubbed in
// the harness so the engine doesn't matter — this exercises the true DOM code.
const { chromium } = await import(process.env.PW_MODULE || "playwright");
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "test", "screenshots");

// ES modules can't be imported over file:// (opaque origin) — serve the
// extension root over http:// so the harness matches how moz-extension:// loads.
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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

// --- Window view (default) ---
let cards = await page.locator(".card").count();
let cols = await page.locator(".column").count();
check("window view renders all 120 tabs", cards === 120, `${cards} cards`);
check("window view has 4 columns", cols === 4, `${cols} columns`);
const stat = await page.locator("#stat").textContent();
check("stat line reports totals", /120 tabs/.test(stat), stat.trim());
await page.screenshot({ path: join(shots, "01-window.png") });

// --- Domain view ---
await page.click('[data-view="domain"]');
await page.waitForTimeout(150);
cols = await page.locator(".column").count();
const firstLabel = await page.locator(".column-label").first().textContent();
check("domain view groups into domain columns", cols >= 5, `${cols} columns`);
check("largest domain column is labeled", firstLabel.includes("."), firstLabel);
await page.screenshot({ path: join(shots, "02-domain.png") });

// --- Smart view (intent buckets) ---
await page.click('[data-view="smart"]');
await page.waitForTimeout(250);
const smartLabels = await page.locator(".column-label").allTextContents();
const smartCards = await page.locator(".card").count();
check("smart view preserves all tabs", smartCards === 120, `${smartCards} cards`);
for (const expected of ["Work", "Communication", "Media", "Reading", "Reference", "Social"]) {
  check(
    `smart view surfaces the ${expected} bucket`,
    smartLabels.includes(expected),
    smartLabels.join(", "),
  );
}
await page.screenshot({ path: join(shots, "03-smart.png") });

// --- Similarity view ---
await page.click('[data-view="similarity"]');
await page.waitForTimeout(200);
const simCols = await page.locator(".column").count();
const simCards = await page.locator(".card").count();
check("similarity view preserves all tabs", simCards === 120, `${simCards} cards`);
check("similarity view produces clusters", simCols >= 1, `${simCols} clusters`);
await page.screenshot({ path: join(shots, "04-similarity.png") });

// --- Regex view ---
await page.click('[data-view="regex"]');
await page.fill("#regex-input", "://([^/]+)");
await page.waitForTimeout(200);
const regexCols = await page.locator(".column").count();
check("regex capture-group view buckets by host", regexCols >= 5, `${regexCols} columns`);
// invalid pattern surfaces a banner, not a crash
await page.fill("#regex-input", "(");
await page.waitForTimeout(150);
const banner = await page.locator("#banner").textContent();
check("invalid regex shows error banner", /Invalid regex/.test(banner), banner.trim());
await page.fill("#regex-input", "");
await page.waitForTimeout(100);

// --- Dedupe ---
await page.click('[data-view="window"]');
await page.waitForTimeout(150);
const before = await page.locator(".card").count();
const dupHighlights = await page.locator(".card.dup").count();
check("duplicates are highlighted", dupHighlights > 0, `${dupHighlights} dup cards`);
await page.click("#dedupe-btn");
await page.waitForTimeout(200);
const after = await page.locator(".card").count();
check("remove duplicates shrinks the board", after < before, `${before} -> ${after}`);

// --- Drag a tab from column 1 to column 2 ---
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

// --- Apply layout: the dragged tab should be moved via the browser API ---
await page.evaluate(() => (window.__calls = []));
await page.click("#apply-btn");
await page.waitForTimeout(400);
const calls = await page.evaluate(() => window.__calls);
const moved = calls.filter((c) => c.name === "tabs.move");
check("apply issues tabs.move calls", moved.length > 0, `${moved.length} move calls`);
const applyBanner = await page.locator("#banner").textContent();
check("apply reports completion", /applied/i.test(applyBanner), applyBanner.trim());

// --- Visual toggle: capture is attempted for visible cards ---
await page.evaluate(() => (window.__calls = []));
await page.click("#visual-toggle");
await page.waitForTimeout(500);
const boardHasVisual = await page.evaluate(() =>
  document.getElementById("board").classList.contains("visual"),
);
check("visual toggle enables visual board mode", boardHasVisual);

check("no console/page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
server.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
