// The scopes are the top-level parts AGENTS.md names under Commits; keep the two lists the same.
// The base defaults to origin/main, so on a branch the range is the commits it adds to main.

import { join } from "node:path";
import { nextLine } from "../cli/say";

const TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
const SCOPES = ["cli", "viewer", "skills"];
const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\((${SCOPES.join("|")})\\))?: \\S`);

const root = join(import.meta.dir, "..");
const base = process.argv[2] ?? "origin/main";

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdin: "ignore" });
  if (result.exitCode !== 0) {
    console.error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
    process.exit(1);
  }
  return result.stdout.toString();
}

// Resolved first: an empty base would make the range HEAD..HEAD, and an option-shaped one a log filter, both passing on zero commits.
const baseSha = git(["rev-parse", "--verify", "--end-of-options", base]).trim();
const log = git(["log", "--no-show-signature", "--format=%h %s", `${baseSha}..HEAD`, "--"]);

const commits = log.split("\n").filter(Boolean);
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
