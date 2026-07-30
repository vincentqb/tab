import {
  groupByWindow,
  groupByDomain,
  groupByPath,
  groupByTitle,
  duplicateTabIds,
  planApply,
  domainKey,
  sessionFromColumns,
  parseSession,
  filterTabs,
  groupBySearches,
  parseQuery,
} from "./logic.js";

const MANAGER_URL = browser.runtime.getURL("manager.html");
const FALLBACK_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<circle cx="8" cy="8" r="6.5" fill="none" stroke="%239aa2b1" stroke-width="1.2"/>' +
      '<path d="M1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13" fill="none" stroke="%239aa2b1" stroke-width="1.2"/></svg>',
  );

const state = {
  tabsById: new Map(),
  columns: [],
  view: "window",
  visual: false,
  query: "",
  searches: [],
};

const els = {
  board: document.getElementById("board"),
  stat: document.getElementById("stat"),
  banner: document.getElementById("banner"),
  visualBtn: document.getElementById("visual-btn"),
  importFile: document.getElementById("import-file"),
  search: document.getElementById("search"),
  columnTpl: document.getElementById("column-tpl"),
  cardTpl: document.getElementById("card-tpl"),
};

let colSeq = 0;
const nextColId = () => `col-${colSeq++}`;
const thumbCache = new Map();

async function loadTabs() {
  const tabs = await browser.tabs.query({});
  const content = tabs.filter((t) => t.url !== MANAGER_URL);
  state.tabsById = new Map(content.map((t) => [t.id, t]));
  rebuildColumns();
}

function currentTabs() {
  const seen = new Set();
  const ordered = [];
  for (const col of state.columns) {
    for (const id of col.tabIds) {
      const t = state.tabsById.get(id);
      if (t && !seen.has(id)) {
        ordered.push(t);
        seen.add(id);
      }
    }
  }
  return ordered;
}

function toColumns(groups) {
  return groups.map((g) => ({
    id: nextColId(),
    label: g.label,
    windowId: g.windowId,
    search: g.search,
    tabIds: g.tabs.map((t) => t.id),
  }));
}

function groupTabs(tabs) {
  if (state.view === "domain") return groupByDomain(tabs);
  if (state.view === "path") return groupByPath(tabs);
  if (state.view === "title") return groupByTitle(tabs);
  return groupByWindow(tabs);
}

function rebuildColumns() {
  const all = [...state.tabsById.values()];
  // Saved searches always hold their columns. What's left is filtered live by
  // whatever is typed, so a pending query narrows the board without disturbing
  // the groups already made.
  const groups = groupBySearches(all, state.searches, (rest) =>
    groupTabs(filterTabs(rest, state.query)),
  );
  state.columns = toColumns(groups);
  render();
}

function render() {
  const dupIds = new Set(duplicateTabIds(currentTabs()));
  const frag = document.createDocumentFragment();

  for (const col of state.columns) {
    const colNode = els.columnTpl.content.firstElementChild.cloneNode(true);
    colNode.dataset.colId = col.id;
    const labelNode = colNode.querySelector(".column-label");
    labelNode.textContent = col.label || (state.view === "path" ? "no path" : "no title");
    labelNode.title = labelNode.textContent;
    colNode.querySelector(".column-count").textContent = `${col.tabIds.length}`;
    const drop = colNode.querySelector(".column-drop");
    if (col.search) {
      colNode.classList.add("search-column");
      drop.hidden = false;
      drop.title = `Ungroup “${col.search}”`;
      drop.addEventListener("click", () => removeSearch(col.search));
    }
    const list = colNode.querySelector(".tablist");
    list.dataset.colId = col.id;

    for (const id of col.tabIds) {
      const tab = state.tabsById.get(id);
      if (tab) list.appendChild(renderCard(tab, dupIds.has(id)));
    }
    wireColumnDnd(list);
    wireColumnReorder(colNode);
    frag.appendChild(colNode);
  }

  els.board.replaceChildren(frag);
  els.board.classList.toggle("visual", state.visual);
  els.visualBtn.setAttribute("aria-pressed", String(state.visual));
  updateStats(dupIds.size);
  if (state.visual) queueThumbs();
  else observer?.disconnect();
}

