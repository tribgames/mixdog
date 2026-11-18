//! The Skill tool's lookup over the skill catalog: a skill is found by its name once trimmed and answers its body, folder and source;
//! a name nobody has is not found; a disabled skill is refused in the words the tool shows the model.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skill_port::CatalogSkillPort;
use mixdog_mcp::skill_port::DeferredToolArm;
use mixdog_mcp::skill_port::TranscriptTexts;
use mixdog_mcp::skills::SkillGate;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::skill::ArmNotice;
use mixdog_tools::orch::skill::SkillLookup;
use mixdog_tools::orch::skill::SkillPort;
use mixdog_tools::orch::util::PortError;
use serde_json::json;

struct Settings(SkillSettings);

impl SkillSettingsSource for Settings {
    fn current(&self) -> SkillSettings {
        self.0.clone()
    }
}

struct NoArm;

#[async_trait]
impl DeferredToolArm for NoArm {
    async fn arm(&self, _: &ThreadId, _: &SkillToolDependencies) -> Result<ArmNotice, PortError> {
        Ok(ArmNotice::default())
    }
}

struct NoTranscript;

#[async_trait]
impl TranscriptTexts for NoTranscript {
    async fn user_texts(&self, _: &ThreadId) -> Result<Vec<String>, PortError> {
        Ok(Vec::new())
    }
}

fn port_over(base: &Path, disabled: &[&str]) -> CatalogSkillPort {
    let skills = base.join("data").join("skills");
    let write = |name: &str, text: &str| {
        let folder = skills.join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("SKILL.md"), text).unwrap();
    };
    write("demo", "---\nname: demo\ndescription: Does a thing.\n---\n\nDo the thing.\n");
    write("other", "---\nname: other\ndescription: Another.\n---\n\nOther body.\n");
    let settings = SkillSettings {
        gate: SkillGate { disabled: disabled.iter().map(|name| (*name).to_owned()).collect(), active_features: Default::default() },
        scopes: ExtensionScopes::from_config(&json!({})),
    };
    let root = SkillRoot { dir: skills, source: SkillSource::Global, plugin: None };
    let tokens = mixdog_rt::testing::tokens();
    let catalog = SkillCatalog::new(base.join("data"), tokens.maintenance_io, Arc::new(move |_| vec![root.clone()]), Arc::new(Settings(settings)), &SkillsWatch::new());
    CatalogSkillPort::new(catalog, Arc::new(NoArm), Arc::new(NoTranscript))
}

async fn look_up(port: &CatalogSkillPort, base: &Path, name: &str) -> SkillLookup {
    port.load(&ThreadId::from("t"), name, &AbsPath::new(base.to_path_buf()).unwrap()).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_skill_is_found_by_its_trimmed_name_and_answers_its_body_its_folder_and_its_source() {
    let scratch = tempfile::tempdir().unwrap();
    let port = port_over(scratch.path(), &[]);
    for name in ["demo", "  demo\n"] {
        let SkillLookup::Loaded(loaded) = look_up(&port, scratch.path(), name).await else { panic!("{name:?} was not loaded") };
        assert_eq!(loaded.content.trim(), "Do the thing.");
        assert_eq!(loaded.source, "global");
        assert!(loaded.dir.as_deref().is_some_and(|dir| dir.contains("demo")), "{:?}", loaded.dir);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_name_no_skill_has_is_not_found() {
    let scratch = tempfile::tempdir().unwrap();
    let port = port_over(scratch.path(), &[]);
    for name in ["missing", "", "DEMO"] {
        assert!(matches!(look_up(&port, scratch.path(), name).await, SkillLookup::NotFound), "{name:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disabled_skill_is_refused_in_the_words_the_model_is_shown_and_the_others_still_load() {
    let scratch = tempfile::tempdir().unwrap();
    let port = port_over(scratch.path(), &["demo"]);
    match look_up(&port, scratch.path(), "demo").await {
        SkillLookup::Refused(text) => assert_eq!(text, "Error: skill \"demo\" is disabled"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(look_up(&port, scratch.path(), "other").await, SkillLookup::Loaded(_)));
}