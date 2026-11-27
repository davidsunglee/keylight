# fathom

A personal research → design → outline → implement workflow for coding agents
(Claude Code, Codex, later Pi), built around rich design artifacts on local
disk. It replaces the parts of HumanLayer worth keeping: the workflow skills
and the artifact viewer.

## Layout

```text
fathom/
├── cli/        # the `fathom` command: workflow runner, task folders, viewer links
├── viewer/     # local artifact viewer
└── plugin/     # the `fathom` plugin, installed in Claude Code and Codex
    ├── .claude-plugin/  .codex-plugin/   # one manifest per tool
    ├── LICENSE, NOTICE  # the skills derive from HumanLayer's Apache-2.0 plugin
    └── skills/          # workflow skills, one directory per skill
        ├── fathom/     # shared: task-folder conventions, sub-agent briefs,
        │               # HTML artifact template; also the overview skill
        ├── show-me/    # visual conventions, used by other skills and on its own
        ├── create-*/   # one per stage, each with its template and final answer
        ├── iterate-*/  # revise a stage's document in place
        └── setup-worktree/  implement-outline/  implement-decisions/  describe-pr/
```

Everything shares one contract: the task folder below. Skills write into it,
the viewer reads it, and a future Pi extension would be another view of the
same files.

## Task folders

A task's documents live in one central root, outside any repository, so they
outlive worktrees and can be backed up as a unit.

```text
~/Artifacts/                              # FATHOM_ROOT
└── <repo>/
    └── <task>/
        ├── task.md
        ├── 01-research-questions-<slug>.md
        ├── 02-research-<slug>.md
        ├── 03-tdd-<slug>.md
        ├── 04-structure-outline-<slug>.md
        ├── pr-description.md
        └── *.html                        # diagrams, mockups

<worktree>/.artifacts/tasks/<task>  ->  ~/Artifacts/<repo>/<task>
```

The worktree symlink is ignored through `.git/info/exclude`, never
`.gitignore`. `<repo>` is the repository's name, shared by all its worktrees.

```sh
fathom task                     # the task linked here, and its files
fathom task new <task>          # create it (or reuse it) and link it here
fathom task list                # tasks stored for this repository
fathom task next tdd <slug>     # path for the next numbered document
fathom scratch                  # the task's scratch page (see Workflows)
```

A shared checkout can have several tasks linked; name one with `--task <task>`
or `FATHOM_TASK`.

## Workflows

`fathom run` takes a task through a workflow, one fresh session per step. It
is a plain loop: start the step's session, wait for it to end, check what the
step was meant to leave behind, start the next. No model decides the order.

| Workflow | Steps |
| --- | --- |
| `design` (default) | research-questions → research → tdd → structure-outline → worktree → implement-outline → pr |
| `product` | the same, with `prd` before `tdd` |
| `direct` | grill → worktree → implement-decisions → review → pr |

```sh
fathom start COR-310                  # seed from a Linear ticket (needs LINEAR_API_KEY), then run
fathom start "what to build" --workflow direct
fathom run                            # continue from the first unfinished step
fathom run --from tdd                 # go back to a step: continues its session (--fresh starts it over)
fathom run --from tdd --until tdd     # one step; --dry-run prints the commands instead
fathom status                         # the steps and how far they are
```

- **Headless steps** run unattended and the next step starts when they end:
  research questions, research, implementation from decisions, review, pull
  request. Messages and tool calls are shown as they happen.
- **Interactive steps** are ordinary sessions. When you quit one, the runner
  asks whether the step is finished: yes and start the next, yes and stop, or
  not yet. "Not yet" keeps the step open, and the next `fathom run` resumes the
  same Claude Code session (a Codex step starts a new one). `confirm: false`
  on the step skips the question.
- **A step is finished when its evidence is there**: its document exists, or
  every phase heading in the decisions document carries ✅, or its `check`
  command passes. Otherwise the runner stops and says what is missing.
- **The worktree step is code**, not a session. `fathom worktree` runs it by
  hand.

Run it in a Rex tab per task: `rex run -- fathom run`.

### Workflows, steps and profiles

The built-in definitions are in [`cli/workflows.yaml`](cli/workflows.yaml),
which documents every field. Override any part in
`~/.config/fathom/workflows.yaml`. A **profile** says how each step's session
is launched, so the model and reasoning effort are chosen once, not per session:

```yaml
profile: default
profiles:
  default:
    claude: { model: opus, effort: high }          # every Claude Code session
    codex:  { model: gpt-6.2-sol, effort: high }   # every Codex session
    tdd:    { model: fable }
    structure-outline: { harness: codex }
    research: { subagents: { model: sonnet, effort: high } }
  frugal:
    claude: { model: sonnet, effort: medium }
```

Entries combine field by field: a step's own entry wins over its harness's
entry (`claude`, `codex`), which wins over `"*"`. `subagents` sets the model
and effort for the sub-agents a step's session dispatches, in Claude Code. Pick a profile per task with `--profile`. A step can name any installed skill, so
your own skills can be steps.

### Prompts you always add

Text you would otherwise paste goes in a file, and the runner or the skill
delivers it. The repository's copy wins over your personal one:

```text
<repo>/.fathom/prompts/<name>.md      then      ~/.config/fathom/prompts/<name>.md
```

| File | Delivered |
| --- | --- |
| `<step>.md`, e.g. `tdd.md` | appended to the step's opening message |
| `<step>.<gate>.md`, e.g. `tdd.system-design.md` | when the session reaches that gate |

A **gate** is a point inside a step where the skill runs
`fathom gate <step> <gate>` and carries out what it prints, as a message from
you delivered at that moment. The default text ships with each skill as
`gate-<gate>.md`:

| Step | Gate | When |
| --- | --- | --- |
| `tdd` | `system-design` | the system design is settled, or `iterate-tdd` changed it |
| `tdd` | `program-design` | the program design is settled, or `iterate-tdd` changed it |
| `structure-outline` | `review` | the outline has been written, or `iterate-structure-outline` changed it |

A `create-` skill and its `iterate-` skill share one gate text. The TDD's
lenses and gates are defined once, in
`plugin/skills/create-tdd/lenses-and-gates.md`.

### Diagrams in a terminal session

A terminal draws text only: Mermaid shows as source and HTML artifacts do not
show. Documents are unaffected, since the viewer renders them. For a diagram
that belongs in a conversation message, the session adds it to the task's
**scratch page** and puts the link in the message:

```sh
fathom scratch < entry.md     # add an entry at the top of scratch.md, print its link
fathom scratch                # just the link, to open before a session
```

Keep the page open beside the session; it reloads as entries arrive, newest
first. Text shapes (call trees, file trees, diffs, pseudocode) stay in the
message. The rule lives in `plugin/skills/fathom/SCRATCH.md` and is referenced by
`show-me`, `create-tdd`, `iterate-tdd`, `create-prd`, `iterate-prd` and the
`grill` step. Later stages skip `scratch.md` when they read the task folder.
With no task linked, the page goes to `<root>/<repo>/scratch/`.

### Coding standards

`create-tdd` and `implement-decisions` read `CODING_STANDARDS.md` at the
repository root. In a TDD session its design principles are the **lenses**
every recommendation is judged through. The review step measures the change
against the same file, so design and review share one source.

## Skills

| Stage | Skill |
| --- | --- |
| Research questions | `create-research-questions` |
| Research | `create-research` |
| Product requirements (optional) | `create-prd` |
| Technical design | `create-tdd` |
| Structure outline | `create-structure-outline` |
| Worktree | `setup-worktree` |
| Implementation | `implement-outline` (runs `review-loop` per phase on request) |
| Implementation, direct | `implement-decisions` (from a decisions document) |
| Pull request | `describe-pr` |

The skills are one plugin, so every name carries its prefix: `/fathom:create-tdd`
in Claude Code, `fathom:create-tdd` in Codex. Each document has an `iterate-`
skill. `fathom:fathom` shows this table and where the current task stands. In
Claude Code the workflow skills run only when invoked by name.

**One definition, referenced.** Anything two skills need lives once and is
reached by a relative link: `../fathom/TASKS.md` (task folders, document
naming, formatting rules), `../fathom/SUBAGENTS.md` and `../fathom/agents/`
(sub-agent briefs), `../fathom/HTML-ARTIFACTS.md` (HTML pages and their
template), `../show-me/SKILL.md` (visual conventions). An `iterate-` skill
reuses its `create-` skill's final answer. The links resolve because the
plugin keeps the skills as sibling directories.

**Sub-agents are briefs, not named agents.** A skill dispatches a
general-purpose sub-agent and tells it to read a brief by path. Nothing is
registered with Claude Code or Codex, and the same brief works in both.

### Install