function renderCard(tab, isDup) {
  const node = els.cardTpl.content.firstElementChild.cloneNode(true);
  node.dataset.tabId = tab.id;
  node.classList.toggle("dup", isDup);

  const icon = node.querySelector(".favicon");
  icon.src = tab.favIconUrl || FALLBACK_ICON;
  icon.addEventListener("error", () => (icon.src = FALLBACK_ICON), { once: true });

  node.querySelector(".card-title").textContent = clip(tab.title || tab.url || "(untitled)");
  node.querySelector(".card-host").textContent = safeHost(tab.url);
  node.title = `${clip(tab.title)}\n${clip(tab.url)}`;

  const thumb = node.querySelector(".thumb");
  if (state.visual && thumbCache.has(tab.id)) {
    thumb.src = thumbCache.get(tab.id);
    thumb.hidden = false;
  }

  node.querySelector(".card-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });
  node.addEventListener("dblclick", () => activateTab(tab));
  wireCardDnd(node);
  return node;
}

// An encoded URL or hash title can run for thousands of characters. Truncating
// at the source keeps it out of the DOM, the tooltip, and any saved file.
const MAX_TEXT = 300;
function clip(text) {
  const value = String(text ?? "");
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

function safeHost(url) {
  const key = domainKey(url);
  if (key) return key;
  try {
    return new URL(url).protocol.replace(":", "");
  } catch {
    return "";
  }
}

function updateStats(dupCount) {
  const total = state.tabsById.size;
  const shown = state.columns.reduce((n, c) => n + c.tabIds.length, 0);
  const wins = new Set([...state.tabsById.values()].map((t) => t.windowId)).size;
  const dupPart = dupCount ? ` · ${dupCount} duplicate${dupCount > 1 ? "s" : ""}` : "";
  const tabPart = shown === total ? `${total} tabs` : `${shown} of ${total} tabs`;
  els.stat.textContent = `${tabPart} · ${wins} window${wins > 1 ? "s" : ""} · ${state.columns.length} columns${dupPart}`;
}

function setBanner(text, isError = false) {
  els.banner.textContent = text;
  els.banner.hidden = !text;
  els.banner.classList.toggle("error", isError);
}

let dragTabId = null;
let dragColId = null;

const clearHighlight = (cls) =>
  document.querySelectorAll(`.column.${cls}`).forEach((c) => c.classList.remove(cls));

function wireCardDnd(card) {
  card.addEventListener("dragstart", (e) => {
    dragTabId = Number(card.dataset.tabId);
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(dragTabId));
  });
  card.addEventListener("dragend", () => {
    dragTabId = null;
    card.classList.remove("dragging");
    clearHighlight("drop-target");
  });
}

function wireColumnReorder(colNode) {
  const head = colNode.querySelector(".column-head");
  const colId = colNode.dataset.colId;
  head.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    dragColId = colId;
    colNode.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", colId);
  });
  head.addEventListener("dragend", () => {
    dragColId = null;
    colNode.classList.remove("dragging");
    clearHighlight("col-target");
  });
  colNode.addEventListener("dragover", (e) => {
    if (dragColId == null || dragColId === colId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    colNode.classList.add("col-target");
  });
  colNode.addEventListener("dragleave", (e) => {
    if (!colNode.contains(e.relatedTarget)) colNode.classList.remove("col-target");
  });
  colNode.addEventListener("drop", (e) => {
    if (dragColId == null || dragColId === colId) return;
    e.preventDefault();
    e.stopPropagation();
    moveColumnInModel(dragColId, colId);
    render();
  });
}

function moveColumnInModel(fromColId, toColId) {
  const from = state.columns.findIndex((c) => c.id === fromColId);
  const to = state.columns.findIndex((c) => c.id === toColId);
  if (from < 0 || to < 0) return;
  const [moved] = state.columns.splice(from, 1);
  state.columns.splice(to, 0, moved);
}

