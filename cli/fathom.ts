#!/usr/bin/env bun

import { existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { flag, loadConfig, localUrl, type Config } from "./config";
import { urlPath } from "../viewer/render";
import { currentRepo, currentTask, ensureTask, storeOf, TASK_USAGE, TaskError, taskCommand } from "./task";
import { gatePrompt, initState, printStatus, readState, recordWorktree, runWorkflow, type RunOptions } from "./run";
import { nextLine } from "./say";
import { addEntry, ensurePage, scratchHome } from "./scratch";
import { seed, taskSummary } from "./start";
import { ConfigError, loadWorkflows, workflowNamed } from "./workflow";
import { setupWorktree } from "./worktree";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const VALUE_FLAGS = new Set([
  "--root", "--port", "--public-url", "--config", "--task",
  "--workflow", "--profile", "--name", "--from", "--until",
]);
const positional = argv.slice(1).filter((arg, i, rest) => !arg.startsWith("--") && !VALUE_FLAGS.has(rest[i - 1] ?? ""));

function fail(message: string): never {
  console.error(`fathom: ${message}`);
  process.exit(1);
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
    return body.app === "fathom-viewer" ? body : null;
  } catch {
    return null;
  }
}

interface ViewerProblem {
  why: string;
  /** The command that clears the problem, when there is one. */
  fix?: string;
}

/** Returns null when the viewer is running. */
async function ensureServer(config: Config): Promise<ViewerProblem | null> {
  const running = await ping(config);
  if (running) {
    if (running.root !== config.root) {
      return { why: `port ${config.port} already serves ${running.root}. Pass --port to use another port, or stop that viewer.`, fix: "fathom stop" };
    }
    return null;
  }
  const log = join(tmpdir(), `fathom-viewer-${config.port}.log`);
  const out = openSync(log, "a");
  const args = [join(import.meta.dir, "..", "viewer", "server.ts"), "--root", config.root, "--port", String(config.port)];
  args.push("--config", config.configDir);
  if (config.publicUrl) args.push("--public-url", config.publicUrl);
  const child = Bun.spawn([process.execPath, ...args], { stdio: ["ignore", out, out], detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(100);
    if (await ping(config)) return null;
  }
  return { why: `the viewer could not be reached or started from here. Its log is ${log}.` };
}

/** A path through a worktree symlink resolves to the same link as the stored file. */
function linkFor(config: Config, target: string | undefined): string {
  const base = config.publicUrl ?? localUrl(config);
  if (!target) return `${base}/`;
  const abs = resolve(target);
  if (!existsSync(abs)) fail(`no such file: ${target}`);
  const rel = relative(config.root, realpathSync(abs));
  if (rel.startsWith("..") || rel.startsWith(sep)) {
    fail(`${target} is not under the artifact root ${config.root}. Pass --root to view another directory.`);
  }
  return rel ? `${base}/view/${urlPath(rel)}` : `${base}/`;
}

async function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(
      [
        RUN_USAGE,
        "",
        TASK_USAGE,
        "",
        "fathom view [path]   open an artifact (or the task index) in the viewer",
        "fathom url  [path]   print the link without opening a browser",
        "fathom serve         run the viewer in the foreground",
        "fathom stop          stop a background viewer",
        "",
        "Options: --root DIR  --port N  --public-url URL  --config DIR  --no-open",
        "Environment: FATHOM_ROOT (default ~/Artifacts), FATHOM_PORT (default 4747), FATHOM_PUBLIC_URL,",
        "             FATHOM_CONFIG (default ~/.config/fathom; holds themes)",
      ].join("\n"),
    );
    return;
  }

  const config = loadConfig(argv);

  const named = flag(argv, "task") ?? (process.env.FATHOM_TASK || undefined);

  if (command === "task") process.exit(taskCommand(positional, config, named));

  if (["start", "run", "status", "gate", "worktree"].includes(command)) {
    try {
      process.exit(await workflowCommand(config, named));
    } catch (err) {
      if (!(err instanceof TaskError) && !(err instanceof ConfigError)) throw err;
      fail(err.message);
    }
  }

  if (command === "scratch") {
    try {
      const home = scratchHome(config, named);
      if (argv.includes("--dir")) return console.log(home.dir);
      const entry = process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
      const path = entry ? addEntry(home, entry) : ensurePage(home);
      await ensureServer(config);
      return console.log(linkFor(config, path));
    } catch (err) {
      if (!(err instanceof TaskError)) throw err;
      fail(err.message);
    }
  }

  if (command === "serve") {
    await import("../viewer/server");
    return;
  }

  if (command === "stop") {
    const running = await ping(config);
    if (!running) return console.log("No viewer is running.");
    process.kill(running.pid, "SIGTERM");
    return console.log(`Stopped the viewer for ${running.root}.`);
  }

  if (command === "view" || command === "url") {
    if (!existsSync(config.root)) {
      if (flagGiven("root") || process.env.FATHOM_ROOT) fail(`artifact root does not exist: ${config.root}`);
      mkdirSync(config.root, { recursive: true });
    }
    const link = linkFor(config, positional[0]);
    const problem = await ensureServer(config);
    if (problem && command === "view") fail(problem.fix ? `${problem.why}\n${nextLine(problem.fix)}` : problem.why);
    // `url` always prints the link: an agent's sandbox may block local network
    // while the viewer is running fine outside it.
    console.log(link);
    // Only a person at a terminal is told; an agent would relay the note as if it were a failure.
    if (problem && process.stderr.isTTY) {
      const rest = problem.fix ? nextLine(problem.fix) : `The link works once the viewer is running.\n${nextLine("fathom view")}`;
      console.error(`fathom: ${problem.why}\n${rest}`);
    }
    if (command === "view" && !argv.includes("--no-open")) {
      // Open the local address: the public one may only resolve from other devices.
      const local = link.replace(config.publicUrl ?? localUrl(config), localUrl(config));
      Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", local], { stdio: ["ignore", "ignore", "ignore"] });
    }
    return;
  }

  fail(`unknown command "${command}".\n${nextLine("fathom help")}`);
}

