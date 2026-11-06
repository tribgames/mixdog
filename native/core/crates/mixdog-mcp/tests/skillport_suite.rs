//! `CatalogSkillPort` against what today's Node product answered for the Skill tool's lookup
//! (`tests/golden/skillport.mjs` → `skillport.json`): the refusal text, or the loaded body,
//! directory and source. The golden carries Windows paths, so the replay runs only there.
#![cfg(windows)]
#![allow(clippy::disallowed_methods, reason = "test fixtures lay out skill folders")]

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skill_port::CatalogSkillPort;
use mixdog_mcp::skill_port::DeferredToolArm;
use mixdog_mcp::skill_port::TranscriptTexts;
use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::skills::SkillGate;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::skill::SkillLookup;
use mixdog_tools::orch::skill::SkillPort;
use serde_json::Value;

struct Settings(SkillSettings);

impl SkillSettingsSource for Settings {
    fn current(&self) -> SkillSettings {
        self.0.clone()
    }
}

struct NoArm;

#[async_trait]
impl DeferredToolArm for NoArm {
    async fn arm(&self, _: &ThreadId, _: &SkillToolDependencies) {}
}

struct NoTranscript;

#[async_trait]
impl TranscriptTexts for NoTranscript {
    async fn user_texts(&self, _: &ThreadId) -> Vec<String> {
        Vec::new()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_skill_lookup_answers_what_node_does() {
    let golden: Value = serde_json::from_str(include_str!("golden/skillport.json")).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let base = scratch.path().to_string_lossy().into_owned();
    let unmask = |text: &str| text.replace("<BASE>", &base);
    let skills = Path::new(&base).join("data").join("skills");
    for (relative, text) in golden["fixtures"].as_object().unwrap() {
        let file = skills.join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text.as_str().unwrap()).unwrap();
    }
    let escaped_base = base.replace('\\', "\\\\");
    let config: Value = serde_json::from_str(&serde_json::to_string(&golden["config"]).unwrap().replace("<BASE>", &escaped_base)).unwrap();
    let disabled = config["skills"]["disabled"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().trim().to_lowercase()).collect();
    let settings = SkillSettings {
        gate: SkillGate { disabled, active_features: Default::default() },
        scopes: ExtensionScopes::from_config(&config["extensionScopes"]),
    };
    let root = SkillRoot { dir: skills.clone(), source: SkillSource::Global, plugin: None };
    let tokens = mixdog_rt::testing::tokens();
    let catalog = SkillCatalog::new(
        Path::new(&base).join("data"),
        tokens.maintenance_io,
        Arc::new(move |_| vec![root.clone()]),
        Arc::new(Settings(settings)),
        &SkillsWatch::new(),
    );
    let port = CatalogSkillPort::new(catalog, Arc::new(NoArm), Arc::new(NoTranscript));
    let thread = ThreadId::from("t");
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let cwd = AbsPath::new(unmask(&case["cwd"].as_str().unwrap().replace('\\', "\\"))).unwrap();
        let got = port.load(&thread, name, &cwd).await.unwrap();
        let label = format!("{name:?} at {}", case["cwd"]);
        match (got, case["refusal"].as_str(), case["resource"].as_object()) {
            (SkillLookup::Refused(text), Some(expected), None) => assert_eq!(text, expected, "{label}"),
            (SkillLookup::NotFound, None, None) => {}
            (SkillLookup::Loaded(loaded), None, Some(resource)) => {
                assert_eq!(loaded.content, resource["content"].as_str().unwrap(), "{label}: body");
                assert_eq!(loaded.dir.as_deref(), Some(unmask(resource["dir"].as_str().unwrap()).as_str()), "{label}: dir");
                assert_eq!(loaded.source, resource["source"].as_str().unwrap(), "{label}: source");
            }
            (other, refusal, resource) => panic!("{label}: got {other:?}, Node {refusal:?} {resource:?}"),
        }
    }
}
