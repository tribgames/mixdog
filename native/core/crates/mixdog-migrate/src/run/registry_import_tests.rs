//! The project list of a Node profile after `migrate` and the first start of the core: what the desktop lists for the same profile
//! (the recording `project-registry-import-cases`: the real DesktopProjectRegistry over the real projects.mjs), through the real
//! `Migrator` and the real `Catalog`.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixtures build the profile with blocking std::fs"
)]

use std::path::Path;

use mixdog_store::state::CoreState;
use mixdog_workspace::catalog::Catalog;
use mixdog_workspace::catalog::display_name;
use mixdog_workspace::lanes::Lanes;
use serde_json::Value;
use serde_json::json;

use super::tests::drivers;
use super::*;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/project-registry-import-cases/golden.json");

/// The profile of a recorded case under `root`: the folders that exist, `home/projects.json` and `profile/desktop-projects.json` as the
/// recorder wrote them (a project is `<root>/<name>`).
fn prepare(root: &Path, profile: &Value) -> MigrationRoots {
    let (data, home, user) = (root.join("data"), root.join("home"), root.join("profile"));
    for dir in [&data, &home, &user] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let at = |name: &str| root.join(name).to_string_lossy().into_owned();
    let registry = profile["registry"].as_array();
    for entry in registry.into_iter().flatten() {
        let name = entry["path"].as_str().unwrap();
        if !profile["missing"].as_array().is_some_and(|missing| missing.iter().any(|m| m == name)) {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
    }
    if let Some(registry) = registry {
        let projects: Vec<Value> = registry
            .iter()
            .map(|entry| {
                let mut project = entry.as_object().unwrap().clone();
                let name = project["path"].as_str().unwrap().to_owned();
                project.entry("name").or_insert(json!(name));
                project.insert("path".into(), json!(at(&name)));
                Value::Object(project)
            })
            .collect();
        std::fs::write(home.join("projects.json"), json!({ "projects": projects }).to_string()).unwrap();
    }
    if let Some(preferences) = profile.get("preferences") {
        let aliases: serde_json::Map<String, Value> = preferences["aliases"].as_object().unwrap().iter().map(|(name, alias)| (at(name), alias.clone())).collect();
        let hidden: Vec<String> = preferences["hidden"].as_array().unwrap().iter().map(|name| at(name.as_str().unwrap())).collect();
        std::fs::write(user.join("desktop-projects.json"), json!({ "version": 2, "aliases": aliases, "hidden": hidden }).to_string()).unwrap();
    }
    MigrationRoots { data, home, profile: Some(user) }
}

/// The recorded answer with `<root>` as this run's root.
fn with_root(value: &Value, root: &str) -> Value {
    match value {
        Value::String(text) => json!(text.replace("<root>", root)),
        Value::Array(items) => Value::Array(items.iter().map(|item| with_root(item, root)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), with_root(item, root))).collect()),
        other => other.clone(),
    }
}

fn migrate(roots: &MigrationRoots) {
    Migrator::new(roots.clone(), drivers(), MigrateOptions { workers: 1, fault: None, verified: None }).run().unwrap();
}

fn catalog(roots: &MigrationRoots) -> Catalog {
    let tokens = mixdog_rt::testing::tokens();
    std::fs::create_dir_all(roots.data.join("state")).unwrap();
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &roots.data.join("state/core.sqlite")).unwrap();
    Catalog::new(state, Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk })
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

/// What the desktop's `list()` answers: name, path and alias of each project in order, and the first twelve paths.
async fn listed(catalog: &Catalog) -> Value {
    let rows = catalog.list().await.unwrap();
    let projects: Vec<Value> = rows.iter().map(|row| json!({ "name": display_name(row), "path": row.path, "alias": row.alias })).collect();
    let recents: Vec<&String> = rows.iter().map(|row| &row.path).take(12).collect();
    json!({ "projects": projects, "recents": recents })
}

