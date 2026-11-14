//! Owner: s4-engine-reply
//! How a command's outcome becomes the reply the agent reads (`reply.ts`). Actions produce facts; this module turns them into
//! text: it waits for nothing and calls no host method. The runner has already let the page settle, checked the postcondition and
//! captured the snapshot and the screenshot, and hands the results over; what is decided here is the words: the page report with
//! the downloads and diagnostics the caller has not heard about yet, what the gesture did or did not change, the postcondition
//! line, and the screenshot bound to the snapshot it was taken with.
//!
//! A JavaScript dialog that blocks the page pre-empts the whole reply (`dialog_text::blocking_dialog_reply`): the runner asks
//! before it waits for the page, so that is not decided here.

use std::collections::HashSet;
use std::fmt;

use bytes::Bytes;
use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotPayload;
use mixdog_app_protocol::v2::browser_engine::DownloadItem;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_browser_policy::timing::CommandTiming;
use serde_json::Value;

use crate::ledger::ingest::PageLedgers;
use crate::limits::EFFECT_REPORT_ACTIONS;
use crate::port::FilePort;
use crate::refs::grounding::VisualGrounding;
use crate::refs::ref_set::RefSet;

use super::dialog_text::DismissedNotice;
use super::downloads_text::DownloadReports;
use super::downloads_text::take_downloads;
use super::screenshot::ScreenshotInput;
use super::screenshot::attach_screenshot;
use super::snapshot_format::SnapshotDiagnostics;
use super::snapshot_format::SnapshotExtras;
use super::snapshot_format::format_page_report;
use super::snapshot_format::format_snapshot;

/// What a reply says about how the command ended (`BrowserCommandResult.outcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyOutcome {
    Completed,
    /// The action ran, but what it was checked against proves nothing about it.
    Inconclusive,
    /// The page refused to go on (a dialog blocks it, or a leave confirmation kept the page).
    Blocked,
}

impl ReplyOutcome {
    /// The word the result value carries.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Inconclusive => "inconclusive",
            Self::Blocked => "blocked",
        }
    }
}

/// A picture in the reply: decoded bytes, never base64 (the tool output carries bytes).
#[derive(Debug, Clone, PartialEq)]
pub struct ReplyImage {
    pub mime_type: String,
    pub bytes: Bytes,
}

/// What a command answers with (`BrowserCommandResult`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ToolReply {
    pub text: String,
    pub image: Option<ReplyImage>,
    pub outcome: Option<ReplyOutcome>,
    /// Set by the runner, which owns the command's clock.
    pub timing: Option<CommandTiming>,
    /// The screenshot the reply carries, as coordinate actions may be expressed in it; the runner keeps it with the page.
    pub grounding: Option<VisualGrounding>,
}

impl ToolReply {
    pub fn text(text: impl Into<String>) -> Self {
        Self { text: text.into(), ..Self::default() }
    }
}

/// A reply that could not be built: the message is what the agent reads as the command's failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyError {
    pub message: String,
}

impl ReplyError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

impl fmt::Display for ReplyError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.message)
    }
}

impl std::error::Error for ReplyError {}

/// What the page looked like before the gesture, for the "no observable change" judgement.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EffectBaseline {
    pub url: String,
    /// The observation revision of the page (`observation` of the snapshot result): per frame the document's identity, the viewport,
    /// the scroll position, the DOM-change counter and the scroller counters; `None` when the page could not be asked.
    pub observation: Option<String>,
}

impl EffectBaseline {
    /// The earlier observation as a baseline.
    pub fn of(set: &RefSet) -> Self {
        Self { url: set.url.clone(), observation: set.observation.clone() }
    }
}

/// What the runner's wait established before the snapshot was taken (`ReplyWait` plus the options the command carried).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReplyEffect {
    /// The command asked for an explicit settle and it took this long.
    pub settle_ms: Option<u64>,
    /// The postcondition the command expected, already described (`describeBrowserPostcondition`).
    pub expected: Option<String>,
    pub postcondition_matched: bool,
    pub postcondition_elapsed_ms: u64,
    /// The postcondition already held before the action, so it proves nothing about it.
    pub preexisting_postcondition: bool,
    /// The command is a gesture whose effect is judged against `baseline`.
    pub settle_action: bool,
    pub baseline: Option<EffectBaseline>,
}

