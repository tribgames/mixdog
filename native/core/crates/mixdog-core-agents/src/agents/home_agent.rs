//! `readHomeAgent` (`session-runtime/agent-home-delivery.mjs`): whether an agent can have a home
//! chat, decided only from a definition that was read successfully.

use std::path::Path;

use mixdog_core_config::config::{bot_migration, is_store_bot};
use mixdog_core_config::workflow::pack::read_document;

use super::files::{Folders, Lane};
use super::{AgentDefinitions, AgentsError, is_contact};

#[cfg(test)]
mod tests;

/// What the definition says about the agent's home chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeAgentKind {
    /// A store bot, or one the kind rule calls a bot.
    Bot,
    /// Read, and a workflow agent: an explicit non-bot `kind`, a shipped role, or an unmarked
    /// `agents/` copy once bots have their own store. It never has a chat.
    None,
    /// An unreadable file, an unparsable one, or an unmarked user copy without bot evidence:
    /// never proof that the agent is no bot.
    Unknown,
}

/// `readOrAbsent`: the text of `path`; a missing file (or a missing parent folder) is absent,
/// any other failure to read it is a failure.
enum Read {
    Text(String),
    Absent,
    Failed,
}

fn read_or_absent(path: &Path) -> Read {
    match mixdog_statefile::read_content(path) {
        Ok(Some(bytes)) => Read::Text(String::from_utf8_lossy(&bytes).into_owned()),
        Ok(None) => Read::Absent,
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => Read::Absent,
        Err(_) => Read::Failed,
    }
}

/// How far the files alone decide it: a final answer, or the greeting evidence of the user copy
/// (`readAgentDefinitionKind`) still to ask.
enum Decided {
    Final(HomeAgentKind),
    ByDefinitionKind,
}

fn decide(folders: &Folders, lane: &Lane, id: &str) -> Decided {
    use Decided::Final;
    if folders.data.as_os_str().is_empty() || id.is_empty() {
        return Final(HomeAgentKind::Unknown);
    }
    if is_store_bot(lane, &folders.data, id) {
        return Final(HomeAgentKind::Bot);
    }
    let user = read_or_absent(&folders.data.join("agents").join(id).join("AGENT.md"));
    if matches!(user, Read::Failed) {
        return Final(HomeAgentKind::Unknown);
    }
    let shipped = if folders.shipped.as_os_str().is_empty() { Read::Absent } else { read_or_absent(&folders.shipped.join("agents").join(id).join("AGENT.md")) };
    let own = match (&user, &shipped) {
        (Read::Text(text), _) => text,
        (_, Read::Text(text)) => text,
        _ => return Final(HomeAgentKind::Unknown),
    };
    let kind = read_document(own).0.get("kind").and_then(|kind| kind.as_str().map(|kind| mixdog_js::js_trim(kind).to_lowercase())).unwrap_or_default();
    if !kind.is_empty() {
        return Final(if is_contact(id, Some(&kind)) {
            HomeAgentKind::Bot
        } else if kind == "agent" {
            HomeAgentKind::None
        } else {
            HomeAgentKind::Unknown
        });
    }
    if !matches!(user, Read::Text(_)) || matches!(shipped, Read::Text(_)) || bot_migration(lane, &folders.data).is_some() {
        return Final(HomeAgentKind::None);
    }
    Decided::ByDefinitionKind
}

impl AgentDefinitions {
    /// `readHomeAgent({ dataDir, shippedRoot, id })`.
    pub async fn home_agent(&self, id: &str) -> Result<HomeAgentKind, AgentsError> {
        let wanted = id.to_owned();
        match self.job(move |folders, lane| decide(folders, lane, &wanted)).await? {
            Decided::Final(kind) => Ok(kind),
            Decided::ByDefinitionKind => Ok(if self.definition_kind(id).await?.as_deref() == Some("bot") { HomeAgentKind::Bot } else { HomeAgentKind::Unknown }),
        }
    }
}