#[test]
fn a_migrated_node_profile_lists_the_projects_the_desktop_lists() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let roots = prepare(dir.path(), &case["observed"]["profile"]);
        migrate(&roots);
        let answer = block_on(async {
            let catalog = catalog(&roots);
            catalog.import_registry(&roots.home).await.unwrap();
            listed(&catalog).await
        });
        let expected = with_root(&case["observed"]["listed"], &dir.path().to_string_lossy());
        if answer != expected {
            failures.push(format!("{}\n  desktop: {expected}\n  core:    {answer}", case["case"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A `projects.json` cut short is no empty registry: the step fails and stays open, the file and the rows are as they were (the
/// file is the way back to Node), and the file is imported once it reads again.
#[test]
fn a_damaged_registry_is_left_byte_for_byte_and_imported_once_it_reads() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let case = golden["cases"].as_array().unwrap().iter().find(|c| c["case"].as_str().unwrap().starts_with("both files")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let roots = prepare(dir.path(), &case["observed"]["profile"]);
    migrate(&roots);
    let file = roots.home.join("projects.json");
    let whole = std::fs::read(&file).unwrap();
    let cut = whole[..whole.len() / 2].to_vec();
    std::fs::write(&file, &cut).unwrap();
    let beside = || {
        let mut names: Vec<String> = std::fs::read_dir(&roots.home).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).filter(|name| name.starts_with("projects.json")).collect();
        names.sort();
        names
    };
    block_on(async {
        let catalog = catalog(&roots);
        let before = catalog.list().await.unwrap();
        assert!(catalog.import_registry(&roots.home).await.is_err(), "a damaged registry is not an empty one");
        assert_eq!(std::fs::read(&file).unwrap(), cut, "the file is left byte for byte");
        assert_eq!(beside(), ["projects.json"], "nothing was moved aside or written beside it");
        assert_eq!(catalog.list().await.unwrap(), before, "the rows are as they were");
        std::fs::write(&file, &whole).unwrap();
        assert!(catalog.import_registry(&roots.home).await.unwrap(), "the step was left open");
        assert_eq!(listed(&catalog).await, with_root(&case["observed"]["listed"], &dir.path().to_string_lossy()));
        assert_eq!(std::fs::read(&file).unwrap(), whole, "the imported file is left byte for byte");
    });
}

#[test]
fn a_profile_migrated_by_an_earlier_build_joins_the_registry_once_and_keeps_its_alias_and_touch() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let case = golden["cases"].as_array().unwrap().iter().find(|c| c["case"].as_str().unwrap().starts_with("both files")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let roots = prepare(dir.path(), &case["observed"]["profile"]);
    // The earlier build: rows from `desktop-projects.json` only (the alias of `alpha`, and of `ghost`, which no registry has), then a touch.
    migrate(&roots);
    let at = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
    block_on(async {
        let catalog = catalog(&roots);
        // The earlier build listed `ghost` too (a preference row), so it could be selected there: that does not register it.
        catalog.touch(&at("ghost"), None).await.unwrap();
        let touched = catalog.touch(&at("alpha"), None).await.unwrap()["lastUsedAt"].as_i64().unwrap();
        assert!(touched > 5000, "the touch is newer than every recorded recency");
        assert!(catalog.import_registry(&roots.home).await.unwrap(), "the step runs on this start");
        let rows = catalog.list().await.unwrap();
        let paths: Vec<&str> = rows.iter().map(|row| row.path.as_str()).collect();
        assert_eq!(paths, [at("alpha"), at("beta"), at("epsilon"), at("delta"), at("gamma")], "the touched project leads, the registry's others follow, `ghost` is not listed");
        assert_eq!((rows[0].alias.as_deref(), rows[0].last_used_at), (Some("The A"), Some(touched)));
        assert_eq!(display_name(&rows[2]), "Zed");
        // Once: the file changing afterwards, or the start repeating, changes nothing.
        std::fs::write(roots.home.join("projects.json"), json!({ "projects": [] }).to_string()).unwrap();
        assert!(!catalog.import_registry(&roots.home).await.unwrap());
        assert_eq!(catalog.list().await.unwrap(), rows);
        // After the cut the rows are the registry: a project made or removed now is what every reader lists.
        let made = dir.path().join("made");
        std::fs::create_dir(&made).unwrap();
        catalog.add(&made.to_string_lossy(), &mixdog_rt::CancellationToken::new(), None).await.unwrap();
        catalog.remove(&at("beta"), None).await.unwrap();
        let after: Vec<String> = catalog.list().await.unwrap().into_iter().map(|row| row.path).collect();
        assert!(after.contains(&at("made")) && !after.contains(&at("beta")), "{after:?}");
    });
}
