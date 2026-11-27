---
name: implement-outline
description: Implement a structure outline one phase at a time, with a sub-agent per phase and a human check between phases.
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

**Progress tracking**: The implementer updates the outline document as work completes:
- Validation checkboxes: `- [ ]` → `- [x]` when automated verification passes
- Phase titles: `## Phase N: Title` → `## ✅ Phase N: Title` when all phase validation is confirmed

## Workflow

For each phase in the structure outline:

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

### 2. Report to Human

After the implementer completes, summarize the phase:
```
## Phase [N] Complete

**What was done:**
- [Brief summary of changes]

**Manual verification needed:**
- [List manual checks from the outline's Validation section]

Ready for Phase [N+1] when you confirm, or let me know if anything needs adjustment.
```

### 3. Wait for Human Confirmation

Ask for the human to:
- Confirm manual checks passed
- Report any issues found
- Give permission to continue to the next phase

### 4. Commit the Changes

- Create a new commit for the changes
- Stage only the files the phase changed, and follow the repository's commit instructions: its `AGENTS.md` or `CLAUDE.md`, and the style of `git log --oneline -5`
- Task documents live outside the repository and git ignores `.artifacts/`, so they stay out of the commit

### 5. Review, when the user wants it

When the user has asked for phases to be reviewed, run the `review-loop` skill on the committed phase before starting the next one. Its boundary is the phase (`phase-N`) and its fixed point is the starting commit you noted in step 1.

### 6. Repeat for Next Phase

When prompted, repeat this workflow for the next phase.

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

### Multiple Phases

If instructed to implement multiple phases consecutively:
- Still dispatch a separate implementer for each phase
- Perform verification between phases
- Report a summary after all requested phases complete
- Only pause for human verification after the final phase

### Waiting for Input

Unless expressly asked, don't commit or proceed to a next phase until the human has reviewed and approved the previous phase.

Workflow checklist:

- [ ] run `keylight task` and discover the documents
- [ ] read the structure outline to understand phases
- [ ] note the starting commit, then dispatch an `outline-implementer` sub-agent for Phase 1
- [ ] report a summary and ask the human to perform manual verification
- [ ] iterate with the human until the results are satisfactory
- [ ] commit the changes
- [ ] run `review-loop` on the phase if the user asked for review
- [ ] dispatch the implementer for the next phase

## After Final Phase Completion

When ALL phases are complete and verified:

1. Commit the final changes
2. Respond with exactly this, filling in the outline's link from `keylight url <path>`. Do not include a summary or other information.

```markdown
### Status

- Implementation complete
- Ticket: [ENG-XXXX](ticket URL if known, otherwise omit the link)

### Next Steps

To create a PR, start a new session and run the `kl:describe-pr` skill.

---

Structure outline: <link>
```
