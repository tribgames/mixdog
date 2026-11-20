//! Mid-conversation effort updates against the Node recording
//! (`providers/anthropic-effort/cases.json`, recorded by
//! `benchmarks/rust-core/recorders/record-anthropic-effort.mjs` from Node's
//! own request builders): the gate decision, the lowered messages with their
//! control messages, and the beta.

use super::effort_updates::model_key;

#[test]
fn model_keys_drop_dates_and_dots() {
    assert_eq!(model_key(" Claude-Sonnet-5.5 "), "claude-sonnet-5-5");
    assert_eq!(model_key("claude-sonnet-5-5-20260101"), "claude-sonnet-5-5");
    assert_eq!(model_key("claude-sonnet-5-5-2026-01-01"), "claude-sonnet-5-5");
}
