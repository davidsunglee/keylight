---
name: implement-outline
description: Implement a structure outline one phase at a time, with a sub-agent per phase, pausing only for the manual checks the outline lists.
disable-model-invocation: true
---

# Phased Implementation from Structure Outline

You are the orchestrator for implementing a structure outline. You work through each phase systematically, dispatching one `outline-implementer` sub-agent per phase and reading the outline and its companion documents.

**CRITICAL**: This skill IS the implementation orchestrator. You dispatch the `outline-implementer` sub-agent yourself, as [`../keylight/SUBAGENTS.md`](../keylight/SUBAGENTS.md) describes.

## Getting Started

When invoked:
1. Read [`../keylight/TASKS.md`](../keylight/TASKS.md), then run `keylight task` to find the task folder and list its documents:
   - note the structure outline: the highest-numbered `*-structure-outline-*.md`
   - note the companion documents: research (`*-research-*.md`), TDD (`*-tdd-*.md`), PRD (`*-prd-*.md`)
2. Read the structure outline fully to understand the phases
3. Begin with Phase 1 (or the first unimplemented phase if resuming)
4. Follow the workflow below

**Document precedence**: structure outline > TDD > PRD > research > ticket. When documents conflict, the outline takes precedence.

**Progress tracking**: the outline records progress as work completes:
- Validation checkboxes: `- [ ]` → `- [x]` when a check passes
- Phase titles: `## Phase N: Title` → `## ✅ Phase N: Title` when the phase is verified. The implementer marks a phase that has no manual checks; you mark a phase that has them, once the human has confirmed.

## Workflow

Work through the phases in order, straight from one into the next. The human is needed at two points only: a manual check the outline lists, and an issue the implementer could not resolve.

For each phase:

### 1. Dispatch the implementer

Note the current commit (`git rev-parse HEAD`) as the phase's starting point, then dispatch an `outline-implementer` sub-agent for the phase. Give it the paths to the documents and say which phase to implement.

Example prompt:
```
Read /absolute/path/to/keylight/agents/outline-implementer.md and follow it.

Implement Phase [N] from the structure outline at .artifacts/tasks/<task>/NN-structure-outline-<description>.md

Companion documents (read these for context):
- Research: .artifacts/tasks/<task>/NN-research-<description>.md
- TDD: .artifacts/tasks/<task>/NN-tdd-<description>.md

The outline describes intent and signatures — use your judgment to write the actual implementation.
Structure outline takes precedence over the other documents if they conflict.
Focus only on Phase [N]. Stop after completing automated verification.
Update progress markers in the outline as you complete validation steps.
```

IMPORTANT — keep your prompt short. The implementer reads the documents itself. Do not duplicate the outline contents in your prompt.

### 2. Settle the phase's manual checks

Read the phase's `#### Manual Verification` list in the outline.

- **No list, or no unchecked item in it**: the phase is verified. Go to step 3.
- **Unchecked items**: report and wait.
  ```
  ## Phase [N]: manual checks

  **What was done:**
  - [Brief summary of changes]

  **Please check:**
  - [Each unchecked manual item from the outline]
  ```
  When the human confirms, check the items off and mark the phase title ✅. When they report a problem, dispatch the implementer again with what they found, then return to this step.

A manual check that states its own condition ("inspect the screenshots that differ") needs the human only when the condition holds. When it does not hold, check the item off and add a few words saying why.

### 3. Commit the phase

- Create a new commit for the changes
- Stage only the files the phase changed, and follow the repository's commit instructions: its `AGENTS.md` or `CLAUDE.md`, and the style of `git log --oneline -5`
- Task documents live outside the repository and git ignores `.artifacts/`, so they stay out of the commit

### 4. Review the phase when the outline calls for it

The outline decides which phases get a review: normally in the phase's `#### Review`, sometimes in its overview. Run the `review-loop` skill on the committed phase when the outline calls for it, or the user asked for reviews. Where the outline is silent about a phase, the decision is yours, by the review rule in [`../create-structure-outline/SKILL.md`](../create-structure-outline/SKILL.md).

The review's boundary is the phase (`phase-N`) and its fixed point is the starting commit you noted in step 1. Commit whatever the review changed.

### 5. Start the next phase

Go on to the next phase without waiting.

## Special Instructions

### Resuming Work

If resuming work on a partially completed outline:
- Read the outline to understand which phases exist
- Look for ✅ markers in phase titles to identify completed phases
- Look for `- [x]` checkboxes to see granular progress within phases
- Trust that completed work is done unless something seems off
- Pick up from the first phase without a ✅ marker

### Handling Issues

If the implementer reports a mismatch or gets stuck:
- Present the issue clearly to the human
- Wait for guidance before proceeding
- Consider whether the outline needs to be updated based on codebase evolution

## After Final Phase Completion

When every phase title carries ✅ and every phase is committed, respond with exactly this, filling in the outline's link from `keylight url <path>`. Do not include a summary or other information.

```markdown
### Status

- Implementation complete
- Ticket: [ENG-XXXX](ticket URL if known, otherwise omit the link)

### Next Steps

To create a PR, start a new session and run the `kl:describe-pr` skill.

---

Structure outline: <link>
```
