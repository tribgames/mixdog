//! The live decode speed of the model call streaming now (`spinner.liveCall`), as `turn-live-call.mjs` (b6f10295a) keeps it:
//! the runtime's token estimate of the text and reasoning streamed so far, from the call's first visible token, published at
//! most every [`PUBLISH_MS`] with its own sample time. A tool call withdraws it until the next call; the call's usage ends it.

use mixdog_js::token_estimate::estimate_tokens;
use serde_json::Value;
use serde_json::json;

/// `LIVE_CALL_PUBLISH_MS`.
pub(crate) const PUBLISH_MS: i64 = 250;

struct Call {
    started_at: i64,
    text: String,
    published_at: i64,
}

#[derive(Default)]
pub(crate) struct LiveCall {
    withdrawn: bool,
    call: Option<Call>,
    /// A figure is on the spinner (Node reads `spinner.liveCall`).
    shown: bool,
}

impl LiveCall {
    /// `noteLiveCallText`: the figure to publish, when this chunk is due one.
    pub(crate) fn text(&mut self, chunk: &str, now: i64) -> Option<Value> {
        if chunk.is_empty() || self.withdrawn {
            return None;
        }
        let call = self.call.get_or_insert_with(|| Call { started_at: now, text: String::new(), published_at: 0 });
        call.text.push_str(chunk);
        if call.published_at != 0 && now - call.published_at < PUBLISH_MS {
            return None;
        }
        call.published_at = now;
        self.shown = true;
        Some(json!({ "startedAt": call.started_at, "outputTokens": estimate_tokens(&call.text), "at": now }))
    }

    /// `endLiveCall`: whether a figure was shown, so `null` is published.
    pub(crate) fn end(&mut self) -> bool {
        let had = self.call.is_some() || self.shown;
        self.call = None;
        self.shown = false;
        had
    }

    /// `withdrawLiveCall`.
    pub(crate) fn withdraw(&mut self) -> bool {
        self.withdrawn = true;
        self.end()
    }

    /// `startNextLiveCall`.
    pub(crate) fn next(&mut self) -> bool {
        self.withdrawn = false;
        self.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// turn-live-call.test.mjs: one sample per window, a tool call withdraws the figure until the next call.
    #[test]
    fn figures_are_sampled_and_withdrawn_as_node_samples_them() {
        let mut live = LiveCall::default();
        assert_eq!(live.text("Hello ", 1000), Some(json!({ "startedAt": 1000, "outputTokens": estimate_tokens("Hello "), "at": 1000 })));
        assert_eq!(live.text("there, ", 1000 + PUBLISH_MS - 1), None);
        assert_eq!(live.text("friend.", 1000 + PUBLISH_MS).map(|v| v["outputTokens"].clone()), Some(json!(estimate_tokens("Hello there, friend."))));
        assert!(live.withdraw());
        assert_eq!(live.text("late text", 5000), None);
        assert!(!live.next());
        assert_eq!(live.text("next", 6000).map(|v| v["startedAt"].clone()), Some(json!(6000)));
        assert!(live.next());
        assert!(!live.next());
    }
}
