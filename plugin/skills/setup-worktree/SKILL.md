---
name: setup-worktree
description: Create an isolated git worktree for the current task and link the task folder into it.
disable-model-invocation: true
---

Run `keylight worktree` from the repository's main checkout. It creates the task's worktree and branch, copies the local files the repository names, runs its setup command, and links the task folder into the new worktree.

It reads `.keylight/workspace.json` (shared) and `.keylight/workspace.local.json` (local overrides). With neither, it reads an earlier `.humanlayer/workspace.json`, and failing that uses its defaults: a worktree at `~/.keylight/workspaces/<task>/<repo>` on a branch named after the task.

When several tasks are linked to the checkout, name the one you mean: `keylight worktree --task <task>`.

If the command fails, show the user its error and work with them to finish the setup.

When it succeeds, respond with exactly this, filling in the path from the `worktree` line it printed:

```markdown
Worktree for [task] is ready at [path], with the task folder linked.

To implement, start a new session in that directory and run the `kl:implement-outline` skill, or run `keylight run` to continue the task's workflow.
```
