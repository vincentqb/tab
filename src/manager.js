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
};

const els = {
  board: document.getElementById("board"),
  stat: document.getElementById("stat"),
  banner: document.getElementById("banner"),
  visualToggle: document.getElementById("visual-toggle"),
  importFile: document.getElementById("import-file"),
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
    tabIds: g.tabs.map((t) => t.id),
  }));
}

function rebuildColumns() {
  const tabs = [...state.tabsById.values()];
  let groups;
  if (state.view === "domain") groups = groupByDomain(tabs);
  else if (state.view === "path") groups = groupByPath(tabs);
  else if (state.view === "title") groups = groupByTitle(tabs);
  else groups = groupByWindow(tabs);
  state.columns = toColumns(groups);
  render();
}

function render() {
  const dupIds = new Set(duplicateTabIds(currentTabs()));
  const frag = document.createDocumentFragment();

  for (const col of state.columns) {
    const colNode = els.columnTpl.content.firstElementChild.cloneNode(true);
    colNode.dataset.colId = col.id;
    colNode.querySelector(".column-label").textContent = col.label;
    colNode.querySelector(".column-count").textContent = `${col.tabIds.length}`;
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

  node.querySelector(".card-title").textContent = tab.title || tab.url || "(untitled)";
  const host = safeHost(tab.url);
  node.querySelector(".card-host").textContent = host;
  node.title = `${tab.title || ""}\n${tab.url || ""}`;

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
  const wins = new Set([...state.tabsById.values()].map((t) => t.windowId)).size;
  const dupPart = dupCount ? ` · ${dupCount} duplicate${dupCount > 1 ? "s" : ""}` : "";
  els.stat.textContent = `${total} tabs · ${wins} window${wins > 1 ? "s" : ""} · ${state.columns.length} columns${dupPart}`;
}

function setBanner(text, isError = false) {
  els.banner.textContent = text;
  els.banner.hidden = !text;
  els.banner.classList.toggle("error", isError);
}

let dragTabId = null;
let dragColId = null;

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
    document
      .querySelectorAll(".column.drop-target")
      .forEach((c) => c.classList.remove("drop-target"));
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
    document
      .querySelectorAll(".column.col-target")
      .forEach((c) => c.classList.remove("col-target"));
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
  while (capturing < 3) {
    const id = nextCapture();
    if (id == null) break;
    capturing++;
    inFlight.add(id);
    captureThumb(id).finally(() => {
      capturing--;
      inFlight.delete(id);
      if (!thumbCache.has(id)) failed.add(id);
      pumpCaptures();
      if (capturing === 0) reportThumbProgress();
    });
  }
}

function reportThumbProgress() {
  if (!state.visual) return;
  const total = state.tabsById.size;
  const got = [...state.tabsById.keys()].filter((id) => thumbCache.has(id)).length;
  const blocked = [...state.tabsById.keys()].filter((id) => failed.has(id)).length;
  const waiting = total - got - blocked;
  const parts = [`Captured ${got} of ${total} thumbnails`];
  if (blocked > 0) parts.push(`${blocked} are pages Firefox won't let an add-on read`);
  if (waiting > 0) parts.push(`${waiting} load as you scroll`);
  setBanner(`${parts.join("; ")}.`);
}

async function captureThumb(id) {
  const tab = state.tabsById.get(id);
  if (!tab) return;
  try {
    const dataUrl = await browser.tabs.captureTab(id, { format: "jpeg", quality: 45 });
    thumbCache.set(id, dataUrl);
    const card = els.board.querySelector(`.card[data-tab-id="${id}"] .thumb`);
    if (card) {
      card.src = dataUrl;
      card.hidden = false;
    }
  } catch {}
}

async function enableVisual() {
  const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
  if (!granted) {
    els.visualToggle.checked = false;
    setBanner("Thumbnails need permission to read page content; kept text-only.");
    return;
  }
  state.visual = true;
  setBanner(`Capturing ${Math.min(state.tabsById.size, EAGER_LIMIT)} thumbnails…`);
  render();
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

function init() {
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectView(btn.dataset.view));
  });
  els.visualToggle.addEventListener("change", (e) => {
    if (e.target.checked) enableVisual();
    else disableVisual();
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
