import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeUrl,
  findDuplicates,
  duplicateTabIds,
  domainKey,
  pathTokens,
  titleTokens,
  clusterByTokens,
  groupByPath,
  groupByTitle,
  groupByWindow,
  groupByDomain,
  searchFields,
  parseQuery,
  matchesQuery,
  filterTabs,
  groupByMatch,
  sessionFromColumns,
  parseSession,
  isImportableUrl,
  SESSION_VERSION,
  planApply,
} from "../src/logic.js";

test("canonicalizeUrl strips protocol, www, trailing slash, fragment", () => {
  assert.equal(
    canonicalizeUrl("https://www.example.com/path/"),
    canonicalizeUrl("http://example.com/path"),
  );
  assert.equal(
    canonicalizeUrl("https://example.com/x#section"),
    canonicalizeUrl("https://example.com/x"),
  );
});

test("canonicalizeUrl drops tracking params but keeps meaningful query", () => {
  assert.equal(
    canonicalizeUrl("https://shop.com/item?id=5&utm_source=news&fbclid=abc"),
    "shop.com/item?id=5",
  );
});

test("canonicalizeUrl is order-insensitive for query params", () => {
  assert.equal(
    canonicalizeUrl("https://a.com/s?b=2&a=1"),
    canonicalizeUrl("https://a.com/s?a=1&b=2"),
  );
});

test("canonicalizeUrl passes through non-http schemes verbatim", () => {
  assert.equal(canonicalizeUrl("about:config"), "about:config");
  assert.equal(canonicalizeUrl(""), "");
});

test("findDuplicates groups matches and keeps the leftmost tab", () => {
  const tabs = [
    { id: 1, windowId: 10, index: 0, url: "https://example.com/a", title: "A" },
    { id: 2, windowId: 10, index: 1, url: "https://www.example.com/a/", title: "A dup" },
    { id: 3, windowId: 11, index: 0, url: "https://example.com/a?utm_source=x", title: "A dup2" },
    { id: 4, windowId: 10, index: 2, url: "https://other.com", title: "Other" },
  ];
  const groups = findDuplicates(tabs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep.id, 1);
  assert.deepEqual(groups[0].remove.map((t) => t.id).sort(), [2, 3]);
});

test("duplicateTabIds returns exactly the removable ids", () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, url: "https://a.com" },
    { id: 2, windowId: 1, index: 1, url: "https://a.com/" },
    { id: 3, windowId: 1, index: 2, url: "https://b.com" },
  ];
  assert.deepEqual(duplicateTabIds(tabs), [2]);
});

test("no duplicates yields empty result", () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, url: "https://a.com" },
    { id: 2, windowId: 1, index: 1, url: "https://b.com" },
  ];
  assert.deepEqual(findDuplicates(tabs), []);
  assert.deepEqual(duplicateTabIds(tabs), []);
});

test("domainKey collapses subdomains to registrable domain", () => {
  assert.equal(domainKey("https://mail.google.com/x"), "google.com");
  assert.equal(domainKey("https://docs.google.com/y"), "google.com");
  assert.equal(domainKey("https://example.co/z"), "example.co");
  assert.equal(domainKey("about:blank"), "");
});

test("pathTokens reads the URL after the host, dropping stopwords and numbers", () => {
  const tokens = pathTokens({
    url: "https://www.example.com/the/2024/rust-async-guide.html?q=tokio",
  });
  assert.ok(tokens.has("rust"));
  assert.ok(tokens.has("async"));
  assert.ok(tokens.has("guide"));
  assert.ok(tokens.has("tokio"));
  assert.ok(!tokens.has("example"), "host is not part of the path");
  assert.ok(!tokens.has("the"));
  assert.ok(!tokens.has("2024"));
  assert.ok(!tokens.has("html"));
});

test("pathTokens is empty for anything that is not http(s)", () => {
  for (const url of ["about:blank", "about:config", "file:///tmp/x.txt", "", null]) {
    assert.equal(pathTokens({ url }).size, 0, `expected no tokens for ${url}`);
  }
});

