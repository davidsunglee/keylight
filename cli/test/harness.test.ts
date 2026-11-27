// The Claude Code and Codex harnesses: the session commands each builds, and
// `check:harness`, which holds those commands against each CLI's help, run
// here against fake CLIs whose help a test writes.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HARNESSES, namingCommand, type SessionRequest } from "../harness";
import type { Launch, Step } from "../workflow";
import { fakeHarness, tempDir } from "./support";

const CHECK = join(import.meta.dir, "check-harness.ts");

function request(launch: Launch, session: Step["session"], resume?: string): SessionRequest {
  return {
    name: "tdd",
    step: { skill: "kl:create-tdd", session },
    launch,
    message: "Go.",
    task: "demo",
    store: "/s",
    resume,
  };
}

describe("the session commands", () => {
  test("Claude Code: a named session with an id, streamed when headless, resumed by id", () => {
    const claude = HARNESSES.claude;
    const launch: Launch = { harness: "claude", model: "opus", effort: "high", args: ["--x"] };
    const headless = claude.sessionCommand(request(launch, "headless"));
    expect(headless.argv).toEqual([
      "claude",
      "-p",
      "Go.",
      "--session-id",
      headless.id as string,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      "--model",
      "opus",
      "--effort",
      "high",
      "--name",
      "demo · tdd",
      "--x",
      "--add-dir",
      "/s",
    ]);
    expect(headless.id).toMatch(/^[0-9a-f-]{36}$/);
    const interactive = claude.sessionCommand(request({ harness: "claude" }, "interactive"));
    expect(interactive.argv).toEqual([
      "claude",
      "Go.",
      "--session-id",
      interactive.id as string,
      "--name",
      "demo · tdd",
      "--add-dir",
      "/s",
    ]);
    expect(claude.sessionCommand(request({ harness: "claude", permissions: "plan" }, "interactive", "abc"))).toEqual({
      argv: ["claude", "--resume", "abc", "--permission-mode", "plan", "--add-dir", "/s"],
      id: "abc",
    });
    expect(claude.skillInvocation("kl:create-tdd")).toBe("/kl:create-tdd");
    expect(namingCommand("Name it.")).toEqual(["claude", "-p", "Name it.", "--model", "haiku"]);
  });

  test("Codex: exec when headless, resume by id, and a writable sandbox unless the profile names one", () => {
    const codex = HARNESSES.codex;
    const launch: Launch = { harness: "codex", model: "gpt-x", effort: "low", args: ["--search"] };
    expect(codex.sessionCommand(request(launch, "headless"))).toEqual({
      argv: [
        "codex",
        "exec",
        "-m",
        "gpt-x",
        "-c",
        'model_reasoning_effort="low"',
        "-s",
        "workspace-write",
        "--add-dir",
        "/s",
        "--search",
        "Go.",
      ],
      id: undefined,
    });
    expect(codex.sessionCommand(request({ harness: "codex", permissions: "read-only" }, "interactive")).argv).toEqual([
      "codex",
      "-s",
      "read-only",
      "--add-dir",
      "/s",
      "Go.",
    ]);
    expect(codex.sessionCommand(request({ harness: "codex" }, "interactive", "thread-1"))).toEqual({
      argv: ["codex", "resume", "-s", "workspace-write", "--add-dir", "/s", "thread-1"],
      id: "thread-1",
    });
    expect(codex.skillInvocation("kl:create-tdd")).toBe("Run the `kl:create-tdd` skill.");
  });

  test("only Claude Code takes sub-agent settings", () => {
    const subagents = { model: "haiku", effort: "low" };
    expect(HARNESSES.claude.subagentEnv({ harness: "claude", subagents })).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      CLAUDE_CODE_SUBAGENT_EFFORT: "low",
    });
    expect(HARNESSES.claude.subagentEnv({ harness: "claude", subagents: { effort: "max" } })).toEqual({
      CLAUDE_CODE_SUBAGENT_EFFORT: "max",
    });
    expect(HARNESSES.claude.subagentEnv({ harness: "claude" })).toEqual({});
    expect(HARNESSES.codex.subagentEnv({ harness: "codex", subagents })).toEqual({});
  });
});

