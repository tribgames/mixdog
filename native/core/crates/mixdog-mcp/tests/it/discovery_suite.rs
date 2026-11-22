//! Skills, plugins, hooks and launchers against real directories.
#![allow(clippy::disallowed_methods, reason = "test fixtures write and inspect directories directly")]

use std::collections::HashSet;
use std::path::Path;

use mixdog_mcp::hooks;
use mixdog_mcp::launcher;
use mixdog_mcp::plugins;
use mixdog_mcp::skills;
use mixdog_rt::LaneToken;
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn skill_md(name: &str, extra: &str) -> String {
    format!("---\nname: {name}\ndescription: {name} description\nwhen_to_use: use {name}\n{extra}---\n\nbody of {name}\n")
}

async fn collect_fixture_skills(tokens: &mixdog_rt::LaneTokens, dir: &Path) -> (Vec<skills::Skill>, std::path::PathBuf) {
    let global = dir.join("global");
    let plugin = dir.join("plug").join("skills");
    let builtin = dir.join("builtin");
    write(&global.join("alpha").join("SKILL.md"), &skill_md("alpha", ""));
    write(&global.join("wrong-folder").join("SKILL.md"), &skill_md("beta", ""));
    write(&global.join("needs-js").join("SKILL.md"), &skill_md("needs-js", "metadata:\n  requires: jsRuntime\n"));
    write(&plugin.join("nested").join("deep").join("SKILL.md"), &skill_md("gamma", ""));
    write(&builtin.join("alpha").join("SKILL.md"), &skill_md("alpha", "").replace("alpha description", "shadowed"));
    write(&builtin.join("broken").join("SKILL.md"), "no frontmatter");
    write(
        &global.join("alpha").join("agents").join("openai.yaml"),
        "dependencies:\n  tools:\n    - type: mcp\n      value: github\n    - type: tool\n      value: read\n",
    );
    let data = dir.join("data");
    let roots = vec![
        skills::SkillRoot { dir: global, source: skills::SkillSource::Global, plugin: None },
        skills::SkillRoot { dir: plugin, source: skills::SkillSource::Plugin, plugin: Some("plug".to_owned()) },
        skills::SkillRoot { dir: builtin, source: skills::SkillSource::Builtin, plugin: None },
    ];
    let found = {
        let data = data.clone();
        tokens.maintenance_io.submit(&CancellationToken::new(), move |lane| skills::collect_skills(lane, &data, &roots)).unwrap().await.unwrap()
    };
    (found, data)
}

#[tokio::test]
async fn skills_are_collected_in_precedence_with_folder_rules() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (found, _) = collect_fixture_skills(&tokens, dir.path()).await;
    let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["alpha", "needs-js", "gamma", "alpha"]);
    assert_eq!(found[0].tool_dependencies.manifest_names(), ["mcp:github", "read"]);
    assert_eq!(found[0].tool_dependencies.source, mixdog_mcp::skill_deps::DependencySource::Declaration);
    let in_use = skills::SkillGate::default().in_use(&found);
    assert_eq!(
        in_use.iter().map(|s| (s.name.as_str(), s.description.as_str())).collect::<Vec<_>>()[0],
        ("alpha", "alpha description"),
        "the global skill shadows the bundled one"
    );
    assert_eq!(in_use.len(), 3);
    assert_eq!(found[2].plugin.as_deref(), Some("plug"));
}

#[tokio::test]
async fn a_users_dependency_override_replaces_the_declaration_and_null_restores_it() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (found, data) = collect_fixture_skills(&tokens, dir.path()).await;
    let alpha = found[0].file_path.clone();
    let override_deps = json!([{"type": "tool", "value": "grep"}]);
    mixdog_mcp::skill_deps::save_skill_tool_dependencies(tokens.durability_io, &data, &alpha, Some(&override_deps)).await.unwrap();
    let after = {
        let (data, alpha) = (data.clone(), alpha.clone());
        tokens
            .maintenance_io
            .submit(&CancellationToken::new(), move |lane| mixdog_mcp::skill_deps::read_skill_tool_dependencies(lane, &data, &alpha, &json!({})))
            .unwrap()
            .await
            .unwrap()
    };
    assert_eq!(after.manifest_names(), ["grep"]);
    assert_eq!(after.source, mixdog_mcp::skill_deps::DependencySource::Override);
    mixdog_mcp::skill_deps::save_skill_tool_dependencies(tokens.durability_io, &data, &alpha, None).await.unwrap();
    let restored = {
        let (data, alpha) = (data.clone(), alpha.clone());
        tokens
            .maintenance_io
            .submit(&CancellationToken::new(), move |lane| mixdog_mcp::skill_deps::read_skill_tool_dependencies(lane, &data, &alpha, &json!({})))
            .unwrap()
            .await
            .unwrap()
    };
    assert_eq!(restored.source, mixdog_mcp::skill_deps::DependencySource::Declaration);
}

#[tokio::test]
async fn a_skill_needing_a_feature_is_offered_only_while_it_is_active() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (found, _) = collect_fixture_skills(&tokens, dir.path()).await;
    let mut gate = skills::SkillGate::default();
    assert_eq!(gate.offered(&found).len(), 2, "needs-js is hidden without the jsRuntime feature");
    gate.active_features = HashSet::from([skills::FEATURE_JS_RUNTIME.to_owned()]);
    assert_eq!(gate.offered(&found).len(), 3);
}

