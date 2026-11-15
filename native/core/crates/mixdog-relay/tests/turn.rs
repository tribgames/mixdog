//! The 7 cases of `apps/relay/lib/turn-credentials.test.mjs`, plus the issuer of `lib/ice-legs.mjs`. Literals marked "Node"
//! were recorded by running the Node module once.

use std::collections::BTreeMap;

use mixdog_relay::ice::turn::*;
use mixdog_relay::ice::{IceRefusal, IceService};
use serde_json::json;

const NOW: i64 = 1_893_499_200_000; // Date.UTC(2030, 0, 1, 12, 0, 0)

fn secret() -> String {
    "a".repeat(64)
}

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

fn env_with(extra: &[(&str, &str)], drop: &[&str]) -> BTreeMap<String, String> {
    let mut map = env(&[("TURN_HOST", "relay.example.com"), ("TURN_ISSUE_LIMIT", "4")]);
    map.insert("TURN_AUTH_SECRET".into(), secret());
    for name in drop {
        map.remove(*name);
    }
    for (k, v) in extra {
        map.insert((*k).to_owned(), (*v).to_owned());
    }
    map
}

fn err_of(map: &BTreeMap<String, String>) -> String {
    turn_config_from_env(map).expect_err("unusable settings").to_string()
}

#[test]
fn the_password_is_base64_hmac_sha1_of_the_username_rfc_2202_case_2() {
    // key "Jefe", data "what do ya want for nothing?" -> effcdf6ae5eb2fa2d27416d5f184df9c259a7c79 (RFC 2202 section 3).
    assert_eq!(turn_password("Jefe", "what do ya want for nothing?"), "7/zfauXrL6LSdBbV8YTfnCWafHk=");
}

#[test]
fn a_credential_is_expiry_and_id_valid_for_one_day_and_verifies_like_coturn_would() {
    let issued = issue_turn_credential(&secret(), "device1", NOW, TURN_CREDENTIAL_TTL_SECONDS);
    assert_eq!(TURN_CREDENTIAL_TTL_SECONDS, 86_400);
    assert_eq!(issued.ttl_seconds, 86_400);
    assert_eq!(issued.expires_at, NOW / 1000 + 86_400);
    assert_eq!(issued.remaining_ms, 86_400_000);
    assert_eq!(issued.username, format!("{}:device1", issued.expires_at));
    // Recorded from Node.
    assert_eq!(issued.username, "1893585600:device1");
    assert_eq!(issued.credential, "5eAz6d50K+6RJPtiD6yLly8dN+0=");
    assert_eq!(issued.credential, turn_password(&secret(), &issued.username));
    let check = |now: i64| verify_turn_credential(&secret(), Some(&issued.username), Some(&issued.credential), now);
    assert!(check(NOW));
    assert!(check(NOW + 86_399_000));
    // From the expiry second on, coturn must refuse it.
    assert!(!check(NOW + 86_400_000));
    assert!(!check(NOW + 90_000_000));
}

#[test]
fn the_real_lifetime_is_what_is_left_after_the_expiry_is_floored_to_a_whole_second() {
    let issued = issue_turn_credential(&secret(), "device1", NOW + 999, TURN_CREDENTIAL_TTL_SECONDS);
    assert_eq!(issued.expires_at, NOW / 1000 + 86_400);
    assert_eq!(issued.remaining_ms, 86_400_000 - 999);
    let verify = |now: i64| verify_turn_credential(&secret(), Some(&issued.username), Some(&issued.credential), now);
    assert!(verify(NOW + 999 + issued.remaining_ms - 1));
    assert!(!verify(NOW + 999 + issued.remaining_ms));
    let on_the_second = issue_turn_credential(&secret(), "device1", NOW, TURN_CREDENTIAL_TTL_SECONDS);
    assert_eq!(on_the_second.remaining_ms, 86_400_000);
}