describe.serial("an interactive Codex session", () => {
  test("whose checkout is removed while it runs ends with nothing to resume", async () => {
    using _harness = fakeHarness();
    using checkout = tempDir();
    const found: (string | undefined)[] = [];
    const problem = await HARNESSES.codex.runSession(
      { argv: ["rmdir", checkout.path] },
      {
        cwd: checkout.path,
        env: process.env as Record<string, string>,
        headless: false,
        log: () => join(checkout.path, "log"),
        onSessionFound: (id) => found.push(id),
      },
    );
    expect(problem).toBeNull();
    expect(found).toEqual([undefined]);
  });
});

/** Help text in the shape both CLIs print: the command's usage, then options with their descriptions after them. */
function helpListing(command: string, options: string[]): string {
  const lines = options.map((option) => `  ${option.padEnd(30)}What it does`);
  return [
    `Usage: ${command} [options]`,
    "",
    "Options:",
    ...lines,
    "                                --resume <id>, mentioned in a description",
    "",
  ].join("\n");
}

const CLAUDE_OPTIONS = [
  "-p, --print",
  "--session-id <uuid>",
  "--output-format <format>",
  "--verbose",
  "--permission-mode <mode>",
  "--model <model>",
  "--effort <level>",
  "-n, --name <name>",
  "--add-dir <directories...>",
  "-r, --resume [value]",
];
const CODEX_OPTIONS = [
  "-c, --config <key=value>",
  "-m, --model <MODEL>",
  "-s, --sandbox <SANDBOX_MODE>",
  "    --add-dir <DIR>",
];

async function checkHarness(): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CHECK], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe.serial("check:harness", () => {
  test("passes when each CLI's help lists every flag keylight passes it", async () => {
    using harness = fakeHarness();
    harness.help("claude", helpListing("claude", CLAUDE_OPTIONS));
    for (const command of ["codex", "codex exec", "codex resume"]) {
      harness.help(command, helpListing(command, CODEX_OPTIONS));
    }

    const result = await checkHarness();
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "ok    claude headless: -p --session-id --output-format --verbose --permission-mode",
    );
    expect(result.stdout).toContain("ok    codex headless: -m -c -s --add-dir  (`codex exec --help`)");
    expect(result.stdout.trim().split("\n")).toHaveLength(7);
    expect(harness.launches()).toEqual([]);
  });

  test("reports each command whose CLI no longer lists a flag, and a help command that fails", async () => {
    using harness = fakeHarness();
    harness.help(
      "claude",
      helpListing(
        "claude",
        CLAUDE_OPTIONS.filter((option) => !option.startsWith("-r,")),
      ),
    );
    harness.help("codex", helpListing("codex", CODEX_OPTIONS));
    harness.help(
      "codex exec",
      helpListing(
        "codex exec",
        CODEX_OPTIONS.filter((option) => !option.startsWith("-s,")),
      ),
    );

    const result = await checkHarness();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "FAIL  claude interactive, resumed: `claude --help` does not list --resume\n" +
        "      claude --resume 00000000-0000-4000-8000-000000000000 --permission-mode PERMISSIONS",
    );
    expect(result.stderr).toContain(
      "FAIL  codex headless: `codex exec --help` does not list -s\n      codex exec -m MODEL",
    );
    expect(result.stderr).toContain(
      'FAIL  codex interactive, resumed: `codex resume --help` exited with status 2: error: unrecognized subcommand in "codex resume"\n',
    );
    expect(result.stdout).toContain("ok    claude headless:");
    expect(result.stdout).toContain("ok    codex interactive:");
  });

  test("fails a subcommand whose help is the top-level help, as Codex prints for one it does not know", async () => {
    using harness = fakeHarness();
    harness.help("claude", helpListing("claude", CLAUDE_OPTIONS));
    for (const command of ["codex", "codex exec", "codex resume"]) {
      harness.help(command, helpListing("codex", CODEX_OPTIONS));
    }

    const result = await checkHarness();
    expect(result.code).toBe(1);
    for (const [mode, command] of [
      ["codex headless", "codex exec"],
      ["codex interactive, resumed", "codex resume"],
    ]) {
      expect(result.stderr).toContain(
        `FAIL  ${mode}: \`${command} --help\` printed no usage for \`${command}\`: Usage: codex [options]\n`,
      );
    }
    expect(result.stdout).toContain("ok    codex interactive:");
  });
});
