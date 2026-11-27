// Seeding a task through `keylight start`: from a Linear ticket, with the
// global fetch answering for Linear, or from a description, with a fake
// `claude` answering the naming call.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atTerminal, fakeHarness, keylight, scopedEnv, type TempRepo, tempRepo } from "./support";

const today = () => new Date().toISOString().slice(0, 10);
const taskFile = (repo: TempRepo, task: string) => readFileSync(join(repo.store(task), "task.md"), "utf8");

interface Sent {
  url: string;
  init: RequestInit;
}

/** Answers every fetch with `reply` until disposed, and keeps what was sent. */
function linear(reply: () => Response): Disposable & { sent: Sent[] } {
  const saved = globalThis.fetch;
  const sent: Sent[] = [];
  const fake = async (url: string | URL | Request, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    return reply();
  };
  globalThis.fetch = Object.assign(fake, { preconnect: saved.preconnect });
  const env = scopedEnv({ LINEAR_API_KEY: "lin_api_test" });
  return {
    sent,
    [Symbol.dispose]: () => {
      globalThis.fetch = saved;
      env[Symbol.dispose]();
    },
  };
}

const ISSUE = {
  identifier: "ABC-123",
  title: "Fix the flaky upload test!",
  description: "  Uploads time out on CI.  ",
  url: "https://linear.app/acme/issue/ABC-123/fix-the-flaky-upload-test",
  comments: {
    nodes: [
      { body: "Second, by nobody.", createdAt: "2026-02-02T10:00:00Z", user: null },
      { body: " First. ", createdAt: "2026-01-01T09:00:00Z", user: { name: "Ada" } },
    ],
  },
};

describe.serial("keylight start from a Linear ticket", () => {
  test("names the task after the ticket and writes its description and comments, oldest first", async () => {
    using repo = tempRepo();
    using api = linear(() => Response.json({ data: { issue: ISSUE } }));

    expect(await keylight("start", "abc-123", "--no-run")).toEqual({
      code: 0,
      stdout: "Created task abc-123-fix-the-flaky-upload-test (design workflow).\n",
      stderr: "",
    });
    expect(taskFile(repo, "abc-123-fix-the-flaky-upload-test")).toBe(
      [
        "---",
        "task: abc-123-fix-the-flaky-upload-test",
        "repo: demo-repo",
        `created: ${today()}`,
        "ticket: ABC-123",
        `url: ${ISSUE.url}`,
        "---",
        "",
        "# ABC-123: Fix the flaky upload test!",
        "",
        `Ticket: [ABC-123](${ISSUE.url})`,
        "",
        "Uploads time out on CI.",
        "",
        "## Comments",
        "",
        "**Ada, 2026-01-01**",
        "",
        "First.",
        "",
        "**Someone, 2026-02-02**",
        "",
        "Second, by nobody.",
        "",
      ].join("\n"),
    );

    const [request] = api.sent;
    expect(request?.url).toBe("https://api.linear.app/graphql");
    expect(request?.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "lin_api_test" },
    });
    const body = JSON.parse(String(request?.init.body));
    expect(body.variables).toEqual({ id: "ABC-123" });
    expect(body.query).toContain("issue(id: $id) { identifier title description url");
  });

  test("takes a Linear link and --name, and says when the ticket has no description", async () => {
    using repo = tempRepo();
    using api = linear(() =>
      Response.json({
        data: { issue: { ...ISSUE, identifier: "ABC-42", description: null, comments: { nodes: [] } } },
      }),
    );

    const created = await keylight(
      "start",
      "https://linear.app/acme/issue/abc-42/some-title",
      "--name",
      "mine",
      "--no-run",
    );
    expect(created.stdout).toBe("Created task mine (design workflow).\n");
    expect(JSON.parse(String(api.sent[0]?.init.body)).variables).toEqual({ id: "ABC-42" });
    expect(taskFile(repo, "mine")).toEndWith(
      "\n# ABC-42: Fix the flaky upload test!\n\n" +
        `Ticket: [ABC-42](${ISSUE.url})\n\n(The ticket has no description.)\n`,
    );
  });

  test("a long title makes a task name of at most six words and 48 characters", async () => {
    using repo = tempRepo();
    using _api = linear(() =>
      Response.json({
        data: { issue: { ...ISSUE, title: "Internationalization, localization: configuration for every page" } },
      }),
    );
    expect((await keylight("start", "ABC-123", "--no-run")).stdout).toBe(
      "Created task abc-123-internationalization-localization-configuration (design workflow).\n",
    );
    expect(taskFile(repo, "abc-123-internationalization-localization-configuration")).toContain("\nticket: ABC-123\n");
  });

  test("a ticket Linear does not return is a task error with Linear's reason", async () => {
    using _repo = tempRepo();
    {
      using _api = linear(() => Response.json({ data: { issue: null }, errors: [{ message: "Entity not found" }] }));
      expect(await keylight("start", "ABC-9", "--no-run")).toEqual({
        code: 1,
        stdout: "",
        stderr: "keylight: Linear did not return ABC-9: Entity not found\n",
      });
    }
    using _api = linear(() => Response.json({}, { status: 401, statusText: "Unauthorized" }));
    expect((await keylight("start", "ABC-9", "--no-run")).stderr).toBe(
      "keylight: Linear did not return ABC-9: Unauthorized\n",
    );
  });
});

