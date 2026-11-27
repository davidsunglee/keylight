// Themes for the viewer.
//
// A theme is a Ghostty theme file: `background`, `foreground`, and the 16
// `palette = N=#rrggbb` terminal colors. Only ten of those are used here; the
// stylesheet derives every other color from them.
//
//   <config>/themes/<name>     one theme per file (symlinks are fine)
//   <config>/theme.conf        `light = <name>` and `dark = <name>`: the pair
//                              used when the viewer follows the device
//   <config>/custom.css        optional overrides, loaded last

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Theme {
  name: string;
  label: string;
  kind: "light" | "dark";
  /** Base palette: bg, fg, secondary text, and the six terminal hues. */
  colors: Record<(typeof BASE_KEYS)[number], string>;
}

export interface ThemeSet {
  themes: Theme[];
  /** Theme names used when no theme is picked, by device appearance. */
  auto: { light?: string; dark?: string };
  customCss: string;
}

const BASE_KEYS = ["bg", "fg", "muted", "red", "green", "yellow", "blue", "magenta", "cyan"] as const;

// Minimum contrast against the background. Links and secondary text meet the
// WCAG level for body text; syntax colors get a little more room to keep
// their character.
const CONTRAST = { accent: 4.5, muted: 4.5, syntax: 3.6 };
const HUE_INDEX = { red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6 } as const;
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

function hex(value: string): string | null {
  const match = HEX.exec(value.trim());
  if (!match) return null;
  const digits = match[1]!;
  return `#${(digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits).toLowerCase()}`;
}

type Rgb = [number, number, number];

function rgb(color: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as Rgb;
}

/** Relative luminance (WCAG). */
function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: string, b: string, amount: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x
    .map((v, i) =>
      Math.round(v + (y[i]! - v) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Hue in degrees and saturation, to tell a brighter shade from a different color. */
function hueSat(color: string): { hue: number; sat: number } {
  const [r, g, b] = rgb(color).map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: (hue * 60 + 360) % 360, sat: d / (1 - Math.abs(max + min - 1) || 1) };
}

/**
 * Terminals carry each hue twice. Use the "bright" one when it reads better
 * on the background, but only if it is really the same hue: Solarized, for
 * one, fills its bright slots with grays.
 */
function pickHue(normal: string, bright: string | undefined, bg: string): string {
  if (!bright || contrast(bright, bg) <= contrast(normal, bg)) return normal;
  const [a, b] = [hueSat(normal), hueSat(bright)];
  const apart = Math.min(Math.abs(a.hue - b.hue), 360 - Math.abs(a.hue - b.hue));
  return apart <= 40 && b.sat >= a.sat * 0.5 ? bright : normal;
}

/** Move a color toward the text color, as little as needed, until it reads on the background. */
function readable(color: string, bg: string, fg: string, minimum: number): string {
  for (let amount = 0; amount <= 0.8; amount += 0.08) {
    const candidate = mix(color, fg, amount);
    if (contrast(candidate, bg) >= minimum) return candidate;
  }
  return mix(color, fg, 0.8);
}

function parseSettings(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    out.set(key, [...(out.get(key) ?? []), line.slice(eq + 1).trim()]);
  }
  return out;
}

export function parseTheme(name: string, text: string): Theme | null {
  const settings = parseSettings(text);
  const palette = new Map<number, string>();
  for (const entry of settings.get("palette") ?? []) {
    const [index, value] = entry.split("=");
    const color = hex(value ?? "");
    if (color) palette.set(Number(index), color);
  }
  const bg = hex(settings.get("background")?.[0] ?? "");
  const fg = hex(settings.get("foreground")?.[0] ?? "");
  if (!bg || !fg) return null;
  const colors = { bg, fg, muted: readable(mix(fg, bg, 0.36), bg, fg, CONTRAST.muted) } as Theme["colors"];
  for (const [hue, index] of Object.entries(HUE_INDEX) as [keyof typeof HUE_INDEX, number][]) {
    const normal = palette.get(index);
    if (!normal) return null;
    const picked = pickHue(normal, palette.get(index + 8), bg);
    colors[hue] = readable(picked, bg, fg, hue === "blue" ? CONTRAST.accent : CONTRAST.syntax);
  }
  return {
    name,
    label: name
      .split(/[-_]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" "),
    kind: luminance(bg) > 0.4 ? "light" : "dark",
    colors,
  };
}

export function loadThemes(configDir: string): ThemeSet {
  const set: ThemeSet = { themes: [], auto: {}, customCss: "" };
  const themesDir = join(configDir, "themes");
  if (existsSync(themesDir)) {
    for (const name of readdirSync(themesDir).sort()) {
      if (name.startsWith(".") || !/^[\w.-]+$/.test(name)) continue;
      try {
        const theme = parseTheme(name, readFileSync(join(themesDir, name), "utf8"));
        if (theme) set.themes.push(theme);
      } catch {
        // Unreadable entry (a dangling symlink, a directory): skip it.
      }
    }
  }
  const conf = join(configDir, "theme.conf");
  if (existsSync(conf)) {
    const settings = parseSettings(readFileSync(conf, "utf8"));
    const known = (name?: string) => (set.themes.some((t) => t.name === name) ? name : undefined);
    set.auto = { light: known(settings.get("light")?.[0]), dark: known(settings.get("dark")?.[0]) };
  }
  const custom = join(configDir, "custom.css");
  if (existsSync(custom)) set.customCss = readFileSync(custom, "utf8");
  return set;
}

function declarations(theme: Theme): string {
  const vars = BASE_KEYS.map((key) => `--t-${key}: ${theme.colors[key]};`).join(" ");
  return `${vars} --theme-kind: ${theme.kind}; color-scheme: ${theme.kind};`;
}

/**
 * Stylesheet that sets the base palette: the followed pair by device
 * appearance, then one block per theme for an explicit pick.
 */
export function themeCss(set: ThemeSet): string {
  const byName = new Map(set.themes.map((t) => [t.name, t]));
  const light = byName.get(set.auto.light ?? "");
  const dark = byName.get(set.auto.dark ?? "");
  const out: string[] = [];
  if (light) out.push(`:root { ${declarations(light)} }`);
  if (dark) out.push(`@media (prefers-color-scheme: dark) { :root { ${declarations(dark)} } }`);
  for (const theme of set.themes) out.push(`:root[data-theme="${theme.name}"] { ${declarations(theme)} }`);
  if (set.customCss) out.push(set.customCss);
  return `${out.join("\n")}\n`;
}
