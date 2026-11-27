// Markdown -> HTML for workflow artifacts.
//
// Everything here runs on the server. The only client-side rendering is
// Mermaid, which needs a real browser layout engine.

import { existsSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import type { RenderRule } from "markdown-it/lib/renderer.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type Token from "markdown-it/lib/token.mjs";

export interface OutlineItem {
  level: number;
  text: string;
  id: string;
  /** The heading folds its section in the document, so the outline folds it too. */
  foldable: boolean;
}

export interface Rendered {
  html: string;
  title: string;
  outline: OutlineItem[];
}

interface Env {
  root: string;
  docDir: string;
  outline: OutlineItem[];
  slugs: Map<string, number>;
}

/** Sandbox for HTML artifacts, both as iframe attribute and as a CSP on the file itself. */
export const EMBED_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

// Language tags agents use that highlight.js names differently.
const LANG_ALIAS: Record<string, string> = {
  jsonc: "json",
  json5: "json",
  just: "makefile",
  make: "makefile",
  cython: "python",
  zsh: "bash",
};
const PLAIN_LANGS = new Set(["", "text", "txt", "plain", "plaintext"]);
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Raw HTML is allowed only for these tags. Agent prose is full of things like
// `Stream<T>` and `<task-slug>`; passing unknown tags through would make that
// text silently vanish, so anything else is shown literally.
const HTML_TAGS = new Set(
  (
    "a abbr b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure " +
    "h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q s samp small source span strong " +
    "sub summary sup table tbody td tfoot th thead tr u ul var wbr"
  ).split(" "),
);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function urlPath(rel: string): string {
  return rel.split(sep).map(encodeURIComponent).join("/");
}

/**
 * Map a reference written in a document to a path relative to the root.
 * Handles relative paths, absolute paths inside the root, and the
 * `.humanlayer/tasks/<slug>/file` style, where the file lives beside the
 * document. Returns null when the target is outside the root.
 */
function resolveRef(ref: string, env: Env): string | null {
  let path = ref.trim();
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw text when it isn't valid percent-encoding.
  }
  if (!path) return null;
  const candidates = [resolve(env.docDir, path), resolve(env.docDir, basename(path))];
  if (path.startsWith("/")) candidates.unshift(path);
  for (const abs of candidates) {
    const rel = relative(env.root, abs);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep) && existsSync(abs)) return rel;
  }
  return null;
}

function headingId(text: string, slugs: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const seen = slugs.get(base) ?? 0;
  slugs.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

function renderDiff(code: string): string {
  return code
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const kind = line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+")
          ? "add"
          : line.startsWith("-")
            ? "del"
            : line.startsWith("~")
              ? "mod"
              : "ctx";
      return `<span class="line ${kind}">${escapeHtml(line) || " "}</span>`;
    })
    .join("");
}

function renderCode(code: string, lang: string): string {
  const label = lang && !PLAIN_LANGS.has(lang) ? ` data-lang="${escapeHtml(lang)}"` : "";
  let body: string;
  if (lang === "diff" || lang === "patch") {
    body = renderDiff(code);
  } else {
    const name = LANG_ALIAS[lang] ?? lang;
    body =
      !PLAIN_LANGS.has(name) && hljs.getLanguage(name)
        ? hljs.highlight(code, { language: name, ignoreIllegals: true }).value
        : escapeHtml(code);
  }
  const cls = lang === "diff" || lang === "patch" ? "code diff" : "code";
  return `<pre class="${cls}"${label}><code>${body}</code></pre>\n`;
}

function renderEmbed(body: string, env: Env): string {
  const refs = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return refs
    .map((ref) => {
      const rel = resolveRef(ref, env);
      const name = escapeHtml(basename(ref));
      if (!rel) return `<p class="embed-missing">Artifact not found: <code>${escapeHtml(ref)}</code></p>\n`;
      const path = urlPath(rel);
      if (IMAGE_EXT.has(extname(rel).toLowerCase())) {
        return `<figure class="embed"><img src="/raw/${path}" alt="${name}"><figcaption>${name}</figcaption></figure>\n`;
      }
      // No allow-same-origin: an embedded artifact can run scripts but cannot
      // reach the viewer or read other artifacts.
      return (
        `<figure class="embed"><iframe class="embed-frame" src="/raw/${path}" title="${name}" loading="lazy" ` +
        `sandbox="${EMBED_SANDBOX}"></iframe>` +
        `<figcaption><a href="/raw/${path}" target="_blank" rel="noopener">${name} &nearr;</a></figcaption></figure>\n`
      );
    })
    .join("");
}

