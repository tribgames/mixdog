//! The Skills lists and the per-skill panel (`extension-pickers/skills-pickers.mjs` and `skills-pickers/{skill-items,
//! project-skills,skill-detail}.mjs`): the enable and disable toggles, the read-only project-skills list and the panel that
//! enables, disables or writes a request that runs one skill.
//!
//! Every row shows the state the core gives the status row (`state`, `hiddenBy`, `offBy`); nothing here works one out. A
//! switch is the core's `setSkillEnabled` of the row's `<source>:<name>` key, which switches that source's skill only, and
//! the list is read again after it.

use mixdog_js::value_to_string;
use serde_json::{Value, json};

use super::Extensions;
use super::disabled_skills::set_skill_enabled;
use super::panel::{
    Action, ExtItem, ExtPanel, ExtensionsHost, Handler, MarkerTone, claim, close_now, or_text, read_status, read_status_with, status_list, with_scope,
};
use crate::slash::host::{PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{truthy, value_text};

/// The options of `openSkillsPicker`.
#[derive(Clone, Debug, Default)]
pub struct SkillsOptions {
    /// The row to highlight.
    pub highlight: Option<String>,
    /// The skills already fetched.
    pub skills: Option<Vec<Value>>,
}

fn skill_description(skill: &Value) -> String {
    let detail = match skill.get("description").filter(|value| truthy(value)) {
        Some(description) => value_text(description),
        None => or_text(skill, "filePath", ""),
    };
    format!("{} \u{b7} {detail}", or_text(skill, "source", "skill"))
}

fn empty_item(label: &str) -> ExtItem {
    ExtItem::new("empty", label, "no project skills available", Action::Noop)
}

/// The disabled-list entry of a row (`<source>:<name>`); a core without source keys answers the bare name.
fn row_key(skill: &Value) -> String {
    Some(or_text(skill, "key", "")).filter(|key| !key.is_empty()).unwrap_or_else(|| skill_name(skill))
}

fn source_label(skill: &Value) -> String {
    source_key_label(&or_text(skill, "sourceKey", ""))
}

/// A `sourceKey` as a person reads it: `global` is the user's own, `plugin:<id>` the plugin, `builtin` built-in.
fn source_key_label(key: &str) -> String {
    match key {
        "global" => "own".to_owned(),
        "builtin" => "built-in".to_owned(),
        other => match other.strip_prefix("plugin:") {
            Some(id) => format!("plugin {id}"),
            None => other.to_owned(),
        },
    }
}

/// The row's `state` as the core reports it (`inUse`, `off`, `hidden`).
fn state(skill: &Value) -> &str {
    skill.get("state").and_then(Value::as_str).unwrap_or("inUse")
}

/// The row's switch: off only while the disabled list turns it off (`offBy` `source` or `name`), not while a feature it
/// needs is missing.
fn switched_on(skill: &Value) -> bool {
    !(state(skill) == "off" && matches!(skill.get("offBy").and_then(Value::as_str), Some("source" | "name")))
}

/// Whether the row has a switch, as the core says (`switchable`): a built-in that follows its feature, or a row off for a
/// feature or the project scope, has none.
fn switchable(skill: &Value) -> bool {
    skill.get("switchable") != Some(&Value::Bool(false))
}

/// Why a row whose switch is on is still off: a feature it needs is off, or this project is outside its scope.
fn unavailable_text(skill: &Value) -> &'static str {
    if skill.get("offBy").and_then(Value::as_str) == Some("scope") { "not in this project" } else { "a feature it needs is off" }
}

/// The words of the row's state.
fn state_text(skill: &Value) -> String {
    match state(skill) {
        "off" if !switched_on(skill) => "off".to_owned(),
        "off" => format!("off \u{b7} {}", unavailable_text(skill)),
        "hidden" => format!("hidden by {}", source_key_label(&or_text(skill, "hiddenBy", ""))),
        _ => "in use".to_owned(),
    }
}

/// Whether the row's name occurs in more than one source.
fn shared(skills: &[Value], skill: &Value) -> bool {
    let name = skill_name(skill);
    skills.iter().filter(|other| skill_name(other) == name).count() > 1
}

