// The entry as an installed command runs it: a separate process, so these
// check what only a child process shows, such as argv forwarding, the exit
// status, and the environment and standard input it starts with.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "../../viewer/test/support";
import { ENTRY, spawnKeylight, tempRepo } from "./support";

async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let tries = 0; tries < 100; tries++) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const answers = async (port: number) =>
  fetch(`http://127.0.0.1:${port}/__ping`, { signal: AbortSignal.timeout(500) }).then(
    (res) => res.ok,
    () => false,
  );

describe.serial("the keylight executable", () => {
  test("exits 0 after help and 1 after a failure, with the message on stderr", async () => {
    using _repo = tempRepo();
    const help = await spawnKeylight(["help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toStartWith("keylight start");
    expect(await spawnKeylight(["nope"])).toEqual({
      code: 1,
      stdout: "",
      stderr: 'keylight: unknown command "nope".\nNext:  keylight help\n',
    });
  });

  test("forwards arguments to the command and its exit status back", async () => {
    using _repo = tempRepo({ tasks: ["demo"] });
    expect(await spawnKeylight(["task", "next", "tdd", "retry"])).toEqual({
      code: 0,
      stdout: ".artifacts/tasks/demo/01-tdd-retry.md\n",
      stderr: "",
    });
    expect((await spawnKeylight(["task", "next", "tdd"])).code).toBe(1);
  });

  test("an unexpected error exits 1", async () => {
    using _repo = tempRepo();
    const result = await spawnKeylight(["stop", "--port", "0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid port: 0");
  });

  test("runs through a symlink, as an installed bin does", async () => {
    using repo = tempRepo();
    const bin = join(repo.outside, "keylight");
    symlinkSync(ENTRY, bin);
    const child = Bun.spawnSync([process.execPath, bin, "help"], { stdout: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toStartWith("keylight start");
  });

  test("creates the default root under the home directory when it is missing", async () => {
    using repo = tempRepo();
    const env = { HOME: repo.outside, KEYLIGHT_ROOT: undefined };
    expect((await spawnKeylight(["url"], { env })).stdout).toBe(`http://localhost:${repo.viewer.port}/\n`);
    expect(existsSync(join(repo.outside, "Artifacts"))).toBe(true);
  });

  test("reads a scratch entry piped to it", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const result = await spawnKeylight(["scratch"], { stdin: "Piped entry\n" });
    expect(result.stdout).toBe(`http://localhost:${repo.viewer.port}/view/demo-repo/demo/scratch.md\n`);
    expect(readFileSync(join(repo.store("demo"), "scratch.md"), "utf8")).toEndWith("\n\nPiped entry\n");
  });

  test("view opens the local address in the browser", async () => {
    using repo = tempRepo({ tasks: ["demo"] });
    const bin = join(repo.outside, "bin");
    const opened = join(repo.outside, "opened");
    mkdirSync(bin);
    for (const opener of ["open", "xdg-open"]) {
      writeFileSync(join(bin, opener), `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
      chmodSync(join(bin, opener), 0o755);
    }
    const env = { PATH: `${bin}:${process.env.PATH}`, KEYLIGHT_PUBLIC_URL: "https://box.example.ts.net" };
    const result = await spawnKeylight(["view", ".artifacts/tasks/demo/task.md"], { env });
    expect(result).toEqual({ code: 0, stdout: "https://box.example.ts.net/view/demo-repo/demo/task.md\n", stderr: "" });
    await waitFor(async () => Bun.file(opened).exists(), "the browser to open");
    expect(readFileSync(opened, "utf8")).toBe(`http://localhost:${repo.viewer.port}/view/demo-repo/demo/task.md`);
  });

  test("serve runs the viewer in the foreground until SIGTERM, then exits 0", async () => {
    using repo = tempRepo();
    const port = await freePort();
    // The fixture's environment, not the one this run started with.
    const child = Bun.spawn(
      [process.execPath, ENTRY, "serve", "--root", repo.root, "--port", String(port), "--config", repo.configDir],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitFor(() => answers(port), "the viewer to answer");
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe(
        `keylight viewer: http://localhost:${port}  (root: ${repo.root})\n`,
      );
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("serve exits 1 when the root does not exist", async () => {
    using repo = tempRepo();
    const missing = join(repo.outside, "missing");
    const result = await spawnKeylight(["serve", "--root", missing, "--port", String(await freePort())]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: `Artifact root does not exist: ${missing}\n` });
  });
});
