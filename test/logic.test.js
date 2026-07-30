import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeUrl,
  findDuplicates,
  duplicateTabIds,
  domainKey,
  tokenize,
  clusterBySimilarity,
  groupByWindow,
  groupByDomain,
  sessionFromColumns,
  parseSession,
  isImportableUrl,
  SESSION_VERSION,
  planApply,
  intentOf,
  smartGroups,
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

test("tokenize drops stopwords, short tokens, and pure numbers", () => {
  const tokens = tokenize({
    url: "https://www.example.com/the/2024/rust-async-guide",
    title: "The Rust Async Guide",
  });
  assert.ok(tokens.has("rust"));
  assert.ok(tokens.has("async"));
  assert.ok(tokens.has("guide"));
  assert.ok(!tokens.has("the"));
  assert.ok(!tokens.has("2024"));
  assert.ok(!tokens.has("www"));
});

test("clusterBySimilarity keeps same-domain tabs together", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://mail.google.com", title: "Gmail" },
    { id: 2, windowId: 2, url: "https://docs.google.com", title: "Docs" },
    { id: 3, windowId: 1, url: "https://en.wikipedia.org/wiki/Rust", title: "Rust" },
  ];
  const clusters = clusterBySimilarity(tabs);
  const google = clusters.find((c) => c.label === "google.com");
  assert.ok(google, "expected a google.com cluster");
  assert.deepEqual(google.tabs.map((t) => t.id).sort(), [1, 2]);
});

test("clusterBySimilarity merges topically similar tabs across domains", () => {
  const tabs = [
    {
      id: 1,
      windowId: 1,
      url: "https://doc.rust-lang.org/book/async.html",
      title: "Async Rust Programming",
    },
    {
      id: 2,
      windowId: 2,
      url: "https://tokio.rs/tokio/tutorial",
      title: "Async Rust with Tokio runtime",
    },
    { id: 3, windowId: 1, url: "https://cooking.com/pasta", title: "Best pasta recipe" },
  ];
  const clusters = clusterBySimilarity(tabs, { threshold: 0.15 });
  const rustCluster = clusters.find((c) => c.tabs.some((t) => t.id === 1));
  assert.ok(
    rustCluster.tabs.some((t) => t.id === 2),
    "rust tabs should merge",
  );
  assert.ok(!rustCluster.tabs.some((t) => t.id === 3), "pasta stays separate");
});

test("clusterBySimilarity returns clusters largest-first and partitions all tabs", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a.com/1", title: "a" },
    { id: 2, windowId: 1, url: "https://a.com/2", title: "a" },
    { id: 3, windowId: 1, url: "https://a.com/3", title: "a" },
    { id: 4, windowId: 1, url: "https://b.com/1", title: "b" },
  ];
  const clusters = clusterBySimilarity(tabs);
  assert.equal(clusters[0].tabs.length, 3);
  const total = clusters.reduce((n, c) => n + c.tabs.length, 0);
  assert.equal(total, tabs.length);
});

test("empty input yields empty clusters", () => {
  assert.deepEqual(clusterBySimilarity([]), []);
});

test("clusterBySimilarity handles 100+ tabs quickly", () => {
  const domains = ["a.com", "b.com", "c.com", "d.com", "e.com"];
  const tabs = Array.from({ length: 150 }, (_, i) => ({
    id: i,
    windowId: (i % 3) + 1,
    url: `https://${domains[i % domains.length]}/page${i}`,
    title: `Page ${i}`,
  }));
  const start = process.hrtime.bigint();
  const clusters = clusterBySimilarity(tabs);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `clustering 150 tabs took ${ms}ms`);
  assert.equal(
    clusters.reduce((n, c) => n + c.tabs.length, 0),
    150,
  );
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

test("intentOf classifies tabs by what they are for", () => {
  assert.equal(intentOf({ url: "https://github.com/foo/pull/1" }), "Work");
  assert.equal(intentOf({ url: "https://mail.google.com/inbox" }), "Communication");
  assert.equal(intentOf({ url: "https://docs.google.com/document/d/1" }), "Docs & Writing");
  assert.equal(intentOf({ url: "https://en.wikipedia.org/wiki/Rust" }), "Reading");
  assert.equal(intentOf({ url: "https://stackoverflow.com/questions/1" }), "Reference");
  assert.equal(intentOf({ url: "https://youtube.com/watch?v=1" }), "Media");
  assert.equal(intentOf({ url: "https://reddit.com/r/rust" }), "Social");
  assert.equal(intentOf({ url: "about:config" }), "Browser");
  assert.equal(intentOf({ url: "https://some-random-site.example/x" }), "");
});

test("smartGroups buckets by intent, not just token overlap", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://github.com/a/pull/1", title: "PR" },
    { id: 2, windowId: 1, url: "https://gitlab.com/b/merge_requests/2", title: "MR" },
    { id: 3, windowId: 1, url: "https://youtube.com/watch?v=x", title: "Video" },
    { id: 4, windowId: 1, url: "https://netflix.com/title/9", title: "Show" },
  ];
  const cols = smartGroups(tabs);
  const work = cols.find((c) => c.label === "Work");
  const media = cols.find((c) => c.label === "Media");
  assert.deepEqual(work.tabs.map((t) => t.id).sort(), [1, 2]);
  assert.deepEqual(media.tabs.map((t) => t.id).sort(), [3, 4]);
});

test("smartGroups organizes unknown tabs by similarity instead of a junk drawer", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://github.com/a/pull/1", title: "PR" },
    { id: 2, windowId: 1, url: "https://obscure-shop.example/cart", title: "Cart" },
    { id: 3, windowId: 1, url: "https://obscure-shop.example/checkout", title: "Checkout" },
  ];
  const cols = smartGroups(tabs);
  assert.ok(!cols.some((c) => c.label === "Other"), "no junk-drawer column");
  const shop = cols.find((c) => c.tabs.some((t) => t.id === 2));
  assert.deepEqual(shop.tabs.map((t) => t.id).sort(), [2, 3], "unknowns cluster together");
});

test("smartGroups partitions every tab exactly once", () => {
  const tabs = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    windowId: 1,
    url: `https://${["github.com", "youtube.com", "weird.example"][i % 3]}/p/${i}`,
    title: `T${i}`,
  }));
  const cols = smartGroups(tabs);
  const ids = cols.flatMap((c) => c.tabs.map((t) => t.id)).sort((a, b) => a - b);
  assert.equal(ids.length, 60);
  assert.deepEqual(new Set(ids).size, 60);
});
