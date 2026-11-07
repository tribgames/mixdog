//! The display names of the rooms' members (`records.names` of `agent-room-records.ts`), the source
//! of `MemberNames` for the rooms in the session list.
//!
//! Node keeps one map for the process and refreshes it whenever the agents are listed: every
//! user-made definition (a bot or not) names its member with its definition's name, else its
//! label, else its id; Mixy's entry is her name or `Mixy`. An entry is never dropped, and a
//! listing that fails changes none (`listAgents().catch(() => [])`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_agents::agents::{AgentDefinition, AgentDefinitions, AgentRow};
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_rooms::rooms::catalog_rows::MemberNames;
use mixdog_js::js_trim;

/// What the names are read from: the agent catalog's rows and Mixy's name.
#[async_trait]
pub trait NamesSource: Send + Sync {
    /// `listAgents()`.
    async fn rows(&self) -> Result<Vec<AgentRow>, String>;
    /// `getLeadStatus().name`.
    async fn lead_name(&self) -> Result<String, String>;
}

#[async_trait]
impl NamesSource for AgentDefinitions {
    async fn rows(&self) -> Result<Vec<AgentRow>, String> {
        AgentDefinitions::rows(self).await.map_err(|error| format!("{error:?}"))
    }

    async fn lead_name(&self) -> Result<String, String> {
        self.lead_status().await.map(|status| status.name).map_err(|error| format!("{error:?}"))
    }
}

/// [`MemberNames`] over the agent catalog.
pub struct DefinitionNames {
    source: Arc<dyn NamesSource>,
    names: Mutex<HashMap<String, String>>,
}

impl DefinitionNames {
    pub fn new(source: Arc<dyn NamesSource>) -> Self {
        Self { source, names: Mutex::new(HashMap::new()) }
    }

    pub(crate) fn source(&self) -> &Arc<dyn NamesSource> {
        &self.source
    }

    /// `mixyName`: her name, `Mixy` while she has none or it cannot be read.
    pub(crate) async fn mixy_name(&self) -> String {
        match self.source.lead_name().await {
            Ok(name) if !name.is_empty() => name,
            _ => "Mixy".to_owned(),
        }
    }

    /// `names.get(id)`.
    pub(crate) fn known(&self, id: &str) -> Option<String> {
        self.names.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(id).cloned()
    }

    /// `names.set(id, name)`.
    pub(crate) fn remember(&self, id: &str, name: &str) {
        self.names.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(id.to_owned(), name.to_owned());
    }
}

/// `agentName(row)`: the definition's name, else the row's label, else the id (each trimmed).
pub(crate) fn agent_name(row: &AgentRow) -> String {
    let named = |text: &str| js_trim(text).to_owned();
    let from_definition = row.definition.as_ref().map(|definition| named(&definition.name)).unwrap_or_default();
    if !from_definition.is_empty() {
        return from_definition;
    }
    let label = named(&row.label);
    if label.is_empty() { row.id.clone() } else { label }
}

#[async_trait]
impl MemberNames for DefinitionNames {
    /// `refreshNames`, then the map.
    async fn names(&self) -> HashMap<String, String> {
        let listed = self.source.rows().await.unwrap_or_default();
        let lead = self.mixy_name().await;
        let mut names = self.names.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for row in listed.iter().filter(|row| !row.fixed && !row.id.is_empty()) {
            names.insert(row.id.clone(), agent_name(row));
        }
        names.insert(MIXY_AGENT_ID.to_owned(), lead);
        names.clone()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use serde_json::{Map, Value};

    use super::*;

    fn row(id: &str, label: &str, fixed: bool, definition_name: Option<&str>) -> AgentRow {
        AgentRow {
            id: id.into(),
            label: label.into(),
            description: String::new(),
            fixed,
            user_override: false,
            route: Value::Null,
            route_configured: false,
            kind: None,
            disabled: false,
            avatar: Value::Null,
            definition: definition_name.map(|name| AgentDefinition {
                id: id.into(),
                name: name.into(),
                description: String::new(),
                permission: None,
                frontmatter: Map::new(),
                kind: None,
                body: String::new(),
                persona: String::new(),
            }),
        }
    }

    struct Source {
        rows: StdMutex<Result<Vec<AgentRow>, String>>,
        lead: StdMutex<Result<String, String>>,
    }
    #[async_trait]
    impl NamesSource for Source {
        async fn rows(&self) -> Result<Vec<AgentRow>, String> {
            self.rows.lock().unwrap().clone()
        }
        async fn lead_name(&self) -> Result<String, String> {
            self.lead.lock().unwrap().clone()
        }
    }

    fn source(rows: Vec<AgentRow>, lead: &str) -> Arc<Source> {
        Arc::new(Source { rows: StdMutex::new(Ok(rows)), lead: StdMutex::new(Ok(lead.into())) })
    }

    #[tokio::test]
    async fn user_made_definitions_and_mixy_are_named_and_fixed_services_are_not() {
        let source = source(
            vec![
                row("maintainer", "Maintainer", true, None),
                row("gh", "gh", false, Some("  GH Bot ")),
                row("ops", "Ops Label", false, Some("   ")),
                row("raw", "  ", false, None),
            ],
            "Mina",
        );
        let names = DefinitionNames::new(source).names().await;
        let sorted: std::collections::BTreeMap<_, _> = names.into_iter().collect();
        assert_eq!(
            sorted.into_iter().collect::<Vec<_>>(),
            [
                ("gh".to_owned(), "GH Bot".to_owned()),
                (MIXY_AGENT_ID.to_owned(), "Mina".to_owned()),
                ("ops".to_owned(), "Ops Label".to_owned()),
                ("raw".to_owned(), "raw".to_owned()),
            ]
        );
    }

    #[tokio::test]
    async fn mixy_without_a_name_is_mixy_and_a_failed_listing_keeps_every_entry() {
        let source = source(vec![row("gh", "gh", false, Some("GH"))], "");
        let names = DefinitionNames::new(source.clone());
        let first = names.names().await;
        assert_eq!((first["gh"].as_str(), first[MIXY_AGENT_ID].as_str()), ("GH", "Mixy"));
        *source.rows.lock().unwrap() = Err("catalog unreadable".into());
        *source.lead.lock().unwrap() = Err("lead unreadable".into());
        let again = names.names().await;
        assert_eq!((again["gh"].as_str(), again[MIXY_AGENT_ID].as_str()), ("GH", "Mixy"));
        // A definition removed from the listing keeps its name, as Node's map does.
        *source.rows.lock().unwrap() = Ok(vec![]);
        assert_eq!(names.names().await["gh"], "GH");
    }
}
