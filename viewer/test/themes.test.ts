// Themes as the viewer loads them from a config directory, and the stylesheet
// generated from them.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadThemes, type ThemeSet, themeCss } from "../themes";

const base = realpathSync(mkdtempSync(join(tmpdir(), "keylight-themes-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let configs = 0;
/** A config directory holding `themes`, and `theme.conf` and `custom.css` when given. */
function configDir(files: { themes?: Record<string, string>; conf?: string; css?: string }): string {
  const dir = join(base, `config-${++configs}`);
  mkdirSync(join(dir, "themes"), { recursive: true });
  for (const [name, text] of Object.entries(files.themes ?? {})) writeFileSync(join(dir, "themes", name), text);
  if (files.conf !== undefined) writeFileSync(join(dir, "theme.conf"), files.conf);
  if (files.css !== undefined) writeFileSync(join(dir, "custom.css"), files.css);
  return dir;
}

const ghostty = (bg: string, fg: string, palette: string[]) =>
  [`background = ${bg}`, `foreground = ${fg}`, ...palette.map((color, i) => `palette = ${i}=${color}`)].join("\n");

// Bright yellow and cyan are the same hues as the normal ones and read better.
const NIGHT_OWL = ghostty("#011627", "#D6DEEB", [
  ...["#000000", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff"],
  ...["#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff"],
]);
// Solarized's bright slots are grays and other hues, so the normal colors stay.
const PAPER = `# a comment\n\n${ghostty("#fff", "333", [
  ...["#000", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee"],
  ...["#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
])}`;
// No bright colors, and every hue too dark to read on the background.
const DIM = ghostty("#1a1a1a", "#e0e0e0", ["#000", "#600000", "#006000", "#606000", "#000080", "#600060", "#006060"]);
// Text barely distinct from the background, so no color can reach the minimum contrast.
const FOG = ghostty("#777777", "#888888", ["#000", "#777", "#777", "#777", "#777", "#777", "#777"]);

// WCAG 2 contrast ratio, the measure the viewer promises for theme colors.
function contrast(a: string, b: string): number {
  const luminance = (color: string) => {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(color.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("loadThemes", () => {
  test("loads each valid theme file by name, labelled and classed as light or dark", () => {
    const set = loadThemes(configDir({ themes: { "night-owl": NIGHT_OWL, paper_light: PAPER, dim: DIM } }));
    expect(set).toEqual({
      themes: [
        {
          name: "dim",
          label: "Dim",
          kind: "dark",
          colors: {
            ...{ bg: "#1a1a1a", fg: "#e0e0e0", muted: "#999999", red: "#9d6c6c", green: "#488948" },
            ...{ yellow: "#7f7f36", blue: "#7d7db6", magenta: "#9d6c9d", cyan: "#367f7f" },
          },
        },
        {
          name: "night-owl",
          label: "Night Owl",
          kind: "dark",
          colors: {
            ...{ bg: "#011627", fg: "#d6deeb", muted: "#8996a4", red: "#ef5350", green: "#22da6e" },
            ...{ yellow: "#ffeb95", blue: "#82aaff", magenta: "#c792ea", cyan: "#7fdbca" },
          },
        },
        {
          name: "paper_light",
          label: "Paper Light",
          kind: "light",
          colors: {
            ...{ bg: "#ffffff", fg: "#333333", muted: "#767676", red: "#dc322f", green: "#788908" },
            ...{ yellow: "#a07b08", blue: "#2976ac", magenta: "#d33682", cyan: "#2b8f88" },
          },
        },
      ],
      auto: {},
      customCss: "",
    });
  });

  test("keeps links and secondary text at 4.5:1 against the background, and syntax colors at 3.6:1", () => {
    const { themes } = loadThemes(configDir({ themes: { "night-owl": NIGHT_OWL, paper: PAPER, dim: DIM } }));
    for (const { colors } of themes) {
      expect(contrast(colors.muted, colors.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.blue, colors.bg)).toBeGreaterThanOrEqual(4.5);
      for (const hue of [colors.red, colors.green, colors.yellow, colors.magenta, colors.cyan]) {
        expect(contrast(hue, colors.bg)).toBeGreaterThanOrEqual(3.6);
      }
    }
  });

  test("moves a color most of the way to the text color when nothing reaches the minimum", () => {
    const [fog] = loadThemes(configDir({ themes: { fog: FOG } })).themes;
    expect(fog?.colors).toMatchObject({ muted: "#878787", red: "#858585", blue: "#858585" });
  });

  test("skips files that are not themes, hidden or oddly named, and entries that cannot be read", () => {
    const dir = configDir({
      themes: {
        ok: DIM,
        "missing-hue": "background = #000\nforeground = #fff\npalette = 1=#f00\n",
        "no-background": "foreground = #fff\n",
        "bad-color": DIM.replace("#1a1a1a", "#12345"),
        ".hidden": DIM,
        "has space": DIM,
      },
    });
    mkdirSync(join(dir, "themes", "a-directory"));
    symlinkSync(join(dir, "nowhere"), join(dir, "themes", "dangling"));
    expect(loadThemes(dir).themes.map((t) => t.name)).toEqual(["ok"]);
  });

  test("reads the followed pair from theme.conf, dropping names it has no theme for, and custom.css", () => {
    const set = loadThemes(
      configDir({
        themes: { paper: PAPER },
        conf: "# pair\nlight = paper\ndark = missing\nnot a setting\n",
        css: "body { color: red; }\n",
      }),
    );
    expect(set.auto).toEqual({ light: "paper", dark: undefined });
    expect(set.customCss).toBe("body { color: red; }\n");
  });

  test("returns an empty set for a config directory that does not exist", () => {
    expect(loadThemes(join(base, "absent"))).toEqual({ themes: [], auto: {}, customCss: "" });
  });
});

describe("themeCss", () => {
  const set = (): ThemeSet =>
    loadThemes(
      configDir({
        themes: { paper: PAPER, dim: DIM },
        conf: "light = paper\ndark = dim\n",
        css: "body { color: red; }",
      }),
    );
  const paperVars =
    "--t-bg: #ffffff; --t-fg: #333333; --t-muted: #767676; --t-red: #dc322f; --t-green: #788908; " +
    "--t-yellow: #a07b08; --t-blue: #2976ac; --t-magenta: #d33682; --t-cyan: #2b8f88; " +
    "--theme-kind: light; color-scheme: light;";
  const dimVars =
    "--t-bg: #1a1a1a; --t-fg: #e0e0e0; --t-muted: #999999; --t-red: #9d6c6c; --t-green: #488948; " +
    "--t-yellow: #7f7f36; --t-blue: #7d7db6; --t-magenta: #9d6c9d; --t-cyan: #367f7f; " +
    "--theme-kind: dark; color-scheme: dark;";

  test("sets the followed pair by device appearance, then one block per theme, then the custom CSS", () => {
    expect(themeCss(set())).toBe(
      [
        `:root { ${paperVars} }`,
        `@media (prefers-color-scheme: dark) { :root { ${dimVars} } }`,
        `:root[data-theme="dim"] { ${dimVars} }`,
        `:root[data-theme="paper"] { ${paperVars} }`,
        "body { color: red; }",
        "",
      ].join("\n"),
    );
  });

  test("leaves out a side of the pair that is not set", () => {
    const css = themeCss({ ...set(), auto: { dark: "dim" }, customCss: "" });
    expect(css).toStartWith(`@media (prefers-color-scheme: dark) { :root { ${dimVars} } }\n`);
    expect(css).not.toMatch(/^:root \{/m);
  });

  test("is empty without themes", () => {
    expect(themeCss({ themes: [], auto: {}, customCss: "" })).toBe("\n");
  });
});
