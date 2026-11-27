#!/usr/bin/env bun
// The artifact viewer: serves one artifact root over loopback HTTP.

import {
  existsSync,
  type FSWatcher,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
  watch,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Config } from "../cli/config";
import { TaskError } from "../cli/task";
import { EMBED_SANDBOX, escapeHtml, IMAGE_EXT, type OutlineItem, renderMarkdown, urlPath } from "./render";
import { loadThemes, type ThemeSet, themeCss } from "./themes";

const HERE = import.meta.dir;
const PUBLIC_DIR = join(HERE, "public");
const MERMAID_PACKAGE = join(HERE, "..", "node_modules", "mermaid");
const MERMAID_DIR = join(MERMAID_PACKAGE, "dist");

const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'";

export interface Viewer {
  /** Ends open event streams and file watches, then stops listening. */
  stop(): Promise<void>;
}

interface Site {
  root: string;
  allowedHosts: Set<string>;
  themes: WatchedThemes;
  /** Ends each open event stream. */
  streams: Set<() => void>;
}

interface WatchedThemes {
  current(): ThemeSet;
  /** Called after the config directory changes. */
  listeners: Set<() => void>;
  close(): void;
}

/** Serves `config.root` on loopback at `config.port` until stopped. */
export function startViewer(config: Config): Viewer {
  if (!existsSync(config.root)) throw new TaskError(`artifact root does not exist: ${config.root}`);
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (config.publicUrl) allowedHosts.add(new URL(config.publicUrl).hostname);
  const site: Site = { root: config.root, allowedHosts, themes: watchThemes(config.configDir), streams: new Set() };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    idleTimeout: 0, // Event streams stay open.
    fetch: (req) =>
      handle(site, req).catch((err) => {
        console.error(err);
        return new Response("Internal error", { status: 500 });
      }),
  });
  return {
    async stop() {
      for (const end of site.streams) end();
      site.themes.close();
      await server.stop(true);
    },
  };
}

function watchThemes(configDir: string): WatchedThemes {
  const listeners = new Set<() => void>();
  let cache: ThemeSet | null = null;
  let watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A request still in flight when the viewer stops must not watch again.
  let closed = false;
  const unwatch = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      cache = null;
      // Watch again from scratch, so a themes directory created later is seen.
      unwatch();
      for (const notify of listeners) notify();
    }, 150);
  };
  return {
    listeners,
    current() {
      if (!watchers.length && !closed) {
        for (const dir of [configDir, join(configDir, "themes")]) {
          if (existsSync(dir)) watchers.push(watch(dir, changed));
        }
      }
      // Without a watcher (no config directory yet) nothing would refresh a cache.
      if (!cache || !watchers.length) cache = loadThemes(configDir);
      return cache;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      unwatch();
    },
  };
}

function themePicker(set: ThemeSet): string {
  if (!set.themes.length) return "";
  const choice = (name: string, label: string, swatch: string, hint = "") =>
    `<button type="button" class="theme-choice" role="menuitemradio" aria-checked="false" data-theme-choice="${escapeHtml(name)}">` +
    `${swatch}<span class="name">${escapeHtml(label)}</span>${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ""}</button>`;
  const group = (kind: "dark" | "light", title: string) => {
    const items = set.themes
      .filter((t) => t.kind === kind)
      .map((t) =>
        choice(
          t.name,
          t.label,
          `<span class="swatch" style="background:${t.colors.bg};color:${t.colors.blue}"></span>`,
        ),
      );
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

/** Absolute path for a path inside `base`, or null if it escapes or is missing. */
function locate(base: string, rel: string): string | null {
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

function isDocument(name: string): boolean {
  return [".md", ".mdx"].includes(extname(name).toLowerCase());
}

function entryKind(name: string, isDir: boolean): Entry["kind"] | null {
  if (isDir) return "dir";
  if (isDocument(name)) return "doc";
  const ext = extname(name).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

function listDir(root: string, dir: string): Entry[] {
  const out: Entry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith(".") || d.name === "node_modules") continue;
    const abs = join(dir, d.name);
    const rel = relative(root, abs);
    let stat: Stats;
    try {
      // A symlink that is broken or leaves the root is never served, so it is not listed.
      if (d.isSymbolicLink() && !locate(root, rel)) continue;
      stat = statSync(abs);
    } catch {
      continue; // Removed since the directory was read.
    }
    const kind = entryKind(d.name, stat.isDirectory());
    if (kind) out.push({ name: d.name, rel, mtime: stat.mtimeMs, kind });
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
function scanTasks(root: string): Task[] {
  const tasks: Task[] = [];
  const walk = (dir: string, depth: number) => {
    const entries = listDir(root, dir);
    const files = entries.filter((e) => e.kind !== "dir");
    if (dir !== root && files.some((f) => f.kind === "doc")) {
      tasks.push(taskAt(root, dir, files));
      return;
    }
    if (depth < 3) for (const e of entries) if (e.kind === "dir") walk(join(root, e.rel), depth + 1);
  };
  walk(root, 0);
  return tasks.sort((a, b) => b.mtime - a.mtime);
}

function taskAt(root: string, dir: string, files: Entry[]): Task {
  const rel = relative(root, dir);
  return {
    rel,
    name: readableName(dir, files) ?? basename(dir),
    group: dirname(rel) === "." ? "" : dirname(rel),
    mtime: Math.max(...files.map((f) => f.mtime)),
    files,
  };
}

/** Directories named by ID get a readable name from the first staged entry with a slug. */
function readableName(dir: string, entries: Entry[]): string | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(basename(dir))) return undefined;
  return entries.map((e) => docKind(e.name)?.slug).find(Boolean);
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

/**
 * The asset path prefix for the installed Mermaid, named by its version so a release
 * change gives the module and its diagram chunks new URLs. Read on each use because
 * `bun install` can replace Mermaid under a running viewer. Null while an install
 * has it removed, so pages still render and only diagrams fail.
 */
function mermaidPrefix(): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(MERMAID_PACKAGE, "package.json"), "utf8"));
    return `mermaid/${version}/`;
  } catch {
    return null;
  }
}

