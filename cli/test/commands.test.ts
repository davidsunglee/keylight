import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "../../viewer/test/support";
import { runCommand } from "../commands";
import { atTerminal, git, keylight, scopedEnv, standInViewer, tempRepo } from "./support";

const today = () => new Date().toISOString().slice(0, 10);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const DESIGN_STEPS = [
  "research-questions",
  "research",
  "tdd",
  "structure-outline",
  "worktree",
  "implement-outline",
  "pr",
];

describe.serial("help and dispatch", () => {
  test("help, its aliases and no command print the same usage, even with an invalid port", async () => {
    using _repo = tempRepo();
    const help = await keylight("help");
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toStartWith('keylight start <ticket | "description">   create a task and run its workflow\n');
    expect(help.stdout).toContain("\nkeylight task new <task>           create the task folder");
    expect(help.stdout).toEndWith("             KEYLIGHT_CONFIG (default ~/.config/keylight; holds themes)\n");
    for (const argv of [[], ["--help"], ["-h"], ["help", "--port", "0"]]) {
      expect(await keylight(...argv)).toEqual(help);
    }
  });

  test("an unknown command names itself and points at help", async () => {
    using _repo = tempRepo();
    for (const command of ["nope", "constructor", ""]) {
      expect(await keylight(command)).toEqual({
        code: 1,
        stdout: "",
        stderr: `keylight: unknown command "${command}".\nNext:  keylight help\n`,
      });
    }
  });

  test("an invalid port is not a command failure and reaches the caller as an error", async () => {
    using _repo = tempRepo();
    expect(runCommand(["stop", "--port", "0"])).rejects.toThrow("Invalid port: 0");
  });

  test("a broken workflows file is reported as one line and exit 1", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const file = join(repo.configDir, "workflows.yaml");
    writeFileSync(file, "workflows:\n  mine: [nope]\n");
    expect(await keylight("status")).toEqual({
      code: 1,
      stdout: "",
      stderr: `keylight: ${file}: workflow "mine" names an unknown step "nope"\n`,
    });
  });
});

