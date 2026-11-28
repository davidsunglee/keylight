// What the `keylight run` test files share: reading and writing a task's recorded state, and reading a run's output.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Launch } from "./fakes/harness";
import type { TempRepo } from "./support";

export interface StepState {
  status: string;
  at: string;
  harness?: string;
  session?: string;
}
export interface State {
  workflow: string;
  profile: string;
  checkout: string;
  worktree?: string;
  base?: string;
  steps: Record<string, StepState>;
  notes?: Record<string, string>;
}

export const plain = (text: string) => Bun.stripANSI(text);
export const banners = (stdout: string) =>
  plain(stdout)
    .split("\n")
    .filter((line) => line.startsWith("▸ "));
export const stepOf = (launch: Launch) => launch.env.KEYLIGHT_STEP;
export const valueAfter = (launch: Launch, flag: string) => launch.argv[launch.argv.indexOf(flag) + 1] ?? "";
export const readState = (repo: TempRepo, task = "demo") =>
  JSON.parse(readFileSync(join(repo.store(task), ".keylight.json"), "utf8")) as State;

export function writeState(repo: TempRepo, steps: Record<string, Partial<StepState>>, more: Partial<State> = {}) {
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

export const documents = (repo: TempRepo) => `Documents: http://localhost:${repo.viewer.port}/view/demo-repo/demo\n`;
export const done = (...names: string[]) => Object.fromEntries(names.map((name) => [name, {}]));

export function writeWorkflows(repo: TempRepo, yaml: string) {
  writeFileSync(join(repo.configDir, "workflows.yaml"), yaml);
}

export function logs(repo: TempRepo): string[] {
  const dir = join(repo.home, ".keylight/logs", repo.name, "demo");
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
}
