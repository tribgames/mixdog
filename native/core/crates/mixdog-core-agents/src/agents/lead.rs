//! Mixy's identity: the Lead has no agent definition to edit, only its `PERSONA.md` (character)
//! and `AGENT.md` (way of working), its `agent.json` (the `created` flag, name, face) and the one
//! pixel face every Lead row wears (`leadAvatar` of the config). The files live in Mixy's
//! identity folder (`bots/mixy` once the bot store is active, `agents/lead` before).
//!
//! Sources: `createLeadIdentityApi` of `workflow-agents-api/agent-editor.mjs` and
//! `getLeadAppearance`/`setLeadAppearance` of `settings-builtin-tools-api.mjs`.

use mixdog_core_api::CoreError;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::io_failure;
use mixdog_core_base::support::remove_file_forced;
use mixdog_core_config::config::Config;
use mixdog_core_config::workflow::ids::clean;
use mixdog_core_config::workflow::ids::one_line;
use mixdog_core_config::workflow::pack::read_text_safe;
use serde_json::Value;
use serde_json::json;

use super::AgentDefinitions;
use super::AgentsError;
use super::LeadStatus;
use super::avatar::AvatarUpdate;
use super::avatar::avatar_update;
use super::avatar::normalize_agent_avatar;
use super::edit;
use super::files::LEAD_ID;
use super::lifecycle;

pub const PERSONA_FILE: &str = "PERSONA.md";
pub const AGENT_FILE: &str = "AGENT.md";
const LEAD_FILE_MAX_BYTES: usize = 256 * 1024;
const NAME_MAX_UTF16: usize = 64;

impl LeadStatus {
    /// The answer of `getLeadStatus`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "created": self.created,
            "name": self.name,
            "avatar": self.avatar,
            "homeChatted": self.home_chatted,
            "route": self.route,
        })
    }
}

impl AgentDefinitions {
    /// `getLeadPersona` / `getLeadAgentBody`: the file's trimmed text, empty when it is missing.
    pub async fn lead_file(&self, file: &'static str) -> Result<String, AgentsError> {
        self.job(move |folders, lane| read_text_safe(&folders.identity_dir(lane).join(file))).await
    }

    /// `saveLeadPersona` / `saveLeadAgentBody`: saved empty, the file goes. The answer is what
    /// the file now reads as.
    pub async fn save_lead_file(&self, file: &'static str, text: &Value) -> Result<String, AgentsError> {
        let writes = self.writes()?;
        let value = clean(Some(text));
        if value.len() > LEAD_FILE_MAX_BYTES {
            return Err(AgentsError::Refused(format!("{file} is larger than 256 KB")));
        }
        let dir = self.job(|folders, lane| folders.identity_dir(lane)).await?;
        let turn = lifecycle(&self.folders.data, LEAD_ID).await;
        let (done, _turn) = self
            .write_job(&writes, turn, move |_, lane| -> Result<(), CoreError> {
                let target = dir.join(file);
                if value.is_empty() {
                    // `rmSync(file, { force: true })`: an absent file is fine; a directory there
                    // is `ERR_FS_EISDIR`, and nothing is published.
                    return remove_file_forced(&target).map_err(|failure| io_failure("agent", &failure));
                }
                // The publication makes the folder (`mkdirSync(dir, { recursive: true })`) and
                // words its failure as Node does.
                edit::write_bytes(lane, &target, format!("{value}\n").as_bytes(), &edit::definition_write())
            })
            .await?;
        done.map_err(AgentsError::Lane)?;
        // Mixy's threads take it from their next turn.
        writes.effects.agents_changed().await;
        self.lead_file(file).await
    }

