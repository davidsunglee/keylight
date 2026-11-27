// keylight run: take a task through its workflow, one fresh session per step.
//
// The runner is a foreground loop. It starts each step's session as a child
// process, waits for it to end, checks what the step was meant to leave
// behind, and starts the next. Headless steps chain on their own; an
// interactive step hands back when you quit its session.
//
// What cannot be read from the task's documents is kept in <task>/.keylight.json:
// the workflow, the profile, where the work happens, and which steps are done.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { Config } from "./config";
import { ask, nextLine } from "./say";
import { currentRepo, currentTask, LINK_DIR, storeOf, TaskError, type Repo } from "./task";
import { ConfigError, documentKinds, launchFor, loadWorkflows, SKILLS_DIR, workflowNamed, type Launch, type Step, type Workflows } from "./workflow";
import { setupWorktree } from "./worktree";

interface StepState {
  status: "started" | "done";
  at: string;
  harness?: string;
  /** Claude Code session, so an interrupted interactive step can be resumed. */
  session?: string;
}

export interface State {
  workflow: string;
  profile: string;
  /** Checkout the design steps run in. */
  checkout: string;
  /** Checkout the implementation steps run in, once the worktree step has run. */
  worktree?: string;
  /** Commit the implementation started from. */
  base?: string;
  steps: Record<string, StepState>;
}

export interface RunOptions {
  named?: string;
  workflow?: string;
  profile?: string;
  from?: string;
  until?: string;
  dryRun?: boolean;
  /** Start the first step in a new session even when it has one to resume. */
  fresh?: boolean;
}

const STATE_FILE = ".keylight.json";
const dim = (text: string) => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text: string) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text);

export function readState(store: string): State | null {
  const file = join(store, STATE_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as State) : null;
}

