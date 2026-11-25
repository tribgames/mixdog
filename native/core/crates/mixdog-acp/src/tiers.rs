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

/// The agent's models grouped by the id they share, each with every tier the agent lists it at.
fn grouped(models: &Models, tiers: &[String]) -> Vec<Listed> {
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

/// A model the agent lists at one tier only has no effort to choose: the tier is the model's own.
fn without_lone_tier(mut row: Listed) -> Listed {
    if row.efforts.len() == 1 {
        row.efforts.clear();
        row.default_effort = None;
    }
    row
}

/// The agent's models as they are listed, in the order the agent first names each.
pub fn listed(models: &Models, tiers: &[String]) -> Vec<Listed> {
    grouped(models, tiers).into_iter().map(without_lone_tier).collect()
}

/// The listed models a session is offered: those of the preset's scope, but for the agent's own orchestration entries.
pub fn offered(models: &Models, quirks: &Quirks) -> Vec<Listed> {
    let mut rows = listed(models, &quirks.effort_tiers);
    rows.retain(|row| is_offered(&row.id, quirks));
    rows
}

fn is_offered(id: &str, quirks: &Quirks) -> bool {
    quirks.model_scope.admits(id) && !quirks.own_orchestration.iter().any(|prefix| id.starts_with(prefix.as_str()))
}

/// The offered model a route's `model` names: the listed id, or the agent's own id of one of its tiers (as a route
/// saved before the list grouped them holds it).
pub fn find(models: &Models, quirks: &Quirks, model: &str) -> Option<Listed> {
    grouped(models, &quirks.effort_tiers)
        .into_iter()
        .find(|row| is_offered(&row.id, quirks) && (row.id == model || row.efforts.iter().any(|(_, id)| id == model)))
        .map(without_lone_tier)
}

/// The agent's model id a route on `model` at `effort` runs: the listed model's tier of that effort. A route that
/// names no effort the model has runs the tier its `model` is, where it was saved under the agent's own id of one,
/// else the model's default. A model the agent lists once, or not at all, is asked for as named.
pub fn agent_model(models: &Models, tiers: &[String], model: &str, effort: Option<&str>) -> String {
    let rows = grouped(models, tiers);
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

    fn quirks(id: &str) -> Quirks {
        crate::preset::builtin().into_iter().find(|preset| preset.id == id).expect("the preset").quirks
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
                // One tier only: nothing to choose.
                ("gpt-oss-120b", "GPT-OSS 120B", vec![], None),
            ]
        );
    }

    /// Each preset is offered the models of its own scope, and neither the agent's planner-and-executor entries; a route
    /// already saved on one still runs as named.
    #[test]
    fn each_preset_is_offered_its_own_models_and_not_the_agents_orchestration_entries() {
        let (official, cli) = (quirks("antigravity"), quirks("antigravity-cli"));
        let ids = |quirks: &Quirks| offered(&agy(), quirks).into_iter().map(|row| row.id).collect::<Vec<_>>();
        assert_eq!(ids(&official), ["gemini-4-neon"]);
        assert_eq!(ids(&cli), ["claude-opus-5-5", "gpt-oss-120b"]);
        assert_eq!(find(&agy(), &official, "gemini-pro-orchestrator"), None);
        // A route names a model of the other preset: neither finds the other's.
        assert_eq!(find(&agy(), &official, "claude-opus-5-5-high"), None);
        assert_eq!(find(&agy(), &cli, "gemini-4-neon"), None);
        assert_eq!(find(&agy(), &cli, "claude-opus-5-5-high").map(|row| row.id), Some("claude-opus-5-5".to_owned()));
        assert_eq!(agent_model(&agy(), &official.effort_tiers, "gemini-pro-orchestrator-neon", None), "gemini-pro-orchestrator-neon");
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

    /// `agy` 1.5.15's `session/new` answer, as it gave it: tiered `models`, and a `model` option of bare ids beside a
    /// `thought_level` option.
    fn agy_answer() -> serde_json::Value {
        let tiered = |bare: &str, name: &str, tiers: &[&str]| -> Vec<serde_json::Value> {
            tiers.iter().map(|tier| serde_json::json!({ "modelId": format!("{bare}-{tier}"), "name": format!("{name} ({tier})") })).collect()
        };
        let mut available = Vec::new();
        available.extend(tiered("gemini-4-neon", "Gemini 4 Neon", &["high", "xhigh", "medium", "low"]));
        available.extend(tiered("gemini-4-hydrogen", "Gemini 4 Hydrogen", &["high", "xhigh", "medium", "low"]));
        available.extend(tiered("gemini-4-carbon", "Gemini 4 Carbon", &["medium", "high", "low"]));
        available.extend(tiered("gemini-4-argon", "Gemini 4 Argon", &["medium", "high", "low"]));
        available.extend(tiered("gemini-3.8-flash", "Gemini 3.8 Flash", &["high", "medium", "low"]));
        available.extend(tiered("claude-opus-5-5", "Claude Opus 5.5", &["low", "medium", "high"]));
        available.extend(tiered("claude-sonnet-5-5", "Claude Sonnet 5.5", &["low", "medium", "high"]));
        available.push(serde_json::json!({ "modelId": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)" }));
        available.push(serde_json::json!({ "modelId": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)" }));
        available.push(serde_json::json!({ "modelId": "gemini-pro-orchestrator", "name": "Orchestrator (Carbon)" }));
        available.push(serde_json::json!({ "modelId": "gemini-pro-orchestrator-argon", "name": "Orchestrator (Argon)" }));
        serde_json::json!({
            "sessionId": "s",
            "models": { "currentModelId": "gemini-4-neon-high", "availableModels": available },
            "configOptions": [
                { "id": "model", "category": "model", "type": "select", "currentValue": "gemini-4-neon", "options": [
                    { "value": "gemini-4-neon", "name": "Gemini 4 Neon" }, { "value": "gemini-4-carbon", "name": "Gemini 4 Carbon" },
                    { "value": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)" } ] },
                { "id": "thought_level", "category": "thought_level", "type": "select", "currentValue": "high", "options": [
                    { "value": "low" }, { "value": "medium" }, { "value": "high" }, { "value": "xhigh" } ] },
            ],
        })
    }

    #[test]
    fn the_agents_session_answer_lists_each_model_once_with_the_efforts_it_runs_at() {
        let answer = agy_answer();
        let models = Models::of(&answer);
        // The tiered list decides, and the model is set with `session/set_model`.
        assert_eq!(models.config_option, None);
        assert_eq!(models.current.as_deref(), Some("gemini-4-neon-high"));
        fn read(rows: &[Listed]) -> Vec<(&str, Vec<&str>)> {
            rows.iter().map(|row| (row.id.as_str(), row.efforts.iter().map(|(tier, _)| tier.as_str()).collect())).collect()
        }
        let (official, cli) = (offered(&models, &quirks("antigravity")), offered(&models, &quirks("antigravity-cli")));
        assert_eq!(
            read(&official),
            [
                ("gemini-4-neon", vec!["low", "medium", "high", "xhigh"]),
                ("gemini-4-hydrogen", vec!["low", "medium", "high", "xhigh"]),
                ("gemini-4-carbon", vec!["low", "medium", "high"]),
                ("gemini-4-argon", vec!["low", "medium", "high"]),
                ("gemini-3.8-flash", vec!["low", "medium", "high"]),
            ]
        );
        assert_eq!(
            read(&cli),
            [("claude-opus-5-5", vec!["low", "medium", "high"]), ("claude-sonnet-5-5", vec!["low", "medium", "high"]), ("gpt-oss-120b", vec![])]
        );
        assert_eq!(official[0].default_effort.as_deref(), Some("high"));
        assert_eq!(cli[2].name, "GPT-OSS 120B");
    }

    #[test]
    fn the_selection_sent_is_the_agents_tiered_id_of_the_models_effort() {
        let models = Models::of(&agy_answer());
        let tiers = tiers();
        let sent = |model: &str, effort: Option<&str>| agent_model(&models, &tiers, model, effort);
        assert_eq!(sent("gemini-4-neon", Some("low")), "gemini-4-neon-low");
        assert_eq!(sent("gemini-4-neon", Some("xhigh")), "gemini-4-neon-xhigh");
        assert_eq!(sent("gemini-4-carbon", Some("medium")), "gemini-4-carbon-medium");
        assert_eq!(sent("gemini-4-carbon", Some("xhigh")), "gemini-4-carbon-medium");
        // Routes saved earlier: a tiered id, and a bare id of the lone-tier model, with or without an effort.
        assert_eq!(sent("gemini-4-hydrogen-low", None), "gemini-4-hydrogen-low");
        assert_eq!(sent("gpt-oss-120b", Some("high")), "gpt-oss-120b-medium");
        assert_eq!(sent("gpt-oss-120b-medium", None), "gpt-oss-120b-medium");
    }

    #[test]
    fn an_answer_with_only_a_model_option_is_set_as_that_option() {
        let mut answer = agy_answer();
        answer.as_object_mut().expect("object").remove("models");
        let models = Models::of(&answer);
        assert_eq!(models.config_option.as_deref(), Some("model"));
        assert_eq!(models.current.as_deref(), Some("gemini-4-neon"));
        assert_eq!(models.available.len(), 3);
        assert_eq!(agent_model(&models, &tiers(), "gemini-4-neon", Some("low")), "gemini-4-neon");
    }

    #[test]
    fn a_saved_tiered_id_of_a_lone_tier_model_finds_its_row() {
        let models = Models::of(&agy_answer());
        assert_eq!(find(&models, &quirks("antigravity-cli"), "gpt-oss-120b-medium").map(|row| row.id), Some("gpt-oss-120b".to_owned()));
        assert_eq!(find(&models, &quirks("antigravity"), "gemini-4-neon-xhigh").map(|row| row.id), Some("gemini-4-neon".to_owned()));
    }
}
