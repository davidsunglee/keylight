# Task folders

Every workflow skill reads and writes one **task folder**: the documents for one piece of work, shared by every session and worktree working on it. The `keylight` command is the source of truth for where the folder is and what it holds.

## Finding the folder

`keylight task` prints the task linked to this worktree:

```text
task   cor-310-page-offset
dir    .artifacts/tasks/cor-310-page-offset
store  /Users/me/Artifacts/parallax/cor-310-page-offset
files
  01-research-questions-page-offset.md
  02-research-page-offset.md
  task.md
```

`dir` is a symlink into the artifact store, which lives outside the repository. Read and write through `dir` as an ordinary directory. Git ignores it, so task documents stay out of every commit. A program that is handed an output path needs the `store` path instead: `codex exec -o`, for one, cannot write through the link.

When no task is linked, `keylight task` says so:

- `keylight task list` shows the tasks already stored for this repository.
- `keylight task new <task>` links one of those, or creates it.

Name a task `<ticket>-<description>` in kebab case, such as `cor-310-page-offset`, or the description alone when there is no ticket. When the request leaves the task open, ask the user which one this is before creating anything.

A checkout shared by several tasks has several linked, and `keylight task` lists them. Work on the one the user named, passing `--task <task>` to `keylight task` and `keylight task next`; when they named none, ask.

## Documents

Staged documents are numbered in the order they were written: `NN-<kind>-<description>.md`, where `<description>` is a 2-4 word kebab-case slug.

`keylight task next <kind> <description>` prints the path for a new one, for example `keylight task next tdd retry-policy`.

| Kind | Document |
| --- | --- |
| `research-questions` | Questions the research must answer |
| `research` | How the codebase works today |
| `prd` | Product requirements |
| `tdd` | Technical design |
| `structure-outline` | Phased implementation outline |
| `decisions` | What a grilling conversation settled, for work implemented without a design stage |
| `review-prompt` | What a review of the implementation is aimed at |

The folder also holds un-numbered files: `task.md` and any ticket text (the ask), `pr-description.md`, and HTML artifacts. `review-loop/` holds the rounds of each review.

**`scratch.md` is not an input.** It holds the visuals shown during conversations ([`SCRATCH.md`](SCRATCH.md)); skip it when a skill tells you to read the task folder.

**Precedence.** When documents disagree, the later stage wins: structure outline > TDD > PRD > research > ticket, and a decisions document outranks the ticket. For questions about how the code behaves today, the code wins.

**Research questions are inputs to research only.** Every later stage reads the research document and skips the questions.

## Writing documents

Documents are read in the keylight viewer, which renders Markdown, Mermaid, highlighted code and diffs.

- **Nested fences.** When a code block shows Markdown that has its own fence, give the outer fence four backticks so the inner one cannot close it.
- **Mermaid that parses.** Quote any node or edge label containing punctuation (`A["conflict: a | b"]`), and keep `;` out of sequence-diagram messages. A diagram that fails to parse shows as an error.
- **Frontmatter.** Keep the template's frontmatter and fill it from git: `repo`, `branch`, and `sha` (`git rev-parse HEAD`).

## Showing a document to the user

`keylight url <path>` prints a link that opens the document in the viewer, starting the viewer if needed. The page updates as the file changes.

Whenever you hand the user a document to read, give them that link.

## HTML artifacts

For a visual too rich for Markdown, see [`HTML-ARTIFACTS.md`](HTML-ARTIFACTS.md).
