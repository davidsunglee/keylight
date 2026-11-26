// Settings shared by the server and the CLI. Flags win over environment
// variables, which win over defaults.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  /** Real path of the artifact root. Nothing outside it is ever served. */
  root: string;
  port: number;
  /**
   * Base URL used in printed links, e.g. a Tailscale HTTPS address, so links
   * open from a phone. The server itself always listens on loopback.
   */
  publicUrl: string | null;
  configDir: string;
}

export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

export function loadConfig(argv: string[]): Config {
  const rootInput = flag(argv, "root") ?? process.env.FATHOM_ROOT ?? resolve(homedir(), "Artifacts");
  const rootPath = resolve(rootInput.replace(/^~(?=\/|$)/, homedir()));
  const port = Number(flag(argv, "port") ?? process.env.FATHOM_PORT ?? 4747);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  const publicUrl = (flag(argv, "public-url") ?? process.env.FATHOM_PUBLIC_URL ?? "").replace(/\/+$/, "") || null;
  const configHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config");
  const configDir = resolve(
    (flag(argv, "config") ?? process.env.FATHOM_CONFIG ?? resolve(configHome, "fathom")).replace(/^~(?=\/|$)/, homedir()),
  );
  return { root: existsSync(rootPath) ? realpathSync(rootPath) : rootPath, port, publicUrl, configDir };
}

export function localUrl(config: Config): string {
  return `http://localhost:${config.port}`;
}
