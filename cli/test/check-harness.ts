#!/usr/bin/env bun
// bun run check:harness: every flag keylight passes to Claude Code and Codex
// is still one the installed CLI lists in its help. The commands come from
// cli/harness.ts, the code the runner launches with, for each mode keylight
// uses, with every option keylight itself can emit set. No session starts.

import { HARNESSES, namingCommand, type SessionRequest } from "../harness";
import type { Launch, Step } from "../workflow";

const MESSAGE = "MESSAGE";
const SESSION = "00000000-0000-4000-8000-000000000000";

interface Command {
  mode: string;
  argv: string[];
}

function sessionArgv(harness: Launch["harness"], session: Step["session"], resume?: string): string[] {
  const request: SessionRequest = {
    name: "STEP",
    step: { skill: "SKILL", session },
    launch: { harness, model: "MODEL", effort: "EFFORT", permissions: "PERMISSIONS" },
    message: MESSAGE,
    task: "TASK",
    store: "/STORE",
    resume,
  };
  return HARNESSES[harness].sessionCommand(request).argv;
}

const COMMANDS: Command[] = [
  { mode: "claude naming", argv: namingCommand(MESSAGE) },
  ...(["claude", "codex"] as const).flatMap((harness) => [
    { mode: `${harness} headless`, argv: sessionArgv(harness, "headless") },
    { mode: `${harness} interactive`, argv: sessionArgv(harness, "interactive") },
    { mode: `${harness} interactive, resumed`, argv: sessionArgv(harness, "interactive", SESSION) },
  ]),
];

/** The program and subcommands: the words before the first flag or the message. */
function helpCommand(argv: string[]): string[] {
  const end = argv.findIndex((arg) => arg.startsWith("-") || arg === MESSAGE || arg === SESSION);
  return argv.slice(0, end === -1 ? argv.length : end);
}

/**
 * The option names help text defines. An option's line is indented least; a
 * line indented further that starts with a flag continues another option's
 * description, so it defines nothing.
 */
function advertised(help: string): Set<string> {
  const optionLines = help.split("\n").filter((line) => /^\s+-/.test(line));
  const indent = Math.min(...optionLines.map((line) => line.search(/\S/)));
  const names = new Set<string>();
  for (const line of optionLines) {
    if (line.search(/\S/) > indent + 4) continue;
    const spec = line.trim().split(/\s{2,}/)[0] ?? "";
    for (const match of spec.matchAll(/(?:^|[\s,])(--?\w[\w-]*)/g)) names.add(match[1] as string);
  }
  return names;
}

const helpTexts = new Map<string, { options: Set<string> } | { problem: string }>();

function readHelp(command: string[]): { options: Set<string> } | { problem: string } {
  const key = command.join(" ");
  const known = helpTexts.get(key);
  if (known) return known;
  let read: { options: Set<string> } | { problem: string };
  try {
    const result = Bun.spawnSync([...command, "--help"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const why = result.stderr.toString().trim().split("\n").at(-1);
    read =
      result.exitCode === 0
        ? { options: advertised(result.stdout.toString()) }
        : { problem: `\`${key} --help\` exited with status ${result.exitCode}${why ? `: ${why}` : ""}` };
  } catch {
    read = { problem: `${command[0]} is not installed` };
  }
  helpTexts.set(key, read);
  return read;
}

let failed = false;
for (const { mode, argv } of COMMANDS) {
  const command = helpCommand(argv);
  const help = readHelp(command);
  const flags = [...new Set(argv.filter((arg) => /^--?\w/.test(arg)))];
  const missing = "options" in help ? flags.filter((flag) => !help.options.has(flag)) : [];
  const problem =
    "problem" in help
      ? help.problem
      : missing.length && `\`${command.join(" ")} --help\` does not list ${missing.join(", ")}`;
  if (!problem) {
    console.log(`ok    ${mode}: ${flags.join(" ")}  (\`${command.join(" ")} --help\`)`);
    continue;
  }
  failed = true;
  console.error(`FAIL  ${mode}: ${problem}\n      ${argv.join(" ")}`);
}
process.exit(failed ? 1 : 0);
