#!/usr/bin/env bun

import { existsSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { loadConfig, localUrl } from "../cli/config";
import { EMBED_SANDBOX, IMAGE_EXT, escapeHtml, renderMarkdown, urlPath, type OutlineItem } from "./render";
import { loadThemes, themeCss, type ThemeSet } from "./themes";

const config = loadConfig(process.argv.slice(2));
const { root } = config;
if (!existsSync(root)) {
  console.error(`Artifact root does not exist: ${root}`);
  process.exit(1);
}

const HERE = import.meta.dir;
const PUBLIC_DIR = join(HERE, "public");
const MERMAID_DIR = join(HERE, "..", "node_modules", "mermaid", "dist");

const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (config.publicUrl) allowedHosts.add(new URL(config.publicUrl).hostname);

const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'";

const themeListeners = new Set<() => void>();
let themeCache: ThemeSet | null = null;
let themeWatchers: FSWatcher[] = [];
let themeTimer: ReturnType<typeof setTimeout> | undefined;

function onThemeChange() {
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => {
    themeCache = null;
    // Watch again from scratch, so a themes directory created later is seen.
    for (const watcher of themeWatchers) watcher.close();
    themeWatchers = [];
    for (const notify of themeListeners) notify();
  }, 150);
}

function themes(): ThemeSet {
  if (!themeWatchers.length) {
    for (const dir of [config.configDir, join(config.configDir, "themes")]) {
      if (existsSync(dir)) themeWatchers.push(watch(dir, onThemeChange));
    }
  }
  // Without a watcher (no config directory yet) nothing would refresh a cache.
  if (!themeCache || !themeWatchers.length) themeCache = loadThemes(config.configDir);
  return themeCache;
}

function themePicker(): string {
  const set = themes();
  if (!set.themes.length) return "";
  const choice = (name: string, label: string, swatch: string, hint = "") =>
    `<button type="button" class="theme-choice" role="menuitemradio" aria-checked="false" data-theme-choice="${escapeHtml(name)}">` +
    `${swatch}<span class="name">${escapeHtml(label)}</span>${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ""}</button>`;
  const group = (kind: "dark" | "light", title: string) => {
    const items = set.themes
      .filter((t) => t.kind === kind)
      .map((t) => choice(t.name, t.label, `<span class="swatch" style="background:${t.colors.bg};color:${t.colors.blue}"></span>`));
    return items.length ? `<div class="theme-group">${title}</div>${items.join("")}` : "";
  };
  return (
    '<button type="button" class="theme-button" id="theme-button" popovertarget="theme-menu" aria-label="Theme" title="Theme"><span class="theme-glyph"></span></button>' +
    '<div class="theme-menu" id="theme-menu" popover role="menu" aria-label="Theme">' +
    choice("", "Auto", '<span class="swatch auto"></span>', "matches this device") +
    group("dark", "Dark") +
    group("light", "Light") +
    "</div>"
  );
}

/** Absolute path for a path inside the root, or null if it escapes or is missing. */
function locate(rel: string, base = root): string | null {
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  if (!existsSync(abs)) return null;
  const real = realpathSync(abs);
  const realBase = realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + sep)) return null;
  return abs;
}

interface Entry {
  name: string;
  rel: string;
  mtime: number;
  kind: "doc" | "html" | "image" | "dir";
}

