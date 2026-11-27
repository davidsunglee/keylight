// What keylight knows about Claude Code and Codex, and the only place a flag of
// either is spelled. Each harness builds the command that starts or resumes a
// step's session, adds the environment it reads, and runs the session to its
// end. The runner asks the step's harness and never names one.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileSink } from "bun";
import type { Launch, Step } from "./workflow";

export interface SessionRequest {
  name: string;
  step: Step;
  launch: Launch;
  message: string;
  task: string;
  store: string;
  resume?: string;
}

export interface Session {
  argv: string[];
  /** Known before launch only when Claude Code is given one or a session is resumed. Codex names its own. */
  id?: string;
}

export interface Problem {
  problem: string;
  /** Where to look, such as the session's log. */
  details?: string[];
}

export interface SessionIo {
  cwd: string;
  env: Record<string, string>;
  headless: boolean;
  /** A new file to keep the session's raw output in. */
  log(): string;
  /** Records the id of a session the harness could only find once it ended. */
  onSessionFound(id: string | undefined): void;
}

export interface Harness {
  skillInvocation(skill: string): string;
  sessionCommand(request: SessionRequest): Session;
  /** The environment that applies the profile's sub-agent settings: empty when the harness takes none. */
  subagentEnv(launch: Launch): Record<string, string>;
  runSession(session: Session, io: SessionIo): Promise<Problem | null>;
}

const dim = (text: string) => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text);

/** Runs a session with the caller's terminal as its output, and as its input unless headless. */
function attend(argv: string[], io: SessionIo): Promise<number> {
  const stdin = io.headless ? "ignore" : "inherit";
  return Bun.spawn(argv, { cwd: io.cwd, env: io.env, stdio: [stdin, "inherit", "inherit"] }).exited;
}

/** Claude Code's one-shot call that proposes a title and a task name. */
export function namingCommand(prompt: string): string[] {
  return ["claude", "-p", prompt, "--model", "haiku"];
}

/**
 * Claude Code's own settings for sub-agents. The force flag makes the model
 * apply even when the session names another one on a dispatch, so the profile
 * decides, not the session.
 */
function subagentEnv(launch: Launch): Record<string, string> {
  if (!launch.subagents) return {};
  const env: Record<string, string> = {};
  if (launch.subagents.model) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = launch.subagents.model;
    env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = "1";
  }
  if (launch.subagents.effort) env.CLAUDE_CODE_SUBAGENT_EFFORT = launch.subagents.effort;
  return env;
}

function claudeCommand({ name, step, launch, message, task, store, resume }: SessionRequest): Session {
  const headless = step.session === "headless";
  const id = resume ?? crypto.randomUUID();
  // The message comes first: --add-dir takes several values and would swallow it.
  const argv = resume
    ? ["claude", "--resume", resume]
    : ["claude", ...(headless ? ["-p"] : []), message, "--session-id", id];
  if (headless) argv.push("--output-format", "stream-json", "--verbose");
  const permissions = launch.permissions ?? (headless ? "auto" : undefined);
  if (permissions) argv.push("--permission-mode", permissions);
  if (launch.model) argv.push("--model", launch.model);
  if (launch.effort) argv.push("--effort", launch.effort);
  if (!resume) argv.push("--name", `${task} · ${name}`);
  argv.push(...(launch.args ?? []), "--add-dir", store);
  return { argv, id };
}

/** The parts of a stream-json event this code reads. */
interface StreamEvent {
  type?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: ContentBlock[] };
  is_error?: boolean;
  result?: unknown;
  subtype?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** The complete lines of a stream, each chunk copied to `raw` as it arrives. */
async function* lines(stream: ReadableStream<Uint8Array>, raw: FileSink): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    raw.write(chunk);
    buffer += decoder.decode(chunk, { stream: true });
    const complete = buffer.split("\n");
    buffer = complete.pop() ?? "";
    yield* complete;
  }
}

function parseEvent(line: string): StreamEvent | null {
  try {
    const event: unknown = JSON.parse(line);
    return typeof event === "object" && event !== null ? (event as StreamEvent) : null;
  } catch {
    return null;
  }
}

function toolLine(name: string, input: Record<string, unknown>): string {
  const detail =
    input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.prompt ?? "";
  return `  ${name}  ${String(detail).split("\n")[0]!.slice(0, 110)}`;
}

