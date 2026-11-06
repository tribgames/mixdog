//! LR §11 gate 10: the real v1.4.5 clients meet the 1.4.6 control listener's refusals.
//!
//! Needs the tag tree: `MIXDOG_V145_TREE=<dir>` holding `git archive 69fe41b05` and a
//! `node_modules` (the tag lockfile's install, or a junction to a compatible one on a dev PC),
//! and `node` on `PATH`. Run: `cargo test -p mixdog-app-server-daemon --test legacy_clients
//! -- --ignored`.

use std::path::PathBuf;
#[allow(clippy::disallowed_types, reason = "test: runs the recorded 1.4.5 node clients as a child process")]
use std::process::Command;
use std::sync::Arc;

use mixdog_app_server_daemon::control::ControlConfig;
use mixdog_app_server_daemon::control::ControlServer;
use mixdog_app_server_daemon::control::Legacy;
use mixdog_app_server_daemon::control::new_token;
use mixdog_app_server_daemon::lifecycle::CorePort;
use mixdog_app_server_daemon::lifecycle::DiscoveryState;
use mixdog_app_server_daemon::lifecycle::DrainNotice;
use mixdog_app_server_daemon::lifecycle::Exiter;
use mixdog_app_server_daemon::lifecycle::Lifecycle;
use mixdog_app_server_daemon::lifecycle::LifecycleConfig;
use mixdog_app_server_daemon::lifecycle::Ports;
use mixdog_app_server_daemon::lifecycle::Publication;
use mixdog_app_server_daemon::lifecycle::Running;
use mixdog_app_server_daemon::lifecycle::StateName;
use serde_json::Value;

/// The text the fixture barrier record carries (`fixtures/lifecycle/barrier`).
const UPDATE_TEXT: &str = "Update Mixdog to continue";

struct Quiet;

impl CorePort for Quiet {
    fn drain_notice(&self, _: &DrainNotice) {}
    fn health(&self, _: u64) {}
    fn cancel_running(&self, _: &[Running]) {}
    fn release_decision(&self, _: u32) {}
    fn final_barriers(&self) {}
    fn close_connections(&self) {}
    fn close_ext_host(&self) {}
    fn close_data_handles(&self) {}
}

impl Publication for Quiet {
    fn publish(&self, _: &DiscoveryState) {}
    fn withdraw(&self) {}
}

impl Exiter for Quiet {
    fn exit(&self) {}
}

#[test]
#[ignore = "needs the v1.4.5 tree: MIXDOG_V145_TREE"]
#[allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test: runs the recorded 1.4.5 node clients as a child process"
)]
fn real_1_4_5_clients_get_the_update_text_and_never_stop_the_core() {
    let tree = PathBuf::from(
        std::env::var("MIXDOG_V145_TREE").expect("MIXDOG_V145_TREE: a `git archive 69fe41b05` tree with node_modules"),
    );
    let quiet = Arc::new(Quiet);
    let runtime = tempfile::tempdir().unwrap();
    let lifecycle = Lifecycle::new(
        LifecycleConfig {
            instance_id: "gate10".into(),
            version: "1.4.6".into(),
            runtime_root: runtime.path().to_owned(),
        },
        Ports { core: quiet.clone(), discovery: quiet.clone(), exiter: quiet },
    );
    lifecycle.set_serving().unwrap();
    let server = ControlServer::start(
        ControlConfig {
            token: new_token(),
            legacy: Legacy { pid: std::process::id(), version: "1.4.6".into(), update_text: UPDATE_TEXT.into() },
        },
        Arc::clone(&lifecycle),
    )
    .unwrap();

    let work = tempfile::tempdir().unwrap();
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let output = Command::new("node")
        .arg(here.join("tests/legacy/gate10.mjs"))
        .arg(&tree)
        .arg(server.port().to_string())
        .arg(work.path())
        .arg(std::process::id().to_string())
        .arg(here.join("../../fixtures/lifecycle/barrier"))
        // esbuild is resolved from the tree's node_modules.
        .current_dir(&tree)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .find_map(|l| l.strip_prefix("GATE10 "))
        .unwrap_or_else(|| panic!("no result line\nstdout: {stdout}\nstderr: {}", String::from_utf8_lossy(&output.stderr)));
    let result: Value = serde_json::from_str(line).unwrap();

    // 1.4.5 TUI/CLI against a serving core: it attaches (the core looks newer) and register
    // is refused with the update text; the TUI prints that message and exits 1.
    let attach = &result["attachToServingCore"];
    assert_eq!(attach["ok"], true, "{attach}");
    assert_eq!(attach["ensureReturnedDiscovery"], true);
    assert_eq!(attach["statusCode"], 426);
    assert_eq!(attach["message"], UPDATE_TEXT);

    // No core: the barrier makes each candidate exit; its reason, carrying the text, is in
    // the candidate line of the error the TUI prints.
    let none = &result["noCoreCandidateLine"];
    assert_eq!(none["ok"], true, "{none}");
    assert!(none["message"].as_str().unwrap().contains(UPDATE_TEXT), "{none}");

    // 1.4.5 SSH program, server with a core: refused as unmanaged, with the text.
    let ssh = &result["sshProgramWithCore"];
    assert_eq!(ssh["ok"], true, "{ssh}");
    assert_eq!(ssh["code"], "daemon-unmanaged");
    assert!(ssh["message"].as_str().unwrap().contains(UPDATE_TEXT), "{ssh}");

    // The core was never asked to stop, replace or upgrade, and is still serving.
    let requests: Vec<&str> = result["requests"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    for forbidden in ["/stop", "/upgrade", "/shutdown", "/install-hold"] {
        assert!(!requests.iter().any(|r| r.contains(forbidden)), "{forbidden} in {requests:?}");
    }
    assert!(requests.iter().any(|r| r.contains("/client/register")));
    assert_eq!(lifecycle.status().state, StateName::Serving);
}
