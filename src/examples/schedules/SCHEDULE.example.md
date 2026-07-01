---
time: 0 9 * * *
timezone: Asia/Seoul
days: weekdays
channel: main
model: gpt-5
enabled: true
---

# Schedule instructions (prompt body)

This whole markdown body is the prompt the scheduler runs when the cron fires.
Everything above the second `---` is frontmatter metadata; everything below is
the instructions.

Frontmatter keys:

- `time` — required. 5- or 6-field cron expression (e.g. `0 9 * * *`).
- `timezone` — optional IANA tz (e.g. `Asia/Seoul`); host-local when omitted.
- `days` — optional; omit for `daily`. Written only when not `daily`.
- `channel` — optional channel label. WITH a channel the run dispatches to that
  channel (non-interactive) and REQUIRES `model`; WITHOUT it the run injects
  into the current session (interactive).
- `model` — required when `channel` is set; the preset id used for dispatch.
- `enabled` — optional; written `false` to disable. Missing/anything-else means
  enabled. The reader casts this string to a boolean.

Storage layout: `<data>/schedules/<name>/SCHEDULE.md` — one file per schedule.
This `.example.md` is documentation only; the readers match `SCHEDULE.md`
exactly, so this file is never loaded as a real schedule.
