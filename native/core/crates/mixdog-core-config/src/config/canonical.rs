//! `canonicalizeUnifiedConfig` (`runtime/shared/config.mjs`): the shape Node's config reads
//! serve and its saves write. Retired keys from old installs are dropped, not folded in, so no
//! reader of the document (the agent section among them) meets one: [`read_file`] applies it to
//! every document read, and every save applies it before the document is written and installed.
//!
//! [`read_file`]: super::read_file

use serde_json::Value;

use super::Doc;

/// The document a read or a save settles on.
pub(super) fn canonicalize(mut next: Doc) -> Doc {
    let had_agent = next.get("agent").is_some_and(Value::is_object);
    let mut agent = next.get("agent").and_then(Value::as_object).cloned().unwrap_or_default();

    agent.shift_remove("outputStyle");
    for key in ["autoClear", "compaction", "shell", "mcpServers"] {
        next.shift_remove(key);
    }
    agent.shift_remove("search");
    agent.shift_remove("capabilities");

    let mut modules = agent.get("modules").and_then(Value::as_object).cloned().unwrap_or_default();
    if modules.contains_key("memory") {
        modules.shift_remove("memory");
        agent.insert("modules".into(), Value::Object(modules));
    }

    if let Some(memory) = next.get("memory").and_then(Value::as_object) {
        let mut memory = memory.clone();
        let mut user = memory.get("user").and_then(Value::as_object).cloned().unwrap_or_default();
        user.shift_remove("title");
        if user.is_empty() {
            memory.shift_remove("user");
        } else {
            memory.insert("user".into(), Value::Object(user));
        }
        memory.shift_remove("enabled");
        if memory.is_empty() {
            next.shift_remove("memory");
        } else {
            next.insert("memory".into(), Value::Object(memory));
        }
    }

    // `canonicalizeStoredChannelsConfig`: schedules live in the scheduler store and prompt
    // injection moved to runtime hooks.
    if let Some(channels) = next.get("channels").and_then(Value::as_object) {
        let mut channels = channels.clone();
        channels.shift_remove("promptInjection");
        channels.shift_remove("schedules");
        next.insert("channels".into(), Value::Object(channels));
    }

    next.shift_remove("search");
    next.shift_remove("capabilities");
    if had_agent || !agent.is_empty() {
        next.insert("agent".into(), Value::Object(agent));
    }
    next
}

#[cfg(test)]
#[path = "canonical_tests.rs"]
mod tests;
