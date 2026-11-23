//! The book's admission, settlement and storm control over manifests built from real bodies.

use mixdog_core_api::domain::cache_tail::{
    Admission, Claim, Claimed, Cold, ColdRequest, Counters, Purpose, Resolution, TTL_1H_MS, TTL_5M_MS, TailRefusal, TailRoute, Verdict, WireManifest,
};
use serde_json::{Value, json};

use super::book::{Book, Judgment};
use super::manifest::anthropic;

const T0: i64 = 1_000_000_000;

fn route(account: &str) -> TailRoute {
    TailRoute(format!("anthropic|https://api.anthropic.com|claude-x|{account}"))
}

/// A body of `turns` answered exchanges and a new user turn, the tail marked at `tail` ("5m"/"1h").
fn body(turns: usize, tail: &str) -> Value {
    let mut messages = Vec::new();
    for n in 0..turns {
        messages.push(json!({ "role": "user", "content": format!("question {n}") }));
        messages.push(json!({ "role": "assistant", "content": [{ "type": "text", "text": format!("answer {n}") }] }));
    }
    let control = if tail == "1h" { json!({ "type": "ephemeral", "ttl": "1h" }) } else { json!({ "type": "ephemeral" }) };
    messages.push(json!({ "role": "user", "content": [{ "type": "text", "text": format!("question {turns}"), "cache_control": control }] }));
    // The layout the product sends: an hour-tier system marker under either tail.
    let system = json!({ "type": "text", "text": "sys", "cache_control": { "type": "ephemeral", "ttl": "1h" } });
    json!({ "model": "claude-x", "system": [system], "messages": messages })
}

fn admit(book: &mut Book, manifest: &WireManifest, account: &str, purpose: Purpose, now: i64) -> Verdict {
    book.admit(Admission { purpose, route: &route(account), manifest, generation: None, unreduced: None }, now, true, SIZING)
}

const SIZING: u64 = 7;

fn sent(verdict: Verdict) -> mixdog_core_api::domain::cache_tail::Permit {
    match verdict {
        Verdict::Send(permit) => permit,
        Verdict::Refuse(refusal) => panic!("refused: {refusal:?}"),
    }
}

fn live(judgment: Judgment) -> bool {
    matches!(judgment, Judgment::Live { .. })
}

fn refused(verdict: Verdict) -> TailRefusal {
    match verdict {
        Verdict::Send(_) => panic!("sent"),
        Verdict::Refuse(refusal) => refusal,
    }
}

fn wrote_5m(read: u64, created: u64) -> Option<Counters> {
    Some(Counters { read: Some(read), created: Some(created), created_5m: Some(created), created_1h: Some(0) })
}

fn wrote_1h_tail(read: u64, created: u64) -> Option<Counters> {
    Some(Counters { read: Some(read), created: Some(created), created_5m: Some(0), created_1h: Some(created) })
}

/// A book whose route `a` proved the tail of `body(1, tail)` at T0.
fn proven(tail: &str) -> (Book, WireManifest) {
    let mut book = Book::default();
    let manifest = anthropic(&body(1, tail));
    let permit = sent(admit(&mut book, &anthropic(&body(0, tail)), "a", Purpose::Turn, T0 - 1));
    book.settle(
        &permit,
        Some(Counters {
            read: Some(0),
            created: Some(1500),
            created_5m: Some(if tail == "1h" { 0 } else { 500 }),
            created_1h: Some(if tail == "1h" { 1500 } else { 1000 }),
        }),
        T0,
    );
    let permit = sent(admit(&mut book, &manifest, "a", Purpose::Turn, T0));
    let counters = if tail == "1h" { wrote_1h_tail(1000, 900) } else { wrote_5m(1000, 900) };
    book.settle(&permit, counters, T0);
    (book, manifest)
}

/// When the five-minute tail [`proven`] proved has run out.
const COLD: i64 = T0 + TTL_5M_MS as i64 + 1;

/// A book whose only proof (on route `a`) has run out by [`COLD`], and the history grown on it: cold by a known expiry.
fn expired() -> (Book, WireManifest) {
    (proven("5m").0, anthropic(&body(3, "5m")))
}

#[test]
fn each_lifetime_is_live_through_its_ttl_and_cold_after_it() {
    for (tail, ttl) in [("5m", TTL_5M_MS as i64), ("1h", TTL_1H_MS as i64)] {
        let (book, _) = proven(tail);
        let next = anthropic(&body(2, tail));
        assert_eq!(book.judge(&route("a"), &next, T0 + ttl - 1), Judgment::Live { holds_ms: 1 }, "{tail}: just before the deadline");
        assert_eq!(book.judge(&route("a"), &next, T0 + ttl), Judgment::Live { holds_ms: 0 }, "{tail}: at the deadline, as Node's `now - lastSendAt <= ttl`");
        assert_eq!(book.judge(&route("a"), &next, T0 + ttl + 1), Judgment::Cold(Cold::Expired), "{tail}: past the deadline");
        assert_eq!(book.judge(&route("a"), &next, T0 + ttl + 60_000), Judgment::Cold(Cold::Expired), "{tail}: after");
    }
}

/// The tail's age is the time since the session last sent, whatever that send wrote: another account's route, an edited
/// history and one grown by more blocks than the provider looks back over are all inside the lifetime, and cold after it.
#[test]
fn the_lifetime_runs_from_the_last_send_whatever_the_request_holds() {
    let (book, _) = proven("5m");
    let mut edited = body(2, "5m");
    edited["messages"][0]["content"] = json!("an edited question");
    let grown = anthropic(&body(40, "5m"));
    for (account, manifest) in [("a", anthropic(&body(2, "5m"))), ("b", anthropic(&body(2, "5m"))), ("a", anthropic(&edited)), ("a", grown)] {
        assert_eq!(book.judge(&route(account), &manifest, T0 + 1), Judgment::Live { holds_ms: TTL_5M_MS - 1 }, "{account}");
        assert_eq!(book.judge(&route(account), &manifest, COLD), Judgment::Cold(Cold::Expired), "{account}");
    }
    assert_eq!(
        book.judge(&route("a"), &anthropic(&body(2, "5m")), T0 - 600_000),
        Judgment::Cold(Cold::Unproven),
        "no lease is extended on a clock that went back"
    );
}

