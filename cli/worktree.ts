// The worktree step: an isolated checkout for a task, with the task folder
// linked into it. Settings come from the repository:
//
//   .keylight/workspace.json         shared
//   .keylight/workspace.local.json   local overrides
//
// With neither, an earlier .humanlayer/workspace.json is read, and failing
// that the defaults below apply. Nothing is written to the repository.

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Config } from "./config";
import { ensureTask, git, type Repo, TaskError } from "./task";

interface RepoEntry {
  localPath: string;
  sourceRef?: string;
  setupCommand?: string;
  copyGlobs?: string[];
}

interface Workspace {
  disabled?: boolean;
  pathTemplate: string;
  branchTemplate: string;
  repos: RepoEntry[];
}

const DEFAULTS: Workspace = {
  disabled: false,
  pathTemplate: "~/.keylight/workspaces/{{ TASKSLUG }}/{{ REPOBASENAME }}",
  branchTemplate: "{{ TASKSLUG }}",
  repos: [
    {
      localPath: ".",
      sourceRef: "HEAD",
      setupCommand: "",
      copyGlobs: [
        ".env*",
        ".claude/settings.local.json",
        "CLAUDE.local.md",
        "AGENTS.local.md",
        ".keylight/workspace.local.json",
      ],
    },
  ],
};

export interface Worktree {
  path: string;
  /** Commit the work starts from: the fixed point for review. */
  base: string;
  notes: string[];
}

function readJson(path: string): Partial<Workspace> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<Workspace>;
  } catch (err) {
    throw new TaskError(`${path}: ${(err as Error).message}`);
  }
}

function readWorkspace(checkout: string): Workspace {
  const shared = join(checkout, ".keylight", "workspace.json");
  const local = join(checkout, ".keylight", "workspace.local.json");
  const earlier = join(checkout, ".humanlayer", "workspace.json");
  let settings: Partial<Workspace> = {};
  if (existsSync(shared)) settings = readJson(shared);
  else if (existsSync(earlier)) {
    settings = readJson(earlier);
    if (settings.pathTemplate)
      settings.pathTemplate = settings.pathTemplate.replace("~/.humanlayer/workspaces", "~/.keylight/workspaces");
  }
  if (existsSync(local)) settings = { ...settings, ...readJson(local) };
  return { ...DEFAULTS, ...settings, repos: settings.repos?.length ? settings.repos : DEFAULTS.repos };
}

function fill(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole)
    .replace(/^~(?=\/|$)/, homedir());
}

function gitOrFail(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new TaskError(`git ${args.join(" ")} failed:\n${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function copyLocalFiles(from: string, to: string, globs: string[]): number {
  let copied = 0;
  for (const pattern of globs) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: from, dot: true, onlyFiles: true })) {
      if (file.startsWith(".git/")) continue;
      mkdirSync(dirname(join(to, file)), { recursive: true });
      cpSync(join(from, file), join(to, file));
      copied++;
    }
  }
  return copied;
}

function headOf(checkout: string): string {
  return gitOrFail(["rev-parse", "HEAD"], checkout);
}

/** A linked worktree's git directory sits under the main checkout's `.git/worktrees/`. */
function isLinkedWorktree(checkout: string): boolean {
  return (git(["rev-parse", "--git-dir"], checkout) ?? "").includes("/worktrees/");
}

function branchExists(branch: string, checkout: string): boolean {
  return git(["show-ref", "--verify", `refs/heads/${branch}`], checkout) !== null;
}

/** A new worktree of `source` at `path` on `branch`, with its local files and setup. Returns what was done. */
function createCheckout(entry: RepoEntry, source: string, path: string, branch: string): string[] {
  gitOrFail(
    branchExists(branch, source)
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, entry.sourceRef || "HEAD"],
    source,
  );
  const copied = copyLocalFiles(source, path, entry.copyGlobs ?? []);
  const notes = [
    `created ${path} on branch ${branch}${copied ? `, copied ${copied} local file${copied === 1 ? "" : "s"}` : ""}`,
  ];
  if (!entry.setupCommand) return notes;
  notes.push(`ran: ${entry.setupCommand}`);
  const setup = Bun.spawnSync(["sh", "-c", entry.setupCommand], { cwd: path, stdio: ["ignore", "inherit", "inherit"] });
  if (setup.exitCode !== 0) throw new TaskError(`setup command failed in ${path}: ${entry.setupCommand}`);
  return notes;
}

/** A checkout for every repository the workspace lists. Returns the path of the repository's own. */
function createCheckouts(
  workspace: Workspace,
  checkout: string,
  task: string,
  branch: string,
  notes: string[],
): string {
  let primary: string | null = null;
  for (const entry of workspace.repos) {
    const source = resolve(checkout, entry.localPath);
    const path = fill(workspace.pathTemplate, { TASKSLUG: task, REPOBASENAME: basename(source) });
    if (existsSync(path)) {
      if (git(["rev-parse", "--show-toplevel"], path) === null)
        throw new TaskError(`${path} exists and is not a git checkout`);
      notes.push(`reusing ${path}`);
    } else {
      notes.push(...createCheckout(entry, source, path, branch));
    }
    if (resolve(source) === resolve(checkout)) primary = path;
  }
  if (!primary) throw new TaskError(`workspace settings need a repos entry with "localPath": "."`);
  return primary;
}

export function setupWorktree(repo: Repo, config: Config, task: string): Worktree {
  const checkout = repo.worktree;
  const notes: string[] = [];

  // Already in a task's own worktree: the work happens here.
  if (isLinkedWorktree(checkout)) {
    notes.push(`already in a worktree; using ${checkout}`);
    return { path: checkout, base: headOf(checkout), notes };
  }

  const workspace = readWorkspace(checkout);
  const branch = fill(workspace.branchTemplate, { TASKSLUG: task, REPOBASENAME: repo.name });
  if (workspace.disabled) {
    gitOrFail(branchExists(branch, checkout) ? ["checkout", branch] : ["checkout", "-b", branch], checkout);
    notes.push(`worktrees are disabled for this repository; checked out branch ${branch} in place`);
    return { path: checkout, base: headOf(checkout), notes };
  }

  const primary = createCheckouts(workspace, checkout, task, branch, notes);
  ensureTask({ worktree: primary, name: repo.name }, config, task);
  return { path: primary, base: headOf(primary), notes };
}
