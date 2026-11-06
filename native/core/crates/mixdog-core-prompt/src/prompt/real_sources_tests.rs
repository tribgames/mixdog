//! The real prompt sources against Node's loaders: `fixtures/prompt-sources/sources.json`,
//! recorded by `record-prompt-sources.mjs` on Windows (PATH and path answers are Windows ones).
//! Each world is written into a temp folder and every query is asked of [`RealSources`] inside an
//! io-interactive lane job.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories and recorded fixtures")]
#![cfg(windows)]

use std::collections::HashSet;
use std::sync::Arc;

use mixdog_agent::env::Clock;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use base64::Engine;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::real_sources::HostFacts;
use super::real_sources::RealSources;
use super::probes::StartupObservations;
use super::sources::PromptSources;
use mixdog_core_base::support::on_lane;

struct Frozen;

impl Clock for Frozen {
    fn now_ms(&self) -> i64 {
        0
    }
}

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/prompt-sources/sources.json");
    serde_json::from_str(&fs::read_to_string(path).expect("sources.json")).expect("json")
}

fn write_world(root: &Path, files: &Value) {
    for file in files.as_array().unwrap() {
        let target = root.join(file["path"].as_str().unwrap());
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let bytes = match file["b64"].as_str() {
            Some(b64) => base64::engine::general_purpose::STANDARD.decode(b64).unwrap(),
            None => file["text"].as_str().unwrap().as_bytes().to_vec(),
        };
        fs::write(target, bytes).unwrap();
    }
}

/// One query of the world, answered by the real sources.
fn answer(sources: &RealSources, root: &Path, query: &Value) -> String {
    let args = query["args"].as_array().unwrap();
    let text = |index: usize| args[index].as_str();
    let at = |rel: &str| root.join(rel.replace('/', "\\")).to_string_lossy().into_owned();
    match query["fn"].as_str().unwrap() {
        "roleCatalog" => sources.role_catalog(text(0), Some("anthropic")),
        "mixyRoleSection" => sources.mixy_role_section(),
        "persona" => sources.persona_section(text(0).unwrap()),
        "identity" => sources.agent_mode_identity_line(text(0).unwrap()),
        "scratch" => sources.scratch_dir(text(0).unwrap()).unwrap_or_default(),
        "shellTools" | "git" => unreachable!("asked with their own PATH"),
        "cwdEntries" => sources.cwd_entries(&at(text(0).unwrap())),
        "instructionFiles" => {
            let mode = text(0).map_or(Value::Null, |mode| json!(mode));
            sources.instruction_files(Some(&mode), text(1).map(at).as_deref())
        }
        other => panic!("unknown query {other}"),
    }
}

