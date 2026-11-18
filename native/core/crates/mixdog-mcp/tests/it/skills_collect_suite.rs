//! Collecting skills from the global, plugin and bundled roots, and which collected skill is offered: the first of a name wins in root
//! order, a skill outside a plugin lives in a folder of its own name, a document that does not parse is skipped, and a bundled skill that
//! needs a feature follows that feature rather than the switched-off list.
#![allow(clippy::disallowed_methods, reason = "test fixtures lay out skill folders")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

use mixdog_mcp::skills::SkillGate;
use mixdog_rt::LaneToken;
use mixdog_mcp::skills::SkillRefusal;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills::collect_skills;
use tokio_util::sync::CancellationToken;

fn write(root: &Path, relative: &str, text: &str) {
    let file = root.join(relative);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn document(name: &str, description: &str, extra: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n{extra}---\n\nBody of {name}\n")
}

async fn collected(data: PathBuf, roots: Vec<SkillRoot>) -> Vec<mixdog_mcp::skills::Skill> {
    let tokens = mixdog_rt::testing::tokens();
    tokens.maintenance_io.submit(&CancellationToken::new(), move |lane| collect_skills(lane, &data, &roots)).unwrap().await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_root_to_hold_a_name_wins_and_every_skill_carries_its_source_and_plugin() {
    let dir = tempfile::tempdir().unwrap();
    let (global, plugin, bundled) = (dir.path().join("global"), dir.path().join("plugin"), dir.path().join("bundled"));
    write(&global, "shared/SKILL.md", &document("shared", "From the user.", ""));
    write(&global, "mine/SKILL.md", &document("mine", "Only the user.", "when_to_use: on request\n"));
    write(&plugin, "deep/nested/SKILL.md", &document("shared", "From the plugin.", ""));
    write(&plugin, "deep/other/SKILL.md", &document("planted", "Declared name wins.", ""));
    write(&bundled, "shared/SKILL.md", &document("shared", "From the bundle.", ""));
    write(&bundled, "builtin-only/SKILL.md", &document("builtin-only", "Shipped.", "metadata:\n  requires: [jsRuntime]\n"));
    let roots = vec![
        SkillRoot { dir: global, source: SkillSource::Global, plugin: None },
        SkillRoot { dir: plugin, source: SkillSource::Plugin, plugin: Some("acme".to_owned()) },
        SkillRoot { dir: bundled, source: SkillSource::Builtin, plugin: None },
    ];
    let skills = collected(dir.path().join("data"), roots).await;
    let row = |name: &str| skills.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("{name} missing from {:?}", skills.iter().map(|s| &s.name).collect::<Vec<_>>()));
    assert_eq!(skills.len(), 4);
    assert_eq!((row("shared").description.as_str(), row("shared").source, row("shared").plugin.clone()), ("From the user.", SkillSource::Global, None));
    assert_eq!((row("mine").when_to_use.as_str(), row("mine").source), ("on request", SkillSource::Global));
    assert_eq!((row("planted").source, row("planted").plugin.as_deref()), (SkillSource::Plugin, Some("acme")));
    assert_eq!((row("builtin-only").source, row("builtin-only").requires.clone()), (SkillSource::Builtin, vec!["jsRuntime".to_owned()]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_skill_in_a_folder_of_another_name_or_with_a_broken_document_is_not_collected() {
    let dir = tempfile::tempdir().unwrap();
    let global = dir.path().join("global");
    write(&global, "folder-name/SKILL.md", &document("other-name", "Misfiled.", ""));
    write(&global, "no-frontmatter/SKILL.md", "just text, no frontmatter\n");
    write(&global, "good/SKILL.md", &document("good", "Fine.", ""));
    let skills = collected(dir.path().join("data"), vec![SkillRoot { dir: global, source: SkillSource::Global, plugin: None }]).await;
    assert_eq!(skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["good"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bundled_skill_follows_its_feature_and_every_other_follows_the_switched_off_list() {
    let dir = tempfile::tempdir().unwrap();
    let (global, bundled) = (dir.path().join("global"), dir.path().join("bundled"));
    write(&global, "mine/SKILL.md", &document("mine", "Only the user.", ""));
    write(&bundled, "runner/SKILL.md", &document("runner", "Needs the runtime.", "metadata:\n  requires: [jsRuntime]\n"));
    let skills = collected(
        dir.path().join("data"),
        vec![SkillRoot { dir: global, source: SkillSource::Global, plugin: None }, SkillRoot { dir: bundled, source: SkillSource::Builtin, plugin: None }],
    )
    .await;
    let (mine, runner) = (skills.iter().find(|s| s.name == "mine").unwrap(), skills.iter().find(|s| s.name == "runner").unwrap());
    let names = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect::<HashSet<_>>();

    let off = SkillGate { disabled: names(&["mine", "runner"]), active_features: names(&["jsRuntime"]) };
    assert_eq!(off.refusal(mine), Some(SkillRefusal::Disabled("mine".to_owned())));
    assert_eq!(off.refusal(runner), None, "its feature is on, the disabled list does not reach it");

    let no_feature = SkillGate { disabled: HashSet::new(), active_features: HashSet::new() };
    assert_eq!(no_feature.refusal(runner), Some(SkillRefusal::MissingFeature { skill: "runner".to_owned(), feature: "jsRuntime".to_owned() }));
    assert_eq!(
        no_feature.refusal(runner).unwrap().to_string(),
        "Error: skill \"runner\" needs the jsRuntime built-in feature, which is not installed or is switched off in Extensions → Plugin → Built-in"
    );
    assert_eq!(no_feature.refusal(mine), None);
    assert_eq!(off.offered(&skills).iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["runner"]);
}