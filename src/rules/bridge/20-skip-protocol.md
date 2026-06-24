# Skip Protocol

For inbound-event bridge reports (`webhook-handler`, `scheduler-task`):
if Lead has nothing actionable to relay
(label-only, duplicate/dedup, no action needed, nothing to report),
prefix the whole response with:

```
[meta:silent]
```

Optionally add one short reason for Discord/debug logs.

Effect: Lead injection is suppressed, but Discord still receives the
body for audit.

Do not use for actionable findings, decisions, summaries, or short-but-
useful reports. True skips only.
