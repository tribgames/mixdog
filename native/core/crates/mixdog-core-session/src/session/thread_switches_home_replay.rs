//! Node's recording `fixtures/agent-home-cases/golden.json` (`record-agent-home-cases.mjs`), case 3: the scratch
//! decision a thread switch makes before it tombstones the thread it leaves (`isScratchSession`), read when the test
//! runs and decoded with [`Exact`]; each recorded session goes through [`is_scratch`] with its stored messages and
//! nothing live, and the whole recorded value is compared.

use std::path::Path;

use mixdog_testkit::Exact;
use serde_json::{Value, json};

use super::is_scratch;

#[test]
fn a_blank_home_thread_is_never_scratch() {
    let golden = Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-home-cases/golden.json"));
    let name = "a blank home thread is never scratch, so no close tombstones its fixed id";
    let case = &golden.get("cases").as_array()[3];
    assert_eq!(case.get("case").as_str(), name);
    let want = case.get("observed");
    let decide = |key: &str| {
        let session = want.get(key).get("session").to_plain().unwrap();
        let messages = session["messages"].as_array().cloned().unwrap_or_default();
        let scratch = is_scratch(session["id"].as_str().unwrap(), &messages, &[]);
        json!({ "session": session, "scratch": scratch })
    };
    let got: Value = json!({ "blankDesktop": decide("blankDesktop"), "blankHome": decide("blankHome") });
    assert!(Exact::plain(&got) == *want, "{name}: {got}");
}
