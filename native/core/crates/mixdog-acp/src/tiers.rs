//! One model an agent lists at several effort tiers (`gemini-4-neon-high` "Gemini 4 Neon (High)", `…-low`, …) is one
//! model whose tiers are its efforts: the list shows it once, and the effort a route carries picks the agent's model id
//! that is run. The tier words are the preset's data; a model whose id ends in none of them is listed as it is.

use crate::preset::Quirks;
use crate::session::AgentModel;
use crate::session::Models;

/// A model as it is listed: under its own id and name, with the agent's model id of each effort it runs at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed {
    pub id: String,
    pub name: String,
    /// `(effort, the agent's model id)`, lowest effort first; empty for a model the agent lists once.
    pub efforts: Vec<(String, String)>,
    /// The effort a route that names none runs at: the tier the agent itself is on where that is one of this model's,
    /// else the first tier the agent listed.
    pub default_effort: Option<String>,
}

/// `model` read as `(tier, the model's own id, the model's own name)`: its id ends in `-<tier>`. The name loses a
/// closing `(<tier>)` that says the same.
fn tiered<'a>(model: &AgentModel, tiers: &'a [String]) -> Option<(&'a str, String, String)> {
    tiers.iter().find_map(|tier| {
        let id = model.id.strip_suffix(tier.as_str())?.strip_suffix('-')?;
        if id.is_empty() {
            return None;
        }
        let name = model.name.trim_end();
        let named = name
            .strip_suffix(')')
            .and_then(|name| name.rsplit_once('('))
            .filter(|(_, said)| said.trim().eq_ignore_ascii_case(tier))
            .map(|(name, _)| name.trim_end());
        Some((tier.as_str(), id.to_owned(), named.filter(|name| !name.is_empty()).unwrap_or(name).to_owned()))
    })
}

/// The agent's models as they are listed, in the order the agent first names each.
pub fn listed(models: &Models, tiers: &[String]) -> Vec<Listed> {
    let mut rows: Vec<Listed> = Vec::new();
    for model in &models.available {
        // An id the agent also lists bare is that model's own, not a tier of it.
        let read = tiered(model, tiers).filter(|(_, id, _)| !models.available.iter().any(|other| other.id == *id));
        let Some((tier, id, name)) = read else {
            rows.push(Listed { id: model.id.clone(), name: model.name.clone(), efforts: Vec::new(), default_effort: None });
            continue;
        };
        let on_it = models.current.as_deref() == Some(model.id.as_str());
        match rows.iter_mut().find(|row| row.id == id && !row.efforts.is_empty()) {
            Some(row) => {
                row.efforts.push((tier.to_owned(), model.id.clone()));
                if on_it {
                    row.default_effort = Some(tier.to_owned());
                }
            }
            None => rows.push(Listed { id, name, efforts: vec![(tier.to_owned(), model.id.clone())], default_effort: Some(tier.to_owned()) }),
        }
    }
    let rank = |tier: &str| tiers.iter().position(|known| known == tier);
    for row in &mut rows {
        row.efforts.sort_by_key(|(tier, _)| rank(tier));
    }
    rows
}

/// The listed models a session is offered: all but the agent's own orchestration entries.
pub fn offered(models: &Models, quirks: &Quirks) -> Vec<Listed> {
    let mut rows = listed(models, &quirks.effort_tiers);
    rows.retain(|row| !quirks.own_orchestration.iter().any(|prefix| row.id.starts_with(prefix.as_str())));
    rows
}