#[test]
fn a_credential_cannot_be_forged_altered_extended_or_used_with_another_secret() {
    let issued = issue_turn_credential(&secret(), "device1", NOW, 600);
    let verify = |username: Option<&str>, credential: Option<&str>| verify_turn_credential(&secret(), username, credential, NOW);
    assert!(verify(Some(&issued.username), Some(&issued.credential)));
    assert!(!verify(Some(&issued.username), Some(&format!("{}x", issued.credential))));
    assert!(!verify(Some(&issued.username), Some(&"A".repeat(issued.credential.len()))));
    // Moving the expiry later (or the user id) breaks the password.
    assert!(!verify(Some(&format!("{}:device1", issued.expires_at + 3600)), Some(&issued.credential)));
    assert!(!verify(Some(&format!("{}:device2", issued.expires_at)), Some(&issued.credential)));
    assert!(!verify_turn_credential(&"b".repeat(64), Some(&issued.username), Some(&issued.credential), NOW));
    let empty_id = format!("{}:", issued.expires_at);
    for username in ["", "device1", "x:device1", empty_id.as_str(), "7"] {
        assert!(!verify(Some(username), Some(&turn_password(&secret(), username))), "{username}");
    }
    assert!(!verify(None, Some(&issued.credential)));
    assert!(!verify(Some(&issued.username), None));
}

