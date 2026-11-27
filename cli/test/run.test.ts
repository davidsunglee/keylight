// `keylight run` end to end: fake `claude` and `codex` executables stand in
// for the sessions, so each case sees which steps run in which order, what
// each session was launched with, and what the runner records and reports.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Launch } from "./fakes/harness";
import { atTerminal, FIXTURES, fakeHarness, git, keylight, type TempRepo, tempRepo } from "./support";

const SKILLS = join(import.meta.dir, "../../plugin/skills");
const HEADLESS = join(FIXTURES, "claude-headless.jsonl");
const SUBAGENT = join(FIXTURES, "claude-subagent.jsonl");
const MODEL_ERROR = join(FIXTURES, "claude-model-error.jsonl");
const UNATTENDED =
  "Nobody is watching this session. Finish the skill without asking questions; where it tells you to wait for the user, stop and say why.";
const DESIGN = ["research-questions", "research", "tdd", "structure-outline", "worktree", "implement-outline", "pr"];

interface StepState {
  status: string;
  at: string;
  harness?: string;
  session?: string;
}
interface State {
  workflow: string;
  profile: string;
  checkout: string;
  worktree?: string;
  base?: string;
  steps: Record<string, StepState>;
}

const plain = (text: string) => Bun.stripANSI(text);
const banners = (stdout: string) =>
  plain(stdout)
    .split("\n")
    .filter((line) => line.startsWith("▸ "));
const stepOf = (launch: Launch) => launch.env.KEYLIGHT_STEP;
const valueAfter = (launch: Launch, flag: string) => launch.argv[launch.argv.indexOf(flag) + 1] ?? "";
const readState = (repo: TempRepo, task = "demo") =>
  JSON.parse(readFileSync(join(repo.store(task), ".keylight.json"), "utf8")) as State;

function writeState(repo: TempRepo, steps: Record<string, Partial<StepState>>, more: Partial<State> = {}) {
  const at = "2024-01-01T00:00:00.000Z";
  const state = {
    workflow: "design",
    profile: "default",
    checkout: repo.worktree,
    ...more,
    steps: Object.fromEntries(Object.entries(steps).map(([name, step]) => [name, { status: "done", at, ...step }])),
  };
  writeFileSync(join(repo.store("demo"), ".keylight.json"), JSON.stringify(state));
}

const documents = (repo: TempRepo) => `Documents: http://localhost:${repo.viewer.port}/view/demo-repo/demo\n`;
const done = (...names: string[]) => Object.fromEntries(names.map((name) => [name, {}]));

function writeWorkflows(repo: TempRepo, yaml: string) {
  writeFileSync(join(repo.configDir, "workflows.yaml"), yaml);
}

function logs(repo: TempRepo): string[] {
  const dir = join(repo.home, ".keylight/logs", repo.name, "demo");
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
}

