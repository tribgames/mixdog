//! What the host removes from a text or a URL before it leaves the machine, and when a URL is judged to carry a secret.

use mixdog_browser_policy::redaction::redact_text;
use mixdog_browser_policy::redaction::redact_url;
use mixdog_browser_policy::redaction::url_contains_secret;

fn text(value: &str) -> String {
    redact_text(value, &[])
}

fn masked(value: &str, secrets: &[&str]) -> String {
    redact_text(value, &secrets.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>())
}

#[test]
fn secret_named_query_parameters_with_a_value_make_a_url_secret() {
    for name in ["api_key", "password", "PASSWORD", "session-id", "sessionToken", "session_token", "token"] {
        assert!(url_contains_secret(&format!("https://example.com/?{name}=x")), "{name}");
    }
    for url in ["https://example.com/?secret=", "https://example.com/?mytoken=abc", "https://example.com/?api+key=abc", "https://example.com/docs?key=keyboard"]
    {
        assert!(!url_contains_secret(url), "{url}");
    }
}

#[test]
fn a_code_parameter_is_a_secret_from_eight_utf16_units() {
    assert!(!url_contains_secret("https://example.com/?code=1234567"));
    assert!(url_contains_secret("https://example.com/?code=12345678"));
    assert!(url_contains_secret("https://example.com/?CODE=12345678"));
    // An astral character is two UTF-16 units: four of them make eight, three make six.
    assert!(url_contains_secret("https://example.com/?code=%F0%9F%98%80%F0%9F%98%80%F0%9F%98%80%F0%9F%98%80"));
    assert!(!url_contains_secret("https://example.com/?code=%F0%9F%98%80%F0%9F%98%80%F0%9F%98%80"));
}

#[test]
fn token_shapes_are_found_in_the_url_text_and_in_its_decodings() {
    for url in [
        "https://example.com/%67%68%70%5Fabcdefghijklmnopqrstuvwxyz",
        "https://example.test/%2567%2568%2570%255Fabcdefghijklmnopqrstuvwxyz",
        "https://example.test/Bearer+abcdefghijklmnop",
        "https://example.test/%zz/ghp_abcdefghijklmnopqrstuvwxyz",
        "https://example.test/%+1/ghp_abcdefghijklmnopqrstuvwxyz",
        "https://example.test/%C0%80/sk-abcdefghijklmnopqrstu",
        "ghp_abcdefghijklmnopqrstuvwxyz",
        "https://example.com/github_pat_abcdefghijklmnopqrstuvwxyz",
        "https://example.com/xoxb-1234567890-abcdef",
        "https://example.com/AKIAABCDEFGHIJKLMNOP",
        "https://example.com/Basic%20QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
        "https://example.com/éghp_abcdefghijklmnopqrstuvwxyz",
        "https://example.com/Bearer\u{feff}abcdefghijklmnop",
    ] {
        assert!(url_contains_secret(url), "{url}");
    }
}

#[test]
fn decoding_is_bounded_and_a_token_must_start_at_an_ascii_word_boundary() {
    for url in [
        // Three levels of escaping are more than the two decodings that are tried.
        "https://example.test/%252567%252568%252570%25255Fabcdefghijklmnopqrstuvwxyz",
        "https://example.com/xghp_abcdefghijklmnopqrstuvwxyz",
        "https://example.test/%zz",
        "https://example.test/%2",
        "https://example.test/%E2%82%AC?x=1",
        "",
        "just some words",
    ] {
        assert!(!url_contains_secret(url), "{url:?}");
    }
}

#[test]
fn credentials_tokens_and_assignments_are_replaced_in_a_text() {
    assert_eq!(
        text("https://alice:secret@example.com/?access_token=abc123 sk-proj-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz"),
        "https://alice:***@example.com/?access_token=[REDACTED] [REDACTED_KEY] [REDACTED_GITHUB_TOKEN]"
    );
    assert_eq!(text("token=synthetic-test-value"), "token=[REDACTED]");
    assert_eq!(text("{\"access_token\":\"opaque-value\",\"name\":\"safe\"}"), "{\"access_token\":[REDACTED],\"name\":\"safe\"}");
    assert_eq!(text("{ \"password\" : \"synthetic test value\", \"name\": \"public\" }"), "{ \"password\" : [REDACTED], \"name\": \"public\" }");
    assert_eq!(text("{'token': 'abc def', 'x': 1}"), "{'token': [REDACTED], 'x': 1}");
    assert_eq!(text("secret: \"a b c\", other: 1"), "secret: [REDACTED], other: 1");
    assert_eq!(text("token=abc,next=1;other=2"), "token=[REDACTED],next=1;other=2");
    assert_eq!(text("password: correct horse battery staple"), "password: [REDACTED] horse battery staple");
}

