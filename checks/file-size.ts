import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 256 * 1024;
const MAX_SOURCE_LINES = 1000;
const SOURCE_FILE = /\.(ts|js)$/;

const root = join(import.meta.dir, "..");

function git(args: string[], stdin?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

function nulFields(output: string): string[] {
  return output.split("\0").slice(0, -1);
}

function generatedPaths(paths: string[]): Set<string> {
  // Each record is three fields: path, attribute name, value.
  const fields = nulFields(git(["check-attr", "-z", "--stdin", "linguist-generated"], `${paths.join("\0")}\0`));
  const generated = new Set<string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const value = fields[i + 2];
    if (value === "set" || value === "true") generated.add(fields[i]!);
  }
  return generated;
}

function lineCount(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines++;
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const tracked = nulFields(git(["ls-files", "-z"]));
const generated = generatedPaths(tracked);
const problems: string[] = [];

for (const path of tracked) {
  if (generated.has(path)) continue;
  // A tracked path deleted from the working tree, a symlink, or a submodule has no file content to measure.
  const stats = lstatSync(join(root, path), { throwIfNoEntry: false });
  if (!stats?.isFile()) continue;
  if (stats.size > MAX_BYTES) {
    problems.push(`${path}: ${kilobytes(stats.size)}, above the ${kilobytes(MAX_BYTES)} limit`);
  }
  if (SOURCE_FILE.test(path)) {
    const lines = lineCount(readFileSync(join(root, path)));
    if (lines > MAX_SOURCE_LINES) problems.push(`${path}: ${lines} lines, above the ${MAX_SOURCE_LINES}-line limit`);
  }
}

for (const problem of problems) console.error(problem);
process.exitCode = problems.length ? 1 : 0;