describe.serial("start and status", () => {
  test("start --no-run creates the task, its summary and its state", async () => {
    using repo = tempRepo();
    const store = repo.store("flaky");
    expect(await keylight("start", "Fix the flaky test", "--name", "flaky", "--no-run")).toEqual({
      code: 0,
      stdout: "Created task flaky (design workflow).\n",
      stderr: "",
    });
    expect(readFileSync(join(store, "task.md"), "utf8")).toBe(
      `---\ntask: flaky\nrepo: demo-repo\ncreated: ${today()}\n---\n\n# Fix the flaky test\n\nFix the flaky test\n`,
    );
    expect(readJson(join(store, ".keylight.json"))).toEqual({
      workflow: "design",
      profile: "default",
      checkout: repo.worktree,
      steps: {},
    });
    expect(existsSync(join(repo.worktree, ".artifacts/tasks/flaky/task.md"))).toBe(true);
  });

  test("start takes the workflow and profile flags and refuses a task that already has a workflow", async () => {
    using repo = tempRepo();
    writeFileSync(join(repo.configDir, "workflows.yaml"), 'profiles:\n  fast:\n    "*": { harness: codex }\n');
    const created = await keylight(
      "start",
      "Plan",
      "--workflow",
      "direct",
      "--profile",
      "fast",
      "--name=plan",
      "--no-run",
    );
    expect(created.stdout).toBe("Created task plan (direct workflow).\n");
    expect(readJson(join(repo.store("plan"), ".keylight.json"))).toMatchObject({ workflow: "direct", profile: "fast" });

    expect(await keylight("start", "Again", "--name", "plan", "--no-run")).toEqual({
      code: 1,
      stdout: "",
      stderr: "keylight: task plan already exists.\nNext:  keylight run --task plan\n",
    });
  });

  test("start refuses a missing description, an invalid name, an unknown workflow and a ticket without a key", async () => {
    using _repo = tempRepo();
    expect((await keylight("start", "--no-run")).stderr).toBe(
      'keylight: usage: keylight start <ticket | "description"> [--workflow NAME] [--profile NAME] [--name TASK]\n',
    );
    expect((await keylight("start", "Fix it", "--name", "Fix_It", "--no-run")).stderr).toBe(
      'keylight: "Fix_It" is not a valid task name: use lowercase letters, digits and dashes\n',
    );
    expect(await keylight("start", "Fix it", "--name", "fix", "--workflow", "nope")).toEqual({
      code: 1,
      stdout: "",
      stderr: 'keylight: no workflow named "nope". Known: direct, design, product\n',
    });
    const ticket = await keylight("start", "ABC-123", "--no-run");
    expect(ticket.code).toBe(1);
    expect(ticket.stderr).toStartWith("keylight: ABC-123 looks like a Linear ticket, and LINEAR_API_KEY is not set.");
    expect(ticket.stderr).toEndWith('\nNext:  keylight start "what to build"\n');
  });

  test("start --dry-run still creates the task, then prints the steps without launching them", async () => {
    using repo = tempRepo();
    const result = await keylight("start", "Dry", "--name", "dry", "--dry-run");
    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("Created task dry (design workflow).\ndry  design workflow · default profile\n");
    expect(result.stdout).not.toContain("Documents:");
    expect(readJson(join(repo.store("dry"), ".keylight.json")).steps).toEqual({});
  });

  test("status before and after a workflow starts", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    expect(await keylight("status")).toEqual({
      code: 0,
      stdout: "task      demo\nworkflow  (not started)\nNext:  keylight run [--workflow NAME]\n",
      stderr: "",
    });

    writeFileSync(join(repo.store("demo"), "01-research-questions-demo.md"), "");
    writeFileSync(
      join(repo.store("demo"), ".keylight.json"),
      JSON.stringify({
        workflow: "design",
        profile: "default",
        checkout: repo.worktree,
        steps: { "research-questions": { status: "done", at: "2024-01-01T00:00:00Z" } },
      }),
    );
    expect((await keylight("status")).stdout).toBe(
      [
        "task      demo",
        "workflow  design  (profile default)",
        "  ✓ research-questions  01-research-questions-demo.md",
        "  ▸ research            claude · headless",
        "  · tdd                 claude · interactive",
        "  · structure-outline   claude · interactive",
        "  · worktree            code",
        "  · implement-outline   claude · interactive",
        "  · pr                  claude · headless",
        "store     ../artifacts/demo-repo/demo",
        "",
      ].join("\n"),
    );
  });
});

describe.serial("run", () => {
  test("--dry-run prints each step's session and writes nothing", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const result = await keylight("run", "--dry-run");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const banners = result.stdout.split("\n").filter((line) => line.startsWith("▸ "));
    expect(banners.map((line) => line.split("  ")[0])).toEqual(DESIGN_STEPS.map((step) => `▸ ${step}`));
    expect(result.stdout).toContain(`  in ${repo.worktree}\n  claude -p '/kl:create-research-questions`);
    expect(result.stdout).not.toContain("Documents:");
    expect(existsSync(join(repo.store("demo"), ".keylight.json"))).toBe(false);
  });

  test("--from and --until choose the steps, and must name steps of the workflow", async () => {
    using _repo = tempRepo({ tasks: ["demo"] });
    const ranged = await keylight("run", "--dry-run", "--from", "tdd", "--until", "structure-outline");
    expect(ranged.stdout.split("\n").filter((line) => line.startsWith("▸ "))).toEqual([
      "▸ tdd  claude · interactive",
      "▸ structure-outline  claude · interactive",
    ]);
    expect(await keylight("run", "--dry-run", "--from", "nope")).toEqual({
      code: 1,
      stdout: "",
      stderr: `keylight: "nope" is not a step of the design workflow (${DESIGN_STEPS.join(", ")})\n`,
    });
  });

  test("a finished workflow prints the documents link and says so", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const steps = Object.fromEntries(DESIGN_STEPS.map((step) => [step, { status: "done", at: "2024-01-01" }]));
    writeFileSync(
      join(repo.store("demo"), ".keylight.json"),
      JSON.stringify({ workflow: "design", profile: "default", checkout: repo.worktree, steps }),
    );
    expect(await keylight("run")).toEqual({
      code: 0,
      stdout:
        `Documents: http://localhost:${repo.viewer.port}/view/demo-repo/demo\n` +
        "Every step of design is done for demo.\n",
      stderr: "",
    });
  });
});