describe.serial("keylight run", () => {
  test("runs the steps in workflow order, each in its own session, and marks each done", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    harness.plan({
      "research-questions": [{ replay: HEADLESS, write: { "01-research-questions-demo.md": "# Questions\n" } }],
      research: [{ replay: SUBAGENT, write: { "02-research-demo.md": "# Research\n" } }],
      tdd: [{ write: { "03-tdd-demo.md": "# TDD\n" } }],
    });

    const result = await keylight("run", "--until", "tdd");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(banners(result.stdout)).toEqual([
      "▸ research-questions  claude · headless",
      "▸ research  claude · headless",
      "▸ tdd  claude · interactive",
    ]);
    expect(result.stdout).toStartWith(
      `${documents(repo)}demo  design workflow · default profile\n\n▸ research-questions`,
    );
    expect(result.stdout).toEndWith("\nStopped after tdd.\n");

    const launches = harness.launches();
    expect(launches.map(stepOf)).toEqual(["research-questions", "research", "tdd"]);
    const store = repo.store("demo");
    const [questions, research, tdd] = launches as [Launch, Launch, Launch];
    expect(questions.program).toBe("claude");
    expect(questions.argv).toEqual([
      "-p",
      `/kl:create-research-questions\n\n${UNATTENDED}`,
      "--session-id",
      valueAfter(questions, "--session-id"),
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      "--name",
      "demo · research-questions",
      "--add-dir",
      store,
    ]);
    expect(tdd.argv).toEqual([
      "/kl:create-tdd",
      "--session-id",
      valueAfter(tdd, "--session-id"),
      "--name",
      "demo · tdd",
      "--add-dir",
      store,
    ]);
    for (const launch of launches) {
      expect(launch.cwd).toBe(repo.worktree);
      expect(launch.env).toMatchObject({ KEYLIGHT_TASK: "demo", KEYLIGHT_TASK_DIR: store });
      expect(launch.env.KEYLIGHT_WORKTREE).toBeUndefined();
    }

    const state = readState(repo);
    expect(Object.keys(state.steps)).toEqual(["research-questions", "research", "tdd"]);
    for (const launch of launches) {
      expect(state.steps[stepOf(launch) as string]).toMatchObject({
        status: "done",
        harness: "claude",
        session: valueAfter(launch, "--session-id"),
      });
    }
    expect(new Set(launches.map((launch) => valueAfter(launch, "--session-id"))).size).toBe(3);
    expect(valueAfter(research, "--name")).toBe("demo · research");
  });

  test("prints the session's own words and tool calls, not its sub-agents', and keeps the raw stream as the log", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    harness.plan({
      "research-questions": [{ replay: SUBAGENT, write: { "01-research-questions-demo.md": "" } }],
    });

    const result = await keylight("run", "--until", "research-questions");
    expect(result.code).toBe(0);
    const out = plain(result.stdout);
    expect(out).toContain(
      "▸ research-questions  claude · headless\n" +
        "  Read  /home/user/.claude/skills/keylight/skills/keylight/TASKS.md\n" +
        "  Read  /home/user/.claude/skills/keylight/skills/keylight/SUBAGENTS.md\n" +
        "  Bash  Name session and locate the task folder\n",
    );
    expect(out).toContain("  Agent  Analyze inventory CLI\n");
    expect(out).toContain("\nThe sub-agent couldn't open its brief because I gave it the wrong path.");
    expect(out).toContain("\n### Next Steps\n\nThe research questions we wrote are a query plan");
    expect(out).not.toContain("List repository files and agent config dirs");
    expect(out).not.toContain("codebase-analyzer.md");

    const [log] = logs(repo);
    expect(log).toMatch(/\/research-questions-\d{4}-\d\d-\d\dT[\d-]+Z\.jsonl$/);
    expect(readFileSync(log as string, "utf8")).toBe(readFileSync(SUBAGENT, "utf8"));
  });

  test("reads the settings again before each step, and keeps the loaded ones when the file breaks", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    const settings = join(repo.configDir, "workflows.yaml");
    harness.plan({
      "research-questions": [
        {
          replay: HEADLESS,
          write: {
            "01-research-questions-demo.md": "",
            [settings]: "profiles:\n  default:\n    research: { model: opus }\n",
          },
        },
      ],
      research: [{ replay: HEADLESS, write: { "02-research-demo.md": "", [settings]: "workflows: [\n" } }],
      tdd: [{ write: { "03-tdd-demo.md": "" } }],
    });

    const result = await keylight("run", "--until", "tdd");
    expect(result.code).toBe(0);
    const [questions, research, tdd] = harness.launches() as [Launch, Launch, Launch];
    expect(questions.argv).not.toContain("--model");
    expect(valueAfter(research, "--model")).toBe("opus");
    expect(banners(result.stdout)[1]).toBe("▸ research  claude · opus · headless");
    expect(tdd.argv).not.toContain("--model");
    expect(result.stderr).toStartWith(`keylight: keeping the settings already loaded: ${settings}: `);
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  test("an edited file that drops the next step leaves the loaded settings in place for it", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(
      repo,
      "default: pair\nworkflows:\n  pair: [one, two]\nsteps:\n  one: { skill: kl:one, session: headless }\n  two: { skill: kl:two, session: headless }\n",
    );
    harness.plan({
      one: [{ replay: HEADLESS, write: { [join(repo.configDir, "workflows.yaml")]: "default: design\n" } }],
      two: [{ replay: HEADLESS }],
    });

    const result = await keylight("run");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(harness.launches().map(stepOf)).toEqual(["one", "two"]);
    expect(result.stdout).toEndWith("\ndemo: the pair workflow is complete.\n");
  });

  test("a task whose documents exist starts after them, and records that", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeFileSync(join(repo.store("demo"), "01-research-questions-demo.md"), "");
    writeFileSync(join(repo.store("demo"), "02-research-demo.md"), "");
    writeFileSync(join(repo.store("demo"), "04-structure-outline-demo.md"), "");
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }] });

    const result = await keylight("run", "--until", "tdd");
    expect(banners(result.stdout)).toEqual(["▸ tdd  claude · interactive"]);
    const state = readState(repo);
    expect(state).toMatchObject({ workflow: "design", profile: "default", checkout: repo.worktree });
    expect(Object.keys(state.steps)).toEqual(["research-questions", "research", "tdd"]);
  });

  test("--workflow and --profile on a task under way replace the recorded ones", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(repo, 'profiles:\n  other:\n    "*": { model: sonnet }\n');
    writeState(repo, done("research-questions", "research"));
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }] });

    await keylight("run", "--profile", "other", "--until", "tdd");
    expect(valueAfter(harness.launches()[0] as Launch, "--model")).toBe("sonnet");
    expect(readState(repo).profile).toBe("other");

    expect(await keylight("run", "--workflow", "nope")).toEqual({
      code: 1,
      stdout: documents(repo),
      stderr: 'keylight: no workflow named "nope". Known: direct, design, product\n',
    });
    expect(readState(repo).workflow).toBe("design");
  });

  test("--dry-run launches nothing and writes no state, log, worktree or check result", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    const marker = join(repo.outside, "checked");
    writeWorkflows(repo, `steps:\n  pr: { check: "touch ${marker}" }\n`);
    writeState(repo, done("research-questions", "research", "tdd", "structure-outline"));
    const before = readFileSync(join(repo.store("demo"), ".keylight.json"), "utf8");

    const result = await keylight("run", "--dry-run", "--profile", "default");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(plain(result.stdout)).toBe(
      [
        "demo  design workflow · default profile",
        "",
        "▸ worktree  code",
        "",
        "▸ implement-outline  claude · interactive",
        "  in <worktree>",
        `  claude /kl:implement-outline --session-id ${result.stdout.match(/--session-id ([\w-]+)/)?.[1]} --name 'demo · implement-outline' --add-dir ${repo.store("demo")}`,
        "",
        "▸ pr  claude · headless",
        "  in <worktree>",
        `  claude -p '/kl:describe-pr\n\n${UNATTENDED}' --session-id ${[...result.stdout.matchAll(/--session-id ([\w-]+)/g)][1]?.[1]} --output-format stream-json --verbose --permission-mode auto --name 'demo · pr' --add-dir ${repo.store("demo")}`,
        "",
      ].join("\n"),
    );
    expect(harness.launches()).toEqual([]);
    expect(readFileSync(join(repo.store("demo"), ".keylight.json"), "utf8")).toBe(before);
    expect(logs(repo)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect(git(repo.worktree, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a step in the worktree waits for the worktree step, which creates it and records where", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    const path = join(repo.home, ".keylight/workspaces/demo/demo-repo");
    writeState(repo, done("research-questions", "research", "tdd", "structure-outline", "worktree"));

    expect(await keylight("run")).toEqual({
      code: 1,
      stdout: `${documents(repo)}demo  design workflow · default profile\n`,
      stderr:
        "\nkeylight: implement-outline is not finished: it runs in the task's worktree, and the worktree step has not run.\n" +
        "Next:  keylight run\n",
    });
    expect(harness.launches()).toEqual([]);

    writeState(repo, done("research-questions", "research", "tdd", "structure-outline"));
    harness.plan({ pr: [{ replay: HEADLESS, write: { "05-pr-description-demo.md": "" } }] });
    const result = await keylight("run");
    expect(result.code).toBe(0);
    const base = git(repo.worktree, "rev-parse", "HEAD");
    expect(plain(result.stdout)).toStartWith(
      `${documents(repo)}demo  design workflow · default profile\n\n▸ worktree  code\n  created ${path} on branch demo\n\n▸ implement-outline`,
    );
    expect(result.stdout).toEndWith("\ndemo: the design workflow is complete.\n");
    const launches = harness.launches();
    expect(launches.map(stepOf)).toEqual(["implement-outline", "pr"]);
    for (const launch of launches) {
      expect(launch.cwd).toBe(path);
      expect(launch.env).toMatchObject({ KEYLIGHT_WORKTREE: path, KEYLIGHT_BASE: base });
    }
    const state = readState(repo);
    expect(state).toMatchObject({ worktree: path, base });
    expect(DESIGN.map((step) => state.steps[step]?.status)).toEqual(DESIGN.map(() => "done"));
    expect(existsSync(join(path, ".artifacts/tasks/demo/task.md"))).toBe(true);
  });

  test("the opening message adds the step's prompt, filled in, and the repository's prompt file before the personal one", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(
      repo,
      [
        "default: one",
        "workflows:",
        "  one: [note]",
        "steps:",
        "  note:",
        "    skill: kl:note",
        "    session: interactive",
        "    prompt: |",
        "      Task {{ task }} in {{dir}}, store {{ store }}, worktree {{ worktree }}, base {{ base }}.",
        "      Skills {{ skills }}, unknown {{ nope }}.",
        "",
      ].join("\n"),
    );
    mkdirSync(join(repo.configDir, "prompts"));
    writeFileSync(join(repo.configDir, "prompts/note.md"), "  Personal addition.\n");

    await keylight("run", "--fresh");
    const filled =
      `Task demo in .artifacts/tasks/demo, store ${repo.store("demo")}, worktree <worktree>, base <starting commit>.\n` +
      `Skills ${SKILLS}, unknown {{ nope }}.`;
    expect(harness.launches()[0]?.argv[0]).toBe(`/kl:note\n\n${filled}\n\nPersonal addition.`);

    mkdirSync(join(repo.worktree, ".keylight/prompts"), { recursive: true });
    writeFileSync(join(repo.worktree, ".keylight/prompts/note.md"), "Repository addition.");
    await keylight("run", "--fresh", "--from", "note");
    expect(harness.launches()[1]?.argv[0]).toBe(`/kl:note\n\n${filled}\n\nRepository addition.`);
  });
});

