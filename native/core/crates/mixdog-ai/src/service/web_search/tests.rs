use super::*;

/// Node's recorded outputs (`tests/golden/web_search/shape.json`).
fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/golden/web_search/shape.json")).unwrap()
}

fn rows(g: &Value, key: &str) -> Vec<Value> {
    g[key].as_array().unwrap().clone()
}

#[test]
fn allowed_domains_match_node() {
    let g = golden();
    for row in rows(&g, "domain") {
        let site = clean(row.get("in"));
        assert_eq!(json!(normalize_allowed_domain(&site)), row["out"], "{row}");
    }
    for row in rows(&g, "domains") {
        let site = clean(row.get("in"));
        assert_eq!(json!(normalize_allowed_domains(&site)), row["out"], "{row}");
    }
}

#[test]
fn the_tool_shape_matches_node_for_every_family() {
    let g = golden();
    let cases = rows(&g, "tool");
    assert!(cases.len() >= 400);
    for row in cases {
        let got = native_web_search_tool(&row["args"], row["type"].as_str().unwrap(), row["family"].as_str().unwrap());
        assert_eq!(got, row["out"], "{row}");
        // Key order is part of the wire body.
        assert_eq!(got.to_string(), row["out"].to_string(), "{row}");
    }
}

#[test]
fn tool_types_prompt_and_sources_match_node() {
    let g = golden();
    for row in rows(&g, "types") {
        let got = native_web_search_tool_types(&row["route"], row["family"].as_str().unwrap(), None);
        assert_eq!(json!(got), row["out"], "{row}");
    }
    assert_eq!(native_web_search_tool_types(&json!({"toolType": "x"}), "gemini", Some(" env ")), ["env"]);
    for row in rows(&g, "messages") {
        assert_eq!(json!(native_web_search_messages(&row["in"])), row["out"], "{row}");
    }
    for row in rows(&g, "sources") {
        let got = Value::Array(flatten_sources(&row["in"]));
        assert_eq!(got.to_string(), row["out"].to_string(), "{row}");
    }
}