describe.serial("keylight start from a description", () => {
  test("asks Claude for a title and a task name", async () => {
    using repo = tempRepo();
    using harness = fakeHarness();
    harness.plan({
      naming: [{ stdout: 'Here you go: {"title": "Add a threshold flag", "slug": "Low Threshold Flag"}\n' }],
    });
    const description = "Let low take a threshold\n\nIt is fixed at five today.";

    expect((await keylight("start", description, "--no-run")).stdout).toBe(
      "Created task low-threshold-flag (design workflow).\n",
    );
    expect(taskFile(repo, "low-threshold-flag")).toEndWith(`\n# Add a threshold flag\n\n${description}\n`);
    const [launch] = harness.launches();
    expect(launch?.program).toBe("claude");
    expect(launch?.argv).toEqual([
      "-p",
      'Name this piece of software work. Reply with one line of JSON and nothing else: {"title": "<up to 8 words, sentence case>", ' +
        `"slug": "<2 to 5 lowercase words joined by dashes>"}\n\n${description}`,
      "--model",
      "haiku",
    ]);
  });

  test("falls back to the description's first words when the reply is unusable or the call fails", async () => {
    using repo = tempRepo();
    using harness = fakeHarness();
    harness.plan({
      naming: [{ stdout: "I cannot help with that.\n" }, { stdout: '{"slug": "no-title"}' }, { exit: 1 }],
    });

    const cases = [
      ["Make the upload retries configurable", "make-the-upload-retries-configurable"],
      ["Show a progress bar during uploads", "show-a-progress-bar-during-uploads"],
      ["Log every retry with its delay and the reason for it\n\nMore detail.", "log-every-retry-with-its-delay"],
    ] as const;
    for (const [description, task] of cases) {
      expect((await keylight("start", description, "--no-run")).stdout).toBe(
        `Created task ${task} (design workflow).\n`,
      );
      expect(taskFile(repo, task)).toEndWith(`\n# ${description.split("\n")[0]}\n\n${description}\n`);
    }
    expect(harness.launches()).toHaveLength(3);
  });

  test("falls back when there is no claude to ask", async () => {
    using repo = tempRepo();
    using _env = scopedEnv({ PATH: repo.outside });
    expect((await keylight("start", "Tidy the README", "--no-run")).stdout).toBe(
      "Created task tidy-the-readme (design workflow).\n",
    );
  });

  test("at a terminal, offers the proposed name and takes another", async () => {
    using repo = tempRepo();
    using harness = fakeHarness();
    harness.plan({
      naming: [
        { stdout: '{"title": "Tidy", "slug": "tidy-readme"}' },
        { stdout: '{"title": "Tidy", "slug": "tidy-readme"}' },
      ],
    });
    using terminal = atTerminal(["", "readme-pass"]);

    expect((await keylight("start", "Tidy the README", "--no-run")).stdout).toBe(
      "Created task tidy-readme (design workflow).\n",
    );
    expect((await keylight("start", "Tidy the README again", "--no-run")).stdout).toBe(
      "Created task readme-pass (design workflow).\n",
    );
    expect(terminal.questions).toEqual(["Task name?", "Task name?"]);
    expect(taskFile(repo, "readme-pass")).toContain("\n# Tidy\n");
  });
});
