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
            let entry = Entry { key: key.clone(), content: step["content"].as_str().unwrap().to_owned(), ts: 0, first: None, meta: () };
            let (stored, dropped) = cache.set_within(entry, max_entries, max_bytes);
            evicted.extend(dropped);
            let entries: Vec<_> = cache.entries.iter().map(|e| json!({"key": e.key, "content": e.content})).collect();
            steps.push(json!({"key": key, "content": step["content"], "stored": stored, "entries": entries, "evicted": evicted}));
        }
        assert_eq!(Value::Array(steps), scenario["steps"], "{}", scenario["name"]);
    }
}
