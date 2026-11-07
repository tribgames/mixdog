//! Production implementations of the `DomainSeams` inputs of `compose_domains`.

pub mod agent_effects;
pub mod automation_setup;
pub mod caches;
pub mod channel_stack;
pub mod doctor;
pub mod feature_effects;
pub mod git;
pub mod hook_status;
pub mod media_status;
pub mod notification_clicks;
pub mod office_fonts;
pub mod plugin_announce;
pub mod profile_changes;
pub mod remote;
pub mod settings_effects;

/// The recorded Node goldens of the seams (`record-domain-seams.mjs`).
#[cfg(test)]
pub(crate) fn golden() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../../fixtures/domain-seams/golden.json")).expect("the golden is JSON")
}

/// `value` with the scenario folder `root` written `<root>` and backslashes `/` (the recorder's
/// one normalization), so the golden reads the same on every OS.
#[cfg(test)]
pub(crate) fn portable(value: &serde_json::Value, root: &std::path::Path) -> serde_json::Value {
    use serde_json::Value;
    let shown = root.to_string_lossy();
    let swap = |text: &str| text.replace(shown.as_ref(), "<root>").replace(shown.replace('\\', "/").as_str(), "<root>").replace('\\', "/");
    match value {
        Value::String(text) => Value::String(swap(text)),
        Value::Array(items) => Value::Array(items.iter().map(|item| portable(item, root)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (swap(key), portable(item, root))).collect()),
        other => other.clone(),
    }
}
