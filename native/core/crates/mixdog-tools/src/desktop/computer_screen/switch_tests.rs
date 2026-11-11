//! Replay of Node's source switch (recorded by `record-screen-control-switch.mjs` from the export of b6f10295a):
//! `decideScreenSource` over the whole cartesian product of its inputs, `screenStatusFor` over every distinct
//! decision, and the pure helpers around them. Every output must equal Node's whole.

use mixdog_core_api::domain::computer::DesktopIdentity;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::installer::InstallState;
use super::installer::install_offer_for;
use super::switch::HELPER_FRAME_INTERVAL_MS;
use super::switch::HelperIssue;
use super::switch::HelperView;
use super::switch::ScreenHelperFacts;
use super::switch::SourceDecision;
use super::switch::SwitchInputs;
use super::switch::decide_screen_source;
use super::switch::decision_uses_helper;
use super::switch::helper_issue_after_change;
use super::switch::helper_video_stall_ms;
use super::switch::screen_helper_issue;
use super::switch::screen_status_for;
use super::switch::secure_desktop_identity;
use super::testing::manifest_names;

const DECISIONS: &str = include_str!("../../../../../fixtures/screen-control/switch/decisions.json");
const STATUSES: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/screen-control/switch/statuses.json");
const MISC: &str = include_str!("../../../../../fixtures/screen-control/switch/misc.json");
const MANIFEST: &str = include_str!("../../../../../fixtures/screen-control/switch/MANIFEST.json");

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("the recording parses")
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serializes")
}

/// The recorded axes' cartesian product, the last axis varying fastest.
fn product(axes: &Value, order: &[String]) -> Vec<Map<String, Value>> {
    let mut rows = vec![Map::new()];
    for name in order {
        let values = axes[name].as_array().unwrap_or_else(|| panic!("axis {name}"));
        rows = rows
            .into_iter()
            .flat_map(|row| {
                values.iter().map(move |value| {
                    let mut next = row.clone();
                    next.insert(name.clone(), value.clone());
                    next
                })
            })
            .collect();
    }
    rows
}

#[test]
fn every_recorded_input_of_the_decision_gets_nodes_whole_output() {
    let recording = parse(DECISIONS);
    let order: Vec<String> = recording["order"].as_array().expect("order").iter().map(|name| name.as_str().expect("a name").to_string()).collect();
    let table = recording["table"].as_array().expect("table");
    let rows = product(&recording["axes"], &order);
    manifest_names(MANIFEST, &[json!({"name": "decisions"}), json!({"name": "statuses"}), json!({"name": "misc"})]);
    assert_eq!(rows.len(), table.len(), "one recorded output per input");
    for (row, index) in rows.into_iter().zip(table) {
        let shown = Value::Object(row.clone());
        let inputs: SwitchInputs = serde_json::from_value(Value::Object(row)).expect("the inputs parse");
        let want = &recording["palette"][index.as_u64().expect("an index") as usize];
        assert_eq!(&to_value(&decide_screen_source(&inputs)), want, "decision for {shown}");
    }
}

#[test]
fn every_recorded_status_is_nodes_whole_status() {
    let decisions = parse(DECISIONS);
    let statuses = parse(&STATUSES);
    let facts: Vec<ScreenHelperFacts> = serde_json::from_value(statuses["facts"].clone()).expect("facts parse");
    let cases = statuses["cases"].as_array().expect("cases");
    // The recorder's loop: every distinct decision × control granted × helper video × each facts block.
    let palette = decisions["palette"].as_array().expect("palette");
    assert_eq!(cases.len(), palette.len() * 2 * 2 * facts.len(), "one recorded status per case");
    for case in cases {
        let decision: SourceDecision = serde_json::from_value(decisions["palette"][case["decision"].as_u64().expect("a decision") as usize].clone()).expect("a decision parses");
        let status = screen_status_for(&decision, case["controlGranted"].as_bool().expect("flag"), case["helperVideo"].as_bool().expect("flag"), &facts[case["facts"].as_u64().expect("facts") as usize]);
        assert_eq!(to_value(&status), case["status"], "status for {case}");
    }
}

struct Client {
    connected: bool,
    session: Option<u32>,
    desktop: Option<String>,
}

impl HelperView for Client {
    fn installed(&self) -> bool {
        true
    }

    fn connected(&self) -> bool {
        self.connected
    }

    fn desktop(&self) -> Option<String> {
        self.desktop.clone()
    }

    fn session(&self) -> Option<u32> {
        self.session
    }
}

#[test]
fn the_pure_helpers_equal_nodes() {
    let misc = parse(MISC);
    let decisions = parse(DECISIONS);
    assert_eq!(misc["helperFrameIntervalMs"], json!(HELPER_FRAME_INTERVAL_MS));
    for case in misc["issueCodes"].as_array().expect("issueCodes") {
        let got = screen_helper_issue(case["code"].as_str().expect("a code"));
        assert_eq!(to_value(&got), case["issue"], "issue of {}", case["code"]);
    }
    for case in misc["issueAfterChange"].as_array().expect("issueAfterChange") {
        let issue: Option<HelperIssue> = serde_json::from_value(case["issue"].clone()).expect("an issue");
        let got = helper_issue_after_change(issue, case["connected"].as_bool().expect("flag"));
        assert_eq!(to_value(&got), case["after"], "after change {case}");
    }
    for case in misc["usesHelper"].as_array().expect("usesHelper") {
        let decision: SourceDecision = serde_json::from_value(decisions["palette"][case["decision"].as_u64().expect("a decision") as usize].clone()).expect("a decision parses");
        assert_eq!(json!(decision_uses_helper(&decision)), case["uses"], "uses helper {case}");
    }
    for case in misc["identity"].as_array().expect("identity") {
        let client = Client {
            connected: case["connected"].as_bool().expect("flag"),
            session: case["session"].as_u64().map(|session| session as u32),
            desktop: case["desktop"].as_str().map(str::to_string),
        };
        let got = secure_desktop_identity(&client).map(|DesktopIdentity { session, desktop }| json!({"session": session, "desktop": desktop}));
        assert_eq!(got.unwrap_or(Value::Null), case["identity"], "identity of {case}");
    }
    for case in misc["offers"].as_array().expect("offers") {
        let state: InstallState = serde_json::from_value(case["state"].clone()).expect("a state");
        assert_eq!(to_value(&install_offer_for(state)), case["offer"], "offer for {case}");
    }
    for case in misc["stall"].as_array().expect("stall") {
        let intervals: Vec<f64> = case["intervals"].as_array().expect("intervals").iter().map(|value| value.as_f64().expect("a number")).collect();
        assert_eq!(Some(helper_video_stall_ms(&intervals)), case["stallMs"].as_f64(), "stall for {case}");
    }
}
