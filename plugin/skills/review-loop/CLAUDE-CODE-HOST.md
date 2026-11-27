# Invoking the loop from native Claude Code

Host branch for [`SKILL.md`](SKILL.md). Use these mechanics for the reviewer process and remediator dispatch; the main skill owns the loop's semantics and gates.

## Run the reviewer

Run step 2's `codex exec` command with `</dev/null >"$ROUND/codex.log" 2>&1` appended through the Bash tool with `run_in_background: true`. Record the returned background task id and wait for that task's terminal exit notification; it is the round's sole liveness signal. Then apply step 2's completion criterion in the main skill.

## Dispatch the remediator

Dispatch one general-purpose sub-agent with [`REMEDIATOR.md`](REMEDIATOR.md) as its brief, as [`../keylight/SUBAGENTS.md`](../keylight/SUBAGENTS.md) describes. After the brief's path, its prompt contains only:

- the absolute worktree path
- the absolute `findings.json` path
- the absolute `ledger.jsonl` path
- the round number

Pass paths and no rewritten finding prose. Wait for it to finish before judging the round. It is the only subagent writing to the worktree during remediation.
