// The two shapes the CLI uses when it hands a decision back to the user:
//
//   Is tdd finished? [Enter] yes, start structure-outline · [s] yes, stop here · [n] not yet:
//
//   tdd is left open.
//   Next:  keylight run

import { closeSync, openSync, readSync } from "node:fs";

type Choice = [key: string, meaning: string];

/**
 * One typed line without its newline, or null when the input has ended.
 * Bun's prompt() cannot tell the two apart: it returns null for a bare Enter.
 */
function readLine(): string | null {
  // Opened afresh, the terminal always blocks; a child that shared standard input may have left it non-blocking.
  const fd = process.stdin.isTTY ? openSync("/dev/tty", "r") : 0;
  try {
    const bytes = Buffer.alloc(1024);
    let text = "";
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, null);
      if (count === 0) return text || null;
      text += bytes.toString("utf8", 0, count);
      const end = text.indexOf("\n");
      if (end !== -1) return text.slice(0, end);
    }
  } finally {
    if (fd !== 0) closeSync(fd);
  }
}

/** Returns the trimmed answer ("" for a bare Enter), or null when the input has ended. `orType` names what free text means. */
export function ask(question: string, choices: Choice[], orType?: string): string | null {
  const listed = choices.map(([key, meaning]) => `[${key}] ${meaning}`);
  if (orType) listed.push(`or type ${orType}`);
  process.stdout.write(`${question} ${listed.join(" · ")}: `);
  return readLine()?.trim() ?? null;
}

export function nextLine(command: string): string {
  return `Next:  ${command}`;
}
