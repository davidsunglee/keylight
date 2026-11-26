---
name: fathom
description: The fathom workflow at a glance, and which skill to run at each stage.
disable-model-invocation: true
---

Fathom takes a piece of work from question to pull request through a series of documents, each one written in its own session and read by the next. Every skill reads and writes the task folder described in [`TASKS.md`](TASKS.md).

Three workflows string the stages together, and `fathom run` takes a task through one of them, a fresh session per stage:

- **design** (the default): research questions → research → technical design → structure outline → worktree → implementation → pull request
- **product**: the same, with product requirements before the technical design
- **direct**: grilling → worktree → implementation from the decisions → review → pull request

| Stage | Skill | Produces |
| --- | --- | --- |
| Research questions | `fathom:create-research-questions` | What the research must find out |
| Research | `fathom:create-research` | How the codebase works today |
| Product requirements (optional) | `fathom:create-prd` | What to build and why |
| Technical design | `fathom:create-tdd` | How to build it, settled through an interview |
| Structure outline | `fathom:create-structure-outline` | The work as thin, verifiable phases |
| Worktree | `fathom:setup-worktree` | An isolated checkout linked to the task |
| Implementation | `fathom:implement-outline` | The code, one phase at a time |
| Implementation, direct | `fathom:implement-decisions` | The code, straight from a decisions document |
| Pull request | `fathom:describe-pr` | The PR description |

Each document has an `iterate-` skill (`fathom:iterate-tdd`, `fathom:iterate-research`, …) that revises it in place. `fathom:show-me` explains anything visually along the way.

Start by running `fathom status` to see where the current task stands in its workflow, then tell the user which stage comes next: `fathom run` starts it, or they can run the stage's skill by hand.