function shell(
  site: Site,
  opts: { title: string; crumbs: string; sidebar?: string; main: string; docPath?: string },
): string {
  const hasSidebar = Boolean(opts.sidebar);
  const mermaid = mermaidPrefix();
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
<body class="${hasSidebar ? "with-sidebar" : "no-sidebar"}"${mermaid ? ` data-mermaid="/assets/${mermaid}mermaid.esm.min.mjs"` : ""}${opts.docPath ? ` data-doc="${escapeHtml(opts.docPath)}"` : ""}>
<header class="topbar">
  ${hasSidebar ? SIDEBAR_TOGGLE : ""}
  <nav class="crumbs" aria-label="Location">${opts.crumbs}</nav>
  <span class="live" id="live" hidden>live</span>
  ${themePicker(site.themes.current())}
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

function fileList(entries: Entry[], current: string): string {
  const items = entries
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

async function docView(root: string, abs: string): Promise<{ view: DocView; entries: Entry[] }> {
  const stat = statSync(abs);
  const rendered = renderMarkdown(await Bun.file(abs).text(), abs, root);
  // Listed after the read, so a file added during it still appears: the page's
  // change stream opens only once the response arrives.
  const entries = listDir(root, dirname(abs));
  return {
    entries,
    view: {
      title: rendered.title,
      html: rendered.html,
      files: fileList(entries, relative(root, abs)),
      outline: outlineList(rendered.outline),
      version: `${stat.mtimeMs}-${stat.size}`,
    },
  };
}

async function docPage(site: Site, abs: string): Promise<string> {
  const rel = relative(site.root, abs);
  const { view, entries } = await docView(site.root, abs);
  return shell(site, {
    title: view.title,
    crumbs: crumbs(rel, readableName(dirname(abs), entries)),
    sidebar:
      `<section><h2>Files</h2><div id="files">${view.files}</div></section>` +
      `<section><h2>On this page</h2><div id="outline">${view.outline}</div></section>`,
    main: `<article class="doc" id="doc" data-version="${view.version}">${view.html}</article>`,
    docPath: urlPath(rel),
  });
}

function dirPage(site: Site, abs: string): string {
  const rel = relative(site.root, abs);
  const entries = listDir(site.root, abs);
  const rows = entries.map(
    (e) =>
      `<li><a href="${entryHref(e)}"><span class="label">${escapeHtml(e.name)}${e.kind === "dir" ? "/" : ""}</span>` +
      `<span class="when">${ago(e.mtime)}</span></a></li>`,
  );
  return shell(site, {
    title: basename(abs),
    crumbs: crumbs(rel),
    main: `<div class="listing"><h1>${escapeHtml(readableName(abs, entries) ?? basename(abs))}</h1><ul class="rows">${rows.join("") || "<li>No documents here.</li>"}</ul></div>`,
  });
}

function indexPage(site: Site): string {
  const tasks = scanTasks(site.root);
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
  return shell(site, {
    title: "Artifacts",
    crumbs: '<span class="here home">Artifacts</span>',
    main:
      `<div class="listing"><h1>Tasks</h1>` +
      `<input id="filter" class="filter" type="search" placeholder="Filter ${tasks.length} tasks" autocomplete="off">` +
      `<ul class="tasks" id="tasks">${cards.join("") || `<li>No documents under <code>${escapeHtml(site.root)}</code>.</li>`}</ul></div>`,
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

function notFound(site: Site, what: string): Response {
  return html(
    shell(site, {
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
function events(site: Site, dir: string | null, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let end = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          end();
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
      site.themes.listeners.add(onTheme);
      const beat = setInterval(() => send(": keepalive\n\n"), 20_000);
      end = () => {
        clearTimeout(timer);
        clearInterval(beat);
        site.themes.listeners.delete(onTheme);
        watcher?.close();
        site.streams.delete(end);
        try {
          controller.close();
        } catch {
          // The client already closed it.
        }
      };
      site.streams.add(end);
      signal.addEventListener("abort", end);
      send("retry: 1000\n\n");
    },
    cancel() {
      end();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
  });
}

type RouteHandler = (site: Site, req: Request, url: URL) => Response | Promise<Response>;
type Route = ({ path: string } | { prefix: string }) & { serve: RouteHandler };

// The first matching route serves the request.
const ROUTES: Route[] = [
  { path: "/", serve: (site) => html(indexPage(site)) },
  { path: "/__ping", serve: (site) => Response.json({ app: "keylight-viewer", root: site.root, pid: process.pid }) },
  // Generated, so it comes before the files under /assets/.
  { path: "/assets/theme.css", serve: serveThemeCss },
  { prefix: "/assets/", serve: serveAsset },
  { path: "/events", serve: serveEvents },
  artifactRoute("/view/", serveView),
  artifactRoute("/frag/", serveFragment),
  artifactRoute("/raw/", serveRaw),
];

async function handle(site: Site, req: Request): Promise<Response> {
  // Reject requests addressed to a name we don't serve (DNS rebinding).
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (!site.allowedHosts.has(host)) return new Response("Unknown host", { status: 421 });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const path = url.pathname;
  const route = ROUTES.find((r) => ("path" in r ? path === r.path : path.startsWith(r.prefix)));
  return route ? route.serve(site, req, url) : notFound(site, path);
}

function serveThemeCss(site: Site): Response {
  return new Response(themeCss(site.themes.current()), {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
  });
}

function serveAsset(_site: Site, _req: Request, url: URL): Response {
  const rel = decodePath(url.pathname, "/assets/");
  if (rel === null) return new Response("Bad path", { status: 400 });
  const fromMermaid = rel.startsWith("mermaid/");
  const mermaid = fromMermaid ? mermaidPrefix() : null;
  const abs = fromMermaid
    ? mermaid !== null && rel.startsWith(mermaid) && locate(MERMAID_DIR, rel.slice(mermaid.length))
    : locate(PUBLIC_DIR, rel);
  if (!abs || statSync(abs).isDirectory()) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(abs), {
    headers: { "cache-control": fromMermaid ? "public, max-age=604800" : "no-cache" },
  });
}

function serveEvents(site: Site, req: Request, url: URL): Response {
  const watched = url.searchParams.get("path");
  if (watched === null) return events(site, null, req.signal);
  const abs = locate(site.root, watched);
  if (!abs) return new Response("Not found", { status: 404 });
  return events(site, statSync(abs).isDirectory() ? abs : dirname(abs), req.signal);
}

/** A route for the file or directory named by the path after `prefix`, when it is inside the root. */
function artifactRoute(prefix: string, serve: (site: Site, abs: string) => Response | Promise<Response>): Route {
  return {
    prefix,
    serve: (site, _req, url) => {
      const rel = decodePath(url.pathname, prefix);
      const abs = rel === null ? null : locate(site.root, rel);
      return abs ? serve(site, abs) : notFound(site, rel ?? url.pathname);
    },
  };
}

async function serveView(site: Site, abs: string): Promise<Response> {
  if (statSync(abs).isDirectory()) return html(dirPage(site, abs));
  if (isDocument(abs)) return html(await docPage(site, abs));
  return Response.redirect(`/raw/${urlPath(relative(site.root, abs))}`, 302);
}

async function serveFragment(site: Site, abs: string): Promise<Response> {
  if (!isDocument(abs)) return new Response("Not a document", { status: 400 });
  return Response.json((await docView(site.root, abs)).view, { headers: { "cache-control": "no-store" } });
}

function serveRaw(site: Site, abs: string): Response {
  if (statSync(abs).isDirectory()) return Response.redirect(`/view/${urlPath(relative(site.root, abs))}`, 302);
  const file = Bun.file(abs);
  const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  // HTML, SVG and other XML documents can run their own scripts. Sandboxing
  // the document itself (not just the iframe) keeps them away from the viewer
  // even when opened in their own tab.
  if (/html|xml/.test(file.type)) headers["content-security-policy"] = `sandbox ${EMBED_SANDBOX}`;
  return new Response(file, { headers });
}

if (import.meta.main) {
  // ensureServer starts a detached viewer by running this file, which serves as `keylight serve` does. Imported
  // here, not at the top, because cli/commands imports this module.
  void import("../cli/commands").then(async ({ runCommand }) => {
    process.exitCode = await runCommand(["serve", ...process.argv.slice(2)]);
  });
}
