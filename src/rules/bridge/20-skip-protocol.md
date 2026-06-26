# Skip Protocol

For inbound-event bridge reports (`webhook-handler`, `scheduler-task`):
if Lead has nothing actionable to relay
(label-only, duplicate/dedup, no action needed, nothing to report),
prefix the whole response with:

```
[meta:silent]
```