function sanitizeHtml(raw: string): string {
  // Comments carry template instructions, never content.
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "");
  return withoutComments.replace(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g, (tag, name: string) => {
    if (!HTML_TAGS.has(name.toLowerCase())) return escapeHtml(tag);
    // Inline handlers and javascript: URLs are also blocked by the page's CSP.
    return tag.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "").replace(/javascript:/gi, "");
  });
}

function createMarkdown(): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true });
  const fallback: RenderRule = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);

  md.renderer.rules.fence = (tokens, idx, _options, env: Env) => {
    const token = tokens[idx]!;
    const lang = (token.info.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (lang === "mermaid") {
      return `<div class="mermaid-block"><pre class="mermaid-src">${escapeHtml(token.content)}</pre></div>\n`;
    }
    if (lang === "task-artifact") return renderEmbed(token.content, env);
    return renderCode(token.content, lang);
  };
  md.renderer.rules.code_block = (tokens, idx) => renderCode(tokens[idx]!.content, "");

  md.renderer.rules.html_block = (tokens, idx) => sanitizeHtml(tokens[idx]!.content);
  md.renderer.rules.html_inline = (tokens, idx) => sanitizeHtml(tokens[idx]!.content);

  md.renderer.rules.heading_open = (tokens, idx, options, env: Env, self) => {
    const text = (tokens[idx + 1]?.children ?? [])
      .filter((t) => t.type === "text" || t.type === "code_inline")
      .map((t) => t.content)
      .join("");
    const id = headingId(text, env.slugs);
    tokens[idx]!.attrSet("id", id);
    const foldable = Boolean(tokens[idx]!.meta?.foldable);
    env.outline.push({ level: Number(tokens[idx]!.tag.slice(1)), text, id, foldable });
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";

  const linkOpen = md.renderer.rules.link_open ?? fallback;
  md.renderer.rules.link_open = (tokens, idx, options, env: Env, self) => {
    const token = tokens[idx]!;
    const href = token.attrGet("href") ?? "";
    if (URL_SCHEME.test(href)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener");
    } else if (!href.startsWith("#")) {
      const local = viewerHref(href, env);
      if (local) token.attrSet("href", local);
    }
    return linkOpen(tokens, idx, options, env, self);
  };

  const image = md.renderer.rules.image ?? fallback;
  md.renderer.rules.image = (tokens, idx, options, env: Env, self) => {
    const token = tokens[idx]!;
    const src = token.attrGet("src") ?? "";
    if (!URL_SCHEME.test(src)) {
      const rel = resolveRef(src, env);
      if (rel) token.attrSet("src", `/raw/${urlPath(rel)}`);
    }
    return image(tokens, idx, options, env, self);
  };

  // GitHub-style task lists: "- [ ] item" and "- [x] item".
  md.core.ruler.after("inline", "task-lists", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const checked = takeTaskMarker(tokens, i);
      if (checked === null) continue;
      tokens[i]!.children!.unshift(checkbox(state, checked));
      tokens[i - 2]!.attrJoin("class", checked ? "task done" : "task");
    }
  });

  // Every top-level section folds: its heading is the summary, and everything
  // up to the next heading of that level or higher is the body. The top level
  // is the highest one in use below the title.
  md.core.ruler.push("foldable-sections", (state) => {
    const levelOf = (token: Token) =>
      token.type === "heading_open" && token.level === 0 ? Number(token.tag.slice(1)) : 0;
    const top = Math.min(...state.tokens.map(levelOf).filter((level) => level > 1));
    const block = (type: string, tag: string, nesting: 1 | -1): Token => {
      const token = new state.Token(type, tag, nesting) as Token;
      token.block = true;
      return token;
    };
    const out: Token[] = [];
    let open = false;
    state.tokens.forEach((token, i) => {
      const level = levelOf(token);
      if (open && level && level <= top) {
        out.push(block("section_close", "details", -1));
        open = false;
      }
      if (level === top) {
        const details = block("section_open", "details", 1);
        details.attrSet("class", "section");
        details.attrSet("open", "");
        out.push(details, block("section_summary_open", "summary", 1));
        open = true;
        token.meta = { foldable: true };
      }
      out.push(token);
      if (token.type === "heading_close" && state.tokens[i - 2]?.meta?.foldable) {
        out.push(block("section_summary_close", "summary", -1));
      }
    });
    if (open) out.push(block("section_close", "details", -1));
    state.tokens = out;
  });

  const htmlInline = md.renderer.rules.html_inline!;
  md.renderer.rules.html_inline = (tokens, idx, options, env, self) =>
    tokens[idx]!.meta?.trusted ? tokens[idx]!.content : htmlInline(tokens, idx, options, env, self);

  return md;
}