/// The command a reply answers.
#[derive(Debug, Clone, Default)]
pub struct ReplyRequest<'a> {
    /// The normalised action name (`normalizeBrowserAction`); empty when none.
    pub action: &'a str,
    /// Report only what differs from `brief_against`.
    pub brief: bool,
    /// The observation a brief reply compares against: the caller's last report, else the gesture's baseline.
    pub brief_against: Option<&'a RefSet>,
    pub effect: ReplyEffect,
}

/// The page report's own state: what this page has already said (`GuestState` fields the reply keeps). Kept by the runner per page.
#[derive(Debug, Default)]
pub struct PageReplyState {
    /// The dialog the host dismissed unseen, and whether a reply already said so.
    pub dismissed: Option<DismissedNotice>,
    /// When the page last reported downloads (epoch milliseconds).
    pub downloads_reported_at: i64,
    /// Popups a reply already announced; only those the host still lists are remembered.
    announced_popups: HashSet<String>,
}

impl PageReplyState {
    /// The dismissed dialog of the facts: a new one (another `at`) is unreported, the one already held keeps its mark, none clears it.
    fn observe_facts(&mut self, facts: &PageFacts) {
        let Some(dialog) = &facts.dismissed_dialog else {
            self.dismissed = None;
            return;
        };
        let held = self.dismissed.as_ref().is_some_and(|notice| notice.at == dialog.at && notice.kind == dialog.kind && notice.message == dialog.message);
        if !held {
            self.dismissed = Some(DismissedNotice::from_facts(dialog));
        }
    }

    /// The popups the page opened that no reply announced yet, announced now.
    fn take_new_popups(&mut self, facts: &PageFacts) -> Vec<String> {
        let fresh: Vec<String> = facts.opened_popups.iter().filter(|id| !self.announced_popups.contains(*id)).cloned().collect();
        self.announced_popups.retain(|id| facts.opened_popups.contains(id));
        self.announced_popups.extend(fresh.iter().cloned());
        fresh
    }
}

/// What the reply reads of the page and the session around it.
pub struct ReplyPage<'a> {
    pub facts: &'a PageFacts,
    pub state: &'a mut PageReplyState,
    /// The owning session's download ledger, newest first.
    pub downloads: &'a [DownloadItem],
    pub download_reports: &'a mut DownloadReports,
    /// Epoch milliseconds now.
    pub now_ms: i64,
}

/// The snapshot a reply reports.
#[derive(Debug, Clone, Copy)]
pub struct SnapshotCapture<'a> {
    pub payload: &'a BrowserSnapshotPayload,
    /// The observation revision the capture stamped on the page's ref set.
    pub observation: Option<&'a str>,
}

/// What the reply needs from the engine around it.
pub struct ReplyContext<'a> {
    /// The page's redaction: the patterns of `redact_browser_text`, then the page's stored credentials (`state.redactText`).
    pub redact: &'a (dyn Fn(&str) -> String + Send + Sync),
    pub files: &'a dyn FilePort,
}

/// `JSON.stringify(text)`.
pub(crate) fn json_string(text: &str) -> String {
    let mut out = String::new();
    mixdog_js::json_quote(text, &mut out);
    out
}

/// The page report with the snapshot: the downloads this reply should mention are taken (marked reported) first.
fn report_snapshot(
    ctx: &ReplyContext<'_>,
    page: &mut ReplyPage<'_>,
    ledgers: &mut PageLedgers,
    payload: &BrowserSnapshotPayload,
    brief_against: Option<&RefSet>,
) -> String {
    let downloads = take_downloads(page.downloads, &mut page.state.downloads_reported_at, page.download_reports, page.now_ms);
    let mut diagnostics = SnapshotDiagnostics {
        pending_dialog: page.facts.pending_dialog.as_ref(),
        dismissed_dialog: page.state.dismissed.as_mut(),
        pending_file_chooser: page.facts.pending_file_chooser.as_ref(),
        ledgers,
    };
    (ctx.redact)(&format_snapshot(payload, &mut diagnostics, &SnapshotExtras { downloads: &downloads, brief_against }))
}

/// The same page report without a snapshot, for a reply that keeps the caller's refs: whatever is new since the last report, or
/// nothing (`reportPage`).
pub fn page_report_text(ctx: &ReplyContext<'_>, page: &mut ReplyPage<'_>, ledgers: &mut PageLedgers) -> String {
    page.state.observe_facts(page.facts);
    let downloads = take_downloads(page.downloads, &mut page.state.downloads_reported_at, page.download_reports, page.now_ms);
    let mut diagnostics = SnapshotDiagnostics {
        pending_dialog: page.facts.pending_dialog.as_ref(),
        dismissed_dialog: page.state.dismissed.as_mut(),
        pending_file_chooser: page.facts.pending_file_chooser.as_ref(),
        ledgers,
    };
    (ctx.redact)(&format_page_report(&mut diagnostics, &SnapshotExtras { downloads: &downloads, brief_against: None }))
}

