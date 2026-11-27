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
import { HARNESSES, type Harness, type Problem, type Session, type SessionRequest } from "./harness";
import { ask, nextLine } from "./say";
import { currentRepo, currentTask, LINK_DIR, type Repo, storeOf, TaskError } from "./task";
import {
  ConfigError,
  documentKinds,
  type Launch,
  launchFor,
  loadWorkflows,
  SKILLS_DIR,
  type Step,
  type Workflows,
  workflowNamed,
} from "./workflow";
import { setupWorktree } from "./worktree";

interface StepState {
  status: "started" | "done";
  at: string;
  harness?: string;
  /** The step's session, so an interrupted interactive step can be resumed. */
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
export function initState(
  store: string,
  checkout: string,
  workflows: Workflows,
  workflow: string,
  profile: string,
  save = true,
): State {
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
function findDocument(store: string, kind: string, workflows: Workflows): string | null {
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

function phaseProgress(document: string): { total: number; done: number } {
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
    promptFile(`${stepName}.${gate}`, cwd, config) ??
    (folder ? firstFile([join(SKILLS_DIR, folder, `gate-${gate}.md`)]) : null);
  if (text === null) throw new TaskError(`no prompt for gate "${gate}" of step "${stepName}"`);
  return text;
}

const UNATTENDED =
  "Nobody is watching this session. Finish the skill without asking questions; where it tells you to wait for the user, stop and say why.";

function openingMessage(
  name: string,
  step: Step,
  harness: Harness,
  cwd: string,
  config: Config,
  values: Record<string, string>,
): string {
  const parts = [harness.skillInvocation(step.skill!)];
  if (step.prompt) parts.push(fill(step.prompt.trim(), values));
  const added = promptFile(name, cwd, config);
  if (added) parts.push(added);
  if (step.session === "headless") parts.push(UNATTENDED);
  return parts.join("\n\n");
}

function shellQuote(argv: string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(" ");
}

interface RunContext {
  repo: Repo;
  task: string;
  store: string;
  config: Config;
  workflows: Workflows;
  state: State;
}

/** What a step should have left behind. Returns the problem, or null when it is all there. */
function unmet(step: Step, ctx: RunContext, cwd: string): string | null {
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
    const result = Bun.spawnSync(["sh", "-c", step.check], {
      cwd,
      env: stepEnv(ctx),
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0)
      return `its check did not pass${result.stderr.length ? `: ${result.stderr.toString().trim().split("\n").at(-1)}` : ""}`;
  }
  return null;
}

function stepEnv(ctx: RunContext, name?: string): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KEYLIGHT_TASK: ctx.task,
    KEYLIGHT_TASK_DIR: ctx.store,
  };
  if (name) env.KEYLIGHT_STEP = name;
  if (ctx.state.worktree) env.KEYLIGHT_WORKTREE = ctx.state.worktree;
  if (ctx.state.base) env.KEYLIGHT_BASE = ctx.state.base;
  return env;
}

/** How a session step is launched, e.g. `claude · opus · headless · sub-agents haiku`. */
function sessionLabel(step: Step, launch: Launch): string {
  const session = [launch.harness, launch.model, launch.effort, step.session].filter(Boolean).join(" · ");
  const subagents = Object.keys(HARNESSES[launch.harness].sessionEnv(launch)).length
    ? [launch.subagents?.model, launch.subagents?.effort].filter(Boolean).join(" · ")
    : "";
  return subagents ? `${session} · sub-agents ${subagents}` : session;
}

function logFile(ctx: RunContext, name: string): string {
  const dir = join(homedir(), ".keylight", "logs", ctx.repo.name, ctx.task);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
}

type Outcome = "done" | "done-stop" | "open" | Problem;

/** How a run enters a step: where it left off, back into a finished step's session, or in a new session. */
type EntryMode = "resume" | "reopen" | "fresh";

interface StepRun {
  dryRun: boolean;
  /** The step the run goes on to, if any. */
  next: string | undefined;
  entry: EntryMode;
}

function markStep(ctx: RunContext, name: string, status: StepState["status"], more: Partial<StepState> = {}) {
  ctx.state.steps[name] = { ...ctx.state.steps[name], ...more, status, at: new Date().toISOString() };
  writeState(ctx.store, ctx.state);
}

/**
 * A document on disk does not prove an interactive step is finished: its skill
 * writes a skeleton first. Only the person who quit the session knows.
 */
function askFinished(name: string, following: string | undefined): "done" | "done-stop" | "open" {
  console.log();
  const answer = following
    ? ask(`Is ${name} finished?`, [
        ["Enter", `yes, start ${following}`],
        ["s", "yes, stop here"],
        ["n", "not yet"],
      ])
    : ask(`Is ${name} finished?`, [
        ["Enter", "yes"],
        ["n", "not yet"],
      ]);
  if (answer === null || answer.toLowerCase().startsWith("n")) return "open";
  return following && answer.toLowerCase().startsWith("s") ? "done-stop" : "done";
}

function runWorktreeStep(name: string, ctx: RunContext, dryRun: boolean): Outcome {
  console.log(`\n${bold(`▸ ${name}`)}  ${dim("code")}`);
  if (dryRun) return "done";
  const worktree = setupWorktree(currentRepo(ctx.state.checkout), ctx.config, ctx.task);
  for (const note of worktree.notes) console.log(`  ${note}`);
  ctx.state.worktree = worktree.path;
  ctx.state.base = worktree.base;
  markStep(ctx, name, "done");
  return "done";
}

/** The session an interactive step continues, if any. */
function resumedSession(
  name: string,
  step: Step,
  launch: Launch,
  ctx: RunContext,
  entry: EntryMode,
): string | undefined {
  const previous = ctx.state.steps[name];
  // Going back to a finished step means continuing its session: a new one would write a second document.
  const open = previous?.status === "started" || entry === "reopen";
  const continues = step.session === "interactive" && open && entry !== "fresh" && previous?.harness === launch.harness;
  return continues ? previous.session : undefined;
}

function sessionRequest(name: string, step: Step, launch: Launch, cwd: string, ctx: RunContext, entry: EntryMode) {
  const { state } = ctx;
  const values = {
    task: ctx.task,
    dir: join(LINK_DIR, ctx.task),
    store: ctx.store,
    worktree: state.worktree ?? "<worktree>",
    base: state.base ?? "<starting commit>",
    skills: SKILLS_DIR,
  };
  const harness = HARNESSES[launch.harness];
  const message = openingMessage(name, step, harness, existsSync(cwd) ? cwd : state.checkout, ctx.config, values);
  const resume = resumedSession(name, step, launch, ctx, entry);
  return { name, step, launch, message, task: ctx.task, store: ctx.store, resume } satisfies SessionRequest;
}

function printDryRun(cwd: string, settings: Record<string, string>, session: Session) {
  console.log(dim(`  in ${cwd}`));
  const prefix = Object.entries(settings)
    .map(([key, value]) => `${key}=${value} `)
    .join("");
  console.log(`  ${prefix}${shellQuote(session.argv)}`);
}

/** After the session: what the step left behind, then, at a terminal, whether the person is finished. */
function concludeStep(name: string, step: Step, ctx: RunContext, cwd: string, next: string | undefined): Outcome {
  const problem = unmet(step, ctx, cwd);
  if (problem) return { problem };
  const asks = step.session === "interactive" && step.confirm !== false && process.stdin.isTTY;
  const answer = asks ? askFinished(name, next) : "done";
  // Left as started, so the next run resumes this session instead of moving on.
  if (answer === "open") return "open";
  markStep(ctx, name, "done");
  return answer;
}

async function runStep(name: string, ctx: RunContext, run: StepRun): Promise<Outcome> {
  const step = ctx.workflows.steps[name]!;
  if (step.run === "worktree") return runWorktreeStep(name, ctx, run.dryRun);

  const launch = launchFor(ctx.workflows, ctx.state.profile, name);
  const inWorktree = step.in === "worktree";
  if (inWorktree && !ctx.state.worktree && !run.dryRun)
    return { problem: `it runs in the task's worktree, and the worktree step has not run` };
  const cwd = inWorktree ? (ctx.state.worktree ?? "<worktree>") : ctx.state.checkout;
  const request = sessionRequest(name, step, launch, cwd, ctx, run.entry);
  const harness = HARNESSES[launch.harness];
  const session = harness.sessionCommand(request);
  const settings = harness.sessionEnv(launch);

  console.log(`\n${bold(`▸ ${name}`)}  ${dim(sessionLabel(step, launch) + (request.resume ? " · resuming" : ""))}`);
  if (run.dryRun) {
    printDryRun(cwd, settings, session);
    return "done";
  }

  markStep(ctx, name, "started", { harness: launch.harness, session: session.id });
  const problem = await harness.runSession(session, {
    cwd,
    env: { ...stepEnv(ctx, name), ...settings },
    headless: step.session === "headless",
    log: () => logFile(ctx, name),
    onSessionFound: (id) => markStep(ctx, name, "started", { session: id }),
  });
  return problem ?? concludeStep(name, step, ctx, cwd, run.next);
}

function runContext(config: Config, workflows: Workflows, options: RunOptions): RunContext {
  const repo = currentRepo();
  const task = currentTask(repo, options.named);
  const store = storeOf(repo, config, task);
  let state = readState(store);
  if (!state) {
    state = initState(
      store,
      repo.worktree,
      workflows,
      options.workflow ?? workflows.default,
      options.profile ?? workflows.profile,
      !options.dryRun,
    );
  } else if (options.workflow || options.profile) {
    if (options.workflow) workflowNamed(workflows, options.workflow);
    state.workflow = options.workflow ?? state.workflow;
    state.profile = options.profile ?? state.profile;
    if (!options.dryRun) writeState(store, state);
  }
  return { repo, task, store, config, workflows, state };
}

interface StepRange {
  /** The steps this run takes, in order. */
  steps: string[];
  /** The step the run stops after: --until, or the workflow's last. */
  last: string;
  endsWorkflow: boolean;
}

/** The steps from --from, or the first unfinished one, through --until. Null when every step is done. */
function stepRange(ctx: RunContext, options: RunOptions): StepRange | null {
  const steps = workflowNamed(ctx.workflows, ctx.state.workflow);
  for (const flagged of [options.from, options.until]) {
    if (flagged && !steps.includes(flagged))
      throw new TaskError(`"${flagged}" is not a step of the ${ctx.state.workflow} workflow (${steps.join(", ")})`);
  }
  const start = options.from
    ? steps.indexOf(options.from)
    : steps.findIndex((name) => ctx.state.steps[name]?.status !== "done");
  if (start === -1) return null;
  const end = options.until ? steps.indexOf(options.until) : steps.length - 1;
  return { steps: steps.slice(start, end + 1), last: steps[end]!, endsWorkflow: end === steps.length - 1 };
}

/** A run can last hours: read the settings again, so an edit to a profile or step applies from the next step on. */
function reloadWorkflows(ctx: RunContext, step: string) {
  try {
    const latest = loadWorkflows(ctx.config.configDir);
    if (latest.steps[step]) ctx.workflows = latest;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`keylight: keeping the settings already loaded: ${err.message}`);
  }
}

