//! Owner: s4-engine-actions-observe-nav
//! Condition-based waiting (`actions/flow.ts`). `wait` holds until the page shows some text, no longer shows some text and/or has
//! a URL containing some text, up to a limit, and then answers with the page as it is. The conditions are the same ones a command's
//! `expect` is checked against (`settle::postcondition`), read the same way: the page's text is read only when a text condition
//! needs it, and it counts only if the page did not navigate while it was read. Sequence dispatch lives in `actions::sequence`, so
//! waiting never needs to know how the next gesture will address the page.
//!
//! The old engine woke on a DOM-change latch it held in the page; the host's page is read here every [`POSTCONDITION_POLL`] instead,
//! the same cadence a command's `expect` is polled at.

use std::time::Duration;

use async_trait::async_trait;
use mixdog_js::js_trim;
use mixdog_rt::CancelView;
use mixdog_rt::time;
use serde_json::Value;

use super::observe::ActionError;
use super::observe::bounded_integer;
use super::observe::number_arg;
use crate::error::HostCallError;
use crate::limits::POSTCONDITION_POLL;
use crate::reply::reply::ToolReply;
use crate::settle::postcondition::Expected;
use crate::settle::postcondition::PageSample;
use crate::settle::postcondition::describe;
use crate::settle::postcondition::matches;
use crate::settle::reply_wait::read_page_text;
use crate::settle::settle::Cancelled;
use crate::settle::settle::Page;
use crate::settle::settle::cancelled;
use crate::settle::settle::pause;
use crate::settle::settle::throw_if_cancelled;

const DEFAULT_WAIT_MS: i64 = 10_000;
const MIN_WAIT_MS: i64 = 500;
const MAX_WAIT_MS: i64 = 30_000;

/// The page report a wait ends with: the runner's snapshot reply (`reply.snapshotResult`), taken only when the command is not an
/// internal step of a sequence.
#[async_trait]
pub trait WaitReport: Send + Sync {
    async fn snapshot(&self) -> Result<ToolReply, ActionError>;
}

/// A condition of the command: a string, trimmed; anything else is not given.
fn condition(command: &Value, name: &str) -> String {
    command.get(name).and_then(Value::as_str).map(|text| js_trim(text).to_owned()).unwrap_or_default()
}

/// What one reading of the page's text found.
enum Observation {
    Text { text: String, truncated: bool },
    Failed(String),
}

/// The whole text of the page, read in parts when it is longer than one read returns. A text still cut after the last part is
/// reported as `truncated`.
async fn observe_text(page: &Page<'_>, cancel: &CancelView) -> Result<Observation, Cancelled> {
    let read = read_page_text(page.host, page.id, cancel.token()).await;
    throw_if_cancelled(cancel)?;
    Ok(match read {
        Err(HostCallError::Cancelled) => return Err(cancelled(cancel)),
        Err(error) => Observation::Failed(format!("Page observation failed: {error}")),
        Ok(whole) => Observation::Text { text: whole.text, truncated: whole.clipped },
    })
}

