# keylight

A personal research → design → outline → implement workflow for coding agents
(Claude Code, Codex, later Pi), built around rich design artifacts on local
disk.

## Layout

```text
keylight/
├── cli/        # the `keylight` command: workflow runner, task folders, viewer links
├── viewer/     # local artifact viewer
└── plugin/     # the `kl` plugin, installed in Claude Code and Codex
    ├── .claude-plugin/  .codex-plugin/   # one manifest per tool
    ├── LICENSE, NOTICE  # the skills derive from HumanLayer's Apache-2.0 plugin
    └── skills/          # workflow skills, one directory per skill
        ├── keylight/   # shared: task-folder conventions, sub-agent briefs,
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
~/Artifacts/                              # KEYLIGHT_ROOT
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
keylight task                     # the task linked here, and its files
keylight task new <task>          # create it (or reuse it) and link it here
keylight task list                # tasks stored for this repository
keylight task next tdd <slug>     # path for the next numbered document
keylight scratch                  # the task's scratch page (see Workflows)
```

A shared checkout can have several tasks linked; name one with `--task <task>`
or `KEYLIGHT_TASK`.

## Workflows

`keylight run` takes a task through a workflow, one fresh session per step. It
is a plain loop: start the step's session, wait for it to end, check what the
step was meant to leave behind, start the next. No model decides the order.

| Workflow | Steps |
| --- | --- |
| `design` (default) | research-questions → research → tdd → structure-outline → worktree → implement-outline → pr |
| `product` | the same, with `prd` before `tdd` |
| `direct` | grill → worktree → implement-decisions → review → pr |

```sh
keylight start COR-310                  # seed from a Linear ticket (needs LINEAR_API_KEY), then run
keylight start "what to build" --workflow direct
keylight run                            # continue from the first unfinished step
keylight run --from tdd                 # go back to a step: continues its session (--fresh starts it over)
keylight run --from tdd --until tdd     # one step; --dry-run prints the commands instead
keylight run --note "start with the CLI"  # a note for the first session the run starts
keylight status                         # the steps and how far they are
```

- **Headless steps** run unattended and the next step starts when they end:
  research questions, research, implementation from decisions, review, pull
  request. Messages and tool calls are shown as they happen.
- **Interactive steps** are ordinary sessions. When you quit one, the runner
  asks whether the step is complete:

  ```text
  Is the technical design complete?
  (1) Yes, proceed to the structure outline
  (2) Yes, stop for now
  (3) Yes, send a note to the next session
  (4) No
  Choose 1-4 [1]:
  ```

  Enter picks the first answer. "No" keeps the step open, and the next
  `keylight run` resumes the same session, in Claude Code and in Codex.
  `confirm: false` on the step skips the question, and `title` sets how the
  question names it.
- **A note for the next session.** The third answer asks for a line of text
  and adds it to the opening message of the next step that starts a session.
  `keylight run --note "…"` does the same for the first session a run starts.
  A note reaches new sessions only, so the answer is not offered when the next
  step would resume its session. `keylight status` shows a note until its step
  is done.
- **A step is finished when its evidence is there**: its document exists, or
  every phase heading in the decisions document carries ✅, or its `check`
  command passes. Otherwise the runner stops and says what is missing.
- **The worktree step is code**, not a session. `keylight worktree` runs it by
  hand.

Run it in a Rex tab per task: `rex run -- keylight run`.

### Workflows, steps and profiles

The built-in definitions are in [`cli/workflows.yaml`](cli/workflows.yaml),
which documents every field. Override any part in
`~/.config/keylight/workflows.yaml`. A **profile** says how each step's session
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
<repo>/.keylight/prompts/<name>.md      then      ~/.config/keylight/prompts/<name>.md
```

| File | Delivered |
| --- | --- |
| `<step>.md`, e.g. `tdd.md` | appended to the step's opening message |
| `<step>.<gate>.md`, e.g. `tdd.system-design.md` | when the session reaches that gate |

A **gate** is a point inside a step where the skill runs
`keylight gate <step> <gate>` and carries out what it prints, as a message from
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
keylight scratch < entry.md     # add an entry at the top of scratch.md, print its link
keylight scratch                # just the link, to open before a session
```