function writeState(store: string, state: State) {
  writeFileSync(join(store, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** State for a task that has none yet. Steps whose documents already exist count as done. */
export function initState(store: string, checkout: string, workflows: Workflows, workflow: string, profile: string, save = true): State {
  const state: State = { workflow, profile, checkout, steps: {} };
  for (const name of workflowNamed(workflows, workflow)) {
    const step = workflows.steps[name]!;
    if (!step.produces || !findDocument(store, step.produces, workflows)) break;
    state.steps[name] = { status: "done", at: new Date().toISOString() };
  }
  if (save) writeState(store, state);
  return state;
}

/** Note the task's worktree, when the task has a workflow under way. */
export function recordWorktree(store: string, worktree: { path: string; base: string }, workflows: Workflows) {
  const state = readState(store);
  if (!state) return;
  state.worktree = worktree.path;
  state.base = worktree.base;
  for (const name of workflowNamed(workflows, state.workflow)) {
    if (workflows.steps[name]?.run === "worktree") state.steps[name] = { status: "done", at: new Date().toISOString() };
  }
  writeState(store, state);
}

/** The newest document of a kind in the task folder: `NN-<kind>-<slug>.md`, or `<kind>.md`. */
export function findDocument(store: string, kind: string, workflows: Workflows): string | null {
  const kinds = documentKinds(workflows);
  const matches = readdirSync(store)
    .filter((file) => {
      if (file === `${kind}.md`) return true;
      const rest = /^\d+-(.+)\.md$/.exec(file)?.[1];
      // `research-questions-x` is not a `research` document: the longest kind wins.
      return rest !== undefined && kinds.find((k) => rest.startsWith(`${k}-`)) === kind;
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return matches.at(-1) ?? null;
}

export function phaseProgress(document: string): { total: number; done: number } {
  // A heading shown inside a code block is an example, not a phase.
  const text = document.replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1.*$/gm, "");
  const headings = text.match(/^#{2,4}\s+(?:✅\s*)?Phase\s+\d+.*$/gm) ?? [];
  return { total: headings.length, done: headings.filter((h) => h.includes("✅")).length };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole);
}

function firstFile(paths: string[]): string | null {
  const found = paths.find((path) => existsSync(path));
  return found ? readFileSync(found, "utf8").trim() : null;
}

/**
 * A prompt kept in a file: the repository's copy wins over the personal one.
 *   <repo>/.keylight/prompts/<name>.md, then <config>/prompts/<name>.md
 */
function promptFile(name: string, cwd: string, config: Config): string | null {
  return firstFile([join(cwd, ".keylight", "prompts", `${name}.md`), join(config.configDir, "prompts", `${name}.md`)]);
}

/**
 * The message for a point inside a step, e.g. the end of the TDD's system
 * design. Falls back to the copy shipped with the step's skill.
 */
export function gatePrompt(stepName: string, gate: string, cwd: string, config: Config, workflows: Workflows): string {
  // A keylight skill is named `kl:<folder>`; other plugins' skills ship no gate text here.
  const folder = workflows.steps[stepName]?.skill?.replace(/^kl:/, "");
  const text =
    promptFile(`${stepName}.${gate}`, cwd, config) ?? (folder ? firstFile([join(SKILLS_DIR, folder, `gate-${gate}.md`)]) : null);
  if (text === null) throw new TaskError(`no prompt for gate "${gate}" of step "${stepName}"`);
  return text;
}

const UNATTENDED =
  "Nobody is watching this session. Finish the skill without asking questions; where it tells you to wait for the user, stop and say why.";

function openingMessage(name: string, step: Step, launch: Launch, cwd: string, config: Config, values: Record<string, string>): string {
  const parts = [launch.harness === "claude" ? `/${step.skill}` : `Run the \`${step.skill}\` skill.`];
  if (step.prompt) parts.push(fill(step.prompt.trim(), values));
  const added = promptFile(name, cwd, config);
  if (added) parts.push(added);
  if (step.session === "headless") parts.push(UNATTENDED);
  return parts.join("\n\n");
}

interface Session {
  argv: string[];
  /** Claude Code session id, when the harness lets us choose one. */
  id?: string;
}

function sessionCommand(name: string, step: Step, launch: Launch, message: string, task: string, store: string, resume?: string): Session {
  const headless = step.session === "headless";
  const extra = launch.args ?? [];
  if (launch.harness === "claude") {
    const id = resume ?? crypto.randomUUID();
    // The message comes first: --add-dir takes several values and would swallow it.
    const argv = resume ? ["claude", "--resume", resume] : ["claude", ...(headless ? ["-p"] : []), message, "--session-id", id];
    if (headless) argv.push("--output-format", "stream-json", "--verbose");
    const permissions = launch.permissions ?? (headless ? "auto" : undefined);
    if (permissions) argv.push("--permission-mode", permissions);
    if (launch.model) argv.push("--model", launch.model);
    if (launch.effort) argv.push("--effort", launch.effort);
    if (!resume) argv.push("--name", `${task} · ${name}`);
    argv.push(...extra, "--add-dir", store);
    return { argv, id };
  }
  const argv = headless ? ["codex", "exec"] : ["codex"];
  if (launch.model) argv.push("-m", launch.model);
  if (launch.effort) argv.push("-c", `model_reasoning_effort="${launch.effort}"`);
  // Codex refuses --add-dir unless the sandbox allows writing, so the task folder needs this in both modes.
  argv.push("-s", launch.permissions ?? "workspace-write");
  argv.push("--add-dir", store, ...extra, message);
  return { argv };
}

function shellQuote(argv: string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function toolLine(name: string, input: Record<string, unknown>): string {
  const detail = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.prompt ?? "";
  return `  ${name}  ${String(detail).split("\n")[0]!.slice(0, 110)}`;
}

async function runClaudeHeadless(argv: string[], cwd: string, env: Record<string, string>, log: string): Promise<{ ok: boolean; why?: string }> {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const raw = Bun.file(log).writer();
  let failed: string | undefined;
  let finished = false;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    raw.write(chunk);
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "assistant" && !event.parent_tool_use_id) {
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && block.text.trim()) console.log(`\n${block.text.trim()}`);
          if (block.type === "tool_use") console.log(dim(toolLine(block.name, block.input ?? {})));
        }
      }
      if (event.type === "result") {
        finished = true;
        if (event.is_error) failed = String(event.result ?? event.subtype ?? "the session reported an error");
      }
    }
  }
  await raw.end();
  const code = await child.exited;
  if (failed) return { ok: false, why: failed };
  if (code !== 0) return { ok: false, why: `the session exited with status ${code}` };
  if (!finished) return { ok: false, why: "the session ended without a result" };
  return { ok: true };
}

