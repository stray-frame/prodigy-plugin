---
name: standup
description: Morning standup for Prodigy — see today's plan and open tasks, and pick where to start in this repo. Use when the user runs /prodigy:standup or asks "what should I work on today", "what's on my plate", or similar at the start of a session.
---

# Prodigy standup

1. Call `get_today_plan` and `get_my_tasks`.
2. Cross-reference with THIS repo: which open tasks plausibly live here?
   Match project names against the repo's own name, its `.prodigy.json` if
   it has one, and what you can see of the codebase. Check recent git log
   for momentum ("you left off at …").
3. Present a short standup: due today, in progress, and ONE concrete
   suggestion for where to start in this repo, with the first step.
4. If the user picks something that matches a task, call `start_task`.

Keep the whole thing under ~10 lines. No filler.
