#!/usr/bin/env bun
// Rendering check against real artifacts, in headless WebKit (the engine
// behind Safari on Mac and iPhone).
//
// Opens every document that contains a Mermaid block, renders each diagram,
// and reports any that fail, plus script errors and layout overflow.
//
//   bun test/parity.ts --root DIR [--port N] [--limit N] [--match TEXT]
//                      [--shots DIR] [--mobile]

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { devices, webkit } from "playwright";
import { flag, loadConfig } from "../../cli/config";
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
    else if (entry.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

const docs = findDocs(config.root)
  .filter((f) => !match || f.includes(match))
  .filter((f) => all || /^\s*```mermaid/m.test(readFileSync(f, "utf8")))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, limit);

if (shots) mkdirSync(shots, { recursive: true });

const browser = await webkit.launch();
const context = await browser.newContext(
  mobile ? { ...devices["iPhone 15"] } : { viewport: { width: 1360, height: 900 } },
);

let diagrams = 0;
let failed = 0;
let docsWithIssues = 0;
const failures: string[] = [];

for (const [i, file] of docs.entries()) {
  const rel = relative(config.root, file);
  const page = await context.newPage();
  const issues: string[] = [];
  page.on("pageerror", (err) => issues.push(`script error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") issues.push(`console: ${msg.text().slice(0, 200)}`);
  });

  await page.goto(`http://localhost:${config.port}/view/${urlPath(rel)}`, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const blocks = [...document.querySelectorAll<HTMLElement>(".mermaid-block")];
    const errors: string[] = [];
    for (const block of blocks) {
      block.scrollIntoView();
      const started = Date.now();
      while (!["done", "error"].includes(block.dataset.state ?? "") && Date.now() - started < 15000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (block.dataset.state !== "done") {
        errors.push(block.querySelector(".mermaid-error")?.textContent ?? "timed out");
      }
    }
    window.scrollTo(0, 0);
    return {
      total: blocks.length,
      errors,
      // The page itself must never scroll sideways; wide content scrolls inside its own box.
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  diagrams += result.total;
  failed += result.errors.length;
  for (const e of result.errors) issues.push(e);
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
