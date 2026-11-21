---
name: budget
description: Work the studio's money from the prompt (managers only) — check cash, log spending or income, set up or change repeating payouts like a contractor's Robux, record a Roblox cash-out, set ownership shares and line budgets. Use when the user runs /prodigy:budget or asks about the studio's money, cash on hand, what we've spent, a payout, DevEx, group funds, or wants something added to or fixed on the budget.
---

# Prodigy budget

The dashboard's /budget page is a view. This is where the money gets worked.
The budget tools are for managers only, and the server enforces it. If a tool
says "managers only", tell the user that and stop. Never try another route
around it.

## Reading

1. Call `get_budget` (pass `month` for another month). Answer from it. Don't
   recite the whole thing:
   - "How are we doing" → cash on hand, this month in vs out, what's
     coming up, and Roblox earnings not yet cashed out.
   - A specific question → just that figure, with what it's made of.
2. Money is in dollars. Print Robux next to the dollars **only** when an
   entry has `robux`, meaning the money really moved in Robux:
   `−$810 (R$ 150,000)`. Never turn dollars into Robux, or Robux into
   dollars, yourself. Roblox earnings come with their own estimate
   (`approxUsd`), so print it with "≈".

## Writing

- **Confirm before writing** whenever the amount, project, or what it's for
  is unclear. One short line is enough: "Log −$405 to 2PRT · Scripting,
  'Valpz payout', dated today?" The ledger is shared, and the whole studio
  reads it.
- Log money with `log_money`. Fix entries with `edit_money`, using ids from
  `get_budget`. Use `remove_money` only for mistakes and duplicates. Name
  the entry and get a yes first.
- Anything that repeats goes in `set_repeating`, not one entry at a time.
  Payouts that move on their own (Roblox group payouts) get
  `auto_pay: true` plus their exact `robux`. To change one, call `update`
  on the rule. To end one, call `stop`, which keeps the history. Use
  `delete` only for a rule created by mistake.
- When planned or expected money actually happens, record it with
  `settle_money`, using the real amount if it differed. Auto-pay rules
  book themselves, so leave those alone.
- When Roblox earnings get cashed out, call `cash_out_roblox` with the
  dollars that actually landed.
- Use `set_ownership` for a share of a project, `set_line_budget` for money
  set aside per line, and `set_spending_cap` for the studio's monthly cap.

## Roblox money: facts the user has confirmed

- 2PRT's earnings are split by Roblox: the group keeps 80%, and two 10%
  payouts go out automatically. One of those 10% cuts is studio money that
  a member holds only so the group keeps its verified badge, which is why
  the studio's share shows as 90%. The other 10% is a developer's pay.
- Group payouts use the higher-value Robux first: $0.0054 each for
  purchases by verified US 18+ players, against $0.0038 standard. The
  payout screen's dollar figure is what Roblox values a payout at, so log
  that figure, not your own conversion.
- None of this is readable through Roblox's API. Group funds and payouts
  need a logged-in account, which the studio declined to run. When the
  user reads figures off the Payouts page, take their numbers.

After a write, say in one line what changed, with the amount and the
project. Never make up an id. If unsure, call `get_budget` again.