Keep the page open beside the session; it reloads as entries arrive, newest
first. Text shapes (call trees, file trees, diffs, pseudocode) stay in the
message. The rule lives in `plugin/skills/keylight/SCRATCH.md` and is referenced by
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
| Implementation | `implement-outline` (runs `review-loop` on the phases the outline marks for review) |
| Implementation, direct | `implement-decisions` (from a decisions document) |
| Review | `review-loop` (Codex reviews, a sub-agent fixes, until clean) |
| Pull request | `describe-pr` |

The skills are one plugin, so every name carries its prefix: `/kl:create-tdd`
in Claude Code, `kl:create-tdd` in Codex. Each document has an `iterate-`
skill. `kl:keylight` shows this table and where the current task stands. In
Claude Code the workflow skills run only when invoked by name.

Two skills come from outside this repository and are used by name:
`grilling`, the first step of the `direct` workflow, and `code-review`, the
two-axis review that `review-loop` hands to Codex.

**One definition, referenced.** Anything two skills need lives once and is
reached by a relative link: `../keylight/TASKS.md` (task folders, document
naming, formatting rules), `../keylight/SUBAGENTS.md` and `../keylight/agents/`
(sub-agent briefs), `../keylight/HTML-ARTIFACTS.md` (HTML pages and their
template), `../show-me/SKILL.md` (visual conventions). An `iterate-` skill
reuses its `create-` skill's final answer. The links resolve because the
plugin keeps the skills as sibling directories.

**Sub-agents are briefs, not named agents.** A skill dispatches a
general-purpose sub-agent and tells it to read a brief by path. Nothing is
registered with Claude Code or Codex, and the same brief works in both.

### Install

```sh
git clone https://github.com/davidsunglee/keylight.git
cd keylight
bun install

# The command: a wrapper in any directory on PATH.
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec bun "%s/cli/keylight.ts" "$@"\n' "$PWD" > ~/.local/bin/keylight
chmod +x ~/.local/bin/keylight

# Claude Code: one link, named for the skill prefix. The plugin loads from the
# repository, so edits apply to the next session.
mkdir -p ~/.claude/skills
ln -s "$PWD/plugin" ~/.claude/skills/kl

# Codex: register the repository as a marketplace, then install from it.
codex plugin marketplace add "$PWD"
codex plugin add kl@keylight
```

Update with `git pull` in the checkout, then `bun install` if `bun.lock`
changed. The wrapper and the Claude Code link run from the checkout, so the
next command and session use the update. A running viewer keeps the old code,
so restart it with `keylight stop` (the next `keylight view` starts it again),
then reload any open viewer tab. Codex installs a copy of `plugin/`.
After a pull or a skill change, refresh the copy:

```sh
codex plugin remove kl@keylight && codex plugin add kl@keylight
```

`claude plugin disable kl@skills-dir` and `codex plugin remove kl@keylight`
turn the plugin off without touching the repository.

The agent must be able to write to the artifact root, which is outside the
worktree:

- **Sessions started by `keylight run`** are given the task's folder
  automatically, and the runner starts the viewer first.
- **Claude Code, by hand:** add the root to `permissions.additionalDirectories`.
- **Codex, by hand:** add it to `sandbox_workspace_write.writable_roots`.
  Codex's sandbox also blocks local network, so `keylight url` prints the link
  without being able to start the viewer; keep one running (`keylight view`).

## Viewer

Renders the artifacts in a browser: GitHub-flavored Markdown, Mermaid
diagrams, highlighted code, line-colored diffs, frontmatter, task lists, and
HTML artifacts embedded inline from `task-artifact` fences. Pages reload when
the file changes on disk. The layout works on a phone.