interface Context {
  repo: Repo;
  task: string;
  store: string;
  config: Config;
  workflows: Workflows;
  state: State;
}

/** What a step should have left behind. Returns the problem, or null when it is all there. */
function unmet(step: Step, ctx: Context, cwd: string): string | null {
  if (step.produces && !findDocument(ctx.store, step.produces, ctx.workflows)) {
    return `no ${step.produces} document was written to the task folder`;
  }
  if (step.phases) {
    const doc = findDocument(ctx.store, step.phases, ctx.workflows);
    if (!doc) return `there is no ${step.phases} document`;
    const { total, done } = phaseProgress(readFileSync(join(ctx.store, doc), "utf8"));
    if (!total) return `${doc} has no phases`;
    if (done < total) return `${done} of ${total} phases are marked done in ${doc}`;
  }
  if (step.check) {
    const result = Bun.spawnSync(["sh", "-c", step.check], { cwd, env: stepEnv(ctx), stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) return `its check did not pass${result.stderr.length ? `: ${result.stderr.toString().trim().split("\n").at(-1)}` : ""}`;
  }
  return null;
}

function stepEnv(ctx: Context, name?: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), KEYLIGHT_TASK: ctx.task, KEYLIGHT_TASK_DIR: ctx.store };
  if (name) env.KEYLIGHT_STEP = name;
  if (ctx.state.worktree) env.KEYLIGHT_WORKTREE = ctx.state.worktree;
  if (ctx.state.base) env.KEYLIGHT_BASE = ctx.state.base;
  return env;
}

function describe(step: Step, launch: Launch): string {
  if (step.run) return "code";
  const session = [launch.harness, launch.model, launch.effort, step.session].filter(Boolean).join(" · ");
  const subagents = Object.keys(subagentEnv(launch)).length ? [launch.subagents?.model, launch.subagents?.effort].filter(Boolean).join(" · ") : "";
  return subagents ? `${session} · sub-agents ${subagents}` : session;
}

/**
 * Claude Code's own settings for sub-agents. The force flag makes the model
 * apply even when the session names another one on a dispatch, so the profile
 * decides, not the session.
 */
function subagentEnv(launch: Launch): Record<string, string> {
  if (launch.harness !== "claude" || !launch.subagents) return {};
  const env: Record<string, string> = {};
  if (launch.subagents.model) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = launch.subagents.model;
    env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = "1";
  }
  if (launch.subagents.effort) env.CLAUDE_CODE_SUBAGENT_EFFORT = launch.subagents.effort;
  return env;
}

function logFile(ctx: Context, name: string): string {
  const dir = join(homedir(), ".keylight", "logs", ctx.repo.name, ctx.task);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
}

type Outcome = "done" | "done-stop" | "open" | { problem: string; details?: string[] };

/**
 * A document on disk does not prove an interactive step is finished: its skill
 * writes a skeleton first. Only the person who quit the session knows.
 */
function askFinished(name: string, following: string | undefined): "done" | "done-stop" | "open" {
  console.log();
  const answer = following
    ? ask(`Is ${name} finished?`, [["Enter", `yes, start ${following}`], ["s", "yes, stop here"], ["n", "not yet"]])
    : ask(`Is ${name} finished?`, [["Enter", "yes"], ["n", "not yet"]]);
  if (answer === null || answer.toLowerCase().startsWith("n")) return "open";
  return following && answer.toLowerCase().startsWith("s") ? "done-stop" : "done";
}

