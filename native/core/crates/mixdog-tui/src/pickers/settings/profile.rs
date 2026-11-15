//! The Profile panel (`maintenance-pickers/profile-picker.mjs`): title, development experience and response language, cycled
//! with the arrows and written through the daemon before the panel rebuilds.

use mixdog_js::js_trim;
use mixdog_tui_widgets::picker::{IndexMode, PickerItem};
use serde_json::{Value, json};

use super::host::{Own, PickerHost};
use super::panel::Panel;
use super::rows::{member, text_of};
use super::{PickerController, cycled_index, open_panel, report};
use crate::slash::host::{Opener, PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{first_truthy_text, truthy};

/// The profile read, normalized for the panel: the option lists with their built-in fallbacks and the selected entries.
struct ProfileView {
    languages: Vec<Value>,
    current_language_id: String,
    experience_levels: Vec<Value>,
    current_experience_id: String,
    title: String,
}

fn entries(profile: &Value, key: &str, fallback: Value) -> Vec<Value> {
    match member(profile, key).as_array() {
        Some(list) if !list.is_empty() => list.clone(),
        _ => fallback.as_array().cloned().unwrap_or_default(),
    }
}

impl ProfileView {
    fn read(profile: &Value) -> Self {
        let id = |key: &str, fallback: &str| first_truthy_text(profile, &[key]).unwrap_or_else(|| fallback.to_owned());
        Self {
            languages: entries(profile, "languages", json!([{"id": "system", "label": "System (locale)"}])),
            current_language_id: id("language", "system"),
            experience_levels: entries(
                profile,
                "experienceLevels",
                json!([
                    {"id": "beginner", "label": "Beginner"},
                    {"id": "vibe-coder", "label": "Vibe coder"},
                    {"id": "junior", "label": "Junior"},
                    {"id": "expert", "label": "Expert"},
                ]),
            ),
            current_experience_id: id("experienceLevel", ""),
            title: js_trim(&text_of(member(profile, "title"))).to_owned(),
        }
    }

    fn language_index(&self) -> Option<usize> {
        self.languages.iter().position(|language| text_of(member(language, "id")) == self.current_language_id)
    }

    fn experience_index(&self) -> Option<usize> {
        self.experience_levels.iter().position(|level| text_of(member(level, "id")) == self.current_experience_id)
    }
}

/// The Profile panel on screen: its claim and the options its rows were built from.
pub struct ProfilePicker {
    own: Own,
    return_to: bool,
    view: ProfileView,
    panel: Panel,
}

/// `openProfilePicker(options)`: `{ returnTo }`. `None` when Esc came before the first paint.
pub fn open_profile_picker(host: &mut dyn PickerHost, options: &Value) -> Option<ProfilePicker> {
    // The profile read is a daemon call, so Esc can land before the first paint.
    let mut own = Own::take(host);
    let profile = host.store_call("getProfile", json!([])).ok().filter(truthy).unwrap_or(Value::Null);
    let view = ProfileView::read(&profile);
    if !own.owns(host) {
        return None;
    }
    host.set_prompt(PromptSurface::Provider, None);
    host.set_prompt(PromptSurface::Settings, None);
    own.clear_context(host);
    host.close_usage_panel();
    let mut title = PickerItem::new("title", "Title");
    title.meta = if view.title.is_empty() { "(not set)".to_owned() } else { view.title.clone() };
    title.description = "Preferred form of address. Enter to edit.".to_owned();
    let mut experience = PickerItem::new("experience-level", "Experience");
    experience.meta = view
        .experience_index()
        .and_then(|at| first_truthy_text(&view.experience_levels[at], &["label"]))
        .unwrap_or_else(|| "(not set)".to_owned());
    experience.description = "Development experience. \u{2190}/\u{2192} to change, Enter to cycle.".to_owned();
    let mut language = PickerItem::new("language", "Language");
    let shown = view.language_index().unwrap_or(0);
    language.meta = view
        .languages
        .get(shown)
        .and_then(|entry| first_truthy_text(entry, &["label"]))
        .unwrap_or_else(|| "System (locale)".to_owned());
    language.description = "Response language. \u{2190}/\u{2192} to change, Enter to cycle.".to_owned();
    let panel = Panel {
        title: "Profile".to_owned(),
        description: "How the assistant addresses you, adapts terminology, and chooses its response language.".to_owned(),
        help: Some("\u{2191}/\u{2193} Select \u{b7} \u{2190}/\u{2192} Change \u{b7} Enter Edit \u{b7} Esc Close".to_owned()),
        index_mode: Some(IndexMode::Always),
        label_width: Some(12),
        meta_width: Some(20),
        items: vec![title, experience, language],
        ..Panel::default()
    };
    own.paint(host, &panel);
    Some(ProfilePicker { own, return_to: truthy(member(options, "returnTo")), view, panel })
}

impl ProfilePicker {
    /// `setProfile` is a daemon write: the panel is rebuilt only after it settles, so the row cannot show a value the daemon
    /// rejected. The rebuild is bound to the claim when the cycle keypress starts: a `setProfile` that acks after Esc must not
    /// re-open the Profile panel.
    fn write(&mut self, host: &mut dyn PickerHost, patch: Value, notice: &str) {
        let reopen = self.own.defer();
        match host.store_call("setProfile", json!([patch])) {
            Ok(_) => host.push_notice(notice, Tone::Info),
            Err(error) => report(host, "profile update failed", &error, Tone::Error),
        }
        if self.own.holds(host, reopen) {
            let returning = if self.return_to { json!("settings") } else { Value::Null };
            open_panel(host, Opener::Profile, json!({"returnTo": returning}));
        }
    }

    fn cycle_language(&mut self, host: &mut dyn PickerHost, direction: i64) {
        let next = self.view.languages[cycled_index(self.view.languages.len(), Some(self.view.language_index().unwrap_or(0)), direction)].clone();
        let label = text_of(member(&next, "label"));
        self.write(host, json!({"language": member(&next, "id")}), &format!("Language set to {label}"));
    }

    fn cycle_experience(&mut self, host: &mut dyn PickerHost, direction: i64) {
        let levels = &self.view.experience_levels;
        // Nothing selected yet: the first step goes to the first entry, a step back to the last.
        let at = match self.view.experience_index() {
            Some(current) => cycled_index(levels.len(), Some(current), direction),
            None if direction < 0 => levels.len() - 1,
            None => 0,
        };
        let next = levels[at].clone();
        let label = text_of(member(&next, "label"));
        self.write(host, json!({"experienceLevel": member(&next, "id")}), &format!("Experience level set to {label}"));
    }
}

impl PickerController for ProfilePicker {
    fn panel(&self) -> &Panel {
        &self.panel
    }

    fn left(&mut self, host: &mut dyn PickerHost, value: &str) {
        match value {
            "language" => self.cycle_language(host, -1),
            "experience-level" => self.cycle_experience(host, -1),
            _ => {}
        }
    }

    fn right(&mut self, host: &mut dyn PickerHost, value: &str) {
        match value {
            "language" => self.cycle_language(host, 1),
            "experience-level" => self.cycle_experience(host, 1),
            _ => {}
        }
    }

    fn select(&mut self, host: &mut dyn PickerHost, value: &str) {
        match value {
            "title" => {
                self.own.close(host);
                let mut prompt = TextPrompt::new("profile-title");
                prompt.label = "Profile \u{b7} Title".to_owned();
                prompt.hint = "How should the assistant address you? Leave blank to clear.".to_owned();
                host.set_prompt(PromptSurface::Settings, Some(prompt));
            }
            "language" => self.cycle_language(host, 1),
            "experience-level" => self.cycle_experience(host, 1),
            _ => {}
        }
    }

    fn cancel(&mut self, host: &mut dyn PickerHost) {
        self.own.close(host);
        if self.return_to {
            open_panel(host, Opener::Settings, json!({}));
        }
    }
}
