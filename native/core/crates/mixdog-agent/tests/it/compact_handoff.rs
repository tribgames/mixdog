//! The handoff summary generation (batching, schema repair) equals Node's.

use crate::compact_support;

use std::sync::Mutex;

use compact_support::NoAttachments;
use compact_support::PreviewArchive;
use compact_support::Rows;
use compact_support::node_message;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::execution_tail::TailContext;
use mixdog_agent::compact::fresh::FreshContext;
use mixdog_agent::compact::summary_run::HandoffInput;
use mixdog_agent::compact::summary_run::SummaryCall;
use mixdog_agent::compact::summary_run::SummaryFailure;
use mixdog_agent::compact::summary_run::SummaryResponse;
use mixdog_agent::compact::summary_run::SummarySender;
use mixdog_agent::compact::summary_run::generate_fresh_handoff_summary;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Usage;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}

struct Scripted {
    responses: Vec<String>,
    sent: Mutex<Vec<(String, String, String, u64)>>,
}

#[async_trait::async_trait]
impl SummarySender for Scripted {
    async fn send(&self, system: &str, prompt: &str, call: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
        let mut sent = self.sent.lock().unwrap();
        let index = sent.len();
        sent.push((system.to_owned(), prompt.to_owned(), call.model.clone(), call.max_output_tokens));
        let text = self.responses.get(index).or(self.responses.last()).cloned().unwrap_or_default();
        Ok(SummaryResponse {
            text,
            tool_call: false,
            usage: Some(Usage { input_tokens: 10, output_tokens: 5, cache_read_tokens: 1, cache_write_tokens: 2, ..Usage::default() }),
        })
    }
}

#[tokio::test]
async fn handoff_generation_equals_node() {
    let golden = golden!("handoff");
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let archive = PreviewArchive { session: "s".into() };
    let ctx = FreshContext {
        tail: TailContext { meter: &meter, rows: &Rows, archive: &archive, redactor: &compact_support::NoRedaction, preview: true },
        attachments: &NoAttachments,
    };
    for run in golden["runs"].as_array().expect("runs") {
        let name = run["name"].as_str().expect("name");
        let messages: Vec<_> = run["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let sender = Scripted {
            responses: run["responses"].as_array().expect("responses").iter().map(|r| r.as_str().expect("text").to_owned()).collect(),
            sent: Mutex::new(Vec::new()),
        };
        let opts = &run["opts"];
        let got = generate_fresh_handoff_summary(
            &ctx,
            &messages,
            &HandoffInput {
                sender: &sender,
                model: "opus",
                provider_name: Some("anthropic"),
                budget_tokens: run["budget"].as_u64().expect("budget"),
                reserve_tokens: 0,
                input_budget_tokens: opts["compactionInputBudgetTokens"].as_u64().unwrap_or(0),
                max_output_tokens: opts["maxOutputTokens"].as_u64().unwrap_or(4096),
                fast: false,
            },
        )
        .await
        .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let sent = sender.sent.lock().unwrap();
        let want = run["sent"].as_array().expect("sent");
        assert_eq!(sent.len(), want.len(), "{name}: calls");
        for (i, (s, w)) in sent.iter().zip(want).enumerate() {
            assert_eq!(s.0, w["system"].as_str().unwrap(), "{name} call {i} system");
            assert_eq!(s.1, w["prompt"].as_str().unwrap(), "{name} call {i} prompt");
            assert_eq!(s.2, w["model"].as_str().unwrap(), "{name} call {i} model");
            assert_eq!(s.3, w["maxOutputTokens"].as_u64().unwrap(), "{name} call {i} max tokens");
        }
        assert_eq!(got.summary, run["summary"].as_str().unwrap(), "{name}: summary");
        assert_eq!(got.repaired, run["repaired"].as_bool().unwrap(), "{name}: repaired");
        assert_eq!(u64::from(got.calls), run["calls"].as_u64().unwrap(), "{name}: calls");
        let usage = got.usage.expect("usage");
        assert_eq!(usage.input_tokens, run["usage"]["inputTokens"].as_u64().unwrap(), "{name}");
        assert_eq!(usage.output_tokens, run["usage"]["outputTokens"].as_u64().unwrap(), "{name}");
        assert_eq!(usage.cache_read_tokens, run["usage"]["cachedTokens"].as_u64().unwrap(), "{name}");
        assert_eq!(usage.cache_write_tokens, run["usage"]["cacheWriteTokens"].as_u64().unwrap(), "{name}");
    }
}

struct Cancelled;
#[async_trait::async_trait]
impl SummarySender for Cancelled {
    async fn send(&self, _: &str, _: &str, _: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
        Err(SummaryFailure::Aborted)
    }
}

/// An aborted summary call surfaces as the abort itself, never as a failed compaction.
#[tokio::test]
async fn an_aborted_summary_call_propagates_as_an_abort() {
    let golden = golden!("handoff");
    let run = &golden["runs"][0];
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let archive = PreviewArchive { session: "s".into() };
    let ctx = FreshContext {
        tail: TailContext { meter: &meter, rows: &Rows, archive: &archive, redactor: &compact_support::NoRedaction, preview: true },
        attachments: &NoAttachments,
    };
    let messages: Vec<_> = run["messages"].as_array().expect("messages").iter().map(node_message).collect();
    let err = generate_fresh_handoff_summary(
        &ctx,
        &messages,
        &HandoffInput {
            sender: &Cancelled,
            model: "opus",
            provider_name: Some("anthropic"),
            budget_tokens: run["budget"].as_u64().expect("budget"),
            reserve_tokens: 0,
            input_budget_tokens: 0,
            max_output_tokens: 4096,
            fast: false,
        },
    )
    .await
    .expect_err("aborted");
    assert!(matches!(err, SummaryFailure::Aborted), "{err:?}");
    assert!(matches!(mixdog_agent::env::CompactError::from(err), mixdog_agent::env::CompactError::Aborted));
}
