/**
 * "Is this a studio repo, and which project?" — answered on this machine.
 *
 * Two sources, in order:
 *   1. A .prodigy.json marker at the git root. Explicit and offline; an
 *      `enabled: false` marker force-marks a repo personal and always wins.
 *   2. The studio registry, synced from the dashboard and cached here. The
 *      dashboard sends the whole list and the match runs locally, so a
 *      personal repo still produces no request that mentions it — the same
 *      guarantee the marker gave, without anyone hand-writing a file.
 *
 * Fails closed everywhere: no git root, no marker and no usable registry,
 * or any thrown error means personal, which means no traffic.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CACHE_PATH = path.join(homedir(), ".prodigy", "registry.json");

/** Re-sync a few times a day. New projects are rare; a stale cache costs a
 *  member one unattributed session, not a broken one. */
const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The request budget for every call the plugin makes, here and in the MCP
 * server and the hook script.
 *
 * The dashboard runs on a Fly machine with min_machines_running = 0, so the
 * first request after an idle gap waits on a cold boot: ~1.7s for the VM and
 * ~5s more before Next.js serves, measured from the proxy logs. The budget
 * used to be 3s, which aborted less than halfway through that — so reports
 * failed whenever a member happened to be the one who woke the machine, and
 * succeeded on the retry that followed. Fly's proxy holds the request while
 * the machine starts, so one patient call rides the boot out.
 */
export const TIMEOUT_MS = Number(process.env.PRODIGY_TIMEOUT_MS) || 12_000;

/**
 * A request budget that does not outlive the request.
 *
 * AbortSignal.timeout() arms a timer for the full budget and there is no way
 * to cancel it — so a 200ms fetch against a 12s budget leaves ~11.8s of timer
 * holding the event loop open. The hook script papered over that with
 * process.exit(), which is what produced the Windows libuv assertion
 * (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c:76) on Node 24:
 * exiting while libuv still had live handles to tear down.
 *
 * Returns the signal plus a `done()` the caller MUST call in a finally.
 */
export function budget(ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  timer.unref?.(); // never the reason the process is still alive
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

/** Undici pools keep sockets alive for ~4s after the last response, which
 *  keeps a short-lived script running long after its work is done. Closing
 *  the global dispatcher lets the loop drain immediately — the supported
 *  alternative to a hard process.exit(). The symbol is undici-internal but
 *  stable across 5–7; if it ever moves, we just exit a few seconds later. */
export async function closeConnections() {
  try {
    await globalThis[Symbol.for("undici.globalDispatcher.1")]?.close?.();
  } catch {
    // nothing to close, or a shape we don't recognize — harmless
  }
}

/** Windows editors and PowerShell write UTF-8 with a BOM, which JSON.parse
 *  rejects — strip it wherever we read JSON. */
export const stripBom = (s) => s.replace(/^﻿/, "");

/** "GunshipSimulator", "gunship-simulator" and "Gunship Simulator" all fold
 *  to "gunshipsimulator". This is the whole matching rule. */
export const normalizeKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function git(cwd, args) {
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

export function readJson(file) {
  return JSON.parse(stripBom(readFileSync(file, "utf8")));
}

export function markerPath(gitRoot) {
  return path.join(gitRoot, ".prodigy.json");
}

export function readMarker(gitRoot) {
  try {
    return readJson(markerPath(gitRoot));
  } catch {
    return null;
  }
}

function readCache() {
  try {
    const c = readJson(CACHE_PATH);
    return c && typeof c.repos === "object" ? c : null;
  } catch {
    return null;
  }
}

function writeCache(registry) {
  try {
    mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ ...registry, fetchedAt: new Date().toISOString() })
    );
  } catch {
    // cache is an optimization; a read-only home just means we re-fetch
  }
}

/** Cached registry, refreshed past the TTL. A failed refresh keeps serving
 *  the stale copy — an offline member should not silently stop reporting. */
export async function loadRegistry({ url, token, timeoutMs = TIMEOUT_MS } = {}) {
  const cached = readCache();
  const fresh =
    cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS;
  if (fresh) return cached;
  if (!url || !token) return cached;

  const { signal, done } = budget(timeoutMs);
  try {
    const res = await fetch(`${url}/api/cc/registry`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return cached;
    const body = await res.json();
    if (!body || typeof body.repos !== "object") return cached;
    const registry = {
      repos: body.repos,
      projects: Array.isArray(body.projects) ? body.projects : [],
    };
    writeCache(registry);
    return registry;
  } catch {
    return cached;
  } finally {
    done();
  }
}

/**
 * Resolve the repo at `cwd`.
 *
 * → { gitRoot, repo, branch, studio, project, source }
 *   source: "marker" | "registry" | null
 */
export async function resolveRepo({ cwd, url, token } = {}) {
  const base = {
    gitRoot: null,
    repo: undefined,
    branch: undefined,
    studio: false,
    project: undefined,
    source: null,
  };

  const gitRoot = git(cwd, "rev-parse --show-toplevel");
  if (!gitRoot) return base; // not a git repo → personal by definition

  const repo = path.basename(gitRoot);
  const ctx = {
    ...base,
    gitRoot,
    repo,
    branch: git(cwd, "rev-parse --abbrev-ref HEAD") || undefined,
  };

  const marker = readMarker(gitRoot);
  if (marker) {
    // An explicit opt-out is the one thing the registry must not override.
    if (marker.enabled === false) return ctx;
    if (typeof marker.project === "string" && marker.project.trim()) {
      return { ...ctx, studio: true, project: marker.project, source: "marker" };
    }
    // Marker present but says nothing about the project — opted in, let the
    // registry name it.
    const registry = await loadRegistry({ url, token });
    return {
      ...ctx,
      studio: true,
      project: registry?.repos?.[normalizeKey(repo)],
      source: "marker",
    };
  }

  const registry = await loadRegistry({ url, token });
  const project = registry?.repos?.[normalizeKey(repo)];
  if (!project) return ctx; // unknown repo → personal → no traffic
  return { ...ctx, studio: true, project, source: "registry" };
}

/** Write the marker for `project` at the git root. Used by link_repo so the
 *  member never hand-authors JSON; committing it opts the repo in for
 *  everyone, including anyone on an older plugin build. */
export function writeMarker(gitRoot, project) {
  const file = markerPath(gitRoot);
  writeFileSync(file, `${JSON.stringify({ project }, null, 2)}\n`);
  return file;
}