/// The agent's model id a route on `model` at `effort` runs: the listed model's tier of that effort. A route that
/// names no effort the model has runs the tier its `model` is, where it was saved under the agent's own id of one,
/// else the model's default. A model the agent lists once, or not at all, is asked for as named.
pub fn agent_model(models: &Models, tiers: &[String], model: &str, effort: Option<&str>) -> String {
    let rows = listed(models, tiers);
    let Some(row) = rows.iter().find(|row| row.id == model || row.efforts.iter().any(|(_, id)| id == model)) else { return model.to_owned() };
    let of = |effort: &str| row.efforts.iter().find(|(tier, _)| tier == effort).map(|(_, id)| id.clone());
    let saved_tier = || row.efforts.iter().any(|(_, id)| id == model).then(|| model.to_owned());
    effort.and_then(of).or_else(saved_tier).or_else(|| row.default_effort.as_deref().and_then(of)).unwrap_or_else(|| model.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models(current: &str, available: &[(&str, &str)]) -> Models {
        Models {
            available: available.iter().map(|(id, name)| AgentModel { id: (*id).to_owned(), name: (*name).to_owned() }).collect(),
            current: Some(current.to_owned()),
            config_option: None,
        }
    }

    fn tiers() -> Vec<String> {
        ["low", "medium", "high", "xhigh"].map(str::to_owned).to_vec()
    }

    /// What `agy` 1.5.15 lists, in its order (a part of it).
    fn agy() -> Models {
        models(
            "gemini-4-neon-high",
            &[
                ("gemini-4-neon-high", "Gemini 4 Neon (High)"),
                ("gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"),
                ("gemini-4-neon-medium", "Gemini 4 Neon (Medium)"),
                ("gemini-4-neon-low", "Gemini 4 Neon (Low)"),
                ("gemini-pro-orchestrator-neon", "Orchestrator (Neon)"),
                ("gemini-pro-orchestrator", "Orchestrator (Carbon)"),
                ("claude-opus-5-5-low", "Claude Opus 5.5 (Low)"),
                ("claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"),
                ("claude-opus-5-5-high", "Claude Opus 5.5 (High)"),
                ("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
            ],
        )
    }

    #[test]
    fn a_model_listed_at_several_tiers_is_one_model_whose_tiers_are_its_efforts() {
        let rows = listed(&agy(), &tiers());
        let read: Vec<(&str, &str, Vec<&str>, Option<&str>)> = rows
            .iter()
            .map(|row| (row.id.as_str(), row.name.as_str(), row.efforts.iter().map(|(tier, _)| tier.as_str()).collect(), row.default_effort.as_deref()))
            .collect();
        assert_eq!(
            read,
            [
                // The agent is on this model's High.
                ("gemini-4-neon", "Gemini 4 Neon", vec!["low", "medium", "high", "xhigh"], Some("high")),
                // No tier in the id: listed as the agent lists them, a parenthesis in the name left alone.
                ("gemini-pro-orchestrator-neon", "Orchestrator (Neon)", vec![], None),
                ("gemini-pro-orchestrator", "Orchestrator (Carbon)", vec![], None),
                // The first tier the agent listed.
                ("claude-opus-5-5", "Claude Opus 5.5", vec!["low", "medium", "high"], Some("low")),
                ("gpt-oss-120b", "GPT-OSS 120B", vec!["medium"], Some("medium")),
            ]
        );
    }

    /// The agent's planner-and-executor entries are not offered; a route already saved on one still runs as named.
    #[test]
    fn the_agents_own_orchestration_entries_are_not_offered() {
        let quirks = crate::preset::builtin().into_iter().find(|preset| preset.id == "antigravity").expect("the preset").quirks;
        let ids: Vec<String> = offered(&agy(), &quirks).into_iter().map(|row| row.id).collect();
        assert_eq!(ids, ["gemini-4-neon", "claude-opus-5-5", "gpt-oss-120b"]);
        assert_eq!(agent_model(&agy(), &quirks.effort_tiers, "gemini-pro-orchestrator-neon", None), "gemini-pro-orchestrator-neon");
    }

    #[test]
    fn a_routes_effort_picks_the_agents_model_id_that_is_run() {
        let (agy, tiers) = (agy(), tiers());
        assert_eq!(agent_model(&agy, &tiers, "gemini-4-neon", Some("xhigh")), "gemini-4-neon-xhigh");
        assert_eq!(agent_model(&agy, &tiers, "claude-opus-5-5", Some("medium")), "claude-opus-5-5-medium");
        // No effort, or one the model has no tier of: the model's default.
        assert_eq!(agent_model(&agy, &tiers, "gemini-4-neon", None), "gemini-4-neon-high");
        assert_eq!(agent_model(&agy, &tiers, "claude-opus-5-5", Some("xhigh")), "claude-opus-5-5-low");
        // A route saved under the agent's own id of one tier is that model at that tier, until it names an effort.
        assert_eq!(agent_model(&agy, &tiers, "claude-opus-5-5-high", None), "claude-opus-5-5-high");
        assert_eq!(agent_model(&agy, &tiers, "claude-opus-5-5-high", Some("low")), "claude-opus-5-5-low");
        assert_eq!(agent_model(&agy, &tiers, "claude-opus-5-5-high", Some("xhigh")), "claude-opus-5-5-high");
        // A model the agent lists once takes no effort.
        assert_eq!(agent_model(&agy, &tiers, "gemini-pro-orchestrator", Some("high")), "gemini-pro-orchestrator");
        // A model the agent does not list is asked for as named; the agent answers for it.
        assert_eq!(agent_model(&agy, &tiers, "gone", Some("high")), "gone");
    }

    #[test]
    fn an_id_the_agent_also_lists_bare_keeps_its_tier_models_apart() {
        let both = models("m", &[("m", "M"), ("m-high", "M (High)")]);
        let rows = listed(&both, &tiers());
        assert_eq!(rows.iter().map(|row| (row.id.as_str(), row.efforts.len())).collect::<Vec<_>>(), [("m", 0), ("m-high", 0)]);
    }
}
