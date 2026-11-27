// The viewer over real loopback HTTP: one server on a spare port, over a
// temporary artifact root with a directory outside it that nothing may reach.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EMBED_SANDBOX } from "../render";
import { startViewer, type Viewer, type ViewerOptions } from "../server";
import { loadThemes, themeCss } from "../themes";
import { freePort } from "./support";

const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'";
const PUBLIC_URL = "https://box.example.ts.net";
const OPAQUE = "3f2a9c1e-1b2c-4d5e-8f90-123456789abc";
const MINUTE = 60_000;
const { version: mermaidVersion } = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "node_modules", "mermaid", "package.json"), "utf8"),
);
const MERMAID = `/assets/mermaid/${mermaidVersion}`;
const MERMAID_MODULE = `data-mermaid="${MERMAID}/mermaid.esm.min.mjs"`;

const base = realpathSync(mkdtempSync(join(tmpdir(), "keylight-viewer-")));
const root = join(base, "artifacts");
const configDir = join(base, "config");
const outside = join(base, "outside");

const RESEARCH = `---
type: research
---
# Research gates

Stream<T> stays text, and <b onclick="x()">bold</b> stays bold.

## Findings

### Speed

## Open questions
`;

/** Writes `files` under the root, each modified `age` ago. */
function plant(age: number, files: Record<string, string>) {
  const when = new Date(Date.now() - age);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    utimesSync(abs, when, when);
  }
}

function buildFixture() {
  mkdirSync(join(configDir, "themes"), { recursive: true });
  writeFileSync(
    join(configDir, "themes", "dim"),
    "background = #1a1a1a\nforeground = #e0e0e0\n" +
      ["#000", "#600000", "#006000", "#606000", "#000080", "#600060", "#006060"]
        .map((color, i) => `palette = ${i}=${color}`)
        .join("\n"),
  );
  mkdirSync(join(outside, "dir"), { recursive: true });
  writeFileSync(join(outside, "secret.md"), "# Secret");
  writeFileSync(join(outside, "dir", "secret.txt"), "secret");
  writeFileSync(join(outside, "dir", "notes.md"), "# Outside notes");
  plant(0, {
    "keylight/add-gates/01-research-gates.md": RESEARCH,
    "keylight/add-gates/02-tdd-gates.md": "# TDD gates\n\n### Early\n\n## Design\n\n### Shape\n",
    "keylight/add-gates/page.html": "<p>artifact</p>",
    "keylight/add-gates/page.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"></html>',
    "keylight/add-gates/chart.svg": "<svg></svg>",
    "keylight/add-gates/pic.png": "png",
    "keylight/add-gates/notes.txt": "not listed",
    "keylight/add-gates/.draft.md": "hidden",
    "keylight/empty/readme.txt": "no documents",
  });
  plant(10 * MINUTE, { "a/b/c/notes.md": "# Three levels down\n", "a/b/c/d/deep.md": "# Too deep\n" });
  plant(2 * 60 * MINUTE, { [`keylight/${OPAQUE}/01-design-discussion-cache-layer.md`]: "# Cache layer\n" });
  plant(3 * 24 * 60 * MINUTE, { "keylight/older/01-prd-older.md": "# Older\n" });
  plant(Date.now() - new Date(2025, 2, 4, 12).getTime(), { "archive/2025/plan.md": "# Old plan\n" });
  plant(0, { "node_modules/pkg/README.md": "# Dependency\n", "top.md": "# At the root\n" });
  symlinkSync(join(outside, "dir"), join(root, "keylight", "escape"));
  symlinkSync(join(outside, "dir", "secret.txt"), join(root, "keylight", "add-gates", "secret.txt"));
  symlinkSync(join(outside, "secret.md"), join(root, "keylight", "add-gates", "secret.md"));
  symlinkSync(join(base, "nowhere"), join(root, "keylight", "add-gates", "broken.md"));
}

