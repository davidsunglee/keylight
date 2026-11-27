# Lenses and gates

Rules for any session that writes or revises a TDD.

## Lenses

The **lenses** are the design principles in `CODING_STANDARDS.md` at the repository root. Read the file at the start of the session.

- For each question you put to the user, apply every lens to your recommendation and write out its guidance.
- For each change you make to the design, check it against every lens.
- A repository without that file has no lenses: say so once, in your first message.

## The ticket's decisions stand

Reflect every decision in the ticket in the design. Reopen one only when analysis or research gives a reason, and name the reason.

## Gates

A **gate** delivers a message from the user at a set point in the session. You run a command, and what it prints is the user's message for that moment, delivered now instead of typed.

| Gate | Command | Run it when |
| --- | --- | --- |
| System design | `keylight gate tdd system-design` | the System Design is settled, or you have changed it |
| Program design | `keylight gate tdd program-design` | the Program Design is settled, or you have changed it |

At a gate:

1. Carry out the message in full, exactly as if the user had sent it.
2. Fix what it turns up in the document.
3. Report on each of its points in your next message.
4. Put any decision it gives reason to reconsider to the user as a question.

A session that changed both sections runs both gates, system design first.
