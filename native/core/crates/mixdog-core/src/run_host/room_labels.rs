//! [`RoomLabels`] over the agent catalog (`memberLabels` of `agent-room-records.ts`).

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::{AgentRow, is_contact};
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_rooms::rooms::live::RoomLabels;
use mixdog_core_rooms::rooms::turn_host::MemberLabel;
use mixdog_js::js_trim;
use serde_json::Value;

use super::member_names::{DefinitionNames, agent_name};

/// What the lead's label says of Mixy.
const MIXY_DESCRIPTION: &str = "The user's main assistant.";

pub struct DefinitionLabels {
    names: Arc<DefinitionNames>,
}

impl DefinitionLabels {
    /// `names`: the process's one names map (a member without a row keeps the name it was last
    /// given).
    pub fn new(names: Arc<DefinitionNames>) -> Self {
        Self { names }
    }
}

/// `agentDescription(row)`: the row's description, else its definition's, each trimmed.
fn agent_description(row: &AgentRow) -> String {
    let own = js_trim(&row.description);
    if !own.is_empty() {
        return own.to_owned();
    }
    row.definition.as_ref().map(|definition| js_trim(&definition.description).to_owned()).unwrap_or_default()
}

#[async_trait]
impl RoomLabels for DefinitionLabels {
    async fn labels(&self, members: &[String]) -> Result<HashMap<String, MemberLabel>, String> {
        // `contactAgentRows(listAgents().catch(() => []), { includeDisabled: true })`.
        let listed = self.names.source().rows().await.unwrap_or_default();
        let rows: Vec<&AgentRow> = listed.iter().filter(|row| !row.fixed && is_contact(&row.id, row.kind.as_deref())).collect();
        let lead = if members.iter().any(|id| id == MIXY_AGENT_ID) { self.names.mixy_name().await } else { String::new() };
        let mut labels = HashMap::new();
        for id in members {
            let row = rows.iter().find(|row| row.id == *id).copied();
            let is_lead = id == MIXY_AGENT_ID;
            let row_name = match row {
                Some(row) => agent_name(row),
                None => self.names.known(id).unwrap_or_else(|| id.clone()),
            };
            let name = if is_lead { lead.clone() } else { row_name };
            if row.is_some() {
                self.names.remember(id, &name);
            }
            let description = if is_lead { MIXY_DESCRIPTION.to_owned() } else { row.map(agent_description).unwrap_or_default() };
            labels.insert(
                id.clone(),
                MemberLabel {
                    id: id.clone(),
                    name,
                    route: row.map_or(Value::Null, |row| row.route.clone()),
                    description,
                    disabled: row.is_some_and(|row| row.disabled),
                },
            );
        }
        Ok(labels)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_agents::agents::AgentDefinition;
    use serde_json::{Map, json};

    use super::super::member_names::NamesSource;
    use super::*;

    fn row(id: &str, kind: Option<&str>, disabled: bool, description: &str, definition: Option<(&str, &str)>) -> AgentRow {
        AgentRow {
            id: id.into(),
            label: id.into(),
            description: description.into(),
            fixed: false,
            user_override: false,
            route: json!({ "provider": "p", "model": id }),
            route_configured: true,
            kind: kind.map(str::to_owned),
            disabled,
            avatar: Value::Null,
            definition: definition.map(|(name, text)| AgentDefinition {
                id: id.into(),
                name: name.into(),
                description: text.into(),
                permission: None,
                frontmatter: Map::new(),
                kind: kind.map(str::to_owned),
                body: String::new(),
                persona: String::new(),
            }),
        }
    }

    struct Source(Mutex<Vec<AgentRow>>);
    #[async_trait]
    impl NamesSource for Source {
        async fn rows(&self) -> Result<Vec<AgentRow>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn lead_name(&self) -> Result<String, String> {
            Ok("Mina".into())
        }
    }

    #[tokio::test]
    async fn labels_name_contacts_mixy_and_strangers_as_the_room_records_do() {
        let source = Arc::new(Source(Mutex::new(vec![
            row("gh", Some("bot"), true, "", Some(("GH Bot", " Reviews code "))),
            row("flow", Some("agent"), false, "a workflow agent", None),
        ])));
        let labels = DefinitionLabels::new(Arc::new(DefinitionNames::new(source.clone())));
        let members: Vec<String> = ["gh", MIXY_AGENT_ID, "flow", "ghost"].iter().map(|id| (*id).to_owned()).collect();
        let got = labels.labels(&members).await.unwrap();
        // A switched-off bot is a label (includeDisabled) and marked disabled.
        assert_eq!((got["gh"].name.as_str(), got["gh"].description.as_str(), got["gh"].disabled), ("GH Bot", "Reviews code", true));
        assert_eq!(got["gh"].route, json!({ "provider": "p", "model": "gh" }));
        assert_eq!((got[MIXY_AGENT_ID].name.as_str(), got[MIXY_AGENT_ID].description.as_str()), ("Mina", "The user's main assistant."));
        // `kind: agent` is no contact, and an unlisted id is its own name with nothing else.
        for id in ["flow", "ghost"] {
            assert_eq!((got[id].name.as_str(), got[id].description.as_str(), got[id].route.clone(), got[id].disabled), (id, "", Value::Null, false));
        }
        // A member whose row is gone keeps the name it was last given.
        source.0.lock().unwrap().clear();
        let later = labels.labels(&["gh".to_owned()]).await.unwrap();
        assert_eq!(later["gh"].name, "GH Bot");
    }
}
