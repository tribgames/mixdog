//! `Bounded::set` replayed against Node's `setBoundedTextCacheEntry` (`fixtures/text-cache-budget/golden.json`,
//! `benchmarks/rust-core/recorders/record-text-cache-budget.mjs`).

use serde_json::Value;
use serde_json::json;

use super::Bounded;
use super::Entry;

#[test]
fn text_cache_bounds_equal_node() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/text-cache-budget/golden.json")).unwrap();
    for scenario in golden["scenarios"].as_array().unwrap() {
        let max_entries = scenario["maxEntries"].as_u64().unwrap() as usize;
        let max_bytes = scenario["maxBytes"].as_u64().unwrap() as usize;
        let mut cache = Bounded::<()>::new();
        let mut evicted: Vec<String> = Vec::new();
        let mut steps = Vec::new();
        for step in scenario["steps"].as_array().unwrap() {
            let key = step["key"].as_str().unwrap().to_owned();
            let before: Vec<String> = cache.entries.iter().map(|e| e.key.clone()).collect();
            let entry = Entry { key: key.clone(), content: step["content"].as_str().unwrap().to_owned(), ts: 0, first: None, meta: () };
            let stored = cache.set_within(entry, max_entries, max_bytes);
            let keys: Vec<String> = cache.entries.iter().map(|e| e.key.clone()).collect();
            // Node's onEvict sees the replaced key first, then each oldest entry it dropped, front to back.
            if before.contains(&key) {
                evicted.push(key.clone());
            }
            evicted.extend(before.iter().filter(|k| **k != key && !keys.contains(k)).cloned());
            steps.push(json!({"key": key, "content": step["content"], "stored": stored, "keys": keys, "evicted": evicted}));
        }
        assert_eq!(Value::Array(steps), scenario["steps"], "{}", scenario["name"]);
    }
}
