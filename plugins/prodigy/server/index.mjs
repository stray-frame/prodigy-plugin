#!/usr/bin/env node
/**
 * Prodigy MCP server — zero-dependency stdio JSON-RPC 2.0 (tools only).
 *
 * Hand-rolled on purpose: no npm install step for members, no node_modules
 * in the plugin cache. Scope is the stable tools-only surface (initialize,
 * tools/list, tools/call, ping). If a future client version's handshake
 * drifts, swap in @modelcontextprotocol/sdk per docs/production.md.
 *
 * Privacy: write tools refuse in repos that are not studio projects — a
 * .prodigy.json marker or a name match against the registry synced for this
 * member, decided locally (second enforcement layer — the hook script is the
 * first). Only one-sentence summaries are ever transmitted.
 */

import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  TIMEOUT_MS,
  loadRegistry,
  normalizeKey,
  resolveRepo,
  writeMarker,
} from "../lib/studio-repo.mjs";

const API_URL = clean(process.env.PRODIGY_API_URL) || "https://prodigy.strayframe.net";

/** Written by connect_account when the member pastes the /connect setup
 *  prompt. Wins over the user_config env value — the credentials file is
 *  the newer, explicit action. */
const CRED_PATH = path.join(homedir(), ".prodigy", "credentials.json");

function credToken() {
  try {
    return JSON.parse(readFileSync(CRED_PATH, "utf8")).token || undefined;
  } catch {
    return undefined;
  }
}

/** Resolved per call so connect_account takes effect without a restart. */
function currentToken() {
  return credToken() || clean(process.env.PRODIGY_API_TOKEN) || "";
}

function clean(v) {
  // ${user_config.*} may pass through un-interpolated on some versions
  return v && !v.startsWith("${") ? v : undefined;
}

function log(...args) {
  console.error("[prodigy-mcp]", ...args);
}

/* ------------------------------------------------------ repo context */

/** A positive answer ("this is studio project X") is resolved once and
 *  reused — the registry fetch behind it is cached on disk, and there is no
 *  reason to redo the git calls per tool call. A negative answer is NOT
 *  kept: the server starts with the session, before the member has had a
 *  chance to `git init` or write a marker, and a memoized "not a git
 *  repository" made link_repo refuse for the rest of the session until
 *  someone reconnected. Re-resolving costs two git calls, which is nothing.
 *  connect_account clears it so a freshly-saved token takes effect. */
let ctxPromise = null;
function repoContext() {
  ctxPromise ??= resolveRepo({
    cwd: process.cwd(),
    url: API_URL,
    token: currentToken(),
  })
    .catch(() => ({ studio: false }))
    .then((ctx) => {
      if (!ctx.studio) ctxPromise = null;
      return ctx;
    });
  return ctxPromise;
}

const NOT_OPTED_IN =
  "This repo isn't a studio project — it matched neither a .prodigy.json marker nor the studio registry, so it's treated as personal and nothing was reported. If it IS a studio repo, call link_repo with the project name; otherwise leave it alone rather than working around this.";

/* -------------------------------------------------------------- api */

