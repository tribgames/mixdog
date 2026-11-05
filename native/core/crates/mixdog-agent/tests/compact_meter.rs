//! The per-message token meter equals Node's `estimateMessageTokens`.

mod compact_support;

use compact_support::node_message;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_core_api::domain::provider::ContentPart;

/// The golden transcripts carry text only; media is the host's to price.
struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}

#[test]
fn meter_equals_node() {
    let golden = golden!("meter");
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let mut all = Vec::new();
    for case in golden["cases"].as_array().expect("cases") {
        let message = node_message(&case["message"]);
        assert_eq!(
            meter.message(&message),
            case["tokens"].as_u64().expect("tokens"),
            "{}",
            case["message"]
        );
        all.push(message);
    }
    assert_eq!(meter.messages(&all), golden["total"].as_u64().expect("total"));
}
