//! The shared ground of the relay: JavaScript string and JSON rules, the rate limiter, routing ids, close codes, the
//! configuration defaults and the log lines. Expectations are literals recorded from Node (`JSON.stringify` output, the
//! tests of `apps/relay/security.test.mjs`); the close codes are also compared with the Node sources read as text.

use std::collections::BTreeMap;
use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_relay::close_codes as codes;
use mixdog_relay::config::Config;
use mixdog_relay::ids::{is_registrable_device_id, is_routing_id};
use mixdog_relay::logline::{self, LoopDelay, SocketBuffer, Stream};
use mixdog_relay::rate_limit::RateLimiter;
use mixdog_relay::{js, tools};

fn relay_source(file: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../apps/relay");
    mixdog_fsio::read_to_string(&Unlaned, root.join(file)).unwrap_or_else(|e| panic!("read apps/relay/{file}: {e}"))
}

// ---- js.rs ----

#[test]
fn a_name_clipped_inside_an_emoji_round_trips_as_a_lone_surrogate_escape() {
    // 79 ASCII characters and an emoji: `.slice(0, 80)` keeps the high surrogate only.
    let name = format!("{}\u{1F600}", "a".repeat(79));
    assert_eq!(js::js_len(&name), 81);
    let clipped = js::js_slice(&name, 80);
    assert_eq!(js::js_len(&clipped), 80);
    let expected = format!("\"{}\\ud83d\"", "a".repeat(79));
    let value = serde_json::Value::String(clipped);
    assert_eq!(js::wire(&value), expected);
    let reparsed = js::parse(&expected).expect("the escape parses");
    assert_eq!(reparsed, value);
    assert_eq!(js::pretty(&reparsed), expected);
}

#[test]
fn a_slice_past_the_end_is_the_whole_text() {
    assert_eq!(js::js_slice("abc", 80), "abc");
    assert_eq!(js::js_slice("abc", 0), "");
}

