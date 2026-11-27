// Loaded before every test file (bunfig.toml). Pins the terminal a test sees,
// so a run at a developer's terminal behaves as a run on CI does: no stream is
// a terminal, standard input is empty, and a question no test scripted fails at
// once instead of waiting for an answer. Refuses to run where git would read
// the developer's own settings or act on another repository.

import { afterAll, mock } from "bun:test";
import { rmSync } from "node:fs";
import * as say from "../say";

/** Fixtures shared by several test files, removed once all of them have run. */
export const removeAfterRun: string[] = [];
afterAll(() => {
  for (const path of removeAfterRun) rmSync(path, { recursive: true, force: true });
});

// Bun starts every child process with the environment the run started with, so
// no test can set or clear these for the git commands production code runs.
// .env.test supplies the isolation, but a variable already in the environment
// outranks it.
const isolation = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const overridden = Object.entries(isolation)
  .filter(([name, value]) => process.env[name] !== value)
  .map(([name]) => name);
if (overridden.length) {
  throw new Error(
    `run the tests from the repository root with ${overridden.join(", ")} unset, so .env.test keeps git from reading your own settings`,
  );
}
const redirects = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"];
const configOverrides = ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"];
const set = [...redirects, ...configOverrides].filter((name) => process.env[name]);
if (set.length) {
  throw new Error(
    `unset ${set.join(", ")} before running the tests: git would act on another repository or with settings that override the tests' own`,
  );
}

export const terminal = {
  /** Answers the next questions receive, in order; null is input that has ended. */
  answers: [] as (string | null)[],
  /** Questions asked so far, answered or not. */
  questions: [] as string[],
};

for (const stream of [process.stdin, process.stdout, process.stderr]) Object.assign(stream, { isTTY: false });
Object.assign(Bun, { stdin: new Blob([""]) });

const actual = { ...say };
mock.module("../say", () => ({
  ...actual,
  ask(question: string): string | null {
    terminal.questions.push(question);
    const answer = terminal.answers.shift();
    if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
    return answer;
  },
}));
