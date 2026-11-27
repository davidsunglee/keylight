import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atTerminal, keylight, pipedStdin, tempRepo } from "./support";

const header = (label: string) => `---\ntype: scratch\n---\n\n# Scratch: ${label}\n`;

describe.serial("keylight scratch", () => {
  test("adds each piped entry above the earlier ones and prints the page's link", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const page = join(repo.store("demo"), "scratch.md");
    const link = `http://localhost:${repo.viewer.port}/view/demo-repo/demo/scratch.md\n`;

    {
      using _stdin = pipedStdin("\n  A sketch of the flow  \n\n");
      expect(await keylight("scratch")).toEqual({ code: 0, stdout: link, stderr: "" });
    }
    const first = readFileSync(page, "utf8");
    expect(first).toMatch(/^---\ntype: scratch\n---\n\n# Scratch: demo\n\n## .+\n\nA sketch of the flow\n$/);
    const dated = first.slice(header("demo").length + 1);

    {
      using _stdin = pipedStdin("## Second\n\nAnother view");
      expect((await keylight("scratch")).stdout).toBe(link);
    }
    expect(readFileSync(page, "utf8")).toBe(`${header("demo")}\n## Second\n\nAnother view\n\n---\n\n${dated}`);
  });

  test("without an entry, creates the empty page once and prints its link", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const page = join(repo.store("demo"), "scratch.md");
    const result = await keylight("scratch");
    expect(result).toEqual({
      code: 0,
      stdout: `http://localhost:${repo.viewer.port}/view/demo-repo/demo/scratch.md\n`,
      stderr: "",
    });
    expect(readFileSync(page, "utf8")).toBe(header("demo"));

    writeFileSync(page, `${header("demo")}\n## Kept\n`);
    await keylight("scratch");
    expect(readFileSync(page, "utf8")).toBe(`${header("demo")}\n## Kept\n`);
  });

  test("at a terminal, standard input is not read for an entry", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    using _stdin = pipedStdin("not an entry");
    using _terminal = atTerminal();
    expect((await keylight("scratch")).code).toBe(0);
    expect(readFileSync(join(repo.store("demo"), "scratch.md"), "utf8")).toBe(header("demo"));
  });

  test("--dir prints the page's folder and creates nothing", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    expect(await keylight("scratch", "--dir")).toEqual({ code: 0, stdout: `${repo.store("demo")}\n`, stderr: "" });
    expect(existsSync(join(repo.store("demo"), "scratch.md"))).toBe(false);
  });

  test("a repository with no linked task keeps one page for the repository", async () => {
    using repo = tempRepo();
    expect((await keylight("scratch")).stdout).toBe(
      `http://localhost:${repo.viewer.port}/view/demo-repo/scratch/scratch.md\n`,
    );
    expect(readFileSync(join(repo.root, "demo-repo/scratch/scratch.md"), "utf8")).toBe(header("demo-repo (no task)"));
  });

  test("outside a repository the page is named after the working directory", async () => {
    using repo = tempRepo();
    process.chdir(repo.outside);
    expect((await keylight("scratch", "--dir")).stdout).toBe(`${join(repo.root, "scratch/outside")}\n`);
    await keylight("scratch");
    expect(readFileSync(join(repo.root, "scratch/outside/scratch.md"), "utf8")).toBe(header("outside"));
  });

  test("with several tasks linked, the page belongs to the one named", async () => {
    using repo = tempRepo({ tasks: ["alpha", "beta"] });
    const ambiguous = await keylight("scratch");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toStartWith("keylight: several tasks are linked to this worktree:\n");
    expect((await keylight("scratch", "--dir", "--task", "beta")).stdout).toBe(`${repo.store("beta")}\n`);
  });
});
