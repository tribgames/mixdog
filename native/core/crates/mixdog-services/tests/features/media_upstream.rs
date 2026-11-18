//! What the media lanes tell the user about an upstream answer, and the usage it reports.

use mixdog_services::media::upstream::{
    Headers, UsageLimit, decode_base64_media, gemini_media_download_url, node_base64, upstream_error, usage_limit_error, usage_limit_from_response, usage_limit_info,
};
use mixdog_services::media::usage::{gemini_usage, has_reported_usage, image_api_usage, interactions_usage, reported_usage, responses_usage, xai_usage};
use serde_json::{Value, json};

// ---- upstream failures ----

fn failure(label: &str, status: u16, body: &str) -> (String, &'static str, u16) {
    let error = upstream_error(label, status, body);
    (error.message, error.code, error.status)
}

#[test]
fn a_rejected_login_tells_the_user_to_sign_in_again() {
    let expected = ("Grok image: authentication rejected — sign in again in Settings → Providers".to_owned(), "MEDIA_AUTH_REJECTED", 401);
    assert_eq!(failure("Grok image", 401, "invalid credentials"), expected);
    assert_eq!(failure("Grok image", 403, r#"{"error":{"message":"denied"}}"#).1, "MEDIA_AUTH_REJECTED");
}

#[test]
fn an_answer_that_speaks_of_money_is_a_billing_block_whatever_the_status() {
    let body = r#"{"error":{"message":"Insufficient credits"}}"#;
    assert_eq!(failure("X", 403, body), ("X: account has no usable balance — Insufficient credits".to_owned(), "MEDIA_BILLING_BLOCKED", 403));
    assert_eq!(failure("X", 400, "spending limit reached").1, "MEDIA_BILLING_BLOCKED");
    assert_eq!(failure("X", 402, "pay up"), ("X: account has no usable balance — pay up".to_owned(), "MEDIA_BILLING_BLOCKED", 402));
}

#[test]
fn rate_limiting_and_other_failures_keep_their_status_and_the_providers_own_sentence() {
    assert_eq!(failure("X", 429, "slow down"), ("X: rate limited — retry in a moment".to_owned(), "MEDIA_RATE_LIMITED", 429));
    assert_eq!(failure("X", 500, ""), ("X failed (500)".to_owned(), "MEDIA_UPSTREAM_FAILED", 500));
    // The sentence is found in `error.message`, `error`, or `message`, in that order.
    assert_eq!(failure("X", 500, r#"{"error":{"message":"boom"},"message":"no"}"#).0, "X failed (500): boom");
    assert_eq!(failure("X", 500, r#"{"error":"plain"}"#).0, "X failed (500): plain");
    assert_eq!(failure("X", 500, r#"{"message":"top"}"#).0, "X failed (500): top");
}

#[test]
fn a_raw_body_is_echoed_only_when_it_is_short_plain_text() {
    assert_eq!(failure("X", 502, "  bad gateway \n").0, "X failed (502): bad gateway");
    assert_eq!(failure("X", 502, "<html><body>oops</body></html>").0, "X failed (502)");
    let long = "y".repeat(500);
    assert_eq!(failure("X", 502, &long).0, format!("X failed (502): {}", "y".repeat(300)));
}

// ---- subscription usage limits ----

fn headers(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

#[test]
fn a_usage_limit_is_told_apart_from_other_errors_and_names_its_limit() {
    let none = headers(&[]);
    assert_eq!(usage_limit_info(&json!({"type": "usage_limit_reached", "limit_id": "codex_image", "resets_at": 1_800_000_000}), &Headers(&none)), Some(UsageLimit { limit_id: "codex_image".into(), resets_at: Some(1_800_000_000) }));
    assert_eq!(usage_limit_info(&json!({"code": "usageLimit"}), &Headers(&none)), Some(UsageLimit { limit_id: String::new(), resets_at: None }));
    assert_eq!(usage_limit_info(&json!({"type": "rate_limit"}), &Headers(&none)), None);
    // The reached-type header alone is enough, and the active-limit header names the limit.
    let by_header = headers(&[("X-Codex-Rate-Limit-Reached-Type", "usage_limit_reached"), ("x-codex-active-limit", "codex_other")]);
    assert_eq!(usage_limit_info(&json!({}), &Headers(&by_header)).unwrap().limit_id, "codex_other");
}

#[test]
fn the_reset_time_falls_back_to_the_latest_exhausted_window_in_the_headers() {
    let h = headers(&[
        ("x-codex-primary-used-percent", "100"),
        ("x-codex-primary-reset-at", "1800000100"),
        ("x-codex-secondary-used-percent", "100"),
        ("x-codex-secondary-reset-at", "1800000900"),
    ]);
    let limit = usage_limit_info(&json!({"type": "usage_limit_reached"}), &Headers(&h)).unwrap();
    assert_eq!(limit.resets_at, Some(1_800_000_900));
    // A window that is not used up does not count.
    let spare = headers(&[("x-codex-primary-used-percent", "99"), ("x-codex-primary-reset-at", "1800000100")]);
    assert_eq!(usage_limit_info(&json!({"type": "usage_limit_reached"}), &Headers(&spare)).unwrap().resets_at, None);
}

#[test]
fn only_a_429_can_be_a_usage_limit_and_its_body_may_nest_the_error() {
    let none = headers(&[]);
    let body = r#"{"error":{"type":"usage_limit_reached","resets_at":1800000000}}"#;
    assert!(usage_limit_from_response(429, body, &Headers(&none)).is_some());
    assert!(usage_limit_from_response(500, body, &Headers(&none)).is_none());
    assert!(usage_limit_from_response(429, "not json", &Headers(&none)).is_none());
}

#[test]
fn the_usage_limit_error_says_when_the_window_resets() {
    let (error, resets) = usage_limit_error("Codex image", &UsageLimit { limit_id: "codex_image".into(), resets_at: Some(1_800_000_000) });
    assert_eq!((error.message.as_str(), error.code, error.status), ("Codex image: image generation usage limit reached — resets 2027-01-15 08:00 UTC", "MEDIA_USAGE_LIMIT", 429));
    assert_eq!(resets.as_deref(), Some("2027-01-15T08:00:00.000Z"));
    let (error, resets) = usage_limit_error("Codex image", &UsageLimit { limit_id: "codex".into(), resets_at: None });
    assert_eq!(error.message, "Codex image: usage limit reached — try again after the usage window resets");
    assert_eq!(resets, None);
}

// ---- generated bytes and Veo addresses ----

#[test]
fn base64_is_decoded_leniently_like_the_providers_senders_expect() {
    assert_eq!(node_base64("aGk="), b"hi");
    assert_eq!(node_base64("aGk"), b"hi", "padding is optional");
    assert_eq!(node_base64("a G\nk="), b"hi", "whitespace is skipped");
    assert_eq!(node_base64("_-8"), node_base64("/+8"), "the URL-safe alphabet is accepted");
    assert_eq!(node_base64("aGk=garbage"), b"hi", "the first = ends the data");
}

#[test]
fn generated_media_must_be_non_empty_text_that_decodes_to_bytes() {
    assert_eq!(decode_base64_media(&json!("aGVsbG8="), "Grok image").unwrap(), b"hello");
    for bad in [json!(""), json!(null), json!(5), json!("!!!!")] {
        let error = decode_base64_media(&bad, "Grok image").unwrap_err();
        assert_eq!((error.message.as_str(), error.code, error.status), ("Grok image exceeds the media size limit", "MEDIA_RESULT_TOO_LARGE", 502), "{bad}");
    }
}

#[test]
fn a_veo_address_is_trusted_only_on_googles_file_host_over_https_without_credentials() {
    let url = gemini_media_download_url(&json!("https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=json&x=1")).unwrap();
    assert_eq!(url, "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media&x=1");
    assert!(gemini_media_download_url(&json!("https://generativelanguage.googleapis.com/f")).unwrap().ends_with("?alt=media"));
    for untrusted in [
        "http://generativelanguage.googleapis.com/f",
        "https://evil.example/f",
        "https://user:pw@generativelanguage.googleapis.com/f",
        "https://generativelanguage.googleapis.com.evil.example/f",
    ] {
        assert_eq!(gemini_media_download_url(&json!(untrusted)).unwrap_err().message, "Veo returned an untrusted video URI", "{untrusted}");
    }
    for invalid in [json!("not a url"), json!(null), json!("")] {
        assert_eq!(gemini_media_download_url(&invalid).unwrap_err().message, "Veo returned an invalid video URI", "{invalid}");
    }
}

// ---- reported usage ----

#[test]
fn gemini_usage_adds_thoughts_to_the_output_and_counts_image_tokens_apart() {
    let meta = json!({
        "promptTokenCount": 10, "cachedContentTokenCount": 3, "candidatesTokenCount": 20, "thoughtsTokenCount": 5,
        "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 7}, {"modality": "text", "tokenCount": 9}, {"modality": "image", "tokenCount": 1}],
    });
    let usage = gemini_usage(&meta).unwrap();
    assert_eq!(usage, json!({"inputTokens": 10, "cachedTokens": 3, "outputTokens": 25, "outputImageTokens": 8}));
    // Snake_case aliases carry the same counts and preserve an explicitly reported output zero.
    assert_eq!(gemini_usage(&json!({"prompt_token_count": 4, "candidates_token_count": 0})).unwrap(), json!({"inputTokens": 4, "outputTokens": 0}));
    for nothing in [json!({}), json!(null), json!({"promptTokenCount": -3}), json!("x")] {
        assert_eq!(gemini_usage(&nothing), None, "{nothing}");
    }
}

#[test]
fn the_other_providers_usage_objects_are_read_by_their_own_names() {
    let omni = json!({"total_input_tokens": 12, "total_cached_tokens": 2, "total_output_tokens": 30, "total_thought_tokens": 4, "output_tokens_by_modality": [{"modality": "VIDEO", "tokens": 25}, {"modality": "text", "tokens": 5}]});
    assert_eq!(interactions_usage(&omni).unwrap(), json!({"inputTokens": 12, "cachedTokens": 2, "outputTokens": 34, "outputVideoTokens": 25}));
    let responses = json!({"input_tokens": 100, "input_tokens_details": {"cached_tokens": 60}, "output_tokens": 40.9});
    assert_eq!(responses_usage(&responses).unwrap(), json!({"inputTokens": 100, "cachedTokens": 60, "outputTokens": 40}));
    assert_eq!(responses_usage(&json!({"input_tokens": 0})), None);
}

#[test]
fn only_a_reported_output_zero_is_preserved_without_making_a_failure_billable() {
    for (format, usage) in [
        ("Gemini", gemini_usage(&json!({"candidatesTokenCount": 0, "thoughtsTokenCount": 0}))),
        ("Interactions", interactions_usage(&json!({"total_output_tokens": 0}))),
        ("Responses", responses_usage(&json!({"output_tokens": 0}))),
        ("Image API", image_api_usage(&json!({"usage": {"completion_tokens": 0}}))),
    ] {
        assert_eq!(usage, Some(json!({"outputTokens": 0})), "{format}");
        assert_eq!(reported_usage(usage), None, "{format}");
    }
    assert_eq!(
        reported_usage(image_api_usage(&json!({"usage": {"completion_tokens": 0, "cost": 0.04}}))),
        Some(json!({"outputTokens": 0, "costUsd": 0.04})),
    );

    let input_only = Some(json!({"inputTokens": 4}));
    assert_eq!(responses_usage(&json!({"input_tokens": 4})), input_only);
    for invalid in [json!(null), json!(false), json!(""), json!("0"), json!([]), json!(-1), json!(0.9)] {
        assert_eq!(responses_usage(&json!({"input_tokens": 4, "output_tokens": invalid})), input_only, "{invalid}");
    }
    assert_eq!(gemini_usage(&json!({"thoughtsTokenCount": 0})), None);
    assert_eq!(interactions_usage(&json!({"total_output_tokens": 0, "total_thought_tokens": "invalid"})), None);
    assert_eq!(
        interactions_usage(&json!({"total_thought_tokens": 0, "output_tokens_by_modality": [{"modality": "video", "tokens": 3}]})),
        Some(json!({"outputVideoTokens": 3})),
    );
    assert_eq!(gemini_usage(&json!({"thoughtsTokenCount": "2"})), Some(json!({"outputTokens": 2})));
}

#[test]
fn xai_reports_its_cost_in_ticks_of_a_ten_billionth_of_a_dollar() {
    assert_eq!(xai_usage(&json!({"cost_in_usd_ticks": 500_000_000})).unwrap(), json!({"costUsd": 0.05}));
    assert_eq!(xai_usage(&json!({"cost_in_usd_ticks": 0})).unwrap(), json!({"costUsd": 0}));
    assert_eq!(xai_usage(&json!({"cost_in_usd_ticks": -1})), None);
    assert_eq!(xai_usage(&json!({})), None);
}

#[test]
fn an_image_api_cost_counts_from_usage_or_from_a_top_level_cost_paid_in_dollars() {
    let tokens = json!({"prompt_tokens": 7, "completion_tokens": 3, "completion_tokens_details": {"image_tokens": 2}});
    assert_eq!(image_api_usage(&json!({"usage": tokens})).unwrap(), json!({"inputTokens": 7, "outputTokens": 3, "outputImageTokens": 2}));
    assert_eq!(image_api_usage(&json!({"usage": {"cost": 0.04}})).unwrap(), json!({"costUsd": 0.04}));
    // NanoGPT's own cost may be billed in another currency: it counts only when paid in USD.
    assert_eq!(image_api_usage(&json!({"cost": 0.5, "paymentSource": "usd"})).unwrap(), json!({"costUsd": 0.5}));
    assert_eq!(image_api_usage(&json!({"cost": 0.5, "paymentSource": "XNO"})), None);
    assert_eq!(image_api_usage(&json!({"cost": 0.5})), None);
    assert_eq!(image_api_usage(&json!({"usage": {"cost": 0.04}, "cost": 9, "paymentSource": "USD"})).unwrap(), json!({"costUsd": 0.04}), "the usage figure wins");
}

#[test]
fn a_failed_request_keeps_only_usage_somebody_would_bill() {
    for billable in [json!({"costUsd": 0.01}), json!({"inputTokens": 3}), json!({"seconds": 4})] {
        assert!(has_reported_usage(&billable), "{billable}");
        assert_eq!(reported_usage(Some(billable.clone())), Some(billable));
    }
    for unbilled in [json!({"outputImageTokens": 9}), json!({}), Value::Null] {
        assert!(!has_reported_usage(&unbilled), "{unbilled}");
        assert_eq!(reported_usage(Some(unbilled)), None);
    }
    assert_eq!(reported_usage(None), None);
}