/// A session of an earlier version has no book, only its header's record of the last send: the lifetime runs from that.
#[test]
fn a_session_without_a_book_is_judged_by_the_send_its_header_records() {
    let manifest = anthropic(&body(3, "1h"));
    let book = Book::unrecorded(false, Some(T0));
    assert!(live(book.judge(&route("a"), &manifest, T0 + 60_000)));
    assert_eq!(book.judge(&route("a"), &manifest, T0 + TTL_1H_MS as i64 + 1), Judgment::Cold(Cold::Expired));
    assert!(live(Book::from_json(&json!({ "v": 3 }), T0 + 1, Some(T0)).judge(&route("a"), &manifest, T0 + 1)));
    // A book that settled an earlier send than the header records (a send it did not judge) reads the later of the two.
    let mut settled = Book::unrecorded(true, None);
    let first = sent(admit(&mut settled, &manifest, "a", Purpose::Turn, T0));
    settled.settle(&first, wrote_5m(0, 900), T0);
    let later = T0 + TTL_1H_MS as i64;
    assert!(live(Book::from_json(&settled.to_json(), later + 2, Some(later)).judge(&route("a"), &manifest, later + 2)));
}

/// The book is persisted with each route's receipts as a map by block and digest, so one receipt's change is one member's;
/// a book an earlier build persisted, with its receipts as a list, reads as the same book.
#[test]
fn a_book_persists_its_receipts_by_route_and_reads_the_listed_form_an_earlier_build_wrote() {
    let (book, manifest) = proven("1h");
    let json = book.to_json();
    assert_eq!(json["v"], 5);
    let held = json["receipts"][route("a").0.as_str()].as_object().expect("the route's receipts");
    assert_eq!(held.len(), book.receipts().len());
    let listed: Vec<Value> = held
        .iter()
        .map(|(at, r)| {
            let (block, digest) = at.split_once(':').expect("block and digest");
            assert_eq!(r.as_object().unwrap().keys().collect::<Vec<_>>(), ["ttlMs", "touchedAt", "extent"]);
            json!({ "route": route("a").0, "block": block.parse::<u64>().unwrap(), "digest": digest, "ttlMs": r["ttlMs"], "touchedAt": r["touchedAt"], "extent": r["extent"] })
        })
        .collect();
    let mut earlier = json.clone();
    earlier["v"] = json!(4);
    earlier["receipts"] = json!(listed);
    for persisted in [&json, &earlier] {
        let read = Book::from_json(persisted, T0 + 1, None);
        assert_eq!(read.receipts(), book.receipts());
        assert_eq!(read.to_json(), json, "written again in the present form");
        assert!(live(read.judge(&route("a"), &manifest, T0 + 1)));
    }
}

#[test]
fn a_new_history_a_one_shot_and_a_system_only_write_are_judged_apart() {
    let book = Book::default();
    assert_eq!(book.judge(&route("a"), &anthropic(&body(0, "5m")), T0), Judgment::FirstWrite);
    let mut one_shot = body(0, "5m");
    one_shot["messages"][0]["content"] = json!("no marker");
    assert_eq!(book.judge(&route("a"), &anthropic(&one_shot), T0), Judgment::NotApplicable);
    // A response that wrote only the hour-tier system entry proves no five-minute tail, and is a send all the same.
    let mut book = Book::default();
    let permit = sent(admit(&mut book, &anthropic(&body(0, "5m")), "a", Purpose::Turn, T0));
    book.settle(&permit, wrote_1h_tail(0, 2000), T0 + 1);
    assert!(book.receipts().is_empty());
    assert!(live(book.judge(&route("a"), &anthropic(&body(1, "5m")), T0 + 2)));
}

/// A history nothing proves is not an expired one: the session of an earlier version, an import, a snapshot of another
/// format or another account's route is sent as it is, by a turn and by a side question alike, and that send is its
/// proof. An attempt that is optional is still not made on it.
#[test]
fn a_history_nothing_proves_is_sent_unchanged_and_proven_by_that_send() {
    let manifest = anthropic(&body(3, "5m"));
    for unproven in [Book::unrecorded(false, None), Book::from_json(&json!({ "v": 3 }), T0, None)] {
        let mut book = unproven;
        assert_eq!(book.judge(&route("a"), &manifest, T0), Judgment::Cold(Cold::Unproven));
        let _ = sent(admit(&mut book, &manifest, "a", Purpose::SideQuestion, T0));
        assert_eq!(refused(admit(&mut book, &manifest, "a", Purpose::Warm, T0)), TailRefusal::Skip(Cold::Unproven));
        let turn = sent(admit(&mut book, &manifest, "a", Purpose::Turn, T0));
        book.settle(&turn, wrote_5m(0, 9000), T0 + 1);
        assert!(live(book.judge(&route("a"), &anthropic(&body(4, "5m")), T0 + 2)));
    }
}

#[test]
fn an_expired_history_is_cold_once_and_its_disposition_holds_on_retry() {
    let (mut book, manifest) = expired();
    let TailRefusal::Rebuild(ColdRequest { ticket, cold }) = refused(admit(&mut book, &manifest, "a", Purpose::Turn, COLD)) else { panic!("a rebuild") };
    assert_eq!(cold, Cold::Expired);
    assert_eq!(book.claim(ticket), Claim::Owner);
    // A second caller while the rewrite is in flight waits for its owner's outcome (single flight).
    assert_eq!(refused(admit(&mut book, &manifest, "a", Purpose::Turn, COLD)), TailRefusal::Wait(ticket));
    assert_eq!(refused(admit(&mut book, &manifest, "a", Purpose::SideQuestion, COLD)), TailRefusal::Wait(ticket));
    book.resolve(ticket, Resolution::Irreducible);
    let _ = sent(admit(&mut book, &manifest, "a", Purpose::Turn, COLD + 1));
    // The disposition survives a restart; growth on top of it is eligible again.
    let mut restored = Book::from_json(&book.to_json(), COLD + 10, None);
    let _ = sent(admit(&mut restored, &manifest, "a", Purpose::Turn, COLD + 11));
    assert!(matches!(refused(admit(&mut restored, &anthropic(&body(4, "5m")), "a", Purpose::Turn, COLD + 12)), TailRefusal::Rebuild(_)));
}

