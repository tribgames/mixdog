# Skip Protocol

For non-actionable inbound-event reports (`webhook-handler`, `scheduler-task`:
label-only, duplicate/dedup, no action needed/report), prefix the whole response
with `[meta:silent]`.