describe.serial("finishing a step", () => {
  const CHECKS = [
    "default: checks",
    "workflows:",
    "  checks: [produce, phased, checked]",
    "steps:",
    "  produce: { skill: kl:p, session: headless, produces: notes }",
    "  phased: { skill: kl:q, session: headless, phases: plan }",
    `  checked: { skill: kl:r, session: headless, check: 'test -f "$KEYLIGHT_TASK_DIR/ok" || { echo first >&2; echo "no ok file" >&2; exit 1; }' }`,
    "",
  ].join("\n");
  const notFinished = (step: string, why: string) =>
    `\nkeylight: ${step} is not finished: ${why}\nNext:  keylight run\n`;

  test("a step is done only when its document, its phases and its check are all there", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(repo, CHECKS);
    const run = async (writes: Record<string, Record<string, string>> = {}) => {
      harness.plan(
        Object.fromEntries(
          ["produce", "phased", "checked"].map((step) => [step, [{ replay: HEADLESS, write: writes[step] }]]),
        ),
      );
      return keylight("run");
    };

    const unwritten = await run();
    expect(unwritten.code).toBe(1);
    expect(unwritten.stderr).toBe(notFinished("produce", "no notes document was written to the task folder."));
    expect(readState(repo).steps.produce?.status).toBe("started");

    expect((await run({ produce: { "01-notes-demo.md": "" } })).stderr).toBe(
      notFinished("phased", "there is no plan document."),
    );
    expect(readState(repo).steps.produce?.status).toBe("done");
    expect((await run({ phased: { "02-plan-demo.md": "# Plan\n" } })).stderr).toBe(
      notFinished("phased", "02-plan-demo.md has no phases."),
    );
    const partial = "## ✅ Phase 1: one\n\n```md\n## Phase 9: an example\n```\n\n### Phase 2: two\n";
    expect((await run({ phased: { "03-plan-demo.md": partial } })).stderr).toBe(
      notFinished("phased", "1 of 2 phases are marked done in 03-plan-demo.md."),
    );
    expect(
      (await run({ phased: { "03-plan-demo.md": partial.replace("### Phase 2", "### ✅ Phase 2") } })).stderr,
    ).toBe(notFinished("checked", "its check did not pass: no ok file."));
    const finished = await run({ checked: { ok: "" } });
    expect(finished).toMatchObject({ code: 0, stderr: "" });
    expect(finished.stdout).toEndWith("\ndemo: the checks workflow is complete.\n");
    expect(harness.launches().map(stepOf)).toEqual([
      "produce",
      "produce",
      "phased",
      "phased",
      "phased",
      "phased",
      "checked",
      "checked",
    ]);
  });

  test("a failed check with nothing on stderr says only that it did not pass", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(
      repo,
      "default: one\nworkflows:\n  one: [only]\nsteps:\n  only: { skill: kl:o, session: headless, check: 'exit 1' }\n",
    );
    harness.plan({ only: [{ replay: HEADLESS }] });
    expect((await keylight("run")).stderr).toBe(notFinished("only", "its check did not pass."));
  });

  test("a headless Claude session that reports an error, exits nonzero or ends without a result is not finished", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    harness.plan({
      "research-questions": [
        { replay: MODEL_ERROR },
        { replay: HEADLESS, exit: 3 },
        { stdout: 'not json\n{"type":"assistant","message":{"content":[{"type":"text","text":"Halfway."}]}}\n' },
      ],
    });

    const failed = await keylight("run");
    expect(failed.code).toBe(1);
    const [log] = logs(repo);
    const id = valueAfter(harness.launches()[0] as Launch, "--session-id");
    expect(failed.stderr).toBe(
      "\nkeylight: research-questions is not finished: There's an issue with the selected model (no-such-model). " +
        "It may not exist or you may not have access to it. Run --model to pick a different model.\n" +
        `Log:  ${log}\nInspect:  cd ${repo.worktree} && claude --resume ${id}\nNext:  keylight run\n`,
    );
    expect(readState(repo).steps["research-questions"]).toMatchObject({ status: "started", session: id });

    expect((await keylight("run")).stderr).toStartWith(
      "\nkeylight: research-questions is not finished: the session exited with status 3.\nLog:  ",
    );
    const ended = await keylight("run");
    expect(ended.stderr).toStartWith(
      "\nkeylight: research-questions is not finished: the session ended without a result.\n",
    );
    expect(ended.stdout).toContain("\nHalfway.\n");
    expect(logs(repo)).toHaveLength(3);
  });
});

