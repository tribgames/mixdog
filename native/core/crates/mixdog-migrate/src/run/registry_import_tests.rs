//! The project list of a 1.4.5 profile (`projects.json` and the desktop's `desktop-projects.json`, written by the test in the
//! formats 1.4.5 wrote) after `migrate` and the first start of the core, through the real `Migrator` and the real `Catalog`.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixtures build the profile with blocking std::fs")]

use std::path::Path;

use mixdog_store::state::CoreState;
use mixdog_workspace::catalog::Catalog;
use mixdog_workspace::catalog::display_name;
use mixdog_workspace::lanes::Lanes;
use serde_json::Value;
use serde_json::json;

use super::tests::drivers;
use super::*;

/// One 1.4.5 profile and the list it gives: (display name, folder, alias) in order.
struct Case {
    name: &'static str,
    profile: Value,
    listed: Vec<(&'static str, &'static str, Option<&'static str>)>,
}

fn registry() -> Value {
    json!([
        {"path": "alpha", "addedAt": 1000},
        {"path": "beta", "name": "beta", "addedAt": 3000, "lastSelectedAt": 5000},
        {"path": "gamma", "addedAt": 2000, "lastSelectedAt": 2500},
        {"path": "delta", "addedAt": 2500},
        {"path": "epsilon", "name": "Zed", "addedAt": 4000}
    ])
}

const ORDER: [(&str, &str); 5] = [("beta", "beta"), ("Zed", "epsilon"), ("delta", "delta"), ("gamma", "gamma"), ("alpha", "alpha")];

fn cases() -> Vec<Case> {
    let plain = || ORDER.iter().map(|(name, folder)| (*name, *folder, None)).collect::<Vec<_>>();
    let mut alias_a = plain();
    alias_a[4].2 = Some("The A");
    let mut alias_b = plain();
    alias_b[0].2 = Some("The B");
    let mut vanished = plain();
    vanished.insert(0, ("vanished", "vanished", None));
    let mut with_vanished = registry();
    with_vanished.as_array_mut().unwrap().push(json!({"path": "vanished", "addedAt": 6000}));
    vec![
        Case { name: "projects.json only", profile: json!({"registry": registry()}), listed: plain() },
        Case {
            name: "both files: aliases, one of a path that is not registered, one blank",
            profile: json!({"registry": registry(), "preferences": {"aliases": {"alpha": "The A", "gamma": "  ", "ghost": "Ghost"}, "hidden": []}}),
            listed: alias_a,
        },
        Case {
            name: "a tombstoned path that is still registered",
            profile: json!({"registry": registry(), "preferences": {"aliases": {"beta": "The B"}, "hidden": ["beta", "ghost"]}}),
            listed: alias_b,
        },
        Case { name: "an entry whose folder no longer exists", profile: json!({"registry": with_vanished, "missing": ["vanished"]}), listed: vanished },
        Case { name: "neither file", profile: json!({}), listed: Vec::new() },
        Case {
            name: "desktop-projects.json only: nothing is registered",
            profile: json!({"preferences": {"aliases": {"alpha": "The A"}, "hidden": ["beta"]}}),
            listed: Vec::new(),
        },
    ]
}

/// What the desktop lists for `case` in the profile rooted at `root`.
fn expected(case: &Case, root: &Path) -> Value {
    let at = |folder: &str| root.join(folder).to_string_lossy().into_owned();
    let projects: Vec<Value> = case.listed.iter().map(|(name, folder, alias)| json!({"name": name, "path": at(folder), "alias": alias})).collect();
    let recents: Vec<String> = case.listed.iter().map(|(_, folder, _)| at(folder)).collect();
    json!({"projects": projects, "recents": recents})
}

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
        let aliases: serde_json::Map<String, Value> =
            preferences["aliases"].as_object().unwrap().iter().map(|(name, alias)| (at(name), alias.clone())).collect();
        let hidden: Vec<String> = preferences["hidden"].as_array().unwrap().iter().map(|name| at(name.as_str().unwrap())).collect();
        std::fs::write(user.join("desktop-projects.json"), json!({ "version": 2, "aliases": aliases, "hidden": hidden }).to_string()).unwrap();
    }
    MigrationRoots { data, home, profile: Some(user) }
}

fn migrate(roots: &MigrationRoots) {
    Migrator::new(roots.clone(), drivers(), MigrateOptions { workers: 1, fault: None, verified: None }).run().unwrap();
}

fn catalog(roots: &MigrationRoots) -> Catalog {
    let tokens = mixdog_rt::testing::tokens();
    std::fs::create_dir_all(roots.data.join("state")).unwrap();
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &roots.data.join("state/core.sqlite")).unwrap();
    Catalog::new(
        state,
        Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk },
    )
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
fn a_migrated_145_profile_lists_the_projects_the_desktop_lists() {
    let mut failures = Vec::new();
    for case in cases() {
        let dir = tempfile::tempdir().unwrap();
        let roots = prepare(dir.path(), &case.profile);
        migrate(&roots);
        let answer = block_on(async {
            let catalog = catalog(&roots);
            catalog.import_registry(&roots.home).await.unwrap();
            listed(&catalog).await
        });
        let want = expected(&case, dir.path());
        if answer != want {
            failures.push(format!("{}\n  desktop: {want}\n  core:    {answer}", case.name));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A `projects.json` cut short is no empty registry: the step fails and stays open, the file and the rows are as they were (the
/// file is the way back to Node), and the file is imported once it reads again.
#[test]
fn a_damaged_registry_is_left_byte_for_byte_and_imported_once_it_reads() {
    let golden = cases();
    let case = &golden[1];
    let dir = tempfile::tempdir().unwrap();
    let roots = prepare(dir.path(), &case.profile);
    migrate(&roots);
    let file = roots.home.join("projects.json");
    let whole = std::fs::read(&file).unwrap();
    let cut = whole[..whole.len() / 2].to_vec();
    std::fs::write(&file, &cut).unwrap();
    let beside = || {
        let mut names: Vec<String> = std::fs::read_dir(&roots.home)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("projects.json"))
            .collect();
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
        assert_eq!(listed(&catalog).await, expected(case, dir.path()));
        assert_eq!(std::fs::read(&file).unwrap(), whole, "the imported file is left byte for byte");
    });
}

#[test]
fn a_profile_migrated_by_an_earlier_build_joins_the_registry_once_and_keeps_its_alias_and_touch() {
    let golden = cases();
    let case = &golden[1];
    let dir = tempfile::tempdir().unwrap();
    let roots = prepare(dir.path(), &case.profile);
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
        assert_eq!(
            paths,
            [at("alpha"), at("beta"), at("epsilon"), at("delta"), at("gamma")],
            "the touched project leads, the registry's others follow, `ghost` is not listed"
        );
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