let port = 0;
let viewer: Viewer;
const optionsFor = (overrides: Partial<ViewerOptions> = {}): ViewerOptions => ({
  root,
  port,
  publicUrl: PUBLIC_URL,
  configDir,
  ...overrides,
});

beforeAll(async () => {
  buildFixture();
  port = await freePort();
  viewer = startViewer(optionsFor());
});

afterAll(async () => {
  await viewer?.stop();
  rmSync(base, { recursive: true, force: true });
});

const get = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", ...init });

const text = async (path: string) => {
  const res = await get(path);
  expect(res.status).toBe(200);
  return res.text();
};

const headersOf = (res: Response) => Object.fromEntries(res.headers.entries());

/** Reads an event stream until `pattern` arrives, or fails after five seconds. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: string): Promise<string> {
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + 5000;
  while (!seen.includes(pattern)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`no ${JSON.stringify(pattern)} in the event stream, only ${JSON.stringify(seen)}`);
    const timeout = Bun.sleep(left).then(() => ({ done: true, value: undefined }) as const);
    const chunk = await Promise.race([reader.read(), timeout]);
    if (chunk.done) throw new Error(`the event stream ended before ${JSON.stringify(pattern)}`);
    seen += decoder.decode(chunk.value);
  }
  return seen;
}

/** An open event stream, closed by the client when disposed. */
async function openEvents(
  path: string,
): Promise<AsyncDisposable & { res: Response; until(pattern: string): Promise<string> }> {
  const abort = new AbortController();
  const res = await get(path, { signal: abort.signal });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("the event stream has no body");
  return {
    res,
    until: (pattern) => readUntil(reader, pattern),
    [Symbol.asyncDispose]: async () => {
      abort.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && address.family === "IPv4" && !address.internal)?.address;

function refuses(host: string, at: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: at });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
  });
}

describe("the viewer's guards", () => {
  test("listens on loopback only", async () => {
    expect(await refuses("127.0.0.1", port)).toBe(false);
    if (lanAddress) expect(await refuses(lanAddress, port)).toBe(true);
  });

  test("answers only the loopback names and the public URL's host, refusing any other with 421", async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "box.example.ts.net"]) {
      expect((await get("/__ping", { headers: { host } })).status).toBe(200);
    }
    const rebound = await get("/__ping", { headers: { host: `attacker.example:${port}` } });
    expect(rebound.status).toBe(421);
    expect(await rebound.text()).toBe("Unknown host");
  });

  test("refuses any method but GET and HEAD with 405, after the Host check", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await get("/raw/keylight/add-gates/page.html", { method });
      expect(res.status).toBe(405);
      expect(await res.text()).toBe("Method not allowed");
    }
    expect((await get("/", { method: "POST", headers: { host: "attacker.example" } })).status).toBe(421);
    const head = await get("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("the index", () => {
  test("lists every directory up to three levels down that holds documents, newest first", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(headersOf(res)).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PAGE_CSP,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const body = await res.text();
    const names = [...body.matchAll(/<a class="task-name" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(names).toEqual([
      ["/view/keylight/add-gates", "add-gates"],
      ["/view/a/b/c", "c"],
      [`/view/keylight/${OPAQUE}`, "cache-layer"],
      ["/view/keylight/older", "older"],
      ["/view/archive/2025", "2025"],
    ]);
    expect(body).toContain('placeholder="Filter 5 tasks"');
  });

  test("shows each task's group and age, and a chip per stage with a count of other files", async () => {
    const body = await text("/");
    const cards = body.split('<li class="task"').slice(1);
    expect(cards[0]).toBe(
      ' data-search="add-gates keylight keylight/add-gates"><div class="task-head">' +
        '<a class="task-name" href="/view/keylight/add-gates">add-gates</a>' +
        '<span class="when">keylight &middot; just now</span></div><div class="chips">' +
        '<a class="chip" href="/view/keylight/add-gates/01-research-gates.md">Research</a>' +
        '<a class="chip" href="/view/keylight/add-gates/02-tdd-gates.md">TDD</a>' +
        '<a class="chip more" href="/view/keylight/add-gates">+3</a></div></li>',
    );
    expect(cards[1]).toContain('<span class="when">a/b &middot; 10m ago</span>');
    expect(cards[2]).toContain('<span class="when">keylight &middot; 2h ago</span>');
    expect(cards[2]).toContain(`href="/view/keylight/${OPAQUE}/01-design-discussion-cache-layer.md">Design</a>`);
    expect(cards[3]).toContain('<span class="when">keylight &middot; 3d ago</span>');
    expect(cards[4]).toContain('<span class="when">archive &middot; Mar 4, 2025</span>');
    expect(cards[4]).toContain('href="/view/archive/2025/plan.md">Plan</a>');
  });

  test("offers the configured themes, grouped by kind, with Auto first", async () => {
    const body = await text("/");
    expect(body).toContain('<button type="button" class="theme-button" id="theme-button" popovertarget="theme-menu"');
    expect(body).toContain('data-theme-choice=""><span class="swatch auto"></span><span class="name">Auto</span>');
    expect(body).toContain(
      '<div class="theme-group">Dark</div><button type="button" class="theme-choice" role="menuitemradio" ' +
        'aria-checked="false" data-theme-choice="dim"><span class="swatch" style="background:#1a1a1a;color:#7d7db6"></span>' +
        '<span class="name">Dim</span></button>',
    );
    expect(body).not.toContain('theme-group">Light');
  });
});