async function runStep(name: string, ctx: Context, dryRun: boolean, next: string | undefined, entry: "resume" | "reopen" | "fresh"): Promise<Outcome> {
  const { state, workflows, config } = ctx;
  const step = workflows.steps[name]!;
  const mark = (status: StepState["status"], more: Partial<StepState> = {}) => {
    state.steps[name] = { ...state.steps[name], ...more, status, at: new Date().toISOString() };
    writeState(ctx.store, state);
  };

  if (step.run === "worktree") {
    console.log(`\n${bold(`▸ ${name}`)}  ${dim("code")}`);
    if (dryRun) return "done";
    const worktree = setupWorktree(currentRepo(state.checkout), config, ctx.task);
    for (const note of worktree.notes) console.log(`  ${note}`);
    state.worktree = worktree.path;
    state.base = worktree.base;
    mark("done");
    return "done";
  }

  const launch = launchFor(workflows, state.profile, name);
  const inWorktree = step.in === "worktree";
  if (inWorktree && !state.worktree && !dryRun) return { problem: `it runs in the task's worktree, and the worktree step has not run` };
  const cwd = inWorktree ? (state.worktree ?? "<worktree>") : state.checkout;
  const values = {
    task: ctx.task,
    dir: join(LINK_DIR, ctx.task),
    store: ctx.store,
    worktree: state.worktree ?? "<worktree>",
    base: state.base ?? "<starting commit>",
    skills: SKILLS_DIR,
  };
  const previous = state.steps[name];
  // Going back to a finished step means continuing its session: a new one would write a second document.
  const open = previous?.status === "started" || entry === "reopen";
  const resume = step.session === "interactive" && open && entry !== "fresh" && previous?.harness === launch.harness ? previous.session : undefined;
  const message = openingMessage(name, step, launch, existsSync(cwd) ? cwd : state.checkout, config, values);
  const session = sessionCommand(name, step, launch, message, ctx.task, ctx.store, resume);

  console.log(`\n${bold(`▸ ${name}`)}  ${dim(describe(step, launch) + (resume ? " · resuming" : ""))}`);
  const subagents = subagentEnv(launch);
  if (dryRun) {
    console.log(dim(`  in ${cwd}`));
    const settings = Object.entries(subagents).map(([key, value]) => `${key}=${value} `).join("");
    console.log(`  ${settings}${shellQuote(session.argv)}`);
    return "done";
  }

  mark("started", { harness: launch.harness, session: session.id });
  const env = { ...stepEnv(ctx, name), ...subagents };
  if (step.session === "headless" && launch.harness === "claude") {
    const log = logFile(ctx, name);
    const result = await runClaudeHeadless(session.argv, cwd, env, log);
    if (!result.ok) return { problem: result.why ?? "the session failed", details: [`Log:  ${log}`, `Inspect:  cd ${cwd} && claude --resume ${session.id}`] };
  } else {
    const headless = step.session === "headless";
    const child = Bun.spawn(session.argv, { cwd, env, stdio: [headless ? "ignore" : "inherit", "inherit", "inherit"] });
    const code = await child.exited;
    if (headless && code !== 0) return { problem: `the session exited with status ${code}` };
  }

  const problem = unmet(step, ctx, cwd);
  if (problem) return { problem };
  const asks = step.session === "interactive" && step.confirm !== false && process.stdin.isTTY;
  const answer = asks ? askFinished(name, next) : "done";
  // Left as started, so the next run resumes this session instead of moving on.
  if (answer === "open") return "open";
  mark("done");
  return answer;
}

function context(config: Config, workflows: Workflows, options: RunOptions): Context {
  const repo = currentRepo();
  const task = currentTask(repo, options.named);
  const store = storeOf(repo, config, task);
  let state = readState(store);
  if (!state) {
    state = initState(store, repo.worktree, workflows, options.workflow ?? workflows.default, options.profile ?? workflows.profile, !options.dryRun);
  } else if (options.workflow || options.profile) {
    if (options.workflow) workflowNamed(workflows, options.workflow);
    state.workflow = options.workflow ?? state.workflow;
    state.profile = options.profile ?? state.profile;
    if (!options.dryRun) writeState(store, state);
  }
  return { repo, task, store, config, workflows, state };
}