async fn declared_plugin(tokens: &mixdog_rt::LaneTokens, dir: &Path) -> plugins::PluginMcpDeclarations {
    let root = dir.join("p");
    write(&root.join(".mcp.json"), &json!({"mcpServers": {"a": {"command": "one"}, "bad": {"type": "stdio"}}}).to_string());
    write(&root.join("plugin.json"), &json!({"mcpServers": [{"b": {"url": "https://example.com/mcp"}}, "extra.json", "../escape.json"]}).to_string());
    write(&root.join("extra.json"), &json!({"a": {"command": "two"}}).to_string());
    tokens.maintenance_io.submit(&CancellationToken::new(), move |lane| plugins::load_declarations(lane, &root)).unwrap().await.unwrap()
}

#[tokio::test]
async fn plugin_declarations_merge_sources_with_later_ones_overriding_by_key() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let declared = declared_plugin(&tokens, dir.path()).await;
    assert_eq!(declared.format, plugins::PluginFormat::Mixdog);
    let a = declared.servers.iter().find(|s| s.key == "a").unwrap();
    assert_eq!(a.config["command"], "two", "later sources override earlier ones by key");
    assert!(declared.servers.iter().any(|s| s.key == "b"));
}

#[tokio::test]
async fn plugin_declaration_errors_name_the_problem_without_values() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let declared = declared_plugin(&tokens, dir.path()).await;
    let messages: Vec<&str> = declared.errors.iter().map(|e| e.message.as_str()).collect();
    assert!(messages.contains(&"stdio server requires \"command\""));
    assert!(messages.iter().any(|m| m.ends_with("MCP path must be relative and stay inside the plugin root")));
}
#[tokio::test]
async fn registry_skills_roots_and_hook_catalog_load_from_disk() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let plug = dir.path().join("plug");
    let project = dir.path().join("project");
    write(&plug.join("plugin.json"), &json!({"skills": ["./more"]}).to_string());
    write(
        &data.join("plugins").join("registry.json"),
        &json!({"plugins": [
            {"id": "My Plug", "root": plug.to_string_lossy(), "enabled": true},
            {"id": "gone", "root": dir.path().join("missing").to_string_lossy()}
        ]})
        .to_string(),
    );
    write(&plug.join("hooks").join("hooks.json"), &json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x"}]}]}}).to_string());
    write(
        &project.join(".mixdog").join("hooks.json"),
        &json!({"hooks": {"PreToolUse": [{"matcher": "shell", "hooks": [{"type": "command", "command": "y"}]}]}}).to_string(),
    );
    write(&data.join("settings.json"), &json!({"trustedProjects": []}).to_string());

    let (registry, roots, trusted) = {
        let (data, plug) = (data.clone(), plug.clone());
        tokens
            .maintenance_io
            .submit(&CancellationToken::new(), move |lane| {
                (plugins::read_registry(lane, &data), plugins::skills_roots(lane, &plug), hooks::read_trusted_projects(lane, &data))
            })
            .unwrap()
            .await
            .unwrap()
    };
    assert_eq!(registry.len(), 1, "an entry whose root is missing is skipped");
    assert_eq!(roots, vec![plug.join("skills"), plug.join("more")]);

    let entries =
        hooks::config_entries(&hooks::HookSources { env_file: None, data_dir: &data, project_dir: &project, trusted_projects: &trusted, plugins: &registry });
    let (events, reports) = tokens.maintenance_io.submit(&CancellationToken::new(), move |lane| hooks::load_catalog(lane, &entries)).unwrap().await.unwrap();
    assert_eq!(reports.len(), 2);
    let pre = &events["PreToolUse"][0];
    assert!(pre.handlers[0].untrusted, "an untrusted project's handlers must not run");
    assert!(pre.matcher.fires("shell") && !pre.matcher.fires("read"));
    assert!(!events["Stop"][0].handlers[0].untrusted);
    assert_eq!(events["Stop"][0].handlers[0].plugin_data.as_deref(), Some(data.join("plugins").join("data").join("my-plug").as_path()));
}

#[tokio::test]
async fn launcher_files_are_written_once_per_runtime_and_atomically() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let runtime = launcher::SkillRuntime {
        platform: launcher::Platform::current(),
        interpreter: "/opt/js/node".to_owned(),
        entry: "/opt/app/src/skill-script-entry.mjs".to_owned(),
        electron: false,
    };
    let data = dir.path().to_path_buf();
    let ensure = {
        let (runtime, data) = (runtime.clone(), data.clone());
        move || {
            let (runtime, data) = (runtime.clone(), data.clone());
            tokens.durability_io.submit(&CancellationToken::new(), move |lane| launcher::ensure_launcher_dir(lane, &runtime, &data)).unwrap()
        }
    };
    let first = ensure().await.unwrap().unwrap();
    let second = ensure().await.unwrap().unwrap();
    assert_eq!(first, second);
    let written = std::fs::read_to_string(first.join(launcher::SKILL_LAUNCHER_COMMAND)).unwrap();
    assert_eq!(written, launcher::render_posix(&runtime));
    assert!(std::fs::read_dir(&first).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
}

/// `parsed?.trustedProjects ?? parsed?.hooks?.trustedProjects`: a null list falls back, as an absent one does.
#[tokio::test]
async fn a_null_trusted_projects_falls_back_to_the_hooks_list() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    write(&data.join("config.json"), &json!({"trustedProjects": null, "hooks": {"trustedProjects": ["/some/proj"]}}).to_string());
    let trusted = {
        let data = data.clone();
        tokens.maintenance_io.submit(&CancellationToken::new(), move |lane| hooks::read_trusted_projects(lane, &data)).unwrap().await.unwrap()
    };
    assert_eq!(trusted.len(), 1);
}
