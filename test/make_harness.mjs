import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "manager.html"), "utf8");

const DOMAINS = [
  ["mail.google.com", "Inbox", "/u/0/inbox"],
  ["docs.google.com", "Design doc", "/document/d/abc/edit"],
  ["github.com", "pull request", "/acme/web/pull"],
  ["github.com", "issue", "/acme/web/issues"],
  ["en.wikipedia.org", "Rust (programming language)", "/wiki/Rust_programming_language"],
  ["doc.rust-lang.org", "Async Rust book", "/book/async-await"],
  ["news.ycombinator.com", "Hacker News", "/item"],
  ["stackoverflow.com", "how to async in rust", "/questions/async-await-rust"],
  ["youtube.com", "Rust tutorial video", "/watch"],
  ["amazon.com", "shopping cart", "/gp/cart/view"],
  ["reddit.com", "r/rust discussion", "/r/rust/comments/async_traits"],
  ["obscure-vendor.example", "invoice portal", "/billing/invoice/portal"],
  // a real-world pathological tab: encoded payload for a path, hash for a title
  [
    "loop.cloud.microsoft",
    "eyJ1IjoiaHR0cHM6Ly9hbWF6b24uc2hhcmVwb2ludC5jb20vY29udGVudHN0b3JhZ2UveDhGTk8teHRza3VDUlgy",
    "/p/eyJ1IjoiaHR0cHM6Ly9hbWF6b24uc2hhcmVwb2ludC5jb20vY29udGVudHN0b3JhZ2UveDhGTk8teHRza3VDUlgyX2ZNVEhMYXpuSEVRU1M4ZEpwNm8yU3BqOU8wOD9uYXY9Y3owbE1rWmpiMjUwWlc1MGMzUnZjbUZuWlNVeVJuZzRSazVQTFhoMGMydDFRMUpZTWw5bVRWUklUR0Y2YmtoRlVWTlRPR1JLY0Radk1sTndhamxQTURn",
  ],
];

const tabs = [];
let id = 1;
for (let w = 1; w <= 4; w++) {
  const perWindow = w === 1 ? 45 : 25;
  for (let i = 0; i < perWindow; i++) {
    const [host, title, path] = DOMAINS[(id + w) % DOMAINS.length];
    tabs.push({
      id: id,
      windowId: w,
      index: i,
      url: id % 11 === 0 ? `https://${host}/shared-page` : `https://${host}${path}?id=${id}`,
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
  window.__attempts = {};
  const rec = (name, arg) => window.__calls.push({ name, arg });
  let nextWin = 100;
  let nextTab = 9000;
  // A reload changes the title and drops the favicon, and the tab reports
  // "loading" once before it settles: the card must not read the tab until then.
  const reloaded = {};
  window.__loadingLeft = {};
  window.browser = {
    runtime: { getURL: () => MANAGER },
    tabs: {
      query: async () => structuredClone(SEED),
      reload: async (id, opts) => {
        rec("tabs.reload", { id, opts });
        if (id % 19 === 0) throw new Error("cannot reload privileged page");
        reloaded[id] = true;
        window.__loadingLeft[id] = 1;
      },
      get: async (id) => {
        const seed = SEED.find((t) => t.id === id);
        if (!seed) throw new Error("no such tab: " + id);
        rec("tabs.get", id);
        if (window.__loadingLeft[id] > 0) {
          window.__loadingLeft[id]--;
          return { ...seed, status: "loading" };
        }
        if (!reloaded[id]) return { ...seed, status: "complete" };
        return { ...seed, status: "complete", title: "RELOADED " + seed.title, favIconUrl: "" };
      },
      remove: async (ids) => rec("tabs.remove", ids),
      move: async (ids, opts) => rec("tabs.move", { ids, opts }),
      update: async (id, opts) => rec("tabs.update", { id, opts }),
      create: async (opts) => { rec("tabs.create", opts); return { id: nextTab++ }; },
      captureTab: async (id) => {
        rec("tabs.captureTab", id);
        if (id % 17 === 0) throw new Error("cannot capture privileged page");
        // slow on the first attempt only: Firefox renders a discarded tab before
        // capturing it, so this must succeed on retry rather than be given up on
        if (id % 23 === 0 && (window.__attempts[id] = (window.__attempts[id] || 0) + 1) === 1) {
          return new Promise((r) => setTimeout(r, 4000));
        }
        if (id % 31 === 0) return new Promise(() => {});
        if (id % 29 === 0) {
          var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="2400">' +
            '<rect width="100%" height="100%" fill="#ccddee"/></svg>';
          return "data:image/svg+xml;base64," + btoa(svg);
        }
        return "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=";
      },
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
