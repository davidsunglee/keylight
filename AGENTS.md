# keylight

## Code Documentation

- Prefer clear names, types, and structure over comments.
- Write a comment only for a reason or constraint the code cannot show. Never narrate straightforward code.
- Keep comments timeless and code-local. Never reference research, design, planning, or review artifacts, or how the code got here.
- Update or remove affected comments when behavior changes; a stale comment is a defect.

Design principles are in [`CODING_STANDARDS.md`](CODING_STANDARDS.md).

## Standing Requirements

- The viewer and the whole workflow work on a phone. Check every viewer change at phone width.
- Code decides the order of workflow steps. Models work inside a step only.
- A definition two skills need lives once, in `plugin/skills/keylight/` or the owning skill, and is reached by relative link.
- The viewer's safety rules in the README are invariants: loopback only, nothing served outside the root, HTML artifacts sandboxed.

## Skills

- Write and edit skills following the `writing-for-agents` skill.
- Skills from outside this repository (`grilling`, `review-loop`) are used by name and never edited from here.

## Verification

A pull request merges into `main` only when GitHub's five jobs pass, each running one script: `bun run check`, `check:browser`, `check:audit`, `check:commits` and `check:harness`. Run the ones a change touches before pushing:

- `bun run check` must pass.
- Verify a viewer change with `bun run check:browser`, which checks desktop and phone width.
- Verify a change to the flags keylight passes Claude Code or Codex with `bun run check:harness`.
- Run `bun run check:commits` before pushing a branch; it checks each subject the branch adds to `origin/main`.
- Verify a skill or runner change by running it in a real session in a scratch repository. Reading the skill is not verification.
- Launch test sessions on cheaper models at medium effort: `opus` or `sonnet` in Claude Code, `gpt-6.2-sol` or `gpt-6.1-terra` in Codex.

## Commits

- Before committing, inspect `git log --oneline -5` and use a concise Conventional Commit subject consistent with repository history: `type(scope): subject`.
- Scopes are the top-level parts: `cli`, `viewer`, `skills`. Leave the scope out for a change that spans them.
- Stage the files the change touched by name.
- Unless requested, omit verification commands from commit bodies. Do not add generated-by, co-author, or similar trailers.