describe("the viewer's own routes", () => {
  test("/__ping names the app and its root", async () => {
    const res = await get("/__ping");
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "application/json;charset=utf-8"]);
    expect(await res.json()).toEqual({ app: "keylight-viewer", root, pid: expect.any(Number) });
  });

  test("/assets/theme.css is generated from the config directory's themes", async () => {
    const res = await get("/assets/theme.css");
    expect(res.status).toBe(200);
    expect(headersOf(res)).toMatchObject({ "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
    expect(await res.text()).toBe(themeCss(loadThemes(configDir)));
  });

  test("/assets/ serves the viewer's files and the installed Mermaid's under its version, and nothing beside them", async () => {
    const app = await get("/assets/app.css");
    expect(app.status).toBe(200);
    expect(headersOf(app)).toMatchObject({ "content-type": "text/css;charset=utf-8", "cache-control": "no-cache" });
    expect(await app.text()).toBe(readFileSync(join(import.meta.dir, "..", "public", "app.css"), "utf8"));
    const script = await get("/assets/app.js");
    expect(script.status).toBe(200);
    expect(headersOf(script)).toMatchObject({
      "content-type": "text/javascript;charset=utf-8",
      "cache-control": "no-cache",
    });
    await script.arrayBuffer();
    const mermaid = await get(`${MERMAID}/mermaid.esm.min.mjs`);
    expect(mermaid.status).toBe(200);
    expect(headersOf(mermaid)).toMatchObject({
      "content-type": "text/javascript;charset=utf-8",
      "cache-control": "public, max-age=604800",
    });
    await mermaid.arrayBuffer();
    for (const path of [
      "/assets/nope.js",
      "/assets/",
      "/assets/..%2Fserver.ts",
      "/assets/mermaid/..%2F..%2Fpackage.json",
      "/assets/mermaid/mermaid.esm.min.mjs",
      "/assets/mermaid/11.0.0/mermaid.esm.min.mjs",
      `${MERMAID}`,
      `${MERMAID}/..%2Fpackage.json`,
    ]) {
      const res = await get(path);
      expect([path, res.status, await res.text()]).toEqual([path, 404, "Not found"]);
    }
    const bad = await get("/assets/%E0%A4");
    expect([bad.status, await bad.text()]).toEqual([400, "Bad path"]);
  });

  test("an unknown path is a 404 page", async () => {
    const res = await get("/elsewhere");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(await res.text()).toContain("<p><code>/elsewhere</code> is not under the artifact root.</p>");
  });
});

