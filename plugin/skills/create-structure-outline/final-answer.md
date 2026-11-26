Check whether you are already in a worktree: run `git rev-parse --git-dir`; you are in one when the output contains `.git/worktrees/`.

Then respond with exactly the text in the block below. Replace `<link>` with the link that `fathom url <path>` prints for the outline, and `<next step>` with the sentence that applies:

- **In a worktree:** You're already in a worktree, so once you're happy with the approach we can go straight to implementation: start a new session and run the `fathom:implement-outline` skill.
- **Otherwise:** Once you're happy with the approach, set up a worktree: start a new session and run the `fathom:setup-worktree` skill.

```markdown
## Next Steps

The implementation outline has been created: <link>

It defines how we will approach the implementation in a clear and concise way.

**Please read it and work with me to ensure:**

1. Step structure & ordering makes sense to you. Ideally, steps should be thin vertical slices that are incrementally verifiable and/or deliverable.
2. Verification steps make sense to you. Did I capture all the testing and verification patterns you have?

You can also ask me to add more detail, code snippets, pseudo-code, or mermaid diagrams.

<next step>
```