#[test]
fn array_index_keys_are_written_first_in_ascending_order() {
    let value = js::parse(r#"{"abcdef01":{"x":1},"12345678":2}"#).expect("parses");
    assert_eq!(js::wire(&value), r#"{"12345678":2,"abcdef01":{"x":1}}"#);
    assert_eq!(js::pretty(&value), "{\n  \"12345678\": 2,\n  \"abcdef01\": {\n    \"x\": 1\n  }\n}");
}

#[test]
fn a_duplicate_key_keeps_its_first_place_and_its_last_value() {
    let value = js::parse(r#"{"a":1,"b":2,"a":3}"#).expect("parses");
    assert_eq!(js::wire(&value), r#"{"a":3,"b":2}"#);
}

#[test]
fn a_lone_surrogate_sent_as_text_becomes_the_replacement_character() {
    let value = js::parse(r#""x\ud800y""#).expect("parses");
    let text = value.as_str().expect("a string");
    assert_eq!(js::js_len(text), 3);
    assert_eq!(js::node_utf8(text), b"x\xEF\xBF\xBDy");
    assert_eq!(js::node_utf8("h\u{e9}llo"), "h\u{e9}llo".as_bytes());
}

#[test]
fn bytes_that_are_not_utf8_are_decoded_with_replacement_characters() {
    assert_eq!(js::decode_utf8(b"a\xFFb"), "a\u{FFFD}b");
    let value = js::parse_bytes(b"\"a\xE2\x82\"").expect("parses");
    assert_eq!(value, serde_json::json!("a\u{FFFD}"));
}

#[test]
fn trim_uses_the_javascript_white_space_set() {
    assert_eq!(js::js_trim("\u{feff} a b \u{a0}\n"), "a b");
}

// ---- rate_limit.rs (the RateLimiter case of security.test.mjs and the cap) ----

#[test]
fn a_key_is_admitted_up_to_its_limit_in_a_window() {
    let mut limiter = RateLimiter::new(2, 60_000);
    assert!(limiter.allow("device-a"));
    assert!(limiter.allow("device-a"));
    assert!(!limiter.allow("device-a"));
    assert!(limiter.allow("device-b"));
}

#[test]
fn hits_age_out_of_the_window_and_retry_after_names_when() {
    let mut limiter = RateLimiter::new(2, 60_000);
    assert!(limiter.allow_at("k", 0));
    assert_eq!(limiter.retry_after_ms_at("k", 5), 0);
    assert!(limiter.allow_at("k", 10));
    assert!(!limiter.allow_at("k", 20));
    assert_eq!(limiter.retry_after_ms_at("k", 20), 59_980);
    assert_eq!(limiter.retry_after_ms_at("other", 20), 0);
    // A hit counts while stamp > now - window: at 60_000 the first has aged out.
    assert!(!limiter.allow_at("k", 59_999));
    assert!(limiter.allow_at("k", 60_001));
}

#[test]
fn an_empty_key_is_the_unknown_key() {
    let mut limiter = RateLimiter::new(1, 1_000);
    assert!(limiter.allow_at("", 0));
    assert!(!limiter.allow_at("unknown", 1));
}

#[test]
fn a_full_table_evicts_the_least_recently_used_key() {
    let mut limiter = RateLimiter::with_max_keys(1, 1_000_000, 2);
    assert!(limiter.allow_at("a", 0));
    assert!(limiter.allow_at("b", 1));
    assert!(limiter.allow_at("c", 2)); // evicts a
    assert!(limiter.allow_at("a", 3)); // a is new again, evicts b
    assert!(!limiter.allow_at("c", 4)); // c is still remembered
    assert!(limiter.allow_at("b", 5)); // b was evicted
}

#[test]
fn a_full_table_first_drops_the_keys_whose_hits_expired() {
    let mut limiter = RateLimiter::with_max_keys(1, 10, 2);
    assert!(limiter.allow_at("a", 0));
    assert!(limiter.allow_at("b", 1));
    assert!(limiter.allow_at("c", 100)); // the sweep drops a and b
    assert!(limiter.allow_at("a", 101));
    assert!(limiter.allow_at("b", 102)); // full of live keys: c, the oldest, goes
    assert!(limiter.allow_at("c", 103));
}

// ---- ids.rs ('routing ids share one predicate across store, HTTP, and binary frames') ----

#[test]
fn routing_id_predicate_shared_everywhere() {
    assert!(is_routing_id("12345678-abcd-4321-abcd-1234567890ab"));
    assert!(is_routing_id("12345678")); // Node coerces the number 12345678
    assert!(is_routing_id("00000001"));
    assert!(!is_routing_id("0000001"));
    assert!(!is_routing_id(""));
    assert!(!is_routing_id("null"));
    assert!(is_routing_id(&"a".repeat(64)));
    assert!(!is_routing_id(&"a".repeat(65)));
    assert!(!is_routing_id("ABCDEF01"));
    assert!(!is_routing_id("12345678\n"));
    assert!(!is_routing_id("1234567\u{e9}"));
}

#[test]
fn registrable_device_ids_are_a_uuid_or_long_hex() {
    assert!(is_registrable_device_id("12345678-abcd-4321-abcd-1234567890ab"));
    assert!(is_registrable_device_id(&"0123456789abcdef".repeat(2)));
    assert!(is_registrable_device_id(&"0123456789abcdef".repeat(4)));
    assert!(!is_registrable_device_id(&"0123456789abcdef".repeat(5)));
    assert!(!is_registrable_device_id("0123456789abcdef"));
    assert!(!is_registrable_device_id("12345678-abcd-4321-abcd-1234567890a"));
    assert!(!is_registrable_device_id("12345678-ABCD-4321-abcd-1234567890ab"));
    assert!(!is_registrable_device_id(""));
}

// ---- close_codes.rs ----

#[test]
fn close_codes_match_the_node_sources() {
    let table = relay_source("lib/relay-close-codes.mjs");
    assert!(table.contains(&format!("DESKTOP_OFFLINE_CLOSE = {}", codes::DESKTOP_OFFLINE)));
    assert!(table.contains(&format!("DESKTOP_HANDSHAKE_STALLED_CLOSE = {}", codes::DESKTOP_HANDSHAKE_STALLED)));

    let server = relay_source("server.mjs");
    assert!(server.contains(&format!("close({}, '{}')", codes::SUPERSEDED, codes::SUPERSEDED_REASON)));
    assert!(server.contains(&format!("{}, '{}'", codes::PAIRING_RESCAN_REQUIRED, codes::PAIRING_RESCAN_REQUIRED_REASON)));
    assert!(server.contains(&format!("ws.close({}, '{}')", codes::SLOW_PEER, codes::SLOW_PRODUCER_REASON)));
    assert!(server.contains(&format!("ws.close({}, '{}')", codes::RELAY_BUSY, codes::RELAY_BUSY_REASON)));
    assert!(server.contains(&format!("DESKTOP_OFFLINE_CLOSE, '{}'", codes::DESKTOP_OFFLINE_REASON)));

    let legs = relay_source("lib/relay-legs.mjs");
    assert!(legs.contains(&format!("closeQuietly(phone, {}, '{}')", codes::REVOKED, codes::PAIRING_REVOKED_REASON)));
    assert!(legs.contains(&format!("closeQuietly(socket, {}, '{}')", codes::REVOKED, codes::DEVICE_REVOKED_REASON)));
    assert!(legs.contains(&format!(
        "closeQuietly(phone, {}, String(message.reason || '{}').slice(0, {}))",
        codes::DESKTOP_REJECTED_CLIENT,
        codes::DESKTOP_REJECTED_CLIENT_REASON,
        codes::DESKTOP_REJECTED_CLIENT_REASON_MAX
    )));
    assert!(legs.contains(&format!("DESKTOP_HANDSHAKE_STALLED_CLOSE, '{}'", codes::DESKTOP_HANDSHAKE_STALLED_REASON)));
    assert!(legs.contains(&format!("DESKTOP_OFFLINE_CLOSE, '{}'", codes::DESKTOP_OFFLINE_REASON)));

    let transport = relay_source("lib/relay-transport.mjs");
    assert!(transport.contains(&format!(
        "socket.close(busy ? {} : {}, busy ? '{}' : '{}')",
        codes::RELAY_BUSY,
        codes::SLOW_PEER,
        codes::RELAY_BUSY_REASON,
        codes::SLOW_CONSUMER_REASON
    )));
    assert!(transport.contains(&format!("({})", codes::MESSAGE_TOO_BIG)));

    let hook = relay_source("lib/relay-hook.mjs");
    assert!(hook.contains(&format!("close({}, '{}')", codes::SUPERSEDED, codes::SUPERSEDED_REASON)));
}

#[test]
fn the_pc_offline_close_is_its_own_code_and_never_a_pairing_revoking_one() {
    assert_eq!(codes::DESKTOP_OFFLINE, 4002);
    let revoking = [codes::REVOKED, codes::DESKTOP_REJECTED_CLIENT, codes::PAIRING_RESCAN_REQUIRED];
    assert!(!revoking.contains(&codes::DESKTOP_OFFLINE));
    let others = [
        codes::SUPERSEDED,
        codes::DESKTOP_OFFLINE,
        codes::REVOKED,
        codes::DESKTOP_REJECTED_CLIENT,
        codes::PAIRING_RESCAN_REQUIRED,
        codes::SLOW_PEER,
        codes::RELAY_BUSY,
    ];
    assert!(!others.contains(&codes::DESKTOP_HANDSHAKE_STALLED));
}

// ---- config.rs ----

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

#[test]
fn the_defaults_are_those_of_the_cli_block() {
    let config = Config::from_env(env(&[]), PathBuf::from("/opt/mixdog-relay"));
    assert_eq!(config.port, 9800.0);
    assert_eq!(config.listen_port(), Ok(9800));
    assert_eq!(config.data_dir, "./data");
    assert_eq!(config.renderer_dir, "");
    assert_eq!(config.renderer_releases_dir, "");
    assert_eq!(config.tls_cert, "");
    assert_eq!(config.tls_key, "");
    assert_eq!(config.scheme(), "http");
    assert_eq!(config.install_dir, PathBuf::from("/opt/mixdog-relay"));
}

#[test]
fn empty_values_take_the_defaults_like_node_or() {
    let config = Config::from_env(env(&[("PORT", ""), ("DATA_DIR", ""), ("RENDERER_DIR", ""), ("TLS_CERT", "c"), ("TLS_KEY", "k")]), PathBuf::new());
    assert_eq!(config.listen_port(), Ok(9800));
    assert_eq!(config.data_dir, "./data");
    assert_eq!(config.scheme(), "https");
}

#[test]
fn a_port_is_a_javascript_number_and_listen_rejects_what_node_rejects() {
    let port = |text: &str| Config::from_env(env(&[("PORT", text)]), PathBuf::new()).listen_port();
    assert_eq!(port("8080"), Ok(8080));
    assert_eq!(port(" 8080 "), Ok(8080));
    assert_eq!(port("0x10"), Ok(16));
    assert_eq!(port("0"), Ok(0));
    assert_eq!(port(" "), Ok(0)); // a blank is truthy and Number(" ") is 0
    let bad = "options.port should be >= 0 and < 65536. Received type number";
    assert_eq!(port("abc"), Err(format!("{bad} (NaN).")));
    assert_eq!(port("70000"), Err(format!("{bad} (70000).")));
    assert_eq!(port("-1"), Err(format!("{bad} (-1).")));
    assert_eq!(port("9800.5"), Err(format!("{bad} (9800.5).")));
    assert_eq!(port("Infinity"), Err(format!("{bad} (Infinity).")));
}

#[test]
fn the_renderer_releases_directory_defaults_beside_the_renderer_directory() {
    let dir = tempfile::tempdir().expect("temp dir");
    let renderer = dir.path().join("site").join("renderer");
    let renderer_text = renderer.to_string_lossy().into_owned();
    let beside = dir.path().join("site").join("renderer-releases").to_string_lossy().into_owned();
    let config = Config::from_env(env(&[("RENDERER_DIR", &renderer_text)]), PathBuf::new());
    assert_eq!(config.renderer_dir, renderer_text);
    assert_eq!(config.renderer_releases_dir, beside);
    let named = Config::from_env(env(&[("RENDERER_DIR", &renderer_text), ("RENDERER_RELEASES_DIR", "/srv/releases")]), PathBuf::new());
    assert_eq!(named.renderer_releases_dir, "/srv/releases");
    // Without RENDERER_DIR, a releases directory is only what was named.
    let only = Config::from_env(env(&[("RENDERER_RELEASES_DIR", "/srv/releases")]), PathBuf::new());
    assert_eq!(only.renderer_releases_dir, "/srv/releases");
}

#[test]
fn the_whole_environment_is_kept_for_the_groups_that_parse_their_own_names() {
    let config = Config::from_env(env(&[("TURN_HOST", "turn.example"), ("APNS_KEY_ID", "k")]), PathBuf::new());
    assert_eq!(config.env.get("TURN_HOST").map(String::as_str), Some("turn.example"));
    assert_eq!(config.env.get("APNS_KEY_ID").map(String::as_str), Some("k"));
}

// ---- logline.rs ----

#[test]
fn lines_keep_their_node_text_and_stream() {
    let line = logline::listening("http", 9800, "");
    assert_eq!((line.stream, line.text.as_str()), (Stream::Out, "[relay] http listening on :9800 (renderer: none)"));
    assert_eq!(logline::listening("https", 443, "/srv/r").text, "[relay] https listening on :443 (renderer: /srv/r)");
    let line = logline::failed_to_start("EADDRINUSE");
    assert_eq!((line.stream, line.text.as_str()), (Stream::Err, "[relay] failed to start: EADDRINUSE"));
    assert_eq!(logline::label_failed("phone frame", "boom").text, "[relay] phone frame failed: boom");
    let line = logline::phone_upgrade_refused(403, "revoked", "12345678-abcd");
    assert_eq!((line.stream, line.text.as_str()), (Stream::Out, "[relay] phone upgrade refused status=403 cause=revoked device=12345678"));
    assert_eq!(
        logline::phone_upgrade_refused_desktop_offline("abcdef0123").text,
        "[relay] phone upgrade refused cause=desktop-offline device=abcdef01"
    );
    assert_eq!(
        logline::slow_phone_handshake(3, logline::HEARD_LIVE).text,
        "[relay] slow phone handshake turn=3; desktop leg is live, leaving the leg up"
    );
    assert_eq!(
        logline::desktop_leg_missed_handshake_turn(3).text,
        "[relay] desktop leg missed a phone handshake turn=3 and its probe; closing it"
    );
    let long_reason = "r".repeat(80);
    assert_eq!(
        logline::phone_leg_closed("0123456789", 4003, &long_reason, 1500).text,
        format!("[relay] phone leg closed client=01234567 code=4003 reason={} lived=1500ms", "r".repeat(60))
    );
    assert_eq!(logline::feedback_diagnostic("send", "error").text, "[relay] feedback send code=error");
    assert_eq!(logline::ice_servers_issued("abcdef0123").text, "[relay] ice-servers issued device=abcdef01");
    assert_eq!(logline::push_credentials_unusable("APNs", "bad key").stream, Stream::Err);
    assert_eq!(logline::sweep_terminated_leg().stream, Stream::Out);
}

#[test]
fn file_names_are_logged_as_file_urls() {
    let dir = tempfile::tempdir().expect("temp dir");
    let url = logline::file_url(&dir.path().join("mobile release.json"));
    assert!(url.starts_with("file:///"), "{url}");
    assert!(url.ends_with("/mobile%20release.json"), "{url}");
}

#[test]
fn the_sockets_line_lists_the_largest_and_sums_the_rest() {
    let delay = LoopDelay { p50: 0.25, p99: 1.0, max: 12.34 };
    let one = [SocketBuffer { name: "desktop:abcdef01".into(), buffered_bytes: 812.0 }, SocketBuffer { name: "phone:12345678".into(), buffered_bytes: 3500.0 }];
    assert_eq!(
        logline::sockets_report(1, &one, &delay, 30_000).text,
        "[relay] sockets 30s phones=1 buffered phone:12345678=3.4KB desktop:abcdef01=812B loop-p50=0.3ms loop-p99=1.0ms loop-max=12.3ms"
    );
    let many: Vec<SocketBuffer> = (0..14).map(|i| SocketBuffer { name: format!("phone:{i}"), buffered_bytes: f64::from(i) }).collect();
    let text = logline::sockets_report(14, &many, &delay, 30_000).text;
    assert!(text.contains("buffered phone:13=13B phone:12=12B"), "{text}");
    assert!(text.contains(" +2 more=1B loop-p50="), "{text}");
}

// ---- the operator tools ----

#[test]
fn the_verifier_with_no_origin_fails_with_exit_1_as_node_does() {
    // verify-release.mjs: new URL("") throws "Invalid URL", the catch prints "[deploy] verification failed" and exits 1.
    let code = format!("{:?}", tools::verify_release::main(&[]));
    assert_eq!(code, format!("{:?}", std::process::ExitCode::from(1)));
}
