//! The four system blocks of a session, as header fields, and the request's system messages.
//!
//! Node keeps them as the leading `system` messages of `session.messages`, told apart by their
//! `cacheTier` and, for the two untiered ones, by position (`resolveDeferredBp2Index`:
//! the first is BP1, the second BP2). Here each block is one header field, present exactly when
//! Node's message exists (a present empty string is an empty message, as in Node).

use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::Role;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Map;
use serde_json::Value;

/// BP1: shared tool policy followed by the route's rules (`composeSystemPrompt.baseRules`).
pub const BASE_KEY: &str = "promptBase";
/// BP2: Lead meta, skill manifest and deferred-tool manifest (`stableSystemContext`).
pub const STABLE_KEY: &str = "promptStable";
/// BP3 core, the `tier3` message (`sessionMarkerCore`). The 1.4.5 header key of the same text.
pub const CORE_KEY: &str = "bp3CoreContext";
/// The volatile `env` message: the `# Session` block and the environment tail.
pub const ENV_KEY: &str = "promptEnv";
/// The `tier3` message of a session without `bp3EnvSplit` (Node's legacy combined layout). There
/// `bp3CoreContext` is only the core and the message is core + `# Session` block + environment
/// (`refreshSessionBp3Environment`, `prompt-utils.mjs:176-186`), so it needs a field of its own.
pub const TIER3_KEY: &str = "promptTier3";

/// Node's system messages in request order; `None` is a message that does not exist.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SystemBlocks {
    pub base: Option<String>,
    pub stable: Option<String>,
    /// The `tier3` message.
    pub core: Option<String>,
    pub env: Option<String>,
    /// The session lacks `bp3EnvSplit: true`: Node keeps one combined `tier3` message and no `env`
    /// message for its whole life, and so does Rust.
    pub combined: bool,
}

/// A `messages` array that is not a system prefix of the shape Node writes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ShapeError {
    #[error("message {0} is not a system message")]
    NotSystem(usize),
    #[error("system message {0} has no string content")]
    NotText(usize),
    #[error("system message {0} has an unknown cacheTier")]
    UnknownTier(usize),
    #[error("system message {0} is out of order or repeated")]
    Misplaced(usize),
}

fn slot<'a>(header: &'a Header, key: &str) -> Option<&'a str> {
    header.get(key).and_then(Value::as_str)
}

impl SystemBlocks {
    pub fn from_header(header: &Header) -> Self {
        let own = |key| slot(header, key).map(str::to_owned);
        let combined = header.get("bp3EnvSplit") != Some(&Value::Bool(true));
        let core = if combined { TIER3_KEY } else { CORE_KEY };
        Self { base: own(BASE_KEY), stable: own(STABLE_KEY), core: own(core), env: own(ENV_KEY), combined }
    }