function entryMode(first: boolean, options: RunOptions): EntryMode {
  if (first && options.fresh) return "fresh";
  return first && options.from ? "reopen" : "resume";
}

/** Says why the run stopped before its last step, and returns the exit status. */
function reportStop(step: string, outcome: Exclude<Outcome, "done">, next: string | undefined): number {
  if (outcome === "open") {
    console.log(`${step} is left open.\n${nextLine("keylight run")}`);
    return 0;
  }
  if (outcome === "done-stop") {
    console.log(`Stopped before ${next}.\n${nextLine("keylight run")}`);
    return 0;
  }
  const why = /[.!?]$/.test(outcome.problem) ? outcome.problem : `${outcome.problem}.`;
  console.error(
    [`\nkeylight: ${step} is not finished: ${why}`, ...(outcome.details ?? []), nextLine("keylight run")].join("\n"),
  );
  return 1;
}

export async function runWorkflow(config: Config, workflows: Workflows, options: RunOptions): Promise<number> {
  const ctx = runContext(config, workflows, options);
  const range = stepRange(ctx, options);
  if (!range) {
    console.log(`Every step of ${ctx.state.workflow} is done for ${ctx.task}.`);
    return 0;
  }
  console.log(`${bold(ctx.task)}  ${dim(`${ctx.state.workflow} workflow · ${ctx.state.profile} profile`)}`);
  for (const [index, name] of range.steps.entries()) {
    reloadWorkflows(ctx, name);
    const next = range.steps[index + 1];
    const outcome = await runStep(name, ctx, {
      dryRun: options.dryRun ?? false,
      next,
      entry: entryMode(index === 0, options),
    });
    if (outcome !== "done") return reportStop(name, outcome, next);
  }
  if (!options.dryRun)
    console.log(
      `\n${range.endsWorkflow ? `${ctx.task}: the ${ctx.state.workflow} workflow is complete.` : `Stopped after ${range.last}.`}`,
    );
  return 0;
}