async function api(method, route, body) {
  const res = await fetch(`${API_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${currentToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Keep the dashboard's own error code on the throw: assign_task turns
    // "target_not_on_project" into a sentence the member can act on, where
    // a bare status would only say "403".
    const err = new Error(`Prodigy API ${res.status}`);
    err.status = res.status;
    err.code = await res
      .json()
      .then((b) => b?.error)
      .catch(() => undefined);
    throw err;
  }
  return res.json();
}

/* -------------------------------------------------- name resolution */

/**
 * Match a name the member SAID ("Lejam") against the people the dashboard
 * says they may assign to, the way link_repo matches a project name against
 * the registry. The write side takes a store key, and a typo would
 * otherwise 422 with nothing to go on.
 *
 * Exact match on either the store key or the display alias wins; failing
 * that, a name that starts one candidate and only one. Anything looser is a
 * question for the member — a card landing on the wrong board is worse than
 * asking.
 */
function matchAssignee(name, candidates) {
  const key = normalizeKey(String(name));
  if (!key) return { kind: "none" };
  const keysOf = (c) => [normalizeKey(c.member), normalizeKey(c.displayName)];
  const exact = candidates.filter((c) => keysOf(c).includes(key));
  if (exact.length === 1) return { kind: "one", who: exact[0] };
  if (exact.length > 1) return { kind: "many", who: exact };
  const partial = candidates.filter((c) =>
    keysOf(c).some((k) => k.startsWith(key))
  );
  if (partial.length === 1) return { kind: "one", who: partial[0] };
  if (partial.length > 1) return { kind: "many", who: partial };
  return { kind: "none" };
}

const nameOf = (c) => c.displayName || c.member;

/** GET /api/cc/assignees, then match. Returns either { who } or a
 *  ready-to-return sentence for the member. */
async function resolveAssignee(name, query) {
  const { task, project, viewerMember, assignable } = await api(
    "GET",
    `/api/cc/assignees?${query}`
  );
  const others = assignable.filter((c) => c.member !== viewerMember);
  const match = matchAssignee(name, assignable);
  if (match.kind === "one") return { who: match.who, task, project };
  if (match.kind === "many") {
    return {
      text: `"${name}" could be any of ${match.who.map(nameOf).join(", ")} — ask the member which one, then call again with the full name.`,
    };
  }
  const where = task ? task.project : project;
  return {
    text: others.length
      ? `Nobody you can assign to on ${where} matches "${name}". People you can hand work to there: ${others.map(nameOf).join(", ")}. If they meant one of these, call again with that name; if the person is on the team but missing here, their Discord role isn't on the project yet.`
      : `There's nobody you can assign to on ${where} — assignment is a team gesture, so both of you need the project's Discord role (managers can assign to anyone). Nothing was changed.`,
  };
}

/** The dashboard's error codes for an assignment, as sentences. */
function assignFailure(err, who) {
  switch (err.code) {
    case "target_not_on_project":
      return `${nameOf(who)} isn't on that project's team, so the card can't go to them — a manager can still assign it, or their Discord role needs adding first. Nothing was changed.`;
    case "not_on_project":
    case "unknown_task":
      return "That card isn't one you can hand over — either the id is wrong, or the project isn't one your Discord roles put you on. Nothing was changed.";
    case "unknown_member":
      return `${nameOf(who)} isn't on the studio roster any more, so the card stayed where it was.`;
    case "task_done":
      return "That card is already Done, and finished cards are frozen — reassigning it would move credit after the fact. Nothing was changed.";
    case "roles_unavailable":
      return "Discord didn't answer when checking project roles, so the assignment was refused rather than guessed. Try again in a moment.";
    default:
      return null;
  }
}

