//! The Skills lists and the per-skill panel (`extension-pickers/skills-pickers.mjs` and `skills-pickers/{skill-items,
//! project-skills,skill-detail}.mjs`): the enable and disable toggles, the read-only project-skills list and the panel that
//! enables, disables or writes a request that runs one skill.
//!
//! The disabled set is read fresh from the host at call time, so a toggle observes the latest state.

use mixdog_js::value_to_string;
use serde_json::Value;

use super::Extensions;
use super::disabled_skills::{SkillSet, set_disabled_skills};
use super::panel::{
    Action, ExtItem, ExtPanel, ExtensionsHost, Handler, MarkerTone, claim, close_now, or_text, read_status, status_list, with_scope,
};
use crate::slash::host::{PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{truthy, value_text};

/// The options of `openSkillsPicker`.
#[derive(Clone, Debug, Default)]
pub struct SkillsOptions {
    /// The row to highlight.
    pub highlight: Option<String>,
    /// The skills already fetched: a toggle reopens the list without asking the store again.
    pub skills: Option<Vec<Value>>,
    /// The disabled set a toggle has just written, which the reopen shows instead of the host's.
    pub disabled_override: Option<SkillSet>,
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

/// The Skills list rows: the marker carries the enabled state the keypress flips.
fn skill_items(skills: &[Value], disabled: &SkillSet) -> Vec<ExtItem> {
    if skills.is_empty() {
        return vec![empty_item("No skills")];
    }
    skills
        .iter()
        .map(|skill| {
            let name = or_text(skill, "name", "");
            let enabled = !disabled.contains(&name);
            let mut item = ExtItem::new(&name, &name, &with_scope(&skill_description(skill), skill), Action::Skill { skill: skill.clone(), enabled });
            item.marker = if enabled { "\u{25cf}" } else { "\u{25cb}" }.to_owned();
            item.marker_tone = Some(if enabled { MarkerTone::Success } else { MarkerTone::Inactive });
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
            let name = or_text(skill, "name", "");
            ExtItem::new(&name, &name, &skill_description(skill), Action::View(skill.clone()))
        })
        .collect()
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
        let disabled = options.disabled_override.unwrap_or_else(|| host.disabled_skills());
        let items = skill_items(&skills, &disabled);
        if !host.owns(own) {
            return;
        }
        host.set_prompt(PromptSurface::Provider, None);
        host.set_prompt(PromptSurface::Settings, None);
        let mut panel = ExtPanel::new("Skills", "Enable or disable project skills.", items, Handler::Skills { skills, disabled }).with_kind("skills");
        panel.initial_index = options.highlight.and_then(|value| panel.items.iter().position(|item| item.value == value)).unwrap_or(0);
        host.paint(&mut own, Some(panel));
    }

    /// Enter, Left or Right on a Skills row: flips the skill, notifies and reopens the list without refetching.
    pub(super) fn toggle_skill(&mut self, host: &mut dyn ExtensionsHost, skills: &[Value], disabled: &SkillSet, item: &ExtItem) {
        let Action::Skill { skill, enabled } = &item.action else { return };
        let name = skill_name(skill);
        if name.is_empty() {
            return;
        }
        let mut next = disabled.clone();
        if *enabled {
            next.insert(&name);
        } else {
            next.remove(&name);
        }
        set_disabled_skills(host, next.clone());
        host.push_notice(&skill_toggle_notice(*enabled, &name), Tone::Info);
        self.open_skills(host, SkillsOptions { highlight: Some(name), skills: Some(skills.to_vec()), disabled_override: Some(next) });
    }

    /// `openProjectSkillsPicker()`: the read-only list; Enter opens a skill's detail, Esc returns to Skills.
    pub fn open_project_skills(&mut self, host: &mut dyn ExtensionsHost) {
        let mut own = claim(host);
        let Some(status) = read_status(host, "skillsStatus", "skills", "skills status") else { return };
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
        let name = skill_name(skill);
        let disabled = host.disabled_skills().contains(&name);
        // The two halves the model's listing shows: capability, then trigger.
        let parts = [clean_member(skill, "description"), clean_member(skill, "whenToUse")];
        let summary = parts.iter().filter(|part| !part.is_empty()).cloned().collect::<Vec<_>>().join(" \u{2014} ");
        let items = vec![
            ExtItem::new(
                "use",
                "Use skill",
                if disabled { "enable this skill first" } else { "write a request with this skill" },
                if disabled { Action::Noop } else { Action::Use },
            ),
            ExtItem::new(
                if disabled { "enable" } else { "disable" },
                if disabled { "Enable skill" } else { "Disable skill" },
                if disabled { "show and allow this skill in the TUI" } else { "hide use action until re-enabled" },
                if disabled { Action::Enable } else { Action::Disable },
            ),
        ];
        let description = if summary.is_empty() { "Enable, disable, or run this skill." } else { summary.as_str() };
        host.paint(&mut own, Some(ExtPanel::new(&format!("Skill \u{b7} {name}"), description, items, Handler::SkillDetail(skill.clone()))));
    }

    /// Enter on a row of the skill panel.
    pub(super) fn skill_detail_select(&mut self, host: &mut dyn ExtensionsHost, skill: &Value, item: &ExtItem) {
        close_now(host);
        let name = skill_name(skill);
        match item.action {
            Action::Enable => self.set_skill_disabled(host, &name, false),
            Action::Disable => self.set_skill_disabled(host, &name, true),
            Action::Use => {
                let mut prompt = TextPrompt::new("skill-use");
                prompt.label = format!("Skill \u{b7} {name}");
                prompt.hint = "Write the request to run with this skill.".to_owned();
                prompt.fields.insert("skillName".to_owned(), Value::String(name));
                host.set_prompt(PromptSurface::Settings, Some(prompt));
            }
            _ => {}
        }
    }

    /// Flips one skill in the held set, notifies and returns to Skills.
    fn set_skill_disabled(&mut self, host: &mut dyn ExtensionsHost, name: &str, disabled: bool) {
        let mut next = host.disabled_skills();
        if disabled {
            next.insert(name);
        } else {
            next.remove(name);
        }
        set_disabled_skills(host, next);
        host.push_notice(&skill_toggle_notice(disabled, name), Tone::Info);
        self.open_skills(host, SkillsOptions::default());
    }
}

fn skill_toggle_notice(disabled: bool, name: &str) -> String {
    format!("skill {}: {name} (prompt updates next session /clear)", if disabled { "disabled" } else { "enabled" })
}
