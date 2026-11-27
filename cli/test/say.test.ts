import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ask, nextLine } from "../say";
import { atTerminal } from "./support";

const SAY = join(import.meta.dir, "..", "say.ts");

/**
 * Asks in a separate process whose standard input holds `input`: the real
 * `ask` reads the terminal or standard input directly, which a test cannot
 * script inside its own process.
 */
async function askWith(input: string): Promise<string> {
  const script = `
    import { ask } from ${JSON.stringify(SAY)};
    const answer = ask("Is tdd finished?", [["Enter", "yes"], ["n", "not yet"]], "a step");
    console.log("\\n" + JSON.stringify(answer));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: new Blob([input]), stdout: "pipe" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return stdout;
}

const QUESTION = "Is tdd finished? [Enter] yes · [n] not yet · or type a step: \n";

describe("ask", () => {
  test("prints the question with its choices and returns the trimmed answer", async () => {
    expect(await askWith("  n  \nignored\n")).toBe(`${QUESTION}"n"\n`);
  });

  test("returns an empty answer for a bare Enter and null when the input has ended", async () => {
    expect(await askWith("\n")).toBe(`${QUESTION}""\n`);
    expect(await askWith("")).toBe(`${QUESTION}null\n`);
  });

  test("takes a last line that has no newline", async () => {
    expect(await askWith("pr")).toBe(`${QUESTION}"pr"\n`);
  });
});

describe("nextLine", () => {
  test("labels the command to run next", () => {
    expect(nextLine("keylight run")).toBe("Next:  keylight run");
  });
});

describe("the test run's terminal", () => {
  test("fails a question no test scripted", () => {
    expect(() => ask("Task name?", [["Enter", "demo"]])).toThrow("unexpected prompt: Task name?");
  });

  test("answers scripted questions in order and records them", () => {
    using terminal = atTerminal(["n", null]);
    expect(ask("Is tdd finished?", [])).toBe("n");
    expect(ask("Is pr finished?", [])).toBeNull();
    expect(terminal.questions).toEqual(["Is tdd finished?", "Is pr finished?"]);
  });
});
