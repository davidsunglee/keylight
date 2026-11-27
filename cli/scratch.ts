// keylight scratch: the page for visuals a terminal cannot draw.
//
// A session pipes an entry in; it is added at the top of scratch.md in the
// task folder, and the viewer page the user keeps open reloads. Without a
// linked task the page lives in a scratch folder under the artifact root.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./config";
import { currentRepo, currentTask, linkedTasks, storeOf, TaskError, type Repo } from "./task";

export const SCRATCH_FILE = "scratch.md";

export function scratchHome(config: Config, named: string | undefined): { dir: string; label: string } {
  let repo: Repo;
  try {
    repo = currentRepo();
  } catch (err) {
    if (!(err instanceof TaskError)) throw err;
    const name = basename(process.cwd());
    return { dir: join(config.root, "scratch", name), label: name };
  }
  // One task, or the one named: its folder. Several and none named: currentTask says how to choose.
  if (named || linkedTasks(repo).length) {
    const task = currentTask(repo, named);
    return { dir: storeOf(repo, config, task), label: task };
  }
  return { dir: join(config.root, repo.name, "scratch"), label: `${repo.name} (no task)` };
}

function header(label: string): string {
  // Kept short: on a phone the newest entry should start near the top of the screen.
  return `---\ntype: scratch\n---\n\n# Scratch: ${label}\n`;
}

export function addEntry(home: { dir: string; label: string }, text: string): string {
  mkdirSync(home.dir, { recursive: true });
  const path = join(home.dir, SCRATCH_FILE);
  let entry = text.trim();
  if (!/^##\s/.test(entry)) entry = `## ${new Date().toLocaleString()}\n\n${entry}`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : header(home.label);
  // Entries are the page's second-level headings; the newest goes before the first of them.
  const first = current.search(/^## /m);
  const page =
    first === -1
      ? `${current.trimEnd()}\n\n${entry}\n`
      : `${current.slice(0, first)}${entry}\n\n---\n\n${current.slice(first)}`;
  writeFileSync(path, page);
  return path;
}

/** The page's path, created empty when it does not exist yet, so its link works before the first entry. */
export function ensurePage(home: { dir: string; label: string }): string {
  mkdirSync(home.dir, { recursive: true });
  const path = join(home.dir, SCRATCH_FILE);
  if (!existsSync(path)) writeFileSync(path, header(home.label));
  return path;
}
