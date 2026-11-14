//! Owner: s4-engine-settle
//! Waiting for the page to settle and for a postcondition to become true (`reply-wait.ts`). The waits run together: a postcondition
//! that turns true may cut the settle short, unless it was already true before the gesture, in which case it proves nothing about
//! this one and may never shorten the wait.

use std::fmt;
use std::time::Duration;

use mixdog_app_protocol::v2::browser_engine::BrowserPageReadKind;
use mixdog_app_protocol::v2::browser_engine::BrowserPageReadOptions;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageReadParams;
use mixdog_rt::CancelView;
use mixdog_rt::CancellationToken;
use mixdog_rt::time;
use serde_json::Value;

use super::postcondition::ExpectError;
use super::postcondition::Expected;
use super::postcondition::PageSample;
use super::postcondition::Postcondition;
use super::postcondition::matches;
use super::postcondition::normalize;
use super::postcondition::normalize_settle_ms;
use super::settle::AfterAction;
use super::settle::Cancelled;
use super::settle::Page;
use super::settle::SettleError;
use super::settle::SettlePolicy;
use super::settle::pause;
use super::settle::settle_after_action;
use super::settle::throw_if_cancelled;
use super::settle::try_join3;
use crate::error::HostCallError;
use crate::limits::POSTCONDITION_POLL;

/// The most text one read returns over the wire (`READ_MAX_CHARS_WIRE` of the host): a longer text is read in parts of this size.
const POSTCONDITION_READ_CHARS: u32 = 120_000;
/// The most parts one text is read in: the host refuses a page text past a million characters (the observation limit), so a
/// read that has not ended by then is not going to.
const POSTCONDITION_READ_PARTS: usize = 10;

/// What the caller asked of the wait besides the command's own `expect` and `settleMs` (`BrowserSnapshotResultOptions`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplyWaitOptions {
    /// Settle after a gesture (an observation that changed nothing does not).
    pub settle_action: bool,
    /// The postcondition was already true before the gesture: it may not cut the settle short, and the quiet windows are required.
    pub preexisting_postcondition: bool,
    /// Where the page was before the gesture.
    pub baseline_url: Option<String>,
    /// A postcondition the caller already normalised (`Some(None)` is "none"); `None` takes the command's own `expect`.
    pub expected: Option<Option<Postcondition>>,
}

/// What the wait found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyWait {
    /// The explicit delay the command asked for.
    pub settle: Duration,
    pub expected: Option<Postcondition>,
    /// How long the postcondition took to hold, or its whole budget when it never did.
    pub postcondition_elapsed: Duration,
    pub postcondition_matched: bool,
}

/// Why the wait ended without a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyWaitError {
    /// The command's `expect` or `settleMs` cannot be read.
    Expect(ExpectError),
    Settle(SettleError),
}

impl From<ExpectError> for ReplyWaitError {
    fn from(error: ExpectError) -> Self {
        Self::Expect(error)
    }
}

impl From<SettleError> for ReplyWaitError {
    fn from(error: SettleError) -> Self {
        Self::Settle(error)
    }
}

impl From<Cancelled> for ReplyWaitError {
    fn from(error: Cancelled) -> Self {
        Self::Settle(error.into())
    }
}

impl fmt::Display for ReplyWaitError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Expect(error) => fmt::Display::fmt(error, out),
            Self::Settle(error) => fmt::Display::fmt(error, out),
        }
    }
}

impl std::error::Error for ReplyWaitError {}

/// `postconditionMatchesGuest`: whether the page now satisfies `expected`. The text is read from the page only when a text
/// condition needs it, and counts only when the page did not navigate while it was read; a failed reading is "not yet".
pub async fn postcondition_matches_page(page: &Page<'_>, expected: &Postcondition, cancel: &CancelView) -> Result<bool, Cancelled> {
    throw_if_cancelled(cancel)?;
    let url = page.probe.state().url;
    if !matches(Expected { text: "", text_gone: "", url: &expected.url }, PageSample { text: None, url: &url }) {
        return Ok(false);
    }
    if expected.text.is_empty() && expected.text_gone.is_empty() {
        return Ok(true);
    }
    let Some(text) = read_page_text(page, cancel).await? else { return Ok(false) };
    Ok(page.probe.state().url == url && matches(expected.expected(), PageSample { text: Some(&text), url: &url }))
}

