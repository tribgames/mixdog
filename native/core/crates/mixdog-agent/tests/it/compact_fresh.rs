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
        tail: TailContext { meter: &meter, rows: &Rows, archive: &archive, redactor: &compact_support::NoRedaction, preview: true },
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
        Ok(mixdog_agent::compact::compactor::Handoff { text: self.0.clone(), usage: None, summary_ms: 0.0 })
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
                active_turn: scenario["options"]["activeTurn"].as_bool().unwrap_or(false),
            })
            .await
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let got: Vec<_> = output.messages.iter().map(node_row).collect();
        assert_eq!(&got, scenario["result"].as_array().expect("result"), "{name}");
    }
}

struct SlowHandoff;
#[async_trait::async_trait]
impl mixdog_agent::compact::compactor::HandoffSource for SlowHandoff {
    async fn triggered(&self, _: &[mixdog_agent::message::AgentMessage]) -> bool {
        true
    }
    async fn handoff(
        &self,
        _: &[mixdog_agent::message::AgentMessage],
        _: u64,
    ) -> Result<mixdog_agent::compact::compactor::Handoff, mixdog_agent::env::CompactError> {
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        Ok(mixdog_agent::compact::compactor::Handoff { text: "handoff".into(), usage: None, summary_ms: 33.0 })
    }
}

/// `pipeline.totalMs` spans the summary decision, the summary and the rebuild (so it covers the summary request), whole
/// milliseconds; `generated.durationMs` is the summary request's own; a pass with no summary reports none and a pipeline of the
/// rebuild alone. Node's values are wall-clock times: the meaning is tested, never equal milliseconds.
#[tokio::test]
async fn the_pipeline_time_spans_the_summary_and_the_summary_time_is_its_own() {
    use mixdog_agent::compact::compactor::CompactorConfig;
    use mixdog_agent::compact::compactor::FreshCompactor;
    use mixdog_agent::compact::compactor::FreshParts;
    use mixdog_agent::env::CompactRequest;
    use mixdog_agent::env::CompactTrigger;
    use mixdog_agent::env::Compactor;
    use std::sync::Arc;

    let golden = golden!("fresh");
    let session = golden["sessionId"].as_str().expect("session").to_owned();
    let scenario = &golden["scenarios"].as_array().expect("scenarios")[0];
    let messages: Vec<_> = scenario["messages"].as_array().expect("messages").iter().map(node_message).collect();
    let o = &scenario["options"];
    for summarize in [true, false] {
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
            summary: summarize.then(|| Arc::new(SlowHandoff) as Arc<dyn mixdog_agent::compact::compactor::HandoffSource>),
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
                active_turn: scenario["options"]["activeTurn"].as_bool().unwrap_or(false),
            })
            .await
            .expect("compact");
        assert_eq!(output.pipeline_ms.fract(), 0.0, "whole milliseconds");
        if summarize {
            assert_eq!(output.summary_ms, Some(33.0), "the summary request's own time");
            assert!(output.pipeline_ms >= 40.0, "the pipeline covers the summary request: {}", output.pipeline_ms);
        } else {
            assert_eq!(output.summary_ms, None);
            assert!(output.pipeline_ms < 40.0, "no summary request in the span: {}", output.pipeline_ms);
        }
    }
}

/// Every file an execution dump writes (the dump and a large message's blob).
struct Written(std::sync::Mutex<Vec<String>>);
#[async_trait::async_trait]
impl mixdog_agent::offload::ArtifactStore for Written {
    async fn persist(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        self.0.lock().unwrap().push(content.to_owned());
        self.preview(content).await
    }
    async fn preview(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        let n = self.0.lock().unwrap().len();
        Some(mixdog_agent::offload::Artifact { display_path: format!("/art/{n}.txt"), path: format!("/art/{n}.txt"), lines: content.lines().count(), sha256: "ab".repeat(32) })
    }
}

/// A session that marked `482913` sensitive.
struct MarkedCode;
impl mixdog_agent::compact::dropped::Redactor for MarkedCode {
    fn redact(&self, rows: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
        rows.into_iter()
            .map(|row| serde_json::from_str(&serde_json::to_string(&row).unwrap().replace("482913", "[redacted]")).unwrap())
            .collect()
    }
}

/// The dump and its blobs are written with the session's sensitive values redacted (Node
/// `buildExecutionTail` over `redactSensitiveMessages`); the transcript kept in context is not.
#[tokio::test]
async fn execution_dump_holds_sensitive_values_redacted() {
    use mixdog_agent::compact::execution_tail::{TailOptions, build_execution_tail};
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let written = Written(std::sync::Mutex::new(Vec::new()));
    let ctx = TailContext { meter: &meter, rows: &Rows, archive: &written, redactor: &MarkedCode, preview: false };
    let fill = serde_json::json!({ "action": "fill", "input": { "ref": "e1", "text": "482913", "sensitive": true } });
    let messages: Vec<_> = [
        serde_json::json!({ "role": "user", "content": "The portal mailed me 482913." }),
        serde_json::json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "f", "name": "browser", "arguments": fill }] }),
        serde_json::json!({ "role": "tool", "toolCallId": "f", "content": format!("Filled 482913\n{}", "page line\n".repeat(15_000)) }),
        serde_json::json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "r", "name": "read", "arguments": { "path": "a" } }] }),
        serde_json::json!({ "role": "tool", "toolCallId": "r", "content": "ok" }),
    ]
    .iter()
    .map(node_message)
    .collect();
    let out = build_execution_tail(&ctx, &messages, &TailOptions { context_window: 40_000, preserve_conversation: false }).await.expect("tail");
    let files = written.0.lock().unwrap().clone();
    assert!(files.len() >= 2, "the dump and the large result's blob: {}", files.len());
    for file in &files {
        assert!(!file.contains("482913"), "{file:.200}");
        assert!(file.contains("[redacted]") || file.contains("archivedMessage"), "{file:.200}");
    }
    assert!(out.messages.iter().any(|m| m.text().contains("482913") || m.tool_calls().iter().any(|c| c.arguments.to_string().contains("482913"))));
}