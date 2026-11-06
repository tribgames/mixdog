//! `react`: a bot's emoji reaction under the user's message. Only a bot's own chat with the user
//! may react (its home chat, or its seat in a group room); never a coding session, a delegated
//! worker, or a run nobody attends.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use serde_json::Value;

use crate::orch::util::JsStr;

use crate::orch::ports::CallerFacts;
use crate::orch::util::PortError;
use crate::orch::util::denied;
use crate::orch::util::invalid;
use crate::orch::util::spec_from_def;
use crate::orch::util::text;

pub const REACTION_EMOJI: [&str; 7] = ["❤️", "👍", "✔️", "😆", "😮", "😢", "🙏"];
const MESSAGES_BACK_MAX: u64 = 20;
const DONE: &str = "The user sees it under their message. Say nothing about it; reply only if the message also needs an answer.";

fn bare(value: &str) -> String {
    value.replace('\u{fe0f}', "")
}

/// The reaction `value` names (a missing or extra U+FE0F tolerated).
pub fn reaction_emoji(value: &str) -> Option<&'static str> {
    let wanted = bare(value.js_trim());
    (!wanted.is_empty())
        .then(|| REACTION_EMOJI.into_iter().find(|e| bare(e) == wanted))
        .flatten()
}

/// `(emoji or None to remove, messages_back)` of a react call.
pub fn validate(args: &Value) -> Result<(Option<&'static str>, u64), String> {
    let back = match args.get("messages_back") {
        None | Some(Value::Null) => 0,
        Some(v) => v
            .as_u64()
            .filter(|b| *b <= MESSAGES_BACK_MAX)
            .ok_or_else(|| format!("react: messages_back is a whole number from 0 to {MESSAGES_BACK_MAX}"))?,
    };
    if args.get("remove").and_then(Value::as_bool) == Some(true) {
        return Ok((None, back));
    }
    let emoji = args.get("emoji").and_then(Value::as_str).and_then(reaction_emoji);
    match emoji {
        Some(e) => Ok((Some(e), back)),
        None => Err(format!("react: emoji must be exactly one of {}", REACTION_EMOJI.join(" "))),
    }
}

/// Whose chat a thread is, when it is a bot's own.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReactSeat {
    pub agent_id: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ReactResult {
    pub changed: bool,
}

/// Reaction storage of the bot's chat or group room. `react` also records what the call hit so
/// the loop can mark the message; a `None` emoji removes the reaction.
#[async_trait]
pub trait Reactions: Send + Sync {
    /// The bot seat of the thread; `None` for a coding session or delegated worker.
    fn seat(&self, thread: &ThreadId) -> Option<ReactSeat>;

    async fn react(
        &self,
        thread: &ThreadId,
        call: &ToolCallId,
        seat: &ReactSeat,
        emoji: Option<&str>,
        messages_back: u64,
    ) -> Result<ReactResult, PortError>;
}

pub struct ReactTool {
    spec: ToolSpec,
    reactions: Arc<dyn Reactions>,
    facts: Arc<dyn CallerFacts>,
}

impl ReactTool {
    pub fn new(reactions: Arc<dyn Reactions>, facts: Arc<dyn CallerFacts>) -> Self {
        Self {
            spec: spec_from_def(include_str!("defs/react.json"), false, &[]),
            reactions,
            facts,
        }
    }
}

#[async_trait]
impl Tool for ReactTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let Some(seat) = self.reactions.seat(&ctx.thread_id) else {
            return Err(denied("react: reactions belong to a bot's own chat with the user"));
        };
        if self.facts.is_unattended(&ctx.thread_id).await {
            return Err(denied("react: nobody is in this run to see a reaction"));
        }
        let (emoji, back) = validate(&args).map_err(|m| invalid("emoji", m))?;
        let result = self.reactions.react(&ctx.thread_id, &ctx.call_id, &seat, emoji, back).await?;
        match emoji {
            None if result.changed => text("Removed your reaction."),
            None => text("You had no reaction on that message."),
            Some(e) => text(format!("Reacted {e}. {DONE}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn emoji_tolerates_variation_selector_and_rejects_others() {
        assert_eq!(validate(&json!({"emoji":"❤"})), Ok((Some("❤️"), 0)));
        assert_eq!(validate(&json!({"emoji":"👍","messages_back":2})), Ok((Some("👍"), 2)));
        assert_eq!(validate(&json!({"remove":true})), Ok((None, 0)));
        assert!(validate(&json!({"emoji":"🔥"})).unwrap_err().starts_with("react: emoji must be exactly one of"));
        assert_eq!(
            validate(&json!({"emoji":"👍","messages_back":21})).unwrap_err(),
            "react: messages_back is a whole number from 0 to 20"
        );
    }
}