/// The whole text of the page, read in parts when it is longer than one read returns; `None` when it could not be read through
/// (a failed read, or a text the host refuses), which a postcondition takes as "not yet": a part of a text proves nothing about
/// a phrase being gone.
async fn read_page_text(page: &Page<'_>, cancel: &CancelView) -> Result<Option<String>, Cancelled> {
    let mut text = String::new();
    // How much has been read, in the UTF-16 units the host counts in.
    let mut taken: u64 = 0;
    for _ in 0..POSTCONDITION_READ_PARTS {
        let offset = (taken > 0).then(|| u32::try_from(taken).unwrap_or(u32::MAX));
        let params = HostBrowserPageReadParams {
            page_id: page.id.to_string(),
            kind: BrowserPageReadKind::Text,
            options: Some(BrowserPageReadOptions { max_chars: Some(POSTCONDITION_READ_CHARS), frame: None, selector: None, include_hidden: None, offset }),
        };
        let read = page.host.page_read(params, cancel.token()).await;
        throw_if_cancelled(cancel)?;
        if matches!(read, Err(HostCallError::Cancelled)) {
            return Err(super::settle::cancelled(cancel));
        }
        let Ok(read) = read else { return Ok(None) };
        let Some(part) = read.payload.get("text").and_then(Value::as_str) else { return Ok(None) };
        taken += mixdog_js::utf16_len(part) as u64;
        text.push_str(part);
        let finished = match read.payload.get("total").and_then(Value::as_u64) {
            Some(total) => taken >= total,
            None => !read.truncated,
        };
        if finished {
            return Ok(Some(text));
        }
        if part.is_empty() {
            return Ok(None);
        }
    }
    Ok(None)
}

/// Polls until the postcondition holds or its budget ends; `announce` is cancelled the moment it holds so the settle can stop
/// waiting for it. Answers how long it took (measured before the probe that found it) and whether it held.
async fn poll_postcondition(
    page: &Page<'_>,
    expected: &Postcondition,
    announce: &CancellationToken,
    cancel: &CancelView,
) -> Result<(Duration, bool), SettleError> {
    let started = time::Instant::now();
    loop {
        throw_if_cancelled(cancel)?;
        let elapsed = started.elapsed();
        if postcondition_matches_page(page, expected, cancel).await? {
            announce.cancel();
            return Ok((elapsed, true));
        }
        if elapsed >= expected.timeout {
            return Ok((elapsed, false));
        }
        // The poll interval is the floor on how fast a verified action can return; each probe is one small page read.
        pause(POSTCONDITION_POLL, cancel).await?;
    }
}

