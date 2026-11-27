// Every keylight command, by name. runCommand parses the arguments, finds the
// command's handler, and turns a TaskError or ConfigError into
// `keylight: <message>` on stderr and exit status 1. Handlers return their exit
// status; only the entry ends the process, apart from `serve` on SIGTERM.

import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { Subprocess } from "bun";
import { urlPath } from "../viewer/render";
import { startViewer } from "../viewer/server";
import { type Config, flag, loadConfig, localUrl } from "./config";
import { gatePrompt, initState, printStatus, type RunOptions, readState, recordWorktree, runWorkflow } from "./run";
import { nextLine } from "./say";
import { addEntry, ensurePage, scratchHome } from "./scratch";
import { seed, taskSummary } from "./start";
import { currentRepo, currentTask, ensureTask, storeOf, TASK_USAGE, TaskError, taskCommand } from "./task";
import { ConfigError, loadWorkflows, type Workflows, workflowNamed } from "./workflow";
import { setupWorktree } from "./worktree";

const VALUE_FLAGS = new Set([
  "--root",
  "--port",
  "--public-url",
  "--config",
  "--task",
  "--workflow",
  "--profile",
  "--name",
  "--from",
  "--until",
]);

interface Invocation {
  command: string;
  argv: string[];
  /** The arguments after the command that are neither a flag nor a flag's value. */
  positional: string[];
  /** --task, or KEYLIGHT_TASK. */
  named: string | undefined;
  /** Loaded on first use, so `help` works whatever the settings say. */
  readonly config: Config;
}

function parseInvocation(argv: string[]): Invocation {
  let config: Config | undefined;
  return {
    command: argv[0] ?? "help",
    argv,
    positional: argv.slice(1).filter((arg, i, rest) => !arg.startsWith("--") && !VALUE_FLAGS.has(rest[i - 1] ?? "")),
    named: flag(argv, "task") ?? (process.env.KEYLIGHT_TASK || undefined),
    get config() {
      config ??= loadConfig(argv);
      return config;
    },
  };
}

type Handler = (invocation: Invocation) => number | Promise<number>;

const COMMANDS: Record<string, Handler> = {
  help,
  "--help": help,
  "-h": help,
  task: (invocation) => taskCommand(invocation.positional, invocation.config, invocation.named),
  start,
  run,
  status,
  gate,
  worktree,
  scratch,
  serve,
  stop,
  view: (invocation) => showLink(invocation, true),
  url: (invocation) => showLink(invocation, false),
};

/** Runs `keylight <argv>` and returns its exit status. `serve` returns while its viewer goes on listening. */
export async function runCommand(argv: string[]): Promise<number> {
  const invocation = parseInvocation(argv);
  const handler = Object.hasOwn(COMMANDS, invocation.command) ? COMMANDS[invocation.command] : undefined;
  if (!handler) return reportFailure(`unknown command "${invocation.command}".\n${nextLine("keylight help")}`);
  try {
    return await handler(invocation);
  } catch (err) {
    if (err instanceof TaskError || err instanceof ConfigError) return reportFailure(err.message);
    throw err;
  }
}

function reportFailure(message: string): number {
  console.error(`keylight: ${message}`);
  return 1;
}

const RUN_USAGE = [
  'keylight start <ticket | "description">   create a task and run its workflow',
  "       [--workflow NAME] [--profile NAME] [--name TASK] [--no-run]",
  "keylight run                       continue the task's workflow from its first unfinished step",
  "       [--from STEP] [--until STEP] [--fresh] [--dry-run] [--workflow NAME] [--profile NAME]",
  "       --from goes back to a step and continues its session; --fresh starts that step over",
  "keylight status                    the task's steps and how far they are",
  "keylight worktree                  create the task's worktree and link the task into it",
  "keylight gate <step> <gate>        print the prompt for a point inside a step",
  "keylight scratch                   add the visual on stdin to the task's scratch page; print its link",
  "       [--dir]                     print the page's folder instead (HTML artifacts go beside it)",
].join("\n");

function help(): number {
  console.log(
    [
      RUN_USAGE,
      "",
      TASK_USAGE,
      "",
      "keylight view [path]   open an artifact (or the task index) in the viewer",
      "keylight url  [path]   print the link without opening a browser",
      "keylight serve         run the viewer in the foreground",
      "keylight stop          stop a background viewer",
      "",
      "Options: --root DIR  --port N  --public-url URL  --config DIR  --no-open",
      "Environment: KEYLIGHT_ROOT (default ~/Artifacts), KEYLIGHT_PORT (default 4747), KEYLIGHT_PUBLIC_URL,",
      "             KEYLIGHT_CONFIG (default ~/.config/keylight; holds themes)",
    ].join("\n"),
  );
  return 0;
}