const RUN_USAGE = [
  'fathom start <ticket | "description">   create a task and run its workflow',
  "       [--workflow NAME] [--profile NAME] [--name TASK] [--no-run]",
  "fathom run                       continue the task's workflow from its first unfinished step",
  "       [--from STEP] [--until STEP] [--fresh] [--dry-run] [--workflow NAME] [--profile NAME]",
  "       --from goes back to a step and continues its session; --fresh starts that step over",
  "fathom status                    the task's steps and how far they are",
  "fathom worktree                  create the task's worktree and link the task into it",
  "fathom gate <step> <gate>        print the prompt for a point inside a step",
  "fathom scratch                   add the visual on stdin to the task's scratch page; print its link",
  "       [--dir]                   print the page's folder instead (HTML artifacts go beside it)",
].join("\n");

async function workflowCommand(config: Config, named: string | undefined): Promise<number> {
  const workflows = loadWorkflows(config.configDir);
  const options: RunOptions = {
    named,
    workflow: flag(argv, "workflow"),
    profile: flag(argv, "profile"),
    from: flag(argv, "from"),
    until: flag(argv, "until"),
    dryRun: argv.includes("--dry-run"),
    fresh: argv.includes("--fresh"),
  };

  if (command === "status") return printStatus(config, workflows, named);

  if (command === "gate") {
    const [step = process.env.FATHOM_STEP, gate] = positional.length > 1 ? positional : [undefined, positional[0]];
    if (!step || !gate) fail("usage: fathom gate <step> <gate>   e.g. fathom gate tdd system-design");
    console.log(gatePrompt(step, gate, currentRepo().worktree, config, workflows));
    return 0;
  }

  if (command === "worktree") {
    const repo = currentRepo();
    const task = currentTask(repo, named);
    const worktree = setupWorktree(repo, config, task);
    recordWorktree(storeOf(repo, config, task), worktree, workflows);
    for (const note of worktree.notes) console.log(note);
    console.log(`worktree  ${worktree.path}\nbase      ${worktree.base}`);
    return 0;
  }

  if (command === "start") {
    const repo = currentRepo();
    const workflow = options.workflow ?? workflows.default;
    workflowNamed(workflows, workflow);
    const seeded = await seed(positional.join(" "), flag(argv, "name"));
    const store = storeOf(repo, config, seeded.task);
    if (existsSync(store) && readState(store)) {
      fail(`task ${seeded.task} already exists.\n${nextLine(`fathom run --task ${seeded.task}`)}`);
    }
    ensureTask(repo, config, seeded.task, taskSummary(seeded, repo.name));
    initState(store, repo.worktree, workflows, workflow, options.profile ?? workflows.profile);
    console.log(`Created task ${seeded.task} (${workflow} workflow).`);
    if (argv.includes("--no-run")) return 0;
    options.named = seeded.task;
  }

  if (!options.dryRun) {
    // Sessions print viewer links; an agent's sandbox may not be able to start the viewer itself.
    if (!(await ensureServer(config))) console.log(`Documents: ${linkFor(config, storeOf(currentRepo(), config, currentTask(currentRepo(), options.named)))}`);
  }
  return runWorkflow(config, workflows, options);
}

function flagGiven(name: string): boolean {
  return argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

await main();
