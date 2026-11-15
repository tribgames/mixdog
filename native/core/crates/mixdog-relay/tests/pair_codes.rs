//! The cases of `apps/relay/lib/pair-codes.test.mjs` that exercise `PairCodes` directly, on an explicit clock. The cases that
//! drive the relay over a WebSocket are twin scenarios of nr-relay-twin-identity (see the ledger).

use mixdog_relay::js;
use mixdog_relay::pairing::codes::{
    GLOBAL_FAIL_LIMIT, IP_BACKOFF_BASE_MS, IP_FAILS_PER_STRIKE, Issue, PAIR_CODE_TTL_MS, PairCodes, Resolve, clean_name, issued_answer,
    presence_ids,
};
use serde_json::json;

const T0: i64 = 1_000_000;
const LEASE: &str = "lease-0001";

fn device(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

fn issue(codes: &mut PairCodes, n: usize, now: i64) -> String {
    let lease = format!("lease-{n:06}");
    match codes.issue_at(&device(n), Some(lease.as_str()), Some(""), now) {
        Issue::Ok { code, .. } => code,
        other => panic!("issue refused: {other:?}"),
    }
}

fn resolve(codes: &mut PairCodes, code: &str, ip: &str, now: i64) -> Resolve {
    codes.resolve_at(Some(code), ip, now)
}

fn wrong_for(code: &str) -> &'static str {
    if code == "000000" { "000001" } else { "000000" }
}