/// `awaitReplyReady`: the settle after a gesture, the explicit `settleMs` and the `expect` poll, together. The command's `expect`
/// and `settleMs` are read as the JSON the caller sent.
pub async fn await_reply_ready(
    page: &Page<'_>,
    policy: &SettlePolicy,
    settle_ms: Option<&Value>,
    expect: Option<&Value>,
    options: &ReplyWaitOptions,
    cancel: &CancelView,
) -> Result<ReplyWait, ReplyWaitError> {
    let settle = normalize_settle_ms(settle_ms)?;
    let expected = match &options.expected {
        Some(given) => given.clone(),
        None => normalize(expect)?,
    };
    let satisfied = CancellationToken::new();
    // A condition that was already true before the gesture proves nothing about this one, so it may never cut the settle short.
    let settle_until = (expected.is_some() && !options.preexisting_postcondition).then_some(&satisfied);
    let after_action = AfterAction {
        // Observe the quiet windows even when nothing looks pending.
        require_quiet: expected.is_some() && options.preexisting_postcondition,
        previous_url: options.baseline_url.clone(),
    };
    let (_, _, (elapsed, matched)) = try_join3(
        async {
            if options.settle_action { settle_after_action(page, policy, cancel, settle_until, &after_action).await } else { Ok(()) }
        },
        async {
            if settle.is_zero() { Ok(()) } else { pause(settle, cancel).await.map_err(SettleError::from) }
        },
        async {
            match &expected {
                Some(expected) => poll_postcondition(page, expected, &satisfied, cancel).await,
                None => Ok((Duration::ZERO, true)),
            }
        },
    )
    .await?;
    Ok(ReplyWait { settle, expected, postcondition_elapsed: elapsed, postcondition_matched: matched })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_rt::CancelSource;
    use serde_json::json;

    use super::super::settle::support::*;
    use super::*;

    const URL: &str = "https://example.test/app";

    fn rig(text: &str) -> (Arc<TestProbe>, Arc<TestHost>) {
        let probe = TestProbe::new(URL);
        let host = Arc::new(TestHost::new(&probe));
        *host.text.lock().expect("lock") = text.to_string();
        (probe, host)
    }

    fn page<'a>(host: &'a TestHost, probe: &'a TestProbe) -> Page<'a> {
        Page { host, id: "p1", probe }
    }

    fn live() -> CancelView {
        CancelSource::new().view()
    }

    #[tokio::test]
    async fn a_postcondition_that_holds_is_found_after_the_gesture_and_reports_how_long_it_took() {
        let (probe, host) = rig("Saved successfully");
        let options = ReplyWaitOptions { settle_action: true, ..ReplyWaitOptions::default() };
        let wait = await_reply_ready(&page(&host, &probe), &fast_policy(), None, Some(&json!({"text": "saved"})), &options, &live()).await.expect("wait");
        assert!(wait.postcondition_matched);
        assert_eq!(wait.settle, Duration::ZERO);
        assert_eq!(wait.expected.as_ref().map(|expected| expected.text.as_str()), Some("saved"));
        assert!(host.count("read") >= 1);
    }

    #[tokio::test]
    async fn a_postcondition_that_never_holds_ends_at_its_budget_and_says_so() {
        let (probe, host) = rig("Still loading");
        let wait = await_reply_ready(&page(&host, &probe), &fast_policy(), None, Some(&json!({"text": "Saved", "timeoutMs": 500})), &ReplyWaitOptions::default(), &live())
            .await
            .expect("wait");
        assert!(!wait.postcondition_matched);
        assert!(wait.postcondition_elapsed >= Duration::from_millis(500));
        assert!(host.count("read") > 1, "the page was read again while waiting");
        assert!(host.count("renderCheckpoint") == 0, "an observation does not settle");
    }

    #[tokio::test]
    async fn a_url_only_condition_reads_no_text_and_a_moved_page_is_not_matched() {
        let (probe, host) = rig("");
        probe.set(|state| state.url = "https://example.test/complete".into());
        let wait = await_reply_ready(&page(&host, &probe), &fast_policy(), None, Some(&json!({"url": "/complete"})), &ReplyWaitOptions::default(), &live())
            .await
            .expect("wait");
        assert!(wait.postcondition_matched);
        assert_eq!(host.count("read"), 0);
    }

    #[tokio::test]
    async fn a_condition_that_held_before_the_gesture_requires_the_quiet_windows() {
        let (probe, host) = rig("Saved");
        let options = ReplyWaitOptions { settle_action: true, preexisting_postcondition: true, baseline_url: Some(URL.into()), expected: None };
        let wait = await_reply_ready(&page(&host, &probe), &fast_policy(), None, Some(&json!({"text": "Saved"})), &options, &live()).await.expect("wait");
        assert!(wait.postcondition_matched);
        assert_eq!(host.count("domQuiet"), 1, "the quiet windows ran although the condition already held");
    }

    #[tokio::test]
    async fn an_explicit_settle_delay_is_waited_and_a_prenormalised_condition_is_taken_as_given() {
        let (probe, host) = rig("");
        let started = time::Instant::now();
        let options = ReplyWaitOptions { expected: Some(None), ..ReplyWaitOptions::default() };
        let wait = await_reply_ready(&page(&host, &probe), &fast_policy(), Some(&json!(40)), Some(&json!({"text": "ignored"})), &options, &live()).await.expect("wait");
        assert!(started.elapsed() >= Duration::from_millis(40));
        assert_eq!(wait.settle, Duration::from_millis(40));
        assert_eq!(wait.expected, None);
        assert!(wait.postcondition_matched);
        assert!(host.called().is_empty());
    }

    #[tokio::test]
    async fn an_unreadable_expect_or_settle_ms_fails_before_anything_waits() {
        let (probe, host) = rig("");
        let bad = await_reply_ready(&page(&host, &probe), &fast_policy(), None, Some(&json!({})), &ReplyWaitOptions::default(), &live()).await.expect_err("bad expect");
        assert!(matches!(bad, ReplyWaitError::Expect(_)));
        assert!(bad.to_string().contains("requires text"));
        let worse = await_reply_ready(&page(&host, &probe), &fast_policy(), Some(&json!("soon")), None, &ReplyWaitOptions::default(), &live()).await.expect_err("bad settleMs");
        assert_eq!(worse.to_string(), "settleMs must be a finite number");
        assert!(host.called().is_empty());
    }

    #[tokio::test]
    async fn cancellation_ends_the_poll_with_the_callers_reason() {
        let (probe, host) = rig("never");
        let source = CancelSource::new();
        let view = source.view();
        let canceller = tokio::spawn(async move {
            time::sleep(Duration::from_millis(30)).await;
            source.cancel("user took control");
        });
        let error = await_reply_ready(&page(&host, &probe), &fast_policy(), None, Some(&json!({"text": "Saved", "timeoutMs": 20_000})), &ReplyWaitOptions::default(), &view)
            .await
            .expect_err("cancelled");
        canceller.await.expect("canceller");
        assert_eq!(error.to_string(), "user took control");
    }

    #[tokio::test]
    async fn a_page_that_navigated_while_its_text_was_read_does_not_match_and_a_failed_read_is_not_yet() {
        let (probe, host) = rig("Saved");
        let expected = normalize(Some(&json!({"text": "Saved"}))).expect("valid").expect("some");
        assert!(postcondition_matches_page(&page(&host, &probe), &expected, &live()).await.expect("read"));

        *host.url_after_read.lock().expect("lock") = Some("https://example.test/elsewhere".into());
        assert!(!postcondition_matches_page(&page(&host, &probe), &expected, &live()).await.expect("read"));

        let (probe, host) = rig("Saved");
        *host.read_fails.lock().expect("lock") = true;
        assert!(!postcondition_matches_page(&page(&host, &probe), &expected, &live()).await.expect("a failed read is not an error"));
    }

    #[tokio::test]
    async fn a_text_longer_than_one_read_is_read_in_parts_so_a_late_phrase_is_found_and_a_missing_one_proved_gone() {
        let long = format!("{}Saved", "x".repeat(250_000));
        let (probe, host) = rig(&long);
        let present = normalize(Some(&json!({"text": "Saved"}))).expect("valid").expect("some");
        assert!(postcondition_matches_page(&page(&host, &probe), &present, &live()).await.expect("read"));
        assert_eq!(host.count("read"), 3, "250,005 characters in parts of 120,000");
        let gone = normalize(Some(&json!({"textGone": "Loading"}))).expect("valid").expect("some");
        assert!(postcondition_matches_page(&page(&host, &probe), &gone, &live()).await.expect("read"));
        let still_there = normalize(Some(&json!({"textGone": "Saved"}))).expect("valid").expect("some");
        assert!(!postcondition_matches_page(&page(&host, &probe), &still_there, &live()).await.expect("read"));
    }

    #[tokio::test]
    async fn a_text_the_host_never_finishes_giving_is_not_yet() {
        let (probe, host) = rig("Saved");
        *host.read_endless.lock().expect("lock") = true;
        let gone = normalize(Some(&json!({"textGone": "Loading"}))).expect("valid").expect("some");
        assert!(!postcondition_matches_page(&page(&host, &probe), &gone, &live()).await.expect("read"));
        assert_eq!(host.count("read"), 10, "the parts are bounded");
    }
}