test("titleTokens reads only the title", () => {
  const tokens = titleTokens({
    url: "https://github.com/acme/pull/9",
    title: "The Rust Async Guide",
  });
  assert.deepEqual([...tokens].sort(), ["async", "guide", "rust"]);
  assert.ok(!tokens.has("github"), "URL is not part of the title");
});

test("groupByPath ignores the host, so it can group across sites", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a.com/billing/invoice/2024", title: "one" },
    { id: 2, windowId: 1, url: "https://b.com/billing/invoice/2025", title: "two" },
    { id: 3, windowId: 1, url: "https://c.com/watch", title: "three" },
  ];
  const cols = groupByPath(tabs);
  const invoice = cols.find((c) => c.tabs.some((t) => t.id === 1));
  assert.ok(
    invoice.tabs.some((t) => t.id === 2),
    "same path words merge across hosts",
  );
  assert.ok(!invoice.tabs.some((t) => t.id === 3));
});

test("groupByTitle ignores the URL, so unrelated sites with one subject merge", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a.com/x", title: "Async Rust Tokio" },
    { id: 2, windowId: 1, url: "https://b.com/y", title: "Async Rust Tokio" },
    { id: 3, windowId: 1, url: "https://c.com/z", title: "Best pasta recipe" },
  ];
  const cols = groupByTitle(tabs);
  const rust = cols.find((c) => c.tabs.some((t) => t.id === 1));
  assert.ok(rust.tabs.some((t) => t.id === 2));
  assert.ok(!rust.tabs.some((t) => t.id === 3));
});

test("clusterByTokens keeps same-domain tabs together", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://mail.google.com", title: "Gmail" },
    { id: 2, windowId: 2, url: "https://docs.google.com", title: "Docs" },
    { id: 3, windowId: 1, url: "https://en.wikipedia.org/wiki/Rust", title: "Rust" },
  ];
  const clusters = clusterByTokens(tabs, titleTokens);
  const google = clusters.find((c) => c.tabs.some((t) => t.id === 1));
  assert.deepEqual(google.tabs.map((t) => t.id).sort(), [1, 2]);
  assert.ok(!google.tabs.some((t) => t.id === 3));
});

test("labels come from the grouping input, never the host", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://github.com/acme/billing/invoice", title: "Invoice one" },
    { id: 2, windowId: 1, url: "https://github.com/acme/billing/invoice2", title: "Invoice two" },
  ];
  assert.ok(
    groupByPath(tabs).every((c) => !c.label.includes(".")),
    "path labels must not be hostnames",
  );
  assert.equal(groupByTitle(tabs)[0].label, "invoice");
});

test("clusterByTokens returns clusters largest-first and partitions all tabs", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a.com/1", title: "a" },
    { id: 2, windowId: 1, url: "https://a.com/2", title: "a" },
    { id: 3, windowId: 1, url: "https://a.com/3", title: "a" },
    { id: 4, windowId: 1, url: "https://b.com/1", title: "b" },
  ];
  const clusters = clusterByTokens(tabs, titleTokens);
  assert.equal(clusters[0].tabs.length, 3);
  const total = clusters.reduce((n, c) => n + c.tabs.length, 0);
  assert.equal(total, tabs.length);
});

test("empty input yields empty clusters", () => {
  assert.deepEqual(clusterByTokens([], titleTokens), []);
  assert.deepEqual(groupByPath([]), []);
  assert.deepEqual(groupByTitle([]), []);
});

test("both token views handle 150 tabs quickly", () => {
  const domains = ["a.com", "b.com", "c.com", "d.com", "e.com"];
  const tabs = Array.from({ length: 150 }, (_, i) => ({
    id: i,
    windowId: (i % 3) + 1,
    url: `https://${domains[i % domains.length]}/topic${i % 7}/page${i}`,
    title: `Topic ${i % 7} page ${i}`,
  }));
  for (const [name, fn] of [
    ["groupByPath", groupByPath],
    ["groupByTitle", groupByTitle],
  ]) {
    const start = process.hrtime.bigint();
    const cols = fn(tabs);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, `${name} on 150 tabs took ${ms}ms`);
    assert.equal(
      cols.reduce((n, c) => n + c.tabs.length, 0),
      150,
      `${name} must partition every tab`,
    );
  }
});

