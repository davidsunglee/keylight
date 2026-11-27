// The worktree step through `keylight worktree`: where the checkout goes, the
// branch it is on, what is copied and run in it, and the settings that change
// each.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, keylight, type TempRepo, tempRepo } from "./support";

function workspace(repo: TempRepo, settings: object, file = ".keylight/workspace.json") {
  mkdirSync(join(repo.worktree, file, ".."), { recursive: true });
  writeFileSync(join(repo.worktree, file), JSON.stringify(settings));
}

const defaultPath = (repo: TempRepo) => join(repo.home, ".keylight/workspaces/demo/demo-repo");

describe.serial("keylight worktree", () => {
  test("creates the checkout under ~/.keylight/workspaces on the task's branch, with the local files copied", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    writeFileSync(join(repo.worktree, ".env.local"), "TOKEN=1\n");
    mkdirSync(join(repo.worktree, ".claude"));
    writeFileSync(join(repo.worktree, ".claude/settings.local.json"), "{}\n");
    writeFileSync(join(repo.worktree, "notes.txt"), "not copied\n");
    const path = defaultPath(repo);

    expect(await keylight("worktree")).toEqual({
      code: 0,
      stdout: `created ${path} on branch demo, copied 2 local files\nworktree  ${path}\nbase      ${git(repo.worktree, "rev-parse", "HEAD")}\n`,
      stderr: "",
    });
    expect(git(path, "branch", "--show-current")).toBe("demo");
    expect(readFileSync(join(path, ".env.local"), "utf8")).toBe("TOKEN=1\n");
    expect(existsSync(join(path, ".claude/settings.local.json"))).toBe(true);
    expect(existsSync(join(path, "notes.txt"))).toBe(false);
    expect(existsSync(join(path, ".artifacts/tasks/demo/task.md"))).toBe(true);
    expect(git(path, "status", "--porcelain")).toBe("?? .claude/\n?? .env.local");
  });

  test("checks out a branch that already exists, and reuses a checkout that already exists", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    git(repo.worktree, "branch", "demo");
    const path = defaultPath(repo);

    expect((await keylight("worktree")).stdout).toStartWith(`created ${path} on branch demo\n`);
    expect(git(path, "branch", "--show-current")).toBe("demo");
    expect((await keylight("worktree")).stdout).toStartWith(`reusing ${path}\nworktree  ${path}\n`);
  });

  test("refuses a path that exists and is not a git checkout", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    mkdirSync(defaultPath(repo), { recursive: true });
    expect(await keylight("worktree")).toEqual({
      code: 1,
      stdout: "",
      stderr: `keylight: ${defaultPath(repo)} exists and is not a git checkout\n`,
    });
  });

  test("inside a worktree already, the work stays there", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const other = join(repo.outside, "feature");
    git(repo.worktree, "worktree", "add", "-q", "-b", "feature", other);
    process.chdir(other);
    await keylight("task", "new", "demo");

    expect(await keylight("worktree")).toEqual({
      code: 0,
      stdout: `already in a worktree; using ${other}\nworktree  ${other}\nbase      ${git(other, "rev-parse", "HEAD")}\n`,
      stderr: "",
    });
  });

  test("with worktrees disabled, checks out the task's branch in place", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    workspace(repo, { disabled: true, branchTemplate: "task/{{ TASKSLUG }}-{{ REPOBASENAME }}" });
    const note = "worktrees are disabled for this repository; checked out branch task/demo-demo-repo in place";

    expect((await keylight("worktree")).stdout).toBe(
      `${note}\nworktree  ${repo.worktree}\nbase      ${git(repo.worktree, "rev-parse", "HEAD")}\n`,
    );
    expect(git(repo.worktree, "branch", "--show-current")).toBe("task/demo-demo-repo");
    git(repo.worktree, "checkout", "-q", "main");
    expect((await keylight("worktree")).stdout).toStartWith(`${note}\n`);
    expect(git(repo.worktree, "branch", "--show-current")).toBe("task/demo-demo-repo");
  });

  test("runs the setup command in a new checkout, and a failing one is an error", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const path = join(repo.outside, "wt/demo");
    workspace(repo, {
      pathTemplate: join(repo.outside, "wt/{{ TASKSLUG }}"),
      repos: [{ localPath: ".", setupCommand: "touch set-up" }],
    });

    expect((await keylight("worktree")).stdout).toStartWith(`created ${path} on branch demo\nran: touch set-up\n`);
    expect(existsSync(join(path, "set-up"))).toBe(true);
    expect((await keylight("worktree")).stdout).toStartWith(`reusing ${path}\n`);

    workspace(repo, {
      pathTemplate: join(repo.outside, "wt/again-{{ TASKSLUG }}"),
      branchTemplate: "again-{{ TASKSLUG }}",
      repos: [{ localPath: ".", setupCommand: "exit 3" }],
    });
    expect((await keylight("worktree")).stderr).toBe(
      `keylight: setup command failed in ${join(repo.outside, "wt/again-demo")}: exit 3\n`,
    );
  });

  test("local settings override the shared ones, and an earlier .humanlayer file is read when there is none", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    workspace(repo, { pathTemplate: "~/.humanlayer/workspaces/{{ TASKSLUG }}" }, ".humanlayer/workspace.json");
    expect((await keylight("worktree")).stdout).toStartWith(`created ${join(repo.home, ".keylight/workspaces/demo")} `);

    workspace(repo, {
      pathTemplate: join(repo.outside, "shared/{{ TASKSLUG }}"),
      branchTemplate: "shared-{{ TASKSLUG }}",
    });
    workspace(repo, { pathTemplate: join(repo.outside, "local/{{ TASKSLUG }}") }, ".keylight/workspace.local.json");
    expect((await keylight("worktree")).stdout).toStartWith(
      `created ${join(repo.outside, "local/demo")} on branch shared-demo, copied 1 local file\n`,
    );
  });

  test("creates a checkout of every listed repository, from each one's own ref", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const sibling = join(repo.outside, "sibling");
    mkdirSync(sibling);
    git(sibling, "init", "-q", "-b", "main");
    git(
      sibling,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "one",
    );
    const first = git(sibling, "rev-parse", "HEAD");
    git(
      sibling,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "two",
    );
    workspace(repo, {
      pathTemplate: join(repo.outside, "wt/{{ TASKSLUG }}/{{ REPOBASENAME }}"),
      repos: [{ localPath: sibling, sourceRef: first }, { localPath: "." }],
    });

    const result = await keylight("worktree");
    expect(result.stdout).toStartWith(
      `created ${join(repo.outside, "wt/demo/sibling")} on branch demo\n` +
        `created ${join(repo.outside, "wt/demo/demo-repo")} on branch demo\n` +
        `worktree  ${join(repo.outside, "wt/demo/demo-repo")}\n`,
    );
    expect(git(join(repo.outside, "wt/demo/sibling"), "rev-parse", "HEAD")).toBe(first);
  });

  test("settings without the repository itself, or that are not JSON, are refused", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const sibling = join(repo.outside, "sibling");
    mkdirSync(sibling);
    git(sibling, "init", "-q", "-b", "main");
    git(
      sibling,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "one",
    );
    workspace(repo, { pathTemplate: join(repo.outside, "wt/{{ REPOBASENAME }}"), repos: [{ localPath: sibling }] });
    expect((await keylight("worktree")).stderr).toBe(
      'keylight: workspace settings need a repos entry with "localPath": "."\n',
    );

    writeFileSync(join(repo.worktree, ".keylight/workspace.json"), "{ nope");
    expect((await keylight("worktree")).stderr).toStartWith(
      `keylight: ${join(repo.worktree, ".keylight/workspace.json")}: `,
    );
  });

  test("a failing git command reports git's own words", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    workspace(repo, {
      pathTemplate: join(repo.outside, "wt/{{ TASKSLUG }}"),
      repos: [{ localPath: ".", sourceRef: "nope" }],
    });
    const result = await keylight("worktree");
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith(
      `keylight: git worktree add -b demo ${join(repo.outside, "wt/demo")} nope failed:\n`,
    );
  });
});
