// The two shapes the CLI uses when it hands a decision back to the user:
//
//   Is tdd finished? [Enter] yes, start structure-outline · [s] yes, stop here · [n] not yet:
//
//   tdd is left open.
//   Next:  fathom run

type Choice = [key: string, meaning: string];

/** Returns the trimmed answer, or null when the input has ended. `orType` names what free text means. */
export function ask(question: string, choices: Choice[], orType?: string): string | null {
  const listed = choices.map(([key, meaning]) => `[${key}] ${meaning}`);
  if (orType) listed.push(`or type ${orType}`);
  const answer = prompt(`${question} ${listed.join(" · ")}:`);
  return answer === null ? null : answer.trim();
}

export function nextLine(command: string): string {
  return `Next:  ${command}`;
}