Every top-level section folds from its heading (the top level is the highest
heading level below the title), and its entry in the sidebar's outline folds
separately. The sidebar hides with the button at the top left or Cmd-B, and
resizes by dragging its edge (double-click the edge to reset). Folds, the
sidebar's state and its width are remembered per device.

```sh
keylight view                    # task index
keylight view path/to/03-tdd-x.md
keylight url  path/to/03-tdd-x.md   # print the link only (what skills call)
keylight stop
```

A path may go through a worktree symlink; it resolves to the same link.

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Artifact root | `--root` | `KEYLIGHT_ROOT` | `~/Artifacts` |
| Port | `--port` | `KEYLIGHT_PORT` | `4747` |
| Base URL for printed links | `--public-url` | `KEYLIGHT_PUBLIC_URL` | `http://localhost:<port>` |
| Config directory (themes) | `--config` | `KEYLIGHT_CONFIG` | `~/.config/keylight` |

### Themes

A theme is a [Ghostty theme file](https://ghostty.org/docs/features/theme):
`background`, `foreground`, and the 16 `palette` colors. The viewer uses nine
values from it (background, text, secondary text, six hues) and derives every
other color, including diagram colors, in the stylesheet. Hues are adjusted
only as far as needed to stay readable on the background.

```text
~/.config/keylight/
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
call `_theme_write_keylight` from `_theme_propagate`.

### On a phone

The viewer listens on loopback only. To reach it from another device, put it
behind Tailscale and tell keylight the address so printed links use it:

```sh
tailscale serve --bg 4747
export KEYLIGHT_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
```

### Safety

- Only files under the artifact root are served.
- Requests for an unknown host name are refused.
- HTML artifacts run sandboxed, both when embedded and when opened directly,
  so their scripts cannot reach the viewer or read other artifacts.
- Raw HTML in Markdown is limited to a list of formatting tags. Anything else
  is shown as text, so `Stream<T>` in prose stays visible.

## Checking a change

GitHub runs five jobs on every pull request and every push to `main`, each one
`bun run` script. `main` takes a change only through a pull request whose five
jobs pass, merged by rebase so its commit subjects land as checked; the owner
can bypass. Before pushing, run the ones a change touches:

| Script | Checks | Needs |
| --- | --- | --- |
| `bun run check` | Types, Biome format and lint (complexity included), tests with per-file coverage, duplication, dead code, file sizes | The checkout, offline |
| `bun run check:browser` | The viewer's render check at desktop and phone width | WebKit (below) |
| `bun run check:audit` | No locked dependency has a known advisory | The network |
| `bun run check:commits [base]` | Each commit subject in `<base>..HEAD` is `type(scope): subject`; the base defaults to `origin/main` | The branch's history |
| `bun run check:harness` | Every flag keylight passes Claude Code and Codex is in their `--help` | `claude` and `codex` installed |

`check:harness` also runs weekly, since a CLI release can drop a flag without a
change here.

No job shows what a model does inside a step. Verify a skill or runner change
by running it in a real session in a scratch repository.

### The viewer in a browser

These tools drive headless WebKit, the engine behind Safari on Mac and iPhone
(`bunx playwright install webkit` once). The fixtures in `viewer/test/fixtures/`
hold one document per thing the viewer renders; a new rendering feature adds one.

```sh
# Start a viewer over the committed fixtures and render-check them at desktop and phone width.
bun run check:browser

# Render every document that has a diagram (every document with --all) in a running viewer;
# report failed or missing diagrams, a document route that answers other than 200 (a redirect included),
# artifacts not found or not loading, script errors and sideways overflow. Documents are .md and .mdx files.
bun viewer/test/render-check.ts --root <dir> [--port N] [--mobile] [--all] [--match TEXT] [--limit N] [--shots DIR]

# Screenshot one page.
bun viewer/test/shot.ts /view/<path> out.png [--mobile] [--dark] [--at CSS] [--theme NAME]
```
