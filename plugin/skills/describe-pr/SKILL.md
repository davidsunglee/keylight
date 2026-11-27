---
name: describe-pr
description: Create or update the pull request for the current task with a concise, visual description, then watch CI until it passes.
disable-model-invocation: true
---

# Describe a Pull Request

Create or update the pull request for the current task with a concise description that helps a reviewer understand why the change exists and the shape of the implementation.

## Workflow

1. Read the description template: [`pr-description-template.md`](pr-description-template.md)

2. Identify or create the pull request:
   - If `gh` is missing or signed out, stop and tell the user. Do not work around it.
   - Check the current branch for a PR with `gh pr view --json url,number,title,state,baseRefName,headRefName 2>/dev/null`.
   - If no PR exists, inspect `git status --short --branch` and the commits on the current branch.
   - Commit task-related changes when needed, push the branch with an upstream, and create a PR for it. Follow the repository's git safety protocol.
   - Ask the user to select a PR only when the current branch has no relevant work and there is no safe current-branch PR to create.

3. Gather only the context needed to explain the change:
   - Read [`../keylight/TASKS.md`](../keylight/TASKS.md), then run `keylight task` to find the task folder. Read the ticket and any relevant task documents.
   - Read the complete PR diff and enough surrounding code to understand behavior and ownership.
   - Use `gh pr view` to collect PR metadata and changed files.
   - Read [`../show-me/SKILL.md`](../show-me/SKILL.md) for the visual-outline conventions used in the PR body.

4. Write the PR description using the template:
   - Keep **Why the change** to exactly one sentence.
   - Keep **Special things to note** to 1-3 bullets. Prioritize reviewer warnings, migrations, compatibility constraints, deliberate omissions, or surprising decisions. Write `- None.` when there are no special considerations.
   - Make **Change outline** a compact, `show-me`-inspired structural view rather than prose or a file-by-file changelog.
   - Include only the views that help explain this PR:
     - SQL table and endpoint contract changes, plus pseudocode for business logic.
     - A shallow file tree showing changed responsibilities.
     - React component tree changes, including important hooks, state, and package boundaries.
     - Call-tree, call-stack, control-flow, or data-flow changes.
   - Prefer `diff` blocks when showing changes to an existing shape. Show the complete target shape when most of it is new or diff notation would obscure ownership or order.
   - Keep each view focused on the calls, files, fields, components, and boundaries a reviewer needs. Omit categories that did not change.
   - Keep the body to the template: no walkthrough artifacts, exhaustive implementation narratives, verification checklists, changelog text, or plan-deviation sections.

5. Save and publish the description:
   - Save it as `pr-description.md` in the task folder. When no task is linked, use a temporary file.
   - Update the PR with `gh pr edit {number} --body-file {output-path}`.
   - Confirm the update succeeded.

6. Report completion with exactly this, filling in the saved description's link from `keylight url <path>`:

   ```markdown
   ### Status

   - PR: [#{number} - {title}]({pr_url})
   - Description saved: <link>
   - Ticket: [{TICKET_ID}]({ticket_url}) (if applicable)

   ### Summary

   [2-3 sentence summary of what the PR does and key implementation decisions]

   ### Files Changed

   - `{file_path}` - [brief description]
   - ...

   ### Deviations from the Outline

   [Brief summary of any deviations found, or "No outline found" / "Implemented as outlined"]

   ### Next Steps

   The PR description has been updated at [pr_url]. Waiting 5 minutes, then checking for merge conflicts and watching CI checks until they pass.
   ```

   Send this report as a message, then keep working in the same turn. Do not end the turn here; step 7 runs after the report.

7. Watch CI until it passes:
   - Wait 5 minutes so checks can start: `sleep 300` (give the command a timeout above 5 minutes).
   - Check for merge conflicts with `gh pr view {number} --json mergeable,mergeStateStatus`. If `mergeable` is `UNKNOWN`, wait 30 seconds and ask again.
   - When `mergeable` is `CONFLICTING`:
     - Do not merge, rebase, or edit any files to resolve the conflicts.
     - Fetch the base branch from the base repo's remote (`git fetch {remote} {baseRefName}`) and list the conflicting files with `git merge-tree --write-tree --name-only HEAD {remote}/{baseRefName}`.
     - For each conflicting file, compare both sides (`git log --oneline HEAD...{remote}/{baseRefName} -- {file}` and the diffs) to learn what each side changed.
     - Offer the user a merge plan: which base commits conflict, how to resolve each file (keep ours, keep theirs, or combine, and why), and the checks to run after merging.
     - Stop and wait for the user to approve the plan. Do not watch CI while the PR has conflicts, since many checks will not run until they are fixed.
   - Check status with `gh pr checks {number}`. If it reports no checks yet, wait another 2 minutes and check again, at most 3 times. If there are still no checks, tell the user and stop.
   - While checks are pending, watch them with `gh pr checks {number} --watch --fail-fast` (give the command a 10 minute timeout). If the command times out, run it again.
   - When a check fails:
     - Read the failed run's logs with `gh run view {run-id} --log-failed` and find the cause.
     - If the failure comes from this PR's changes, fix it, run the matching local check, commit, push, and go back to watching.
     - If the failure is flaky or unrelated to this PR, rerun it once with `gh run rerun {run-id} --failed`. If it fails again, stop and tell the user what failed and why.
     - Stop and ask the user after 3 fix attempts on the same check.
   - When all checks pass, send a short final message that says so, with the PR URL.

Always read and follow [`pr-description-template.md`](pr-description-template.md). Do not expand the PR body beyond that template.

Write as one human talking to another: avoid jargon and slang, and use simple, coherent, concise language.
