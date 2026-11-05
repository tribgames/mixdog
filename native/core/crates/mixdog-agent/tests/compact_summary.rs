//! Summary prompts, schema repair and handoff fitting equal Node's.

mod compact_support;

use compact_support::Rows;
use compact_support::node_message;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::summary::COMPACTION_SYSTEM_PROMPT;
use mixdog_agent::compact::summary::HandoffMeta;
use mixdog_agent::compact::summary::enforce_compact_summary_schema;
use mixdog_agent::compact::summary::fit_complete_compaction_prompt;
use mixdog_agent::compact::summary::fit_generated_handoff_message;
use mixdog_agent::compact::summary::forked_compaction_prompt;
use mixdog_core_api::domain::provider::ContentPart;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}

#[test]
fn summary_pieces_equal_node() {
    let golden = golden!("summary");
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let head: Vec<_> = golden["head"].as_array().expect("head").iter().map(node_message).collect();

    assert_eq!(COMPACTION_SYSTEM_PROMPT, golden["systemPrompt"].as_str().expect("system"));
    assert_eq!(forked_compaction_prompt(), golden["forkedPrompt"].as_str().expect("forked"));

    for (i, case) in golden["prompts"].as_array().expect("prompts").iter().enumerate() {
        let h = if case.get("head").is_some() { Vec::new() } else { head.clone() };
        let got = fit_complete_compaction_prompt(&meter, &h, case["previous"].as_str(), case["target"].as_f64().expect("target") as u64);
        assert_eq!(got.as_deref(), case["prompt"].as_str(), "prompt {i}");
    }

    let tail = &head[head.len() - 1..];
    for case in golden["enforce"].as_array().expect("enforce") {
        let name = case["name"].as_str().expect("name");
        let got = enforce_compact_summary_schema(case["summary"].as_str().expect("summary"), &head, tail);
        assert_eq!(got.summary, case["result"]["summary"].as_str().expect("out"), "{name}");
        assert_eq!(got.repaired, case["result"]["repaired"].as_bool().expect("repaired"), "{name}");
    }

    for case in golden["fits"].as_array().expect("fits") {
        let name = case["name"].as_str().expect("name");
        let got = fit_generated_handoff_message(
            &meter,
            &Rows,
            &head,
            case["summary"].as_str().expect("summary"),
            case["remaining"].as_u64().expect("remaining"),
            &HandoffMeta { provider: Some("anthropic"), model: "opus" },
        );
        assert_eq!(got.map(|m| m.text()), case["result"]["content"].as_str().map(str::to_owned), "{name}");
    }
}

#[test]
fn conversation_input_equals_node() {
    use compact_support::NoAttachments;
    use compact_support::PreviewArchive;
    use mixdog_agent::compact::conversation::conversation_compaction_input;
    use mixdog_agent::compact::execution_tail::TailContext;
    use mixdog_agent::compact::fresh::FreshContext;

    let golden = golden!("conversation");
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let archive = PreviewArchive { session: "s".into() };
    let ctx = FreshContext {
        tail: TailContext { meter: &meter, rows: &Rows, archive: &archive, preview: true },
        attachments: &NoAttachments,
    };
    let messages: Vec<_> = golden["messages"].as_array().expect("messages").iter().map(node_message).collect();
    for (key, summary) in [("plain", false), ("summary", true)] {
        let got: Vec<_> = conversation_compaction_input(&ctx, &messages, summary)
            .iter()
            .map(|m| (compact_support::node_row(m)["role"].clone(), m.text()))
            .collect();
        let want: Vec<_> = golden[key]
            .as_array()
            .expect("rows")
            .iter()
            .map(|r| (r["role"].clone(), r["content"].as_str().expect("content").to_owned()))
            .collect();
        assert_eq!(got.len(), want.len(), "{key}");
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            assert_eq!(g, w, "{key} row {i}");
        }
    }
}
