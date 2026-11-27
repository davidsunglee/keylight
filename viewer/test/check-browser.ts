#!/usr/bin/env bun
// The browser gate: starts a viewer over the committed fixtures on a spare
// port, runs render-check.ts at desktop and iPhone 15 widths against it, and
// stops the viewer whatever the outcome. Takes no arguments.
//
//   bun run check:browser

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./support";

const repo = join(import.meta.dir, "..", "..");
const root = join(import.meta.dir, "fixtures");
const port = await freePort();
// An empty config directory keeps the developer's own themes out of the result.
const configDir = mkdtempSync(join(tmpdir(), "keylight-check-browser-"));
const viewerArgs = ["--root", root, "--port", String(port), "--config", configDir];

async function run(args: string[]): Promise<number> {
  const child = Bun.spawn([process.execPath, ...args], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
  return await child.exited;
}

function keylight(command: string, ...args: string[]): Promise<number> {
  return run([join(repo, "cli", "keylight.ts"), command, ...args, ...viewerArgs]);
}

const passes = [
  { name: "desktop", args: [] },
  { name: "iPhone 15", args: ["--mobile"] },
];
const failed: string[] = [];

try {
  if ((await keylight("view", "--no-open")) !== 0) {
    failed.push("viewer start");
  } else {
    for (const pass of passes) {
      console.log(`\n${pass.name}`);
      const status = await run([join(import.meta.dir, "render-check.ts"), ...viewerArgs, "--all", ...pass.args]);
      if (status !== 0) failed.push(pass.name);
    }
  }
} finally {
  await keylight("stop");
  rmSync(configDir, { recursive: true, force: true });
}

console.log(failed.length ? `\ncheck:browser failed: ${failed.join(", ")}` : "\ncheck:browser passed");
process.exit(failed.length ? 1 : 0);
