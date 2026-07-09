# Skip Protocol

For inbound-event reports (`webhook-handler`, `scheduler-task`) with nothing
actionable to relay (label-only, duplicate/dedup, no action needed/report),
prefix the whole response with `[meta:silent]`.