#[test]
fn every_secret_key_spelling_is_recognised_in_assignments() {
    assert_eq!(
        text("api-key=1 apikey: 2 id_token = 3 refresh-token=4 secret:5 passwd=6 session-id=7 sessionToken=8"),
        "api-key=[REDACTED] apikey: [REDACTED] id_token = [REDACTED] refresh-token=[REDACTED] secret:[REDACTED] passwd=[REDACTED] session-id=[REDACTED] sessionToken=[REDACTED]"
    );
}

#[test]
fn authorization_values_are_replaced_whole() {
    assert_eq!(text("Authorization: Bearer MIXDOG_SYNTHETIC_ONLY_0123456789"), "Authorization: [REDACTED]");
    assert_eq!(text("authorization = Basic QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo="), "authorization = [REDACTED]");
    assert_eq!(text("bearer abcdefghijklmnop"), "[REDACTED_AUTH]");
    assert_eq!(text("Bearer\u{feff}abcdefghijklmnop Bearer\u{a0}abcdefghijklmnop"), "[REDACTED_AUTH] [REDACTED_AUTH]");
    assert_eq!(text("Bearer short"), "Bearer short");
    // U+0085 is not whitespace to the pattern, so this is not a bearer credential.
    assert_eq!(text("Bearer\u{85}abcdefghijklmnop"), "Bearer\u{85}abcdefghijklmnop");
}

#[test]
fn each_kind_of_credential_shape_gets_its_own_marker() {
    assert_eq!(
        text("ghp_aaaaaaaaaaaaaaaaaaaa gho_aaaaaaaaaaaaaaaaaaaa ghu_aaaaaaaaaaaaaaaaaaaa ghs_aaaaaaaaaaaaaaaaaaaa ghr_aaaaaaaaaaaaaaaaaaaa"),
        "[REDACTED_GITHUB_TOKEN] [REDACTED_GITHUB_TOKEN] [REDACTED_GITHUB_TOKEN] [REDACTED_GITHUB_TOKEN] [REDACTED_GITHUB_TOKEN]"
    );
    assert_eq!(text("use github_pat_11AAAAAAA0abcdefghijklmnop please"), "use [REDACTED_GITHUB_TOKEN] please");
    assert_eq!(text("xoxp-1234567890-abc AKIAABCDEFGHIJKLMNOP"), "[REDACTED_SLACK_TOKEN] [REDACTED_AWS_KEY]");
    assert_eq!(text("jwt eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImRldiJ9.c2lnbmF0dXJlLXZhbHVl end"), "jwt [REDACTED_JWT] end");
    assert_eq!(text("sk-abcdefghijklmnopqrstu rk-abcdefghijklmnopqrstu pk-proj-abcdefghijklmnopqrstu"), "[REDACTED_KEY] [REDACTED_KEY] [REDACTED_KEY]");
    assert_eq!(text("sk-short and task-abcdefghijklmnopqrstu"), "sk-short and task-abcdefghijklmnopqrstu");
    assert_eq!(text("éghp_abcdefghijklmnopqrstuvwxyz"), "é[REDACTED_GITHUB_TOKEN]");
}

#[test]
fn only_a_url_password_is_masked_in_a_text_not_a_bare_user() {
    assert_eq!(text("https://alice@example.com/"), "https://alice@example.com/");
    assert_eq!(text("visit http://bob:hunter2@host.test:8080/x now"), "visit http://bob:***@host.test:8080/x now");
    assert_eq!(text("http://a:b@x.test/ and HTTPS://c:d@y.test/"), "http://a:***@x.test/ and HTTPS://c:***@y.test/");
}

#[test]
fn query_secrets_in_a_text_end_at_the_next_separator() {
    assert_eq!(text("GET /cb?code=abc&state=public&key=k1&auth=a2#frag"), "GET /cb?code=[REDACTED]&state=public&key=[REDACTED]&auth=[REDACTED]#frag");
    assert_eq!(text("see ?token=abc def"), "see ?token=[REDACTED] def");
    assert_eq!(text("https://example.test/?token=synthetic-test-value"), "https://example.test/?token=[REDACTED]");
}

