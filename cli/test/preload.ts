// Loaded before every test file (bunfig.toml). Pins the terminal a test sees,
// so a run at a developer's terminal behaves as a run on CI does: no stream is
// a terminal, standard input is empty, and a question no test scripted fails at
// once instead of waiting for an answer. Refuses to run where git is pointed at
// another repository.

import { afterAll, mock } from "bun:test";
import { rmSync } from "node:fs";
import * as say from "../say";

/** Fixtures shared by several test files, removed once all of them have run. */
export const removeAfterRun: string[] = [];
afterAll(() => {
  for (const path of removeAfterRun) rmSync(path, { recursive: true, force: true });
});

// Bun starts every child process with the environment the run started with, so
// no test can clear these for the git commands production code runs.
const redirects = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"];
const set = redirects.filter((name) => process.env[name]);
if (set.length) {
  throw new Error(
    `unset ${set.join(", ")} before running the tests: git would act on that repository, not the tests' own`,
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
