//! What the view model decides that the surfaces show: model names, status words and outcome tones, error numbers, and the
//! small text helpers the tool cards share.

use mixdog_view_model::card_model::terminal_status::OutcomeToneInput;
use mixdog_view_model::card_model::{
    clamp_failure_count, derive_tool_outcome_tone, display_terminal_status, merge_terminal_detail, normalize_terminal_status, shell_result_elapsed,
    shell_result_status, strip_leading_status_marker_from_text,
};
use mixdog_view_model::display::model_display::{
    canonical_model_display, display_model_name, effort_display_label, gateway_brand_display, shorten_model_name, title_model_part,
};
use mixdog_view_model::errors::err_text::{error_http_status, format_duration_ms, is_cancel_like_error};
use mixdog_view_model::results::status::{assign_ui_diff_from_message, ui_diff_from_message};
use mixdog_view_model::tool_primitives::{display_model, first_text, pluralize};
use serde_json::json;

// ---- model names ----------------------------------------------------------------------------------------------------------

#[test]
fn a_model_id_reads_as_its_product_name() {
    for (id, shown) in [
        ("claude-opus-4-7", "Claude Opus 4.7"),
        ("claude-3-5-sonnet-20241022", "Claude Sonnet 3.5"),
        ("gpt-5.1-codex-mini", "GPT-5.1-Codex-Mini"),
        ("gpt-5-2025-08-07", "GPT-5"),
        ("gpt-4o", "GPT-4o"),
        ("o3-mini", "O3 Mini"),
        ("deepseek-chat", "DeepSeek Chat"),
        ("grok-4-fast", "Grok 4 Fast"),
        ("gemini-2.5-pro", "Gemini 2.5 Pro"),
        ("gemini-flash", "Gemini Flash"),
        ("kimi-k2.7", "Kimi K2.7"),
        ("glm-4.6", "GLM-4.6"),
        ("qwen3-coder", "Qwen3 Coder"),
        ("mimo-v2-contributor", "MiMo V2"),
    ] {
        assert_eq!(canonical_model_display(id), shown, "{id}");
    }
    assert_eq!(canonical_model_display("mystery-model"), "mystery-model", "an unknown id is shown as it is");
    assert_eq!(gateway_brand_display("mystery-model"), "");
    assert_eq!(title_model_part("gpt"), "GPT");
    assert_eq!(title_model_part("v4"), "V4");
    assert_eq!(title_model_part("foo"), "Foo");
}

#[test]
fn a_display_hint_wins_only_when_it_says_more_than_the_id() {
    assert_eq!(display_model_name("anthropic/claude-opus-4-7", ""), "Claude Opus 4.7", "the vendor prefix is dropped");
    assert_eq!(display_model_name("gpt-5", "My GPT"), "My GPT");
    assert_eq!(display_model_name("gpt-5", "GPT 5"), "GPT-5", "a hint that only re-spaces the id does not replace the canonical name");
    assert_eq!(display_model_name("", "Hint"), "Hint");
    assert_eq!(display_model("vendor/claude-opus-4-7", ""), "Claude Opus 4.7");
    assert_eq!(display_model("", ""), "");
}

#[test]
fn effort_and_narrow_footer_names_are_shortened_by_rule() {
    assert_eq!(effort_display_label("xhigh"), "XHigh");
    assert_eq!(shorten_model_name("Claude Opus 4.7 (1M context)", 200.0), "Opus 4.7 (1M)");
    assert_eq!(shorten_model_name("A very long model display name here", 70.0), "A very long model\u{2026}", "17 columns and an ellipsis under 80");
    assert_eq!(shorten_model_name("", 200.0), "model");
}

// ---- status words and tones -----------------------------------------------------------------------------------------------

#[test]
fn a_status_is_shown_as_one_word_and_unknown_ones_as_none() {
    for (status, word) in [
        ("running", "Running"),
        ("queued", "Running"),
        ("completed", "Finished"),
        ("done", "Finished"),
        ("failed", "Failed"),
        ("canceled", "Cancelled"),
        ("denied", "Denied"),
        ("exit", "Exited"),
        ("whatever", ""),
        ("", ""),
    ] {
        assert_eq!(display_terminal_status(status), word, "{status:?}");
    }
    assert_eq!(normalize_terminal_status("In_Progress"), "running");
}

#[test]
fn the_outcome_tone_is_red_only_for_a_failed_invocation() {
    let tone = |input: OutcomeToneInput| derive_tool_outcome_tone(&input);
    let base = OutcomeToneInput::default;
    assert_eq!(tone(OutcomeToneInput { pending: true, ..base() }), "running");
    assert_eq!(tone(base()), "success");
    assert_eq!(tone(OutcomeToneInput { terminal_status: "cancelled", ..base() }), "warning");
    assert_eq!(tone(OutcomeToneInput { terminal_status: "denied", ..base() }), "warning");
    assert_eq!(tone(OutcomeToneInput { terminal_status: "failed", ..base() }), "warning", "a command that ran and failed is not a red failure");
    assert_eq!(tone(OutcomeToneInput { exit_failed_count: 1.0, ..base() }), "warning");
    assert_eq!(tone(OutcomeToneInput { call_failed_count: 1.0, ..base() }), "error");
    assert_eq!(tone(OutcomeToneInput { call_failed_count: 1.0, partial_mutation: true, ..base() }), "warning", "a failed edit that still committed a diff");
    assert_eq!(tone(OutcomeToneInput { group_count: 3.0, call_failed_count: 1.0, ..base() }), "warning", "some of a group failed");
    assert_eq!(tone(OutcomeToneInput { group_count: 3.0, call_failed_count: 3.0, ..base() }), "error", "every call of a group failed");
}