#[test]
fn a_compacted_base_is_written_once_on_any_route_without_a_second_summary() {
    let (mut book, manifest) = expired();
    let TailRefusal::Rebuild(ColdRequest { ticket, .. }) = refused(admit(&mut book, &manifest, "a", Purpose::Turn, COLD)) else { panic!() };
    book.rebuilt();
    book.resolve(ticket, Resolution::Compacted);
    let base = anthropic(&body(1, "5m"));
    let _ = sent(admit(&mut book, &base, "a", Purpose::Turn, COLD + 1));
    let _ = sent(admit(&mut book, &base, "b", Purpose::Turn, COLD + 2));
}

#[test]
fn cancelled_or_abandoned_rewrites_are_never_counted() {
    let (mut book, manifest) = expired();
    let TailRefusal::Rebuild(ColdRequest { ticket, .. }) = refused(admit(&mut book, &manifest, "a", Purpose::Turn, COLD)) else { panic!() };
    assert_eq!(book.claim(ticket), Claim::Owner);
    book.resolve(ticket, Resolution::Abandoned);
    let TailRefusal::Rebuild(ColdRequest { ticket: again, .. }) = refused(admit(&mut book, &manifest, "a", Purpose::Turn, COLD + 1)) else { panic!() };
    assert_ne!(again, ticket, "a new decision");
}

/// A failed reduction decides nothing: its leave goes to the turn that owned the rewrite (and told the user), and only that
/// turn's request goes out unchanged with it. Another turn cold on the same history, which was never told, is offered the
/// rewrite itself, before and after the owner's request went out, and the book keeps nothing across a restart.
#[test]
fn a_failed_rewrite_hands_its_leave_to_its_owner_alone() {
    let (mut book, manifest) = expired();
    let with = |book: &mut Book, unreduced, now| {
        book.admit(Admission { purpose: Purpose::Turn, route: &route("a"), manifest: &manifest, generation: None, unreduced }, now, true, SIZING)
    };
    // Two turns cold on one history: the first owns the rewrite, the second waits for it.
    let TailRefusal::Rebuild(offer) = refused(with(&mut book, None, COLD)) else { panic!() };
    assert_eq!(book.claim(offer.ticket), Claim::Owner);
    assert_eq!(refused(with(&mut book, None, COLD)), TailRefusal::Wait(offer.ticket));
    let leave = book.resolve(offer.ticket, Resolution::Failed).expect("the owner's leave");
    assert!(book.disposition().is_none());
    // The waiter, admitting again, is never let through on the owner's failure.
    let TailRefusal::Rebuild(again) = refused(with(&mut book, None, COLD + 1)) else { panic!("the other turn decides afresh") };
    assert_ne!(again.ticket, offer.ticket);
    let _ = sent(with(&mut book, Some(leave), COLD + 2));
    assert!(matches!(refused(with(&mut book, None, COLD + 3)), TailRefusal::Rebuild(_)), "nothing of it stayed in the book");
    assert!(matches!(refused(admit(&mut Book::from_json(&book.to_json(), COLD + 4, None), &manifest, "a", Purpose::Turn, COLD + 5)), TailRefusal::Rebuild(_)));
    // A leave names its history: on any other one it lets nothing through.
    let grown = anthropic(&body(4, "5m"));
    let other = book.admit(
        Admission { purpose: Purpose::Turn, route: &route("a"), manifest: &grown, generation: None, unreduced: Some(leave) },
        COLD + 6,
        true,
        SIZING,
    );
    assert!(matches!(refused(other), TailRefusal::Rebuild(_)));
}

/// The compacted base is the history the compaction committed: its first marked write binds the disposition whatever it
/// is judged (here inside an older entry's lifetime), so a later cold turn of grown history is decided again rather than
/// taken for the base, while the base itself is still written unchanged on another route.
#[test]
fn the_compacted_base_is_bound_at_its_first_write_and_a_later_cold_turn_is_decided_again() {
    let (mut book, _) = proven("5m");
    book.rebuilt();
    let base = anthropic(&body(2, "5m"));
    assert!(live(book.judge(&route("a"), &base, T0 + 1)));
    let _ = sent(admit(&mut book, &base, "a", Purpose::Turn, T0 + 1));
    let later = T0 + TTL_5M_MS as i64 + 1;
    let grown = admit(&mut book, &anthropic(&body(3, "5m")), "a", Purpose::Turn, later);
    assert!(matches!(refused(grown), TailRefusal::Rebuild(ColdRequest { cold: Cold::Expired, .. })));
    let _ = sent(admit(&mut book, &base, "b", Purpose::Turn, later + 1));
}

/// A live verdict holds for as long as the entry it reads can be alive, which a host that posts later has to respect; any
/// other verdict does not lapse with time.
#[test]
fn a_live_permit_holds_for_the_remaining_lifetime_of_the_entry_it_reads() {
    let (mut book, _) = proven("5m");
    let next = anthropic(&body(2, "5m"));
    assert_eq!(sent(admit(&mut book, &next, "a", Purpose::Turn, T0 + 60_000)).holds_ms, Some(TTL_5M_MS - 60_000));
    let mut fresh = Book::unrecorded(true, None);
    assert_eq!(sent(admit(&mut fresh, &next, "a", Purpose::Turn, T0)).holds_ms, None, "a first write");
}

/// A branch of the conversation: its first question differs, so no other branch's entry reaches it.
fn branch(k: usize, turns: usize) -> WireManifest {
    let mut body = body(turns, "5m");
    body["messages"][0]["content"] = json!(format!("branch {k}"));
    anthropic(&body)
}

/// Every proof lives as long as the entry it proves can: many live prefixes on one route each keep theirs.
#[test]
fn every_live_prefix_keeps_its_proof_for_its_whole_lifetime() {
    let mut book = Book::unrecorded(false, None);
    for k in 0..12 {
        let at = T0 + k as i64;
        let Verdict::Send(permit) =
            book.admit(Admission { purpose: Purpose::Turn, route: &route("a"), manifest: &branch(k, 1), generation: None, unreduced: None }, at, false, SIZING)
        else {
            panic!()
        };
        book.settle(&permit, wrote_5m(0, 4000), at);
    }
    for k in 0..12 {
        assert!(live(book.judge(&route("a"), &branch(k, 2), T0 + 20)), "branch {k}");
    }
    assert_eq!(book.receipts().len(), 12);
    let after = T0 + 12 + TTL_5M_MS as i64;
    for k in 0..12 {
        assert_eq!(
            Book::from_json(&book.to_json(), after, None).judge(&route("a"), &branch(k, 2), after),
            Judgment::Cold(Cold::Expired),
            "branch {k}: and no longer"
        );
    }
}

