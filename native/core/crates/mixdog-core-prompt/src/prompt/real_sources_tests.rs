//! The real prompt sources: each world is written into a temp folder and every query is asked of [`RealSources`] inside an
//! io-interactive lane job.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories and real files")]
#![cfg(windows)]

use std::collections::HashSet;
use std::sync::Arc;

use mixdog_agent::env::Clock;
use std::fs;
use std::path::Path;

use base64::Engine;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::probes::StartupObservations;
use super::real_sources::HostFacts;
use super::real_sources::RealSources;
use super::sources::PromptSources;
use mixdog_core_base::support::on_lane;

struct Frozen;

impl Clock for Frozen {
    fn now_ms(&self) -> i64 {
        0
    }
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
#[tokio::test]
async fn the_startup_observations_land_in_the_git_and_listing_lines() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    write_world(
        &root,
        &json!([
            {"path": "repo/.git/HEAD", "text": "ref: refs/heads/main\n"},
            {"path": "repo/keep.txt", "text": ""},
            {"path": "repo/skip.log", "text": ""},
            {"path": "bin/git.exe", "text": ""},
        ]),
    );
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
    write_world(
        &root,
        &json!([
            {"path": "repo/.git/HEAD", "text": "ref: refs/heads/main\n"},
            {"path": "bin/git.exe", "text": ""},
            {"path": "bin/node.exe", "text": ""},
        ]),
    );
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

/// `agentProfileRevision`: an edit of an agent's `PERSONA.md`, `AGENT.md` or `agent.json` is another stamp, an
/// untouched profile keeps its own, a coding Lead's is a constant and an invalid id has none.
#[tokio::test]
async fn an_agents_profile_stamp_follows_its_files() {
    let dir = tempfile::tempdir().unwrap();
    let plugin = dir.path().join("plugin");
    let data = dir.path().join("data");
    let home = dir.path().join("home");
    fs::create_dir_all(data.join("agents/helper")).unwrap();
    fs::write(data.join("agents/helper/AGENT.md"), "role").unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let stamps = on_lane(tokens.interactive_io, &CancellationToken::new(), move |lane| {
        let observed = StartupObservations::new(Arc::new(Frozen));
        let host = HostFacts {
            plugin_root: &plugin,
            data_dir: &data,
            home_dir: &home,
            path_env: "",
            locale: "en-US",
            instruction_files_forced_off: false,
            stored_instruction_files: None,
        };
        let stamp = |agent: &str, mixy: bool| RealSources::new(lane, host, &observed).agent_profile_revision(agent, mixy);
        let before = stamp("helper", false);
        assert_eq!(before, stamp("helper", false));
        fs::write(data.join("agents/helper/PERSONA.md"), "gentle").unwrap();
        let persona = stamp("helper", false);
        fs::write(data.join("agents/helper/agent.json"), "{\"name\":\"Helper\"}").unwrap();
        let manifest = stamp("helper", false);
        // A file holding only blanks reads as absent, as `readSafe` of a trimmed empty file does.
        fs::write(data.join("agents/helper/PERSONA.md"), "  \n").unwrap();
        let blank = stamp("helper", false);
        // So does one a crash left as NUL bytes (`holdsNoData`).
        fs::write(data.join("agents/helper/PERSONA.md"), [0u8, 0, 0]).unwrap();
        let nul = stamp("helper", false);
        assert_eq!(nul, blank);
        fs::remove_file(data.join("agents/helper/PERSONA.md")).unwrap();
        let absent = stamp("helper", false);
        (before, persona, manifest, (blank, absent), stamp("lead", false), stamp("..", false), stamp("lead", true))
    })
    .await
    .unwrap();
    assert_eq!(stamps.0.len(), 24);
    assert!(stamps.0 != stamps.1 && stamps.1 != stamps.2 && stamps.0 != stamps.2);
    assert_eq!(stamps.3.0, stamps.3.1);
    assert_eq!(stamps.4, "coding-lead");
    assert_eq!(stamps.5, "");
    assert_eq!(stamps.6.len(), 24);
}
