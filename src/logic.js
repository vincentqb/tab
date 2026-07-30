const IGNORED_QUERY_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "ref",
  "ref_src",
  "ref_url",
]);

export function canonicalizeUrl(rawUrl) {
  if (!rawUrl) return "";
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl.trim();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return rawUrl.trim();
  }
  const host = parsed.host.replace(/^www\./, "");
  const params = new URLSearchParams(parsed.search);
  for (const key of [...params.keys()]) {
    if (IGNORED_QUERY_KEYS.has(key.toLowerCase())) params.delete(key);
  }
  params.sort();
  const query = params.toString();
  let path = parsed.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${host}${path}${query ? `?${query}` : ""}`;
}

export function findDuplicates(tabs) {
  const byCanonical = new Map();
  for (const tab of tabs) {
    const key = canonicalizeUrl(tab.url);
    if (!key) continue;
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key).push(tab);
  }

  const groups = [];
  for (const [key, group] of byCanonical) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(compareForKeep);
    groups.push({
      canonicalUrl: key,
      keep: sorted[0],
      remove: sorted.slice(1),
    });
  }
  return groups;
}

export function duplicateTabIds(tabs) {
  return findDuplicates(tabs).flatMap((g) => g.remove.map((t) => t.id));
}

function compareForKeep(a, b) {
  if (a.windowId !== b.windowId) return a.windowId - b.windowId;
  const ai = a.index ?? a.id ?? 0;
  const bi = b.index ?? b.id ?? 0;
  return ai - bi;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "at",
  "by",
  "from",
  "as",
  "it",
  "your",
  "you",
  "how",
  "what",
  "www",
  "com",
  "org",
  "net",
  "io",
  "html",
  "php",
  "home",
  "page",
  "new",
  "tab",
]);

export function domainKey(rawUrl) {
  try {
    const host = new URL(rawUrl).host.replace(/^www\./, "");
    const labels = host.split(".");
    if (labels.length <= 2) return host;
    return labels.slice(-2).join(".");
  } catch {
    return "";
  }
}

function words(text) {
  const tokens = new Set();
  if (!text) return tokens;
  for (const raw of String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

export function pathTokens(tab) {
  try {
    const parsed = new URL(tab.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return new Set();
    return words(`${parsed.pathname} ${parsed.search}`);
  } catch {
    return new Set();
  }
}

export function titleTokens(tab) {
  return words(tab.title);
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function clusterByTokens(tabs, tokenize, { threshold = 0.26 } = {}) {
  if (tabs.length === 0) return [];

  const seeds = new Map();
  const loners = [];
  for (const tab of tabs) {
    const dom = domainKey(tab.url);
    if (dom) {
      if (!seeds.has(dom)) seeds.set(dom, []);
      seeds.get(dom).push(tab);
    } else {
      loners.push([tab]);
    }
  }

  let groups = [...seeds.values(), ...loners].map((groupTabs) => ({
    tabs: groupTabs,
    tokens: unionTokens(groupTabs, tokenize),
  }));

  let merged = true;
  while (merged && groups.length > 1) {
    merged = false;
    let best = { score: threshold, i: -1, j: -1 };
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const score = jaccard(groups[i].tokens, groups[j].tokens);
        if (score >= best.score) best = { score, i, j };
      }
    }
    if (best.i >= 0) {
      const gi = groups[best.i];
      const gj = groups[best.j];
      const combined = {
        tabs: [...gi.tabs, ...gj.tabs],
        tokens: new Set([...gi.tokens, ...gj.tokens]),
      };
      groups.splice(best.j, 1);
      groups.splice(best.i, 1, combined);
      merged = true;
    }
  }

  return groups
    .map((g) => ({ label: labelFor(g.tabs, tokenize), tabs: g.tabs }))
    .sort((a, b) => b.tabs.length - a.tabs.length || a.label.localeCompare(b.label));
}

export function groupByPath(tabs) {
  return clusterByTokens(tabs, pathTokens);
}

export function groupByTitle(tabs) {
  return clusterByTokens(tabs, titleTokens);
}

const FUZZY_SPAN = 1.5;
const MIN_FUZZY_LENGTH = 4;

export function searchFields(tab) {
  const fields = [];
  const push = (text) => {
    const value = String(text ?? "")
      .toLowerCase()
      .trim();
    if (value) fields.push(value);
  };
  push(tab.title);
  for (const word of String(tab.title ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    push(word);
  }
  try {
    const parsed = new URL(tab.url);
    const host = parsed.host.replace(/^www\./, "");
    push(host);
    push(parsed.pathname);
    for (const label of host.split(".")) push(label);
    for (const segment of parsed.pathname.split("/")) push(segment);
    push(parsed.search);
  } catch {
    push(tab.url);
  }
  return fields;
}

// Ordered-subsequence match, but only when the letters land within 1.5x the
// query length. Unbounded subsequence matches "cart" against "AsyncRusTbook";
// the span cap is what keeps a typo tolerance from becoming noise.
function subsequenceHit(term, field) {
  let at = 0;
  let first = -1;
  for (const ch of term) {
    const i = field.indexOf(ch, at);
    if (i < 0) return false;
    if (first < 0) first = i;
    at = i + 1;
  }
  return at - first <= Math.ceil(term.length * FUZZY_SPAN);
}

// Subsequence matching is order-preserving, so it misses a transposition —
// "invioce" for "invoice" — which is the most common typo there is. This allows
// one edit against any same-length window of the field: substitution, doubling,
// and transposition all become one edit, while staying anchored so it can't
// drift into unrelated text.
// Anchored at a word start: a typo'd query should begin where a word begins.
// Scanning every offset instead would match "kube" inside "youtube".
function withinOneEdit(term, field) {
  const span = term.length;
  for (let start = 0; start + span - 1 <= field.length; start++) {
    if (start > 0 && /[a-z0-9]/.test(field[start - 1])) continue;
    for (const width of [span - 1, span, span + 1]) {
      if (width <= 0 || start + width > field.length) continue;
      if (editDistanceWithin1(term, field.slice(start, start + width))) return true;
    }
  }
  return false;
}

// One Damerau-Levenshtein edit: substitution, insertion, deletion, or a swap of
// two adjacent characters. Plain Levenshtein would score a transposition as two
// and reject the typo this exists to catch.
function editDistanceWithin1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;

  if (a.length === b.length) {
    const restEqual = a.slice(i + 1) === b.slice(i + 1);
    if (restEqual) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i);
}

function fuzzyHit(term, field) {
  if (field.includes(term)) return true;
  if (term.length < MIN_FUZZY_LENGTH) return false;
  return subsequenceHit(term, field) || withinOneEdit(term, field);
}

export function parseQuery(query) {
  return String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Every term must hit some field, so extra words narrow rather than widen.
export function matchesQuery(tab, terms) {
  if (terms.length === 0) return true;
  const fields = searchFields(tab);
  return terms.every((term) => fields.some((field) => fuzzyHit(term, field)));
}

export function filterTabs(tabs, query) {
  const terms = parseQuery(query);
  if (terms.length === 0) return tabs;
  return tabs.filter((tab) => matchesQuery(tab, terms));
}

// One column of everything the query matches, so Apply can gather it into a
// single window. Non-matching tabs keep their existing grouping.
export function groupByMatch(tabs, query, rest) {
  const terms = parseQuery(query);
  if (terms.length === 0) return rest(tabs);
  const matched = [];
  const others = [];
  for (const tab of tabs) (matchesQuery(tab, terms) ? matched : others).push(tab);
  if (matched.length === 0) return rest(tabs);
  return [{ label: query.trim(), tabs: matched }, ...rest(others)];
}

export function groupByWindow(tabs) {
  const byWindow = new Map();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }
  const ids = [...byWindow.keys()].sort((a, b) => a - b);
  return ids.map((windowId, i) => ({
    label: `Window ${i + 1}`,
    windowId,
    tabs: byWindow.get(windowId),
  }));
}

export function groupByDomain(tabs) {
  const byDomain = new Map();
  for (const tab of tabs) {
    const key = domainKey(tab.url) || "other";
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(tab);
  }
  return [...byDomain.entries()]
    .map(([label, group]) => ({ label, tabs: group }))
    .sort((a, b) => b.tabs.length - a.tabs.length || a.label.localeCompare(b.label));
}

export const SESSION_VERSION = 1;

export function sessionFromColumns(columns) {
  return {
    version: SESSION_VERSION,
    groups: columns
      .map((col) => ({
        label: col.label,
        tabs: col.tabs.filter((t) => t?.url).map((t) => ({ url: t.url, title: t.title ?? "" })),
      }))
      .filter((g) => g.tabs.length > 0),
  };
}

export function isImportableUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function parseSession(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  let raw;
  if (Array.isArray(data)) raw = data;
  else if (Array.isArray(data?.groups)) raw = data.groups;
  else if (Array.isArray(data?.tabs)) raw = [{ label: "Imported", tabs: data.tabs }];
  else throw new Error("no groups or tabs found");

  const groups = raw
    .map((group, i) => ({
      label: group?.label ? String(group.label) : `Imported ${i + 1}`,
      tabs: (Array.isArray(group?.tabs) ? group.tabs : [])
        .map((t) => (typeof t === "string" ? { url: t } : t))
        .filter((t) => isImportableUrl(t?.url))
        .map((t) => ({ url: t.url, title: t.title ? String(t.title) : "" })),
    }))
    .filter((group) => group.tabs.length > 0);
  if (groups.length === 0) throw new Error("no importable http(s) URLs found");
  return groups;
}

export function planApply(columns, existingWindowIds) {
  const existing = [...existingWindowIds].sort((a, b) => a - b);
  const available = new Set(existing);
  const targets = new Array(columns.length).fill(undefined);

  const prefs = columns.map((col) => {
    const counts = new Map();
    for (const tab of col.tabs) {
      if (tab.windowId != null) counts.set(tab.windowId, (counts.get(tab.windowId) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return { candidates: ranked.map((e) => e[0]), top: ranked[0]?.[1] ?? 0 };
  });

  const order = columns.map((_, i) => i).sort((a, b) => prefs[b].top - prefs[a].top);
  for (const i of order) {
    for (const wid of prefs[i].candidates) {
      if (available.has(wid)) {
        targets[i] = wid;
        available.delete(wid);
        break;
      }
    }
  }

  const leftover = existing.filter((w) => available.has(w));
  for (let i = 0; i < columns.length; i++) {
    if (targets[i] === undefined) {
      targets[i] = leftover.length ? leftover.shift() : null;
    }
  }

  return columns.map((col, i) => ({
    targetWindowId: targets[i],
    isNew: targets[i] === null,
    tabIds: col.tabs.map((t) => t.id),
  }));
}

function unionTokens(groupTabs, tokenize) {
  const all = new Set();
  for (const tab of groupTabs) for (const t of tokenize(tab)) all.add(t);
  return all;
}

function labelFor(groupTabs, tokenize) {
  const counts = new Map();
  for (const tab of groupTabs) {
    for (const token of tokenize(tab)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? "untitled";
}