```sh
bun install

# The command: a wrapper in any directory on PATH.
printf '#!/bin/sh\nexec bun %s/cli/fathom.ts "$@"\n' "$PWD" > ~/.local/bin/fathom
chmod +x ~/.local/bin/fathom

# Claude Code: one link. The plugin loads from the repository, so edits apply
# to the next session.
ln -s "$PWD/plugin" ~/.claude/skills/fathom

# Codex: register the repository as a marketplace, then install from it.
codex plugin marketplace add "$PWD"
codex plugin add fathom@fathom
```

Codex installs a copy of `plugin/`. After changing a skill, refresh the copy:

```sh
codex plugin remove fathom@fathom && codex plugin add fathom@fathom
```

`claude plugin disable fathom@skills-dir` and `codex plugin remove fathom@fathom`
turn the plugin off without touching the repository.

The agent must be able to write to the artifact root, which is outside the
worktree:

- **Sessions started by `fathom run`** are given the task's folder
  automatically, and the runner starts the viewer first.
- **Claude Code, by hand:** add the root to `permissions.additionalDirectories`.
- **Codex, by hand:** add it to `sandbox_workspace_write.writable_roots`.
  Codex's sandbox also blocks local network, so `fathom url` prints the link
  without being able to start the viewer; keep one running (`fathom view`).

## Viewer

Renders the artifacts in a browser: GitHub-flavored Markdown, Mermaid
diagrams, highlighted code, line-colored diffs, frontmatter, task lists, and
HTML artifacts embedded inline from `task-artifact` fences. Pages reload when
the file changes on disk. The layout works on a phone.

```sh
fathom view                    # task index
fathom view path/to/03-tdd-x.md
fathom url  path/to/03-tdd-x.md   # print the link only (what skills call)
fathom stop
```

A path may go through a worktree symlink; it resolves to the same link.

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Artifact root | `--root` | `FATHOM_ROOT` | `~/Artifacts` |
| Port | `--port` | `FATHOM_PORT` | `4747` |
| Base URL for printed links | `--public-url` | `FATHOM_PUBLIC_URL` | `http://localhost:<port>` |
| Config directory (themes) | `--config` | `FATHOM_CONFIG` | `~/.config/fathom` |

### Themes

A theme is a [Ghostty theme file](https://ghostty.org/docs/features/theme):
`background`, `foreground`, and the 16 `palette` colors. The viewer uses nine
values from it (background, text, secondary text, six hues) and derives every
other color, including diagram colors, in the stylesheet. Hues are adjusted
only as far as needed to stay readable on the background.

```text
~/.config/fathom/
├── themes/<name>     # one theme per file; symlinks are fine
├── theme.conf        # light = <name> / dark = <name>
└── custom.css        # optional: override any CSS variable by hand
```

- **Auto** (the default) uses the `theme.conf` pair, chosen by the device's
  light or dark appearance. Open pages restyle when these files change.
- **The picker** in the top bar overrides Auto for that browser only, so a
  phone and a laptop can differ. The choice is kept in the browser.
- With no config directory the viewer uses its built-in light and dark
  palette and hides the picker.

`viewer/integrations/theme.zsh` connects this to the Theme utility in
`~/.config/theme`: it links every slug's Ghostty theme into `themes/` and
writes `theme.conf` from Theme's state. Add the function to `apply.zsh` and
call `_theme_write_fathom` from `_theme_propagate`.

### On a phone

The viewer listens on loopback only. To reach it from another device, put it
behind Tailscale and tell fathom the address so printed links use it:

```sh
tailscale serve --bg 4747
export FATHOM_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
```

### Safety

- Only files under the artifact root are served.
- Requests for an unknown host name are refused.
- HTML artifacts run sandboxed, both when embedded and when opened directly,
  so their scripts cannot reach the viewer or read other artifacts.
- Raw HTML in Markdown is limited to a list of formatting tags. Anything else
  is shown as text, so `Stream<T>` in prose stays visible.

### Checking a change

Both tools drive headless WebKit, the engine behind Safari on Mac and iPhone
(`bunx playwright install webkit` once).

```sh
# Render every document that has a diagram; report failures and sideways overflow.
bun viewer/test/parity.ts --root <dir> [--mobile] [--match TEXT] [--limit N]

# Screenshot one page.
bun viewer/test/shot.ts /view/<path> out.png [--mobile] [--dark] [--at CSS] [--theme NAME]
```
