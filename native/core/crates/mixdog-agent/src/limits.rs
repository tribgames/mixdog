//! A turn's caps: tool calls, a wrap-up time and tool-calling rounds. A call
//! past a cap, or one made after the wrap-up time, is answered without
//! running. Once a cap is reached the model is told once to reply, and every
//! later request of the turn forbids tool use. A response that still calls
//! tools after that ends the turn with no reply.

use crate::message::AgentMessage;
use crate::message::Source;
use crate::message::ToolKind;

const NOTICE: &str = "[mixdog-runtime] This turn has reached its tool-call or time limit: no further tool call runs. Reply now with your final answer from what you already have.";
const REFUSAL: &str = "[turn-limit] This turn has reached its tool-call or time limit; this call was not run. Reply now without tools.";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct TurnLimits {
    pub max_tool_calls: Option<u64>,
    /// Epoch milliseconds.
    pub wrap_up_at_ms: Option<i64>,
    pub max_tool_rounds: Option<u64>,
}

/// How many calls of the next batch may run.
pub fn calls_allowed(
    limits: Option<&TurnLimits>,
    noticed: bool,
    tool_calls_total: u64,
    now_ms: i64,
) -> u64 {
    let Some(limits) = limits else {
        return u64::MAX;
    };
    if noticed || limits.wrap_up_at_ms.is_some_and(|at| now_ms >= at) {
        return 0;
    }
    match limits.max_tool_calls {
        Some(max) => max.saturating_sub(tool_calls_total),
        None => u64::MAX,
    }
}

/// The answer to a call a cap kept from running.
pub fn refusal(call_id: &str) -> AgentMessage {
    AgentMessage::tool_text(call_id, REFUSAL, ToolKind::Error)
}

/// After a tool batch, once a cap is reached: the one-time notice. `None`
/// while the turn is within its caps.
pub fn notice_if_reached(
    limits: Option<&TurnLimits>,
    tool_calls_total: u64,
    iterations: u64,
    now_ms: i64,
) -> Option<AgentMessage> {
    let limits = limits?;
    let within_calls = limits.max_tool_calls.is_none_or(|max| tool_calls_total < max);
    let within_time = limits.wrap_up_at_ms.is_none_or(|at| now_ms < at);
    let within_rounds = limits.max_tool_rounds.is_none_or(|max| iterations < max);
    if within_calls && within_time && within_rounds {
        return None;
    }
    Some(AgentMessage::sourced(Source::TurnLimit, NOTICE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_answer_calls_unrun_and_notice_once_reached() {
        let limits = TurnLimits {
            max_tool_calls: Some(3),
            ..TurnLimits::default()
        };
        assert_eq!(calls_allowed(Some(&limits), false, 1, 0), 2);
        assert_eq!(calls_allowed(Some(&limits), true, 1, 0), 0);
        assert_eq!(calls_allowed(None, false, 9, 0), u64::MAX);
        assert!(notice_if_reached(Some(&limits), 2, 1, 0).is_none());
        let notice = notice_if_reached(Some(&limits), 3, 1, 0).unwrap();
        assert_eq!(notice.source, Some(Source::TurnLimit));
        let timed = TurnLimits {
            wrap_up_at_ms: Some(10),
            ..TurnLimits::default()
        };
        assert_eq!(calls_allowed(Some(&timed), false, 0, 10), 0);
    }
}