export async function runWorkflow(config: Config, workflows: Workflows, options: RunOptions): Promise<number> {
  const ctx = context(config, workflows, options);
  const steps = workflowNamed(workflows, ctx.state.workflow);
  for (const flagged of [options.from, options.until]) {
    if (flagged && !steps.includes(flagged)) throw new TaskError(`"${flagged}" is not a step of the ${ctx.state.workflow} workflow (${steps.join(", ")})`);
  }
  let index = options.from ? steps.indexOf(options.from) : steps.findIndex((name) => ctx.state.steps[name]?.status !== "done");
  if (index === -1) {
    console.log(`Every step of ${ctx.state.workflow} is done for ${ctx.task}.`);
    return 0;
  }
  const start = index;
  const last = options.until ? steps.indexOf(options.until) : steps.length - 1;
  console.log(`${bold(ctx.task)}  ${dim(`${ctx.state.workflow} workflow · ${ctx.state.profile} profile`)}`);

  for (; index <= last; index++) {
    const name = steps[index]!;
    // A run can last hours: read the settings again, so an edit to a profile or step applies from the next step on.
    try {
      const latest = loadWorkflows(config.configDir);
      if (latest.steps[name]) ctx.workflows = latest;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      console.error(`keylight: keeping the settings already loaded: ${err.message}`);
    }
    const next = index < last ? steps[index + 1] : undefined;
    const first = name === steps[start];
    const entry = first && options.fresh ? "fresh" : first && options.from ? "reopen" : "resume";
    const outcome = await runStep(name, ctx, options.dryRun ?? false, next, entry);
    if (typeof outcome === "object") {
      const why = /[.!?]$/.test(outcome.problem) ? outcome.problem : `${outcome.problem}.`;
      console.error([`\nkeylight: ${name} is not finished: ${why}`, ...(outcome.details ?? []), nextLine("keylight run")].join("\n"));
      return 1;
    }
    if (outcome === "open") {
      console.log(`${name} is left open.\n${nextLine("keylight run")}`);
      return 0;
    }
    if (outcome === "done-stop") {
      console.log(`Stopped before ${next}.\n${nextLine("keylight run")}`);
      return 0;
    }
  }
  if (!options.dryRun) console.log(`\n${last === steps.length - 1 ? `${ctx.task}: the ${ctx.state.workflow} workflow is complete.` : `Stopped after ${steps[last]}.`}`);
  return 0;
}

export function printStatus(config: Config, workflows: Workflows, named: string | undefined): number {
  const repo = currentRepo();
  const task = currentTask(repo, named);
  const store = storeOf(repo, config, task);
  const state = readState(store);
  console.log(`task      ${task}`);
  if (!state) {
    console.log(`workflow  (not started)\n${nextLine("keylight run [--workflow NAME]")}`);
    return 0;
  }
  console.log(`workflow  ${state.workflow}  (profile ${state.profile})`);
  if (state.worktree) console.log(`worktree  ${state.worktree}`);
  const steps = workflowNamed(workflows, state.workflow);
  const width = Math.max(...steps.map((name) => name.length));
  let nextShown = false;
  for (const name of steps) {
    const step = workflows.steps[name]!;
    const status = state.steps[name]?.status;
    const kind = step.produces ?? step.phases;
    const doc = kind ? findDocument(store, kind, workflows) : null;
    let note = doc ?? "";
    if (step.phases && doc) {
      const { total, done } = phaseProgress(readFileSync(join(store, doc), "utf8"));
      if (total) note = `${doc}  ${done}/${total} phases`;
    }
    const symbol = status === "done" ? "✓" : status === "started" || !nextShown ? "▸" : "·";
    if (status !== "done") nextShown = true;
    console.log(`  ${symbol} ${name.padEnd(width)}  ${status === "done" || status === "started" ? note : dim(describe(step, step.run ? ({} as Launch) : launchFor(workflows, state.profile, name)))}`);
  }
  console.log(`store     ${relative(process.cwd(), store) || "."}`);
  return 0;
}
