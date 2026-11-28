// Fixtures for the CLI's tests. Each changes process state (working
// directory, environment, terminal, output) and undoes it when disposed, so a
// test holds one with `using` and the next test starts clean.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import type { Subprocess } from "bun";
import { runCommand } from "../commands";
import { ensureTask } from "../task";
import type { Act, Launch } from "./fakes/harness";
import { home as homeDir, removeAfterRun, terminal } from "./preload";

export const ENTRY = join(import.meta.dir, "..", "keylight.ts");
/** Recorded Claude Code transcripts, sanitized. */
export const FIXTURES = join(import.meta.dir, "fixtures");

export interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "keylight-test-")));
}

/** An empty directory, removed with everything in it when disposed. */
export function tempDir(): Disposable & { path: string } {
  const path = makeTempDir();
  return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
}

/** Sets or removes environment variables until disposed. */
export function scopedEnv(vars: Record<string, string | undefined>): Disposable {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  return { [Symbol.dispose]: () => apply(saved) };
}

/** A git command for building fixtures, reading no git settings or overrides from the developer's environment. */
export function git(cwd: string, ...args: string[]): string {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && key !== "XDG_CONFIG_HOME");
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...Object.fromEntries(inherited), HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

let template: string | undefined;

/** A repository with one empty commit, built once and copied for each fixture, because git is slow to start. */
function copyRepository(to: string) {
  if (!template) {
    const dir = makeTempDir();
    removeAfterRun.push(dir);
    git(dir, "init", "-q", "-b", "main");
    git(
      dir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    template = dir;
  }
  cpSync(template, to, { recursive: true });
}

export interface StandInViewer extends Disposable {
  port: number;
  /** A sleeping child the viewer reports as its own, so `keylight stop` has a process to end. */
  process: Subprocess;
}

/** Answers /__ping as a keylight viewer serving `root`, so no test starts a real one by accident. */
export function standInViewer(root: string): StandInViewer {
  const sleeper = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/__ping"
        ? Response.json({ app: "keylight-viewer", root, pid: sleeper.pid })
        : new Response("Not found", { status: 404 }),
  });
  return {
    port: server.port ?? 0,
    process: sleeper,
    [Symbol.dispose]: () => {
      server.stop(true);
      sleeper.kill();
    },
  };
}

export interface TempRepo extends Disposable {
  /** The repository's checkout, and the working directory while the fixture lives. */
  worktree: string;
  name: string;
  root: string;
  configDir: string;
  viewer: StandInViewer;
  /** A scratch directory beside the repository, for anything a test needs outside it. */
  outside: string;
  /** The home directory while the fixture lives. */
  home: string;
  store(task: string): string;
}

/**
 * A repository with one empty commit, its own artifact root, config and home
 * directories, and a stand-in viewer on KEYLIGHT_PORT. `tasks` are created and
 * linked as `keylight task new` would.
 */
export function tempRepo(options: { tasks?: string[] } = {}): TempRepo {
  const base = makeTempDir();
  const name = "demo-repo";
  const worktree = join(base, name);
  const root = join(base, "artifacts");
  const configDir = join(base, "config");
  const outside = join(base, "outside");
  const home = join(base, "home");
  for (const dir of [root, configDir, outside, home]) mkdirSync(dir, { recursive: true });
  copyRepository(worktree);
  const viewer = standInViewer(root);
  const env = scopedEnv({
    KEYLIGHT_ROOT: root,
    KEYLIGHT_CONFIG: configDir,
    KEYLIGHT_PORT: String(viewer.port),
    KEYLIGHT_PUBLIC_URL: undefined,
    KEYLIGHT_TASK: undefined,
    KEYLIGHT_TASK_DIR: undefined,
    KEYLIGHT_STEP: undefined,
    KEYLIGHT_WORKTREE: undefined,
    KEYLIGHT_BASE: undefined,
    XDG_CONFIG_HOME: undefined,
    LINEAR_API_KEY: undefined,
  });
  const cwd = process.cwd();
  process.chdir(worktree);
  const savedHome = homeDir.path;
  homeDir.path = home;
  const fixture: TempRepo = {
    worktree,
    name,
    root,
    configDir,
    viewer,
    outside,
    home,
    store: (task) => join(root, name, task),
    [Symbol.dispose]: () => {
      process.chdir(cwd);
      homeDir.path = savedHome;
      env[Symbol.dispose]();
      viewer[Symbol.dispose]();
      rmSync(base, { recursive: true, force: true });
    },
  };
  try {
    const config = { root, port: viewer.port, publicUrl: null, configDir };
    for (const task of options.tasks ?? []) ensureTask({ worktree, name }, config, task);
  } catch (err) {
    fixture[Symbol.dispose]();
    throw err;
  }
  return fixture;
}

