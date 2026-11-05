//! `explore`: one read-only explorer loop per query, all in parallel, merged into one bounded
//! answer within the same tool call. The loop itself (fixed prompt, read-only tool surface,
//! ≤10 tool rounds) belongs to the agent runtime; this is the fan-out, deadline and merge.

use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use futures::future::join_all;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde_json::Value;

use crate::orch::util::JsStr;
use tokio_util::sync::CancellationToken;

use super::util::cancelled;
use super::util::spec_from_def;
use super::util::text;

pub const EXPLORE_MAX_QUERIES: usize = 8;
pub const EXPLORE_TIMEOUT: Duration = Duration::from_secs(120);
pub const EXPLORE_OUTPUT_CAP: usize = 24_000;
const TRUNCATED: &str = "\n[explore: answer truncated]";

/// What one explorer produced. `late` marks text written before the deadline cut the loop.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ExploreAnswer {
    pub text: String,
    pub late: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ExploreFailure {
    /// The deadline passed with nothing written.
    TimedOut,
    Message(String),
}

pub struct ExploreRun<'a> {
    pub query: &'a str,
    pub thread: &'a ThreadId,
    pub cwd: &'a AbsPath,
    pub cancel: &'a CancellationToken,
    /// The loop is cut here and returns the text it already wrote.
    pub deadline: Instant,
}

#[async_trait]
pub trait ExploreRunner: Send + Sync {
    /// `Err` with the user-facing reason when Explore has no model or its provider is not
    /// ready (nothing has run yet).
    async fn prepare(&self) -> Result<(), String>;
    async fn explore(&self, run: ExploreRun<'_>) -> Result<ExploreAnswer, ExploreFailure>;
}

fn queries(args: &Value) -> Vec<String> {
    let list: Vec<&Value> = match args.get("query") {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(v) => vec![v],
        None => Vec::new(),
    };
    list.into_iter().filter_map(Value::as_str).map(|q| q.js_trim().to_owned()).filter(|q| !q.is_empty()).collect()
}

fn capped(text: &str, budget: usize) -> String {
    if text.js_len() <= budget {
        return text.to_owned();
    }
    let keep = budget.saturating_sub(TRUNCATED.js_len());
    format!("{}{TRUNCATED}", mixdog_js::slice_utf16(text, keep))
}

/// Headings and error lines are labels, not answers: no truncation marker.
fn shortened(text: &str, max: usize) -> String {
    if text.js_len() <= max {
        text.to_owned()
    } else {
        format!("{}…", mixdog_js::slice_utf16(text, max - 1))
    }
}

/// The merged text and whether every explorer failed.
pub fn merge(queries: &[String], results: &[Result<ExploreAnswer, ExploreFailure>], timeout: Duration) -> (String, bool) {
    let budget = EXPLORE_OUTPUT_CAP / queries.len().max(1);
    let secs = timeout.as_secs();
    let bodies: Vec<String> = results
        .iter()
        .map(|r| match r {
            Ok(a) if !a.text.js_trim().is_empty() => {
                let body = if a.late { format!("{}\n[explore: partial, timed out]", a.text.js_trim()) } else { a.text.js_trim().to_owned() };
                capped(&body, budget)
            }
            Ok(_) => "[explore error] explorer returned no answer".to_owned(),
            Err(ExploreFailure::TimedOut) => format!("[explore error] timed out after {secs}s with no answer"),
            Err(ExploreFailure::Message(m)) => format!("[explore error] {}", shortened(m, 500)),
        })
        .collect();
    let all_failed = results.iter().all(|r| !matches!(r, Ok(a) if !a.text.js_trim().is_empty()));
    let text = if queries.len() == 1 {
        bodies[0].clone()
    } else {
        bodies
            .iter()
            .zip(queries)
            .enumerate()
            .map(|(i, (body, q))| {
                let one_line = mixdog_js::js_words(q).collect::<Vec<_>>().join(" ");
                format!("## Q{}: {}\n{body}", i + 1, shortened(&one_line, 100))
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    (text, all_failed)
}

fn explore_error(message: impl Into<String>) -> ToolError {
    let message = message.into();
    ToolError::new(ToolErrorCode::Unavailable { capability: "explore".to_owned(), reason: message.clone() }, message)
}

pub struct ExploreTool {
    spec: ToolSpec,
    runner: Arc<dyn ExploreRunner>,
}

impl ExploreTool {
    pub fn new(runner: Arc<dyn ExploreRunner>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/explore.json"), true, &[]), runner }
    }
}

#[async_trait]
impl Tool for ExploreTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let queries = queries(&args);
        if queries.is_empty() {
            return Err(explore_error("[explore error] query is required"));
        }
        if queries.len() > EXPLORE_MAX_QUERIES {
            return Err(explore_error(format!("[explore error] at most {EXPLORE_MAX_QUERIES} queries per call")));
        }
        self.runner.prepare().await.map_err(|m| explore_error(format!("[explore error] {m}")))?;
        let started = Instant::now();
        let deadline = ctx.deadline.unwrap_or(started + EXPLORE_TIMEOUT);
        let timeout = deadline.saturating_duration_since(started);
        let runs = queries.iter().map(|query| {
            self.runner.explore(ExploreRun { query, thread: &ctx.thread_id, cwd: &ctx.cwd, cancel: &ctx.cancel, deadline })
        });
        let results = join_all(runs).await;
        if ctx.cancel.is_cancelled() {
            return Err(cancelled());
        }
        let (merged, all_failed) = merge(&queries, &results, timeout);
        if all_failed {
            return Err(explore_error(merged));
        }
        text(merged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(t: &str, late: bool) -> Result<ExploreAnswer, ExploreFailure> {
        Ok(ExploreAnswer { text: t.to_owned(), late })
    }

    #[test]
    fn single_query_returns_the_bare_answer() {
        let (text, failed) = merge(&["q".into()], &[ok("answer", false)], EXPLORE_TIMEOUT);
        assert_eq!((text.as_str(), failed), ("answer", false));
    }

    #[test]
    fn many_queries_get_headings_and_error_lines() {
        let results = vec![ok("a1", true), Err(ExploreFailure::TimedOut), Err(ExploreFailure::Message("boom".into()))];
        let queries: Vec<String> = vec!["first  question".into(), "second".into(), "third".into()];
        let (text, failed) = merge(&queries, &results, EXPLORE_TIMEOUT);
        assert!(!failed);
        assert_eq!(
            text,
            "## Q1: first question\na1\n[explore: partial, timed out]\n\n## Q2: second\n[explore error] timed out after 120s with no answer\n\n## Q3: third\n[explore error] boom"
        );
        assert!(merge(&queries[..1], &[Err(ExploreFailure::TimedOut)], EXPLORE_TIMEOUT).1);
    }

    #[test]
    fn long_answers_are_capped_per_query() {
        let long = "x".repeat(30_000);
        let (text, _) = merge(&["q".into()], &[ok(&long, false)], EXPLORE_TIMEOUT);
        assert_eq!(text.js_len(), EXPLORE_OUTPUT_CAP);
        assert!(text.ends_with(TRUNCATED));
    }
}