function wireColumnDnd(list) {
  const column = list.closest(".column");
  list.addEventListener("dragover", (e) => {
    if (dragTabId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    column.classList.add("drop-target");
  });
  list.addEventListener("dragleave", (e) => {
    if (!list.contains(e.relatedTarget)) column.classList.remove("drop-target");
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    column.classList.remove("drop-target");
    if (dragTabId == null) return;
    const targetColId = list.dataset.colId;
    const beforeCard = e.target.closest(".card");
    const beforeId = beforeCard ? Number(beforeCard.dataset.tabId) : null;
    moveTabInModel(dragTabId, targetColId, beforeId);
    render();
  });
}

function moveTabInModel(tabId, targetColId, beforeId) {
  for (const col of state.columns) {
    const i = col.tabIds.indexOf(tabId);
    if (i >= 0) col.tabIds.splice(i, 1);
  }
  const target = state.columns.find((c) => c.id === targetColId);
  if (!target) return;
  if (beforeId != null && beforeId !== tabId) {
    const at = target.tabIds.indexOf(beforeId);
    target.tabIds.splice(at >= 0 ? at : target.tabIds.length, 0, tabId);
  } else {
    target.tabIds.push(tabId);
  }
}

async function closeTab(id) {
  await browser.tabs.remove(id);
  state.tabsById.delete(id);
  for (const col of state.columns) {
    const i = col.tabIds.indexOf(id);
    if (i >= 0) col.tabIds.splice(i, 1);
  }
  render();
}

async function activateTab(tab) {
  await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tab.id, { active: true });
}

async function removeDuplicates() {
  const ids = duplicateTabIds(currentTabs());
  if (ids.length === 0) {
    setBanner("No duplicates found.");
    return;
  }
  await browser.tabs.remove(ids);
  for (const id of ids) state.tabsById.delete(id);
  for (const col of state.columns) col.tabIds = col.tabIds.filter((id) => !ids.includes(id));
  setBanner(`Removed ${ids.length} duplicate tab${ids.length > 1 ? "s" : ""}.`);
  render();
}

async function applyLayout() {
  const columns = state.columns
    .map((c) => ({ tabs: c.tabIds.map((id) => state.tabsById.get(id)).filter(Boolean) }))
    .filter((c) => c.tabs.length > 0);
  if (columns.length === 0) return;

  const existingWindowIds = [...new Set([...state.tabsById.values()].map((t) => t.windowId))];
  const plan = planApply(columns, existingWindowIds);

  setBusy(true);
  setBanner("Applying layout…");
  try {
    for (const entry of plan) {
      if (entry.tabIds.length === 0) continue;
      let windowId = entry.targetWindowId;
      if (entry.isNew) {
        const win = await browser.windows.create({ tabId: entry.tabIds[0] });
        windowId = win.id;
        if (entry.tabIds.length > 1) {
          await browser.tabs.move(entry.tabIds.slice(1), { windowId, index: -1 });
        }
      } else {
        await browser.tabs.move(entry.tabIds, { windowId, index: -1 });
      }
    }
    setBanner("Layout applied.");
  } catch (err) {
    setBanner(`Apply failed: ${err.message}`, true);
  } finally {
    await loadTabs();
    setBusy(false);
  }
}

function setBusy(busy) {
  document.querySelectorAll(".action-btn").forEach((b) => (b.disabled = busy));
}

function saveSession() {
  const session = sessionFromColumns(
    state.columns.map((col) => ({
      label: col.label,
      tabs: col.tabIds.map((id) => state.tabsById.get(id)).filter(Boolean),
    })),
  );
  const count = session.groups.reduce((n, g) => n + g.tabs.length, 0);
  if (count === 0) {
    setBanner("Nothing to save.");
    return;
  }
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tabs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setBanner(`Saved ${count} tabs in ${session.groups.length} groups.`);
}