/// `(value, label, description)` of a row: a name in one source reads as before; a name in several names the row's source
/// and its state.
fn row_text(skill: &Value, shared: bool) -> (String, String, String) {
    let name = skill_name(skill);
    if !shared {
        return (name.clone(), name, skill_description(skill));
    }
    (row_key(skill), format!("{name} \u{b7} {}", source_label(skill)), format!("{} \u{b7} {}", state_text(skill), skill_description(skill)))
}

/// The Skills list rows: the marker shows the row's state, the keypress flips its switch.
fn skill_items(skills: &[Value]) -> Vec<ExtItem> {
    if skills.is_empty() {
        return vec![empty_item("No skills")];
    }
    skills
        .iter()
        .map(|skill| {
            let (value, label, description) = row_text(skill, shared(skills, skill));
            let action = if switchable(skill) { Action::Skill { skill: skill.clone(), enabled: switched_on(skill) } } else { Action::Noop };
            let mut item = ExtItem::new(&value, &label, &with_scope(&description, skill), action);
            let (marker, tone) = match state(skill) {
                "off" => ("\u{25cb}", MarkerTone::Inactive),
                "hidden" => ("\u{25cc}", MarkerTone::Inactive),
                _ => ("\u{25cf}", MarkerTone::Success),
            };
            item.marker = marker.to_owned();
            item.marker_tone = Some(tone);
            item
        })
        .collect()
}

/// The project-skills rows: Enter opens the detail panel, nothing toggles here.
fn project_skill_items(skills: &[Value]) -> Vec<ExtItem> {
    if skills.is_empty() {
        return vec![empty_item("No project skills")];
    }
    skills
        .iter()
        .map(|skill| {
            let shared = shared(skills, skill);
            let (value, label, description) = row_text(skill, shared);
            let mut row = skill.clone();
            if shared && let Some(fields) = row.as_object_mut() {
                fields.insert(SHARED.to_owned(), Value::Bool(true));
            }
            ExtItem::new(&value, &label, &description, Action::View(row))
        })
        .collect()
}

/// Set on a row the project-skills list hands to the detail panel when its name occurs in more than one source.
const SHARED: &str = "sharedName";

/// The title name of a row in the detail panel: with its source when the name is shared.
fn detail_name(skill: &Value) -> String {
    let name = skill_name(skill);
    if skill.get(SHARED) == Some(&Value::Bool(true)) { format!("{name} \u{b7} {}", source_label(skill)) } else { name }
}

/// The name a notice gives a row: with its source when the name occurs in several.
fn notice_name(skill: &Value, shared: bool) -> String {
    let name = skill_name(skill);
    if shared { format!("{name} ({})", source_label(skill)) } else { name }
}

/// `clean(value)` of a member: the trimmed text, empty when absent.
fn clean_member(value: &Value, key: &str) -> String {
    value.get(key).filter(|member| !member.is_null()).map(|member| mixdog_js::js_trim(&value_to_string(member)).to_owned()).unwrap_or_default()
}

fn skill_name(skill: &Value) -> String {
    or_text(skill, "name", "")
}

impl Extensions {
    /// `openSkillsPicker(options)`.
    pub fn open_skills(&mut self, host: &mut dyn ExtensionsHost, options: SkillsOptions) {
        let mut own = claim(host);
        let skills = match options.skills {
            Some(skills) => skills,
            None => {
                let Some(status) = read_status(host, "skillsStatus", "skills", "skills status") else { return };
                status_list(&status, "skills")
            }
        };
        let items = skill_items(&skills);
        if !host.owns(own) {
            return;
        }
        host.set_prompt(PromptSurface::Provider, None);
        host.set_prompt(PromptSurface::Settings, None);
        let mut panel = ExtPanel::new("Skills", "Enable or disable project skills.", items, Handler::Skills { skills }).with_kind("skills");
        panel.initial_index = options.highlight.and_then(|value| panel.items.iter().position(|item| item.value == value)).unwrap_or(0);
        host.paint(&mut own, Some(panel));
    }

    /// Enter, Left or Right on a Skills row: the core flips the row's switch; the list is read again with the row kept.
    pub(super) fn toggle_skill(&mut self, host: &mut dyn ExtensionsHost, skills: &[Value], item: &ExtItem) {
        let Action::Skill { skill, enabled } = &item.action else { return };
        if skill_name(skill).is_empty() {
            return;
        }
        if set_skill_enabled(host, &row_key(skill), !*enabled) {
            host.push_notice(&skill_toggle_notice(*enabled, &notice_name(skill, shared(skills, skill))), Tone::Info);
        }
        self.open_skills(host, SkillsOptions { highlight: Some(item.value.clone()), skills: None });
    }

