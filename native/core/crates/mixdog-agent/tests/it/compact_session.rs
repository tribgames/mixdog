//! A session's compactor is wired as Node wires it: sized by the policy the session's settings resolve
//! to (automatic compaction on or off), the triggers armed, the summary threshold the session's.

use crate::compact_support;

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use compact_support::NoAttachments;
use compact_support::NoBlobs;
use compact_support::NoRedaction;
use compact_support::PreviewArchive;
use compact_support::Rows;
use compact_support::replay_owner;
use mixdog_agent::boundary::CompactSettings;
use mixdog_agent::compact::compactor::FreshCompactor;
use mixdog_agent::compact::compactor::FreshParts;
use mixdog_agent::compact::compactor::SessionCompactor;
use mixdog_agent::compact::compactor::TriggerSeams;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::summary_run::ForkRequest;
use mixdog_agent::compact::summary_run::ForkSource;
use mixdog_agent::compact::summary_run::RouteResolver;
use mixdog_agent::compact::summary_run::RouteStep;
use mixdog_agent::compact::summary_run::SummaryFailure;
use mixdog_agent::compact::summary_run::SummaryMode;
use mixdog_agent::compact::summary_run::SummaryResponse;
use mixdog_agent::compact::summary_run::SummaryRoute;
use mixdog_agent::compact::triggers::CacheTail;
use mixdog_agent::compact::triggers::CacheWarmLedger;
use mixdog_agent::compact::triggers::ToolMediaMeter;
use mixdog_agent::env::CompactError;
use mixdog_agent::env::CompactRequest;
use mixdog_agent::env::CompactTrigger;
use mixdog_agent::env::Compactor;
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only session: {part:?}")
    }
}

/// Every tool result carries 30 MB of images: the request-media trigger arms.
struct HeavyMedia;
impl ToolMediaMeter for HeavyMedia {
    fn bytes(&self, _: &Content, _: bool) -> u64 {
        30_000_000
    }
    fn count(&self, _: &Content, _: bool) -> u64 {
        1
    }
}

/// An agent session whose last request was sent an hour ago on a 5-minute tail.
struct ExpiredTail;
impl CacheWarmLedger for ExpiredTail {
    fn last_use_at(&self) -> u64 {
        0
    }
    fn route_use_at(&self) -> Option<u64> {
        Some(0)
    }
}
impl CacheTail for ExpiredTail {
    fn agent_owner(&self) -> bool {
        true
    }
    fn five_minute_tail(&self) -> bool {
        true
    }
    fn last_provider_send_at(&self) -> u64 {
        1_000
    }
    fn now_ms(&self) -> u64 {
        3_600_000
    }
}

struct Cold;
#[async_trait]
impl ForkSource for Cold {
    fn warm(&self) -> bool {
        false
    }
    fn request(&self) -> Option<ForkRequest> {
        None
    }
    async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
        panic!("a cold session forks nothing")
    }
}

/// No route is available; the steps asked for are recorded.
#[derive(Default)]
struct Asked(Mutex<Vec<RouteStep>>);
#[async_trait]
impl RouteResolver for Asked {
    async fn resolve(&self, step: RouteStep) -> Result<Option<SummaryRoute>, SummaryFailure> {
        self.0.lock().unwrap().push(step);
        Ok(None)
    }
}

fn settings(window: Option<u64>) -> CompactSettings {
    CompactSettings {
        auto: false,
        context_window: window,
        request_reserve_tokens: 1_200,
        configured_reserve_tokens: 800,
        token_calibration: 1.25,
        ..CompactSettings::default()
    }
}

fn session(settings: CompactSettings, threshold: Option<u64>, resolver: Arc<Asked>) -> SessionCompactor {
    SessionCompactor {
        settings,
        parts: Arc::new(FreshParts {
            media: Arc::new(TextOnly),
            replay_owner: replay_owner(),
            rows: Arc::new(Rows),
            archive: Arc::new(PreviewArchive { session: "sess_test".into() }),
            attachments: Arc::new(NoAttachments),
            redactor: Arc::new(NoRedaction),
            blobs: Arc::new(NoBlobs),
        }),
        triggers: TriggerSeams { tool_media: Arc::new(HeavyMedia), native_pdf: false, cache: Arc::new(ExpiredTail) },
        fork: Arc::new(Cold),
        resolver,
        summary_mode: SummaryMode::Session,
        conversation_threshold_tokens: threshold,
    }
}