/** Prints what the session itself says and does; its sub-agents' events stay in the log. */
function show(event: StreamEvent) {
  if (event.type !== "assistant" || event.parent_tool_use_id) return;
  for (const block of event.message?.content ?? []) {
    if (block.type === "text" && block.text?.trim()) console.log(`\n${block.text.trim()}`);
    if (block.type === "tool_use") console.log(dim(toolLine(String(block.name), block.input ?? {})));
  }
}

/** Runs a headless Claude Code session, printing its progress. Returns why it failed, or null. */
async function streamHeadless(argv: string[], io: SessionIo, log: string): Promise<string | null> {
  const child = Bun.spawn(argv, { cwd: io.cwd, env: io.env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const raw = Bun.file(log).writer();
  let failed: string | undefined;
  let finished = false;
  for await (const line of lines(child.stdout, raw)) {
    const event = parseEvent(line);
    if (!event) continue;
    show(event);
    if (event.type !== "result") continue;
    finished = true;
    if (event.is_error) failed = String(event.result ?? event.subtype ?? "the session reported an error");
  }
  await raw.end();
  const code = await child.exited;
  if (failed) return failed;
  if (code !== 0) return `the session exited with status ${code}`;
  return finished ? null : "the session ended without a result";
}

const claude: Harness = {
  skillInvocation: (skill) => `/${skill}`,
  sessionCommand: claudeCommand,
  subagentEnv,
  async runSession(session, io) {
    if (!io.headless) {
      await attend(session.argv, io);
      return null;
    }
    const log = io.log();
    const failed = await streamHeadless(session.argv, io, log);
    if (!failed) return null;
    return { problem: failed, details: [`Log:  ${log}`, `Inspect:  cd ${io.cwd} && claude --resume ${session.id}`] };
  },
};

function codexCommand({ step, launch, message, store, resume }: SessionRequest): Session {
  const headless = step.session === "headless";
  const argv = headless ? ["codex", "exec"] : resume ? ["codex", "resume"] : ["codex"];
  if (launch.model) argv.push("-m", launch.model);
  if (launch.effort) argv.push("-c", `model_reasoning_effort="${launch.effort}"`);
  // Codex refuses --add-dir unless the sandbox allows writing, so the task folder needs this in both modes.
  argv.push("-s", launch.permissions ?? "workspace-write");
  argv.push("--add-dir", store, ...(launch.args ?? []), resume ?? message);
  return { argv, id: resume };
}

interface CodexThread {
  id: string;
  timestamp: string;
  cwd: string;
  thread_source: string;
}

/** The thread a Codex session file describes in its first line, or null for a file this code cannot read. */
function readThread(file: string, since: Date): CodexThread | null {
  try {
    if (!file.endsWith(".jsonl") || statSync(file).mtime < since) return null;
    return JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!).payload as CodexThread;
  } catch {
    return null;
  }
}

/**
 * The id of the interactive Codex session started in `cwd` since `launched`,
 * read from the session files Codex keeps (one folder per local day, the
 * first line of each file describing the session). Undefined when none is
 * found, which leaves the step without a session to resume.
 */
function codexSessionSince(cwd: string, launched: Date): string | undefined {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const dayDir = (day: Date) =>
    join(
      home,
      "sessions",
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
  // A checkout moved or removed while the session ran leaves nothing to resume.
  if (!existsSync(cwd)) return undefined;
  const places = [cwd, realpathSync(cwd)];
  const started: CodexThread[] = [];
  for (const dir of new Set([dayDir(launched), dayDir(new Date())])) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const thread = readThread(join(dir, name), launched);
      // Codex also files its own helper threads here; only the one the user talks to can be resumed.
      const ours =
        thread?.thread_source === "user" && places.includes(thread.cwd) && new Date(thread.timestamp) >= launched;
      if (ours) started.push(thread);
    }
  }
  return started.sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0]?.id;
}

const codex: Harness = {
  skillInvocation: (skill) => `Run the \`${skill}\` skill.`,
  sessionCommand: codexCommand,
  subagentEnv: () => ({}),
  async runSession(session, io) {
    const launched = new Date();
    const code = await attend(session.argv, io);
    if (io.headless) return code === 0 ? null : { problem: `the session exited with status ${code}` };
    if (!session.id) io.onSessionFound(codexSessionSince(io.cwd, launched));
    return null;
  },
};

export const HARNESSES: Record<Launch["harness"], Harness> = { claude, codex };
