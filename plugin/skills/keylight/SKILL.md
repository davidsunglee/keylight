---
name: keylight
description: The keylight workflow at a glance, and which skill to run at each stage.
disable-model-invocation: true
---

Keylight takes a piece of work from question to pull request through a series of documents, each one written in its own session and read by the next. Every skill reads and writes the task folder described in [`TASKS.md`](TASKS.md).

Three workflows string the stages together, and `keylight run` takes a task through one of them, a fresh session per stage:

- **design** (the default): research questions → research → technical design → structure outline → worktree → implementation → pull request
- **product**: the same, with product requirements before the technical design
- **direct**: grilling → worktree → implementation from the decisions → review → pull request

| Stage | Skill | Produces |
| --- | --- | --- |
| Research questions | `kl:create-research-questions` | What the research must find out |
| Research | `kl:create-research` | How the codebase works today |
| Product requirements (optional) | `kl:create-prd` | What to build and why |
| Technical design | `kl:create-tdd` | How to build it, settled through an interview |
| Structure outline | `kl:create-structure-outline` | The work as thin, verifiable phases |
| Worktree | `kl:setup-worktree` | An isolated checkout linked to the task |
| Implementation | `kl:implement-outline` | The code, one phase at a time |
| Implementation, direct | `kl:implement-decisions` | The code, straight from a decisions document |
| Pull request | `kl:describe-pr` | The PR description |

Each document has an `iterate-` skill (`kl:iterate-tdd`, `kl:iterate-research`, …) that revises it in place. `kl:show-me` explains anything visually along the way.

Start by running `keylight status` to see where the current task stands in its workflow, then tell the user which stage comes next: `keylight run` starts it, or they can run the stage's skill by hand.
