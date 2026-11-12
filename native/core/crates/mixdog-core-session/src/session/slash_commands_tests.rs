//! `fixtures/slash-commands-cases` (`record-slash-commands-cases.mjs`, b6f10295a), replayed through the core's slash registry and `/btw`
//! scroll rules. `contentRows` (the rendered row count of a markdown answer, `measureMarkdownRenderedRows`) is the Node TUI's markdown
//! renderer: the core has none, so that one recorded number is the input of `btw_panel_rows` and is not produced here (the manifest says so).

use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::slash_commands::BTW_CHROME_ROWS;
use super::slash_commands::btw_panel_rows;
use super::slash_commands::btw_scroll_max;
use super::slash_commands::btw_scroll_offset;
use super::slash_commands::normalize_slash_command_name;
use super::slash_commands::overlay_blocks_global_transcript_scroll;
use super::slash_commands::slash_argument_hint;

fn observed(name: &str) -> Value {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/slash-commands-cases/golden.json")).expect("golden.json");
    let golden = Exact::decode(&golden).expect("exact");
    let found = golden.get("cases").as_array().iter().find(|case| case.get("case").as_str() == name).cloned();
    found.unwrap_or_else(|| panic!("no recorded case {name:?}")).get("observed").to_plain().expect("plain")
}

fn int(value: &Value) -> i64 {
    value.as_i64().expect("an integer")
}

#[test]
fn a_command_name_resolves_through_its_aliases_and_an_unknown_one_stays_as_typed_as_node_recorded() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/slash-commands-cases/golden.json")).expect("golden.json");
    let golden = Exact::decode(&golden).expect("exact");
    let case = &golden.get("cases").as_array()[0];
    assert_eq!(case.get("case").as_str(), "a command name resolves through its aliases, and an unknown one stays as typed");
    let names = case.get("observed").get("names").as_array();
    assert_eq!(names.len(), 6);
    for entry in names {
        // The recorded `undefined` input is `String(undefined || '')`: the empty name.
        let input = match entry.get("input") {
            Exact::Undefined => "",
            other => other.as_str(),
        };
        assert_eq!(normalize_slash_command_name(input), entry.get("result").as_str(), "{:?}", entry.get("input"));
    }
}

#[test]
fn an_open_btw_panel_owns_the_scroll_keys_as_node_recorded() {
    let want = observed("an open /btw panel owns PageUp/PageDown and wheel scroll");
    let overlays = want["overlays"].as_array().unwrap();
    assert_eq!(overlays.len(), 2);
    for entry in overlays {
        assert_eq!(json!(overlay_blocks_global_transcript_scroll(&entry["overlay"])), entry["blocks"], "{}", entry["overlay"]);
    }
}

#[test]
fn btw_scroll_pages_by_one_row_less_than_the_body_clamped_to_the_content_as_node_recorded() {
    let want = observed("btw scroll offsets page by one row less than the body, clamped to the content");
    for entry in want["scrollMax"].as_array().unwrap() {
        assert_eq!(json!(btw_scroll_max(int(&entry["content"]), int(&entry["body"]))), entry["result"], "{entry}");
    }
    for entry in want["scrollOffset"].as_array().unwrap() {
        let args = entry["args"].as_array().unwrap();
        let got = btw_scroll_offset(&args[0], int(&args[1]), int(&args[2]), int(&args[3]));
        assert_eq!(json!(got), entry["result"], "{entry}");
    }
    assert_eq!(json!(BTW_CHROME_ROWS), want["chromeRows"]);
    assert_eq!(json!(btw_panel_rows(int(&want["contentRows"]))), want["panelRows"]);
}

#[test]
fn the_argument_hint_comes_from_the_resolved_command_only_after_a_trailing_space_as_node_recorded() {
    let want = observed("the argument hint comes from the resolved command, only after a trailing space");
    let hints = want["hints"].as_array().unwrap();
    assert_eq!(hints.len(), 8);
    for entry in hints {
        assert_eq!(json!(slash_argument_hint(entry["input"].as_str().unwrap())), entry["hint"], "{}", entry["input"]);
    }
}
