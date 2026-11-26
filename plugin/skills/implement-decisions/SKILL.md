---
name: implement-decisions
description: Implement a task straight from its decisions document, one committed phase at a time, with no design stage in between.
disable-model-invocation: true
---

# Implement from Decisions

You implement a task whose design was settled in conversation. The **decisions document** records what was agreed. You turn it into committed code in the task's worktree, one **phase** at a time, and the document's phase headings are the record of how far you got.

## 1. Read the task

- Read [`../fathom/TASKS.md`](../fathom/TASKS.md), then run `fathom task` to find the task folder.
- Read `task.md` and the decisions document (the highest-numbered `*-decisions-*.md`) fully.
- Read `CODING_STANDARDS.md` at the repository root when it exists, and the instruction files that cover the paths you will change.

**Precedence**: decisions document > ticket. The decisions are settled: build them as written.

Done when you can say, for each decision, where in the code it lands.

## 2. Settle the phases

The document's **Phases** section is both the plan and the progress record.

- When it already lists phases, use them as written.
- When it is empty, write it now, before changing any code. Split the work into phases that each leave the repository passing its checks, each with a **Check** line naming the command or behaviour that proves it. A small change is one phase.

Use the phase format in [`decisions-template.md`](decisions-template.md).

Done when every decision is covered by a phase.

## 3. Implement each phase

For each phase whose heading has no ✅, in order:

1. Implement the phase.
2. Run its check and the repository's own verification (tests, types, lint).
3. Commit the phase as one commit. Stage only the files the phase changed, and follow the repository's commit instructions: its `AGENTS.md` or `CLAUDE.md`, and the style of `git log --oneline -5`. Task documents live outside the repository and git ignores `.artifacts/`, so they stay out of the commit.
4. Mark the heading: `### Phase N: Title` → `### ✅ Phase N: Title`.

Done when every phase heading carries ✅ and `git status --short` is empty.

## When you cannot proceed

A decision contradicts the code or another decision, or a check still fails after you have found its cause and tried to fix it.

- Add a `## Blocked` section to the decisions document: what stopped you, the evidence, and the options with your recommendation.
- Leave the phase's heading unmarked and its unfinished changes uncommitted.
- Stop. The missing ✅ is what tells the workflow to wait for the user.

## Final answer

Respond with exactly this, filling in the document's link from `fathom url <path>`:

```markdown
### Status

- [Implementation complete: N phases committed | Blocked in Phase N: one line on why]

---

Decisions: <link>
```
