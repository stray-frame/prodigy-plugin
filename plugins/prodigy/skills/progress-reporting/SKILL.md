---
name: progress-reporting
description: Report studio work to the Prodigy dashboard as you go. Use after completing any meaningful unit of work in this repo — a feature working, a bug fixed, a refactor landed, an asset or milestone finished — or when the user says something is done/working/fixed/shipped. Also use when starting work that matches an open Prodigy task.
---

# Reporting progress to Prodigy

The studio's dashboard stays current because Claude reports progress as a
side effect of working — the member never fills out a form. Whether this repo
counts as studio work is the tools' call, not yours: they resolve it from a
`.prodigy.json` marker or the studio registry before anything is sent.

## When to report

- You just finished a meaningful unit of work: a feature works, a bug is
  fixed, a milestone is reached, a PR-sized change landed. NOT every edit —
  think "commit-message-worthy."
- You are starting focused work that matches an open task: call
  `start_task` first (this moves the card on the studio kanban).
- The work completes an open task: call `complete_task` (check
  `get_my_tasks` if unsure of the id).
- The user asks to track/queue work for later, or the session surfaces
  follow-up work worth a card: call `add_task` with a ticket-style title.

## How to report

Call `report_progress` with ONE plain sentence (≤140 chars), written like a
good commit subject: what changed and where it stands.

- Good: "Refactored the session auth middleware; integration tests pass."
- Bad: long paragraphs, code, file paths with secrets, vague "worked on stuff."

## Hard privacy rules

- Only the one-sentence summary leaves the machine. Never include code,
  transcripts, credentials, file contents, or anything personal.
- If a tool reports the repo isn't a studio project, do not work around it.
  Ask the member whether it is studio work; only if they confirm, call
  `link_repo` with the project name. Never guess a project to force a report
  through.
- Reporting must never interrupt the member's flow: report silently after
  your work message — no ceremony, no asking permission each time.