test("searchFields exposes title, host, path, and their parts", () => {
  const fields = searchFields({
    url: "https://mail.google.com/u/0/inbox",
    title: "Inbox (42)",
  });
  for (const expected of ["inbox (42)", "inbox", "mail.google.com", "google", "/u/0/inbox"]) {
    assert.ok(fields.includes(expected), `expected field ${expected} in ${fields.join("|")}`);
  }
});

test("parseQuery lowercases and splits on whitespace", () => {
  assert.deepEqual(parseQuery("  Rust   Book "), ["rust", "book"]);
  assert.deepEqual(parseQuery(""), []);
  assert.deepEqual(parseQuery(null), []);
});

test("an empty query matches everything", () => {
  const tabs = [{ id: 1, url: "https://a.com", title: "A" }];
  assert.deepEqual(filterTabs(tabs, ""), tabs);
  assert.deepEqual(filterTabs(tabs, "   "), tabs);
  assert.ok(matchesQuery(tabs[0], []));
});

test("search matches on title, host, and path", () => {
  const tab = { id: 1, url: "https://obscure-vendor.example/billing/invoice", title: "Portal" };
  for (const query of ["portal", "vendor", "invoice", "billing"]) {
    assert.ok(matchesQuery(tab, parseQuery(query)), `expected ${query} to match`);
  }
});

test("search tolerates every common typo class", () => {
  const tab = { id: 1, url: "https://vendor.example/billing/invoice", title: "invoice portal" };
  for (const [query, kind] of [
    ["invoice", "exact"],
    ["invoic", "truncated"],
    ["invoce", "dropped letter"],
    ["invioce", "transposed"],
    ["inovice", "transposed further in"],
    ["invoicce", "doubled letter"],
    ["invoise", "substituted letter"],
  ]) {
    assert.ok(matchesQuery(tab, parseQuery(query)), `${kind}: ${query} should match`);
  }
});

test("fuzzy matching does not reach into unrelated words", () => {
  const rustBook = { id: 1, url: "https://doc.rust-lang.org/book/async", title: "Async Rust book" };
  // "cart" is a scattered subsequence of "AsyncRusTbook"; the span cap blocks it.
  assert.equal(matchesQuery(rustBook, parseQuery("cart")), false);
  // "kube" is one edit from the "tube" inside "youtube"; the word-start anchor
  // blocks it.
  const video = { id: 2, url: "https://youtube.com/watch", title: "Rust tutorial video" };
  assert.equal(matchesQuery(video, parseQuery("kube")), false);
  const kubernetes = { id: 3, url: "https://kubernetes.io/docs", title: "Kubernetes" };
  assert.ok(matchesQuery(kubernetes, parseQuery("kube")), "a real prefix still matches");
});

test("filtering 400 tabs stays fast enough to run on every keystroke", () => {
  const tabs = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    windowId: 1,
    url: `https://site${i % 20}.com/section/${i}/detail-page-${i}`,
    title: `A reasonably long page title number ${i}`,
  }));
  const start = process.hrtime.bigint();
  filterTabs(tabs, "invoice");
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 100, `filtering 400 tabs took ${ms}ms`);
});

test("short queries are substring-only, so they cannot fuzzy-match noise", () => {
  const tab = { id: 1, url: "https://a.com/x", title: "Async Rust book" };
  assert.ok(matchesQuery(tab, parseQuery("rus")));
  assert.equal(matchesQuery(tab, parseQuery("ark")), false);
});