describe.serial("an interactive step at a terminal", () => {
  function setUp(repo: TempRepo) {
    writeState(repo, done("research-questions", "research"));
  }

  test("Enter counts the step done and starts the next; the last step asks only yes or not yet", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({
      tdd: [{ write: { "03-tdd-demo.md": "" } }],
      "structure-outline": [{ write: { "04-structure-outline-demo.md": "" } }],
    });
    using terminal = atTerminal(["", ""]);

    const result = await keylight("run", "--until", "structure-outline");
    expect(result.code).toBe(0);
    expect(terminal.questions).toEqual(["Is tdd finished?", "Is structure-outline finished?"]);
    expect(harness.launches().map(stepOf)).toEqual(["tdd", "structure-outline"]);
    expect(plain(result.stdout)).toEndWith("\n\nStopped after structure-outline.\n");
    expect(readState(repo).steps["structure-outline"]?.status).toBe("done");
  });

  test("s counts the step done and stops before the next", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }] });
    using _terminal = atTerminal(["S"]);

    const result = await keylight("run");
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toEndWith("\nStopped before structure-outline.\nNext:  keylight run\n");
    expect(harness.launches().map(stepOf)).toEqual(["tdd"]);
    expect(readState(repo).steps.tdd?.status).toBe("done");
  });

  test("n or ended input leaves the step open, and the next run resumes its session", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }, {}] });
    using _terminal = atTerminal(["not yet", null, "s"]);

    const open = await keylight("run");
    expect(open.code).toBe(0);
    expect(plain(open.stdout)).toEndWith("\ntdd is left open.\nNext:  keylight run\n");
    const id = valueAfter(harness.launches()[0] as Launch, "--session-id");
    expect(readState(repo).steps.tdd).toMatchObject({ status: "started", harness: "claude", session: id });

    const resumed = await keylight("run");
    expect(banners(resumed.stdout)).toEqual(["▸ tdd  claude · interactive · resuming"]);
    expect(harness.launches()[1]?.argv).toEqual(["--resume", id, "--add-dir", repo.store("demo")]);
    expect(readState(repo).steps.tdd?.status).toBe("started");

    await keylight("run");
    expect(harness.launches()[2]?.argv).toEqual(["--resume", id, "--add-dir", repo.store("demo")]);
    expect(readState(repo).steps.tdd).toMatchObject({ status: "done", session: id });
  });

  test("a step with confirm: false continues without asking", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    writeWorkflows(repo, "steps:\n  tdd: { confirm: false }\n");
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }] });
    using terminal = atTerminal([]);

    expect((await keylight("run", "--until", "tdd")).code).toBe(0);
    expect(terminal.questions).toEqual([]);
    expect(readState(repo).steps.tdd?.status).toBe("done");
  });
});