export interface FakeHarness extends Disposable {
  /** Where an interactive Codex session is filed (CODEX_HOME). */
  codexHome: string;
  /** What the fakes do for each step, one Act per launch in order. Replaces the plan's unused acts. */
  plan(acts: Record<string, Act[]>): void;
  /** Every launch so far, oldest first. */
  launches(): Launch[];
  /** What `<command> --help` prints, for a command such as "claude" or "codex exec". */
  help(command: string, text: string): void;
}

/** Puts fake `claude` and `codex` executables first on PATH until disposed. See fakes/harness.ts. */
export function fakeHarness(): FakeHarness {
  const dir = makeTempDir();
  const codexHome = join(dir, "codex");
  const env = scopedEnv({
    PATH: `${join(import.meta.dir, "fakes")}:${process.env.PATH}`,
    FAKE_HARNESS_DIR: dir,
    CODEX_HOME: codexHome,
    CLAUDE_CODE_SUBAGENT_MODEL: undefined,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: undefined,
    CLAUDE_CODE_SUBAGENT_EFFORT: undefined,
  });
  const launches = join(dir, "launches.jsonl");
  return {
    codexHome,
    plan: (acts) => writeFileSync(join(dir, "plan.json"), JSON.stringify(acts)),
    launches: () =>
      existsSync(launches)
        ? readFileSync(launches, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Launch)
        : [],
    help: (command, text) => {
      mkdirSync(join(dir, "help"), { recursive: true });
      writeFileSync(join(dir, "help", `${command}.txt`), text);
    },
    [Symbol.dispose]: () => {
      env[Symbol.dispose]();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every stream reports a terminal, and each question takes the next of `answers`. */
export function atTerminal(answers: (string | null)[] = []): Disposable & { questions: string[]; menus: string[][] } {
  const streams = [process.stdin, process.stdout, process.stderr];
  const saved = {
    isTTY: streams.map((stream) => stream.isTTY),
    answers: terminal.answers,
    questions: terminal.questions,
    menus: terminal.menus,
  };
  for (const stream of streams) Object.assign(stream, { isTTY: true });
  terminal.answers = [...answers];
  terminal.questions = [];
  terminal.menus = [];
  return {
    questions: terminal.questions,
    menus: terminal.menus,
    [Symbol.dispose]: () => {
      for (const [i, stream] of streams.entries()) Object.assign(stream, { isTTY: saved.isTTY[i] });
      terminal.answers = saved.answers;
      terminal.questions = saved.questions;
      terminal.menus = saved.menus;
    },
  };
}

/** Standard input holds `text` and then ends, as when a command is piped into. */
export function pipedStdin(text: string): Disposable {
  const saved = Bun.stdin;
  Object.assign(Bun, { stdin: new Blob([text]) });
  return { [Symbol.dispose]: () => Object.assign(Bun, { stdin: saved }) };
}

/** Runs `action` with console and stream output captured instead of printed. */
async function captured(action: () => number | Promise<number>): Promise<Output> {
  const out: string[] = [];
  const err: string[] = [];
  const saved = {
    log: console.log,
    info: console.info,
    error: console.error,
    warn: console.warn,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  const into =
    (sink: string[]) =>
    (...args: unknown[]) => {
      sink.push(`${format(...args)}\n`);
    };
  const writeInto = (sink: string[]) => (chunk: string | Uint8Array) => {
    sink.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  Object.assign(console, { log: into(out), info: into(out), error: into(err), warn: into(err) });
  Object.assign(process.stdout, { write: writeInto(out) });
  Object.assign(process.stderr, { write: writeInto(err) });
  try {
    const code = await action();
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    Object.assign(console, { log: saved.log, info: saved.info, error: saved.error, warn: saved.warn });
    Object.assign(process.stdout, { write: saved.stdout });
    Object.assign(process.stderr, { write: saved.stderr });
  }
}

/** Runs the installed entry as a separate process, in this process's working directory and environment. */
export async function spawnKeylight(
  argv: string[],
  options: { env?: Record<string, string | undefined>; stdin?: string } = {},
): Promise<Output> {
  // Passed explicitly: Bun gives a child the environment this process started
  // with, not process.env as a fixture has changed it since.
  const env = Object.entries({ ...process.env, ...options.env }).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const child = Bun.spawn([process.execPath, ENTRY, ...argv], {
    cwd: process.cwd(),
    env: Object.fromEntries(env),
    stdin: new Blob([options.stdin ?? ""]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** `keylight <argv>`, run in this process so coverage sees it. */
export function keylight(...argv: string[]): Promise<Output> {
  return captured(() => runCommand(argv));
}
