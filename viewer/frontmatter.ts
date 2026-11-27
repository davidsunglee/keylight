/** A leading YAML mapping between `---` lines, split from the Markdown after it. */
export function splitFrontmatter(source: string): { data: Record<string, unknown> | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { data: null, body: source };
  try {
    const data = Bun.YAML.parse(match[1]!);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return { data: data as Record<string, unknown>, body: source.slice(match[0].length) };
    }
  } catch {
    // Not valid YAML: treat the block as ordinary content.
  }
  return { data: null, body: source };
}
