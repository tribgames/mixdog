//! `fixtures/services/media-upstream-twin.json` (`record-media-upstream.mjs`): Node's upstream
//! error translation, usage-limit recognition, base64 decoding of generated media and Veo
//! download addresses over a matrix of statuses, bodies, headers and inputs.

use serde_json::{Value, json};

use super::lanes::LaneError;
use super::upstream::{Headers, UsageLimit, decode_base64_media, gemini_media_download_url, upstream_error, usage_limit_error, usage_limit_from_response, usage_limit_info};

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/services/media-upstream-twin.json");

fn golden() -> Value {
    serde_json::from_str(&GOLDEN).unwrap()
}

fn view(error: &LaneError) -> Value {
    json!({ "message": error.message, "code": error.code, "status": error.status })
}

fn header_list(headers: &Value) -> Vec<(String, String)> {
    headers.as_object().map(|map| map.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()).unwrap_or_default()
}

fn limit_json(limit: Option<UsageLimit>) -> Value {
    limit.map_or(Value::Null, |l| json!({ "limitId": l.limit_id, "resetsAt": l.resets_at }))
}

#[test]
fn failed_responses_read_as_nodes_sentences() {
    for case in golden()["upstreamErrors"].as_array().unwrap() {
        let got = upstream_error(case["label"].as_str().unwrap(), case["status"].as_u64().unwrap() as u16, case["text"].as_str().unwrap());
        assert_eq!(view(&got), case["error"], "{} {}", case["status"], case["text"]);
    }
}

#[test]
fn usage_limits_are_recognised_as_nodes_do() {
    let golden = golden();
    for case in golden["usageInfos"].as_array().unwrap() {
        let headers = header_list(&case["headers"]);
        let got = usage_limit_info(&case["error"], &Headers(&headers));
        assert_eq!(limit_json(got), case["value"], "{} {}", case["error"], case["headers"]);
    }
    for case in golden["usageFromResponse"].as_array().unwrap() {
        let headers = header_list(&case["headers"]);
        let got = usage_limit_from_response(case["status"].as_u64().unwrap() as u16, case["text"].as_str().unwrap(), &Headers(&headers));
        assert_eq!(limit_json(got), case["value"], "{} {} {}", case["status"], case["text"], case["headers"]);
    }
    for case in golden["usageErrors"].as_array().unwrap() {
        let options = &case["options"];
        let resets_at = options["resetsAt"].as_i64().filter(|at| *at != 0);
        let limit = UsageLimit { limit_id: options["limitId"].as_str().unwrap_or_default().to_owned(), resets_at };
        let (error, resets) = usage_limit_error("Codex image", &limit);
        let mut got = view(&error);
        if let Some(at) = resets {
            got["resetsAt"] = json!(at);
        }
        assert_eq!(got, case["error"], "{options}");
    }
}

#[test]
fn generated_media_and_veo_addresses_are_accepted_as_nodes_accepts_them() {
    let golden = golden();
    for case in golden["decoded"].as_array().unwrap() {
        let got = match decode_base64_media(&case["input"], "Grok image") {
            Ok(bytes) => json!({ "value": bytes.iter().map(|b| format!("{b:02x}")).collect::<String>() }),
            Err(error) => json!({ "error": view(&error) }),
        };
        let want = case.get("value").map_or_else(|| json!({ "error": case["error"] }), |v| json!({ "value": v }));
        assert_eq!(got, want, "{}", case["input"]);
    }
    for case in golden["geminiUrls"].as_array().unwrap() {
        let got = match gemini_media_download_url(&case["input"]) {
            Ok(url) => json!({ "value": url }),
            Err(error) => json!({ "error": view(&error) }),
        };
        let want = case.get("value").map_or_else(|| json!({ "error": case["error"] }), |v| json!({ "value": v }));
        assert_eq!(got, want, "{}", case["input"]);
    }
}
