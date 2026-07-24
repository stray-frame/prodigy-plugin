#!/usr/bin/env node
/**
 * Prodigy MCP server — zero-dependency stdio JSON-RPC 2.0 (tools only).
 *
 * Hand-rolled on purpose: no npm install step for members, no node_modules
 * in the plugin cache. Scope is the stable tools-only surface (initialize,
 * tools/list, tools/call, ping). If a future client version's handshake
 * drifts, swap in @modelcontextprotocol/sdk per docs/production.md.
 *
 * Privacy: write tools refuse in repos without a .prodigy.json marker
 * (second enforcement layer — the hook script is the first). Only
 * one-sentence summaries are ever transmitted.
 */

import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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

function git(args) {
  try {
    return execSync(`git ${args}`, {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const gitRoot = git("rev-parse --show-toplevel");
let marker = null;
if (gitRoot) {
  try {
    // strip a possible UTF-8 BOM (common from Windows editors/PowerShell)
    marker = JSON.parse(
      readFileSync(path.join(gitRoot, ".prodigy.json"), "utf8").replace(
        /^﻿/,
        ""
      )
    );
  } catch {
    marker = null;
  }
}
const optedIn = marker !== null && marker.enabled !== false;
const repoCtx = {
  repo: gitRoot ? path.basename(gitRoot) : undefined,
  branch: git("rev-parse --abbrev-ref HEAD") || undefined,
  project:
    optedIn && typeof marker?.project === "string" ? marker.project : undefined,
};

const NOT_OPTED_IN =
  "This repo has no .prodigy.json marker, so it's treated as personal — nothing was reported. Studio repos carry the marker; do not try to work around this.";

/* -------------------------------------------------------------- api */

async function api(method, route, body) {
  const res = await fetch(`${API_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${currentToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Prodigy API ${res.status}`);
  return res.json();
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
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok)
        return "That token was not accepted (mistyped, or revoked by a newer mint?) — generate a fresh one at the dashboard's /connect page and paste the new prompt.";
      const { member } = await res.json();
      mkdirSync(path.dirname(CRED_PATH), { recursive: true });
      writeFileSync(CRED_PATH, JSON.stringify({ token }, null, 2));
      return `Connected as ${member} — Prodigy reports from this machine are now attributed to you. Takes effect immediately.`;
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
            `- [${t.id}] ${t.title} · ${t.project} · ${t.status}${t.due ? ` · due ${t.due}` : ""}${t.points ? ` · ${t.points} pt` : ""}`
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
      "Queue a new task on the member's Prodigy board (To do lane). Call when the user asks to track, queue, or remember work for later — or when a session surfaces follow-up work worth a card. Title reads like a good ticket name; never include code, paths, or secrets. Estimate story points from the title and context — 1: trivial tweak (<30 min); 2: small, well-understood change; 3: a typical half-day task; 5: large multi-part work; 8: major feature or unfamiliar territory. Always pass your estimate; the member can adjust it on the dashboard. When unsure between two sizes, pick the larger.",
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
      },
      required: ["title"],
      additionalProperties: false,
    },
    async run({ title, project, due, points }) {
      if (!optedIn) return NOT_OPTED_IN;
      const { task } = await api("POST", "/api/cc/tasks", {
        title: String(title).slice(0, 140),
        project: project ?? repoCtx.project,
        repo: repoCtx.repo,
        dueIso: due,
        points,
      });
      return `Queued: ${task.title} — card added to To do${task.due ? ` (due ${task.due})` : ""} · ${task.points} pt.`;
    },
  },
  {
    name: "start_task",
    description:
      "Mark a Prodigy task as in progress. Call as soon as you begin working on something that matches an open task — this moves the card to the In-progress lane on the studio dashboard.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    async run({ taskId }) {
      if (!optedIn) return NOT_OPTED_IN;
      const { task } = await api("POST", "/api/cc/start", { taskId });
      return `Started: ${task.title} — the card moved to In progress.`;
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
      if (!optedIn) return NOT_OPTED_IN;
      await api("POST", "/api/cc/events", {
        type: "progress",
        summary: String(summary).slice(0, 140),
        project: project ?? repoCtx.project,
        taskId,
        repo: repoCtx.repo,
        branch: repoCtx.branch,
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
      if (!optedIn) return NOT_OPTED_IN;
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
          serverInfo: { name: "prodigy", version: "0.4.0" },
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

log(
  `ready · repo=${repoCtx.repo ?? "none"} · optedIn=${optedIn} · project=${repoCtx.project ?? "-"}`
);