/// An offer is the rewrite of the session's current history and lasts exactly as long as it: every cold turn of that
/// history is offered the same rewrite, and a turn of any other history (an append, sent cold or live), a claim or a
/// rewrite ends it.
#[test]
fn an_offer_lasts_as_long_as_its_history() {
    let offer = |book: &mut Book, history: &WireManifest| {
        let TailRefusal::Rebuild(offer) = refused(admit(book, history, "a", Purpose::Turn, COLD)) else { panic!() };
        offer.ticket
    };
    let (current, appended) = (anthropic(&body(3, "5m")), anthropic(&body(4, "5m")));
    let mut book = expired().0;
    let first = offer(&mut book, &current);
    assert_eq!(offer(&mut book, &current), first, "the same history, the same offer");
    let _ = refused(admit(&mut book, &current, "a", Purpose::SideQuestion, COLD));
    assert_eq!(book.claim(first), Claim::Owner, "a side question's admission is not the history");
    let mut book = expired().0;
    let first = offer(&mut book, &current);
    let _ =
        sent(book.admit(Admission { purpose: Purpose::Turn, route: &route("a"), manifest: &appended, generation: None, unreduced: None }, COLD, false, SIZING));
    assert_eq!(book.claim(first), Claim::Stale, "the history was appended to");
    let mut book = expired().0;
    let first = offer(&mut book, &current);
    book.rebuilt();
    assert_eq!(book.claim(first), Claim::Stale, "its history was rewritten");
}

#[test]
fn optional_attempts_skip_a_cold_history_and_a_side_question_never_rebuilds() {
    let (mut book, manifest) = expired();
    assert_eq!(refused(admit(&mut book, &manifest, "a", Purpose::Warm, COLD)), TailRefusal::Skip(Cold::Expired));
    assert_eq!(refused(admit(&mut book, &manifest, "a", Purpose::SummaryFork, COLD)), TailRefusal::Skip(Cold::Expired));
    assert_eq!(refused(admit(&mut book, &manifest, "a", Purpose::SideQuestion, COLD)), TailRefusal::Skip(Cold::Expired));
}

#[test]
fn auto_clear_off_sends_unchanged_and_still_collects_evidence() {
    let mut book = Book::unrecorded(false, None);
    let manifest = anthropic(&body(3, "5m"));
    let Verdict::Send(permit) =
        book.admit(Admission { purpose: Purpose::Turn, route: &route("a"), manifest: &manifest, generation: None, unreduced: None }, T0, false, SIZING)
    else {
        panic!()
    };
    book.settle(&permit, wrote_5m(1000, 4000), T0 + 5);
    assert!(live(book.judge(&route("a"), &anthropic(&body(4, "5m")), T0 + 6)));
}

#[test]
fn a_matching_read_refreshes_and_a_late_or_retired_result_changes_nothing() {
    let (mut book, manifest) = proven("5m");
    let extent = book.receipts()[0].extent.unwrap();
    // A warm at +4m reads exactly the entry: its lease runs from the warm's dispatch.
    let warm = sent(admit(&mut book, &manifest, "a", Purpose::Warm, T0 + 240_000));
    book.settle(&warm, Some(Counters { read: Some(extent), created: Some(0), created_5m: Some(0), created_1h: Some(0) }), T0 + 241_000);
    assert!(live(book.judge(&route("a"), &anthropic(&body(2, "5m")), T0 + 500_000)));
    // A prefix-only hit refreshes nothing.
    let short = sent(admit(&mut book, &manifest, "a", Purpose::Warm, T0 + 400_000));
    book.settle(&short, Some(Counters { read: Some(extent - 1), created: Some(0), created_5m: Some(0), created_1h: Some(0) }), T0 + 401_000);
    assert_eq!(book.receipts()[0].touched_at, T0 + 240_000);
    // An attempt admitted before a compaction retired the history settles into nothing.
    let stale = sent(admit(&mut book, &anthropic(&body(2, "5m")), "a", Purpose::Turn, T0 + 410_000));
    book.rebuilt();
    book.settle(&stale, wrote_5m(extent, 700), T0 + 420_000);
    assert_eq!(book.receipts().len(), 1);
    // An earlier dispatch settling after a later one does not rewind the later proof.
    let (mut book, manifest) = proven("5m");
    let early = sent(admit(&mut book, &manifest, "a", Purpose::Turn, T0 + 10));
    let late = sent(admit(&mut book, &manifest, "a", Purpose::Turn, T0 + 20));
    book.settle(&late, wrote_5m(1000, 900), T0 + 30);
    book.settle(&early, wrote_5m(1000, 900), T0 + 40);
    let tail = manifest.tail_marker().unwrap();
    assert_eq!(book.receipts().iter().find(|r| r.digest == tail.digest).map(|r| r.touched_at), Some(T0 + 20));
}

#[test]
fn an_hour_tail_is_proven_beside_an_hour_system_marker() {
    let manifest = anthropic(&body(0, "1h"));
    let mut book = Book::default();
    let permit = sent(admit(&mut book, &manifest, "a", Purpose::Turn, T0));
    book.settle(&permit, wrote_1h_tail(0, 1500), T0 + 1);
    assert_eq!(book.receipts().len(), 1, "the write that made the system entry made the tail's");
    assert!(live(book.judge(&route("a"), &anthropic(&body(1, "1h")), T0 + 2)));
}

#[test]
fn rotation_away_and_back_reads_each_routes_own_receipts() {
    let (mut book, _) = proven("5m");
    let next = anthropic(&body(2, "5m"));
    assert!(matches!(admit(&mut book, &next, "b", Purpose::Turn, T0 + 1_000), Verdict::Send(_)), "B proved nothing, so nothing of B's expired");
    let mut book = proven("5m").0;
    assert!(matches!(admit(&mut book, &next, "a", Purpose::Turn, T0 + 2_000), Verdict::Send(_)), "back on A inside its lifetime");
}

