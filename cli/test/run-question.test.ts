// The question `keylight run` asks when an interactive session ends, and the note it can carry to the next one.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Launch } from "./fakes/harness";
import {
  banners,
  documents,
  done,
  plain,
  readState,
  stepOf,
  valueAfter,
  writeState,
  writeWorkflows,
} from "./run-support";
import { atTerminal, fakeHarness, keylight, type TempRepo, tempRepo } from "./support";

describe.serial("an interactive step at a terminal", () => {
  const PROCEED = ["Yes, proceed to the structure outline", "Yes, stop for now"];
  const WITH_NOTE = [...PROCEED, "Yes, send a note to the next session", "No"];

  function setUp(repo: TempRepo) {
    writeState(repo, done("research-questions", "research"));
  }

  test("Enter or 1 counts the step done and starts the next; the last step asks only yes or no", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({
      tdd: [{ write: { "03-tdd-demo.md": "" } }],
      "structure-outline": [{ write: { "04-structure-outline-demo.md": "" } }],
    });
    using terminal = atTerminal(["", "1"]);

    const result = await keylight("run", "--until", "structure-outline");
    expect(result.code).toBe(0);
    expect(terminal.questions).toEqual(["Is the technical design complete?", "Is the structure outline complete?"]);
    expect(terminal.menus).toEqual([WITH_NOTE, ["Yes", "No"]]);
    expect(harness.launches().map(stepOf)).toEqual(["tdd", "structure-outline"]);
    expect(harness.launches()[1]?.argv[0]).toBe("/kl:create-structure-outline");
    expect(plain(result.stdout)).toEndWith("\n\nStopped after structure-outline.\n");
    expect(readState(repo).steps["structure-outline"]?.status).toBe("done");
  });

  test("2 counts the step done and stops before the next", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }] });
    using _terminal = atTerminal(["2"]);

    const result = await keylight("run");
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toEndWith("\nStopped before structure-outline.\nNext:  keylight run\n");
    expect(harness.launches().map(stepOf)).toEqual(["tdd"]);
    expect(readState(repo).steps.tdd?.status).toBe("done");
  });

  test("No or ended input leaves the step open, and the next run resumes its session", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }, {}] });
    using _terminal = atTerminal(["4", null, "2"]);

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

  test("anything that is not one of the numbers is asked about again", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }] });
    using terminal = atTerminal(["y", "5", "0", "2"]);

    const result = await keylight("run");
    expect(result.code).toBe(0);
    expect(terminal.questions).toHaveLength(4);
    expect(result.stdout.split("\nType a number from 1 to 4.\n")).toHaveLength(4);
    expect(readState(repo).steps.tdd?.status).toBe("done");
  });

  test("a step without a title is asked about by its name", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeWorkflows(
      repo,
      "workflows:\n  design: [first, second]\nsteps:\n" +
        '  first: { skill: "kl:keylight", session: interactive }\n' +
        '  second: { skill: "kl:keylight", session: interactive }\n',
    );
    using terminal = atTerminal(["2"]);

    expect((await keylight("run")).code).toBe(0);
    expect(terminal.questions).toEqual(["Is first complete?"]);
    expect(terminal.menus[0]?.[0]).toBe("Yes, proceed to second");
    expect(harness.launches().map(stepOf)).toEqual(["first"]);
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

describe.serial("a note for the next step", () => {
  const NOTE = "A note from the user for this step: ";

  function setUp(repo: TempRepo) {
    writeState(repo, done("research-questions", "research"));
  }

  test("3 asks for a note, counts the step done and opens the next session with it", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({
      tdd: [{ write: { "03-tdd-demo.md": "" } }],
      "structure-outline": [{ write: { "04-structure-outline-demo.md": "" } }],
    });
    using terminal = atTerminal(["3", "No mocks in phase one", ""]);

    const result = await keylight("run", "--until", "structure-outline");
    expect(result.code).toBe(0);
    expect(terminal.questions).toEqual([
      "Is the technical design complete?",
      "Note for the structure outline",
      "Is the structure outline complete?",
    ]);
    expect(harness.launches()[1]?.argv[0]).toBe(`/kl:create-structure-outline\n\n${NOTE}No mocks in phase one`);
    expect(plain(result.stdout)).toContain(
      "\n▸ structure-outline  claude · interactive\n  note: No mocks in phase one\n",
    );
    expect(readState(repo)).toMatchObject({
      notes: { "structure-outline": "No mocks in phase one" },
      steps: { tdd: { status: "done" } },
    });
  });

  test("a note skips a code step, waits for the session after it, and shows in status until that step is done", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeState(repo, done("research-questions", "research", "tdd"));
    harness.plan({ "structure-outline": [{ write: { "04-structure-outline-demo.md": "" } }] });
    using terminal = atTerminal(["3", "Run the review on every phase"]);

    expect((await keylight("run", "--until", "worktree")).code).toBe(0);
    expect(terminal.menus[0]?.[0]).toBe("Yes, proceed to the worktree");
    expect(terminal.questions[1]).toBe("Note for the implementation");
    expect(readState(repo).notes).toEqual({ "implement-outline": "Run the review on every phase" });
    const pending = plain((await keylight("status")).stdout);
    expect(pending).toContain(
      "\n  ▸ implement-outline   claude · interactive\n    note: Run the review on every phase\n",
    );

    const state = readState(repo);
    state.steps["implement-outline"] = { status: "done", at: "2024-01-01T00:00:00.000Z" };
    writeFileSync(join(repo.store("demo"), ".keylight.json"), JSON.stringify(state));
    expect(plain((await keylight("status")).stdout)).not.toContain("note:");
  });

  test("an empty note returns to the question, and input that ends there leaves the step open", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }, {}] });
    using terminal = atTerminal(["3", "", "3", null, "2"]);

    expect(plain((await keylight("run")).stdout)).toEndWith("\ntdd is left open.\nNext:  keylight run\n");
    expect(terminal.questions).toEqual([
      "Is the technical design complete?",
      "Note for the structure outline",
      "Is the technical design complete?",
      "Note for the structure outline",
    ]);
    expect(plain((await keylight("run")).stdout)).toEndWith(
      "\nStopped before structure-outline.\nNext:  keylight run\n",
    );
    expect(readState(repo).notes).toBeUndefined();
  });

  test("no note is offered for a step that will continue its session", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeState(repo, {
      ...done("research-questions", "research"),
      "structure-outline": { status: "started", harness: "claude", session: "outline-session" },
    });
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }] });
    using terminal = atTerminal(["3"]);

    expect(plain((await keylight("run")).stdout)).toEndWith("\ntdd is left open.\nNext:  keylight run\n");
    expect(terminal.menus).toEqual([["Yes, proceed to the structure outline", "Yes, stop for now", "No"]]);
  });

  test("--note reaches the first new session of the run, and a dry run keeps nothing", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    setUp(repo);
    harness.plan({ tdd: [{ write: { "03-tdd-demo.md": "" } }] });

    const dry = await keylight("run", "--note", "Use the retry design", "--until", "tdd", "--dry-run");
    expect(dry.stdout).toContain(`${NOTE}Use the retry design`);
    expect(readState(repo).notes).toBeUndefined();

    expect((await keylight("run", "--note", "Use the retry design", "--until", "tdd")).code).toBe(0);
    expect(harness.launches()[0]?.argv[0]).toBe(`/kl:create-tdd\n\n${NOTE}Use the retry design`);
    expect(readState(repo).notes).toEqual({ tdd: "Use the retry design" });
  });

  test("--note is refused when the run starts no new session", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using harness = fakeHarness();
    writeState(repo, {
      ...done("research-questions", "research"),
      tdd: { status: "started", harness: "claude", session: "tdd-session" },
    });

    expect(await keylight("run", "--note", "Mind the cache")).toEqual({
      code: 1,
      stdout: documents(repo),
      stderr:
        "keylight: tdd continues its session, which takes no opening message: " +
        "type the note there, or add --fresh to start tdd over\n",
    });
    expect(await keylight("run", "--note", "Mind the cache", "--from", "worktree", "--until", "worktree")).toEqual({
      code: 1,
      stdout: documents(repo),
      stderr: "keylight: --note needs a step that starts a session, and this run has none\n",
    });
    expect(harness.launches()).toEqual([]);
    expect(readState(repo).notes).toBeUndefined();
  });
});