function runOptions({ argv, named }: Invocation): RunOptions {
  return {
    named,
    workflow: flag(argv, "workflow"),
    profile: flag(argv, "profile"),
    from: flag(argv, "from"),
    until: flag(argv, "until"),
    dryRun: argv.includes("--dry-run"),
    fresh: argv.includes("--fresh"),
  };
}

async function start(invocation: Invocation): Promise<number> {
  const { config, argv } = invocation;
  const workflows = loadWorkflows(config.configDir);
  const options = runOptions(invocation);
  const repo = currentRepo();
  const workflow = options.workflow ?? workflows.default;
  workflowNamed(workflows, workflow);
  const seeded = await seed(invocation.positional.join(" "), flag(argv, "name"));
  const store = storeOf(repo, config, seeded.task);
  if (existsSync(store) && readState(store)) {
    throw new TaskError(`task ${seeded.task} already exists.\n${nextLine(`keylight run --task ${seeded.task}`)}`);
  }
  ensureTask(repo, config, seeded.task, taskSummary(seeded, repo.name));
  initState(store, repo.worktree, workflows, workflow, options.profile ?? workflows.profile);
  console.log(`Created task ${seeded.task} (${workflow} workflow).`);
  if (argv.includes("--no-run")) return 0;
  return continueWorkflow(config, workflows, { ...options, named: seeded.task });
}

function run(invocation: Invocation): Promise<number> {
  const { config } = invocation;
  return continueWorkflow(config, loadWorkflows(config.configDir), runOptions(invocation));
}

async function continueWorkflow(config: Config, workflows: Workflows, options: RunOptions): Promise<number> {
  // Sessions print viewer links; an agent's sandbox may not be able to start the viewer itself.
  if (!options.dryRun && !(await ensureServer(config))) {
    const repo = currentRepo();
    console.log(`Documents: ${linkFor(config, storeOf(repo, config, currentTask(repo, options.named)))}`);
  }
  return runWorkflow(config, workflows, options);
}

function status({ config, named }: Invocation): number {
  return printStatus(config, loadWorkflows(config.configDir), named);
}

function gate({ config, positional }: Invocation): number {
  const workflows = loadWorkflows(config.configDir);
  const [step = process.env.KEYLIGHT_STEP, point] = positional.length > 1 ? positional : [undefined, positional[0]];
  if (!step || !point) throw new TaskError("usage: keylight gate <step> <gate>   e.g. keylight gate tdd system-design");
  console.log(gatePrompt(step, point, currentRepo().worktree, config, workflows));
  return 0;
}

function worktree({ config, named }: Invocation): number {
  const workflows = loadWorkflows(config.configDir);
  const repo = currentRepo();
  const task = currentTask(repo, named);
  const created = setupWorktree(repo, config, task);
  recordWorktree(storeOf(repo, config, task), created, workflows);
  for (const note of created.notes) console.log(note);
  console.log(`worktree  ${created.path}\nbase      ${created.base}`);
  return 0;
}

async function scratch({ config, argv, named }: Invocation): Promise<number> {
  const home = scratchHome(config, named);
  if (argv.includes("--dir")) {
    console.log(home.dir);
    return 0;
  }
  const entry = process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
  const path = entry ? addEntry(home, entry) : ensurePage(home);
  await ensureServer(config);
  console.log(linkFor(config, path));
  return 0;
}

function serve({ config }: Invocation): number {
  if (!existsSync(config.root)) throw new TaskError(`artifact root does not exist: ${config.root}`);
  const viewer = startViewer(config);
  console.log(`keylight viewer: ${localUrl(config)}  (root: ${config.root})`);
  if (config.publicUrl) console.log(`public links: ${config.publicUrl}`);
  process.on("SIGTERM", () => {
    void viewer.stop();
    process.exit(0);
  });
  return 0;
}

async function stop({ config }: Invocation): Promise<number> {
  const running = await ping(config);
  if (!running) {
    console.log("No viewer is running.");
    return 0;
  }
  process.kill(running.pid, "SIGTERM");
  console.log(`Stopped the viewer for ${running.root}.`);
  return 0;
}