fn conversation() -> Vec<AgentMessage> {
    (0..6)
        .flat_map(|n| [AgentMessage::user(format!("question {n} {}", "word ".repeat(200))), AgentMessage::assistant(format!("answer {n} {}", "word ".repeat(200)), Vec::new())])
        .collect()
}

fn request(messages: &[AgentMessage]) -> CompactRequest<'_> {
    CompactRequest { messages, budget_tokens: 4_000, trigger: CompactTrigger::Auto, require_reduction: false, reference_latest_attachments: false, active_turn: true }
}

#[test]
fn a_session_without_a_boundary_has_no_compactor() {
    assert!(FreshCompactor::for_session(session(settings(None), None, Arc::default())).is_none());
}

#[test]
fn the_compactor_is_sized_by_the_policy_even_with_automatic_compaction_off() {
    let compactor = FreshCompactor::for_session(session(settings(Some(200_000)), None, Arc::default())).expect("a compactor");
    assert_eq!(compactor.config.reserve_tokens, 2_000, "request reserve plus the operator's headroom");
    assert_eq!(compactor.config.context_window, 200_000);
    assert_eq!(compactor.config.max_budget_tokens, 160_000, "floor(200000 / 1.25)");
    assert_eq!(compactor.config.handoff_token_cap, None);
}

#[test]
fn an_explicit_boundary_below_the_window_is_the_context_the_hard_budget_is_cut_from() {
    let compactor = FreshCompactor::for_session(session(
        CompactSettings { explicit_boundary: Some(100_000), token_calibration: 1.0, ..settings(Some(200_000)) },
        None,
        Arc::default(),
    ))
    .expect("a compactor");
    assert_eq!(compactor.config.context_window, 200_000);
    assert_eq!(compactor.config.max_budget_tokens, 200_000);
}

#[test]
fn the_session_arms_the_cache_expiry_and_request_media_triggers() {
    let compactor = FreshCompactor::for_session(session(settings(Some(200_000)), None, Arc::default())).expect("a compactor");
    assert!(compactor.cache_expired());
    let result = AgentMessage::tool_result("c1", Content::Text("shot".into()), mixdog_agent::message::ToolKind::Normal);
    assert!(compactor.request_media(&[result]));
}

#[tokio::test]
async fn a_conversation_over_the_sessions_threshold_is_summarized_on_its_plan() {
    let asked = Arc::new(Asked::default());
    let compactor = FreshCompactor::for_session(session(settings(Some(200_000)), Some(1), asked.clone())).expect("a compactor");
    let messages = conversation();
    let error = compactor.compact(request(&messages)).await.err().expect("no route is available");
    assert!(matches!(error, CompactError::Failed(ref m) if m == "compact summary route unavailable"), "{error:?}");
    assert_eq!(*asked.0.lock().unwrap(), vec![RouteStep::Session], "mode self: the conversation's own model only");
}

#[tokio::test]
async fn a_conversation_under_the_threshold_is_rebuilt_by_rules_alone() {
    let asked = Arc::new(Asked::default());
    let compactor = FreshCompactor::for_session(session(settings(Some(200_000)), Some(10_000_000), asked.clone())).expect("a compactor");
    let messages = conversation();
    compactor.compact(request(&messages)).await.expect("rules-only compaction");
    assert!(asked.0.lock().unwrap().is_empty());
}

/// `runHandoffCompaction` (a manual pass between turns) passes no `activeTurn`: a finished conversation that fits comes back
/// as it is, with no active-turn continuation, so Node reports "nothing to compact"; a pass inside a turn gets the continuation.
#[tokio::test]
async fn only_a_pass_inside_a_turn_adds_the_active_turn_continuation() {
    let compactor = FreshCompactor::for_session(session(settings(Some(200_000)), Some(10_000_000), Arc::default())).expect("a compactor");
    let messages = vec![AgentMessage::user("is the code accepted?".to_owned()), AgentMessage::assistant("Yes.".to_owned(), Vec::new())];
    let between = compactor.compact(CompactRequest { active_turn: false, ..request(&messages) }).await.expect("between turns");
    assert_eq!(between.messages.len(), messages.len(), "{:?}", between.messages);
    let inside = compactor.compact(request(&messages)).await.expect("inside a turn");
    assert_eq!(inside.messages.len(), messages.len() + 1);
    assert_eq!(inside.messages.last().and_then(|m| m.source.clone()), Some(mixdog_agent::message::Source::ActiveTurnContinuation));
}