async function importSession(file) {
  let groups;
  try {
    groups = parseSession(await file.text());
  } catch (err) {
    setBanner(`Import failed: ${err.message}`, true);
    return;
  }
  setBusy(true);
  setBanner(`Importing ${groups.length} window${groups.length > 1 ? "s" : ""}…`);
  let opened = 0;
  try {
    for (const group of groups) {
      const urls = group.tabs.map((t) => t.url);
      const win = await browser.windows.create({ url: urls[0] });
      for (const url of urls.slice(1)) {
        await browser.tabs.create({ windowId: win.id, url, active: false });
      }
      opened += urls.length;
    }
    setBanner(`Imported ${opened} tabs into ${groups.length} new windows.`);
  } catch (err) {
    setBanner(`Import failed after ${opened} tabs: ${err.message}`, true);
  } finally {
    await loadTabs();
    setBusy(false);
  }
}

const EAGER_LIMIT = 100;
const CAPTURE_TIMEOUT_MS = 1500;
const CAPTURE_CONCURRENCY = 4;

let capturing = 0;
let observer = null;
const visibleQueue = new Set();
const backfillQueue = new Set();
const inFlight = new Set();
const failed = new Set();

// A card grows ~4x taller once it holds a thumbnail, so a single visibility
// measurement would prioritize a layout the thumbnails immediately invalidate.
// The observer re-reports on every scroll and reflow instead, and whatever is on
// screen always outranks the backfill.
function queueThumbs() {
  observer?.disconnect();
  visibleQueue.clear();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = Number(entry.target.dataset.tabId);
        if (entry.isIntersecting) visibleQueue.add(id);
        else visibleQueue.delete(id);
      }
      pumpCaptures();
    },
    { root: els.board, rootMargin: "200px" },
  );
  for (const card of els.board.querySelectorAll(".card")) observer.observe(card);

  backfillQueue.clear();
  for (const id of state.tabsById.keys()) backfillQueue.add(id);
  pumpCaptures();
}

function takeFrom(queue) {
  for (const id of queue) {
    queue.delete(id);
    if (!thumbCache.has(id) && !inFlight.has(id) && !failed.has(id)) return id;
  }
  return null;
}

// Visible cards are never subject to EAGER_LIMIT; the cap only throttles the
// off-screen backfill.
function nextCapture() {
  const visible = takeFrom(visibleQueue);
  if (visible != null) return visible;
  if (thumbCache.size + inFlight.size >= EAGER_LIMIT) return null;
  return takeFrom(backfillQueue);
}

function pumpCaptures() {
  while (capturing < CAPTURE_CONCURRENCY) {
    const id = nextCapture();
    if (id == null) break;
    capturing++;
    inFlight.add(id);
    captureThumb(id).finally(() => {
      capturing--;
      inFlight.delete(id);
      if (!thumbCache.has(id)) failed.add(id);
      reportThumbProgress();
      pumpCaptures();
    });
  }
}

function reportThumbProgress() {
  if (!state.visual) return;
  const ids = [...state.tabsById.keys()];
  const total = ids.length;
  const got = ids.filter((id) => thumbCache.has(id)).length;
  const blocked = ids.filter((id) => failed.has(id)).length;
  const pending = total - got - blocked;
  const idle = capturing === 0 && visibleQueue.size === 0 && backfillQueue.size === 0;
  if (pending === 0 || idle) {
    const missed = total - got;
    const tail = missed > 0 ? `; ${missed} could not be captured` : "";
    setBanner(`Captured ${got} of ${total} thumbnails${tail}.`);
    return;
  }
  const parts = [`Captured ${got} of ${total} thumbnails`];
  parts.push(capturing > 0 ? `${pending} to go` : `${pending} load as you scroll`);
  if (blocked > 0) parts.push(`${blocked} could not be captured`);
  setBanner(`${parts.join("; ")}${capturing > 0 ? "…" : "."}`);
}

