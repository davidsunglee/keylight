# Sub-agents

A **brief** in [`agents/`](agents/) defines each sub-agent role: what it is for, how it works, and what it returns.

| Brief | Role |
| --- | --- |
| `codebase-locator` | Finds where code lives. Returns file locations grouped by purpose. |
| `codebase-analyzer` | Explains how specific code works, with `file:line` references. |
| `codebase-pattern-finder` | Finds existing implementations to model new work on, with code. |
| `web-search-researcher` | Answers a question from the web, with sources. |
| `outline-implementer` | Implements one phase of a structure outline. |

## Dispatch

Spawn a general-purpose sub-agent. Its prompt is the brief's absolute path with the instruction to read and follow it, then the task, then any paths it needs:

```text
Read /absolute/path/to/fathom/agents/codebase-locator.md and follow it.

Task: find where retry policy is configured and where it is consumed.
```

The sub-agent reads the brief itself, so the brief's text stays out of your prompt.

Wait for each result before you continue: run sub-agents in the foreground, and in parallel when their questions are independent. The four research briefs are read-only, so give them a faster model when the host lets you choose.

On a host without sub-agents, read the brief and do its work in this session.
