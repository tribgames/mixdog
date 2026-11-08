//! Rule-only fresh-context compaction equals Node's `freshContextCompactMessages`.

use crate::compact_support;

use compact_support::NoAttachments;
use compact_support::PreviewArchive;
use compact_support::Rows;
use compact_support::node_message;
use compact_support::node_row;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::execution_tail::TailContext;
use mixdog_agent::compact::fresh::FreshContext;
use mixdog_agent::compact::fresh::FreshOptions;
use mixdog_agent::compact::fresh::fresh_context_compact_messages;
use mixdog_core_api::domain::provider::ContentPart;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}

#[tokio::test]
async fn fresh_context_equals_node() {
    let golden = golden!("fresh");
    let session = golden["sessionId"].as_str().expect("session").to_owned();
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let archive = PreviewArchive { session };
    let ctx = FreshContext {
        tail: TailContext { meter: &meter, rows: &Rows, archive: &archive, preview: true },
        attachments: &NoAttachments,
    };
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("name");
        let o = &scenario["options"];
        let messages: Vec<_> = scenario["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let options = FreshOptions {
            max_budget_tokens: o["maxBudgetTokens"].as_u64().unwrap_or(0),
            context_window: o["contextWindow"].as_u64().unwrap_or(0),
            handoff_text: o["handoffText"].as_str().unwrap_or_default().to_owned(),
            active_turn: o["activeTurn"].as_bool().unwrap_or(false),
            force: true,
            ..FreshOptions::default()
        };
        let result = fresh_context_compact_messages(&ctx, &messages, scenario["budget"].as_u64().expect("budget"), &options)
            .await
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let got: Vec<_> = result.messages.iter().map(node_row).collect();
        let want = scenario["result"].as_array().expect("result");
        assert_eq!(got.len(), want.len(), "{name}: message count\n{got:#?}");
        for (index, (g, w)) in got.iter().zip(want).enumerate() {
            assert_eq!(g, w, "{name}: message {index}");
        }
        assert_eq!(result.fresh_context, scenario["freshContext"].as_bool().expect("flag"), "{name}");
    }
}

struct FixedHandoff(String);
#[async_trait::async_trait]
impl mixdog_agent::compact::compactor::HandoffSource for FixedHandoff {
    async fn triggered(&self, _: &[mixdog_agent::message::AgentMessage]) -> bool {
        !self.0.is_empty()
    }
    async fn handoff(
        &self,
        _: &[mixdog_agent::message::AgentMessage],
        _: u64,
    ) -> Result<mixdog_agent::compact::compactor::Handoff, mixdog_agent::env::CompactError> {
        Ok(mixdog_agent::compact::compactor::Handoff { text: self.0.clone(), usage: None })
    }
}

/// The loop's `Compactor` produces the same transcripts as the rebuild itself.
#[tokio::test]
async fn compactor_equals_node() {
    use mixdog_agent::compact::compactor::CompactorConfig;
    use mixdog_agent::compact::compactor::FreshCompactor;
    use mixdog_agent::compact::compactor::FreshParts;
    use mixdog_agent::env::CompactRequest;
    use mixdog_agent::env::CompactTrigger;
    use mixdog_agent::env::Compactor;
    use std::sync::Arc;

    let golden = golden!("fresh");
    let session = golden["sessionId"].as_str().expect("session").to_owned();
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("name");
        let o = &scenario["options"];
        let messages: Vec<_> = scenario["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let compactor = FreshCompactor {
            parts: Arc::new(FreshParts {
                media: Arc::new(TextOnly),
                replay_owner: replay_owner(),
                rows: Arc::new(Rows),
                archive: Arc::new(PreviewArchive { session: session.clone() }),
                attachments: Arc::new(NoAttachments),
                redactor: Arc::new(compact_support::NoRedaction),
                blobs: Arc::new(compact_support::NoBlobs),
            }),
            triggers: None,
            summary: Some(Arc::new(FixedHandoff(o["handoffText"].as_str().unwrap_or_default().to_owned()))),
            config: CompactorConfig {
                max_budget_tokens: o["maxBudgetTokens"].as_u64().unwrap_or(0),
                context_window: o["contextWindow"].as_u64().unwrap_or(0),
                ..CompactorConfig::default()
            },
        };
        let output = compactor
            .compact(CompactRequest {
                messages: &messages,
                budget_tokens: scenario["budget"].as_u64().expect("budget"),
                trigger: CompactTrigger::Auto,
                require_reduction: false,
                reference_latest_attachments: false,
            })
            .await
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let got: Vec<_> = output.messages.iter().map(node_row).collect();
        assert_eq!(&got, scenario["result"].as_array().expect("result"), "{name}");
    }
}
