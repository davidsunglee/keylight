// Loads every CLI and viewer module that coverage counts. Bun leaves a module no
// test loads out of the report instead of failing it, so a module without tests
// would pass the floor unseen; loaded here, it is listed and held to the floor.

import { expect, test } from "bun:test";
import { join } from "node:path";
import bunfig from "../bunfig.toml";

const root = join(import.meta.dir, "..");
const ignored = (bunfig.test.coveragePathIgnorePatterns as string[]).map((pattern) => new Bun.Glob(pattern));
const counted = [...new Bun.Glob("{cli,viewer}/*.ts").scanSync(root)]
  .filter((file) => !ignored.some((glob) => glob.match(file)))
  .sort();

test("finds the production modules", () => {
  expect(counted).toContain("cli/commands.ts");
  expect(counted).toContain("viewer/server.ts");
  expect(counted).not.toContain("cli/keylight.ts");
});

test.each(counted)("loads %s", async (file) => {
  expect(await import(join(root, file))).toBeDefined();
});
