//! The text cache's bounds: entries and retained UTF-16 bytes, oldest dropped first, an entry larger than the whole budget refused.

use super::Bounded;
use super::Entry;

fn entry(key: &str, content: &str) -> Entry<()> {
    Entry { key: key.to_owned(), content: content.to_owned(), ts: 0, first: None, meta: () }
}

fn keys(cache: &Bounded<()>) -> Vec<&str> {
    cache.entries.iter().map(|e| e.key.as_str()).collect()
}

#[test]
fn the_oldest_entry_goes_when_the_entry_count_is_full() {
    let mut cache = Bounded::new();
    for key in ["a", "b", "c"] {
        assert_eq!(cache.set_within(entry(key, "x"), 3, 1_000), (true, vec![]));
    }
    assert_eq!(cache.set_within(entry("d", "x"), 3, 1_000), (true, vec!["a".to_owned()]));
    assert_eq!(keys(&cache), ["b", "c", "d"]);
}

#[test]
fn setting_a_key_again_replaces_it_and_moves_it_to_the_back() {
    let mut cache = Bounded::new();
    cache.set_within(entry("a", "1"), 10, 1_000);
    cache.set_within(entry("b", "2"), 10, 1_000);
    assert_eq!(cache.set_within(entry("a", "3"), 10, 1_000), (true, vec!["a".to_owned()]));
    assert_eq!(keys(&cache), ["b", "a"]);
    assert_eq!(cache.entries[1].content, "3");
}

#[test]
fn an_entry_is_charged_two_bytes_per_utf16_unit_of_its_key_and_content() {
    // "ab" + "cd" is four units, eight bytes: it fits a budget of eight and not of seven.
    assert!(Bounded::new().set_within(entry("ab", "cd"), 10, 8).0);
    assert!(!Bounded::new().set_within(entry("ab", "cd"), 10, 7).0);
    // An astral character is two UTF-16 units: "k" + one emoji is three units, six bytes.
    assert!(Bounded::new().set_within(entry("k", "\u{1F600}"), 10, 6).0);
    assert!(!Bounded::new().set_within(entry("k", "\u{1F600}"), 10, 5).0);
}

#[test]
fn older_entries_are_dropped_until_the_retained_bytes_fit() {
    let mut cache = Bounded::new();
    cache.set_within(entry("a", "xx"), 10, 20); // 6 bytes
    cache.set_within(entry("b", "xx"), 10, 20); // 6 bytes
    cache.set_within(entry("c", "xx"), 10, 20); // 6 bytes: 18 retained
    // A 10-byte entry needs 28 retained: the two oldest go (28 - 12 = 16 <= 20).
    let (stored, dropped) = cache.set_within(entry("d", "xxxx"), 10, 20);
    assert_eq!((stored, dropped), (true, vec!["a".to_owned(), "b".to_owned()]));
    assert_eq!(keys(&cache), ["c", "d"]);
}

#[test]
fn an_entry_over_the_whole_budget_is_refused_and_drops_only_its_own_older_copy() {
    let mut cache = Bounded::new();
    cache.set_within(entry("a", "x"), 10, 20);
    cache.set_within(entry("big", "x"), 10, 20);
    let (stored, dropped) = cache.set_within(entry("big", &"x".repeat(50)), 10, 20);
    assert_eq!((stored, dropped), (false, vec!["big".to_owned()]));
    assert_eq!(keys(&cache), ["a"], "nothing else is evicted for an entry that cannot fit");
}