/// A value an `evaluate` returned as text, redacted and cut to `max_chars` UTF-16 units (`formatEvaluationValue`). `None` is what
/// JavaScript calls `undefined`.
pub fn format_evaluation_value(ctx: &ReplyContext<'_>, value: Option<&Value>, max_chars: usize) -> String {
    let rendered = match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => mixdog_js::json_stringify_indent(other, 2),
    };
    let redacted = (ctx.redact)(&rendered);
    let length = mixdog_js::utf16_len(&redacted);
    if length <= max_chars {
        return redacted;
    }
    format!("{}\n[truncated: {} more characters]", mixdog_js::slice_utf16(&redacted, max_chars), length - max_chars)
}

/// Whether the documents behind two observation revisions differ (`browserDocumentChanged`): a new document, a different viewport,
/// a DOM mutation or a control's value, or, when asked, the scroll position (the page's, a nested scroller's, an explicit scroll).
/// Pointer and key activity alone does not count. A revision is one entry per frame, `|`-separated, each
/// `timeOrigin:version:innerWidth:innerHeight:scrollX:scrollY:dom[:scroller[:explicit]]`. `None` when a revision is missing or
/// predates the counter.
fn document_changed(before: Option<&str>, after: Option<&str>, include_scroll: bool) -> Option<bool> {
    let (before, after) = (before.filter(|text| !text.is_empty())?, after.filter(|text| !text.is_empty())?);
    let (left, right): (Vec<&str>, Vec<&str>) = (before.split('|').collect(), after.split('|').collect());
    if left.len() != right.len() {
        return Some(true);
    }
    for (earlier, later) in left.iter().zip(&right) {
        let (a, b): (Vec<&str>, Vec<&str>) = (earlier.split(':').collect(), later.split(':').collect());
        if a.len() < 7 || b.len() < 7 {
            return None;
        }
        if a[0] != b[0] || a[6] != b[6] || a[2] != b[2] || a[3] != b[3] {
            return Some(true);
        }
        if include_scroll && (a[4] != b[4] || a[5] != b[5]) {
            return Some(true);
        }
        if include_scroll && a.len() >= 8 && b.len() >= 8 && a[7] != b[7] {
            return Some(true);
        }
        if include_scroll && a.len() >= 9 && b.len() >= 9 && a[8] != b[8] {
            return Some(true);
        }
    }
    Some(false)
}

/// What the reply says besides the snapshot: waits that completed, pages that opened, and a gesture the page visibly ignored.
fn effect_notes(request: &ReplyRequest<'_>, page: &mut ReplyPage<'_>, capture: &SnapshotCapture<'_>, snapshot: &str) -> Vec<String> {
    let effect = &request.effect;
    let action = request.action;
    // A gesture the page ignored looks exactly like one that worked unless the reply says so; repeating it would not help, a
    // different target might. Scroll is judged by position, everything else by the document.
    let reacted = match &effect.baseline {
        Some(baseline) if effect.settle_action && EFFECT_REPORT_ACTIONS.contains(&action) => {
            document_changed(baseline.observation.as_deref(), capture.observation, action == "scroll")
        }
        _ => None,
    };
    // A gesture that opened a page did something, even when this document is untouched. Reporting that as "no observable change"
    // sends the caller looking for a covering element instead of the page that just opened.
    let opened = page.state.take_new_popups(page.facts);
    // A postcondition this action made true, or a download it started, is the page reacting. Calling that "no observable change"
    // would contradict the same reply and send the caller hunting for an overlay that is not there.
    let proven = effect.expected.is_some() && effect.postcondition_matched && !effect.preexisting_postcondition;
    let side_effect = !opened.is_empty() || snapshot.contains("Downloads since last report:");
    let same_address = effect.baseline.as_ref().is_some_and(|baseline| baseline.url == capture.payload.url);
    let unchanged = reacted == Some(false) && same_address && !side_effect && !proven;
    let mut notes = Vec::new();
    if let Some(settle_ms) = effect.settle_ms.filter(|ms| *ms != 0) {
        notes.push(format!("Explicit settle completed after {settle_ms}ms."));
    }
    if effect.expected.is_some() {
        if effect.preexisting_postcondition {
            notes.push(
                "Postcondition was already true before this action, so it proves nothing about it; the action executed once. \
                 Verify with a condition only this action makes true."
                    .to_owned(),
            );
        } else {
            notes.push(format!("Postcondition met after {}ms; action executed once.", effect.postcondition_elapsed_ms));
        }
    }
    if !opened.is_empty() {
        let names: Vec<String> = opened.iter().map(|name| json_string(name)).collect();
        notes.push(format!("Opened {} as a new page; act on it with that tab name, or call list_tabs for its URL.", names.join(", ")));
    }
    if unchanged {
        notes.push(format!(
            "No observable change: the document, URL, and control values are the same as before this {action}. \
             Do not repeat the same gesture; check the element's states or covering elements, or choose another target."
        ));
    }
    notes
}