/* ------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: "connect_account",
    description:
      "Save the member's personal Prodigy token on this machine. Call when the user pastes a setup prompt like 'Connect my Prodigy account: prodigy_…' (minted on the dashboard's /connect page). Validates the token against the dashboard, then stores it in ~/.prodigy/credentials.json — hooks and tools authenticate as them from then on, no restart needed. The token goes nowhere except the Prodigy API.",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
      additionalProperties: false,
    },
    async run({ token }) {
      token = String(token).trim();
      const res = await fetch(`${API_URL}/api/cc/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok)
        return "That token was not accepted (mistyped, or revoked by a newer mint?) — generate a fresh one at the dashboard's /connect page and paste the new prompt.";
      const { member } = await res.json();
      mkdirSync(path.dirname(CRED_PATH), { recursive: true });
      writeFileSync(CRED_PATH, JSON.stringify({ token }, null, 2));
      // The repo context may have resolved to "personal" purely because
      // there was no token to sync the registry with. Re-resolve.
      ctxPromise = null;
      return `Connected as ${member} — Prodigy reports from this machine are now attributed to you. Takes effect immediately.`;
    },
  },
  {
    name: "link_repo",
    description:
      "Tell Prodigy which studio project this repo belongs to. Call when the member says something like 'this repo is for Gunship Simulator', or after a write tool reported the repo isn't recognized and the member confirms it IS studio work. Writes the .prodigy.json marker here and registers the repo on the dashboard so teammates who clone it resolve automatically. Never call this to force reporting on a repo the member hasn't confirmed is studio work.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Studio project name, e.g. 'Gunship Simulator'",
        },
      },
      required: ["project"],
      additionalProperties: false,
    },
    async run({ project }) {
      const ctx = await repoContext();
      if (!ctx.gitRoot)
        return "This folder isn't a git repository, so there's nothing to link — Prodigy identifies repos by their git root.";

      // Match against the real roster rather than trusting the string: a
      // typo would otherwise open a project nobody is looking at.
      const registry = await loadRegistry({
        url: API_URL,
        token: currentToken(),
      });
      const roster = registry?.projects ?? [];
      const matched = roster.find(
        (p) => normalizeKey(p) === normalizeKey(String(project))
      );
      if (!matched) {
        return roster.length
          ? `No studio project matches "${project}". Current projects: ${roster.join(", ")}. Ask the member which one, then call link_repo again.`
          : `Could not reach the dashboard to check the project list, so nothing was linked. Try again once it's back.`;
      }

      await api("POST", "/api/cc/registry", { repo: ctx.repo, project: matched });
      const file = writeMarker(ctx.gitRoot, matched);
      ctxPromise = null;

      return `Linked ${ctx.repo} to ${matched}. Wrote ${path.basename(file)} at the repo root — commit it so the whole team is covered even before the registry syncs. Reporting works from here on.`;
    },
  },
  {
    name: "get_my_tasks",
    description:
      "Get the member's open Prodigy tasks with ids, projects, statuses, and due dates. Call when deciding what to work on, or before reporting progress to check whether the work matches an open task.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const { tasks } = await api("GET", "/api/cc/tasks");
      const open = tasks.filter((t) => t.status !== "done");
      if (open.length === 0) return "No open tasks on the board.";
      return open
        .map(
          (t) =>
            `- [${t.id}] ${t.title} · ${t.project} · ${t.status}${t.due ? ` · due ${t.due}` : ""}${t.points ? ` · ${t.points} pt` : ""}${t.skills?.length ? ` · ${t.skills[0].skill}` : ""}`
        )
        .join("\n");
    },
  },
  {
    name: "get_today_plan",
    description:
      "Get today's plan: tasks due today and in progress. Call at the start of a work session or when the user asks what today looks like.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const plan = await api("GET", "/api/cc/plan");
      const fmt = (list) =>
        list.length
          ? list.map((t) => `- [${t.id}] ${t.title} · ${t.project}`).join("\n")
          : "  (none)";
      return `Due today:\n${fmt(plan.dueToday)}\nIn progress:\n${fmt(plan.inProgress)}\nOpen:\n${fmt(plan.open)}`;
    },
  },
  {
    name: "add_task",
    description:
      "Queue a new task on the member's Prodigy board (To do lane). Call when the user asks to track, queue, or remember work for later — or when a session surfaces follow-up work worth a card. Title reads like a good ticket name; never include code, paths, or secrets. Estimate story points from the title and context — 1: trivial tweak (<30 min); 2: small, well-understood change; 3: a typical half-day task; 5: large multi-part work; 8: major feature or unfamiliar territory. Always pass your estimate; the member can adjust it on the dashboard. When unsure between two sizes, pick the larger. Also classify the task into ONE studio discipline — game_design, level_design, programming, ux_ui, art_3d, vfx, audio, production — the area the work mostly lives in (a dashboard tweak is ux_ui or programming, a blockout is level_design). Always pass your pick; the member can adjust it until the card is done. Approved points level that discipline on the member's skill profile and feed their Design/Tech core stats.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title, ≤140 chars" },
        project: { type: "string" },
        due: { type: "string", description: "Optional due date, YYYY-MM-DD" },
        points: {
          type: "number",
          enum: [1, 2, 3, 5, 8],
          description: "Story-point estimate — always provide one",
        },
        skill: {
          type: "string",
          enum: [
            "game_design",
            "level_design",
            "programming",
            "ux_ui",
            "art_3d",
            "vfx",
            "audio",
            "production",
          ],
          description:
            "The discipline this work levels up — always provide one",
        },
        assignee: {
          type: "string",
          description:
            "Optional: file the card on a teammate's board instead of the member's own — the name as the member said it (e.g. 'Lejam'). Only when they explicitly asked for it to go to someone else.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async run({ title, project, due, points, skill, assignee }) {
      const ctx = await repoContext();
      if (!ctx.studio) return NOT_OPTED_IN;
      const landing = project ?? ctx.project;

      // Resolve the name BEFORE filing so a typo never queues a card on the
      // member's own board by accident.
      let who;
      if (assignee) {
        if (!landing)
          return "A card for someone else needs a project so the right team can be checked — pass one, or link this repo first.";
        const resolved = await resolveAssignee(
          assignee,
          `project=${encodeURIComponent(landing)}`
        );
        if (resolved.text) return resolved.text;
        who = resolved.who;
      }

      let task;
      try {
        ({ task } = await api("POST", "/api/cc/tasks", {
          title: String(title).slice(0, 140),
          project: landing,
          repo: ctx.repo,
          dueIso: due,
          points,
          // the API stores a weighted split; a single pick is 100% of it —
          // the area's fixed Design/Tech ratio does the rest (GDT-style)
          skills: skill ? [{ skill, pct: 100 }] : undefined,
          member: who?.member,
        }));
      } catch (err) {
        const said = who && assignFailure(err, who);
        if (said) return said;
        throw err;
      }
      const picked = task.skills?.[0]?.skill;
      const lane = who
        ? `card added to ${nameOf(who)}'s To do (they've been told on Discord)`
        : "card added to To do";
      return `Queued: ${task.title} — ${lane}${task.due ? ` (due ${task.due})` : ""} · ${task.points} pt${picked ? ` · ${picked}` : ""}.`;
    },
  },
  {
    name: "start_task",
    description:
      "Mark a Prodigy task as in progress. Call as soon as you begin working on something that matches an open task — this moves the card to the In-progress lane on the studio dashboard, and clocks the member into that project on Discord if they weren't already working.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    async run({ taskId }) {
      const ctx = await repoContext();
      if (!ctx.studio) return NOT_OPTED_IN;
      const { task, clock } = await api("POST", "/api/cc/start", { taskId });
      // clock.message already states plainly what happened to the Discord
      // session — including that nothing did. Pass it through rather than
      // re-deriving it, so the model never reports a clock-in that was
      // actually skipped.
      return `Started: ${task.title} — the card moved to In progress.${clock?.message ? ` ${clock.message}` : ""}`;
    },
  },
  {
    name: "edit_task",
    description:
      "Fix the title of one of the member's existing cards. Call when they say a card is worded wrong, has a typo, or should read differently — not to re-scope work, which is a new card. Title only: project, due date and skill classification are deliberately not editable here. A card that is already Done is frozen and cannot be retitled.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        title: { type: "string", description: "New title, ≤140 chars" },
      },
      required: ["taskId", "title"],
      additionalProperties: false,
    },
    async run({ taskId, title }) {
      const ctx = await repoContext();
      if (!ctx.studio) return NOT_OPTED_IN;
      const { task } = await api("PATCH", "/api/cc/tasks", {
        taskId,
        title: String(title).slice(0, 140),
      });
      return `Renamed: the card now reads "${task.title}".`;
    },
  },
  {
    name: "assign_task",
    description:
      "Hand a Prodigy card to a teammate — 'assign this ticket to Lejam'. Call when the member names who should own a card; pass the name exactly as they said it and the tool resolves it against who they are allowed to assign to. Assignment is a team gesture, not a manager privilege: anyone whose Discord role puts them on the card's project can hand any of that project's cards to anyone else on it (managers can assign anyone). The card keeps its lane, points and title; the new owner is told on Discord and the handover is logged. Cards that are already Done are frozen. The member's own cards come from get_my_tasks; a teammate's card id can also be used if the member gives it. If the name is ambiguous or unknown the tool says so instead of guessing — relay that to the member rather than picking for them.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        to: {
          type: "string",
          description: "Who should own the card, as the member said it",
        },
      },
      required: ["taskId", "to"],
      additionalProperties: false,
    },
    async run({ taskId, to }) {
      const ctx = await repoContext();
      if (!ctx.studio) return NOT_OPTED_IN;

      let resolved;
      try {
        resolved = await resolveAssignee(
          to,
          `taskId=${encodeURIComponent(String(taskId))}`
        );
      } catch (err) {
        if (err.code === "unknown_task")
          return "No card with that id is on a board you can see — check the id with get_my_tasks. Nothing was changed.";
        throw err;
      }
      if (resolved.text) return resolved.text;
      const { who, task } = resolved;

      if (task.member === who.member)
        return `"${task.title}" is already on ${nameOf(who)}'s board — nothing to do.`;

      try {
        await api("PATCH", "/api/cc/tasks", { taskId, member: who.member });
      } catch (err) {
        const said = assignFailure(err, who);
        if (said) return said;
        throw err;
      }
      return `Assigned: "${task.title}" is now on ${nameOf(who)}'s board (${task.project}) — they've been told on Discord.`;
    },
  },
  {
    name: "delete_task",
    description:
      "Remove one of the member's cards from the board. ASK THE MEMBER FIRST and only call once they have said yes — never infer a delete from a card merely looking stale, duplicated, or obsolete. The card is archived rather than destroyed, so points already approved for it stay on the ledger, but points still awaiting a manager's approval are given up. If the member only wants the card out of the way for now, move_task back to todo instead.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    async run({ taskId }) {
      const ctx = await repoContext();
      if (!ctx.studio) return NOT_OPTED_IN;
      const { task, withdrawn } = await api("DELETE", "/api/cc/tasks", {
        taskId,
      });
      return `Deleted: "${task.title}" is off the board${withdrawn ? ` — ${withdrawn} pt that was awaiting approval has been withdrawn` : ""}.`;
    },
  },
  {
    name: "move_task",
    description:
      "Move one of the member's cards between the To-do and In-progress lanes. Call when work on a card stops and it should go back to To do, or when a card needs to be put back after being started by mistake. To mark work finished use complete_task instead — that is the only path to Done, because it carries the completion summary and the points award.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: {
          type: "string",
          enum: ["todo", "in_progress"],
          description: "Lane to move the card to",
        },
      },
      required: ["taskId", "status"],
      additionalProperties: false,
    },
    async run({ taskId, status }) {
      const ctx = await repoContext();
      if (!ctx.studio) return NOT_OPTED_IN;
      const { task } = await api("POST", "/api/cc/move", { taskId, status });
      const lane = task.status === "todo" ? "To do" : "In progress";
      return `Moved: "${task.title}" is now in ${lane}.`;
    },
  },
  {
    name: "report_progress",
    description:
      "Report one sentence of progress to the Prodigy dashboard. Call after landing a meaningful unit of work (feature working, bug fixed, asset exported, milestone hit) — not for every small edit. The summary is the ONLY thing that leaves this machine: plain factual sentence, like a commit message. Never include code, file contents, secrets, or personal details.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One sentence, ≤140 chars" },
        project: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    async run({ summary, project, taskId }) {
      const ctx = await repoContext();
      if (!ctx.studio) return NOT_OPTED_IN;
      await api("POST", "/api/cc/events", {
        type: "progress",
        summary: String(summary).slice(0, 140),
        project: project ?? ctx.project,
        taskId,
        repo: ctx.repo,
        branch: ctx.branch,
        source: "mcp",
      });
      return "Progress reported to the Prodigy dashboard.";
    },
  },
  {
    name: "complete_task",
    description:
      "Mark a Prodigy task done. Call when work in this session completes an open task (verify with get_my_tasks first). Optionally include a one-sentence completion summary.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        summary: { type: "string" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    async run({ taskId, summary }) {
      const ctx = await repoContext();
      if (!ctx.studio) return NOT_OPTED_IN;
      const { task, pending } = await api("POST", "/api/cc/complete", {
        taskId,
        summary,
      });
      return `Completed: ${task.title} — the card moved to Done${pending ? ` (${pending} pt pending manager approval)` : ""}.`;
    },
  },
];

/* ----------------------------------------------------- JSON-RPC loop */

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  line = line.replace(/^﻿/, ""); // BOM guard (Windows pipes)
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not JSON — ignore
  }
  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          // Keep in step with .claude-plugin/plugin.json — it drifted to
          // 0.5.0 once and made version reports useless for debugging.
          serverInfo: { name: "prodigy", version: "0.13.0" },
        });
        break;
      case "notifications/initialized":
      case "notifications/cancelled":
        break; // notifications need no reply
      case "ping":
        reply(id, {});
        break;
      case "tools/list":
        reply(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
        break;
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) {
          replyError(id, -32602, `Unknown tool: ${params?.name}`);
          break;
        }
        let text;
        try {
          text = await tool.run(params?.arguments ?? {});
        } catch (err) {
          // errors come back as text, never crash the server
          text = `Prodigy is unreachable right now (${err.message}) — nothing was reported. Continue working; the session hooks still record the basics when the dashboard is back.`;
        }
        reply(id, { content: [{ type: "text", text }] });
        break;
      }
      default:
        if (id !== undefined) replyError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (err) {
    log("handler error:", err.message);
    if (id !== undefined) replyError(id, -32603, "internal error");
  }
});

repoContext().then((ctx) =>
  log(
    `ready · repo=${ctx.repo ?? "none"} · studio=${ctx.studio} · project=${ctx.project ?? "-"}${ctx.source ? ` (${ctx.source})` : ""}`
  )
);
