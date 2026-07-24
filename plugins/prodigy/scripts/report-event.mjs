#!/usr/bin/env node
/**
 * Prodigy session reporter — runs on SessionStart / SessionEnd.
 *
 * Privacy contract (enforced HERE, before any network call):
 *  - Only reports in repos that carry a .prodigy.json marker at the git
 *    root (project-level opt-in). No marker → exit silently, zero traffic.
 *  - Sends metadata only: event type, session id, repo name, branch,
 *    git email, project. Never code, never transcripts.
 *
 * Failure contract: every path exits 0 — a down dashboard, bad token, or
 * missing git can NEVER break the member's Claude Code session. No stdout
 * (SessionStart stdout is injected into the model's context).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_URL = "https://prodigy.strayframe.net";
const DEFAULT_TOKEN = "";

/** Written by the MCP server's connect_account tool. */
const CRED_PATH = path.join(homedir(), ".prodigy", "credentials.json");

/** Windows editors and PowerShell often write UTF-8 with a BOM, which
 *  JSON.parse rejects — strip it wherever we read JSON. */
const stripBom = (s) => s.replace(/^﻿/, "");
const readJson = (file) => JSON.parse(stripBom(readFileSync(file, "utf8")));

function git(cwd, args) {
  try {
    return execSync(`git ${args}`, {
      cwd,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

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

  // ---- opt-in gate: no marker, no traffic --------------------------------
  const gitRoot = git(cwd, "rev-parse --show-toplevel");
  if (!gitRoot) return; // not a git repo → personal by definition
  let marker;
  try {
    marker = readJson(path.join(gitRoot, ".prodigy.json"));
  } catch {
    return; // no marker → personal repo → report nothing
  }
  if (marker.enabled === false) return;

  // ---- gather metadata ---------------------------------------------------
  const body = {
    type:
      payload.hook_event_name === "SessionStart"
        ? "session_start"
        : "session_end",
    sessionId: payload.session_id,
    repo: path.basename(gitRoot),
    branch: git(cwd, "rev-parse --abbrev-ref HEAD") || undefined,
    gitEmail: git(cwd, "config user.email") || undefined,
    project: typeof marker.project === "string" ? marker.project : undefined,
    source: "hook",
  };

  const { url, token } = loadConfig();
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
