// bun run check:commits [base]: every commit subject in <base>..HEAD has the
// form AGENTS.md asks for, `type(scope): subject`, with no scope or one of the
// repository's top-level parts. The base defaults to origin/main, so on a
// branch the range is the commits it adds to main.

import { join } from "node:path";
import { nextLine } from "../cli/say";

const TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
const SCOPES = ["cli", "viewer", "skills"];
const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\((${SCOPES.join("|")})\\))?: \\S`);

const root = join(import.meta.dir, "..");
const base = process.argv[2] ?? "origin/main";

const log = Bun.spawnSync(["git", "log", "--format=%h %s", `${base}..HEAD`, "--"], { cwd: root, stdin: "ignore" });
if (log.exitCode !== 0) {
  console.error(`git log ${base}..HEAD failed: ${log.stderr.toString().trim()}`);
  process.exit(1);
}

const commits = log.stdout.toString().split("\n").filter(Boolean);
const invalid = commits.filter((line) => !SUBJECT.test(line.slice(line.indexOf(" ") + 1)));

if (invalid.length === 0) {
  console.log(`${commits.length} commit subjects in ${base}..HEAD follow type(scope): subject`);
} else {
  for (const line of invalid) console.error(line);
  console.error(
    `\n${invalid.length} of ${commits.length} subjects in ${base}..HEAD are not type(scope): subject,` +
      ` with type one of ${TYPES.join(", ")} and scope one of ${SCOPES.join(", ")} or left out.`,
  );
  console.error(nextLine(`git rebase -i ${base}`));
}
process.exitCode = invalid.length ? 1 : 0;
