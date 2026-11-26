# Coding Standards

## Design Principles

Hold every change to these principles:

- **Deep modules.** Judge module shape with the `codebase-design` skill: its vocabulary and principles, not its design-it-twice exercise.
- **Canonical data.** Work from the canonical structures the data owner already builds at the right point in its lifecycle. When access must be faster, the owner presents a view and manages its lifetime there, rather than a caller building a structure for one piece of work.
- **End-to-end processing.** Each step runs once, close to the data owner, at a point with a coherent reason, across every flow that reaches it. Optimize the whole flow: a step convenient locally but reversed downstream, such as encoding that a later stage decodes, is duplicate processing.
- **Production-only code.** Tests reach production through existing seams. When no seam exists and no other approach can test the behavior, escalate to the maintainer to choose between a minimal seam and a different testing approach.
- **Least surprise.** The command and file surface behaves as its intended user expects, both per operation and as a set whose operations work harmoniously together.

## Review

- Judge changes against these principles and the repository's instructions in [`AGENTS.md`](AGENTS.md), including its rules for comments.