#[test]
fn the_user_id_is_the_full_keyed_digest_stable_per_device_opaque_and_bound_to_the_secret() {
    let device_id = "3f2a9c1e-5b7d-4e68-9a10-2c4d6e8f0a1b";
    let id = turn_user_id(&secret(), device_id);
    assert_eq!(id.len(), 64);
    assert!(id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    // Recorded from Node.
    assert_eq!(id, "ef2dd35e7b3ab44c78aac8a28aa4dbfbeaff4065ba60547e8cb12e55c0033f13");
    // RFC 8489 section 14.3: a USERNAME is fewer than 509 bytes.
    let issued = issue_turn_credential(&secret(), &id, NOW, TURN_CREDENTIAL_TTL_SECONDS);
    assert!(issued.username.len() < 509, "{}", issued.username.len());
    assert_eq!(turn_user_id(&secret(), device_id), id);
    assert_ne!(turn_user_id(&secret(), "another-device"), id);
    assert_ne!(turn_user_id(&"b".repeat(64), device_id), id);
    assert!(!id.contains(&device_id[..8]));
}

#[test]
fn settings_come_from_the_deploy_environment_and_fail_closed() {
    assert_eq!(turn_config_from_env(&BTreeMap::new()), Ok(None));
    let config = turn_config_from_env(&env_with(&[], &[])).expect("usable").expect("provisioned");
    assert_eq!(
        (config.host.as_str(), config.port, config.tls_port, config.ttl_seconds, config.issue_limit),
        ("relay.example.com", TURN_DEFAULT_PORT, 0, 86_400, 4)
    );
    assert_eq!(TURN_DEFAULT_PORT, 3478);
    assert_eq!(TURN_DEFAULT_TLS_PORT, 5349);
    let tls = turn_config_from_env(&env_with(&[("TURN_PORT", "3479"), ("TURN_TLS_PORT", "5350")], &[])).unwrap().unwrap();
    assert_eq!((tls.port, tls.tls_port), (3479, 5350));

    assert!(err_of(&env(&[("TURN_AUTH_SECRET", &secret())])).contains("both"));
    assert!(err_of(&env(&[("TURN_HOST", "relay.example.com")])).contains("both"));
    // The request limit is a deploy-time decision: no value, no issuance.
    assert!(err_of(&env_with(&[], &["TURN_ISSUE_LIMIT"])).contains("TURN_ISSUE_LIMIT"));
    for limit in ["", "0", "-1", "1.5", "many", "1e3", " 3", "9007199254740992"] {
        assert!(err_of(&env_with(&[("TURN_ISSUE_LIMIT", limit)], &[])).contains("TURN_ISSUE_LIMIT"), "{limit}");
    }
    assert_eq!(turn_config_from_env(&env_with(&[("TURN_ISSUE_LIMIT", "30")], &[])).unwrap().unwrap().issue_limit, 30);
    let short = "x".repeat(TURN_SECRET_MIN_BYTES - 1);
    assert!(err_of(&env_with(&[("TURN_AUTH_SECRET", &short)], &[])).contains("at least 20 bytes"));
    let exact = "x".repeat(TURN_SECRET_MIN_BYTES);
    assert!(turn_config_from_env(&env_with(&[("TURN_AUTH_SECRET", &exact)], &[])).is_ok());
    for host in ["bad host", "a/b", "host:3478", "-lead.example.com", "trail.example.com.-", "[::1]", "host\n"] {
        assert!(err_of(&env_with(&[("TURN_HOST", host)], &[])).contains("host"), "{host}");
    }
    assert!(turn_config_from_env(&env_with(&[("TURN_HOST", "h")], &[])).is_ok());
    for port in ["0", "65536", "abc", "3478.5", "-1"] {
        assert!(err_of(&env_with(&[("TURN_PORT", port)], &[])).contains("TURN_PORT"), "{port}");
        assert!(err_of(&env_with(&[("TURN_TLS_PORT", port)], &[])).contains("TURN_TLS_PORT"), "{port}");
    }
    // The messages the relay logs after "[relay] TURN credential issuance disabled:".
    assert_eq!(err_of(&env_with(&[("TURN_PORT", "0")], &[])), "TURN_PORT must be a port number.");
    assert_eq!(err_of(&env_with(&[], &["TURN_ISSUE_LIMIT"])), "TURN_ISSUE_LIMIT must be a positive whole number.");
}

#[test]
fn the_ice_list_names_only_this_host_stun_then_turn_over_udp_tcp_and_when_provisioned_tls() {
    let plain = turn_config_from_env(&env_with(&[], &[])).unwrap().unwrap();
    assert_eq!(stun_urls(&plain), ["stun:relay.example.com:3478"]);
    assert_eq!(turn_urls(&plain), ["turn:relay.example.com:3478?transport=udp", "turn:relay.example.com:3478?transport=tcp"]);
    let with_tls = turn_config_from_env(&env_with(&[("TURN_TLS_PORT", "5349")], &[])).unwrap().unwrap();
    let issued = issue_turn_credential(&secret(), "device1", NOW, TURN_CREDENTIAL_TTL_SECONDS);
    let servers = ice_servers_for(&with_tls, &issued);
    assert_eq!(
        servers,
        json!([
            { "urls": ["stun:relay.example.com:3478"] },
            {
                "urls": [
                    "turn:relay.example.com:3478?transport=udp",
                    "turn:relay.example.com:3478?transport=tcp",
                    "turns:relay.example.com:5349?transport=tcp",
                ],
                "username": issued.username,
                "credential": issued.credential,
            },
        ])
    );
    // The wire order of the keys is urls, username, credential.
    assert!(mixdog_relay::js::wire(&servers).contains(r#""username":"1893585600:device1","credential":"#));
}

#[test]
fn the_issuer_replies_with_the_shapes_the_desktop_reads() {
    let config = turn_config_from_env(&env_with(&[], &[])).unwrap().unwrap();
    let mut service = IceService::new(config);
    let issue = service.issue("device1", NOW + 250);
    let reply = IceService::issued_reply("req1", &issue);
    assert_eq!((reply["type"].as_str(), reply["ok"].as_bool()), (Some("ice-servers"), Some(true)));
    assert_eq!(
        (reply["ttlSeconds"].as_i64(), reply["expiresAt"].as_i64(), reply["remainingMs"].as_i64()),
        (Some(86_400), Some(1_893_585_600), Some(86_399_750))
    );
    let username = reply["servers"][1]["username"].as_str().unwrap();
    assert_eq!(username, format!("1893585600:{}", turn_user_id(&secret(), "device1")));

    let not_paired = service.refusal_reply("req1", IceRefusal::NotPaired, None);
    assert_eq!(
        mixdog_relay::js::wire(&not_paired),
        r#"{"type":"ice-servers","requestId":"req1","ok":false,"error":"not-paired","stun":["stun:relay.example.com:3478"]}"#
    );
    for _ in 0..4 {
        assert!(service.limiter.allow_at("device1", NOW));
    }
    assert!(!service.limiter.allow_at("device1", NOW));
    let retry = service.limiter.retry_after_ms_at("device1", NOW);
    let limited = service.refusal_reply("req1", IceRefusal::RateLimited, Some(retry));
    assert_eq!(limited["error"], "rate-limited");
    assert_eq!(limited["retryAfterMs"].as_i64(), Some(retry));
    assert!(retry > 0);
}