/** `view` and `url`: print the link to a path under the root, starting the viewer when none is running. */
async function showLink(invocation: Invocation, open: boolean): Promise<number> {
  const { config, argv } = invocation;
  ensureRoot(config, argv);
  const link = linkFor(config, invocation.positional[0]);
  const problem = await ensureServer(config);
  if (problem && open) throw new TaskError(problem.fix ? `${problem.why}\n${nextLine(problem.fix)}` : problem.why);
  // `url` always prints the link: an agent's sandbox may block local network
  // while the viewer is running fine outside it.
  console.log(link);
  // Only a person at a terminal is told; an agent would relay the note as if it were a failure.
  if (problem && process.stderr.isTTY) {
    const rest = problem.fix
      ? nextLine(problem.fix)
      : `The link works once the viewer is running.\n${nextLine("keylight view")}`;
    console.error(`keylight: ${problem.why}\n${rest}`);
  }
  if (open && !argv.includes("--no-open")) {
    // Open the local address: the public one may only resolve from other devices.
    const local = link.replace(config.publicUrl ?? localUrl(config), localUrl(config));
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", local], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
  return 0;
}

/** The default root is created on first use; one the user named must already exist. */
function ensureRoot(config: Config, argv: string[]) {
  if (existsSync(config.root)) return;
  const named = argv.some((a) => a === "--root" || a.startsWith("--root=")) || process.env.KEYLIGHT_ROOT;
  if (named) throw new TaskError(`artifact root does not exist: ${config.root}`);
  mkdirSync(config.root, { recursive: true });
}

interface Ping {
  app: string;
  root: string;
  pid: number;
}

async function ping(config: Config): Promise<Ping | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/__ping`, { signal: AbortSignal.timeout(500) });
    const body = (await res.json()) as Ping;
    return body.app === "keylight-viewer" ? body : null;
  } catch {
    return null;
  }
}

interface ViewerProblem {
  why: string;
  /** The command that clears the problem, when there is one. */
  fix?: string;
}

const INTERRUPTS = ["SIGINT", "SIGTERM"] as const;

/** Returns null when the viewer is running. */
async function ensureServer(config: Config): Promise<ViewerProblem | null> {
  const running = await ping(config);
  if (running) {
    if (running.root !== config.root) {
      return {
        why: `port ${config.port} already serves ${running.root}. Pass --port to use another port, or stop that viewer.`,
        fix: "keylight stop",
      };
    }
    return null;
  }
  const log = join(tmpdir(), `keylight-viewer-${config.port}.log`);
  const args = [
    join(import.meta.dir, "keylight.ts"),
    "serve",
    "--root",
    config.root,
    "--port",
    String(config.port),
    "--config",
    config.configDir,
    // Passed even when empty, so the viewer cannot fall back to a KEYLIGHT_PUBLIC_URL this invocation overrode.
    "--public-url",
    config.publicUrl ?? "",
  ];
  const out = openSync(log, "a");
  let child: Subprocess;
  try {
    child = Bun.spawn([process.execPath, ...args], { stdio: ["ignore", out, out], detached: true });
    child.unref();
  } finally {
    closeSync(out);
  }
  // Until the viewer answers, no `keylight stop` can find it, so an interrupt
  // ends it here before this process dies by the same signal.
  const interrupted = (signal: NodeJS.Signals) => {
    child.kill();
    release();
    process.kill(process.pid, signal);
  };
  const release = () => {
    for (const signal of INTERRUPTS) process.off(signal, interrupted);
  };
  for (const signal of INTERRUPTS) process.on(signal, interrupted);
  try {
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(100);
      if (await ping(config)) return null;
    }
  } finally {
    release();
  }
  // Left running: an agent's sandbox can block the ping while the viewer serves.
  return { why: `the viewer could not be reached or started from here. Its log is ${log}.` };
}

/** A path through a worktree symlink resolves to the same link as the stored file. */
function linkFor(config: Config, target: string | undefined): string {
  const base = config.publicUrl ?? localUrl(config);
  if (!target) return `${base}/`;
  const abs = resolve(target);
  if (!existsSync(abs)) throw new TaskError(`no such file: ${target}`);
  const rel = relative(config.root, realpathSync(abs));
  if (rel.startsWith("..") || rel.startsWith(sep)) {
    throw new TaskError(
      `${target} is not under the artifact root ${config.root}. Pass --root to view another directory.`,
    );
  }
  return rel ? `${base}/view/${urlPath(rel)}` : `${base}/`;
}