    /// `openProjectSkillsPicker()`: the read-only list; Enter opens a skill's detail, Esc returns to Skills. It lists what
    /// this session can run, so it asks as the session about itself (`scoped`), like the `$` palette.
    pub fn open_project_skills(&mut self, host: &mut dyn ExtensionsHost) {
        let mut own = claim(host);
        let Some(status) = read_status_with(host, "skillsStatus", json!([{"scoped": true}]), "skills", "skills status") else { return };
        let items = project_skill_items(&status_list(&status, "skills"));
        if !host.owns(own) {
            return;
        }
        host.set_prompt(PromptSurface::Provider, None);
        host.set_prompt(PromptSurface::Settings, None);
        host.paint(&mut own, Some(ExtPanel::new("Project skills", "Skills bundled with this project.", items, Handler::ProjectSkills)));
    }

    /// `openSkillDetailPicker(skill)`: enable, disable, or write a request that runs the skill. Nothing async precedes the
    /// paint, so this is an ordinary claimed paint.
    pub fn open_skill_detail(&mut self, host: &mut dyn ExtensionsHost, skill: &Value) {
        let mut own = claim(host);
        let name = detail_name(skill);
        let disabled = !switched_on(skill);
        // A request names the skill by name, which runs the name's skill in use: only that row can be run.
        let usable = state(skill) == "inUse";
        // The two halves the model's listing shows: capability, then trigger.
        let parts = [clean_member(skill, "description"), clean_member(skill, "whenToUse")];
        let summary = parts.iter().filter(|part| !part.is_empty()).cloned().collect::<Vec<_>>().join(" \u{2014} ");
        let mut items = vec![ExtItem::new(
            "use",
            "Use skill",
            if disabled {
                "enable this skill first"
            } else if state(skill) == "hidden" {
                "another source's skill of this name is in use"
            } else if !usable {
                unavailable_text(skill)
            } else {
                "write a request with this skill"
            },
            if usable { Action::Use } else { Action::Noop },
        )];
        if switchable(skill) {
            items.push(ExtItem::new(
                if disabled { "enable" } else { "disable" },
                if disabled { "Enable skill" } else { "Disable skill" },
                if disabled { "show and allow this skill in the TUI" } else { "hide use action until re-enabled" },
                if disabled { Action::Enable } else { Action::Disable },
            ));
        }
        let description = if summary.is_empty() { "Enable, disable, or run this skill." } else { summary.as_str() };
        host.paint(&mut own, Some(ExtPanel::new(&format!("Skill \u{b7} {name}"), description, items, Handler::SkillDetail(skill.clone()))));
    }

    /// Enter on a row of the skill panel.
    pub(super) fn skill_detail_select(&mut self, host: &mut dyn ExtensionsHost, skill: &Value, item: &ExtItem) {
        close_now(host);
        let name = skill_name(skill);
        match item.action {
            Action::Enable => self.set_skill_disabled(host, skill, false),
            Action::Disable => self.set_skill_disabled(host, skill, true),
            Action::Use => {
                let mut prompt = TextPrompt::new("skill-use");
                prompt.label = format!("Skill \u{b7} {}", detail_name(skill));
                prompt.hint = "Write the request to run with this skill.".to_owned();
                prompt.fields.insert("skillName".to_owned(), Value::String(name));
                host.set_prompt(PromptSurface::Settings, Some(prompt));
            }
            _ => {}
        }
    }

    /// Has the core flip the row's switch, notifies and returns to Skills.
    fn set_skill_disabled(&mut self, host: &mut dyn ExtensionsHost, skill: &Value, disabled: bool) {
        if set_skill_enabled(host, &row_key(skill), !disabled) {
            host.push_notice(&skill_toggle_notice(disabled, &notice_name(skill, skill.get(SHARED) == Some(&Value::Bool(true)))), Tone::Info);
        }
        self.open_skills(host, SkillsOptions::default());
    }
}

fn skill_toggle_notice(disabled: bool, name: &str) -> String {
    format!("skill {}: {name} (prompt updates next session /clear)", if disabled { "disabled" } else { "enabled" })
}
