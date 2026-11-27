import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, documentKinds, launchFor, loadWorkflows, workflowNamed } from "../workflow";
import { tempDir } from "./support";

/** Loads the built-in settings under `yaml` as the user's file. */
function load(yaml?: string) {
  using config = tempDir();
  if (yaml !== undefined) writeFileSync(join(config.path, "workflows.yaml"), yaml);
  return loadWorkflows(config.path);
}

/** The ConfigError message loading `yaml` throws, with the temporary directory written as <config>. */
function problem(yaml: string): string {
  using config = tempDir();
  writeFileSync(join(config.path, "workflows.yaml"), yaml);
  try {
    loadWorkflows(config.path);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return err.message.replaceAll(config.path, "<config>");
  }
  throw new Error("loaded without a problem");
}

describe("loadWorkflows", () => {
  test("without a user file, the built-in workflows, steps and profile", () => {
    const workflows = load();
    expect(workflows.default).toBe("design");
    expect(workflows.profile).toBe("default");
    expect(workflows.workflows.design).toEqual([
      "research-questions",
      "research",
      "tdd",
      "structure-outline",
      "worktree",
      "implement-outline",
      "pr",
    ]);
    expect(Object.keys(workflows.workflows)).toEqual(["direct", "design", "product"]);
    expect(workflows.steps.tdd).toEqual({ skill: "kl:create-tdd", session: "interactive", produces: "tdd" });
    expect(workflows.profiles).toEqual({ default: { "*": { harness: "claude" } } });
    expect(load("")).toEqual(workflows);
    expect(load("# nothing but a comment\n")).toEqual(workflows);
  });

  test("the user's file adds and replaces workflows, one step field and one profile entry at a time", () => {
    const workflows = load(
      [
        "default: mine",
        "profile: fast",
        "workflows:",
        "  mine: [tdd, review]",
        "  direct: [grill]",
        "steps:",
        "  tdd: { session: headless }",
        "  extra: { skill: kl:extra, session: headless }",
        "profiles:",
        "  default:",
        '    "*": { model: opus }',
        "  fast:",
        '    "*": { harness: codex }',
        "",
      ].join("\n"),
    );
    expect(workflows.default).toBe("mine");
    expect(workflows.profile).toBe("fast");
    expect(workflows.workflows.mine).toEqual(["tdd", "review"]);
    expect(workflows.workflows.direct).toEqual(["grill"]);
    expect(workflows.workflows.design).toHaveLength(7);
    expect(workflows.steps.tdd).toEqual({ skill: "kl:create-tdd", session: "headless", produces: "tdd" });
    expect(workflows.steps.extra).toEqual({ skill: "kl:extra", session: "headless" });
    expect(workflows.profiles.default).toEqual({ "*": { harness: "claude", model: "opus" } });
    expect(workflows.profiles.fast).toEqual({ "*": { harness: "codex" } });
  });

  test("each malformed setting names the file and what is wrong", () => {
    expect(problem("[1, 2]\n")).toBe('<config>/workflows.yaml: expected settings as "key: value" lines');
    expect(problem("steps: [a]\n")).toBe('<config>/workflows.yaml: "steps" must hold named entries');
    expect(problem("profiles:\n  fast: [a]\n")).toBe(
      '<config>/workflows.yaml: profile "fast" must map steps to settings',
    );
    expect(problem("workflows:\n  mine: []\n")).toBe('<config>/workflows.yaml: workflow "mine" must list its steps');
    expect(problem("workflows:\n  mine: tdd\n")).toBe('<config>/workflows.yaml: workflow "mine" must list its steps');
    expect(problem("workflows:\n  mine: [tdd, nope]\n")).toBe(
      '<config>/workflows.yaml: workflow "mine" names an unknown step "nope"',
    );
    expect(problem("steps:\n  odd: 3\n")).toBe('<config>/workflows.yaml: step "odd" must hold settings');
    expect(problem("steps:\n  odd: { session: headless }\n")).toBe(
      '<config>/workflows.yaml: step "odd" needs either "skill" or "run"',
    );
    expect(problem("steps:\n  tdd: { run: worktree }\n")).toBe(
      '<config>/workflows.yaml: step "tdd" needs either "skill" or "run"',
    );
    expect(problem("steps:\n  odd: { run: deploy }\n")).toBe(
      '<config>/workflows.yaml: step "odd": the only code step is "run: worktree"',
    );
    expect(problem("steps:\n  odd: { skill: kl:odd }\n")).toBe(
      '<config>/workflows.yaml: step "odd" needs "session: headless" or "session: interactive"',
    );
    expect(problem("default: nope\n")).toBe('no workflow named "nope". Known: direct, design, product');
    expect(problem("profile: nope\n")).toBe('no profile named "nope". Known: default');
  });

  test("checks the workflows before the steps, and the steps before the defaults", () => {
    expect(problem("default: nope\nworkflows:\n  mine: [nope]\nsteps:\n  odd: 3\n")).toBe(
      '<config>/workflows.yaml: workflow "mine" names an unknown step "nope"',
    );
    expect(problem("default: nope\nsteps:\n  odd: 3\n")).toBe('<config>/workflows.yaml: step "odd" must hold settings');
  });

  test("a file that is not YAML is reported with the parser's reason", () => {
    expect(problem("workflows: [\n")).toStartWith("<config>/workflows.yaml: ");
  });
});

describe("workflowNamed and launchFor", () => {
  test("a workflow's steps, or the known names", () => {
    const workflows = load();
    expect(workflowNamed(workflows, "direct")).toEqual(["grill", "worktree", "implement-decisions", "review", "pr"]);
    expect(() => workflowNamed(workflows, "nope")).toThrow(
      new ConfigError('no workflow named "nope". Known: direct, design, product'),
    );
  });

  test("the step's own entry wins over the harness's, which wins over every step's", () => {
    const workflows = load(
      [
        "profiles:",
        "  mixed:",
        '    "*": { harness: codex, model: general, effort: low, permissions: read-only }',
        "    codex: { model: codex-model }",
        "    claude: { model: claude-model, effort: high }",
        "    tdd: { harness: claude, permissions: plan }",
        "    research: { effort: medium }",
        "",
      ].join("\n"),
    );
    expect(launchFor(workflows, "mixed", "tdd")).toEqual({
      harness: "claude",
      model: "claude-model",
      effort: "high",
      permissions: "plan",
    });
    expect(launchFor(workflows, "mixed", "research")).toEqual({
      harness: "codex",
      model: "codex-model",
      effort: "medium",
      permissions: "read-only",
    });
    expect(launchFor(workflows, "default", "pr")).toEqual({ harness: "claude" });
    expect(() => launchFor(workflows, "nope", "pr")).toThrow('no profile named "nope". Known: default, mixed');
  });

  test("a harness other than claude or codex is refused", () => {
    const workflows = load('profiles:\n  odd:\n    "*": { harness: gemini }\n');
    expect(() => launchFor(workflows, "odd", "tdd")).toThrow(
      new ConfigError('profile "odd", step "tdd": harness must be claude or codex, not "gemini"'),
    );
  });
});

describe("documentKinds", () => {
  test("every kind a step produces or tracks, longest first", () => {
    const kinds = documentKinds(load());
    expect(kinds.indexOf("research-questions")).toBeLessThan(kinds.indexOf("research"));
    expect([...kinds].sort()).toEqual(
      ["decisions", "pr-description", "prd", "research", "research-questions", "structure-outline", "tdd"].sort(),
    );
    expect(kinds.map((kind) => kind.length)).toEqual([...kinds.map((kind) => kind.length)].sort((a, b) => b - a));
  });
});
