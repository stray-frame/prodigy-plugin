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
 * missing git can NEVER break the member's Claude Code session. No stdout
 * (SessionStart stdout is injected into the model's context).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { git, readJson, resolveRepo, stripBom } from "../lib/studio-repo.mjs";

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

  await fetch(`${url}/api/cc/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
