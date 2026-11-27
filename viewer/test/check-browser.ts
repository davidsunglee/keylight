#!/usr/bin/env bun
// The browser gate: starts a viewer over the committed fixtures on a spare
// port, runs render-check.ts at desktop and iPhone 15 widths against it, and
// stops the viewer whatever the outcome. Takes no arguments.
//
//   bun run check:browser

import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { freePort } from "./support";

const repo = join(import.meta.dir, "..", "..");
const root = join(import.meta.dir, "fixtures");
const port = await freePort();
// An empty config directory keeps the developer's own themes out of the result.
const configDir = mkdtempSync(join(tmpdir(), "keylight-check-browser-"));
const viewerArgs = ["--root", root, "--port", String(port), "--config", configDir];

let current: Subprocess | undefined;
let interrupted: NodeJS.Signals | undefined;
// The viewer runs detached and outlives this script, so an interrupt ends the
// current step and falls through to the stop below instead of exiting here.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = signal;
    current?.kill(signal);
  });
}

function spawn(args: string[], detached = false): Subprocess {
  return Bun.spawn([process.execPath, ...args], { cwd: repo, stdio: ["ignore", "inherit", "inherit"], detached });
}

async function run(args: string[]): Promise<number> {
  current = spawn(args);
  const status = await current.exited;
  current = undefined;
  return status;
}

function keylight(command: string, ...args: string[]): string[] {
  return [join(repo, "cli", "keylight.ts"), command, ...args, ...viewerArgs];
}

const passes = [
  { name: "desktop", args: [] },
  { name: "iPhone 15", args: ["--mobile"] },
];
const failed: string[] = [];

try {
  if ((await run(keylight("view", "--no-open"))) !== 0) {
    failed.push("viewer start");
  } else {
    for (const pass of passes) {
      if (interrupted) break;
      console.log(`\n${pass.name}`);
      const status = await run([join(import.meta.dir, "render-check.ts"), ...viewerArgs, "--all", ...pass.args]);
      if (status !== 0) failed.push(pass.name);
    }
  }
} finally {
  // Its own process group and no forwarded signal, so a second interrupt cannot
  // cut short the stop the first one started.
  if ((await spawn(keylight("stop"), true).exited) !== 0) failed.push("viewer stop");
  rmSync(configDir, { recursive: true, force: true });
}

if (interrupted) {
  console.log(`\ncheck:browser interrupted by ${interrupted}`);
  process.exit(128 + constants.signals[interrupted]);
}
console.log(failed.length ? `\ncheck:browser failed: ${failed.join(", ")}` : "\ncheck:browser passed");
process.exit(failed.length ? 1 : 0);