#[test]
fn a_restart_drops_times_ahead_of_its_clock_and_keeps_the_proof_of_an_expiry() {
    let (book, _) = proven("5m");
    let snapshot = book.to_json();
    assert_eq!(Book::from_json(&snapshot, T0 + 1, None).receipts().len(), 2, "the first write and the tail after it");
    assert!(Book::from_json(&snapshot, T0 - 2, None).receipts().is_empty(), "a time ahead of the clock is uncertain");
    assert_eq!(
        Book::from_json(&snapshot, COLD, None).judge(&route("a"), &anthropic(&body(2, "5m")), COLD),
        Judgment::Cold(Cold::Expired),
        "an entry that ran out while the process was down expired all the same"
    );
    assert!(Book::from_json(&json!({ "v": 0 }), T0, None).receipts().is_empty());
    assert_eq!(
        Book::from_json(&json!({ "v": 1 }), T0, None).judge(&route("a"), &anthropic(&body(0, "5m")), T0),
        Judgment::Cold(Cold::Unproven),
        "an older record is a history, not a new session"
    );
}

/// Newness is a recorded fact, not the absence of an answer: a user-only transcript the book did not record (an import,
/// an upgrade) is not new, and a first prompt that was dispatched and proven is expired once its lifetime ran out, answered
/// or not.
#[test]
fn only_a_session_with_nothing_sent_gets_the_first_write() {
    let user_only = anthropic(&body(0, "5m"));
    assert_eq!(Book::unrecorded(true, None).judge(&route("a"), &user_only, T0), Judgment::FirstWrite);
    assert_eq!(Book::unrecorded(false, None).judge(&route("a"), &user_only, T0), Judgment::Cold(Cold::Unproven));
    let mut book = Book::unrecorded(true, None);
    let first = sent(admit(&mut book, &user_only, "a", Purpose::Turn, T0));
    book.settle(&first, wrote_5m(0, 4000), T0 + 1);
    // Interrupted before an answer was saved: the same prompt again, after its lifetime.
    assert!(matches!(refused(admit(&mut book, &user_only, "a", Purpose::Turn, COLD)), TailRefusal::Rebuild(ColdRequest { cold: Cold::Expired, .. })));
    // A dispatch with no proof leaves a retry of the same first prompt unproven, not new.
    let mut book = Book::unrecorded(true, None);
    let _ = sent(admit(&mut book, &user_only, "a", Purpose::Turn, T0));
    assert_eq!(book.judge(&route("a"), &user_only, T0 + 1), Judgment::Cold(Cold::Unproven));
    // The fact survives a restart.
    assert_eq!(Book::from_json(&book.to_json(), T0 + 2, None).judge(&route("a"), &user_only, T0 + 2), Judgment::Cold(Cold::Unproven));
}

/// A disposition holds only for what made it true: another sizing policy (a window configured after `NoSizing`), or a
/// proof settled after it (whose later expiry is a fresh one), asks for a new decision.
#[test]
fn a_disposition_is_retired_by_a_new_sizing_policy_or_a_later_proof() {
    let manifest = anthropic(&body(3, "5m"));
    let decided = |resolution: Resolution| {
        let mut book = expired().0;
        let TailRefusal::Rebuild(ColdRequest { ticket, .. }) = refused(admit(&mut book, &manifest, "a", Purpose::Turn, COLD)) else { panic!() };
        assert_eq!(book.claim(ticket), Claim::Owner);
        book.resolve(ticket, resolution);
        book
    };
    for resolution in [Resolution::NoSizing, Resolution::Irreducible] {
        let mut book = decided(resolution);
        let _ = sent(admit(&mut book, &manifest, "a", Purpose::Turn, COLD + 1));
        let resized = book.admit(
            Admission { purpose: Purpose::Turn, route: &route("a"), manifest: &manifest, generation: None, unreduced: None },
            COLD + 2,
            true,
            SIZING + 1,
        );
        assert!(matches!(refused(resized), TailRefusal::Rebuild(_)), "{resolution:?}: a new sizing policy decides again");
    }
    let mut book = decided(Resolution::Irreducible);
    let unchanged = sent(admit(&mut book, &manifest, "a", Purpose::Turn, COLD + 1));
    book.settle(&unchanged, wrote_5m(0, 9000), COLD + 2);
    assert!(live(book.judge(&route("a"), &manifest, COLD + 3)));
    let again = admit(&mut book, &manifest, "a", Purpose::Turn, COLD + 2 + TTL_5M_MS as i64);
    assert!(matches!(refused(again), TailRefusal::Rebuild(ColdRequest { cold: Cold::Expired, .. })), "the proven write's expiry is a fresh one");
}

/// An attempt prepared against the history before a rewrite is refused, whatever an old receipt says.
#[test]
fn an_attempt_prepared_before_a_rewrite_is_stale() {
    let (mut book, manifest) = proven("5m");
    let prepared = book.generation();
    book.rebuilt();
    let fork = book.admit(
        Admission { purpose: Purpose::SummaryFork, route: &route("a"), manifest: &manifest, generation: Some(prepared), unreduced: None },
        T0 + 1,
        true,
        SIZING,
    );
    assert_eq!(refused(fork), TailRefusal::Stale);
    let current = book.admit(
        Admission { purpose: Purpose::Turn, route: &route("a"), manifest: &manifest, generation: Some(book.generation()), unreduced: None },
        T0 + 1,
        true,
        SIZING,
    );
    assert!(matches!(current, Verdict::Send(_)));
}

/// The rewrite's waiters through the session gate: one owner, the others resume when it decides.
#[tokio::test]
async fn a_waiter_resumes_when_the_owner_decides() {
    let (books, session) = (super::Books::default(), "waiters".to_owned());
    let clock: super::Clock = std::sync::Arc::new(|| COLD);
    let gate = books.gate(
        &session,
        Some(&expired().0.to_json()),
        super::GateSettings { clock, auto_clear: std::sync::Arc::new(|| true), sizing: SIZING, fresh: false, last_send_at: None },
    );
    let manifest = anthropic(&body(3, "5m"));
    let on_a = route("a");
    let ask = || gate.0.admit(Admission { purpose: Purpose::Turn, route: &on_a, manifest: &manifest, generation: None, unreduced: None });
    let TailRefusal::Rebuild(offer) = refused(ask().await) else { panic!("the owner") };
    let Claimed::Owner(lease) = gate.claim(offer) else { panic!("claimed") };
    assert_eq!(refused(ask().await), TailRefusal::Wait(offer.ticket));
    let waiting = tokio::spawn(gate.0.wait_for(offer.ticket));
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished());
    lease.resolve(Resolution::Irreducible);
    tokio::time::timeout(std::time::Duration::from_secs(5), waiting).await.expect("resumed").unwrap();
    assert!(matches!(ask().await, Verdict::Send(_)), "the decision holds for the waiter");
}