/** Where the viewer serves a link's local target, or null when the target is missing or outside the root. */
function viewerHref(href: string, env: Env): string | null {
  const [path = "", fragment] = href.split("#");
  const rel = resolveRef(path, env);
  if (!rel) return null;
  const prefix = extname(rel).toLowerCase() === ".md" ? "/view/" : "/raw/";
  return prefix + urlPath(rel) + (fragment ? `#${fragment}` : "");
}

/**
 * Whether the list item whose first paragraph is the inline token at `i`
 * starts with a checked or unchecked box, removing the box's text; null when
 * it is not a task item.
 */
function takeTaskMarker(tokens: Token[], i: number): boolean | null {
  const inline = tokens[i]!;
  if (
    inline.type !== "inline" ||
    tokens[i - 1]!.type !== "paragraph_open" ||
    tokens[i - 2]!.type !== "list_item_open"
  ) {
    return null;
  }
  const first = inline.children?.[0];
  const match = first?.type === "text" ? /^\[([ xX])\]\s+/.exec(first.content) : null;
  if (!first || !match) return null;
  first.content = first.content.slice(match[0].length);
  return match[1] !== " ";
}

function checkbox(state: StateCore, checked: boolean): Token {
  const box = new state.Token("html_inline", "", 0);
  box.content = `<input type="checkbox" disabled${checked ? " checked" : ""}> `;
  // Marked trusted so the sanitizer's tag list doesn't need to include input.
  box.meta = { trusted: true };
  return box;
}

const md = createMarkdown();

function renderFrontmatter(data: Record<string, unknown>): string {
  const show = (v: unknown): string =>
    Array.isArray(v) ? v.map(String).join(", ") : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
  const summary = ["type", "status", "branch", "date"]
    .filter((k) => data[k] !== undefined && data[k] !== null)
    .map((k) => `<span class="chip">${escapeHtml(show(data[k]))}</span>`)
    .join("");
  const rows = Object.entries(data)
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(show(v))}</td></tr>`)
    .join("");
  return `<details class="frontmatter"><summary>${summary || "Frontmatter"}</summary><table>${rows}</table></details>\n`;
}

function splitFrontmatter(source: string): { data: Record<string, unknown> | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { data: null, body: source };
  try {
    const data = Bun.YAML.parse(match[1]!);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return { data: data as Record<string, unknown>, body: source.slice(match[0].length) };
    }
  } catch {
    // Not valid YAML: treat the block as ordinary content.
  }
  return { data: null, body: source };
}

export function renderMarkdown(source: string, file: string, root: string): Rendered {
  const { data, body } = splitFrontmatter(source);
  const env: Env = { root, docDir: dirname(file), outline: [], slugs: new Map() };
  const content = md.render(body, env);
  const title = env.outline.find((h) => h.level === 1)?.text ?? basename(file);
  return { html: (data ? renderFrontmatter(data) : "") + content, title, outline: env.outline };
}
