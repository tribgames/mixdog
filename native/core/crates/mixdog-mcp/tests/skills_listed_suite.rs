//! `SkillCatalog::any_visible_now`: whether a session's tool list offers `Skill`, answered
//! without waiting on the lane (`skills.length` of Node's `resolveSessionTools`).
#![allow(clippy::disallowed_methods, reason = "test fixtures write skill folders directly")]

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::scopes::ScopeKind;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_watch::SkillsWatch;

#[derive(Default)]
struct Settings(Mutex<SkillSettings>);

impl SkillSettingsSource for Settings {
    fn current(&self) -> SkillSettings {
        self.0.lock().unwrap().clone()
    }
}

fn add_skill(root: &Path, name: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: Use when {name}.\n---\n\nbody\n")).unwrap();
}

/// Waits until the background collection a stale read started has finished.
async fn settled(catalog: &Arc<SkillCatalog>, cwd: &Path, wanted: bool) {
    for _ in 0..200 {
        if catalog.any_visible_now(cwd) == wanted {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the answer never became {wanted}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_answer_follows_the_collected_list_settings_and_scope() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("skills");
    std::fs::create_dir_all(&root).unwrap();
    let settings = Arc::new(Settings::default());
    let watch = SkillsWatch::new();
    let roots = SkillRoot { dir: root.clone(), source: SkillSource::Global, plugin: None };
    let catalog = SkillCatalog::new(dir.path().to_path_buf(), tokens.maintenance_io, Arc::new(move || vec![roots.clone()]), settings.clone(), &watch);
    let cwd = dir.path().join("project");

    // Nothing collected yet: the answer is no, and a collection starts.
    assert!(!catalog.any_visible_now(&cwd));
    assert!(catalog.skills().await.unwrap().is_empty());
    assert!(!catalog.any_visible_now(&cwd));

    // A skill added through the app invalidates the list; the next reads see it once collected.
    add_skill(&root, "alpha");
    catalog.invalidate();
    settled(&catalog, &cwd, true).await;

    // Switched off in settings: hidden at once, no collection needed.
    settings.0.lock().unwrap().gate.disabled.insert("alpha".to_owned());
    assert!(!catalog.any_visible_now(&cwd));
    settings.0.lock().unwrap().gate.disabled.clear();
    assert!(catalog.any_visible_now(&cwd));

    // Limited to another project: hidden here, seen there.
    let mut scopes = ExtensionScopes::default();
    scopes.set(ScopeKind::Skills, "alpha", vec![dir.path().join("elsewhere").to_string_lossy().into_owned()]);
    settings.0.lock().unwrap().scopes = scopes;
    assert!(!catalog.any_visible_now(&cwd));
    assert!(catalog.any_visible_now(&dir.path().join("elsewhere").join("sub")));

    // Removed: the list empties after the next collection.
    settings.0.lock().unwrap().scopes = ExtensionScopes::default();
    std::fs::remove_dir_all(root.join("alpha")).unwrap();
    catalog.invalidate();
    settled(&catalog, &cwd, false).await;
}