/// The reply of a command that observed the page (`snapshotResult` after its wait): the page report, what the gesture did, and the
/// screenshot bound to the snapshot. Without a snapshot it is the page report alone (`reportPage`), which may be empty.
///
/// A postcondition that did not hold is an error that carries the snapshot, so the agent sees the page the action left behind.
pub async fn build_reply(
    ctx: &ReplyContext<'_>,
    request: &ReplyRequest<'_>,
    page: &mut ReplyPage<'_>,
    ledgers: &mut PageLedgers,
    snapshot: Option<SnapshotCapture<'_>>,
    screenshot: Option<ScreenshotInput<'_>>,
) -> Result<ToolReply, ReplyError> {
    let Some(capture) = snapshot else {
        let mut reply = ToolReply::text(page_report_text(ctx, page, ledgers));
        if let Some(input) = screenshot {
            attach_screenshot(ctx.files, &mut reply, input).await?;
        }
        return Ok(reply);
    };
    page.state.observe_facts(page.facts);
    // Deliberately NOT deduplicated against the previous snapshot. Identical page text is common precisely when a gesture
    // reproduces the same result ("Mouse dragged" twice), and that text is the only evidence the gesture landed. Trading it for
    // tokens would break the verify-after-dispatch contract, so repetition stays.
    let brief_against = if request.brief { request.brief_against } else { None };
    let report = report_snapshot(ctx, page, ledgers, capture.payload, brief_against);
    let effect = &request.effect;
    if let Some(expected) = &effect.expected
        && !effect.postcondition_matched
    {
        let action = if request.action.is_empty() { "browser" } else { request.action };
        return Err(ReplyError::new(format!(
            "Postcondition failed after {}ms; the {action} action executed once and was not retried. Expected {expected}.\n\n{report}",
            effect.postcondition_elapsed_ms
        )));
    }
    let notes = effect_notes(request, page, &capture, &report);
    let mut reply = ToolReply {
        text: if notes.is_empty() { report } else { format!("{}\n\n{report}", notes.join(" ")) },
        outcome: Some(if effect.expected.is_some() && effect.preexisting_postcondition { ReplyOutcome::Inconclusive } else { ReplyOutcome::Completed }),
        ..ToolReply::default()
    };
    if let Some(input) = screenshot {
        attach_screenshot(ctx.files, &mut reply, input).await?;
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::path::PathBuf;

    use async_trait::async_trait;
    use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotElement;
    use serde_json::json;

    use super::*;
    use crate::fake::page_facts;
    use crate::refs::ref_set::tests::element;
    use crate::refs::ref_set::tests::payload as snapshot_payload;
    use crate::types::FileFacts;

    struct NoFiles;

    #[async_trait]
    impl FilePort for NoFiles {
        async fn stat(&self, _path: &Path) -> FileFacts {
            FileFacts::default()
        }

        async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
            Ok(run_dir.to_path_buf())
        }
    }

    fn keep(text: &str) -> String {
        text.to_owned()
    }

    struct Fixture {
        facts: PageFacts,
        state: PageReplyState,
        reports: DownloadReports,
        ledgers: PageLedgers,
    }

    fn fixture() -> Fixture {
        Fixture {
            facts: facts(json!({})),
            state: PageReplyState::default(),
            reports: DownloadReports::default(),
            ledgers: PageLedgers::new(std::sync::Arc::new(|text: &str| text.to_owned())),
        }
    }

    fn facts(patch: serde_json::Value) -> PageFacts {
        let mut value = page_facts("p1", 1);
        if let (Some(target), Some(extra)) = (value.as_object_mut(), patch.as_object()) {
            target.extend(extra.clone());
        }
        serde_json::from_value(value).expect("facts")
    }

    fn payload(snapshot_id: &str, elements: Vec<BrowserSnapshotElement>) -> BrowserSnapshotPayload {
        let mut made = snapshot_payload(snapshot_id, elements, "https://fixture.example/app");
        made.title = "Fixture".into();
        made.viewport_width = 800.0;
        made.viewport_height = 600.0;
        made.text = "x".repeat(700);
        made
    }

    fn before() -> BrowserSnapshotPayload {
        let mut email = element("p1-s1-e2", "textbox", "Email");
        email.value = Some(String::new());
        payload("p1-s1", vec![element("p1-s1-e1", "button", "Save"), email])
    }

    fn same_as_before() -> BrowserSnapshotPayload {
        let mut again = before();
        again.snapshot_id = "p1-s2".into();
        for el in &mut again.elements {
            el.ref_id = el.ref_id.replace("s1", "s2");
        }
        again
    }

    /// The observation of one frame whose DOM-change counter is `dom`, scrolled to `scroll_y`, its nested scrollers at `scroller`.
    fn observed(dom: u32, scroll_y: u32, scroller: u32) -> String {
        format!("1700000000000.5:{}:1280:720:0:{scroll_y}:{dom}:{scroller}", dom + 3)
    }

    fn baseline(dom: u32) -> EffectBaseline {
        EffectBaseline { url: "https://fixture.example/app".into(), observation: Some(observed(dom, 0, 0)) }
    }

    fn gesture(action: &str, dom: u32) -> ReplyRequest<'_> {
        ReplyRequest {
            action,
            effect: ReplyEffect { settle_action: true, baseline: Some(baseline(dom)), ..ReplyEffect::default() },
            ..ReplyRequest::default()
        }
    }

    async fn run_observing(f: &mut Fixture, request: &ReplyRequest<'_>, payload: &BrowserSnapshotPayload, observation: &str) -> Result<ToolReply, ReplyError> {
        let files = NoFiles;
        let ctx = ReplyContext { redact: &keep, files: &files };
        let mut page = ReplyPage { facts: &f.facts, state: &mut f.state, downloads: &[], download_reports: &mut f.reports, now_ms: 0 };
        build_reply(&ctx, request, &mut page, &mut f.ledgers, Some(SnapshotCapture { payload, observation: Some(observation) }), None).await
    }

    async fn run(f: &mut Fixture, request: &ReplyRequest<'_>, payload: &BrowserSnapshotPayload, dom: u32) -> Result<ToolReply, ReplyError> {
        run_observing(f, request, payload, &observed(dom, 0, 0)).await
    }

    #[tokio::test]
    async fn a_gesture_that_opened_a_page_says_so_instead_of_claiming_the_page_ignored_it() {
        let mut f = fixture();
        // A target="_blank" click leaves this document exactly as it was.
        f.facts = facts(json!({"openedPopups": ["popup-1"]}));
        let reply = run(&mut f, &gesture("click", 4), &same_as_before(), 4).await.unwrap();
        assert!(reply.text.contains("Opened \"popup-1\" as a new page; act on it with that tab name, or call list_tabs for its URL."), "{}", reply.text);
        assert!(!reply.text.contains("No observable change"));
        let next = run(&mut f, &gesture("click", 4), &same_as_before(), 4).await.unwrap();
        assert!(!next.text.contains("Opened"), "a page is announced once, not on every reply");
        assert!(next.text.starts_with("No observable change"), "{}", next.text);
    }

    #[tokio::test]
    async fn a_gesture_the_page_ignored_is_reported_as_no_observable_change_and_scroll_is_judged_by_position() {
        let mut f = fixture();
        let ignored = run(&mut f, &gesture("click", 4), &same_as_before(), 4).await.unwrap();
        assert!(
            ignored.text.starts_with("No observable change: the document, URL, and control values are the same as before this click"),
            "{}",
            ignored.text
        );
        assert_eq!(ignored.outcome, Some(ReplyOutcome::Completed));
        let reacted = run(&mut f, &gesture("click", 4), &same_as_before(), 5).await.unwrap();
        assert!(!reacted.text.contains("No observable change"));
        let scrolled = run_observing(&mut f, &gesture("scroll", 4), &same_as_before(), &observed(4, 400, 0)).await.unwrap();
        assert!(!scrolled.text.contains("No observable change"));
        // A nested scroller moved while the window stayed at the top: the page reacted.
        let nested = run_observing(&mut f, &gesture("scroll", 4), &same_as_before(), &observed(4, 0, 2)).await.unwrap();
        assert!(!nested.text.contains("No observable change"), "{}", nested.text);
        assert!(run(&mut f, &gesture("scroll", 4), &same_as_before(), 4).await.unwrap().text.starts_with("No observable change"));
        // A reload to an identical DOM is a new document, and the viewport is part of what was seen.
        let reloaded = observed(4, 0, 0).replacen("1700000000000.5", "1700000009999.5", 1);
        assert!(!run_observing(&mut f, &gesture("click", 4), &same_as_before(), &reloaded).await.unwrap().text.contains("No observable change"));
        let resized = observed(4, 0, 0).replacen(":1280:720:", ":800:600:", 1);
        assert!(!run_observing(&mut f, &gesture("click", 4), &same_as_before(), &resized).await.unwrap().text.contains("No observable change"));
        let observed = ReplyRequest {
            action: "snapshot",
            effect: ReplyEffect { settle_action: false, baseline: Some(baseline(4)), ..ReplyEffect::default() },
            ..ReplyRequest::default()
        };
        assert!(!run(&mut f, &observed, &same_as_before(), 4).await.unwrap().text.contains("No observable change"), "an observation is not a gesture");
        assert!(
            !run(&mut f, &gesture("hover", 4), &same_as_before(), 4).await.unwrap().text.contains("No observable change"),
            "only the gestures that report an effect"
        );
    }

    #[tokio::test]
    async fn an_unknown_revision_or_a_changed_address_claims_no_lack_of_change() {
        let mut f = fixture();
        let judged = |url: &str, observation: Option<String>| ReplyRequest {
            action: "click",
            effect: ReplyEffect { settle_action: true, baseline: Some(EffectBaseline { url: url.into(), observation }), ..ReplyEffect::default() },
            ..ReplyRequest::default()
        };
        let unknown = judged("https://fixture.example/app", None);
        assert!(!run(&mut f, &unknown, &same_as_before(), 0).await.unwrap().text.contains("No observable change"));
        let old_counter = judged("https://fixture.example/app", Some("1:2:3".into()));
        assert!(!run(&mut f, &old_counter, &same_as_before(), 4).await.unwrap().text.contains("No observable change"), "a revision without the counters proves nothing");
        let moved = judged("https://other.example/", Some(observed(4, 0, 0)));
        assert!(!run(&mut f, &moved, &same_as_before(), 4).await.unwrap().text.contains("No observable change"), "a changed URL is a change");
    }

    #[tokio::test]
    async fn brief_replies_list_only_new_or_changed_elements_and_trim_the_text() {
        let mut after = payload(
            "p1-s2",
            vec![element("p1-s2-e1", "button", "Save"), element("p1-s2-e2", "textbox", "Email"), element("p1-s2-e3", "link", "Continue")],
        );
        after.elements[1].value = Some("ada@example.test".into());
        after.elements[2].href = Some("https://fixture.example/next".into());
        let earlier = RefSet::from_payload("p1-s1", &before());
        let mut f = fixture();
        let brief = ReplyRequest { brief: true, brief_against: Some(&earlier), ..gesture("fill", 6) };
        let reply = run(&mut f, &brief, &after, 6).await.unwrap();
        let text = &reply.text;
        assert!(text.contains("Brief reply: 2 changed or new element(s); 1 unchanged omitted"), "{text}");
        assert!(text.contains("[p1-s2-e2] textbox \"Email\" value=\"ada@example.test\""));
        assert!(text.contains("[p1-s2-e3] link \"Continue\""));
        assert!(!text.contains("[p1-s2-e1]"));
        assert!(!text.contains("no longer matched"));
        assert!(text.contains("use a known target directly"));
        assert!(text.contains("Visible text (first 500 of 700 chars"));
        let full = run(&mut f, &gesture("fill", 6), &after, 6).await.unwrap();
        assert!(full.text.contains("[p1-s2-e1] button \"Save\""));
        // The brief flag is what asks for it: a baseline alone changes nothing.
        let not_asked = ReplyRequest { brief: false, brief_against: Some(&earlier), ..gesture("fill", 6) };
        assert!(run(&mut f, &not_asked, &after, 6).await.unwrap().text.contains("[p1-s2-e1] button \"Save\""));
    }

    #[tokio::test]
    async fn an_already_true_postcondition_is_a_warning_with_an_inconclusive_outcome() {
        let mut f = fixture();
        let request = ReplyRequest {
            action: "click",
            effect: ReplyEffect {
                settle_action: true,
                expected: Some("text \"x\"".into()),
                postcondition_matched: true,
                preexisting_postcondition: true,
                ..ReplyEffect::default()
            },
            ..ReplyRequest::default()
        };
        let reply = run(&mut f, &request, &payload("p1-s2", vec![]), 9).await.unwrap();
        assert_eq!(reply.outcome, Some(ReplyOutcome::Inconclusive));
        assert!(
            reply
                .text
                .starts_with("Postcondition was already true before this action, so it proves nothing about it; the action executed once. Verify with a condition only this action makes true."),
            "{}",
            reply.text
        );
    }

    #[tokio::test]
    async fn the_waits_that_completed_are_said_before_the_page_report_in_one_paragraph() {
        let mut f = fixture();
        let request = ReplyRequest {
            action: "click",
            effect: ReplyEffect {
                settle_ms: Some(30),
                expected: Some("text \"Done\"".into()),
                postcondition_matched: true,
                postcondition_elapsed_ms: 120,
                ..ReplyEffect::default()
            },
            ..ReplyRequest::default()
        };
        let reply = run(&mut f, &request, &payload("p1-s2", vec![]), 9).await.unwrap();
        assert!(
            reply.text.starts_with("Explicit settle completed after 30ms. Postcondition met after 120ms; action executed once.\n\nUNTRUSTED PAGE CONTENT"),
            "{}",
            reply.text
        );
        assert_eq!(reply.outcome, Some(ReplyOutcome::Completed));
        let plain = run(&mut f, &ReplyRequest::default(), &payload("p1-s2", vec![]), 9).await.unwrap();
        assert!(plain.text.starts_with("UNTRUSTED PAGE CONTENT"));
    }

    fn after_a_focus() -> BrowserSnapshotPayload {
        let mut after = payload("p1-s3", vec![element("p1-s3-e1", "button", "Save"), element("p1-s3-e2", "textbox", "Email")]);
        after.elements[0].states = Some(vec!["focused".into()]);
        after.elements[1].value = Some(String::new());
        after
    }

    #[tokio::test]
    async fn a_postcondition_that_did_not_hold_fails_with_the_page_the_action_left_behind() {
        let earlier = RefSet::from_payload("p1-s1", &before());
        let request = ReplyRequest {
            brief: true,
            brief_against: Some(&earlier),
            effect: ReplyEffect {
                settle_action: true,
                baseline: Some(baseline(6)),
                expected: Some("text \"missing\"".into()),
                postcondition_matched: false,
                postcondition_elapsed_ms: 500,
                ..ReplyEffect::default()
            },
            action: "click",
        };
        let mut f = fixture();
        let failed = run(&mut f, &request, &after_a_focus(), 6).await.unwrap_err();
        assert!(
            failed.message.starts_with(
                "Postcondition failed after 500ms; the click action executed once and was not retried. Expected text \"missing\".\n\nUNTRUSTED PAGE CONTENT"
            ),
            "{}",
            failed.message
        );
        assert!(failed.message.contains("1 changed or new element(s); 1 unchanged omitted"));
        let unnamed = ReplyRequest { action: "", ..request };
        assert!(run(&mut f, &unnamed, &after_a_focus(), 6).await.unwrap_err().message.starts_with("Postcondition failed after 500ms; the browser action"));
    }

    #[tokio::test]
    async fn the_effect_is_judged_against_the_gestures_baseline_while_the_brief_compares_the_last_report() {
        let earlier = RefSet::from_payload("p1-s1", &before());
        let targeted = RefSet::from_payload("p1-s2", &payload("p1-s2", vec![element("p1-s2-e1", "button", "Save")]))
            .with_document("d1", 6)
            .with_observation(Some(&observed(6, 0, 0)));
        let request = ReplyRequest {
            brief: true,
            brief_against: Some(&earlier),
            effect: ReplyEffect { settle_action: true, baseline: Some(EffectBaseline::of(&targeted)), ..ReplyEffect::default() },
            action: "click",
        };
        let mut f = fixture();
        let reply = run(&mut f, &request, &after_a_focus(), 6).await.unwrap();
        assert!(reply.text.contains("1 changed or new element(s); 1 unchanged omitted"), "{}", reply.text);
        assert!(reply.text.starts_with("No observable change"), "{}", reply.text);
        assert!(!reply.text.contains("[p1-s3-e2]"));
    }

    #[tokio::test]
    async fn the_page_report_alone_says_what_is_new_and_a_download_is_said_once_for_the_session() {
        let item = |state: &str, completed: Option<i64>| -> DownloadItem {
            serde_json::from_value(json!({
                "id": "d1", "file": "Images.txt", "path": "C:/tmp/Images.txt", "url": "https://a.test/f", "mimeType": "text/plain",
                "state": state, "received": 10, "total": 2048, "startedAt": 60_000, "completedAt": completed
            }))
            .unwrap()
        };
        let files = NoFiles;
        let ctx = ReplyContext { redact: &keep, files: &files };
        let facts = facts(json!({}));
        let (mut first, mut second) = (PageReplyState::default(), PageReplyState::default());
        let (mut first_ledgers, mut second_ledgers) = (fixture().ledgers, fixture().ledgers);
        let mut reports = DownloadReports::default();
        let running = [item("in_progress", None)];
        let mut say = |state: &mut PageReplyState, ledgers: &mut PageLedgers, downloads: &[DownloadItem], now_ms: i64| {
            let mut page = ReplyPage { facts: &facts, state, downloads, download_reports: &mut reports, now_ms };
            page_report_text(&ctx, &mut page, ledgers)
        };
        assert_eq!(say(&mut first, &mut first_ledgers, &running, 1), "Downloads since last report:\n- [d1] Images.txt — in_progress, 2 KB → C:/tmp/Images.txt");
        assert_eq!(say(&mut second, &mut second_ledgers, &running, 1), "", "the other page already heard this state");
        assert_eq!(say(&mut first, &mut first_ledgers, &running, 2), "");
        let finished = [item("completed", Some(60_000))];
        assert!(say(&mut second, &mut second_ledgers, &finished, 2).contains("[d1] Images.txt — completed"));
        assert_eq!(say(&mut first, &mut first_ledgers, &finished, 3), "", "a state change is also said once");
    }

    #[tokio::test]
    async fn a_download_a_gesture_started_is_the_page_reacting() {
        let started: DownloadItem = serde_json::from_value(json!({
            "id": "d1", "file": "a.csv", "path": "C:/a.csv", "url": "https://a.test/f", "mimeType": "text/csv",
            "state": "in_progress", "received": 1, "total": 2, "startedAt": 5
        }))
        .unwrap();
        let files = NoFiles;
        let ctx = ReplyContext { redact: &keep, files: &files };
        let mut f = fixture();
        let downloads = [started];
        let mut page = ReplyPage { facts: &f.facts, state: &mut f.state, downloads: &downloads, download_reports: &mut f.reports, now_ms: 10 };
        let capture = same_as_before();
        let observation = observed(4, 0, 0);
        let snapshot = Some(SnapshotCapture { payload: &capture, observation: Some(&observation) });
        let reply = build_reply(&ctx, &gesture("click", 4), &mut page, &mut f.ledgers, snapshot, None).await.unwrap();
        assert!(reply.text.contains("Downloads since last report:"));
        assert!(!reply.text.contains("No observable change"));
    }

    #[test]
    fn the_reply_text_goes_through_the_pages_redaction() {
        let files = NoFiles;
        let hide = |text: &str| text.replace("secret-word", "[REDACTED STORED CREDENTIAL]");
        let ctx = ReplyContext { redact: &hide, files: &files };
        let mut f = fixture();
        f.ledgers.console.record_error("failed with secret-word");
        let mut page = ReplyPage { facts: &f.facts, state: &mut f.state, downloads: &[], download_reports: &mut f.reports, now_ms: 0 };
        let report = page_report_text(&ctx, &mut page, &mut f.ledgers);
        assert_eq!(report, "New console errors: failed with [REDACTED STORED CREDENTIAL]");
    }

    #[test]
    fn an_evaluated_value_is_rendered_redacted_and_cut_with_the_count_of_what_was_left() {
        let files = NoFiles;
        let ctx = ReplyContext { redact: &keep, files: &files };
        assert_eq!(format_evaluation_value(&ctx, None, 100), "undefined");
        assert_eq!(format_evaluation_value(&ctx, Some(&json!("plain")), 100), "plain");
        assert_eq!(format_evaluation_value(&ctx, Some(&json!({"a": [1, 2]})), 100), "{\n  \"a\": [\n    1,\n    2\n  ]\n}");
        assert_eq!(format_evaluation_value(&ctx, Some(&json!(null)), 100), "null");
        assert_eq!(format_evaluation_value(&ctx, Some(&json!("abcdef")), 4), "abcd\n[truncated: 2 more characters]");
        assert_eq!(format_evaluation_value(&ctx, Some(&json!("abcd")), 4), "abcd");
        assert_eq!(ReplyOutcome::Blocked.as_str(), "blocked");
        assert_eq!(ReplyOutcome::Inconclusive.as_str(), "inconclusive");
        assert_eq!(ReplyOutcome::Completed.as_str(), "completed");
    }
}