describe.serial("going back to a step", () => {
  test("--from continues a finished interactive step's session; --fresh starts a new one", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeState(repo, { ...done("research-questions", "research"), tdd: { harness: "claude", session: "tdd-session" } });
    writeFileSync(join(repo.store("demo"), "03-tdd-demo.md"), "");

    const reopened = await keylight("run", "--from", "tdd", "--until", "tdd");
    expect(reopened.code).toBe(0);
    expect(banners(reopened.stdout)).toEqual(["▸ tdd  claude · interactive · resuming"]);
    expect(harness.launches()[0]?.argv).toEqual(["--resume", "tdd-session", "--add-dir", repo.store("demo")]);

    const fresh = await keylight("run", "--from", "tdd", "--until", "tdd", "--fresh");
    expect(banners(fresh.stdout)).toEqual(["▸ tdd  claude · interactive"]);
    const started = harness.launches()[1] as Launch;
    const id = valueAfter(started, "--session-id");
    expect(id).not.toBe("tdd-session");
    expect(started.argv[0]).toBe("/kl:create-tdd");
    expect(readState(repo).steps.tdd).toMatchObject({ status: "done", session: id });
  });

  test("--fresh starts an open step over, and only the first step of the run is reopened", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeState(repo, {
      ...done("research-questions", "research"),
      tdd: { status: "started", harness: "claude", session: "open-tdd" },
      "structure-outline": { harness: "claude", session: "outline-session" },
    });
    harness.plan({
      tdd: [{ write: { "03-tdd-demo.md": "" } }],
      "structure-outline": [{ write: { "04-structure-outline-demo.md": "" } }],
    });

    await keylight("run", "--fresh", "--until", "structure-outline");
    const [tdd, outline] = harness.launches() as [Launch, Launch];
    expect(tdd.argv).not.toContain("--resume");
    expect(outline.argv).not.toContain("--resume");
  });

  test("a headless step and a step whose harness changed start new sessions", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeState(repo, {
      "research-questions": { harness: "claude", session: "rq-session" },
      research: {},
      tdd: { status: "started", harness: "codex", session: "codex-session" },
    });
    harness.plan({
      "research-questions": [{ replay: HEADLESS, write: { "01-research-questions-demo.md": "" } }],
      research: [{ replay: HEADLESS, write: { "02-research-demo.md": "" } }],
    });

    await keylight("run", "--from", "research-questions", "--until", "research");
    expect(harness.launches()[0]?.argv).not.toContain("--resume");
    await keylight("run", "--until", "tdd");
    const tdd = harness.launches()[2] as Launch;
    expect(stepOf(tdd)).toBe("tdd");
    expect(tdd.argv).not.toContain("--resume");
  });
});

