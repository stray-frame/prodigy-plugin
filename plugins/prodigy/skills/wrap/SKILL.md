---
name: wrap
description: End-of-session wrap for Prodigy — summarize the session in one line, report it, close finished tasks, draft a leave-off note. Use when the user runs /prodigy:wrap or says they're done / wrapping up / heading out.
---

# Prodigy wrap

1. Review what actually happened THIS session: your own work in this
   conversation plus `git status` / `git log` for landed changes.
2. Call `report_progress` with one sentence summarizing the session's
   outcome (≤140 chars, commit-message style).
3. Call `get_my_tasks`; for any task this session completed, call
   `complete_task`.
4. Tell the user a one-line "leave-off" note (where to pick up tomorrow).
   Display it in chat — the note itself stays local; only the one-sentence
   summary from step 2 was reported.
5. If the user asked to be clocked out (now, or earlier with "clock me out
   when you're done"), call `clock_out` last, with `summary` set to a short
   wrap: what got done, what's unfinished, and the leave-off note. That
   wrap is sent to them as a Discord DM along with the clock-out, so it does
   leave the machine: plain sentences only, no code. Don't clock anyone out
   who didn't ask.
