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
import { ask, choose, nextLine } from "./say";
import { currentRepo, currentTask, LINK_DIR, type Repo, storeOf, TaskError } from "./task";
import {
  ConfigError,
  documentKinds,
  type Launch,
  launchFor,
  loadWorkflows,
  profileProblem,
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
  /** What the user wants a step to take into account, by step: part of the opening message of each new session. */
  notes?: Record<string, string>;
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
  /** A note for the first session the run starts. */
  note?: string;
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
  note: string | undefined,
): string {
  const parts = [harness.skillInvocation(step.skill!)];
  if (step.prompt) parts.push(fill(step.prompt.trim(), values));
  const added = promptFile(name, cwd, config);
  if (added) parts.push(added);
  if (note) parts.push(`A note from the user for this step: ${note}`);
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
  const subagents = Object.keys(HARNESSES[launch.harness].subagentEnv(launch)).length
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
function askFinished(
  name: string,
  following: string | undefined,
  noteFor: string | undefined,
  ctx: RunContext,
): Answer {
  const title = (step: string) => ctx.workflows.steps[step]?.title ?? step;
  const options = finishedOptions(following && title(following), noteFor !== undefined);
  const labels = options.map(([label]) => label);
  for (;;) {
    console.log();
    const typed = choose(`Is ${title(name)} complete?`, labels);
    if (typed === null) return { outcome: "open" };
    const answer = answerTo(typed, options, noteFor && title(noteFor));
    if (answer) return answer;
  }
}

/** What a typed line settles, or null when the question has to be asked again. */
function answerTo(typed: string, options: [label: string, meaning: Meaning][], noteTitle: string | undefined) {
  const picked = /^\d*$/.test(typed) ? options[Number(typed || 1) - 1]?.[1] : undefined;
  if (!picked) {
    console.log(`Type a number from 1 to ${options.length}.`);
    return null;
  }
  if (picked !== "note") return { outcome: picked } satisfies Answer;
  const note = ask(`Note for ${noteTitle}`);
  if (note === null) return { outcome: "open" } satisfies Answer;
  // An empty note is a change of mind: back to the question.
  return note ? ({ outcome: "done", note } satisfies Answer) : null;
}

type Meaning = Answer["outcome"] | "note";

/** The answers to whether a step is complete, in the order they are numbered. `following` is the next step's title. */
function finishedOptions(following: string | undefined, takesNote: boolean): [label: string, meaning: Meaning][] {
  if (!following)
    return [
      ["Yes", "done"],
      ["No", "open"],
    ];
  const note: [string, Meaning][] = takesNote ? [["Yes, send a note to the next session", "note"]] : [];
  return [[`Yes, proceed to ${following}`, "done"], ["Yes, stop for now", "done-stop"], ...note, ["No", "open"]];
}

interface Answer {
  outcome: "done" | "done-stop" | "open";
  note?: string;
}

/** The step a note given after `name` would reach: the next one that opens a new session. */
function noteTarget(name: string, ctx: RunContext): string | undefined {
  const steps = workflowNamed(ctx.workflows, ctx.state.workflow);
  const target = steps.slice(steps.indexOf(name) + 1).find((later) => ctx.workflows.steps[later]?.skill);
  if (!target) return undefined;
  const launch = launchFor(ctx.workflows, ctx.state.profile, target);
  return resumedSession(target, ctx.workflows.steps[target]!, launch, ctx, "resume") ? undefined : target;
}

function keepNote(ctx: RunContext, step: string, note: string) {
  ctx.state.notes = { ...ctx.state.notes, [step]: note };
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
  const note = state.notes?.[name];
  const message = openingMessage(name, step, harness, existsSync(cwd) ? cwd : state.checkout, ctx.config, values, note);
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

function concludeStep(name: string, step: Step, ctx: RunContext, cwd: string, next: string | undefined): Outcome {
  const problem = unmet(step, ctx, cwd);
  if (problem) return { problem };
  const asks = step.session === "interactive" && step.confirm !== false && process.stdin.isTTY;
  const noteFor = next && noteTarget(name, ctx);
  const answer: Answer = asks ? askFinished(name, next, noteFor || undefined, ctx) : { outcome: "done" };
  // Left as started, so the next run resumes this session instead of moving on.
  if (answer.outcome === "open") return "open";
  if (answer.note && noteFor) keepNote(ctx, noteFor, answer.note);
  markStep(ctx, name, "done");
  return answer.outcome;
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
  const settings = harness.subagentEnv(launch);

  console.log(`\n${bold(`▸ ${name}`)}  ${dim(sessionLabel(step, launch) + (request.resume ? " · resuming" : ""))}`);
  const note = ctx.state.notes?.[name];
  if (note && !request.resume) console.log(dim(`  note: ${note}`));
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
  // Checked before anything is recorded, so a mistyped name is never kept as the task's own.
  if (options.workflow) workflowNamed(workflows, options.workflow);
  const unknown = options.profile ? profileProblem(workflows, options.profile) : null;
  if (unknown) throw new ConfigError(unknown);
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
    state.workflow = options.workflow ?? state.workflow;
    state.profile = options.profile ?? state.profile;
    if (!options.dryRun) writeState(store, state);
  }
  return { repo, task, store, config, workflows, state };
}

interface StepRange {
  steps: string[];
  /** The step the run stops after: --until, or the workflow's last. */
  last: string;
  endsWorkflow: boolean;
}

/**
 * The steps from --from, or the first unfinished one, through --until. Null
 * when every step is done and no --from is given.
 */
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

/** Says why the run stopped short, and returns the exit status. */
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

/** The command that gives a task a profile the settings define, for one whose own has gone from them. */
function profileFix(workflows: Workflows): string {
  return nextLine(`keylight run --profile ${workflows.profile}`);
}

/** Keeps --note for the first session the run starts, which must be a new one: a resumed session takes no opening message. */
function takeNote(ctx: RunContext, range: StepRange, options: RunOptions) {
  const index = range.steps.findIndex((name) => ctx.workflows.steps[name]?.skill);
  const name = range.steps[index];
  if (name === undefined) throw new TaskError("--note needs a step that starts a session, and this run has none");
  const launch = launchFor(ctx.workflows, ctx.state.profile, name);
  if (resumedSession(name, ctx.workflows.steps[name]!, launch, ctx, entryMode(index === 0, options)))
    throw new TaskError(
      `${name} continues its session, which takes no opening message: type the note there, or add --fresh to start ${name} over`,
    );
  keepNote(ctx, name, options.note!);
  if (!options.dryRun) writeState(ctx.store, ctx.state);
}

export async function runWorkflow(config: Config, workflows: Workflows, options: RunOptions): Promise<number> {
  const ctx = runContext(config, workflows, options);
  const range = stepRange(ctx, options);
  if (!range) {
    console.log(`Every step of ${ctx.state.workflow} is done for ${ctx.task}.`);
    return 0;
  }
  const gone = profileProblem(ctx.workflows, ctx.state.profile);
  if (gone) throw new TaskError(`${gone}\n${profileFix(ctx.workflows)}`);
  if (options.note) takeNote(ctx, range, options);
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

function documentNote(step: Step, store: string, workflows: Workflows): string {
  const kind = step.produces ?? step.phases;
  const doc = kind ? findDocument(store, kind, workflows) : null;
  if (!doc || !step.phases) return doc ?? "";
  const { total, done } = phaseProgress(readFileSync(join(store, doc), "utf8"));
  return total ? `${doc}  ${done}/${total} phases` : doc;
}

/**
 * What a step's status line says after its name: its document once it has started, how it will launch before.
 * A launch the settings cannot describe leaves the line empty and is added to `problems`.
 */
function stepSummary(name: string, state: State, store: string, workflows: Workflows, problems: Set<string>): string {
  const step = workflows.steps[name]!;
  if (state.steps[name]?.status) return documentNote(step, store, workflows);
  if (step.run) return dim("code");
  try {
    return dim(sessionLabel(step, launchFor(workflows, state.profile, name)));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    problems.add(err.message);
    return "";
  }
}

/** Prints the steps, and returns what in the settings kept a step's launch from being shown. */
function printSteps(state: State, store: string, workflows: Workflows): string[] {
  const steps = workflowNamed(workflows, state.workflow);
  const width = Math.max(...steps.map((name) => name.length));
  const problems = new Set<string>();
  let nextShown = false;
  for (const name of steps) {
    const status = state.steps[name]?.status;
    const symbol = status === "done" ? "✓" : status === "started" || !nextShown ? "▸" : "·";
    if (status !== "done") nextShown = true;
    console.log(`  ${symbol} ${name.padEnd(width)}  ${stepSummary(name, state, store, workflows, problems)}`);
    const note = status === "done" ? undefined : state.notes?.[name];
    if (note) console.log(dim(`    note: ${note}`));
  }
  return [...problems];
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
  const problems = printSteps(state, store, workflows);
  console.log(`store     ${relative(process.cwd(), store) || "."}`);
  for (const problem of problems) console.log(problem);
  if (problems.length && profileProblem(workflows, state.profile)) console.log(profileFix(workflows));
  return 0;
}
