//! The ids a compaction dropped equal Node's `droppedIdentities`.

mod compact_support;

use compact_support::node_message;
use compact_support::NoBlobs;
use compact_support::NoRedaction;
use mixdog_agent::compact::dropped::dropped_summary;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_protocol::message_class::user_text::UserText;

struct StoredByIds(std::collections::HashMap<String, serde_json::Value>);

impl MessageRows for StoredByIds {
    fn row(&self, message: &mixdog_agent::message::AgentMessage) -> serde_json::Value {
        self.0[message.message_id.as_deref().expect("stored message id")].clone()
    }
}

#[test]
fn dropped_identities_equal_node() {
    let golden = golden!("dropped");
    for case in golden["cases"].as_array().expect("cases") {
        let rows = |key: &str| -> Vec<_> { case[key].as_array().expect(key).iter().map(node_message).collect() };
        let blobs = NoBlobs;
        // The store keeps every row Node wrote, `meta` included, by message id.
        let stored = StoredByIds(
            case["before"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| (row["meta"]["transcript"]["messageId"].as_str().unwrap().to_owned(), row.clone()))
                .collect(),
        );
        let (count, got) =
            dropped_summary(&rows("before"), &rows("after"), &stored, &NoRedaction, &mut UserText::new(&blobs));
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