/** A step's document, with its phase progress when the step tracks phases. */
function documentNote(step: Step, store: string, workflows: Workflows): string {
  const kind = step.produces ?? step.phases;
  const doc = kind ? findDocument(store, kind, workflows) : null;
  if (!doc || !step.phases) return doc ?? "";
  const { total, done } = phaseProgress(readFileSync(join(store, doc), "utf8"));
  return total ? `${doc}  ${done}/${total} phases` : doc;
}

function printSteps(state: State, store: string, workflows: Workflows) {
  const steps = workflowNamed(workflows, state.workflow);
  const width = Math.max(...steps.map((name) => name.length));
  let nextShown = false;
  for (const name of steps) {
    const step = workflows.steps[name]!;
    const status = state.steps[name]?.status;
    const symbol = status === "done" ? "✓" : status === "started" || !nextShown ? "▸" : "·";
    if (status !== "done") nextShown = true;
    const settings = step.run ? "code" : sessionLabel(step, launchFor(workflows, state.profile, name));
    console.log(`  ${symbol} ${name.padEnd(width)}  ${status ? documentNote(step, store, workflows) : dim(settings)}`);
  }
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
  printSteps(state, store, workflows);
  console.log(`store     ${relative(process.cwd(), store) || "."}`);
  return 0;
}
