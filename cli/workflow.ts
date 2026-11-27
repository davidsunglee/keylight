// Workflows, steps and profiles: what `keylight run` executes and how each
// session is launched. Built-in definitions live in workflows.yaml beside this
// file; <config>/workflows.yaml overrides them.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Step {
  skill?: string;
  run?: "worktree";
  session?: "headless" | "interactive";
  in?: "checkout" | "worktree";
  produces?: string;
  phases?: string;
  check?: string;
  prompt?: string;
  confirm?: boolean;
}

export interface Launch {
  harness: "claude" | "codex";
  model?: string;
  effort?: string;
  permissions?: string;
  args?: string[];
  /** Model and effort for the sub-agents the step's session dispatches. Claude Code only. */
  subagents?: { model?: string; effort?: string };
}

export interface Workflows {
  default: string;
  profile: string;
  workflows: Record<string, string[]>;
  steps: Record<string, Step>;
  profiles: Record<string, Record<string, Partial<Launch>>>;
}

export class ConfigError extends Error {}

/** The skills shipped with keylight, for prompts that point at one of their files. */
export const SKILLS_DIR = join(import.meta.dir, "..", "plugin", "skills");

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYaml(path: string): Dict {
  let data: unknown;
  try {
    data = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  if (data == null) return {};
  if (!isDict(data)) throw new ConfigError(`${path}: expected settings as "key: value" lines`);
  return data;
}

function section(data: Dict, key: string, path: string): Dict {
  const value = data[key];
  if (value == null) return {};
  if (!isDict(value)) throw new ConfigError(`${path}: "${key}" must hold named entries`);
  return value;
}

/** Merge named entries, and the fields inside an entry, so an override can change one field. */
function mergeEntries(base: Dict, over: Dict): Dict {
  const out: Dict = { ...base };
  for (const [name, value] of Object.entries(over)) {
    out[name] = isDict(value) && isDict(base[name]) ? { ...(base[name] as Dict), ...value } : value;
  }
  return out;
}

interface Settings {
  data: Dict;
  path: string;
}

/** The user's settings over the built-in ones, field by field. Shape errors name the file they are in. */
function mergeSettings(base: Settings, user: Settings): Workflows {
  const profiles = section(base.data, "profiles", base.path);
  for (const [name, entries] of Object.entries(section(user.data, "profiles", user.path))) {
    if (!isDict(entries)) throw new ConfigError(`${user.path}: profile "${name}" must map steps to settings`);
    profiles[name] = mergeEntries(isDict(profiles[name]) ? (profiles[name] as Dict) : {}, entries);
  }
  return {
    default: String(user.data.default ?? base.data.default),
    profile: String(user.data.profile ?? base.data.profile),
    workflows: { ...section(base.data, "workflows", base.path), ...section(user.data, "workflows", user.path) },
    steps: mergeEntries(section(base.data, "steps", base.path), section(user.data, "steps", user.path)),
    profiles,
  } as Workflows;
}

/** What is wrong with a step's settings, or null. */
function stepProblem(name: string, step: unknown): string | null {
  if (!isDict(step)) return `step "${name}" must hold settings`;
  if (!step.skill === !step.run) return `step "${name}" needs either "skill" or "run"`;
  if (step.run && step.run !== "worktree") return `step "${name}": the only code step is "run: worktree"`;
  if (step.skill && step.session !== "headless" && step.session !== "interactive") {
    return `step "${name}" needs "session: headless" or "session: interactive"`;
  }
  return null;
}

/** Throws a ConfigError naming `where` for the first workflow, then step, that is wrong, then checks the defaults. */
function assertWorkflowsValid(config: Workflows, where: string) {
  for (const [name, steps] of Object.entries(config.workflows)) {
    if (!Array.isArray(steps) || !steps.length)
      throw new ConfigError(`${where}: workflow "${name}" must list its steps`);
    const unknown = steps.find((step) => !config.steps[step]);
    if (unknown !== undefined) throw new ConfigError(`${where}: workflow "${name}" names an unknown step "${unknown}"`);
  }
  for (const [name, step] of Object.entries(config.steps)) {
    const problem = stepProblem(name, step);
    if (problem) throw new ConfigError(`${where}: ${problem}`);
  }
  workflowNamed(config, config.default);
  profileNamed(config, config.profile);
}

export function loadWorkflows(configDir: string): Workflows {
  const basePath = join(import.meta.dir, "workflows.yaml");
  const userPath = join(configDir, "workflows.yaml");
  const hasUser = existsSync(userPath);
  const config = mergeSettings(
    { data: readYaml(basePath), path: basePath },
    { data: hasUser ? readYaml(userPath) : {}, path: userPath },
  );
  assertWorkflowsValid(config, hasUser ? userPath : basePath);
  return config;
}

export function workflowNamed(config: Workflows, name: string): string[] {
  const steps = config.workflows[name];
  if (!steps) throw new ConfigError(`no workflow named "${name}". Known: ${Object.keys(config.workflows).join(", ")}`);
  return steps;
}

function profileNamed(config: Workflows, name: string): Record<string, Partial<Launch>> {
  const profile = config.profiles[name];
  if (!profile) throw new ConfigError(`no profile named "${name}". Known: ${Object.keys(config.profiles).join(", ")}`);
  return profile;
}

export function launchFor(config: Workflows, profileName: string, step: string): Launch {
  const profile = profileNamed(config, profileName);
  const general = profile["*"] ?? {};
  const own = profile[step] ?? {};
  const harness = own.harness ?? general.harness ?? "claude";
  if (harness !== "claude" && harness !== "codex") {
    throw new ConfigError(
      `profile "${profileName}", step "${step}": harness must be claude or codex, not "${harness}"`,
    );
  }
  // A harness's own defaults outrank "*": a model named for every step would be wrong for the other harness.
  return { ...general, ...profile[harness], ...own, harness };
}

/** Every document kind a step produces, longest first, to tell `research` from `research-questions`. */
export function documentKinds(config: Workflows): string[] {
  const kinds = new Set<string>();
  for (const step of Object.values(config.steps)) {
    if (step.produces) kinds.add(step.produces);
    if (step.phases) kinds.add(step.phases);
  }
  return [...kinds].sort((a, b) => b.length - a.length);
}
