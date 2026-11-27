#!/usr/bin/env bun
// Rendering check against a running viewer, in headless WebKit (the engine
// behind Safari on Mac and iPhone).
//
// Opens every document that contains a Mermaid block (every document with
// --all), renders each diagram, and reports any that fail or never appear, plus
// a document route that answers other than 200 (a redirect included), artifacts
// not found or not loading, script errors and layout overflow. Exits 1 on any
// issue or when no document matches.
//
//   bun viewer/test/render-check.ts --root DIR [--port N] [--limit N] [--match TEXT]
//                                   [--shots DIR] [--mobile] [--all]

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import MarkdownIt from "markdown-it";
import { devices, webkit } from "playwright";
import { flag, loadConfig } from "../../cli/config";
import { splitFrontmatter } from "../frontmatter";
import { urlPath } from "../render";

const argv = process.argv.slice(2);
const config = loadConfig(argv);
const limit = Number(flag(argv, "limit") ?? Infinity);
const match = flag(argv, "match");
const shots = flag(argv, "shots");
const mobile = argv.includes("--mobile");
const all = argv.includes("--all"); // Include documents without diagrams.

function findDocs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) findDocs(abs, out);
    else if (/\.mdx?$/i.test(entry.name)) out.push(abs);
  }
  return out;
}

// Counted with plain markdown-it rather than the viewer's renderer, so a fence
// the viewer stops turning into a diagram shows up as a missing one.
const parser = new MarkdownIt({ html: true });
function mermaidFences(file: string): number {
  return parser
    .parse(splitFrontmatter(readFileSync(file, "utf8")).body, {})
    .filter((t) => t.type === "fence" && t.info.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid").length;
}

// Diagrams and embeds load only once on screen, which a closed <details> prevents. Each is
// revealed just before its own check, because opening one panel of a named group closes the rest.
function reveal(el: Element) {
  for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
}

const docs: { file: string; fences: number }[] = [];
// Newest first, reading only as many files as the selection needs.
for (const file of findDocs(config.root)
  .filter((f) => !match || f.includes(match))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)) {
  if (docs.length >= limit) break;
  const fences = mermaidFences(file);
  if (all || fences > 0) docs.push({ file, fences });
}

if (docs.length === 0) {
  console.log(`No documents matched under ${config.root}.`);
  process.exit(1);
}

if (shots) mkdirSync(shots, { recursive: true });

const browser = await webkit.launch();
const context = await browser.newContext(
  mobile ? { ...devices["iPhone 15"] } : { viewport: { width: 1360, height: 900 } },
);

let diagrams = 0;
let failed = 0;
let docsWithIssues = 0;
const failures: string[] = [];

for (const [i, { file, fences }] of docs.entries()) {
  const rel = relative(config.root, file);
  const page = await context.newPage();
  const issues: string[] = [];
  page.on("pageerror", (err) => issues.push(`script error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") issues.push(`console: ${msg.text().slice(0, 200)}`);
  });
  const frameStatuses = new Map<string, number>();
  page.on("response", (r) => {
    if (r.request().isNavigationRequest() && r.frame() !== page.mainFrame()) frameStatuses.set(r.url(), r.status());
  });

  const response = await page.goto(`http://localhost:${config.port}/view/${urlPath(rel)}`, { waitUntil: "load" });
  // goto resolves with the response at the end of any redirects; the document route itself must answer.
  let request = response?.request() ?? null;
  while (request?.redirectedFrom()) request = request.redirectedFrom();
  const status = (await request?.response())?.status();
  if (status !== 200) issues.push(`HTTP ${status ?? "no response"}`);
  const disclosures = await page.evaluate(() => [...document.querySelectorAll("details")].map((d) => d.open));
  // Embedded artifacts load lazily, so each frame is scrolled to before its response is checked.
  for (const embed of await page.locator("iframe.embed-frame").all()) {
    const src = await embed.evaluate((el: HTMLIFrameElement) => el.src);
    await embed.evaluate(reveal);
    await embed.scrollIntoViewIfNeeded();
    const frameStatus =
      frameStatuses.get(src) ??
      (await page.waitForResponse(src, { timeout: 15000 }).then(
        (r) => r.status(),
        () => undefined,
      ));
    if (frameStatus !== 200) issues.push(`embedded artifact ${src}: HTTP ${frameStatus ?? "no response"}`);
  }
  const errors: string[] = [];
  const blocks = await page.locator(".mermaid-block").all();
  for (const block of blocks) {
    await block.evaluate(reveal);
    const error = await block.evaluate(async (el: HTMLElement) => {
      el.scrollIntoView();
      const started = Date.now();
      while (!["done", "error"].includes(el.dataset.state ?? "") && Date.now() - started < 15000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return el.dataset.state === "done" ? null : (el.querySelector(".mermaid-error")?.textContent ?? "timed out");
    });
    if (error !== null) errors.push(error);
  }
  // The overflow check and screenshot see the disclosures as the document left them.
  await page.evaluate((open) => {
    for (const [i, d] of document.querySelectorAll("details").entries()) d.open = open[i] ?? d.open;
  }, disclosures);
  const result = await page.evaluate(() => {
    window.scrollTo(0, 0);
    return {
      missingArtifacts: [...document.querySelectorAll(".embed-missing")].map((el) => el.textContent ?? ""),
      // The page itself must never scroll sideways; wide content scrolls inside its own box.
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  const absent = Math.max(0, fences - blocks.length);
  diagrams += blocks.length + absent;
  failed += errors.length + absent;
  for (const e of errors) issues.push(e);
  if (absent) issues.push(`${absent} of ${fences} Mermaid fences rendered no diagram`);
  for (const text of result.missingArtifacts) issues.push(text);
  if (result.overflow > 1) issues.push(`page overflows horizontally by ${result.overflow}px`);
  if (issues.length) {
    docsWithIssues++;
    failures.push(`${rel}\n${[...new Set(issues)].map((x) => `    ${x}`).join("\n")}`);
  }
  if (shots) {
    await page.screenshot({
      path: join(shots, `${String(i + 1).padStart(3, "0")}-${mobile ? "mobile" : "desktop"}.png`),
    });
  }
  await page.close();
  if ((i + 1) % 25 === 0) console.error(`  ${i + 1}/${docs.length} documents`);
}

await browser.close();

console.log(
  `${docs.length} documents, ${diagrams} diagrams, ${failed} failed to render (${mobile ? "iPhone 15" : "desktop"} WebKit)`,
);
console.log(`${docsWithIssues} documents with issues`);
if (failures.length) console.log(`\n${failures.join("\n")}`);
process.exit(failed || docsWithIssues ? 1 : 0);
