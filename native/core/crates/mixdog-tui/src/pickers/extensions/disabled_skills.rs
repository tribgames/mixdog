//! Which Skills the user has turned off (`src/tui/app/use-disabled-skills.mjs`).
//!
//! The set is read once when the application starts and written back through the store on every change, so the Skills picker
//! edits one authority instead of a local copy.

use serde_json::{Value, json};

use super::panel::ExtensionsHost;
use crate::slash::host::Tone;
use crate::slash::notices::value_text;

/// An insertion-ordered set of skill names (a JavaScript `Set` of strings: the order is what the store is written with).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SkillSet(Vec<String>);

impl SkillSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn contains(&self, name: &str) -> bool {
        self.0.iter().any(|entry| entry == name)
    }

    pub fn insert(&mut self, name: &str) {
        if !self.contains(name) {
            self.0.push(name.to_owned());
        }
    }

    pub fn remove(&mut self, name: &str) {
        self.0.retain(|entry| entry != name);
    }

    pub fn names(&self) -> &[String] {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl FromIterator<String> for SkillSet {
    fn from_iter<T: IntoIterator<Item = String>>(names: T) -> Self {
        let mut set = SkillSet::new();
        for name in names {
            set.insert(&name);
        }
        set
    }
}

/// The set read at start: `store.getDisabledSkills()` answers `{ disabled: [...] }`. A non-empty list replaces the (empty)
/// held set; a failed probe or a missing method leaves every skill enabled.
pub fn load_disabled_skills(host: &mut dyn ExtensionsHost) {
    let Ok(result) = host.store_call("getDisabledSkills", json!([])) else { return };
    let disabled: SkillSet = result.get("disabled").and_then(Value::as_array).map(|names| names.iter().map(value_text).collect()).unwrap_or_default();
    if !disabled.is_empty() {
        host.hold_disabled_skills(disabled);
    }
}

/// `setDisabledSkills(next)`: holds `next` and persists it through the store; a failed write is reported.
pub fn set_disabled_skills(host: &mut dyn ExtensionsHost, next: SkillSet) {
    host.hold_disabled_skills(next.clone());
    if let Err(error) = host.store_call("setDisabledSkills", json!([next.names()])) {
        host.push_notice(&format!("skill disable persist failed: {error}"), Tone::Error);
    }
}
