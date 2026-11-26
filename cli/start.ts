// Seeding a task: from a Linear ticket, or from a description in plain words.
//
// A ticket is fetched by code. A description gets one small model call to
// propose a title and a task name; pass --name to skip it.

import { TaskError } from "./task";

export interface Seed {
  /** Task name: the folder, the branch and the worktree are named after it. */
  task: string;
  title: string;
  body: string;
  ticket?: string;
  url?: string;
}

const TICKET = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const LINEAR_URL = /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/;

export function slugify(text: string, words = 6): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, words)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
}

export function ticketId(input: string): string | null {
  const text = input.trim();
  if (TICKET.test(text)) return text.toUpperCase();
  return LINEAR_URL.exec(text)?.[1]?.toUpperCase() ?? null;
}

interface LinearIssue {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] };
}

export function seedFromIssue(issue: LinearIssue, name?: string): Seed {
  const comments = issue.comments.nodes
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => `**${c.user?.name ?? "Someone"}, ${c.createdAt.slice(0, 10)}**\n\n${c.body.trim()}`);
  return {
    task: name ?? `${issue.identifier.toLowerCase()}-${slugify(issue.title)}`.replace(/-+$/, ""),
    title: `${issue.identifier}: ${issue.title}`,
    body: [issue.description?.trim() || "(The ticket has no description.)", ...(comments.length ? ["## Comments", ...comments] : [])].join("\n\n"),
    ticket: issue.identifier,
    url: issue.url,
  };
}

async function fetchLinear(id: string): Promise<LinearIssue> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    throw new TaskError(
      `${id} looks like a Linear ticket, and LINEAR_API_KEY is not set.\n` +
        `Create a personal API key in Linear (Settings > Security & access) and export it,\n` +
        `or describe the task in words instead:  fathom start "what to build"`,
    );
  }
  const query = `query($id: String!) { issue(id: $id) { identifier title description url
    comments(first: 50) { nodes { body createdAt user { name } } } } }`;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables: { id } }),
  });
  const payload = (await res.json()) as { data?: { issue: LinearIssue | null }; errors?: { message: string }[] };
  const issue = payload.data?.issue;
  if (!res.ok || !issue) throw new TaskError(`Linear did not return ${id}: ${payload.errors?.[0]?.message ?? res.statusText}`);
  return issue;
}

/** One small model call: a title and a task name for a description. Falls back to the first words. */
function proposeName(description: string): { title: string; task: string } {
  const firstLine = description.split("\n")[0]!.trim();
  const fallback = { title: firstLine.slice(0, 80), task: slugify(description) };
  const prompt =
    `Name this piece of software work. Reply with one line of JSON and nothing else: ` +
    `{"title": "<up to 8 words, sentence case>", "slug": "<2 to 5 lowercase words joined by dashes>"}\n\n${description}`;
  try {
    const result = Bun.spawnSync(["claude", "-p", prompt, "--model", "haiku"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 60_000 });
    const parsed = JSON.parse(/\{[^{}]*\}/.exec(result.stdout.toString())?.[0] ?? "") as { title?: string; slug?: string };
    const task = slugify(parsed.slug ?? "");
    return task && parsed.title ? { title: parsed.title, task } : fallback;
  } catch {
    return fallback;
  }
}

export async function seed(input: string, name: string | undefined): Promise<Seed> {
  const id = ticketId(input);
  if (id) return seedFromIssue(await fetchLinear(id), name);
  const description = input.trim();
  if (!description) throw new TaskError(`usage: fathom start <ticket | "description"> [--workflow NAME] [--profile NAME] [--name TASK]`);
  if (name) return { task: name, title: description.split("\n")[0]!.slice(0, 80), body: description };
  const proposed = proposeName(description);
  let task = proposed.task;
  if (process.stdin.isTTY) {
    const answer = prompt(`Task name [${task}]:`)?.trim();
    if (answer) task = answer;
  }
  return { task, title: proposed.title, body: description };
}

export function taskSummary(seed: Seed, repo: string): string {
  const created = new Date().toISOString().slice(0, 10);
  const front = [`task: ${seed.task}`, `repo: ${repo}`, `created: ${created}`];
  if (seed.ticket) front.push(`ticket: ${seed.ticket}`);
  if (seed.url) front.push(`url: ${seed.url}`);
  const link = seed.url ? `Ticket: [${seed.ticket}](${seed.url})\n\n` : "";
  return `---\n${front.join("\n")}\n---\n\n# ${seed.title}\n\n${link}${seed.body}\n`;
}