function entryKind(name: string, isDir: boolean): Entry["kind"] | null {
  if (isDir) return "dir";
  const ext = extname(name).toLowerCase();
  if (ext === ".md" || ext === ".mdx") return "doc";
  if (ext === ".html" || ext === ".htm") return "html";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

function listDir(dir: string): Entry[] {
  const out: Entry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith(".") || d.name === "node_modules") continue;
    const abs = join(dir, d.name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue; // Broken symlink.
    }
    const kind = entryKind(d.name, stat.isDirectory());
    if (kind) out.push({ name: d.name, rel: relative(root, abs), mtime: stat.mtimeMs, kind });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const DOC_KINDS = ["research-questions", "research", "design-discussion", "prd", "tdd", "structure-outline", "plan"];
const KIND_LABEL: Record<string, string> = {
  "research-questions": "Questions",
  research: "Research",
  "design-discussion": "Design",
  prd: "PRD",
  tdd: "TDD",
  "structure-outline": "Outline",
  plan: "Plan",
  "pr-description": "PR",
  "pr-walkthrough": "Walkthrough",
};

/** The workflow stage a file belongs to, from the `NN-<kind>-<slug>.md` convention. */
function docKind(name: string): { kind: string; slug: string } | null {
  const stem = name.replace(/\.[^.]+$/, "");
  if (KIND_LABEL[stem]) return { kind: stem, slug: "" };
  const match = /^\d+-(.+)$/.exec(stem);
  if (!match) return null;
  const kind = DOC_KINDS.find((k) => match[1] === k || match[1]!.startsWith(`${k}-`));
  return kind ? { kind, slug: match[1]!.slice(kind.length + 1) } : null;
}

interface Task {
  rel: string;
  name: string;
  group: string;
  mtime: number;
  files: Entry[];
}

/** Every directory (up to three levels deep) that directly holds documents. */
function scanTasks(): Task[] {
  const tasks: Task[] = [];
  const walk = (dir: string, depth: number) => {
    const entries = listDir(dir);
    const files = entries.filter((e) => e.kind !== "dir");
    if (files.some((f) => f.kind === "doc") && dir !== root) {
      const rel = relative(root, dir);
      const dirName = basename(dir);
      // Directories named by ID get a readable name from their first staged document.
      const slug = files.map((f) => docKind(f.name)?.slug).find(Boolean);
      const opaque = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(dirName);
      tasks.push({
        rel,
        name: opaque && slug ? slug : dirName,
        group: dirname(rel) === "." ? "" : dirname(rel),
        mtime: Math.max(...files.map((f) => f.mtime)),
        files,
      });
      return;
    }
    if (depth < 3) for (const e of entries) if (e.kind === "dir") walk(join(root, e.rel), depth + 1);
  };
  walk(root, 0);
  return tasks.sort((a, b) => b.mtime - a.mtime);
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function entryHref(e: Entry): string {
  return (e.kind === "doc" || e.kind === "dir" ? "/view/" : "/raw/") + urlPath(e.rel);
}

const SIDEBAR_TOGGLE =
  '<button type="button" class="sidebar-toggle" id="sidebar-toggle" aria-controls="sidebar" aria-expanded="true" ' +
  'aria-label="Toggle the sidebar" title="Toggle the sidebar (\u2318B)">' +
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 2.75v10.5"/></svg></button>';

const SIDEBAR_RESIZER =
  '<div class="sidebar-resizer" id="sidebar-resizer" role="separator" aria-orientation="vertical" ' +
  'aria-label="Resize the sidebar" title="Drag to resize, double-click to reset" tabindex="0"></div>';

function shell(opts: { title: string; crumbs: string; sidebar?: string; main: string; docPath?: string }): string {
  const hasSidebar = Boolean(opts.sidebar);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="stylesheet" href="/assets/theme.css" id="theme-css">
<script src="/assets/prefs-init.js"></script>
<script type="module" src="/assets/app.js"></script>
</head>
<body class="${hasSidebar ? "with-sidebar" : "no-sidebar"}"${opts.docPath ? ` data-doc="${escapeHtml(opts.docPath)}"` : ""}>
<header class="topbar">
  ${hasSidebar ? SIDEBAR_TOGGLE : ""}
  <nav class="crumbs" aria-label="Location">${opts.crumbs}</nav>
  <span class="live" id="live" hidden>live</span>
  ${themePicker()}
</header>
${hasSidebar ? `<aside class="sidebar" id="sidebar">${opts.sidebar}</aside>${SIDEBAR_RESIZER}<div class="scrim" id="scrim"></div>` : ""}
<main class="main" id="main">${opts.main}</main>
</body>
</html>`;
}

function crumbs(rel: string, taskName?: string): string {
  const parts = rel ? rel.split(sep) : [];
  let acc = "";
  const links = parts.map((part, i) => {
    acc = acc ? join(acc, part) : part;
    const last = i === parts.length - 1;
    const label = escapeHtml(taskName && i === parts.length - 2 ? taskName : part);
    return last ? `<span class="here">${label}</span>` : `<a href="/view/${urlPath(acc)}">${label}</a>`;
  });
  return ['<a href="/" class="home">Artifacts</a>', ...links].join('<span class="sep">/</span>');
}

function fileList(dir: string, current?: string): string {
  const items = listDir(dir)
    .filter((e) => e.kind !== "dir")
    .map((e) => {
      const stage = docKind(e.name);
      const number = /^(\d+)-/.exec(e.name)?.[1] ?? "";
      const stem = e.name.replace(/\.(md|mdx)$/, "").slice(number ? number.length + 1 : 0);
      const label = stage ? (KIND_LABEL[stage.kind] ?? stage.kind) : stem;
      const active = e.rel === current ? ' class="active" aria-current="page"' : "";
      const external = e.kind === "doc" ? "" : ' target="_blank" rel="noopener"';
      return (
        `<li><a href="${entryHref(e)}"${active}${external} title="${escapeHtml(e.name)}">` +
        `<span class="num">${number}</span><span class="label">${escapeHtml(label)}</span>` +
        `${e.kind === "doc" ? "" : `<span class="tag">${e.kind}</span>`}</a></li>`
      );
    });
  return `<ul class="files">${items.join("")}</ul>`;
}

function outlineList(outline: OutlineItem[]): string {
  // Documents start their sections at different levels (outlines at h2, design
  // docs at h3), so show the two highest levels in use below the title.
  const sections = outline.filter((h) => h.level > 1);
  const top = Math.min(...sections.map((h) => h.level));
  const shown = sections.filter((h) => h.level <= top + 1);
  const link = (h: OutlineItem) => `<a href="#${h.id}">${escapeHtml(h.text)}</a>`;
  const items: string[] = [];
  for (let i = 0; i < shown.length; ) {
    const head = shown[i++]!;
    if (head.level > top) {
      items.push(`<li class="l3">${link(head)}</li>`);
      continue;
    }
    const under: string[] = [];
    if (head.foldable) while (shown[i] && shown[i]!.level > top) under.push(`<li class="l3">${link(shown[i++]!)}</li>`);
    items.push(
      under.length
        ? `<li class="l2"><details open><summary><span class="fold-mark" aria-hidden="true"></span>${link(head)}</summary>` +
            `<ul>${under.join("")}</ul></details></li>`
        : `<li class="l2">${link(head)}</li>`,
    );
  }
  return items.length ? `<ul class="outline">${items.join("")}</ul>` : "";
}

interface DocView {
  title: string;
  html: string;
  files: string;
  outline: string;
  version: string;
}

async function docView(abs: string): Promise<DocView> {
  const stat = statSync(abs);
  const rendered = renderMarkdown(await Bun.file(abs).text(), abs, root);
  return {
    title: rendered.title,
    html: rendered.html,
    files: fileList(dirname(abs), relative(root, abs)),
    outline: outlineList(rendered.outline),
    version: `${stat.mtimeMs}-${stat.size}`,
  };
}

async function docPage(abs: string): Promise<string> {
  const rel = relative(root, abs);
  const view = await docView(abs);
  const taskName = scanName(dirname(abs));
  return shell({
    title: view.title,
    crumbs: crumbs(rel, taskName),
    sidebar:
      `<section><h2>Files</h2><div id="files">${view.files}</div></section>` +
      `<section><h2>On this page</h2><div id="outline">${view.outline}</div></section>`,
    main: `<article class="doc" id="doc" data-version="${view.version}">${view.html}</article>`,
    docPath: urlPath(rel),
  });
}

function scanName(dir: string): string | undefined {
  const dirName = basename(dir);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(dirName)) return undefined;
  return listDir(dir)
    .map((f) => docKind(f.name)?.slug)
    .find(Boolean);
}

function dirPage(abs: string): string {
  const rel = relative(root, abs);
  const rows = listDir(abs).map(
    (e) =>
      `<li><a href="${entryHref(e)}"><span class="label">${escapeHtml(e.name)}${e.kind === "dir" ? "/" : ""}</span>` +
      `<span class="when">${ago(e.mtime)}</span></a></li>`,
  );
  return shell({
    title: basename(abs),
    crumbs: crumbs(rel),
    main: `<div class="listing"><h1>${escapeHtml(scanName(abs) ?? basename(abs))}</h1><ul class="rows">${rows.join("") || "<li>No documents here.</li>"}</ul></div>`,
  });
}

function indexPage(): string {
  const tasks = scanTasks();
  const cards = tasks.map((t) => {
    const staged = t.files
      .map((f) => ({ f, stage: docKind(f.name) }))
      .filter((x): x is { f: Entry; stage: { kind: string; slug: string } } => x.stage !== null);
    // One chip per stage, pointing at the latest file of that stage.
    const byKind = new Map(staged.map((x) => [x.stage.kind, x.f]));
    const chips = [...byKind].map(
      ([kind, f]) => `<a class="chip" href="${entryHref(f)}">${escapeHtml(KIND_LABEL[kind] ?? kind)}</a>`,
    );
    const other = t.files.length - staged.length;
    const search = escapeHtml(`${t.name} ${t.group} ${t.rel}`.toLowerCase());
    return (
      `<li class="task" data-search="${search}"><div class="task-head">` +
      `<a class="task-name" href="/view/${urlPath(t.rel)}">${escapeHtml(t.name)}</a>` +
      `<span class="when">${t.group ? `${escapeHtml(t.group)} &middot; ` : ""}${ago(t.mtime)}</span></div>` +
      `<div class="chips">${chips.join("")}${other > 0 ? `<a class="chip more" href="/view/${urlPath(t.rel)}">+${other}</a>` : ""}</div></li>`
    );
  });
  return shell({
    title: "Artifacts",
    crumbs: '<span class="here home">Artifacts</span>',
    main:
      `<div class="listing"><h1>Tasks</h1>` +
      `<input id="filter" class="filter" type="search" placeholder="Filter ${tasks.length} tasks" autocomplete="off">` +
      `<ul class="tasks" id="tasks">${cards.join("") || `<li>No documents under <code>${escapeHtml(root)}</code>.</li>`}</ul></div>`,
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PAGE_CSP,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function notFound(what: string): Response {
  return html(
    shell({
      title: "Not found",
      crumbs: crumbs(""),
      main: `<div class="listing"><h1>Not found</h1><p><code>${escapeHtml(what)}</code> is not under the artifact root.</p></div>`,
    }),
    404,
  );
}

function decodePath(pathname: string, prefix: string): string | null {
  try {
    return decodeURIComponent(pathname.slice(prefix.length)).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Event stream: theme changes for every page, plus file changes in `dir` for documents. */
function events(dir: string | null, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Watch the directory, not the file: editors and agents often replace
      // a file by renaming a new one over it, which a file watch misses.
      const watcher = dir
        ? watch(dir, () => {
            clearTimeout(timer);
            timer = setTimeout(() => send("event: change\ndata: {}\n\n"), 120);
          })
        : null;
      const onTheme = () => send("event: theme\ndata: {}\n\n");
      themeListeners.add(onTheme);
      const beat = setInterval(() => send(": keepalive\n\n"), 20_000);
      cleanup = () => {
        clearTimeout(timer);
        clearInterval(beat);
        themeListeners.delete(onTheme);
        watcher?.close();
      };
      signal.addEventListener("abort", cleanup);
      send("retry: 1000\n\n");
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Reject requests addressed to a name we don't serve (DNS rebinding).
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (!allowedHosts.has(host)) return new Response("Unknown host", { status: 421 });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  const path = url.pathname;
  if (path === "/") return html(indexPage());
  if (path === "/__ping") return Response.json({ app: "keylight-viewer", root, pid: process.pid });

  if (path === "/assets/theme.css") {
    return new Response(themeCss(themes()), {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (path.startsWith("/assets/")) {
    const rel = decodePath(path, "/assets/");
    if (rel === null) return new Response("Bad path", { status: 400 });
    const fromMermaid = rel.startsWith("mermaid/");
    const abs = fromMermaid ? locate(rel.slice("mermaid/".length), MERMAID_DIR) : locate(rel, PUBLIC_DIR);
    if (!abs || statSync(abs).isDirectory()) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(abs), {
      headers: { "cache-control": fromMermaid ? "public, max-age=604800" : "no-cache" },
    });
  }

  if (path === "/events") {
    const watched = url.searchParams.get("path");
    if (watched === null) return events(null, req.signal);
    const abs = locate(watched);
    if (!abs) return new Response("Not found", { status: 404 });
    return events(statSync(abs).isDirectory() ? abs : dirname(abs), req.signal);
  }

  for (const prefix of ["/view/", "/frag/", "/raw/"] as const) {
    if (!path.startsWith(prefix)) continue;
    const rel = decodePath(path, prefix);
    const abs = rel === null ? null : locate(rel);
    if (!abs) return notFound(rel ?? path);
    const isDir = statSync(abs).isDirectory();
    const isDoc = [".md", ".mdx"].includes(extname(abs).toLowerCase());

    if (prefix === "/frag/") {
      if (!isDoc) return new Response("Not a document", { status: 400 });
      return Response.json(await docView(abs), { headers: { "cache-control": "no-store" } });
    }
    if (prefix === "/view/") {
      if (isDir) return html(dirPage(abs));
      if (isDoc) return html(await docPage(abs));
      return Response.redirect(`/raw/${urlPath(relative(root, abs))}`, 302);
    }
    if (isDir) return Response.redirect(`/view/${urlPath(relative(root, abs))}`, 302);
    const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    // HTML artifacts run their own scripts. Sandboxing the document itself
    // (not just the iframe) keeps them away from the viewer even when opened
    // in their own tab.
    if ([".html", ".htm", ".svg"].includes(extname(abs).toLowerCase())) {
      headers["content-security-policy"] = `sandbox ${EMBED_SANDBOX}`;
    }
    return new Response(Bun.file(abs), { headers });
  }

  return notFound(path);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  idleTimeout: 0, // Event streams stay open.
  fetch: (req) =>
    handle(req).catch((err) => {
      console.error(err);
      return new Response("Internal error", { status: 500 });
    }),
});

console.log(`keylight viewer: ${localUrl(config)}  (root: ${root})`);
if (config.publicUrl) console.log(`public links: ${config.publicUrl}`);
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
