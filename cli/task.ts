// fathom task: the task folder for the current worktree.
//
// A task's documents live in the artifact root, outside any repository:
//
//   <root>/<repo>/<task>/
//
// and each worktree working on the task reaches them through one symlink:
//
//   <worktree>/.artifacts/tasks/<task>  ->  <root>/<repo>/<task>
//
// The link is ignored through the repository's info/exclude, so nothing about
// it is ever committed.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Config } from "./config";

export const LINK_DIR = join(".artifacts", "tasks");
const EXCLUDE_LINE = "/.artifacts/";
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

export const TASK_USAGE = [
  "fathom task                      show the task linked to this worktree and its files",
  "fathom task new <task>           create the task folder (or reuse it) and link it here",
  "fathom task list                 tasks stored for this repository",
  "fathom task next <kind> <slug>   path for the next numbered document, e.g. next tdd retry-policy",
  "",
  "A shared checkout can have several tasks linked. Name the one you mean with",
  "--task <task> (or FATHOM_TASK) on `fathom task` and `fathom task next`.",
].join("\n");

export class TaskError extends Error {}

export function git(args: string[], cwd?: string): string | null {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore", cwd });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

export interface Repo {
  /** Root of the current worktree. */
  worktree: string;
  /** Name shared by every worktree of the repository. */
  name: string;
}

export function currentRepo(dir?: string): Repo {
  const worktree = git(["rev-parse", "--show-toplevel"], dir);
  if (!worktree) throw new TaskError("not inside a git repository");
  // Worktrees share one common git directory; its parent names the repository.
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  const name = common && basename(common) === ".git" ? basename(dirname(common)) : basename(worktree);
  return { worktree, name };
}

/** Tasks linked into this worktree: one in a task's own worktree, possibly several in a shared checkout. */
export function linkedTasks(repo: Repo): string[] {
  const dir = join(repo.worktree, LINK_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && existsSync(join(dir, name)))
    .sort();
}

export function currentTask(repo: Repo, named: string | undefined): string {
  const linked = linkedTasks(repo);
  if (named) {
    if (linked.includes(named)) return named;
    throw new TaskError(`task "${named}" is not linked to this worktree.\nLink it:  fathom task new ${named}`);
  }
  if (linked.length === 1) return linked[0]!;
  if (linked.length === 0) {
    throw new TaskError(
      `no task is linked to this worktree.\n` +
        `Link an existing one or create one:  fathom task new <task>\n` +
        `Tasks stored for ${repo.name}:        fathom task list`,
    );
  }
  throw new TaskError(
    `several tasks are linked to this worktree:\n${linked.map((name) => `  ${name}`).join("\n")}\n` +
      `Name the one you mean by adding:  --task <task>`,
  );
}

/** Path as the caller should use it: relative to where they are standing. */
function show(path: string): string {
  return relative(process.cwd(), path) || ".";
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function printTask(repo: Repo, config: Config, task: string) {
  const link = join(repo.worktree, LINK_DIR, task);
  const files = listFiles(link);
  console.log(`task   ${task}`);
  console.log(`dir    ${show(link)}`);
  console.log(`store  ${join(config.root, repo.name, task)}`);
  console.log(files.length ? `files\n${files.map((f) => `  ${f}`).join("\n")}` : "files  (none yet)");
}

function ensureExcluded(repo: Repo) {
  const path = git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], repo.worktree);
  if (!path) return;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split("\n").some((line) => line.trim() === EXCLUDE_LINE)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
}

/** Where a task's documents are stored. */
export function storeOf(repo: Repo, config: Config, task: string): string {
  return join(config.root, repo.name, task);
}

export function slugError(task: string): string | null {
  return SLUG.test(task) ? null : `"${task}" is not a valid task name: use lowercase letters, digits and dashes`;
}

/**
 * Create the task folder if needed and link it into the repo's worktree.
 * `summary` is the text for a new task.md; an existing one is kept.
 */
export function ensureTask(repo: Repo, config: Config, task: string, summary?: string): { store: string; isNew: boolean } {
  const problem = slugError(task);
  if (problem) throw new TaskError(problem);
  const store = storeOf(repo, config, task);
  const isNew = !existsSync(store);
  mkdirSync(store, { recursive: true });
  const file = join(store, "task.md");
  if (!existsSync(file)) {
    const created = new Date().toISOString().slice(0, 10);
    writeFileSync(
      file,
      summary ??
        `---\ntask: ${task}\nrepo: ${repo.name}\ncreated: ${created}\n---\n\n# ${task}\n\n` +
          `[What this task is: a link to the ticket, or a few sentences describing the ask.]\n`,
    );
  }

  const link = join(repo.worktree, LINK_DIR, task);
  if (!existsSync(link)) {
    // A dangling link left behind (the store moved) is not replaced silently.
    if (lstatSync(link, { throwIfNoEntry: false })) throw new TaskError(`${show(link)} exists but points nowhere; remove it and retry`);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(store, link, "dir");
  }
  ensureExcluded(repo);
  return { store, isNew };
}

function newTask(repo: Repo, config: Config, task: string | undefined) {
  if (!task) throw new TaskError("usage: fathom task new <task>   e.g. cor-310-page-offset");
  const { isNew } = ensureTask(repo, config, task);
  console.log(isNew ? `Created task ${task}.` : `Linked existing task ${task}.`);
  printTask(repo, config, task);
}

function listTasks(repo: Repo, config: Config) {
  const dir = join(config.root, repo.name);
  const linked = new Set(linkedTasks(repo));
  const tasks = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, mtime: statSync(join(dir, entry.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    : [];
  if (!tasks.length) return console.log(`No tasks stored for ${repo.name} under ${config.root}.`);
  for (const task of tasks) {
    const day = new Date(task.mtime).toISOString().slice(0, 10);
    console.log(`${day}  ${task.name}${linked.has(task.name) ? "  (linked here)" : ""}`);
  }
}

function nextDocument(repo: Repo, named: string | undefined, kind: string | undefined, slug: string | undefined) {
  if (!kind || !slug || !SLUG.test(kind) || !SLUG.test(slug)) {
    throw new TaskError("usage: fathom task next <kind> <slug>   e.g. fathom task next tdd retry-policy");
  }
  const link = join(repo.worktree, LINK_DIR, currentTask(repo, named));
  const numbers = readdirSync(link).map((name) => Number(/^(\d+)-/.exec(name)?.[1] ?? 0));
  const next = String(Math.max(0, ...numbers) + 1).padStart(2, "0");
  console.log(show(join(link, `${next}-${kind}-${slug}.md`)));
}

/** `args` are the positional arguments after `task`; `named` is --task or FATHOM_TASK. Returns the exit status. */
export function taskCommand(args: string[], config: Config, named: string | undefined): number {
  try {
    const [sub, ...rest] = args;
    const repo = currentRepo();
    if (!sub || sub === "show") printTask(repo, config, currentTask(repo, named));
    else if (sub === "new") newTask(repo, config, rest[0]);
    else if (sub === "list") listTasks(repo, config);
    else if (sub === "next") nextDocument(repo, named, rest[0], rest[1]);
    else throw new TaskError(`unknown subcommand "${sub}".\n${TASK_USAGE}`);
    return 0;
  } catch (err) {
    if (!(err instanceof TaskError)) throw err;
    console.error(`fathom task: ${err.message}`);
    return 1;
  }
}
