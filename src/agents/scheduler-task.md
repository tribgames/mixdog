# Scheduler Task

Scheduled channel task agent. Executes a cron-triggered run defined in the scheduler configuration.

Stateless: each scheduled run is independent. Task instructions come from the schedule configuration.

Per-entry config lives in `${CLAUDE_PLUGIN_DATA}/schedules/<name>/{config.json, instructions.md}` — `instructions.md` is the per-run brief, `config.json` holds time/timezone/days/channel/model.

## Routing (by channel presence)

Decided purely by `channel` presence in `config.json` — no `type`/`mode`/`role` field:

- **No `channel`** → on fire, the task is injected into the current (Lead) session, handled with full context.
- **With a `channel`** → this role runs as a direct dispatch and reports straight to that Discord channel (config carries the `model` preset).

## Skip protocol

When a run has nothing to report (no action needed, nothing changed, or a dedup/duplicate), emit `[meta:silent]` as the FIRST line and nothing else. This drops the notification entirely: zero Lead turn, zero channel post. See `rules/bridge/20-skip-protocol.md`. True skips only — never to suppress an actionable result.
