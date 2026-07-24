# Prodigy — Claude Code plugin

Progress reporting as a side effect of working. Install the plugin, work in
an opted-in repo, and your sessions, one-line progress updates, and task
moves show up on the Prodigy dashboard automatically — no forms.

## Install

In Claude Code:

```
/plugin marketplace add stray-frame/prodigy-plugin
/plugin install prodigy@stray-frame
```

Restart when prompted, then connect your account: sign in at
`prodigy.strayframe.net/connect`, copy the setup prompt it gives you, and
paste it into Claude Code. That's it.

## Privacy model

- **Opt-in per project.** The plugin only reports in repos that contain a
  `.prodigy.json` marker at the git root. Repos without one never send
  anything — the check runs on your machine before any network call.
- **One sentence, nothing else.** Only short, commit-message-style summaries
  and basic metadata (repo name, branch, duration, project) leave your
  machine. Never code, never transcripts, never file contents. The API has
  no field that could carry them.

## What you get

- **Automatic session records** — start/end/duration, via session hooks.
- **Ambient progress** — when meaningful work lands, a one-line update posts
  and matching task cards move on the board.
- **/prodigy:standup** — today's plan and where to start.
- **/prodigy:wrap** — a one-line session summary and a leave-off note.

## Configuration

The dashboard URL is built in. The only setting is your personal API token,
which the connect flow sets for you. Advanced: set `PRODIGY_API_URL` in your
environment to point the plugin at a different dashboard instance.