describe.serial("gate and worktree", () => {
  test("gate prints the step's gate prompt, the repository's copy first", async () => {
    using repo = tempRepo();
    const shipped = readFileSync(join(import.meta.dir, "../../plugin/skills/create-tdd/gate-system-design.md"), "utf8");
    expect(await keylight("gate", "tdd", "system-design")).toEqual({
      code: 0,
      stdout: `${shipped.trim()}\n`,
      stderr: "",
    });

    mkdirSync(join(repo.worktree, ".keylight/prompts"), { recursive: true });
    writeFileSync(join(repo.worktree, ".keylight/prompts/tdd.system-design.md"), "Our own check.\n");
    {
      using _env = scopedEnv({ KEYLIGHT_STEP: "tdd" });
      expect((await keylight("gate", "system-design")).stdout).toBe("Our own check.\n");
    }
  });

  test("gate needs a step and a gate, and a gate that exists", async () => {
    using _repo = tempRepo();
    expect(await keylight("gate", "system-design")).toEqual({
      code: 1,
      stdout: "",
      stderr: "keylight: usage: keylight gate <step> <gate>   e.g. keylight gate tdd system-design\n",
    });
    expect((await keylight("gate", "tdd", "nope")).stderr).toBe('keylight: no prompt for gate "nope" of step "tdd"\n');
  });

  test("worktree creates the task's checkout, links the task into it and records it", async () => {
    using repo = tempRepo();
    await keylight("start", "Work", "--name", "work", "--no-run");
    mkdirSync(join(repo.worktree, ".keylight"));
    const template = join(repo.outside, "workspaces/{{ TASKSLUG }}/{{ REPOBASENAME }}");
    writeFileSync(join(repo.worktree, ".keylight/workspace.json"), JSON.stringify({ pathTemplate: template }));
    const path = join(repo.outside, "workspaces/work/demo-repo");
    const base = git(repo.worktree, "rev-parse", "HEAD");

    expect(await keylight("worktree")).toEqual({
      code: 0,
      stdout: `created ${path} on branch work\nworktree  ${path}\nbase      ${base}\n`,
      stderr: "",
    });
    expect(git(path, "branch", "--show-current")).toBe("work");
    expect(existsSync(join(path, ".artifacts/tasks/work/task.md"))).toBe(true);
    const state = readJson(join(repo.store("work"), ".keylight.json"));
    expect(state.worktree).toBe(path);
    expect(state.base).toBe(base);
    expect(state.steps.worktree.status).toBe("done");

    expect((await keylight("worktree")).stdout).toStartWith(`reusing ${path}\n`);
  });
});