describe("documents and directories", () => {
  const doc = "keylight/add-gates/01-research-gates.md";

  test("/view/ renders a document with its files, outline, location and version", async () => {
    const body = await text(`/view/${doc}`);
    const stat = statSync(join(root, doc));
    expect(body).toContain("<title>Research gates</title>");
    expect(body).toContain(`<body class="with-sidebar" ${MERMAID_MODULE} data-doc="${doc}">`);
    expect(body).toContain(
      '<nav class="crumbs" aria-label="Location"><a href="/" class="home">Artifacts</a><span class="sep">/</span>' +
        '<a href="/view/keylight">keylight</a><span class="sep">/</span><a href="/view/keylight/add-gates">add-gates</a>' +
        '<span class="sep">/</span><span class="here">01-research-gates.md</span></nav>',
    );
    expect(body).toContain(
      '<ul class="files">' +
        `<li><a href="/view/${doc}" class="active" aria-current="page" title="01-research-gates.md">` +
        '<span class="num">01</span><span class="label">Research</span></a></li>' +
        '<li><a href="/view/keylight/add-gates/02-tdd-gates.md" title="02-tdd-gates.md">' +
        '<span class="num">02</span><span class="label">TDD</span></a></li>' +
        '<li><a href="/raw/keylight/add-gates/chart.svg" target="_blank" rel="noopener" title="chart.svg">' +
        '<span class="num"></span><span class="label">chart.svg</span><span class="tag">image</span></a></li>' +
        '<li><a href="/raw/keylight/add-gates/page.html" target="_blank" rel="noopener" title="page.html">' +
        '<span class="num"></span><span class="label">page.html</span><span class="tag">html</span></a></li>' +
        '<li><a href="/raw/keylight/add-gates/pic.png" target="_blank" rel="noopener" title="pic.png">' +
        '<span class="num"></span><span class="label">pic.png</span><span class="tag">image</span></a></li></ul>',
    );
    expect(body).toContain(
      '<ul class="outline"><li class="l2"><details open><summary><span class="fold-mark" aria-hidden="true"></span>' +
        '<a href="#findings">Findings</a></summary><ul><li class="l3"><a href="#speed">Speed</a></li></ul></details></li>' +
        '<li class="l2"><a href="#open-questions">Open questions</a></li></ul>',
    );
    expect(body).toContain(`<article class="doc" id="doc" data-version="${stat.mtimeMs}-${stat.size}">`);
    expect(body).toContain("<p>Stream&lt;T&gt; stays text, and <b>bold</b> stays bold.</p>");
  });

  test("/view/ names a directory called by an ID after its first staged document", async () => {
    const body = await text(`/view/keylight/${OPAQUE}/01-design-discussion-cache-layer.md`);
    expect(body).toContain(`<a href="/view/keylight/${OPAQUE}">cache-layer</a>`);
    expect(await text(`/view/keylight/${OPAQUE}`)).toContain("<h1>cache-layer</h1>");
  });

  test("/view/ lists a directory, with or without a trailing slash, and nothing a symlink takes outside the root", async () => {
    const body = await text("/view/keylight/");
    expect(body).toContain(`<body class="no-sidebar" ${MERMAID_MODULE}>`);
    const rows = [...body.matchAll(/<li><a href="([^"]+)"><span class="label">([^<]+)<\/span>/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(rows).toEqual([
      [`/view/keylight/${OPAQUE}`, `${OPAQUE}/`],
      ["/view/keylight/add-gates", "add-gates/"],
      ["/view/keylight/empty", "empty/"],
      ["/view/keylight/older", "older/"],
    ]);
    expect(await text("/view/keylight")).toBe(body);
    expect(await text("/view/keylight/empty")).toContain('<ul class="rows"><li>No documents here.</li></ul>');
  });

  test("/view/ of a file that is not a document redirects to /raw/", async () => {
    const res = await get("/view/keylight/add-gates/page.html");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/raw/keylight/add-gates/page.html");
  });

  test("/frag/ returns a document's parts for a live refresh, and refuses anything else", async () => {
    const res = await get(`/frag/${doc}`);
    expect(res.status).toBe(200);
    expect(headersOf(res)).toMatchObject({
      "content-type": "application/json;charset=utf-8",
      "cache-control": "no-store",
    });
    const frag = (await res.json()) as Record<string, string>;
    const page = await text(`/view/${doc}`);
    expect(Object.keys(frag)).toEqual(["title", "html", "files", "outline", "version"]);
    expect(frag.title).toBe("Research gates");
    for (const part of [frag.html, frag.files, frag.outline]) expect(page).toContain(part ?? "missing");
    const earlyRes = await get("/frag/keylight/add-gates/02-tdd-gates.md");
    expect(earlyRes.status).toBe(200);
    const early = (await earlyRes.json()) as Record<string, string>;
    expect(early.outline).toBe(
      '<ul class="outline"><li class="l3"><a href="#early">Early</a></li><li class="l2"><details open><summary>' +
        '<span class="fold-mark" aria-hidden="true"></span><a href="#design">Design</a></summary>' +
        '<ul><li class="l3"><a href="#shape">Shape</a></li></ul></details></li></ul>',
    );
    for (const path of ["/frag/keylight/add-gates", "/frag/keylight/add-gates/page.html"]) {
      const refused = await get(path);
      expect([refused.status, await refused.text()]).toEqual([400, "Not a document"]);
    }
  });

  test("/raw/ serves a file as it is, and sends a directory to /view/", async () => {
    const res = await get("/raw/keylight/add-gates/pic.png");
    expect(res.status).toBe(200);
    expect(headersOf(res)).toMatchObject({
      "content-type": "image/png",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(await res.text()).toBe("png");
    expect(await text(`/raw/${doc}`)).toBe(RESEARCH);
    const dir = await get("/raw/keylight/add-gates/");
    expect(dir.status).toBe(302);
    expect(dir.headers.get("location")).toBe("/view/keylight/add-gates");
  });

  test("/raw/ sandboxes HTML, XHTML and SVG artifacts in their own tab, as the embed frame does", async () => {
    for (const [name, type] of [
      ["page.html", "text/html;charset=utf-8"],
      ["page.xhtml", "application/xhtml+xml"],
      ["chart.svg", "image/svg+xml"],
    ]) {
      const res = await get(`/raw/keylight/add-gates/${name}`);
      expect([name, res.status, res.headers.get("content-type")]).toEqual([name, 200, type]);
      expect(res.headers.get("content-security-policy")).toBe(`sandbox ${EMBED_SANDBOX}`);
      await res.text();
    }
  });

  test("a handler's failure is a 500, logged on the server", async () => {
    if (process.getuid?.() === 0) return;
    const unreadable = join(root, "keylight", "older", "01-prd-older.md");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    chmodSync(unreadable, 0o000);
    try {
      const res = await get("/view/keylight/older/01-prd-older.md");
      expect([res.status, await res.text()]).toEqual([500, "Internal error"]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      chmodSync(unreadable, 0o644);
      logged.mockRestore();
    }
  });
});

describe("containment", () => {
  test("serves nothing outside the root, whether reached by .., an absolute path or a symlink", async () => {
    const escapes = [
      "..%2Foutside%2Fsecret.md",
      "keylight%2F..%2F..%2Foutside%2Fsecret.md",
      encodeURIComponent(join(outside, "secret.md")),
      "keylight/escape/secret.txt",
      "keylight/escape",
      "keylight/add-gates/secret.txt",
      "keylight/add-gates/secret.md",
      "keylight/add-gates/broken.md",
      "keylight/add-gates/missing.md",
    ];
    for (const rel of escapes) {
      for (const prefix of ["/view/", "/frag/", "/raw/"]) {
        const res = await get(prefix + rel);
        const body = await res.text();
        expect([prefix + rel, res.status]).toEqual([prefix + rel, 404]);
        expect(body).not.toContain("secret\n");
        expect(body).toContain("is not under the artifact root.");
      }
    }
  });

  test("names the missing path on the 404 page, escaped, or the raw path when it cannot be decoded", async () => {
    const named = await get("/view/%3Cb%3Ex.md");
    expect(named.status).toBe(404);
    expect(await named.text()).toContain("<code>&lt;b&gt;x.md</code>");
    const undecodable = await get("/raw/%E0%A4");
    expect(undecodable.status).toBe(404);
    expect(await undecodable.text()).toContain("<code>/raw/%E0%A4</code>");
  });

  test("watches nothing outside the root", async () => {
    for (const path of ["..", "keylight/escape", join(outside, "dir"), "keylight/missing"]) {
      const res = await get(`/events?path=${encodeURIComponent(path)}`);
      expect([path, res.status]).toEqual([path, 404]);
      await res.text();
    }
  });
});

describe("live updates", () => {
  test("a page's event stream opens with a retry interval", async () => {
    await using events = await openEvents("/events");
    expect(headersOf(events.res)).toMatchObject({ "content-type": "text/event-stream", "cache-control": "no-store" });
    expect(await events.until("\n\n")).toBe("retry: 1000\n\n");
  });

  test("a document's stream reports a change in its directory", async () => {
    await using events = await openEvents(`/events?path=${encodeURIComponent("keylight/empty/readme.txt")}`);
    await events.until("retry: 1000\n\n");
    writeFileSync(join(root, "keylight", "empty", "readme.txt"), "changed");
    expect(await events.until("event: change\n")).toContain("event: change\ndata: {}\n\n");
  });

  test("every stream reports a theme change, and the stylesheet follows it", async () => {
    await text("/assets/theme.css");
    await using events = await openEvents(`/events?path=${encodeURIComponent("keylight/empty")}`);
    await events.until("retry: 1000\n\n");
    writeFileSync(join(configDir, "theme.conf"), "dark = dim\n");
    expect(await events.until("event: theme\n")).toContain("event: theme\ndata: {}\n\n");
    expect(await text("/assets/theme.css")).toStartWith("@media (prefers-color-scheme: dark)");
  });
});

describe("startViewer", () => {
  test("an empty root says where it looked, and no themes means no theme menu", async () => {
    const empty = join(base, "empty-root");
    mkdirSync(empty);
    const at = await freePort();
    const other = startViewer({ root: empty, port: at, publicUrl: null, configDir: join(base, "no-config") });
    try {
      const body = await (await fetch(`http://127.0.0.1:${at}/`)).text();
      expect(body).toContain(`<li>No documents under <code>${empty}</code>.</li>`);
      expect(body).not.toContain("theme-button");
      expect((await fetch(`http://127.0.0.1:${at}/`, { headers: { host: "box.example.ts.net" } })).status).toBe(421);
    } finally {
      await other.stop();
    }
  });

  test("stop ends open event streams and frees the port", async () => {
    const at = await freePort();
    const other = startViewer(optionsFor({ port: at }));
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      const res = await fetch(`http://127.0.0.1:${at}/events`);
      const body = res.body?.getReader();
      if (!body) throw new Error("the event stream has no body");
      reader = body;
      await readUntil(reader, "retry");
    } finally {
      await other.stop();
    }
    const ended = await Promise.race([
      reader.read().then(
        (chunk) => chunk.done,
        () => true,
      ),
      Bun.sleep(2000).then(() => false),
    ]);
    expect(ended).toBe(true);
    expect(await refuses("127.0.0.1", at)).toBe(true);
  });
});
