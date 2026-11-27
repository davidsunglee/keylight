import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

const root = join(import.meta.dir, "..");
const pluginDir = join(root, "plugin");
const realPluginDir = realpathSync(pluginDir);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function linkTargets(markdown: string): string[] {
  const md = new MarkdownIt({ html: true });
  md.normalizeLink = (url) => url;
  const targets: string[] = [];
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      const target = token.attrGet("href") ?? token.attrGet("src");
      if (target !== null) targets.push(target);
      if (token.children) visit(token.children);
    }
  };
  visit(md.parse(markdown, {}));
  return targets;
}

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;
const TEMPLATE_PLACEHOLDER = /^\{[A-Za-z_]+\}$/;

function linkPath(target: string): string {
  const path = target.replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path; // A % that starts no escape is part of the file name.
  }
}

function linkProblem(file: string, target: string): string | undefined {
  if (EXTERNAL.test(target) || TEMPLATE_PLACEHOLDER.test(target)) return undefined;
  const path = resolve(dirname(file), linkPath(target));
  // Codex installs a copy of plugin/, so a link that leaves it, as written or
  // through a symlink, breaks once installed.
  if (!path.startsWith(pluginDir + sep)) return "leaves plugin/";
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return "does not exist";
  }
  if (!real.startsWith(realPluginDir + sep)) return "leaves plugin/";
  return undefined;
}

describe("skill links", () => {
  test("every relative link in a skill resolves to a file inside the plugin", () => {
    const files = [...new Bun.Glob("plugin/skills/**/*.md").scanSync({ cwd: root })].sort();
    expect(files.length).toBeGreaterThan(0);
    const broken: string[] = [];
    for (const file of files) {
      const absolute = join(root, file);
      for (const target of linkTargets(readFileSync(absolute, "utf8"))) {
        const problem = linkProblem(absolute, target);
        if (problem) broken.push(`${file}: (${target}) ${problem}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("plugin manifests", () => {
  const pkg = readJson("package.json");
  const claude = readJson("plugin/.claude-plugin/plugin.json");
  const codex = readJson("plugin/.codex-plugin/plugin.json");
  const marketplace = readJson(".agents/plugins/marketplace.json");

  test("both plugin manifests carry the package version", () => {
    expect(claude.version).toBe(pkg.version);
    expect(codex.version).toBe(pkg.version);
  });

  test("both plugin manifests name the same plugin", () => {
    expect(codex.name).toBe(claude.name);
  });

  test("the marketplace lists the plugin by its name and directory", () => {
    const plugins = marketplace.plugins as { name: string; source: { path: string } }[];
    const entry = plugins.find((plugin) => plugin.name === claude.name);
    expect(entry).toBeDefined();
    expect(relative(root, resolve(root, entry!.source.path))).toBe("plugin");
  });
});
