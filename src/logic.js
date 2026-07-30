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

export function tokenize(tab) {
  const tokens = new Set();
  const add = (text) => {
    if (!text) return;
    for (const raw of String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
      tokens.add(raw);
    }
  };
  try {
    const parsed = new URL(tab.url);
    for (const label of parsed.host.replace(/^www\./, "").split(".")) add(label);
    add(parsed.pathname.replace(/[/_-]+/g, " "));
  } catch {}
  add(tab.title);
  return tokens;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function clusterBySimilarity(tabs, { threshold = 0.26 } = {}) {
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
    tokens: unionTokens(groupTabs),
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
    .map((g) => ({ label: labelFor(g.tabs), tabs: g.tabs }))
    .sort((a, b) => b.tabs.length - a.tabs.length || a.label.localeCompare(b.label));
}

const INTENT_RULES = [
  {
    label: "Work",
    hosts: [
      /github\.com$/,
      /gitlab\.com$/,
      /atlassian\.net$/,
      /jira\./,
      /bitbucket\./,
      /amazon\.com$/i,
    ],
    paths: [/\/(pull|merge_requests|issues|commit)\b/],
  },
  {
    label: "Communication",
    hosts: [/mail\./, /gmail\./, /outlook\./, /slack\.com$/, /teams\.microsoft/, /discord\.com$/],
  },
  {
    label: "Docs & Writing",
    hosts: [
      /docs\.google\.com$/,
      /notion\.so$/,
      /quip\.com$/,
      /confluence\./,
      /sharepoint\./,
      /overleaf\.com$/,
    ],
  },
  {
    label: "Reading",
    hosts: [
      /wikipedia\.org$/,
      /medium\.com$/,
      /substack\.com$/,
      /arxiv\.org$/,
      /news\.ycombinator\.com$/,
      /\.blog$/,
    ],
    paths: [/\/(blog|article|post|wiki)\b/],
  },
  {
    label: "Reference",
    hosts: [
      /stackoverflow\.com$/,
      /stackexchange\.com$/,
      /developer\.mozilla\.org$/,
      /docs\./,
      /readthedocs\./,
      /man7\.org$/,
    ],
  },
  {
    label: "Media",
    hosts: [
      /youtube\.com$/,
      /youtu\.be$/,
      /netflix\.com$/,
      /twitch\.tv$/,
      /spotify\.com$/,
      /vimeo\.com$/,
    ],
  },
  {
    label: "Social",
    hosts: [
      /twitter\.com$/,
      /x\.com$/,
      /reddit\.com$/,
      /facebook\.com$/,
      /instagram\.com$/,
      /linkedin\.com$/,
    ],
  },
  {
    label: "Search",
    hosts: [/^(www\.)?google\.[a-z.]+$/, /bing\.com$/, /duckduckgo\.com$/],
    paths: [/\/search\b/, /^\/\?q=/],
  },
];

export function intentOf(tab) {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(tab.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Browser";
    host = parsed.host.replace(/^www\./, "");
    path = parsed.pathname + parsed.search;
  } catch {
    return "Browser";
  }
  for (const rule of INTENT_RULES) {
    if (rule.hosts?.some((re) => re.test(host))) return rule.label;
    if (rule.paths?.some((re) => re.test(path))) return rule.label;
  }
  return "";
}

export function smartGroups(tabs) {
  if (tabs.length === 0) return [];
  const byIntent = new Map();
  const unknown = [];
  for (const tab of tabs) {
    const intent = intentOf(tab);
    if (intent) {
      if (!byIntent.has(intent)) byIntent.set(intent, []);
      byIntent.get(intent).push(tab);
    } else {
      unknown.push(tab);
    }
  }

  const columns = [...byIntent.entries()].map(([label, group]) => ({ label, tabs: group }));
  for (const cluster of clusterBySimilarity(unknown)) {
    columns.push({ label: cluster.label, tabs: cluster.tabs });
  }
  return columns.sort((a, b) => b.tabs.length - a.tabs.length || a.label.localeCompare(b.label));
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

function unionTokens(groupTabs) {
  const all = new Set();
  for (const tab of groupTabs) for (const t of tokenize(tab)) all.add(t);
  return all;
}

function labelFor(groupTabs) {
  const domainCounts = new Map();
  for (const tab of groupTabs) {
    const dom = domainKey(tab.url);
    if (dom) domainCounts.set(dom, (domainCounts.get(dom) ?? 0) + 1);
  }
  if (domainCounts.size > 0) {
    return [...domainCounts].sort((a, b) => b[1] - a[1])[0][0];
  }
  const tokenCounts = new Map();
  for (const tab of groupTabs) {
    for (const token of tokenize(tab)) {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }
  if (tokenCounts.size > 0) {
    return [...tokenCounts].sort((a, b) => b[1] - a[1])[0][0];
  }
  return "misc";
}
