// Stands in for `claude` and `codex` when the tests put cli/test/fakes first
// on PATH. Each launch is recorded, then acts as the test's plan says for the
// step it was launched for (KEYLIGHT_STEP), or for "naming" when no step is set.
//
//   $FAKE_HARNESS_DIR/launches.jsonl         one Launch per line, appended
//   $FAKE_HARNESS_DIR/plan.json              { [step]: Act[] }, one Act taken per launch
//   $FAKE_HARNESS_DIR/help/<command>.txt     what `<command> --help` prints, e.g. "codex exec"

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Act {
  stdout?: string;
  /** A file whose contents are printed to standard output, such as a recorded transcript. */
  replay?: string;
  /** Files to write, relative to the task folder, or absolute. */
  write?: Record<string, string>;
  /** Interactive Codex sessions to file under CODEX_HOME, each started after the last, with a helper thread before them. */
  codexSessions?: string[];
  exit?: number;
}

export interface Launch {
  program: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

const [program = "", ...argv] = process.argv.slice(2);
const dir = process.env.FAKE_HARNESS_DIR;
if (!dir) throw new Error(`fake ${program}: FAKE_HARNESS_DIR is not set`);

function printHelp(): never {
  const command = [program, ...argv.slice(0, argv.indexOf("--help"))].join(" ");
  const file = join(dir as string, "help", `${command}.txt`);
  if (!existsSync(file)) {
    process.stderr.write(`error: unrecognized subcommand in "${command}"\n`);
    process.exit(2);
  }
  process.stdout.write(readFileSync(file, "utf8"));
  process.exit(0);
}

function fileCodexSessions(ids: string[]) {
  const now = new Date();
  const day = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ];
  const sessions = join(process.env.CODEX_HOME as string, "sessions", ...day);
  mkdirSync(sessions, { recursive: true });
  const meta = (threadId: string, source: string, at: number) =>
    `${JSON.stringify({ type: "session_meta", payload: { id: threadId, timestamp: new Date(at).toISOString(), cwd: process.cwd(), thread_source: source } })}\n`;
  writeFileSync(join(sessions, "rollout-helper.jsonl"), meta("helper", "subagent", now.getTime()));
  // Written newest first, so the order files are listed in says nothing about which started first.
  for (const [i, id] of [...ids.entries()].reverse()) {
    writeFileSync(join(sessions, `rollout-${id}.jsonl`), meta(id, "user", now.getTime() + 1 + i));
  }
}

if (argv.includes("--help")) printHelp();

const step = process.env.KEYLIGHT_STEP ?? "naming";
// Only what keylight sets is kept: the inherited rest can hold credentials, and a failed assertion prints it.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith("KEYLIGHT_") || key.startsWith("CLAUDE_CODE_SUBAGENT_")),
) as Record<string, string>;
const launch: Launch = { program, argv, cwd: process.cwd(), env };
appendFileSync(join(dir, "launches.jsonl"), `${JSON.stringify(launch)}\n`);

const planFile = join(dir, "plan.json");
const plan = existsSync(planFile) ? (JSON.parse(readFileSync(planFile, "utf8")) as Record<string, Act[]>) : {};
const act = plan[step]?.shift() ?? {};
writeFileSync(planFile, JSON.stringify(plan));

for (const [path, content] of Object.entries(act.write ?? {})) {
  const target = resolve(process.env.KEYLIGHT_TASK_DIR ?? process.cwd(), path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
if (act.codexSessions) fileCodexSessions(act.codexSessions);
if (act.replay) process.stdout.write(readFileSync(act.replay));
if (act.stdout) process.stdout.write(act.stdout);
process.exit(act.exit ?? 0);
