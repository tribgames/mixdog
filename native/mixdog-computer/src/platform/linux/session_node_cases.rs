//! Node's session-detection case of `linux-readiness.test.mjs` (`fixtures/linux-session-cases`,
//! `record-linux-session-cases.mjs`): per recorded environment, [`wayland_session`] must name the session
//! Node's `detectSession` named. The environment is the process's own, as the core reads it.

use super::wayland_session;
use serde_json::Value;

const VARS: [&str; 3] = ["WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "DISPLAY"];

#[test]
fn every_recorded_environment_names_nodes_session() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../core/fixtures/linux-session-cases/golden.json")).expect("the recording");
    let golden: Value = serde_json::from_str(&text).expect("json");
    let cases = golden["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 1, "every case of the Node test's session detection");
    for case in cases {
        for check in case["checks"].as_array().expect("checks") {
            let env = check["env"].as_object().expect("env");
            for var in VARS {
                match env.get(var).and_then(Value::as_str) {
                    Some(value) => std::env::set_var(var, value),
                    None => std::env::remove_var(var),
                }
            }
            let got = if wayland_session() { "wayland" } else { "x11" };
            assert_eq!(got, check["session"].as_str().expect("session"), "{}", check["env"]);
        }
    }
}
