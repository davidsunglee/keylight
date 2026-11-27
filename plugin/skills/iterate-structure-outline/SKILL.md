---
name: iterate-structure-outline
description: Revise an existing structure outline from feedback.
disable-model-invocation: true
---

# Iterate Structure Outline

You are iterating on an existing structure outline document based on user feedback.

## Input

- Read [`../keylight/TASKS.md`](../keylight/TASKS.md), then run `keylight task` to find the task folder and the structure outline in it.
- Optionally, a ticket file path containing comments with feedback

## Initial Check

If the user calls this with no instructions or feedback, ask them for their feedback:

```
I'm ready to iterate on the structure outline. What feedback or changes would you like me to incorporate? For example:
- Phase reorganization
- Scope changes (add/remove items)
- Answers to open questions
- Additional context or requirements
```

Then wait for the user's feedback before proceeding.

## Steps

1. **Read all input documents FULLY**:
   - Read in full, never a partial range: the structure outline and all prior artifacts (`ticket.md` or `task.md`, research, PRD/TDD if present)
   - Understand the current state of the codebase from research findings
   - Review all design decisions and patterns to follow

2. **Check for related task content**:
   - Read all relevant files in the task directory, including the structure outline, research documents, and ticket
   - Read relevant files mentioned in the task files

3. **If the user gives any input**:
   - DO NOT just accept the correction blindly
   - Spawn research tasks to verify the information if needed
   - Read the specific files/directories they mention
   - Only proceed once you've verified the facts yourself

4. **Dispatch sub-agents for follow-up research** (if needed), as [`../keylight/SUBAGENTS.md`](../keylight/SUBAGENTS.md) describes:

   - **codebase-locator**: Find additional files if needed
   - **codebase-analyzer**: Deep-dive on specific implementations
   - **codebase-pattern-finder**: Find more examples of patterns
   - **web-search-researcher**: Research external best practices


5. **Process the feedback**:
   - If user requested phase changes: Reorganize phases as requested
   - If user requested scope changes: Update "What we're not doing" and phase contents
   - If user answered open questions: Remove from open questions and incorporate into plan
   - Keep the same YAML frontmatter and format

Each phase should ideally be a thin vertical slice that touches all / as many layers as possible for the desired end state. Avoid horizontal phases like 'add all types', 'add API endpoints', 'implement UI'.

Try to find ways to structure the outline so that each phase cuts across multiple layers, services, or module boundaries at least > 1 if at all possible. Each phase should be independently verifiable based on typechecks, tests, build steps, and any other in-repo verification. Ensure you understand codebase patterns for testing and verification, and don't suggest manual testing for a step that could be automated w/ a script, an existing skill, etc.

A horizontal breakdown looks like this:

1. Build the schema
2. Build the API
3. Build the UI
4. Add tests

That creates handoff problems and partially finished work.

A vertical slice cuts through the stack:

1. User can create the simplest version of the thing end-to-end
2. User can edit one field end-to-end
3. User can see the first validation error end-to-end

Each issue should include schema, API, UI, and tests if the slice needs them.

These are intended to be **illustrative**. Not all work lends itself to this type of structure specifically, but you should try to cross module boundaries where able to surface surprises early. Do not structure a phase N such that Phase N+1 must be completed before Phase N can be verified.

6. **Update document** (if changes needed):
   - Update the document at the same `docPath`
   - Reorganize phases as needed
   - Update file changes within phases
   - Update validation approaches
   - Remove answered questions from "Open Questions"

7. **Run the gate** when you changed the document: `keylight gate structure-outline review`. What it prints is a message from the user, delivered now instead of typed. Carry it out in full, exactly as if they had sent it, and fix what it turns up in the outline.

8. **Update the user**
   - Respond with your report on each point of the gate's message, then [`../create-structure-outline/final-answer.md`](../create-structure-outline/final-answer.md) exactly. Do not add a summary or other information.

## Document Precedence

When documents conflict, the most recent document wins:
**structure outline > TDD > PRD > research > ticket**

<guidance>
## Phase changes should be concise but clear

The goal of this document is to be concise and human readable.
Be tasteful and thoughtful about how and where you include code snippets, and prefer highlighting signature changes rather than entire code blocks, unless the user explicitly asks for them. The structure outline is our "c header files", the plan will include the function definitions.


## Phase Validation Design

Not every phase requires manual validation, don't put steps for manual validation just to have them.

There's a good chance that if a phase cannot be manually checked, its either too small
or not vertical enough. The goal of manual validation is to avoid getting to the end of a 1000+ line
code change and then having to figure out which part went wrong.

Automated testing is always better than manual testing - be thoughtful based on your knowledge
of the codebase and testing patterns, and be clear about which tests are manual versus automated.
</guidance>
