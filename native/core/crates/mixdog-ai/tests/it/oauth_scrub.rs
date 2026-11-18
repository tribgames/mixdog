//! The redaction every provider error text and response excerpt passes before it leaves the process.

use mixdog_ai::oauth::scrub::scrub_muse_secrets;
use mixdog_ai::oauth::scrub::scrub_oauth_secrets;

fn scrub(text: &str) -> String {
    scrub_oauth_secrets(text, &[])
}

#[test]
fn a_body_with_nothing_secret_comes_back_as_it_came() {
    for text in ["hello", "   ", "{ \"a\" : 1 }", "123", "a   b\tc  "] {
        assert_eq!(scrub(text), text);
    }
}

#[test]
fn secret_fields_of_a_json_body_are_redacted_at_any_depth() {
    assert_eq!(scrub(r#"{"a":[{"access_token":"x"},{"token":5}]}"#), r#"{"a":[{"access_token":"[REDACTED]"},{"token":5}]}"#);
    assert_eq!(scrub(r#"[{"token":"t"}]"#), r#"[{"token":"[REDACTED]"}]"#);
    assert_eq!(scrub(r#"{"a":{"b":{"c":{"secret":"s"}}}}"#), r#"{"a":{"b":{"c":{"secret":"[REDACTED]"}}}}"#);
    assert_eq!(scrub(r#"{"Key": "v", "KEY": "w"}"#), r#"{"Key":"[REDACTED]","KEY":"[REDACTED]"}"#, "names match whatever their case");
}

#[test]
fn an_escaped_field_name_cannot_slip_past() {
    assert_eq!(scrub(r#"{"client\u005fsecret":"zzz"}"#), r#"{"client_secret":"[REDACTED]"}"#);
}

#[test]
fn only_whole_secret_field_names_are_redacted() {
    let body = r#"{"code":"abc","tokens":"x","keys":"y","apiKeyId":"i"}"#;
    assert_eq!(scrub(body), body);
}

#[test]
fn a_truncated_body_is_still_redacted_as_text() {
    assert_eq!(scrub(r#"{"access_token":"abc"#), r#"{"access_token":"[REDACTED]""#, "the unfinished value is replaced whole");
    assert_eq!(scrub(r#"{"password":"a\"b","y":1"#), r#"{"password":"[REDACTED]","y":1"#);
}

#[test]
fn form_encoded_secret_fields_are_redacted_and_other_fields_kept() {
    assert_eq!(scrub("token=abc"), "token=[REDACTED]");
    assert_eq!(scrub("code=abc&Code_Verifier=v"), "code=abc&Code_Verifier=[REDACTED]");
    assert_eq!(scrub(r#"{"body":"a=1&password=p"}"#), r#"{"body":"a=1&password=[REDACTED]"}"#);
}

#[test]
fn bearer_credentials_and_jwts_are_redacted_wherever_they_appear() {
    assert_eq!(scrub("Bearer a Bearer b"), "Bearer [REDACTED] Bearer [REDACTED]");
    assert_eq!(scrub("authorization: bearer lower.case"), "authorization: Bearer [REDACTED]");
    assert_eq!(scrub("stack eyJhbGciOiJ.eyJzdWIiO.c2lnbmF0 tail"), "stack [REDACTED] tail");
    assert_eq!(scrub("key sk-ant-abc123_x.y end"), "key [REDACTED] end");
}

#[test]
fn the_secret_values_the_caller_names_are_redacted_and_empty_ones_ignored() {
    assert_eq!(scrub_oauth_secrets("the zzz value", &["zzz"]), "the [REDACTED] value");
    assert_eq!(scrub_oauth_secrets("nothing here", &["", "zzz"]), "nothing here");
}

#[test]
fn a_muse_body_also_loses_its_api_key_field() {
    assert_eq!(scrub_muse_secrets(r#"x "api_key" : "k1" y"#, &[]), r#"x "api_key":"[REDACTED]" y"#);
}