#[test]
fn a_row_merges_the_status_word_with_its_detail_and_the_time() {
    assert_eq!(merge_terminal_detail("failed", "boom"), "Failed \u{b7} boom");
    assert_eq!(merge_terminal_detail("failed", "failed: boom"), "failed: boom", "a detail that already opens with the word is kept");
    assert_eq!(merge_terminal_detail("completed", ""), "Finished");
    assert_eq!(merge_terminal_detail("running", "queued behind 2"), "queued behind 2");
    assert_eq!(clamp_failure_count(Some(&json!(2.7)), 5.0, false), 2.0);
}

#[test]
fn a_shell_result_reports_its_status_and_elapsed_time_from_its_first_block_only() {
    assert_eq!(shell_result_status("status: Running\nmore"), "running");
    assert_eq!(shell_result_status("header\n\nstatus: failed"), "", "text after a blank line says nothing about the call");
    assert_eq!(shell_result_elapsed("[elapsed: 2500 ms]\nout"), "2s");
    assert_eq!(shell_result_elapsed("[elapsed: 999 ms]"), "");
    assert_eq!(strip_leading_status_marker_from_text("[status: done]\nbody"), "body");
    assert_eq!(strip_leading_status_marker_from_text("body\n[status: done]"), "body\n[status: done]");
}

// ---- error numbers --------------------------------------------------------------------------------------------------------

#[test]
fn the_http_status_is_read_from_the_error_in_a_fixed_order() {
    assert_eq!(error_http_status(Some(&json!({ "httpStatus": 401, "status": 500 }))), 401.0);
    assert_eq!(error_http_status(Some(&json!({ "status": 503 }))), 503.0);
    assert_eq!(error_http_status(Some(&json!({ "response": { "status": 429 } }))), 429.0);
    assert_eq!(error_http_status(Some(&json!({}))), 0.0);
    assert_eq!(error_http_status(None), 0.0);
}

#[test]
fn a_wait_is_written_in_ms_seconds_or_whole_minutes() {
    assert_eq!(format_duration_ms(500.0), "500ms");
    assert_eq!(format_duration_ms(1_499.0), "1s");
    assert_eq!(format_duration_ms(1_500.0), "2s");
    assert_eq!(format_duration_ms(90_000.0), "90s");
    assert_eq!(format_duration_ms(120_000.0), "2m");
    assert_eq!(format_duration_ms(f64::NAN), "0ms");
    assert_eq!(format_duration_ms(-5.0), "0ms");
}

#[test]
fn an_abort_or_a_closed_session_is_a_cancellation_not_a_failure() {
    assert!(is_cancel_like_error(Some(&json!({ "name": "AbortError", "message": "x" }))));
    assert!(is_cancel_like_error(Some(&json!({ "cancelled": true }))));
    assert!(!is_cancel_like_error(Some(&json!("boom"))));
    assert!(!is_cancel_like_error(Some(&json!(null))));
    assert!(!is_cancel_like_error(None));
}

// ---- small helpers --------------------------------------------------------------------------------------------------------

#[test]
fn a_live_message_copies_its_diff_as_text() {
    assert_eq!(ui_diff_from_message(&json!({ "uiDiff": "d" })).as_deref(), Some("d"));
    assert_eq!(ui_diff_from_message(&json!({ "uiDiff": 5 })).as_deref(), Some(""), "a malformed diff is empty text");
    assert_eq!(ui_diff_from_message(&json!({})), None);
    let mut target = json!({ "id": 1 });
    assign_ui_diff_from_message(&mut target, &json!({ "uiDiff": "d" }));
    assert_eq!(target, json!({ "id": 1, "uiDiff": "d" }));
    assign_ui_diff_from_message(&mut target, &json!({}));
    assert_eq!(target, json!({ "id": 1, "uiDiff": "d" }), "a message without a diff leaves the target alone");
}

#[test]
fn the_first_non_blank_text_is_returned_trimmed_and_plural_follows_one() {
    let blank = json!("   ");
    let text = json!(" x ");
    assert_eq!(first_text(&[None, Some(&blank), Some(&text)]), "x");
    assert_eq!(first_text(&[None]), "");
    assert_eq!(pluralize(1.0, "file", "files"), "file");
    assert_eq!(pluralize(0.0, "file", "files"), "files");
    assert_eq!(pluralize(2.0, "file", "files"), "files");
}
