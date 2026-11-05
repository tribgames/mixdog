//! The ids a compaction dropped equal Node's `droppedIdentities`.

mod compact_support;

use compact_support::node_message;
use mixdog_agent::compact::dropped::dropped_summary;

#[test]
fn dropped_identities_equal_node() {
    let golden = golden!("dropped");
    for case in golden["cases"].as_array().expect("cases") {
        let rows = |key: &str| -> Vec<_> { case[key].as_array().expect(key).iter().map(node_message).collect() };
        let (count, got) = dropped_summary(&rows("before"), &rows("after"));
        let name = case["name"].as_str().unwrap();
        assert_eq!(count, case["droppedMessages"].as_u64().unwrap(), "{name} droppedMessages");
        match case["identities"].as_object() {
            None => assert!(got.is_none(), "{name}"),
            Some(expected) => {
                let strings = |key: &str| -> Vec<String> {
                    expected[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
                };
                let got = got.unwrap_or_else(|| panic!("{name}: expected ids"));
                assert_eq!(got.message_ids, strings("messageIds"), "{name} messageIds");
                assert_eq!(got.call_ids, strings("callIds"), "{name} callIds");
            }
        }
    }
}
