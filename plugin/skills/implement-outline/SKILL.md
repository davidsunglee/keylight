---
name: implement-outline
description: Implement a structure outline one phase at a time, with a sub-agent per phase, stopping only where the outline or a problem needs the human.
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
- Validation checkboxes: `- [ ]` → `- [x]` when a check passes. The implementer checks off the automated ones.
- Phase titles: `## Phase N: Title` → `## ✅ Phase N: Title`. You mark it, as the last act of the phase, so ✅ means done: implemented, committed, reviewed where the outline calls for it, and checked by the human where it lists manual checks.
- The Implementation Overview at the top lists every phase: `- [ ] Phase N: Title` → `- [x] Phase N: Title`, ticked when you mark that phase's title.

## Workflow

Work through the phases in order, straight from one into the next. The human is needed at three points only:

- a manual check the outline lists
- an issue the implementer or a review could not resolve
- an outward-facing action (pushing, publishing, changing repository or account settings) that the outline does not spell out. A phase that names the action and its destination authorizes exactly that; for anything beyond it, ask first.

For each phase:

### 1. Dispatch the implementer

Record where the phase starts: add `Starting commit: <hash>`, from `git rev-parse HEAD`, on its own line under the phase title in the outline. It is the fixed point of the phase's review, and it tells a resumed session the phase has begun. After a rebase, replace it with the rebased commit.

Decide now whether the phase gets a review, as step 3 describes.

Then dispatch an `outline-implementer` sub-agent for the phase. Give it the paths to the documents and say which phase to implement. For a phase that gets a review, add the last paragraph of the example: the implementer writes the review prompt, because it knows the intent behind the change. Its guide is [`../review-loop/REVIEW-PROMPT.md`](../review-loop/REVIEW-PROMPT.md).

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

This phase gets a review. Write the review prompt as your last step, following /absolute/path/to/review-loop/REVIEW-PROMPT.md. The phase's starting commit is [hash].
```

IMPORTANT — keep your prompt short. The implementer reads the documents itself. Do not duplicate the outline contents in your prompt.

### 2. Commit the phase

- Create a new commit for the changes
- Stage only the files the phase changed, and follow the repository's commit instructions: its `AGENTS.md` or `CLAUDE.md`, and the style of `git log --oneline -5`
- Task documents live outside the repository and git ignores `.artifacts/`, so they stay out of the commit
- For a phase that gets a review, put the new commit in the review prompt's front matter as `head`. The implementer wrote the prompt before the commit existed.

### 3. Review the phase when the outline calls for it

The outline decides which phases get a review: normally in the phase's `#### Review`, sometimes in its overview. Run the `kl:review-loop` skill on the committed phase when the outline calls for it, or the user asked for reviews. Where the outline is silent about a phase, the decision is yours, by the review rule in [`../create-structure-outline/SKILL.md`](../create-structure-outline/SKILL.md).

Give it the review prompt the implementer wrote, the boundary `phase-N`, the phase's starting commit as the fixed point, and the task folder's `store` path as its artifact directory. The review commits its own fixes and ends clean, or stops at one of its gates and puts the question to the human. The phase goes on once the review is clean.

### 4. Settle the phase's manual checks

Manual checks come last, so the human checks the phase as it will stand, review fixes included. Read the phase's `#### Manual Verification` list in the outline.

- **No list, or no unchecked item in it**: go to step 5.
- **Unchecked items**: report and wait.
  ```
  ## Phase [N]: manual checks

  **What was done:**
  - [Brief summary of changes]

  **Please check:**
  - [Each unchecked manual item from the outline]
  ```
  When the human confirms, check the items off. When they report a problem, note the current commit, dispatch the implementer again with what they found, and commit its fix. Where the review rule calls for a review of the fix, run it under its own boundary, `phase-N-fix`, with that commit as the fixed point, so it starts its own round count. Then return to this step.

A manual check that states its own condition ("inspect the screenshots that differ") needs the human only when the condition holds. When it does not hold, check the item off and add a few words saying why.

### 5. Mark the phase done and start the next

Mark the phase title ✅ and tick the phase in the Implementation Overview, then go on to the next phase without waiting.

## Special Instructions

### Resuming Work

Pick up at the first phase whose title has no ✅. That phase may be partly done, so work out how far it got and continue from that step:

- no starting commit under its title: it has not begun
- unchecked automated checkboxes: the implementer did not finish, so dispatch it again
- `git status --short` lists changes: it is implemented and not yet committed
- otherwise it is committed. Where it gets a review, the task folder's `review-loop/phase-N/` shows how far that went: no folder means the review has not started, and it is finished when the latest round's `findings.json` has the verdict `clean`. Running `kl:review-loop` on the same boundary continues an unfinished one.

### Handling Issues

If the implementer reports a mismatch or gets stuck:
- Present the issue clearly to the human
- Wait for guidance before proceeding
- Consider whether the outline needs to be updated based on codebase evolution

## After Final Phase Completion

When every phase title carries ✅, respond with exactly this, filling in the outline's link from `keylight url <path>`. Do not include a summary or other information.

```markdown
### Status

- Implementation complete
- Ticket: [ENG-XXXX](ticket URL if known, otherwise omit the link)

### Next Steps

To create a PR, start a new session and run the `kl:describe-pr` skill.

---

Structure outline: <link>
```