/// Ownership of a rewrite is the lease: an owner whose future is dropped mid-rewrite (cancelled) releases it, its waiter
/// wakes, re-admits, becomes the owner and completes the rewrite; nothing waits for ever.
#[tokio::test]
async fn an_owner_cancelled_mid_rewrite_hands_the_rewrite_to_a_waiter() {
    let (books, session) = (super::Books::default(), "cancelled-owner".to_owned());
    let clock: super::Clock = std::sync::Arc::new(|| COLD);
    let gate = books.gate(
        &session,
        Some(&expired().0.to_json()),
        super::GateSettings { clock, auto_clear: std::sync::Arc::new(|| true), sizing: SIZING, fresh: false, last_send_at: None },
    );
    let manifest = std::sync::Arc::new(anthropic(&body(3, "5m")));
    let admit_turn = |gate: mixdog_core_api::domain::cache_tail::TailGateHandle, manifest: std::sync::Arc<WireManifest>| async move {
        gate.0.admit(Admission { purpose: Purpose::Turn, route: &route("a"), manifest: &manifest, generation: None, unreduced: None }).await
    };
    // The owner claims the rewrite and is cancelled while compacting.
    let TailRefusal::Rebuild(offer) = refused(admit_turn(gate.clone(), manifest.clone()).await) else { panic!("an offer") };
    let owner = {
        let gate = gate.clone();
        tokio::spawn(async move {
            let Claimed::Owner(_lease) = gate.claim(offer) else { panic!("the owner") };
            std::future::pending::<()>().await;
        })
    };
    tokio::task::yield_now().await;
    let TailRefusal::Wait(ticket) = refused(admit_turn(gate.clone(), manifest.clone()).await) else { panic!("a waiter") };
    assert_eq!(ticket, offer.ticket);
    // The waiter: waits for the outcome, admits again, owns the rewrite and decides it.
    let waiter = {
        let (gate, manifest) = (gate.clone(), manifest.clone());
        tokio::spawn(async move {
            gate.0.wait_for(ticket).await;
            let TailRefusal::Rebuild(next) = refused(admit_turn(gate.clone(), manifest.clone()).await) else { panic!("offered again") };
            assert_ne!(next.ticket, ticket, "a new decision");
            let Claimed::Owner(lease) = gate.claim(next) else { panic!("the waiter owns it") };
            lease.resolve(Resolution::Irreducible);
            admit_turn(gate, manifest).await
        })
    };
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished(), "the waiter waits while the owner lives");
    owner.abort();
    let verdict = tokio::time::timeout(std::time::Duration::from_secs(5), waiter).await.expect("the waiter resumed").unwrap();
    assert!(matches!(verdict, Verdict::Send(_)), "the waiter's decision holds");
}

/// Each session store owns the books of its sessions: two stores (two data directories) holding a session of the same id
/// judge it on two books, while a second open of a session in one store is that session's book, each open judging with
/// its own turn's settings.
#[tokio::test]
async fn same_id_sessions_of_two_stores_have_their_own_books_and_a_second_open_shares_one() {
    let settings = |at: i64, auto_clear: bool| super::GateSettings {
        clock: std::sync::Arc::new(move || at),
        auto_clear: std::sync::Arc::new(move || auto_clear),
        sizing: SIZING,
        fresh: false,
        last_send_at: None,
    };
    let (one, two) = (super::Books::default(), super::Books::default());
    let (proven_book, _) = proven("5m");
    let next = anthropic(&body(2, "5m"));
    let on_a = route("a");
    let first = one.gate("home", Some(&proven_book.to_json()), settings(T0 + 1, true));
    let other_store = two.gate("home", Some(&Book::unrecorded(false, None).to_json()), settings(T0 + 1, true));
    assert!(matches!(ask_turn(&first, &on_a, &next).await, Verdict::Send(_)), "live on its own store's book");
    assert!(matches!(ask_turn(&other_store, &on_a, &next).await, Verdict::Send(_)), "the other store's session proved nothing, so nothing of it expired");
    // A second open of the session in the first store: the same book (its offer is the first open's), judged with its own
    // settings, and the first open's settings untouched.
    let later = anthropic(&body(3, "5m"));
    let expired = T0 + TTL_5M_MS as i64 + 1;
    let second = one.gate("home", None, settings(expired, false));
    assert!(matches!(ask_turn(&second, &on_a, &later).await, Verdict::Send(_)), "auto-clear off on the second open");
    let late = one.gate("home", None, settings(expired, true));
    let TailRefusal::Rebuild(offer) = refused(ask_turn(&late, &on_a, &later).await) else { panic!("expired on the shared book") };
    let Claimed::Owner(_lease) = late.claim(offer) else { panic!("the owner") };
    let again = one.gate("home", None, settings(expired, true));
    assert_eq!(refused(ask_turn(&again, &on_a, &later).await), TailRefusal::Wait(offer.ticket), "another open sees the same rewrite");
    assert!(matches!(ask_turn(&first, &on_a, &later).await, Verdict::Send(_)), "the first open still judges at its own clock");
    assert!(matches!(ask_turn(&other_store, &on_a, &later).await, Verdict::Send(_)), "and the other store waits for no rewrite of this one");
}

async fn ask_turn(gate: &mixdog_core_api::domain::cache_tail::TailGateHandle, route: &TailRoute, manifest: &WireManifest) -> Verdict {
    gate.0.admit(Admission { purpose: Purpose::Turn, route, manifest, generation: None, unreduced: None }).await
}

