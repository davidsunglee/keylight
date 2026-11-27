import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { flag, loadConfig, localUrl } from "../config";
import { scopedEnv, tempDir } from "./support";

const UNSET = {
  KEYLIGHT_ROOT: undefined,
  KEYLIGHT_PORT: undefined,
  KEYLIGHT_PUBLIC_URL: undefined,
  KEYLIGHT_CONFIG: undefined,
  XDG_CONFIG_HOME: undefined,
};

describe.serial("loadConfig", () => {
  test("defaults to ~/Artifacts, port 4747, no public URL and ~/.config/keylight", () => {
    using _env = scopedEnv(UNSET);
    const artifacts = resolve(homedir(), "Artifacts");
    expect(loadConfig([])).toEqual({
      root: existsSync(artifacts) ? realpathSync(artifacts) : artifacts,
      port: 4747,
      publicUrl: null,
      configDir: resolve(homedir(), ".config/keylight"),
    });
  });

  test("environment variables override the defaults, and XDG_CONFIG_HOME moves the config directory", () => {
    using temp = tempDir();
    const dir = temp.path;
    using _env = scopedEnv({
      ...UNSET,
      KEYLIGHT_ROOT: join(dir, "root"),
      KEYLIGHT_PORT: "5001",
      KEYLIGHT_PUBLIC_URL: "https://box.example.ts.net/",
      XDG_CONFIG_HOME: join(dir, "xdg"),
    });
    expect(loadConfig([])).toEqual({
      root: join(dir, "root"),
      port: 5001,
      publicUrl: "https://box.example.ts.net",
      configDir: join(dir, "xdg/keylight"),
    });
    using _config = scopedEnv({ KEYLIGHT_CONFIG: join(dir, "kl") });
    expect(loadConfig([]).configDir).toBe(join(dir, "kl"));
  });

  test("flags override the environment, in both --name value and --name=value form", () => {
    using temp = tempDir();
    const dir = temp.path;
    using _env = scopedEnv({
      KEYLIGHT_ROOT: join(dir, "env-root"),
      KEYLIGHT_PORT: "5001",
      KEYLIGHT_PUBLIC_URL: "https://env.example",
      KEYLIGHT_CONFIG: join(dir, "env-config"),
    });
    const argv = ["view", "--root", join(dir, "flag-root"), "--port=5002", "--public-url=https://flag.example//"];
    expect(loadConfig([...argv, "--config", join(dir, "flag-config")])).toEqual({
      root: join(dir, "flag-root"),
      port: 5002,
      publicUrl: "https://flag.example",
      configDir: join(dir, "flag-config"),
    });
  });

  test("expands ~ and resolves an existing root to its real path", () => {
    using temp = tempDir();
    const dir = temp.path;
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    using _env = scopedEnv(UNSET);
    expect(loadConfig(["--root", join(dir, "link")]).root).toBe(join(dir, "real"));
    expect(loadConfig(["--root", "~/keylight-missing-root"]).root).toBe(join(homedir(), "keylight-missing-root"));
    expect(loadConfig(["--config", "~/kl"]).configDir).toBe(join(homedir(), "kl"));
    expect(loadConfig(["--root", "relative"]).root).toBe(resolve("relative"));
  });

  test("an empty public URL means none", () => {
    using _env = scopedEnv({ ...UNSET, KEYLIGHT_PUBLIC_URL: "" });
    expect(loadConfig([]).publicUrl).toBeNull();
    expect(loadConfig(["--public-url", "/"]).publicUrl).toBeNull();
  });

  test("refuses a port that is not an integer from 1 to 65535", () => {
    using _env = scopedEnv(UNSET);
    for (const port of ["0", "65536", "http", "80.5"]) {
      expect(() => loadConfig(["--port", port])).toThrow(`Invalid port: ${Number(port)}`);
    }
    expect(loadConfig(["--port", "1"]).port).toBe(1);
    expect(loadConfig(["--port", "65535"]).port).toBe(65535);
  });
});

describe("flag and localUrl", () => {
  test("flag reads a separate or inline value and is undefined when absent", () => {
    expect(flag(["--task", "demo"], "task")).toBe("demo");
    expect(flag(["--task=demo"], "task")).toBe("demo");
    expect(flag(["--task"], "task")).toBeUndefined();
    expect(flag(["--tasks=demo"], "task")).toBeUndefined();
    expect(flag([], "task")).toBeUndefined();
  });

  test("localUrl names localhost and the port", () => {
    expect(localUrl({ root: "/", port: 4800, publicUrl: "https://box.example", configDir: "/" })).toBe(
      "http://localhost:4800",
    );
  });
});