describe.serial("the viewer commands", () => {
  test("url prints the root's link, or a file's through the task link", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const base = `http://localhost:${repo.viewer.port}`;
    expect(await keylight("url")).toEqual({ code: 0, stdout: `${base}/\n`, stderr: "" });
    writeFileSync(join(repo.store("demo"), "notes #1.md"), "");
    expect((await keylight("url", ".artifacts/tasks/demo/notes #1.md")).stdout).toBe(
      `${base}/view/demo-repo/demo/notes%20%231.md\n`,
    );
    expect((await keylight("url", repo.root)).stdout).toBe(`${base}/\n`);
    expect((await keylight("view", "--no-open", ".artifacts/tasks/demo")).stdout).toBe(`${base}/view/demo-repo/demo\n`);
  });

  test("a public URL replaces the local address in printed links", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    expect((await keylight("url", "--public-url", "https://box.example.ts.net/", repo.store("demo"))).stdout).toBe(
      "https://box.example.ts.net/view/demo-repo/demo\n",
    );
    using _env = scopedEnv({ KEYLIGHT_PUBLIC_URL: "https://env.example" });
    expect((await keylight("url")).stdout).toBe("https://env.example/\n");
  });

  test("a missing file or one outside the root is refused", async () => {
    using repo = tempRepo();
    expect(await keylight("url", "missing.md")).toEqual({
      code: 1,
      stdout: "",
      stderr: "keylight: no such file: missing.md\n",
    });
    writeFileSync(join(repo.outside, "x.md"), "");
    expect((await keylight("view", "--no-open", join(repo.outside, "x.md"))).stderr).toBe(
      `keylight: ${join(repo.outside, "x.md")} is not under the artifact root ${repo.root}. ` +
        "Pass --root to view another directory.\n",
    );
  });

  test("a named root that does not exist is refused", async () => {
    using repo = tempRepo();
    const missing = join(repo.outside, "missing");
    const refused = { code: 1, stdout: "", stderr: `keylight: artifact root does not exist: ${missing}\n` };
    expect(await keylight("url", "--root", missing)).toEqual(refused);
    using _env = scopedEnv({ KEYLIGHT_ROOT: missing });
    expect(await keylight("view", "--no-open")).toEqual(refused);
    expect(existsSync(missing)).toBe(false);
  });

  test("a port serving another root fails view and still lets url print the link", async () => {
    using repo = tempRepo();
    using other = standInViewer(repo.outside);
    const port = String(other.port);
    expect(await keylight("view", "--no-open", "--port", port)).toEqual({
      code: 1,
      stdout: "",
      stderr:
        `keylight: port ${port} already serves ${repo.outside}. Pass --port to use another port, or stop that viewer.\n` +
        "Next:  keylight stop\n",
    });
    expect(await keylight("url", "--port", port)).toEqual({
      code: 0,
      stdout: `http://localhost:${port}/\n`,
      stderr: "",
    });

    using _terminal = atTerminal();
    expect(await keylight("url", "--port", port)).toEqual({
      code: 0,
      stdout: `http://localhost:${port}/\n`,
      stderr:
        `keylight: port ${port} already serves ${repo.outside}. Pass --port to use another port, or stop that viewer.\n` +
        "Next:  keylight stop\n",
    });
  });

  test("stop ends the viewer on the port, or says none is running", async () => {
    using repo = tempRepo();
    expect(await keylight("stop", "--port", String(await freePort()))).toEqual({
      code: 0,
      stdout: "No viewer is running.\n",
      stderr: "",
    });
    expect(await keylight("stop")).toEqual({ code: 0, stdout: `Stopped the viewer for ${repo.root}.\n`, stderr: "" });
    await repo.viewer.process.exited;
    expect(repo.viewer.process.signalCode).toBe("SIGTERM");
  });

  test("view starts a detached viewer over the root when none answers, and stop ends it", async () => {
    using repo = tempRepo();
    const port = String(await freePort());
    try {
      expect(await keylight("view", "--no-open", "--port", port)).toEqual({
        code: 0,
        stdout: `http://localhost:${port}/\n`,
        stderr: "",
      });
      const ping = await (await fetch(`http://127.0.0.1:${port}/__ping`)).json();
      expect(ping).toMatchObject({ app: "keylight-viewer", root: repo.root });
    } finally {
      rmSync(join(tmpdir(), `keylight-viewer-${port}.log`), { force: true });
      expect((await keylight("stop", "--port", port)).stdout).toBe(`Stopped the viewer for ${repo.root}.\n`);
    }
  });
});