describe.serial("profiles", () => {
  test("Claude sub-agent settings reach the session as Claude Code's own variables", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(
      repo,
      'profiles:\n  default:\n    "*": { subagents: { model: haiku, effort: low } }\n    tdd: { subagents: { model: opus } }\n',
    );
    harness.plan({
      "research-questions": [{ replay: HEADLESS, write: { "01-research-questions-demo.md": "" } }],
      research: [{ replay: HEADLESS, write: { "02-research-demo.md": "" } }],
      tdd: [{ write: { "03-tdd-demo.md": "" } }],
    });

    const result = await keylight("run", "--until", "tdd");
    expect(banners(result.stdout)).toEqual([
      "▸ research-questions  claude · headless · sub-agents haiku · low",
      "▸ research  claude · headless · sub-agents haiku · low",
      "▸ tdd  claude · interactive · sub-agents opus",
    ]);
    const [questions, , tdd] = harness.launches() as [Launch, Launch, Launch];
    expect(questions.env).toMatchObject({
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      CLAUDE_CODE_SUBAGENT_EFFORT: "low",
    });
    expect(tdd.env).toMatchObject({ CLAUDE_CODE_SUBAGENT_MODEL: "opus", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" });
    expect(tdd.env.CLAUDE_CODE_SUBAGENT_EFFORT).toBeUndefined();

    const dry = await keylight("run", "--dry-run", "--from", "tdd", "--until", "tdd", "--fresh");
    expect(plain(dry.stdout)).toContain(
      "\n  CLAUDE_CODE_SUBAGENT_MODEL=opus CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 claude /kl:create-tdd ",
    );
  });

  test("a profile entry sets model, effort, permissions and extra arguments, the step's own entry winning", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(
      repo,
      [
        "profiles:",
        "  default:",
        '    "*": { model: sonnet, effort: high, args: ["--verbose-ish"] }',
        "    claude: { effort: medium }",
        "    research-questions: { model: opus, permissions: plan }",
        "",
      ].join("\n"),
    );
    harness.plan({ "research-questions": [{ replay: HEADLESS }] });

    await keylight("run", "--until", "research-questions");
    const launch = harness.launches()[0] as Launch;
    expect(launch.argv.slice(launch.argv.indexOf("--permission-mode"))).toEqual([
      "--permission-mode",
      "plan",
      "--model",
      "opus",
      "--effort",
      "medium",
      "--name",
      "demo · research-questions",
      "--verbose-ish",
      "--add-dir",
      repo.store("demo"),
    ]);
  });

  test("a Codex profile runs headless steps with codex exec and resumes the interactive session Codex filed", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(
      repo,
      'profile: cx\nprofiles:\n  cx:\n    "*": { harness: codex, subagents: { model: haiku } }\n    codex: { model: gpt-x, effort: medium }\n',
    );
    harness.plan({
      "research-questions": [{ write: { "01-research-questions-demo.md": "" } }],
      research: [{ write: { "02-research-demo.md": "" } }],
      tdd: [{ codexSessions: ["codex-tdd", "codex-later"] }, {}],
    });
    const store = repo.store("demo");

    const first = await keylight("run", "--until", "tdd");
    expect(first.code).toBe(1);
    expect(first.stderr).toBe(
      "\nkeylight: tdd is not finished: no tdd document was written to the task folder.\nNext:  keylight run\n",
    );
    expect(banners(first.stdout)).toEqual([
      "▸ research-questions  codex · gpt-x · medium · headless",
      "▸ research  codex · gpt-x · medium · headless",
      "▸ tdd  codex · gpt-x · medium · interactive",
    ]);
    const [questions, , tdd] = harness.launches() as [Launch, Launch, Launch];
    const options = [
      "-m",
      "gpt-x",
      "-c",
      'model_reasoning_effort="medium"',
      "-s",
      "workspace-write",
      "--add-dir",
      store,
    ];
    expect(questions.program).toBe("codex");
    expect(questions.argv).toEqual([
      "exec",
      ...options,
      `Run the \`kl:create-research-questions\` skill.\n\n${UNATTENDED}`,
    ]);
    expect(tdd.argv).toEqual([...options, "Run the `kl:create-tdd` skill."]);
    expect(questions.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    const state = readState(repo);
    expect(state.steps["research-questions"]).toEqual({ status: "done", at: expect.any(String), harness: "codex" });
    expect(state.steps.tdd).toMatchObject({ status: "started", harness: "codex", session: "codex-tdd" });

    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }] });
    const resumed = await keylight("run", "--until", "tdd");
    expect(resumed.code).toBe(0);
    expect(harness.launches()[3]?.argv).toEqual(["resume", ...options, "codex-tdd"]);
  });

  test("a headless Codex session that exits nonzero is not finished", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(repo, 'profiles:\n  default:\n    "*": { harness: codex, permissions: read-only }\n');
    harness.plan({ "research-questions": [{ exit: 2 }] });

    expect((await keylight("run")).stderr).toBe(
      "\nkeylight: research-questions is not finished: the session exited with status 2.\nNext:  keylight run\n",
    );
    expect(harness.launches()[0]?.argv.slice(0, 4)).toEqual(["exec", "-s", "read-only", "--add-dir"]);
  });

  test("an interactive Codex session Codex did not file, or filed unreadably, leaves nothing to resume", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(repo, 'profiles:\n  default:\n    "*": { harness: codex }\n');
    writeState(repo, done("research-questions", "research"));
    harness.plan({ tdd: [{}] });
    const now = new Date();
    const today = join(
      harness.codexHome,
      "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    mkdirSync(today, { recursive: true });
    const later = new Date(now.getTime() + 60_000);
    writeFileSync(join(today, "rollout-garbled.jsonl"), "not a session\n");
    utimesSync(join(today, "rollout-garbled.jsonl"), later, later);
    writeFileSync(join(today, "notes.txt"), "");

    await keylight("run", "--until", "tdd");
    expect(readState(repo).steps.tdd).toEqual({ status: "started", at: expect.any(String), harness: "codex" });
  });

  test("an unknown profile or harness is a settings error", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using _harness = fakeHarness();
    expect((await keylight("run", "--profile", "nope")).stderr).toBe(
      'keylight: no profile named "nope". Known: default\n',
    );
    writeWorkflows(repo, "profiles:\n  default:\n    research: { harness: gemini }\n");
    writeState(repo, done("research-questions"));
    expect((await keylight("run")).stderr).toBe(
      'keylight: profile "default", step "research": harness must be claude or codex, not "gemini"\n',
    );
  });
});

