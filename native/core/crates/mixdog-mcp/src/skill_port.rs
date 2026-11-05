//! The real `SkillPort` of the `Skill` tool: the skill catalog and its gate, plus the two
//! things only the session knows — re-arming the skill's deferred tools for the thread and
//! reading the thread's live transcript.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::skill::LoadedSkill;
use mixdog_tools::orch::skill::SkillLookup;
use mixdog_tools::orch::skill::SkillPort;
use mixdog_tools::orch::util::PortError;

use crate::skill_catalog::SkillCatalog;
use crate::skill_catalog::SkillLoad;
use crate::skill_deps::SkillToolDependencies;
use crate::skill_state::body_present;
use crate::skills::SkillSource;

/// Makes a loaded skill's tool dependencies available to the thread (the deferred tools it
/// names, and the report of those it cannot get). Called on every load, a repeat load
/// included.
#[async_trait]
pub trait DeferredToolArm: Send + Sync {
    async fn arm(&self, thread: &ThreadId, dependencies: &SkillToolDependencies);
}

/// The live transcript of a thread.
#[async_trait]
pub trait TranscriptTexts: Send + Sync {
    /// The text of each user message the model will see, oldest first (the live turn's
    /// messages when a turn is running, else the thread's).
    async fn user_texts(&self, thread: &ThreadId) -> Vec<String>;
}

pub struct CatalogSkillPort {
    catalog: Arc<SkillCatalog>,
    arm: Arc<dyn DeferredToolArm>,
    transcript: Arc<dyn TranscriptTexts>,
}

impl CatalogSkillPort {
    pub fn new(catalog: Arc<SkillCatalog>, arm: Arc<dyn DeferredToolArm>, transcript: Arc<dyn TranscriptTexts>) -> Self {
        Self { catalog, arm, transcript }
    }
}

fn source_name(source: SkillSource) -> &'static str {
    match source {
        SkillSource::Global => "global",
        SkillSource::Plugin => "plugin",
        SkillSource::Builtin => "builtin",
    }
}

#[async_trait]
impl SkillPort for CatalogSkillPort {
    async fn load(&self, thread: &ThreadId, name: &str, cwd: &AbsPath) -> Result<SkillLookup, PortError> {
        Ok(match self.catalog.load(name, cwd.as_path()).await {
            SkillLoad::Refused(refusal) => SkillLookup::Refused(refusal.to_string()),
            SkillLoad::NotFound => SkillLookup::NotFound,
            SkillLoad::Loaded(resource) => {
                self.arm.arm(thread, &resource.skill.tool_dependencies).await;
                SkillLookup::Loaded(LoadedSkill {
                    content: resource.body,
                    dir: Some(resource.dir),
                    source: source_name(resource.skill.source).to_owned(),
                })
            }
        })
    }

    async fn body_present(&self, thread: &ThreadId, body: &str) -> bool {
        body_present(self.transcript.user_texts(thread).await, body)
    }
}