/// `wait`: `text`, `textGone` and/or `url` (substrings) to wait for, `timeoutMs` (500 ms to 30 s, 10 s by default). `internalStep`
/// (a step of a sequence) answers without the page report.
pub async fn wait(page: &Page<'_>, cancel: &CancelView, command: &Value, report: &dyn WaitReport) -> Result<ToolReply, ActionError> {
    throw_if_cancelled(cancel)?;
    let want_text = condition(command, "text");
    let want_gone = condition(command, "textGone");
    let want_url = condition(command, "url");
    if want_text.is_empty() && want_gone.is_empty() && want_url.is_empty() {
        return Err(ActionError::failed("wait requires text, textGone, and/or url (substrings to wait for)"));
    }
    let timeout = Duration::from_millis(bounded_integer(number_arg(command, "timeoutMs"), DEFAULT_WAIT_MS, MIN_WAIT_MS, MAX_WAIT_MS) as u64);
    let internal_step = command.get("internalStep").is_some_and(|step| !matches!(step, Value::Null | Value::Bool(false)));
    let expected = Expected { text: &want_text, text_gone: &want_gone, url: &want_url };
    let url_only = Expected { text: "", text_gone: "", url: &want_url };
    let reads_text = !want_text.is_empty() || !want_gone.is_empty();
    let started = time::Instant::now();
    let mut observation_failure = String::new();
    let matched = loop {
        throw_if_cancelled(cancel)?;
        let url = page.probe.state().url;
        let mut text: Option<String> = None;
        if reads_text && matches(url_only, PageSample { text: None, url: &url }) {
            match observe_text(page, cancel).await? {
                Observation::Failed(failure) => observation_failure = failure,
                // The page may have navigated while it was read: its text must not be combined with the URL from before that read.
                Observation::Text { .. } if page.probe.state().url != url => {
                    observation_failure = "Page URL changed during condition observation".to_owned();
                }
                // The rest of a text cut after every part was not observed: it cannot prove that a phrase is gone.
                Observation::Text { truncated: true, .. } if !want_gone.is_empty() => {
                    observation_failure = "Page observation failed: the page holds more text than one read carries".to_owned();
                }
                Observation::Text { text: observed, .. } => {
                    observation_failure.clear();
                    text = Some(observed);
                }
            }
        }
        if matches(expected, PageSample { text: text.as_deref(), url: &url }) {
            break true;
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            break false;
        }
        pause(POSTCONDITION_POLL.min(timeout - elapsed), cancel).await?;
    };
    throw_if_cancelled(cancel)?;
    if !matched {
        let waited = describe(expected);
        let mut outcome = String::new();
        if !internal_step {
            outcome = match report.snapshot().await {
                Ok(reply) => reply.text,
                Err(error) => {
                    if cancel.is_cancelled() {
                        return Err(cancelled(cancel).into());
                    }
                    format!("Final snapshot failed: {error}")
                }
            };
        }
        throw_if_cancelled(cancel)?;
        let head = format!("Wait timed out after {}ms without matching {waited}.", timeout.as_millis());
        return Err(ActionError::Failed([head, observation_failure, outcome].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n")));
    }
    let elapsed = started.elapsed().as_millis();
    let mut reply = if internal_step { ToolReply::default() } else { report.snapshot().await? };
    throw_if_cancelled(cancel)?;
    reply.text = format!("Condition met after {elapsed}ms.\n\n{}", reply.text);
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use mixdog_rt::CancelSource;
    use mixdog_rt::CancellationToken;
    use serde_json::json;

    use super::*;
    use crate::fake::page_facts;
    use crate::port::HostWire;
    use crate::settle::settle::PageProbe;
    use crate::settle::settle::PageState;

    const URL: &str = "https://fixture.example/Complete";

    struct Probe(Mutex<String>);

    impl PageProbe for Probe {
        fn state(&self) -> PageState {
            PageState { url: self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone(), ..PageState::default() }
        }

        fn stop_loading(&self) {}
    }

    /// Answers `page/read` from a list of texts (the last one stays), and may move the page to another URL during the first read.
    struct Texts {
        probe: Arc<Probe>,
        answers: Mutex<VecDeque<Result<String, String>>>,
        url_after_first_read: Option<String>,
        reads: AtomicUsize,
    }

    #[async_trait]
    impl HostWire for Texts {
        async fn call(&self, method: &'static str, _params: Value, _cancel: &CancellationToken) -> Result<Value, HostCallError> {
            assert_eq!(method, "host/browser/page/read");
            if self.reads.fetch_add(1, Ordering::SeqCst) == 0
                && let Some(url) = &self.url_after_first_read
            {
                *self.probe.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = url.clone();
            }
            let mut answers = self.answers.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let answer = if answers.len() > 1 { answers.pop_front() } else { answers.front().cloned() };
            match answer.expect("an answer") {
                Ok(text) => Ok(json!({"payload": {"url": "u", "title": "", "text": text}, "truncated": false, "facts": page_facts("p1", 1)})),
                Err(message) => Err(HostCallError::Failed { message }),
            }
        }

        fn notify(&self, _method: &'static str, _params: Value) -> Result<(), HostCallError> {
            Ok(())
        }
    }

    fn rig(answers: Vec<Result<&str, &str>>, url_after_first_read: Option<&str>) -> (Arc<Probe>, Texts) {
        let probe = Arc::new(Probe(Mutex::new(URL.to_owned())));
        let host = Texts {
            probe: probe.clone(),
            answers: Mutex::new(answers.into_iter().map(|answer| answer.map(str::to_owned).map_err(str::to_owned)).collect()),
            url_after_first_read: url_after_first_read.map(str::to_owned),
            reads: AtomicUsize::new(0),
        };
        (probe, host)
    }

    /// The page report the runner would take: a text, or a failure.
    struct Report {
        reply: Result<&'static str, &'static str>,
        taken: AtomicUsize,
        cancel_on_take: Option<Arc<CancelSource>>,
    }

    impl Report {
        fn observed() -> Self {
            Self { reply: Ok("Observed"), taken: AtomicUsize::new(0), cancel_on_take: None }
        }
    }

    #[async_trait]
    impl WaitReport for Report {
        async fn snapshot(&self) -> Result<ToolReply, ActionError> {
            self.taken.fetch_add(1, Ordering::SeqCst);
            if let Some(source) = &self.cancel_on_take {
                source.cancel("user takeover");
            }
            self.reply.map(ToolReply::text).map_err(|message| ActionError::failed(message))
        }
    }

    async fn run(probe: &Probe, host: &Texts, command: Value, report: &Report) -> Result<ToolReply, ActionError> {
        let source = CancelSource::new();
        let view = source.view();
        let page = Page { host, id: "p1", probe };
        wait(&page, &view, &command, report).await
    }

    #[tokio::test]
    async fn a_url_only_wait_never_reads_the_text() {
        for command in [json!({"url": "/COMPLETE"}), json!({"url": "  /Complete  "})] {
            let (probe, host) = rig(vec![Err("must not be read")], None);
            let report = Report::observed();
            let reply = run(&probe, &host, command, &report).await.expect("the url holds");
            assert!(reply.text.starts_with("Condition met after ") && reply.text.ends_with("ms.\n\nObserved"), "{}", reply.text);
            assert_eq!(host.reads.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn text_and_text_gone_and_url_are_checked_together_on_one_read() {
        let (probe, host) = rig(vec![Ok("Saved successfully")], None);
        let reply = run(&probe, &host, json!({"text": "SAVED", "textGone": "Loading", "url": "/complete"}), &Report::observed()).await.expect("holds");
        assert!(reply.text.starts_with("Condition met after "), "{}", reply.text);
        assert!(reply.text.ends_with("ms.\n\nObserved"), "{}", reply.text);
        assert_eq!(host.reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_timeout_keeps_the_observation_failure_and_the_snapshot_failure() {
        let (probe, host) = rig(vec![Err("frame unavailable")], None);
        let report = Report { reply: Err("snapshot unavailable"), taken: AtomicUsize::new(0), cancel_on_take: None };
        let error = run(&probe, &host, json!({"textGone": "Saving", "timeoutMs": 500}), &report).await.expect_err("times out");
        let ActionError::Failed(message) = error else { panic!("{error:?}") };
        assert!(message.starts_with("Wait timed out after 500ms without matching textGone \"Saving\"."), "{message}");
        assert!(message.contains("\n\nPage observation failed: frame unavailable"), "{message}");
        assert!(message.ends_with("\n\nFinal snapshot failed: snapshot unavailable"), "{message}");
    }

    #[tokio::test]
    async fn blank_or_non_string_conditions_are_refused_before_any_observation() {
        for command in [json!({"text": " \t "}), json!({"textGone": 1}), json!({"url": null}), json!({})] {
            let (probe, host) = rig(vec![Err("must not be read")], None);
            let error = run(&probe, &host, command, &Report::observed()).await.expect_err("refused");
            assert_eq!(error, ActionError::failed("wait requires text, textGone, and/or url (substrings to wait for)"));
            assert_eq!(host.reads.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn the_text_condition_is_trimmed() {
        let (probe, host) = rig(vec![Ok("Saved")], None);
        run(&probe, &host, json!({"text": "  Saved  "}), &Report::observed()).await.expect("trimmed");
    }

    #[tokio::test]
    async fn an_internal_step_answers_without_the_page_report() {
        let (probe, host) = rig(vec![Ok("Saved")], None);
        let report = Report::observed();
        let reply = run(&probe, &host, json!({"text": "Saved", "internalStep": true}), &report).await.expect("holds");
        assert!(reply.text.starts_with("Condition met after "), "{}", reply.text);
        assert_eq!(report.taken.load(Ordering::SeqCst), 0);
        let (probe, host) = rig(vec![Ok("Saving")], None);
        let error = run(&probe, &host, json!({"text": "Saved", "timeoutMs": 500, "internalStep": true}), &report).await.expect_err("times out");
        assert_eq!(report.taken.load(Ordering::SeqCst), 0);
        let ActionError::Failed(message) = error else { panic!("{error:?}") };
        assert_eq!(message, "Wait timed out after 500ms without matching text \"Saved\".");
    }

    #[tokio::test]
    async fn a_cancelled_command_is_never_observed() {
        let (probe, host) = rig(vec![Err("must not be read")], None);
        let source = CancelSource::new();
        source.cancel("user takeover");
        let view = source.view();
        let page = Page { host: &host, id: "p1", probe: &*probe };
        let error = wait(&page, &view, &json!({"url": "/Complete"}), &Report::observed()).await.expect_err("cancelled");
        assert!(matches!(&error, ActionError::Cancelled(cancelled) if cancelled.reason.as_deref() == Some("user takeover")), "{error:?}");
        assert_eq!(host.reads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancellation_during_the_final_snapshot_keeps_its_reason() {
        let (probe, host) = rig(vec![Ok("Saving")], None);
        let source = Arc::new(CancelSource::new());
        let report = Report { reply: Ok("Observed"), taken: AtomicUsize::new(0), cancel_on_take: Some(source.clone()) };
        let view = source.view();
        let page = Page { host: &host, id: "p1", probe: &*probe };
        let error = wait(&page, &view, &json!({"text": "Saved", "timeoutMs": 500}), &report).await.expect_err("cancelled");
        assert!(matches!(&error, ActionError::Cancelled(cancelled) if cancelled.reason.as_deref() == Some("user takeover")), "{error:?}");
        assert_eq!(report.taken.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn text_read_across_a_navigation_is_not_combined_with_the_old_url() {
        let (probe, host) = rig(vec![Ok("Saved")], Some("https://fixture.example/other"));
        let command = json!({"text": "Saved", "textGone": "Saving", "url": "/complete", "timeoutMs": 500, "internalStep": true});
        let error = run(&probe, &host, command, &Report::observed()).await.expect_err("times out");
        let ActionError::Failed(message) = error else { panic!("{error:?}") };
        assert!(message.starts_with("Wait timed out"), "{message}");
        assert!(message.ends_with("\n\nPage URL changed during condition observation"), "{message}");
        assert_eq!(host.reads.load(Ordering::SeqCst), 1, "a mismatched URL must not trigger another page-text read");
    }

    #[tokio::test]
    async fn a_stable_observation_after_navigation_can_satisfy_the_condition() {
        let (probe, host) = rig(vec![Ok("Saved")], Some("https://fixture.example/after"));
        let command = json!({"textGone": "Saving", "timeoutMs": 500, "internalStep": true});
        let reply = run(&probe, &host, command, &Report::observed()).await.expect("holds on the second read");
        assert!(reply.text.starts_with("Condition met after "), "{}", reply.text);
        assert_eq!(host.reads.load(Ordering::SeqCst), 2, "the changed-URL result is discarded, not treated as an empty document");
    }
}