#[test]
fn cookie_header_lines_lose_their_whole_value() {
    assert_eq!(text("Set-Cookie: sid=abc; Path=/; HttpOnly\nContent-Type: text/html"), "Set-Cookie: [REDACTED]\nContent-Type: text/html");
    assert_eq!(text("COOKIE:   a=b; c=d"), "COOKIE:   [REDACTED]");
    assert_eq!(text("before\r\nCookie: a=b\r\nafter"), "before\r\nCookie: [REDACTED]\r\nafter");
    assert_eq!(text("x\u{2028}Set-Cookie: a=b\u{2029}y"), "x\u{2028}Set-Cookie: [REDACTED]\u{2029}y");
    assert_eq!(text("my cookie: a=b"), "my cookie: a=b", "a cookie word inside a line is not a header");
}

#[test]
fn redacting_already_redacted_text_changes_nothing() {
    assert_eq!(text("Authorization: [REDACTED STORED CREDENTIAL]"), "Authorization: [REDACTED]");
    assert_eq!(text("token: [REDACTED_KEY] tail"), "token: [REDACTED] tail");
    assert_eq!(text("Authorization: [REDACTED]"), "Authorization: [REDACTED]");
    assert_eq!(text("日本語のテキスト 😀"), "日本語のテキスト 😀");
    assert_eq!(text(""), "");
}

#[test]
fn a_known_secret_is_masked_to_its_own_length_and_a_long_one_becomes_the_marker() {
    assert_eq!(masked("abc", &["", "b"]), "a*c", "an empty secret is skipped");
    assert_eq!(masked("pw pw pw", &["pw"]), "** ** **");
    assert_eq!(masked("a ***** b", &["*****"]), "a ••••• b", "a secret made of mask characters shows bullets");
    assert_eq!(masked("x 😀😀 y", &["😀😀"]), "x **** y", "length counts UTF-16 units");
    assert_eq!(masked("value is hunter2hunter2hunter2hunter2 ok", &["hunter2hunter2hunter2hunter2"]), "value is [REDACTED STORED CREDENTIAL] ok");
    assert_eq!(masked("x 123456789012345678901234567A x", &["123456789012345678901234567A"]), "x [REDACTED STORED CREDENTIAL] x");
    assert_eq!(masked("a password can be short: a", &["a", "*"]), "• p•ssword c•n be short: •");
}

#[test]
fn a_url_loses_its_user_password_and_secret_query_values() {
    assert_eq!(redact_url("https://alice:secret@example.com/path?x=1"), "https://%5BREDACTED%5D:***@example.com/path?x=1");
    assert_eq!(redact_url("https://alice@example.com/"), "https://%5BREDACTED%5D@example.com/");
    assert_eq!(redact_url("https://example.test/callback?code=opaque-code&state=public"), "https://example.test/callback?code=[REDACTED]&state=public");
    assert_eq!(redact_url("https://example.test/p?token=a#section"), "https://example.test/p?token=[REDACTED]#section");
    assert_eq!(redact_url("https://example.test/?token=&x=1"), "https://example.test/?token=[REDACTED]&x=1");
    assert_eq!(redact_url("https://example.test/ghp_abcdefghijklmnopqrstuvwxyz/x"), "https://example.test/[REDACTED_GITHUB_TOKEN]/x");
}

#[test]
fn a_repeated_secret_parameter_keeps_only_its_first_occurrence() {
    assert_eq!(redact_url("https://example.test/?token=a&x=1&token=b"), "https://example.test/?token=[REDACTED]&x=1");
}

#[test]
fn secret_named_parameters_match_by_whole_key_or_key_suffix_spelling() {
    assert_eq!(
        redact_url("https://example.test/?Access_Token=a&API-KEY=b&mykey=c&author=d&plain=e"),
        "https://example.test/?Access_Token=[REDACTED]&API-KEY=[REDACTED]&mykey=%5BREDACTED%5D&author=%5BREDACTED%5D&plain=e"
    );
}

#[test]
fn a_url_without_secret_parameters_keeps_its_query_spelling() {
    assert_eq!(redact_url("https://example.test/?q=a+b&r=%7e"), "https://example.test/?q=a+b&r=%7e");
    assert_eq!(redact_url("https://example.test"), "https://example.test/");
}

#[test]
fn text_that_is_not_an_absolute_url_is_redacted_as_text() {
    assert_eq!(redact_url("plain text token=abc"), "plain text token=[REDACTED]");
    assert_eq!(redact_url("/cb?token=abc"), "/cb?token=[REDACTED]");
    assert_eq!(redact_url("mailto:someone@example.com?subject=hi"), "mailto:someone@example.com?subject=hi");
    assert_eq!(redact_url(""), "");
}