test("every term must match, so more words narrow the result", () => {
  const tabs = [
    { id: 1, url: "https://doc.rust-lang.org/book/async", title: "Async Rust book" },
    { id: 2, url: "https://youtube.com/watch", title: "Rust tutorial video" },
  ];
  assert.deepEqual(
    filterTabs(tabs, "rust").map((t) => t.id),
    [1, 2],
  );
  assert.deepEqual(
    filterTabs(tabs, "rust book").map((t) => t.id),
    [1],
  );
});

test("groupByMatch puts matches in a leading column and regroups the rest", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a.com/invoice", title: "Invoice" },
    { id: 2, windowId: 1, url: "https://b.com/invoice", title: "Bill" },
    { id: 3, windowId: 2, url: "https://c.com/x", title: "Unrelated" },
  ];
  const cols = groupByMatch(tabs, "invoice", groupByWindow);
  assert.equal(cols[0].label, "invoice");
  assert.deepEqual(
    cols[0].tabs.map((t) => t.id),
    [1, 2],
  );
  assert.equal(cols[0].windowId, undefined, "the match column must not claim a window");
  const rest = cols.slice(1).flatMap((c) => c.tabs.map((t) => t.id));
  assert.deepEqual(rest, [3]);
});

test("groupByMatch falls back to the plain view when nothing matches", () => {
  const tabs = [{ id: 1, windowId: 1, url: "https://a.com", title: "A" }];
  assert.deepEqual(groupByMatch(tabs, "zzz", groupByWindow), groupByWindow(tabs));
  assert.deepEqual(groupByMatch(tabs, "", groupByWindow), groupByWindow(tabs));
});

test("groupByMatch keeps every tab exactly once", () => {
  const tabs = Array.from({ length: 30 }, (_, i) => ({
    id: i,
    windowId: (i % 3) + 1,
    url: `https://site${i % 5}.com/page/${i}`,
    title: i % 4 === 0 ? `Invoice ${i}` : `Page ${i}`,
  }));
  const ids = groupByMatch(tabs, "invoice", groupByWindow).flatMap((c) => c.tabs.map((t) => t.id));
  assert.equal(ids.length, tabs.length);
  assert.equal(new Set(ids).size, tabs.length);
});

test("groupByWindow yields one column per window carrying windowId", () => {
  const tabs = [
    { id: 1, windowId: 20, url: "https://a.com" },
    { id: 2, windowId: 10, url: "https://b.com" },
    { id: 3, windowId: 20, url: "https://c.com" },
  ];
  const cols = groupByWindow(tabs);
  assert.equal(cols.length, 2);
  assert.equal(cols[0].windowId, 10);
  assert.deepEqual(
    cols[1].tabs.map((t) => t.id),
    [1, 3],
  );
});

test("groupByDomain buckets subdomains together, largest first", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://mail.google.com" },
    { id: 2, windowId: 1, url: "https://docs.google.com" },
    { id: 3, windowId: 1, url: "https://news.ycombinator.com" },
    { id: 4, windowId: 1, url: "about:blank" },
  ];
  const cols = groupByDomain(tabs);
  assert.equal(cols[0].label, "google.com");
  assert.equal(cols[0].tabs.length, 2);
  assert.ok(cols.some((c) => c.label === "other" && c.tabs[0].id === 4));
});

test("sessionFromColumns keeps labels and drops browser ids", () => {
  const session = sessionFromColumns([
    { label: "Work", tabs: [{ id: 1, windowId: 3, url: "https://a.com", title: "A" }] },
    { label: "Media", tabs: [{ id: 2, windowId: 4, url: "https://b.com", title: "B" }] },
  ]);
  assert.equal(session.version, SESSION_VERSION);
  assert.deepEqual(session.groups, [
    { label: "Work", tabs: [{ url: "https://a.com", title: "A" }] },
    { label: "Media", tabs: [{ url: "https://b.com", title: "B" }] },
  ]);
});

test("sessionFromColumns skips urlless tabs and empty groups", () => {
  const session = sessionFromColumns([
    { label: "keep", tabs: [{ id: 1, url: "https://a.com" }, { id: 2 }] },
    { label: "drop", tabs: [] },
  ]);
  assert.equal(session.groups.length, 1);
  assert.deepEqual(session.groups[0].tabs, [{ url: "https://a.com", title: "" }]);
});

