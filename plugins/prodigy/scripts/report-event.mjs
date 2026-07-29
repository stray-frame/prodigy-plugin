#!/usr/bin/env node
/**
 * Prodigy session reporter — runs on SessionStart / SessionEnd.
 *
 * Privacy contract (enforced HERE, before anything about this repo is sent):
 *  - Only reports in studio repos — either a .prodigy.json marker at the git
 *    root, or a name match against the registry synced from the dashboard.
 *    The registry is a plain list fetched for this member and matched
 *    locally; a personal repo never appears in a request. No match → exit
 *    silently.
 *  - Sends metadata only: event type, session id, repo name, branch,
 *    git email, project. Never code, never transcripts.
 *
 * Failure contract: every path exits 0 — a down dashboard, bad token, or
 * missing git can NEVER break the member's Claude Code session.
 *
 * On SessionStart it prints the member's open cards, because that stdout is
 * injected into the model's context. This is deliberate and is the only
 * reason cards reach the In-progress lane reliably: without it a session
 * starts blind to the board, and moving a card depends on the model choosing
 * to go looking for one. Nothing is printed for a personal repo, an empty
 * board, or an unreachable dashboard.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  TIMEOUT_MS,
  git,
  readJson,
  resolveRepo,
  stripBom,
} from "../lib/studio-repo.mjs";

const DEFAULT_URL = "https://prodigy.strayframe.net";
const DEFAULT_TOKEN = "";

/** Written by the MCP server's connect_account tool. */
const CRED_PATH = path.join(homedir(), ".prodigy", "credentials.json");

function loadConfig() {
  // Layered: credentials file (newest explicit action, from the /connect
  // setup prompt) → env (user_config interpolation) → plugin data file →
  // defaults.
  let url = process.env.PRODIGY_API_URL;
  let token;
  try {
    token = readJson(CRED_PATH).token || undefined;
  } catch {
    // not connected via prompt — fall through to env/config
  }
  token = token || process.env.PRODIGY_API_TOKEN;
  // ${user_config.*} may pass through un-interpolated on some versions.
  if (url && url.startsWith("${")) url = undefined;
  if (token && token.startsWith("${")) token = undefined;
  if ((!url || !token) && process.env.CLAUDE_PLUGIN_DATA) {
    try {
      const file = readJson(
        path.join(process.env.CLAUDE_PLUGIN_DATA, "config.json")
      );
      url = url || file.api_url;
      token = token || file.api_token;
    } catch {
      // no data file — fall through to defaults
    }
  }
  return { url: url || DEFAULT_URL, token: token || DEFAULT_TOKEN };
}

async function main() {
  const payload = JSON.parse(stripBom(readFileSync(0, "utf8")));
  const cwd = payload.cwd || process.cwd();

  // Loaded before the gate now: deciding whether this is a studio repo can
  // need the registry, which is fetched for this member and carries nothing
  // about the repo either way.
  const { url, token } = loadConfig();

  // ---- opt-in gate: not a studio repo, no traffic ------------------------
  const ctx = await resolveRepo({ cwd, url, token });
  if (!ctx.studio) return;

  // ---- gather metadata ---------------------------------------------------
  const body = {
    type:
      payload.hook_event_name === "SessionStart"
        ? "session_start"
        : "session_end",
    sessionId: payload.session_id,
    repo: ctx.repo,
    branch: ctx.branch,
    gitEmail: git(cwd, "config user.email") || undefined,
    project: ctx.project,
    source: "hook",
  };

  const isStart = body.type === "session_start";

  // Run together rather than in sequence — the hook's budget in hooks.json
  // has to cover one TIMEOUT_MS, not two, and the board fetch doesn't depend
  // on the event landing.
  const [, board] = await Promise.all([
    fetch(`${url}/api/cc/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null),
    isStart ? fetchOpenCards(url, token) : Promise.resolve(null),
  ]);

  // SessionStart stdout is injected into the model's context. Without this
  // a session begins blind to the board: cards created on the dashboard are
  // invisible, so matching work to one depends on thinking to go looking.
  // Printing them is what makes start_task happen reliably.
  if (isStart && board?.length) {
    process.stdout.write(renderBoard(board, ctx.project));
  }
}

async function fetchOpenCards(url, token) {
  try {
    const res = await fetch(`${url}/api/cc/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const { tasks } = await res.json();
    return Array.isArray(tasks)
      ? tasks.filter((t) => t && t.status !== "done")
      : null;
  } catch {
    return null; // a quiet start beats a broken one
  }
}

/** Compact enough to be worth its context: this repo's project first, a few
 *  from elsewhere, hard-capped. */
function renderBoard(cards, project) {
  const CAP = 8;
  const here = cards.filter((t) => t.project === project);
  const rest = cards.filter((t) => t.project !== project);
  const shown = [...here, ...rest].slice(0, CAP);
  if (!shown.length) return "";

  const line = (t) =>
    `  [${t.id}] ${t.title}` +
    (t.project !== project ? ` · ${t.project}` : "") +
    (t.points ? ` · ${t.points}pt` : "") +
    (t.due ? ` · due ${t.due}` : "") +
    (t.status === "in_progress" ? " · already in progress" : "");

  const hidden = cards.length - shown.length;
  return [
    `Prodigy — open cards for ${project ?? "this repo"}:`,
    ...shown.map(line),
    hidden > 0 ? `  (+${hidden} more)` : "",
    "If work this session matches one, call start_task with its id so the board",
    "reflects it, and report_progress as things land.",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
