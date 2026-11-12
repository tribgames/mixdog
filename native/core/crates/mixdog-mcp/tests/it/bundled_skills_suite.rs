//! `scripts/skill-creator-validator.test.mjs`, case "the bundled skill-creator validates and is collected as a built-in skill",
//! recorded from the reference tree (`fixtures/skill-creator-validator-cases`, `record-skill-creator-validator-cases.mjs`): the
//! collector run over the bundled skills folder as its one built-in root finds the skills Node's `collectSkills` found, in order,
//! each with its description, trigger text, source, plugin, required features, tool dependencies and where they came from.
//! The recorded validator result is compared whole with what the shipped validator script returns under node.
#![allow(clippy::disallowed_methods, reason = "the bundled skills folder is read from the checkout")]

use std::path::PathBuf;

use mixdog_mcp::skills::{self, SkillRoot, SkillSource};
use mixdog_rt::LaneToken;
use mixdog_testkit::Exact;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/skill-creator-validator-cases/golden.json");

/// The result the shipped validator (`validateSkillDirectory`, the script the skill-creator skill runs under node) gives for the
/// bundled skill-creator folder, with the checkout's path written `<tree>` as the recording writes it.
fn validate_bundled_skill_creator(tree: &std::path::Path) -> Value {
    let script = tree.join("src/defaults/skills/skill-creator/scripts/validate-skill.mjs");
    let folder = tree.join("src/defaults/skills/skill-creator");
    let program = "import { pathToFileURL } from 'node:url'; \
        const { validateSkillDirectory } = await import(pathToFileURL(process.argv[1]).href); \
        console.log(JSON.stringify(validateSkillDirectory(process.argv[2])));";
    let mut command = std::process::Command::new("node");
    command.args(["--input-type=module", "-e", program]).arg(&script).arg(&folder);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let output = command.output().expect("node runs the shipped validator");
    assert!(output.status.success(), "validator failed: {}", String::from_utf8_lossy(&output.stderr));
    let mut result: Value = serde_json::from_slice(
        // the script also runs its own command line (argv[1] is the script here) and prints `Valid skill: <name>` first
        output.stdout.split(|b| *b == b'\n').rfind(|line| !line.is_empty()).unwrap_or_default(),
    ).unwrap_or_else(|e| panic!("the validator printed JSON: {e}; stdout {:?}, stderr {:?}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)));
    let directory = result["skill"]["directory"].as_str().expect("a validated folder").replace('\\', "/");
    let root = tree.to_string_lossy().replace('\\', "/");
    result["skill"]["directory"] = Value::String(directory.replacen(&root, "<tree>", 1));
    result
}

#[tokio::test]
async fn the_bundled_skills_are_collected_as_node_collected_them() {
    let recorded = Exact::decode(&serde_json::from_str(&GOLDEN).unwrap()).unwrap();
    let observed = recorded.get("cases").as_array()[0].get("observed");

    let tree = PathBuf::from(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap().to_owned();
    let validated = validate_bundled_skill_creator(&tree);
    if let Some(difference) = Exact::plain(&validated).difference(observed.get("validated")) {
        panic!("the validator's result: {difference}");
    }

    let bundled = tree.join("src/defaults/skills");
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
            "declaredToolDependencies": skill.tool_dependencies.declared,
            "dependencySource": dependency_source,
            "dependencyIssues": skill.tool_dependencies.issues,
        });
        assert_eq!(row, want.to_plain().unwrap(), "{name}");
    }
    assert!(found.iter().any(|skill| skill.name == "skill-creator"));
}
