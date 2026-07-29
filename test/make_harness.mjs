// Build a browser-loadable harness from the real manager.html by injecting a
// mock `browser` API (classic script, runs before the deferred module) plus a
// seed of fake tabs. Lets us screenshot the actual UI without the privileged
// WebExtension APIs. Writes _harness.html at the extension root so the relative
// manager.css / src/manager.js paths still resolve.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "manager.html"), "utf8");

const DOMAINS = [
  ["mail.google.com", "Inbox"],
  ["docs.google.com", "Design doc"],
  ["github.com", "pull request"],
  ["github.com", "issue"],
  ["en.wikipedia.org", "Rust (programming language)"],
  ["doc.rust-lang.org", "Async Rust book"],
  ["news.ycombinator.com", "Hacker News"],
  ["stackoverflow.com", "how to async in rust"],
  ["youtube.com", "Rust tutorial video"],
  ["amazon.com", "shopping cart"],
  ["reddit.com", "r/rust discussion"],
  ["obscure-vendor.example", "invoice portal"],
];

const tabs = [];
let id = 1;
for (let w = 1; w <= 4; w++) {
  const perWindow = w === 1 ? 45 : 25; // window 1 is heavy -> 120 total
  for (let i = 0; i < perWindow; i++) {
    const [host, title] = DOMAINS[(id + w) % DOMAINS.length];
    // sprinkle exact duplicates so the dedupe highlight shows
    const path = id % 11 === 0 ? "/shared-page" : `/p/${id}`;
    tabs.push({
      id: id,
      windowId: w,
      index: i,
      url: `https://${host}${path}`,
      title: `${title} #${id}`,
      favIconUrl: "",
    });
    id++;
  }
}

const mock = `
<script>
  const MANAGER = "moz-extension://harness/manager.html";
  const SEED = ${JSON.stringify(tabs)};
  window.__calls = [];
  const rec = (name, arg) => window.__calls.push({ name, arg });
  let nextWin = 100;
  window.browser = {
    runtime: { getURL: () => MANAGER },
    tabs: {
      query: async () => structuredClone(SEED),
      remove: async (ids) => rec("tabs.remove", ids),
      move: async (ids, opts) => rec("tabs.move", { ids, opts }),
      update: async (id, opts) => rec("tabs.update", { id, opts }),
      create: async (opts) => { rec("tabs.create", opts); return { id: 9999 }; },
      captureTab: async () => { throw new Error("no capture in harness"); },
    },
    windows: {
      update: async (id, opts) => rec("windows.update", { id, opts }),
      create: async (opts) => { rec("windows.create", opts); return { id: nextWin++ }; },
    },
    permissions: { request: async () => true },
  };
</script>
`;

const out = html.replace("</head>", `${mock}</head>`);
writeFileSync(join(root, "_harness.html"), out);
console.log(`wrote _harness.html with ${tabs.length} fake tabs`);
