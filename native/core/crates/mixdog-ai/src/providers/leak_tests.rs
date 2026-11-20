//! The leaked tool-call guard and the decoders that wire it, replayed from Node's recorded behaviour
//! (`golden/leaked_toolcall.json`).



use super::leak::Dedupe;
use super::leak::LeakGuard;


/// A repeated native id is one call; a name+arguments repeat of a minted id is one call; a native call a leak
/// already ran is suppressed once.
#[test]
fn the_dedupe_follows_node_s_identity_rules() {
    let args = serde_json::json!({ "path": "a.txt" });
    let mut dedupe = Dedupe::default();
    assert!(dedupe.should_dispatch("read", &args, "call_leaked_0123456789abcdef"));
    assert!(!dedupe.should_dispatch("read", &args, ""));
    assert!(!dedupe.should_dispatch("read", &args, "call_native"), "the native copy of a leak that ran");
    assert!(dedupe.should_dispatch("read", &args, "call_other"), "a second native call is its own");
    assert!(!dedupe.should_dispatch("read", &args, "call_other"));
}


















/// One 300 000-character delta passes in linear time: only its last characters can start an opener.
#[test]
fn a_long_delta_holds_back_only_its_opener_tail() {
    let mut guard = LeakGuard::new(["read".to_owned()].into_iter().collect(), false);
    let body = "x".repeat(300_000);
    let started = std::time::Instant::now();
    let (text, calls) = guard.push(&format!("{body}<inv"), false);
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "took {:?}", started.elapsed());
    assert_eq!(text, body);
    assert!(calls.is_empty());
    assert_eq!(guard.flush().0, "<inv");
}