/// A session that leaves memory takes its book along: what it learned is handed over for the header, the process map no
/// longer holds it, a gate still held judges nothing on it, and the next load judges by the persisted book.
#[tokio::test]
async fn an_unloaded_session_leaves_no_book_and_reloads_the_persisted_one() {
    let (books, session) = (super::Books::default(), "unloaded".to_owned());
    let at = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(T0 + 1));
    let clock: super::Clock = {
        let at = at.clone();
        std::sync::Arc::new(move || at.load(std::sync::atomic::Ordering::SeqCst))
    };
    let settings = || super::GateSettings { clock: clock.clone(), auto_clear: std::sync::Arc::new(|| true), sizing: SIZING, fresh: false, last_send_at: None };
    let (book, _) = proven("5m");
    let gate = books.gate(&session, Some(&book.to_json()), settings());
    let on_a = route("a");
    let next = anthropic(&body(2, "5m"));
    let Verdict::Send(permit) = gate.0.admit(Admission { purpose: Purpose::Turn, route: &on_a, manifest: &next, generation: None, unreduced: None }).await
    else {
        panic!("live")
    };
    gate.0.settle(&permit, wrote_5m(1900, 300));
    assert!(books.loaded(&session));
    let header = books.unsaved(&session).expect("the settle is unsaved");
    books.release(&session);
    assert!(!books.loaded(&session), "the map holds no entry for the unloaded session");
    let later = anthropic(&body(3, "5m"));
    let ask = |gate| ask_turn(gate, &on_a, &later);
    assert_eq!(refused(ask(&gate).await), TailRefusal::Stale, "a gate kept across the unload is rebuilt on the reloaded book");
    // The settle at T0+1 renewed the tail: just before its expiry the reloaded book admits it, where the book the
    // session was opened with (proven at T0) would already have expired.
    at.store(COLD, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(book.judge(&on_a, &later, COLD), Judgment::Cold(Cold::Expired));
    let reloaded = books.gate(&session, Some(&header), settings());
    assert!(matches!(ask(&reloaded).await, Verdict::Send(_)), "judged by the persisted book");
    at.store(COLD + 1, std::sync::atomic::Ordering::SeqCst);
    assert!(matches!(refused(ask(&reloaded).await), TailRefusal::Rebuild(ColdRequest { cold: Cold::Expired, .. })));
    books.release(&session);
}

/// A rewrite claimed when its session leaves memory is not orphaned: its waiter wakes and admits again on the reloaded book.
#[tokio::test]
async fn an_unload_releases_a_pending_rewrite_and_wakes_its_waiter() {
    let (books, session) = (super::Books::default(), "unloaded-rewrite".to_owned());
    let clock: super::Clock = std::sync::Arc::new(|| COLD);
    let settings = || super::GateSettings { clock: clock.clone(), auto_clear: std::sync::Arc::new(|| true), sizing: SIZING, fresh: false, last_send_at: None };
    let persisted = expired().0.to_json();
    let gate = books.gate(&session, Some(&persisted), settings());
    let manifest = anthropic(&body(3, "5m"));
    let on_a = route("a");
    let ask = |gate| ask_turn(gate, &on_a, &manifest);
    let TailRefusal::Rebuild(offer) = refused(ask(&gate).await) else { panic!("an offer") };
    let Claimed::Owner(_lease) = gate.claim(offer) else { panic!("the owner") };
    assert_eq!(refused(ask(&gate).await), TailRefusal::Wait(offer.ticket));
    let waiting = tokio::spawn(gate.0.wait_for(offer.ticket));
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished());
    books.release(&session);
    tokio::time::timeout(std::time::Duration::from_secs(5), waiting).await.expect("the waiter woke").unwrap();
    let reloaded = books.gate(&session, Some(&persisted), settings());
    assert!(matches!(refused(ask(&reloaded).await), TailRefusal::Rebuild(_)), "the reloaded book offers the rewrite afresh");
    books.release(&session);
}

/// Two callers cold on one history (on two routes) share its one offer: the first to claim owns it, the other waits for it.
#[test]
fn two_offers_have_one_owner() {
    let (mut book, manifest) = expired();
    let on_b = sent(admit(&mut book, &anthropic(&body(1, "5m")), "b", Purpose::Turn, T0));
    book.settle(&on_b, wrote_5m(0, 900), T0);
    let TailRefusal::Rebuild(first) = refused(admit(&mut book, &manifest, "a", Purpose::Turn, COLD)) else { panic!() };
    let TailRefusal::Rebuild(second) = refused(admit(&mut book, &manifest, "b", Purpose::Turn, COLD)) else { panic!() };
    assert_eq!(first.ticket, second.ticket);
    assert_eq!(book.claim(second.ticket), Claim::Owner);
    assert_eq!(book.claim(first.ticket), Claim::Wait(second.ticket));
    book.rebuilt();
    assert_eq!(book.claim(first.ticket), Claim::Stale, "an offer from before a rewrite");
}

/// A refresh proven on route A says nothing about route B: an irreducible decision stays in force on B (no second
/// summary), while A, whose fresh proof later expires, is decided again.
#[test]
fn a_proof_on_one_route_does_not_rearm_the_disposition_on_another() {
    let (mut book, manifest) = expired();
    let on_b = sent(admit(&mut book, &anthropic(&body(1, "5m")), "b", Purpose::Turn, T0));
    book.settle(&on_b, wrote_5m(0, 900), T0);
    let TailRefusal::Rebuild(offer) = refused(admit(&mut book, &manifest, "a", Purpose::Turn, COLD)) else { panic!() };
    assert_eq!(book.claim(offer.ticket), Claim::Owner);
    book.resolve(offer.ticket, Resolution::Irreducible);
    let on_a = sent(admit(&mut book, &manifest, "a", Purpose::Turn, COLD + 1));
    book.settle(&on_a, wrote_5m(0, 9000), COLD + 2);
    let _ = sent(admit(&mut book, &manifest, "b", Purpose::Turn, COLD + 3));
    let _ = sent(admit(&mut book, &manifest, "b", Purpose::Turn, COLD + 2 + TTL_5M_MS as i64));
    assert!(matches!(
        refused(admit(&mut book, &manifest, "a", Purpose::Turn, COLD + 2 + TTL_5M_MS as i64)),
        TailRefusal::Rebuild(ColdRequest { cold: Cold::Expired, .. })
    ));
}

