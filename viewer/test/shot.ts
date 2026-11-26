#!/usr/bin/env bun
// Screenshot one viewer page in headless WebKit, for checking a change by eye.
//
//   bun test/shot.ts <url-path> <out.png> [--port N] [--mobile] [--dark]
//                    [--at CSS] [--full] [--drawer] [--click CSS] [--wait MS]
//                    [--theme NAME] [--menu]

import { devices, webkit } from "playwright";
import { flag } from "../../cli/config";

const argv = process.argv.slice(2);
const [path, out] = argv.filter((a, i) => !a.startsWith("--") && !["--port", "--at", "--click", "--wait", "--theme"].includes(argv[i - 1] ?? ""));
if (!path || !out) throw new Error("usage: bun test/shot.ts <url-path> <out.png>");

const browser = await webkit.launch();
const context = await browser.newContext({
  ...(argv.includes("--mobile") ? devices["iPhone 15"] : { viewport: { width: 1360, height: 900 } }),
  colorScheme: argv.includes("--dark") ? "dark" : "light",
});
const page = await context.newPage();
page.on("pageerror", (err) => console.error(`script error: ${err.message}`));
page.on("console", (msg) => msg.type() === "error" && console.error(`console: ${msg.text()}`));
await page.goto(`http://localhost:${flag(argv, "port") ?? 4747}${path}`, { waitUntil: "load" });

// Pick a theme through the picker, as a person would.
const theme = flag(argv, "theme");
if (theme !== undefined || argv.includes("--menu")) {
  await page.click("#theme-button");
  if (theme !== undefined) await page.click(`[data-theme-choice="${theme}"]`);
  if (!argv.includes("--menu")) await page.keyboard.press("Escape");
}

const at = flag(argv, "at");
if (at) await page.locator(at).first().scrollIntoViewIfNeeded();
if (argv.includes("--drawer")) await page.click("#menu-button");
// Give visible diagrams time to draw.
await page
  .waitForFunction(() => {
    const inView = [...document.querySelectorAll<HTMLElement>(".mermaid-block")].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight;
    });
    return inView.every((b) => b.dataset.state === "done" || b.dataset.state === "error");
  }, { timeout: 15000 })
  .catch(() => console.error("diagrams still rendering"));
const click = flag(argv, "click");
if (click) await page.locator(click).first().click();
await page.waitForTimeout(Number(flag(argv, "wait") ?? 300));
await page.screenshot({ path: out, fullPage: argv.includes("--full") });
await browser.close();