test("a saved session round-trips through parseSession", () => {
  const columns = [
    { label: "Work", tabs: [{ id: 1, url: "https://a.com/x", title: "A" }] },
    {
      label: "Reading",
      tabs: [
        { id: 2, url: "https://b.com", title: "B" },
        { id: 3, url: "https://c.com", title: "C" },
      ],
    },
  ];
  const groups = parseSession(JSON.stringify(sessionFromColumns(columns)));
  assert.deepEqual(
    groups.map((g) => [g.label, g.tabs.map((t) => t.url)]),
    [
      ["Work", ["https://a.com/x"]],
      ["Reading", ["https://b.com", "https://c.com"]],
    ],
  );
});

test("isImportableUrl accepts only http(s)", () => {
  assert.ok(isImportableUrl("https://a.com"));
  assert.ok(isImportableUrl("http://a.com"));
  for (const bad of ["about:blank", "file:///tmp/x", "javascript:alert(1)", "", null]) {
    assert.equal(isImportableUrl(bad), false);
  }
});

test("parseSession drops unrestorable URLs but keeps the rest of the group", () => {
  const groups = parseSession(
    JSON.stringify({
      version: 1,
      groups: [
        {
          label: "Mixed",
          tabs: [
            { url: "about:config" },
            { url: "https://ok.com", title: "Ok" },
            { url: "javascript:alert(1)" },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(groups, [{ label: "Mixed", tabs: [{ url: "https://ok.com", title: "Ok" }] }]);
});

test("parseSession accepts a flat tab list and bare url strings", () => {
  const flat = parseSession(JSON.stringify({ tabs: ["https://a.com", "https://b.com"] }));
  assert.equal(flat.length, 1);
  assert.equal(flat[0].tabs.length, 2);

  const bare = parseSession(JSON.stringify([{ tabs: [{ url: "https://a.com" }] }]));
  assert.equal(bare[0].label, "Imported 1");
});

test("parseSession throws a showable message on junk input", () => {
  assert.throws(() => parseSession("not json"), /valid JSON/);
  assert.throws(() => parseSession('{"nope":1}'), /no groups or tabs/);
  assert.throws(() => parseSession('{"groups":[{"tabs":["about:blank"]}]}'), /no importable/);
});

test("planApply maps window view to a no-op (each column keeps its window)", () => {
  const tabs = [
    { id: 1, windowId: 10, url: "https://a.com" },
    { id: 2, windowId: 10, url: "https://b.com" },
    { id: 3, windowId: 11, url: "https://c.com" },
  ];
  const cols = groupByWindow(tabs);
  const plan = planApply(cols, [10, 11]);
  assert.equal(plan[0].targetWindowId, 10);
  assert.equal(plan[1].targetWindowId, 11);
  assert.ok(plan.every((p) => !p.isNew));
});

test("planApply gives contested window to the larger claimant, spills rest to new", () => {
  const columns = [
    {
      label: "big",
      tabs: [
        { id: 1, windowId: 10 },
        { id: 2, windowId: 10 },
        { id: 3, windowId: 10 },
      ],
    },
    { label: "small", tabs: [{ id: 4, windowId: 10 }] },
  ];
  const plan = planApply(columns, [10]);
  assert.equal(plan[0].targetWindowId, 10, "larger group keeps window 10");
  assert.equal(plan[1].isNew, true, "smaller group spills to a new window");
  assert.equal(plan[1].targetWindowId, null);
});

test("planApply reuses leftover windows before creating new ones", () => {
  const columns = [
    { label: "one", tabs: [{ id: 1, windowId: 10 }] },
    { label: "two", tabs: [{ id: 2, windowId: null }] },
  ];
  const plan = planApply(columns, [10, 11]);
  assert.equal(plan[0].targetWindowId, 10);
  assert.equal(plan[1].targetWindowId, 11, "reuses free window 11 instead of new");
  assert.ok(plan.every((p) => !p.isNew));
});
