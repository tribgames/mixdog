//! `scripts/skill-creator-validator.test.mjs`, case "the bundled skill-creator validates and is collected as a built-in skill",
//! recorded from the reference tree (`fixtures/skill-creator-validator-cases`, `record-skill-creator-validator-cases.mjs`): the
//! collector run over the bundled skills folder as its one built-in root finds the skills Node's `collectSkills` found, in order,
//! each with its description, trigger text, source, plugin, required features, tool dependencies and where they came from.
//! (The validator is a shipped script, not Rust: its recorded verdict is only asserted to be the clean one.)
#![allow(clippy::disallowed_methods, reason = "the bundled skills folder is read from the checkout")]

use std::path::PathBuf;

use mixdog_mcp::skills::{self, SkillRoot, SkillSource};
use mixdog_rt::LaneToken;
use mixdog_testkit::Exact;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/skill-creator-validator-cases/golden.json");

#[tokio::test]
async fn the_bundled_skills_are_collected_as_node_collected_them() {
    let recorded = Exact::decode(&serde_json::from_str(&GOLDEN).unwrap()).unwrap();
    let observed = recorded.get("cases").as_array()[0].get("observed");
    assert_eq!(observed.get("validated").get("ok").as_bool(), true);
    assert!(observed.get("validated").get("errors").as_array().is_empty());

    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../src/defaults/skills");
    let data = tempfile::tempdir().unwrap();
    let roots = vec![SkillRoot { dir: bundled.clone(), source: SkillSource::Builtin, plugin: None }];
    let data_dir = data.path().to_owned();
    let tokens = mixdog_rt::testing::tokens();
    let found = tokens
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| skills::collect_skills(lane, &data_dir, &roots))
        .unwrap()
        .await
        .unwrap();

    let expected = observed.get("collected").as_array();
    assert_eq!(found.len(), expected.len(), "skills collected");
    for (skill, want) in found.iter().zip(expected) {
        let name = want.get("name").as_str();
        let folder = skill.file_path.parent().unwrap().file_name().unwrap().to_str().unwrap();
        let dependencies: Vec<Value> = skill
            .tool_dependencies
            .manifest_names()
            .iter()
            .map(|entry| match entry.strip_prefix("mcp:") {
                Some(server) => serde_json::json!({"type": "mcp", "value": server}),
                None => serde_json::json!({"type": "tool", "value": entry}),
            })
            .collect();
        let source = match skill.source {
            SkillSource::Builtin => "builtin",
            SkillSource::Global => "global",
            SkillSource::Plugin => "plugin",
        };
        let dependency_source = skill.tool_dependencies.source.name();
        let row = serde_json::json!({
            "name": skill.name,
            "description": skill.description,
            "whenToUse": skill.when_to_use,
            "filePath": format!("<tree>/src/defaults/skills/{folder}/SKILL.md"),
            "source": source,
            "plugin": skill.plugin,
            "requires": skill.requires,
            "toolDependencies": dependencies,
            "dependencySource": dependency_source,
        });
        let mut want_row = want.to_plain().unwrap();
        for dropped in ["declaredToolDependencies", "dependencyIssues"] {
            want_row.as_object_mut().unwrap().remove(dropped);
        }
        assert_eq!(row, want_row, "{name}");
    }
    assert!(found.iter().any(|skill| skill.name == "skill-creator"));
}