// captureTab can hang indefinitely on a discarded or never-rendered tab, which
// would hold a concurrency slot forever and stall the whole queue.
async function captureThumb(id) {
  if (!state.tabsById.has(id)) return;
  let timer;
  try {
    const dataUrl = await Promise.race([
      browser.tabs.captureTab(id, { format: "jpeg", quality: 45 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("capture timed out")), CAPTURE_TIMEOUT_MS);
      }),
    ]);
    thumbCache.set(id, dataUrl);
    const thumb = els.board.querySelector(`.card[data-tab-id="${id}"] .thumb`);
    if (thumb) {
      thumb.src = dataUrl;
      thumb.hidden = false;
    }
  } catch {
  } finally {
    clearTimeout(timer);
  }
}

async function enableVisual() {
  const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
  if (!granted) {
    setBanner("Thumbnails need permission to read page content; kept text-only.");
    return;
  }
  state.visual = true;
  render();
  reportThumbProgress();
}

function disableVisual() {
  state.visual = false;
  observer?.disconnect();
  observer = null;
  visibleQueue.clear();
  backfillQueue.clear();
  setBanner("");
  render();
}

function selectView(view) {
  state.view = view;
  document.querySelectorAll(".view-btn").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.view === view));
  });
  rebuildColumns();
}

function setQuery(query) {
  state.query = query;
  rebuildColumns();
  reportSearch();
}

// Enter banks the current query as its own column and empties the box, so the
// next search groups what the previous one left behind.
function groupCurrentSearch() {
  const query = els.search.value.trim();
  if (parseQuery(query).length === 0) return;
  const isNew = !state.searches.includes(query);
  if (isNew) state.searches.push(query);
  els.search.value = "";
  state.query = "";
  rebuildColumns();
  const column = state.columns.find((c) => c.search === query);
  if (!column) {
    state.searches.pop();
    rebuildColumns();
    setBanner(`Nothing left to group for “${query}”.`);
    return;
  }
  const n = column.tabIds.length;
  setBanner(
    isNew
      ? `Grouped ${n} tab${n === 1 ? "" : "s"} as “${query}”. Apply moves each group to its own window.`
      : `“${query}” is already grouped, with ${n} tab${n === 1 ? "" : "s"}.`,
  );
}

function removeSearch(query) {
  state.searches = state.searches.filter((q) => q !== query);
  rebuildColumns();
  reportSearch();
}

function clearSearch() {
  els.search.value = "";
  state.query = "";
  state.searches = [];
  rebuildColumns();
  setBanner("");
}

function reportSearch() {
  if (parseQuery(state.query).length === 0) {
    setBanner("");
    return;
  }
  const grouped = new Set(state.columns.filter((c) => c.search).flatMap((c) => c.tabIds));
  const shown = state.columns.filter((c) => !c.search).reduce((n, c) => n + c.tabIds.length, 0);
  const groupedNote = grouped.size ? ` (${grouped.size} already grouped)` : "";
  if (shown === 0) {
    setBanner(`No ungrouped tabs match “${state.query.trim()}”${groupedNote}.`);
    return;
  }
  setBanner(
    `${shown} tab${shown === 1 ? "" : "s"} match${groupedNote}; press Enter to group them.`,
  );
}

function init() {
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectView(btn.dataset.view));
  });
  els.visualBtn.addEventListener("click", () => {
    if (state.visual) disableVisual();
    else enableVisual();
  });
  els.search.addEventListener("input", (e) => setQuery(e.target.value));
  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") groupCurrentSearch();
    else if (e.key === "Escape") clearSearch();
  });
  document.getElementById("dedupe-btn").addEventListener("click", removeDuplicates);
  document.getElementById("save-btn").addEventListener("click", saveSession);
  document.getElementById("import-btn").addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) importSession(file);
  });
  document.getElementById("apply-btn").addEventListener("click", applyLayout);
  document.getElementById("refresh-btn").addEventListener("click", () => {
    setBanner("");
    loadTabs();
  });

  selectView("window");
  loadTabs();
}

init();