fn is_hex_ticket(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn ticket_of(codes: &mut PairCodes, n: usize, now: i64) -> String {
    let code = issue(codes, n, now);
    match resolve(codes, &code, "ip", now) {
        Resolve::Ok { ticket, .. } => ticket,
        other => panic!("not resolved: {other:?}"),
    }
}

#[test]
fn a_code_resolves_once_to_its_device_and_is_then_spent() {
    let mut codes = PairCodes::new();
    let issued = codes.issue_at(&device(1), Some(LEASE), Some("Home PC"), T0);
    let Issue::Ok { code, lease, ttl_ms } = issued else { panic!("issue refused") };
    assert_eq!(code.len(), 6);
    assert!(code.bytes().all(|b| b.is_ascii_digit()));
    assert_eq!(lease, LEASE);
    assert_eq!(ttl_ms, PAIR_CODE_TTL_MS);
    match resolve(&mut codes, &code, "1.1.1.1", T0) {
        Resolve::Ok { device_id, name, ticket, lease } => {
            assert_eq!(device_id, device(1));
            assert_eq!(name, "Home PC");
            assert_eq!(lease, LEASE);
            assert!(is_hex_ticket(&ticket));
        }
        other => panic!("not resolved: {other:?}"),
    }
    assert_eq!(resolve(&mut codes, &code, "1.1.1.1", T0), Resolve::Invalid);
}

#[test]
fn a_code_expires_after_five_minutes_and_a_new_lease_replaces_the_old_without_extending_it() {
    let mut codes = PairCodes::new();
    let mut now = T0;
    let first = issue(&mut codes, 1, now);
    now += PAIR_CODE_TTL_MS - 1_000;
    let Issue::Ok { code: second, lease: second_lease, .. } = codes.issue_at(&device(1), Some("lease-000002"), Some(""), now) else {
        panic!("issue refused")
    };
    assert_eq!(second_lease, "lease-000002");
    // One live code per device: the replaced code is gone (unless the draw repeated it).
    if first != second {
        assert_eq!(resolve(&mut codes, &first, "x", now), Resolve::Invalid);
    }
    now += PAIR_CODE_TTL_MS - 1_000;
    assert!(matches!(resolve(&mut codes, &second, "a", now), Resolve::Ok { .. }));
    let third = issue(&mut codes, 1, now);
    now += PAIR_CODE_TTL_MS + 1;
    assert_eq!(resolve(&mut codes, &third, "b", now), Resolve::Invalid);
}

#[test]
fn clear_withdraws_the_live_code_of_a_device() {
    let mut codes = PairCodes::new();
    let code = issue(&mut codes, 1, T0);
    codes.clear(&device(1));
    assert_eq!(resolve(&mut codes, &code, "ip", T0), Resolve::Invalid);
}

#[test]
fn callers_cannot_choose_codes_malformed_leases_are_refused_and_issued_codes_are_distinct() {
    let mut codes = PairCodes::new();
    for bad in [Some("short"), Some("has space!!"), Some("123456x"), None] {
        assert_eq!(codes.issue_at(&device(1), bad, Some(""), T0), Issue::Invalid);
    }
    let long = "a".repeat(65);
    assert_eq!(codes.issue_at(&device(1), Some(long.as_str()), None, T0), Issue::Invalid);
    let longest = "a".repeat(64);
    assert!(matches!(codes.issue_at(&device(1), Some(longest.as_str()), None, T0), Issue::Ok { .. }));
    assert!(matches!(codes.issue_at(&device(1), Some("12345678"), None, T0), Issue::Ok { .. }));
    assert_eq!(codes.issue_at("not-an-id", Some(LEASE), Some(""), T0), Issue::Invalid);
    let mut issued = std::collections::BTreeSet::new();
    for n in 10..210 {
        issued.insert(issue(&mut codes, n, T0));
    }
    assert_eq!(issued.len(), 200, "concurrent devices never share a code");
}

#[test]
fn at_most_ten_thousand_codes_are_live() {
    let mut codes = PairCodes::new();
    for n in 0..10_000 {
        issue(&mut codes, n, T0);
    }
    assert_eq!(codes.issue_at(&device(10_000), Some(LEASE), None, T0), Issue::Full);
    // A device that already holds a code replaces it, so the table stays at its cap.
    assert!(matches!(codes.issue_at(&device(5), Some(LEASE), None, T0), Issue::Ok { .. }));
    // Expired codes make room.
    assert!(matches!(codes.issue_at(&device(10_000), Some(LEASE), None, T0 + PAIR_CODE_TTL_MS), Issue::Ok { .. }));
}

#[test]
fn a_ticket_is_single_use_and_bound_to_its_device() {
    let mut codes = PairCodes::new();
    let first = ticket_of(&mut codes, 1, T0);
    // Asking for it as another device spends it.
    assert!(!codes.take_ticket_at(Some(first.as_str()), &device(2), T0));
    assert!(!codes.take_ticket_at(Some(first.as_str()), &device(1), T0));
    let second = ticket_of(&mut codes, 1, T0);
    assert!(codes.take_ticket_at(Some(second.as_str()), &device(1), T0));
    assert!(!codes.take_ticket_at(Some(second.as_str()), &device(1), T0));
    assert!(!codes.take_ticket_at(Some("nope"), &device(1), T0));
    assert!(!codes.take_ticket_at(None, &device(1), T0));
}

#[test]
fn a_ticket_lives_five_minutes_and_four_thousand_ninety_six_are_kept() {
    let mut codes = PairCodes::new();
    let ticket = ticket_of(&mut codes, 1, T0);
    assert!(!codes.take_ticket_at(Some(ticket.as_str()), &device(1), T0 + PAIR_CODE_TTL_MS));

    let mut codes = PairCodes::new();
    let tickets: Vec<String> = (0..4_097).map(|_| ticket_of(&mut codes, 1, T0)).collect();
    assert!(!codes.take_ticket_at(tickets.first().map(String::as_str), &device(1), T0), "the oldest ticket was evicted");
    assert!(codes.take_ticket_at(tickets.last().map(String::as_str), &device(1), T0));
}

#[test]
fn wrong_guesses_lock_a_source_out_with_a_growing_backoff_even_for_a_right_code() {
    let mut codes = PairCodes::new();
    let mut now = T0;
    let right = issue(&mut codes, 1, now);
    for _ in 0..IP_FAILS_PER_STRIKE {
        assert_eq!(resolve(&mut codes, wrong_for(&right), "bad", now), Resolve::Invalid);
    }
    assert_eq!(resolve(&mut codes, &right, "bad", now), Resolve::Limited { retry_after_ms: IP_BACKOFF_BASE_MS });
    // Another source is unaffected.
    assert!(matches!(resolve(&mut codes, &right, "other", now), Resolve::Ok { .. }));
    let right = issue(&mut codes, 1, now);
    now += IP_BACKOFF_BASE_MS;
    for _ in 0..IP_FAILS_PER_STRIKE {
        resolve(&mut codes, wrong_for(&right), "bad", now);
    }
    assert_eq!(resolve(&mut codes, &right, "bad", now), Resolve::Limited { retry_after_ms: IP_BACKOFF_BASE_MS * 2 });
    now += IP_BACKOFF_BASE_MS * 2;
    assert!(matches!(resolve(&mut codes, &right, "bad", now), Resolve::Ok { .. }));
}

#[test]
fn the_lockout_doubles_per_strike_and_stops_at_one_hour() {
    let mut codes = PairCodes::new();
    let mut now = T0;
    let mut expected = IP_BACKOFF_BASE_MS;
    // Past the 64th strike the doubling no longer fits an i64: the lockout is still one hour.
    for _ in 0..70 {
        for _ in 0..IP_FAILS_PER_STRIKE {
            resolve(&mut codes, "000000", "bad", now);
        }
        let wait = expected.min(60 * 60_000);
        assert_eq!(codes.retry_after_ms_at("bad", now), wait);
        now += wait;
        expected = (expected * 2).min(60 * 60_000);
    }
}

#[test]
fn a_source_state_is_forgotten_after_an_hour_without_a_block() {
    let mut codes = PairCodes::new();
    for _ in 0..(IP_FAILS_PER_STRIKE - 1) {
        resolve(&mut codes, "000000", "slow", T0);
    }
    // One more failure an hour and a second later starts a fresh count: it is not the fifth of a strike.
    let later = T0 + 60 * 60_000 + 1;
    resolve(&mut codes, "000000", "slow", later);
    assert_eq!(codes.retry_after_ms_at("slow", later), 0);
}

#[test]
fn the_whole_code_space_shares_one_guess_budget_across_sources() {
    let mut codes = PairCodes::new();
    let mut now = T0;
    let right = issue(&mut codes, 1, now);
    for i in 0..GLOBAL_FAIL_LIMIT {
        assert_eq!(resolve(&mut codes, wrong_for(&right), &format!("src-{i}"), now), Resolve::Invalid);
        now += 1;
    }
    // The oldest failure ages out ten minutes after it was made: 60 ms of that have passed.
    assert_eq!(resolve(&mut codes, &right, "fresh-source", now), Resolve::Limited { retry_after_ms: 10 * 60_000 - 60 });
    now += 10 * 60_000 + 1;
    let fresh = issue(&mut codes, 2, now);
    assert!(matches!(resolve(&mut codes, &fresh, "fresh-source", now), Resolve::Ok { .. }));
}

#[test]
fn a_malformed_code_counts_as_a_wrong_guess() {
    let mut codes = PairCodes::new();
    for bad in [None, Some("abc"), Some("12345"), Some("1234567")] {
        assert_eq!(codes.resolve_at(bad, "ip", T0), Resolve::Invalid);
    }
    assert_eq!(codes.resolve_at(Some("12345a"), "ip", T0), Resolve::Invalid);
    assert_eq!(codes.resolve_at(Some("000000"), "ip", T0), Resolve::Limited { retry_after_ms: IP_BACKOFF_BASE_MS });
}

#[test]
fn the_answer_to_a_code_request_is_ok_with_the_code_or_not_ok_without_it() {
    let mut codes = PairCodes::new();
    let issued = codes.issue_at(&device(1), Some(LEASE), None, T0);
    let Issue::Ok { code, .. } = &issued else { panic!("issue refused") };
    assert_eq!(
        js::wire(&issued_answer(Some(LEASE), &issued)),
        format!("{{\"type\":\"pair-code-issued\",\"lease\":\"{LEASE}\",\"ok\":true,\"code\":\"{code}\",\"expiresInMs\":300000}}")
    );
    let refused = codes.issue_at(&device(1), Some("short"), None, T0);
    assert_eq!(js::wire(&issued_answer(Some("short"), &refused)), "{\"type\":\"pair-code-issued\",\"lease\":\"short\",\"ok\":false}");
    assert_eq!(js::wire(&issued_answer(None, &refused)), "{\"type\":\"pair-code-issued\",\"lease\":\"\",\"ok\":false}");
    let long = "x".repeat(100);
    assert_eq!(issued_answer(Some(long.as_str()), &refused)["lease"], json!("x".repeat(64)));
}

#[test]
fn a_name_is_cleaned_trimmed_and_cut_as_node_does() {
    assert_eq!(clean_name(None), "");
    assert_eq!(clean_name(Some("  Home\u{0}\u{7}\u{7f} PC \n")), "Home PC");
    let long = "n".repeat(100);
    assert_eq!(clean_name(Some(long.as_str())), "n".repeat(80));
    // A cut inside an emoji keeps the dangling high surrogate.
    let name = format!("{}\u{1F600}", "a".repeat(79));
    assert_eq!(js::js_len(&clean_name(Some(name.as_str()))), 80);
    // Controls are removed before the trim, so a name of them is empty.
    assert_eq!(clean_name(Some("\u{1}\u{2}")), "");
}

#[test]
fn a_presence_request_looks_at_the_first_sixteen_entries_of_an_array() {
    let ids: Vec<_> = (0..20).map(|n| json!(device(n))).collect();
    let body = json!({ "ids": ids });
    let kept = presence_ids(&body);
    assert_eq!(kept.len(), 16);
    assert_eq!(kept[15], &json!(device(15)));
    assert!(presence_ids(&json!({ "ids": "abc" })).is_empty());
    assert!(presence_ids(&json!({})).is_empty());
    assert!(presence_ids(&json!(null)).is_empty());
    assert_eq!(presence_ids(&json!({ "ids": [1, null] })).len(), 2);
}