    /// `saveLeadIdentity(payload)`: Mixy's name and face. A name `""` and an avatar `null` go
    /// back to the defaults; a key the payload does not have is kept.
    pub async fn save_lead_identity(&self, payload: &Value) -> Result<Value, AgentsError> {
        let writes = self.writes()?;
        let dir = self.job(|folders, lane| folders.identity_dir(lane)).await?;
        let turn = lifecycle(&self.folders.data, LEAD_ID).await;
        let payload = payload.clone();
        let named = payload.as_object().is_some_and(|keys| keys.contains_key("name"));
        let (done, _turn) = self
            .write_job(&writes, turn, move |_, lane| -> Result<(), CoreError> {
                let text = |text: String| failed("agent", text);
                let mut manifest = edit::read_manifest_coded(lane, &dir)?;
                let keys = payload.as_object();
                if let Some(name) = keys.and_then(|keys| keys.get("name")).map(|name| one_line(Some(name))) {
                    if mixdog_js::utf16_len(&name) > NAME_MAX_UTF16 {
                        return Err(text("name must be 64 characters or fewer".to_owned()));
                    }
                    if name.is_empty() {
                        manifest.shift_remove("name");
                    } else {
                        manifest.insert("name".into(), Value::String(name));
                    }
                }
                let update = keys.and_then(|keys| keys.get("avatar")).map(|avatar| avatar_update(avatar, &dir)).transpose().map_err(text)?;
                match &update {
                    Some(AvatarUpdate { avatar: Some(avatar), .. }) => {
                        manifest.insert("avatar".into(), avatar.clone());
                    }
                    Some(_) => {
                        manifest.shift_remove("avatar");
                    }
                    None => {}
                }
                edit::write_manifest_coded(lane, &dir.join("agent.json"), &manifest)?;
                let stored = manifest.get("avatar").and_then(normalize_agent_avatar);
                edit::sync_avatar_files_coded(lane, &dir, stored.as_ref(), update.as_ref().map_or(&[], |update| &update.writes))
            })
            .await?;
        done.map_err(AgentsError::Lane)?;
        // The name is in Mixy's prompt (her identity line); the face is not.
        if named {
            writes.effects.agents_changed().await;
        }
        Ok(self.lead_status().await?.to_json())
    }

    /// `setLeadCreated(created, description)`: sets the flag (and Mixy's job when given); every
    /// other key stays. A damaged manifest with no good copy is left alone and the status stays
    /// as read: a rewrite would drop her connector policy.
    pub async fn set_lead_created(&self, created: &Value, description: &Value) -> Result<Value, AgentsError> {
        let Some(created) = created.as_bool() else {
            return Err(AgentsError::Refused("created must be a boolean".into()));
        };
        let writes = self.writes()?;
        let dir = self.job(|folders, lane| folders.identity_dir(lane)).await?;
        let turn = lifecycle(&self.folders.data, LEAD_ID).await;
        let job = one_line(Some(description));
        let (done, _turn) = self
            .write_job(&writes, turn, move |_, lane| -> Result<(), CoreError> {
                let Ok(mut manifest) = edit::read_manifest_coded(lane, &dir) else {
                    return Ok(());
                };
                manifest.insert("created".into(), Value::Bool(created));
                if !job.is_empty() {
                    manifest.insert("description".into(), Value::String(job));
                }
                edit::write_manifest_coded(lane, &dir.join("agent.json"), &manifest)
            })
            .await?;
        done.map_err(AgentsError::Lane)?;
        Ok(self.lead_status().await?.to_json())
    }
}

/// The one pixel face every Lead row on the bot page wears, shared by every device that follows
/// this host. Only a mascot look counts; `null` (the default grey pup) is stored as no key.
#[derive(Clone)]
pub struct LeadAppearance {
    config: Config,
}

impl LeadAppearance {
    #[must_use]
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    /// `getLeadAppearance`.
    #[must_use]
    pub fn get(&self) -> Value {
        let stored = self.config.agent().get("leadAvatar").and_then(normalize_agent_avatar);
        json!({ "avatar": stored.filter(|avatar| avatar["kind"] == "mascot") })
    }

    /// `setLeadAppearance(avatar)`.
    pub async fn set(&self, avatar: &Value) -> Result<Value, AgentsError> {
        let before = self.config.agent();
        let mut after = before.clone();
        if avatar.is_null() {
            after.shift_remove("leadAvatar");
        } else {
            let mascot = normalize_agent_avatar(avatar).filter(|avatar| avatar["kind"] == "mascot");
            let mascot = mascot.ok_or_else(|| AgentsError::Refused("usage: setLeadAppearance(a mascot appearance or null)".into()))?;
            after.insert("leadAvatar".into(), mascot);
        }
        self.config.save_agent_config(&before, &after, false).await?;
        Ok(self.get())
    }
}