    fn slots(&self) -> [(&'static str, Option<&str>); 4] {
        [
            (BASE_KEY, self.base.as_deref()),
            (STABLE_KEY, self.stable.as_deref()),
            (if self.combined { TIER3_KEY } else { CORE_KEY }, self.core.as_deref()),
            (ENV_KEY, self.env.as_deref()),
        ]
    }

    /// Writes the blocks into `header`: a present block is set, an absent one removed.
    pub fn write(&self, header: &mut Header) {
        for (key, text) in self.slots() {
            match text {
                Some(text) => {
                    header.insert(key.to_owned(), Value::String(text.to_owned()));
                }
                None => {
                    header.shift_remove(key);
                }
            }
        }
    }

    /// The header change that turns the blocks `previous` into these (one `thread/header/patch`).
    pub fn change_from(&self, previous: &Self) -> HeaderChange {
        let mut change = HeaderChange { set: Map::new(), unset: Vec::new() };
        for ((key, text), (_, before)) in self.slots().into_iter().zip(previous.slots()) {
            if text == before {
                continue;
            }
            match text {
                Some(text) => {
                    change.set.insert(key.to_owned(), Value::String(text.to_owned()));
                }
                None => change.unset.push(key.to_owned()),
            }
        }
        change
    }

    /// The request's system messages, in Node's order with Node's cache tiers.
    pub fn messages(&self) -> Vec<Message> {
        let tiers = [None, None, Some(CacheTier::Tier3), Some(CacheTier::Env)];
        self.slots()
            .into_iter()
            .zip(tiers)
            .filter_map(|((_, text), tier)| {
                let mut message = Message::new(Role::System, Content::Text(text?.to_owned()));
                message.cache_tier = tier;
                Some(message)
            })
            .collect()
    }

    /// Node's message objects (`{role, content, cacheTier?}`): the shape the `run_host` rewriters
    /// (`deferred_manifest`, `rules::refresh_rule_variants`) take as `session["messages"]`.
    pub fn node_messages(&self) -> Vec<Value> {
        let tiers = [None, None, Some("tier3"), Some("env")];
        self.slots()
            .into_iter()
            .zip(tiers)
            .filter_map(|((_, text), tier)| {
                let mut message = Map::new();
                message.insert("role".to_owned(), Value::String("system".to_owned()));
                message.insert("content".to_owned(), Value::String(text?.to_owned()));
                if let Some(tier) = tier {
                    message.insert("cacheTier".to_owned(), Value::String(tier.to_owned()));
                }
                Some(Value::Object(message))
            })
            .collect()
    }

    /// The blocks of a system prefix as Node writes it: untiered messages first (the first is
    /// BP1, the second BP2, as `resolveDeferredBp2Index` reads them), then `tier3`, then `env`.
    /// Anything else is an error, never a guess.
    pub fn from_node_messages(messages: &[Value]) -> Result<Self, ShapeError> {
        let mut blocks = Self::default();
        // The first slot the next message may take.
        let mut next = 0usize;
        for (at, message) in messages.iter().enumerate() {
            if message.get("role").and_then(Value::as_str) != Some("system") {
                return Err(ShapeError::NotSystem(at));
            }
            let text = message.get("content").and_then(Value::as_str).ok_or(ShapeError::NotText(at))?.to_owned();
            let slot = match message.get("cacheTier") {
                None | Some(Value::Null) => next,
                Some(Value::String(tier)) if tier.is_empty() => next,
                Some(Value::String(tier)) if tier == "tier3" => 2,
                Some(Value::String(tier)) if tier == "env" => 3,
                Some(_) => return Err(ShapeError::UnknownTier(at)),
            };
            let tiered = message.get("cacheTier").is_some_and(|t| !t.is_null() && t.as_str() != Some(""));
            if slot < next || slot > 3 || (!tiered && slot > 1) {
                return Err(ShapeError::Misplaced(at));
            }
            match slot {
                0 => blocks.base = Some(text),
                1 => blocks.stable = Some(text),
                2 => blocks.core = Some(text),
                _ => blocks.env = Some(text),
            }
            next = slot + 1;
        }
        Ok(blocks)
    }
}

/// A request's system messages, from the session header: the one function every provider
/// request reads them through (Node: the leading `system` messages of `session.messages`).
pub fn request_system_messages(header: &Header) -> Vec<Message> {
    SystemBlocks::from_header(header).messages()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn header(value: Value) -> Header {
        value.as_object().expect("object").clone()
    }

    #[test]
    fn the_request_is_the_present_blocks_in_nodes_order_with_nodes_tiers() {
        let h = header(json!({"bp3EnvSplit": true, "promptBase": "rules", "bp3CoreContext": "core", "promptEnv": "env", "other": 1}));
        let tiers: Vec<(Role, Option<CacheTier>, Content)> =
            request_system_messages(&h).into_iter().map(|m| (m.role, m.cache_tier, m.content)).collect();
        assert_eq!(
            tiers,
            vec![
                (Role::System, None, Content::Text("rules".into())),
                (Role::System, Some(CacheTier::Tier3), Content::Text("core".into())),
                (Role::System, Some(CacheTier::Env), Content::Text("env".into())),
            ]
        );
        assert!(request_system_messages(&header(json!({}))).is_empty());
        // A present empty string is an empty message, as in Node.
        assert_eq!(request_system_messages(&header(json!({"promptStable": ""}))).len(), 1);
    }

    #[test]
    fn a_session_without_the_split_flag_sends_its_one_combined_tier3_message_unchanged() {
        // `bp3CoreContext` is only the core there; the message text is `promptTier3`.
        let h = header(json!({"promptBase": "rules", "bp3CoreContext": "core", "promptTier3": "core\n\n---\n\n# Session\nCwd: x"}));
        let sent = request_system_messages(&h);
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1].cache_tier, Some(CacheTier::Tier3));
        assert_eq!(sent[1].content, Content::Text("core\n\n---\n\n# Session\nCwd: x".into()));
        let blocks = SystemBlocks::from_header(&h);
        let mut next = blocks.clone();
        next.core = Some("new".into());
        let change = next.change_from(&blocks);
        assert_eq!(Value::Object(change.set), json!({"promptTier3": "new"}));
        let mut written = h.clone();
        next.write(&mut written);
        assert_eq!(written["bp3CoreContext"], "core");
    }

    #[test]
    fn node_messages_round_trip_and_the_untiered_ones_are_read_by_position() {
        let full = SystemBlocks { base: Some("a".into()), stable: Some("b".into()), core: Some("c".into()), env: Some("d".into()), combined: false };
        let nodes = full.node_messages();
        assert_eq!(nodes[2], json!({"role": "system", "content": "c", "cacheTier": "tier3"}));
        assert_eq!(SystemBlocks::from_node_messages(&nodes), Ok(full));
        // A lone untiered message is the first slot, as Node's `systemIndexes[0]` reads it.
        let lone = vec![json!({"role": "system", "content": "x"}), json!({"role": "system", "content": "c", "cacheTier": "tier3"})];
        assert_eq!(SystemBlocks::from_node_messages(&lone).unwrap().base.as_deref(), Some("x"));
        let order = vec![json!({"role": "system", "content": "c", "cacheTier": "tier3"}), json!({"role": "system", "content": "x"})];
        assert_eq!(SystemBlocks::from_node_messages(&order), Err(ShapeError::Misplaced(1)));
        let user = vec![json!({"role": "user", "content": "x"})];
        assert_eq!(SystemBlocks::from_node_messages(&user), Err(ShapeError::NotSystem(0)));
    }

    #[test]
    fn a_change_carries_only_the_blocks_that_differ() {
        let before = SystemBlocks { base: Some("a".into()), core: Some("c".into()), env: Some("e".into()), ..Default::default() };
        let after = SystemBlocks { base: Some("a".into()), core: None, env: Some("e2".into()), ..Default::default() };
        let change = after.change_from(&before);
        assert_eq!(Value::Object(change.set), json!({"promptEnv": "e2"}));
        assert_eq!(change.unset, ["bp3CoreContext"]);
        let mut h = header(json!({"promptBase": "a", "bp3CoreContext": "c", "promptEnv": "e", "x": 1}));
        after.write(&mut h);
        assert_eq!(Value::Object(h), json!({"promptBase": "a", "promptEnv": "e2", "x": 1}));
    }
}
