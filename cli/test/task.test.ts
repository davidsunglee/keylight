import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TASK_USAGE } from "../task";
import { git, keylight, scopedEnv, tempRepo } from "./support";

const today = () => new Date().toISOString().slice(0, 10);

describe.serial("keylight task", () => {
  test("shows the linked task and its files, numbers in order and hidden files left out", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const store = repo.store("demo");
    for (const file of ["10-review-demo.md", "02-tdd-demo.md", "01-research-demo.md", ".keylight.json"]) {
      writeFileSync(join(store, file), "");
    }
    mkdirSync(join(store, "review-loop"));

    const expected = [
      "task   demo",
      "dir    .artifacts/tasks/demo",
      `store  ${store}`,
      "files",
      "  01-research-demo.md",
      "  02-tdd-demo.md",
      "  10-review-demo.md",
      "  review-loop/",
      "  task.md",
      "",
    ].join("\n");
    expect(await keylight("task")).toEqual({ code: 0, stdout: expected, stderr: "" });
    expect((await keylight("task", "show")).stdout).toBe(expected);
  });

  test("new creates the store, its task.md and the link, and excludes the link from git once", async () => {
    using repo = tempRepo();
    const store = repo.store("demo");

    const created = await keylight("task", "new", "demo");
    expect(created).toEqual({
      code: 0,
      stdout: `Created task demo.\ntask   demo\ndir    .artifacts/tasks/demo\nstore  ${store}\nfiles\n  task.md\n`,
      stderr: "",
    });
    expect(readFileSync(join(store, "task.md"), "utf8")).toBe(
      `---\ntask: demo\nrepo: demo-repo\ncreated: ${today()}\n---\n\n# demo\n\n` +
        "[What this task is: a link to the ticket, or a few sentences describing the ask.]\n",
    );
    expect(readlinkSync(join(repo.worktree, ".artifacts/tasks/demo"))).toBe(store);

    writeFileSync(join(store, "task.md"), "kept\n");
    const linked = await keylight("task", "new", "demo");
    expect(linked.stdout).toStartWith("Linked existing task demo.\n");
    expect(readFileSync(join(store, "task.md"), "utf8")).toBe("kept\n");

    const exclude = readFileSync(join(repo.worktree, ".git/info/exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === "/.artifacts/")).toHaveLength(1);
    expect(git(repo.worktree, "status", "--porcelain")).toBe("");
  });

  test("new links a task stored by another worktree of the same repository", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const other = join(repo.outside, "feature");
    git(repo.worktree, "worktree", "add", "-q", "-b", "feature", other);
    process.chdir(other);

    const linked = await keylight("task", "new", "demo");
    expect(linked.stdout).toStartWith("Linked existing task demo.\n");
    expect(realpathSync(join(other, ".artifacts/tasks/demo"))).toBe(repo.store("demo"));
  });

  test("new refuses a missing or invalid name and a dangling link", async () => {
    using repo = tempRepo();
    expect(await keylight("task", "new")).toEqual({
      code: 1,
      stdout: "",
      stderr: "keylight: usage: keylight task new <task>   e.g. cor-310-page-offset\n",
    });
    expect((await keylight("task", "new", "Bad_Name")).stderr).toBe(
      'keylight: "Bad_Name" is not a valid task name: use lowercase letters, digits and dashes\n',
    );

    mkdirSync(join(repo.worktree, ".artifacts/tasks"), { recursive: true });
    symlinkSync(join(repo.outside, "moved"), join(repo.worktree, ".artifacts/tasks/demo"));
    expect(await keylight("task", "new", "demo")).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "keylight: .artifacts/tasks/demo exists but points nowhere. Remove it, then run the command again.\n" +
        "Next:  rm .artifacts/tasks/demo\n",
    });
  });

  test("list shows stored tasks newest first and marks the linked ones", async () => {
    using repo = tempRepo({ tasks: ["linked"] });
    expect((await keylight("task", "list")).stdout).toBe(`${today()}  linked  (linked here)\n`);

    mkdirSync(repo.store("older"));
    mkdirSync(repo.store(".hidden"));
    writeFileSync(join(repo.root, repo.name, "a-file"), "");
    utimesSync(repo.store("older"), new Date("2024-03-01T12:00:00Z"), new Date("2024-03-01T12:00:00Z"));
    expect(await keylight("task", "list")).toEqual({
      code: 0,
      stdout: `${today()}  linked  (linked here)\n2024-03-01  older\n`,
      stderr: "",
    });
  });

  test("list says when nothing is stored for the repository", async () => {
    using repo = tempRepo();
    expect((await keylight("task", "list")).stdout).toBe(`No tasks stored for demo-repo under ${repo.root}.\n`);
  });

  test("next gives the path after the highest numbered document, relative to the caller", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    expect((await keylight("task", "next", "research", "retry")).stdout).toBe(
      ".artifacts/tasks/demo/01-research-retry.md\n",
    );

    writeFileSync(join(repo.store("demo"), "01-research-retry.md"), "");
    writeFileSync(join(repo.store("demo"), "09-review-prompt-x.md"), "");
    expect((await keylight("task", "next", "tdd", "retry")).stdout).toBe(".artifacts/tasks/demo/10-tdd-retry.md\n");

    mkdirSync(join(repo.worktree, "src"));
    process.chdir(join(repo.worktree, "src"));
    expect((await keylight("task", "next", "tdd", "retry")).stdout).toBe("../.artifacts/tasks/demo/10-tdd-retry.md\n");
  });

  test("next refuses a missing or invalid kind or slug", async () => {
    using _repo = tempRepo({ tasks: ["demo"] });
    const usage = "keylight: usage: keylight task next <kind> <slug>   e.g. keylight task next tdd retry-policy\n";
    expect(await keylight("task", "next", "tdd")).toEqual({ code: 1, stdout: "", stderr: usage });
    expect((await keylight("task", "next", "TDD", "retry")).stderr).toBe(usage);
  });

  test("with several tasks linked, one is chosen by --task or KEYLIGHT_TASK, the flag first", async () => {
    using repo = tempRepo({ tasks: ["alpha", "beta"] });
    expect(await keylight("task")).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "keylight: several tasks are linked to this worktree:\n  alpha\n  beta\n" +
        "Next:  repeat the command with --task <task>\n",
    });
    expect((await keylight("task", "--task", "beta")).stdout).toStartWith("task   beta\n");
    expect((await keylight("task", "--task=beta")).stdout).toStartWith("task   beta\n");
    expect((await keylight("task", "--task", "beta", "next", "tdd", "x")).stdout).toBe(
      ".artifacts/tasks/beta/01-tdd-x.md\n",
    );
    {
      using _env = scopedEnv({ KEYLIGHT_TASK: "beta" });
      expect((await keylight("task")).stdout).toStartWith("task   beta\n");
      expect((await keylight("task", "--task", "alpha")).stdout).toStartWith("task   alpha\n");
    }
    expect(existsSync(repo.store("alpha"))).toBe(true);
  });

  test("a named task must be linked here, and a worktree without one says how to link it", async () => {
    using _repo = tempRepo();
    expect((await keylight("task", "--task", "gamma")).stderr).toBe(
      'keylight: task "gamma" is not linked to this worktree.\nNext:  keylight task new gamma\n',
    );
    expect(await keylight("task")).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "keylight: no task is linked to this worktree. `keylight task list` shows the ones stored for demo-repo.\n" +
        "Next:  keylight task new <task>\n",
    });
  });

  test("an unknown subcommand prints the usage, and outside a repository nothing runs", async () => {
    using repo = tempRepo();
    expect(await keylight("task", "bogus")).toEqual({
      code: 1,
      stdout: "",
      stderr: `keylight: unknown subcommand "bogus".\n${TASK_USAGE}\n`,
    });
    process.chdir(repo.outside);
    expect(await keylight("task", "list")).toEqual({
      code: 1,
      stdout: "",
      stderr: "keylight: not inside a git repository\n",
    });
  });
});