describe.serial("keylight status", () => {
  test("shows each step's document, phase progress and settings, and the worktree", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    writeWorkflows(repo, 'profiles:\n  default:\n    "*": { model: opus, subagents: { effort: low } }\n');
    const store = repo.store("demo");
    writeFileSync(join(store, "01-research-questions-demo.md"), "");
    writeFileSync(join(store, "02-research-demo.md"), "");
    writeFileSync(join(store, "03-decisions-demo.md"), "## ✅ Phase 1: a\n## Phase 2: b\n");
    writeState(
      repo,
      { grill: {}, worktree: {}, "implement-decisions": { status: "started" } },
      { workflow: "direct", worktree: join(repo.outside, "wt") },
    );

    expect(await keylight("status")).toEqual({
      code: 0,
      stdout: [
        "task      demo",
        "workflow  direct  (profile default)",
        `worktree  ${join(repo.outside, "wt")}`,
        "  ✓ grill                03-decisions-demo.md",
        "  ✓ worktree             ",
        "  ▸ implement-decisions  03-decisions-demo.md  1/2 phases",
        "  · review               claude · opus · headless · sub-agents low",
        "  · pr                   claude · opus · headless · sub-agents low",
        "store     ../artifacts/demo-repo/demo",
        "",
      ].join("\n"),
      stderr: "",
    });
  });
});