/// A plain side question never writes a compacted base unchanged (its body may predate the rewrite); one rebuilt after its
/// own idle compaction does.
#[test]
fn only_the_turn_or_a_side_question_after_its_own_compaction_writes_the_compacted_base() {
    let mut book = Book::unrecorded(false, None);
    book.rebuilt();
    let base = anthropic(&body(3, "5m"));
    assert_eq!(refused(admit(&mut book, &base, "a", Purpose::SideQuestion, T0)), TailRefusal::Skip(Cold::Unproven));
    let _ = sent(admit(&mut book, &base, "a", Purpose::SideAfterCompaction, T0 + 1));
}

/// The kept book of an unloaded session goes through the warmer's touch file: a warm's refresh, kept there, survives the
/// process, and the next process's first load of the session judges the tail from it.
#[tokio::test]
async fn a_kept_book_is_persisted_in_the_touch_file_and_read_at_the_next_load() {
    use crate::warmer::stores::TouchStore;
    let dir = tempfile::tempdir().unwrap();
    let io = mixdog_rt::testing::tokens().durability_io;
    let open = || async {
        let at: crate::warmer::stores::Now = std::sync::Arc::new(|| T0 as f64);
        std::sync::Arc::new(TouchStore::open(dir.path().join("touches.json"), io, std::sync::Arc::new(|_| {}), at).await.unwrap())
    };
    let settings = |at: i64| super::GateSettings {
        clock: std::sync::Arc::new(move || at),
        auto_clear: std::sync::Arc::new(|| true),
        sizing: SIZING,
        fresh: false,
        last_send_at: None,
    };
    let (book, manifest) = proven("5m");
    let header = book.to_json();
    let extent = book.receipts()[0].extent.unwrap();
    let session = "kept-in-file";
    let touches = open().await;
    let books = super::Books::kept_in(touches.clone());
    let warm_at = T0 + 240_000;
    let warm = books.gate(session, Some(&header), settings(warm_at));
    let on_a = route("a");
    let Verdict::Send(permit) =
        warm.0.admit(Admission { purpose: Purpose::Warm, route: &on_a, manifest: &manifest, generation: None, unreduced: None }).await
    else {
        panic!("the warm is admitted inside the lifetime")
    };
    warm.0.settle(&permit, Some(Counters { read: Some(extent), created: Some(0), created_5m: Some(0), created_1h: Some(0) }));
    books.keep_unloaded(session);
    touches.flush().await;
    drop((books, touches));

    let books = super::Books::kept_in(open().await);
    let later = anthropic(&body(2, "5m"));
    let at = warm_at + TTL_5M_MS as i64 - 1;
    assert_eq!(book.judge(&on_a, &later, at), Judgment::Cold(Cold::Expired), "the header alone has expired");
    let load = books.gate(session, Some(&header), settings(at));
    assert!(matches!(ask_turn(&load, &on_a, &later).await, Verdict::Send(_)), "the next process's load judges from the kept warm");
}

#[derive(Default)]
struct Kept(std::sync::Mutex<std::collections::HashMap<String, Value>>);

impl super::KeptBooks for Kept {
    fn kept(&self, session_id: &str) -> Option<Value> {
        self.0.lock().unwrap().get(session_id).cloned()
    }
    fn keep(&self, session_id: &str, book: Value) {
        self.0.lock().unwrap().insert(session_id.to_owned(), book);
    }
    fn drop_kept(&self, session_id: &str) {
        self.0.lock().unwrap().remove(session_id);
    }
}

/// A warm of a session that is not loaded refreshes its tail on a book opened from the header; the book is kept and leaves
/// memory, and the session's next load judges the tail from the warm's use, which the header alone does not hold. The
/// load's own release, once its owner committed the book to the header, drops the kept one; a header that moved on since
/// (a send of the session's own) wins over a kept book.
#[tokio::test]
async fn a_warm_of_an_unloaded_session_reaches_its_next_load() {
    use super::KeptBooks as _;
    let kept = std::sync::Arc::new(Kept::default());
    let books = super::Books::kept_in(kept.clone());
    let session = "unloaded-warm";
    let settings = |at: i64| super::GateSettings {
        clock: std::sync::Arc::new(move || at),
        auto_clear: std::sync::Arc::new(|| true),
        sizing: SIZING,
        fresh: false,
        last_send_at: None,
    };
    let (book, manifest) = proven("5m");
    let header = book.to_json();
    let extent = book.receipts()[0].extent.unwrap();
    let warm_at = T0 + 240_000;
    let warm = books.gate(session, Some(&header), settings(warm_at));
    let on_a = route("a");
    let Verdict::Send(permit) =
        warm.0.admit(Admission { purpose: Purpose::Warm, route: &on_a, manifest: &manifest, generation: None, unreduced: None }).await
    else {
        panic!("the warm is admitted inside the lifetime")
    };
    warm.0.settle(&permit, Some(Counters { read: Some(extent), created: Some(0), created_5m: Some(0), created_1h: Some(0) }));
    books.keep_unloaded(session);
    assert!(!books.loaded(session), "nothing stays open after the warm");
    assert!(kept.kept(session).is_some(), "the warm's evidence is kept");

    let later = anthropic(&body(2, "5m"));
    let past_send = warm_at + TTL_5M_MS as i64 - 1;
    assert_eq!(book.judge(&on_a, &later, past_send), Judgment::Cold(Cold::Expired), "the header alone has expired");
    let load = books.gate(session, Some(&header), settings(past_send));
    assert!(matches!(ask_turn(&load, &on_a, &later).await, Verdict::Send(_)), "the load judges from the warm's use");
    let committed = books.unsaved(session).expect("a kept book is committed by the loaded owner");
    books.release(session);
    assert!(kept.kept(session).is_none(), "the header holds it now");
    let reloaded = books.gate(session, Some(&committed), settings(past_send));
    assert!(matches!(ask_turn(&reloaded, &on_a, &later).await, Verdict::Send(_)), "and the header judges as the kept book did");
    books.release(session);

    kept.keep(session, header.clone());
    let mut moved = header.clone();
    moved["lastSendAt"] = json!(T0 + 1_000);
    assert_eq!(books.generation(session, Some(&moved)), 0);
    let gate = books.gate(session, Some(&moved), settings(T0 + 1_000 + TTL_5M_MS as i64));
    assert!(matches!(ask_turn(&gate, &on_a, &later).await, Verdict::Send(_)), "the header's later send decides, not the kept book");
}