#[tokio::test]
async fn the_real_sources_answer_what_nodes_loaders_answered() {
    let plugin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/prompt/plugin");
    let tokens = mixdog_rt::testing::tokens();
    let mut failures: Vec<String> = Vec::new();
    for world in fixture()["worlds"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        write_world(&root, &world["files"]);
        let (world, plugin) = (world.clone(), plugin.clone());
        let name = world["name"].as_str().unwrap().to_owned();
        let found = on_lane(tokens.interactive_io, &CancellationToken::new(), move |lane| {
            let (data, home) = (root.join("data"), root.join("home"));
            let observed = StartupObservations::new(Arc::new(Frozen));
            let host = |path_env: &'static str| HostFacts {
                plugin_root: &plugin,
                data_dir: &data,
                home_dir: &home,
                path_env,
                locale: "en-US",
                instruction_files_forced_off: false,
                stored_instruction_files: None,
            };
            let expected_of = |query: &Value| query["answer"].as_str().unwrap().replace("{ROOT}", &root.to_string_lossy());
            let mut failed = Vec::new();
            for query in world["queries"].as_array().unwrap() {
                let args = query["args"].as_array().unwrap();
                let path_of = |dirs: &Value| dirs.as_array().unwrap().iter().map(|d| root.join(d.as_str().unwrap().replace('/', "\\")).to_string_lossy().into_owned()).collect::<Vec<_>>().join(";");
                let got = match query["fn"].as_str().unwrap() {
                    "shellTools" => {
                        let path = path_of(&args[0]);
                        RealSources::new(lane, host(Box::leak(path.into_boxed_str())), &observed).shell_tools_line()
                    }
                    "git" => {
                        let path = path_of(&args[0]);
                        let cwd = root.join(args[1].as_str().unwrap().replace('/', "\\")).to_string_lossy().into_owned();
                        RealSources::new(lane, host(Box::leak(path.into_boxed_str())), &observed).git_line(Some(&cwd))
                    }
                    _ => answer(&RealSources::new(lane, host(""), &observed), &root, query),
                };
                let expected = expected_of(query);
                if got != expected {
                    failed.push(format!("{} {}: {}\n  node: {expected:?}\n  rust: {got:?}", query["fn"], query["args"], ""));
                }
            }
            failed
        })
        .await
        .unwrap();
        failures.extend(found.into_iter().map(|f| format!("[{name}] {f}")));
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

#[tokio::test]
async fn the_startup_observations_land_in_the_git_and_listing_lines() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    write_world(&root, &json!([
        {"path": "repo/.git/HEAD", "text": "ref: refs/heads/main\n"},
        {"path": "repo/keep.txt", "text": ""},
        {"path": "repo/skip.log", "text": ""},
        {"path": "bin/git.exe", "text": ""},
    ]));
    let tokens = mixdog_rt::testing::tokens();
    let line = on_lane(tokens.interactive_io, &CancellationToken::new(), move |lane| {
        let repo = root.join("repo").to_string_lossy().into_owned();
        let observed = StartupObservations::new(Arc::new(Frozen));
        observed.record_change_state(&repo, Some("changes present".to_owned()), true);
        observed.record_ignored(&repo, vec!["keep.txt".to_owned(), "skip.log".to_owned()], HashSet::from(["skip.log".to_owned()]), true);
        let path = root.join("bin").to_string_lossy().into_owned();
        let host = HostFacts {
            plugin_root: &root,
            data_dir: &root,
            home_dir: &root,
            path_env: &path,
            locale: "en-US",
            instruction_files_forced_off: false,
            stored_instruction_files: None,
        };
        let sources = RealSources::new(lane, host, &observed);
        (sources.git_line(Some(&repo)), sources.cwd_entries(&repo), repo)
    })
    .await
    .unwrap();
    assert_eq!(line.0, format!("- Git startup state: repository root {} on branch main; changes present.", line.2));
    assert_eq!(line.1, "- Cwd entries at startup: keep.txt");
}

/// Node probes once per process: a second session gets the first one's shell-tools line and git
/// presence even after the files they were measured from are gone.
#[tokio::test]
async fn a_second_session_reuses_the_first_ones_observations() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    write_world(&root, &json!([
        {"path": "repo/.git/HEAD", "text": "ref: refs/heads/main\n"},
        {"path": "bin/git.exe", "text": ""},
        {"path": "bin/node.exe", "text": ""},
    ]));
    let tokens = mixdog_rt::testing::tokens();
    let lines = on_lane(tokens.interactive_io, &CancellationToken::new(), move |lane| {
        let repo = root.join("repo").to_string_lossy().into_owned();
        let path = root.join("bin").to_string_lossy().into_owned();
        let observed = StartupObservations::new(Arc::new(Frozen));
        let host = HostFacts {
            plugin_root: &root,
            data_dir: &root,
            home_dir: &root,
            path_env: &path,
            locale: "en-US",
            instruction_files_forced_off: false,
            stored_instruction_files: None,
        };
        let ask = || {
            let sources = RealSources::new(lane, host, &observed);
            (sources.shell_tools_line(), sources.git_line(Some(&repo)))
        };
        let first = ask();
        fs::remove_file(root.join("bin").join("git.exe")).unwrap();
        fs::remove_file(root.join("bin").join("node.exe")).unwrap();
        (first, ask(), observed.take_requests().len())
    })
    .await
    .unwrap();
    assert!(lines.0.0.starts_with("- Shell tools at startup: node;"));
    assert!(lines.0.1.contains("on branch main"));
    assert_eq!(lines.0, lines.1);
    assert_eq!(lines.2, 1, "the change state of the repository is asked for once, not per session");
}