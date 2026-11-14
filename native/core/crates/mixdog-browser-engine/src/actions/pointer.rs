//! Owner: s4-engine-actions-pointer
//! Gestures aimed at a point: click, hover, drag, scroll and key presses (`actions/pointer.ts`). A point comes from a snapshot ref
//! (with stale-ref recovery before anything is dispatched) or from image-pixel coordinates bound to the latest visual snapshot.
//!
//! The gesture itself is one `host/browser/input/batch` request carrying the page's precondition; the press of a click on a ref also
//! carries a hit guard naming the element, which the host checks as the press lands. The engine never replays a gesture: only the
//! read-only preflights (resolving a target, probing a ref's point, preparing a ref) run under recovery.

use mixdog_app_protocol::v2::browser_engine::BrowserInputOutcome;
use mixdog_app_protocol::v2::browser_engine::BrowserInputTiming;
use mixdog_app_protocol::v2::browser_engine::BrowserPointerButton;
use mixdog_app_protocol::v2::browser_engine::BrowserPointerKind;
use mixdog_app_protocol::v2::browser_engine::BrowserPointerStep;
use mixdog_app_protocol::v2::browser_engine::BrowserPressStep;
use mixdog_app_protocol::v2::browser_engine::FrameRef;
use mixdog_app_protocol::v2::browser_engine::HostBrowserInputBatchParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageEvalParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserSnapshotResult;
use mixdog_app_protocol::v2::browser_engine::InputStep;
use mixdog_browser_policy::redaction::redact_browser_text;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_rt::CancelView;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::HostCallError;
use crate::limits::CDP_REQUEST_TIMEOUT;
use crate::limits::COMMAND_TIMEOUT;
use crate::limits::OFFSCREEN_VIEWPORT;
use crate::port::BrowserHost;
use crate::refs::access::ActionabilityReason;
use crate::refs::access::RefError;
use crate::refs::access::RefTarget;
use crate::refs::access::call_ref;
use crate::refs::points::ref_point;
use crate::refs::points::with_covered_guidance;
use crate::refs::probes::Point;
use crate::refs::reply_recovery::with_ref_recovery;
use crate::reply::reply::json_string;
use crate::settle::actionability::ACTIONABILITY_TIMEOUT;
use crate::settle::actionability::ActionabilityError;
use crate::settle::actionability::ActionableError;
use crate::settle::actionability::ProbeFailure;
use crate::settle::actionability::wait_for_actionable;
use crate::settle::settle::cancelled;

use super::ref_mutation::mutate_ref;
use super::target::ActionContext;
use super::target::ActionError;
use super::target::ActionOutput;
use super::target::ActionPage;
use super::target::action_ref;
use super::target::drag_refs;
use super::target::expect_for;
use super::target::finite_number;
use super::target::hit_guard;
use super::target::snapshot_of_ref;
use super::target::text_of;
use super::target::truthy;
use super::target::visual_point;

/// The page-world sources of scroll-to-text (`assets/page/scroll-text.js`): the match pass and the apply pass, each started by a
/// `//@@ <name>` line, and the document-roots function both call.
const SCROLL_TEXT: &str = include_str!("../../assets/page/scroll-text.js");
const DOCUMENT_ROOTS: &str = include_str!("../../assets/page/document-roots.js");
const MATCH_MARKER: &str = "//@@ browserScrollTextMatchExpression\n";
const APPLY_MARKER: &str = "\n//@@ browserScrollTextApplyExpression\n";
/// Frames a complete observation may cover (the top document and its child frames).
const MAX_FRAME_TARGETS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pointer {
    Mouse,
    Touch,
}

/// `pointerKind`: `mouse` (the default) or `touch`.
fn pointer_kind(cx: &ActionContext<'_>, action: &str) -> Result<Pointer, ActionError> {
    let pointer = match cx.field("pointer") {
        Some(value) if truthy(Some(value)) => js_to_lowercase(js_trim(&value_to_string(value))),
        _ => "mouse".to_string(),
    };
    match pointer.as_str() {
        "mouse" => Ok(Pointer::Mouse),
        "touch" => Ok(Pointer::Touch),
        _ => Err(ActionError::Failed(format!("{action} pointer must be mouse or touch"))),
    }
}

/// `normalizeMouseButton`: `left` (the default), `right` or `middle`.
fn mouse_button(value: Option<&Value>) -> Result<BrowserPointerButton, ActionError> {
    let button = if truthy(value) { js_to_lowercase(js_trim(&text_of(value))) } else { "left".to_string() };
    match button.as_str() {
        "left" => Ok(BrowserPointerButton::Left),
        "right" => Ok(BrowserPointerButton::Right),
        "middle" => Ok(BrowserPointerButton::Middle),
        _ => Err(ActionError::Failed("click button must be left, right, or middle".to_string())),
    }
}

/// `normalizeModifierMask`: the modifier names a click holds, checked here so a wrong one is refused before anything is dispatched
/// (the host turns the names into its mask). `None` when the caller sent none.
fn modifier_names(value: Option<&Value>) -> Result<Option<Vec<String>>, ActionError> {
    let Some(value) = value else { return Ok(None) };
    let Some(list) = value.as_array() else { return Err(ActionError::Failed("click modifiers must be an array".to_string())) };
    let mut names = Vec::with_capacity(list.len());
    for raw in list {
        let name = js_to_lowercase(js_trim(&text_of(Some(raw))));
        match name.as_str() {
            "alt" | "control" | "ctrl" | "meta" | "command" | "cmd" | "shift" => names.push(name),
            _ => return Err(ActionError::Failed(format!("unsupported click modifier \"{}\"", value_to_string(raw)))),
        }
    }
    Ok(Some(names))
}

fn pointer_step(kind: BrowserPointerKind, at: Point) -> BrowserPointerStep {
    BrowserPointerStep { kind, x: at.x, y: at.y, button: None, modifiers: None, delta_x: None, delta_y: None, to_x: None, to_y: None, hit_guard: None }
}

/// One `host/browser/input/batch`: the steps run in order against the page as the engine decided them. A dialog the gesture opened is
/// not a failure (the reply reports it); the person at the page, a cancel and a press that missed its element are.
async fn send_input(cx: &ActionContext<'_>, steps: Vec<InputStep>, ref_id: Option<&str>) -> Result<BrowserInputTiming, ActionError> {
    let expect = expect_for(cx.page, ref_id);
    let params = HostBrowserInputBatchParams {
        page_id: cx.page.facts().page_id,
        steps,
        stop_on_dialog: true,
        timeout_ms: u32::try_from(COMMAND_TIMEOUT.as_millis()).unwrap_or(u32::MAX),
        expect: expect.clone(),
    };
    let result = cx.host.input_batch(params, cx.token()).await?;
    match result.outcome {
        BrowserInputOutcome::Completed | BrowserInputOutcome::Dialog => Ok(result.timing),
        BrowserInputOutcome::Cancelled => Err(ActionError::Cancelled(cancelled(cx.cancel))),
        BrowserInputOutcome::UserInput => Err(ActionError::Host(HostCallError::UserInput { until: None })),
        // Navigation destroys the old document's guard: the caller reports the resulting page, a successful navigation is not a miss.
        BrowserInputOutcome::HitGuard => {
            let navigated = result.facts.loading || expect.url.as_deref().is_some_and(|url| url != result.facts.url);
            if navigated {
                Ok(result.timing)
            } else {
                Err(ActionError::Failed("input target changed or could not be verified; input was not replayed, observe before continuing".to_string()))
            }
        }
    }
}

/// One attempt at the point of a ref, waiting out a blocker that clears (a covered, moving or disabled element). A blocker that does
/// not clear while the wait lasts says so with a fresh snapshot, so it can be dismissed by ref.
async fn ref_point_waiting(host: &dyn BrowserHost, page: &dyn ActionPage, cancel: &CancelView, ref_id: String) -> Result<Point, HostCallError> {
    let page_id = page.facts().page_id;
    let expect = expect_for(page, Some(&ref_id));
    let target = RefTarget { page_id: &page_id, snapshot_id: snapshot_of_ref(&ref_id), ref_id: &ref_id, expect: Some(&expect) };
    let target_ref = &target;
    let waited = wait_for_actionable(
        move || async move {
            ref_point(host, target_ref, cancel.token()).await.map_err(|error| match error.reason() {
                Some(reason) => ProbeFailure::NotActionable(ActionabilityError::new(error.to_string(), reason.as_str())),
                None => ProbeFailure::Other(error),
            })
        },
        cancel,
        ACTIONABILITY_TIMEOUT,
    )
    .await;
    let error = match waited {
        Ok(point) => return Ok(point),
        Err(ActionableError::Cancelled(_)) => return Err(HostCallError::Cancelled),
        Err(ActionableError::Failed(error)) => error,
        Err(ActionableError::NotActionable(blocker)) if blocker.reason == ActionabilityReason::Covered.as_str() => {
            RefError::Refused { reason: ActionabilityReason::Covered, message: blocker.message }
        }
        Err(ActionableError::NotActionable(blocker)) => RefError::Failed(blocker.message),
    };
    // Capturing guidance only after the wait expired matters: capturing during each probe would retire the ref being waited on.
    let format = |snapshot: &HostBrowserSnapshotResult| page.format_snapshot(snapshot);
    match with_covered_guidance(host, &page_id, error, &format, cancel.token()).await {
        RefError::Host(error) => Err(error),
        other => Err(HostCallError::Failed { message: other.to_string() }),
    }
}

/// A ref resolved to its point under stale-ref recovery: a stale ref is found again once, before anything is dispatched.
async fn recovered_point(cx: &mut ActionContext<'_>, source_ref: &str) -> Result<Point, ActionError> {
    let (host, page, cancel) = (cx.host, cx.page, cx.cancel);
    let point = with_ref_recovery(page.recovery_host(), cx.recovery, source_ref, |candidate| ref_point_waiting(host, page, cancel, candidate)).await?;
    Ok(point)
}

/// A ref (recovering a stale one once) or a coordinate target read off the latest visual snapshot.
async fn target_point(cx: &mut ActionContext<'_>, ref_id: Option<&str>, x_key: &str, y_key: &str, label: &str) -> Result<Point, ActionError> {
    match ref_id {
        Some(ref_id) => recovered_point(cx, ref_id).await,
        None => visual_point(cx, cx.field(x_key), cx.field(y_key), label).await,
    }
}

/// What the reply of a gesture on a ref adds: the targets resolved and the refs swapped.
fn finished(semantic: bool, input: BrowserInputTiming) -> ActionOutput {
    ActionOutput { decorate_recovery: semantic, input: vec![input], ..ActionOutput::default() }
}

/// `click`: a mouse click (button, modifiers, double) or a touch tap at a ref's point or a screenshot coordinate. A click on a ref
/// carries a hit guard: the host refuses a press that does not land on that element.
pub async fn click(cx: &mut ActionContext<'_>) -> Result<ActionOutput, ActionError> {
    let pointer = pointer_kind(cx, "click")?;
    let ref_id = action_ref(cx).await?;
    let semantic = ref_id.is_some();
    let point = target_point(cx, ref_id.as_deref(), "x", "y", "click").await?;
    let button = mouse_button(cx.field("button"))?;
    let modifiers = modifier_names(cx.field("modifiers"))?;
    let effective = ref_id.as_deref().map(|source| cx.recovery.effective_ref(source).to_string());
    cx.page.invalidate_interaction();
    let touch = pointer == Pointer::Touch;
    if touch && (truthy(cx.field("doubleClick")) || cx.field("button").is_some() || modifiers.is_some()) {
        return Err(ActionError::Failed("click pointer=touch does not accept button, modifiers, or doubleClick".to_string()));
    }
    let mut step = if touch {
        pointer_step(BrowserPointerKind::Tap, point)
    } else {
        let mut press = pointer_step(if truthy(cx.field("doubleClick")) { BrowserPointerKind::Dblclick } else { BrowserPointerKind::Click }, point);
        press.button = Some(button);
        press.modifiers = modifiers;
        press
    };
    step.hit_guard = effective.as_deref().map(hit_guard);
    let timing = send_input(cx, vec![InputStep::Pointer(step)], effective.as_deref()).await?;
    Ok(finished(semantic, timing))
}

/// `hover`: moves the pointer onto a ref's point or a screenshot coordinate.
pub async fn hover(cx: &mut ActionContext<'_>) -> Result<ActionOutput, ActionError> {
    let ref_id = action_ref(cx).await?;
    let semantic = ref_id.is_some();
    let point = target_point(cx, ref_id.as_deref(), "x", "y", "hover").await?;
    let effective = ref_id.as_deref().map(|source| cx.recovery.effective_ref(source).to_string());
    cx.page.invalidate_interaction();
    let timing = send_input(cx, vec![InputStep::Pointer(pointer_step(BrowserPointerKind::Hover, point))], effective.as_deref()).await?;
    Ok(finished(semantic, timing))
}

/// `drag`: from one point to another, by mouse or by touch (a swipe). Both ends take a snapshot-free target, as every other pointer
/// action does: a draggable element with no accessible name carries no ref, so requiring one meant grounding coordinates just to move it.
pub async fn drag(cx: &mut ActionContext<'_>) -> Result<ActionOutput, ActionError> {
    let pointer = pointer_kind(cx, "drag")?;
    let (source_ref, destination_ref) = drag_refs(cx).await?;
    let semantic = source_ref.is_some();
    let source = target_point(cx, source_ref.as_deref(), "x", "y", "drag").await?;
    let destination = match (&source_ref, &destination_ref) {
        (Some(_), Some(destination)) => recovered_point(cx, destination).await?,
        (Some(_), None) => return Err(ActionError::Failed("drag with a ref or target needs a destination: targetRef, or dropTarget".to_string())),
        (None, _) => target_point(cx, None, "targetX", "targetY", "drag target").await?,
    };
    cx.page.invalidate_interaction();
    let mut step = pointer_step(if pointer == Pointer::Touch { BrowserPointerKind::Swipe } else { BrowserPointerKind::DragTo }, source);
    step.to_x = Some(destination.x);
    step.to_y = Some(destination.y);
    let timing = send_input(cx, vec![InputStep::Pointer(step)], None).await?;
    Ok(finished(semantic, timing))
}

/// `press`: a key or a chord (`Enter`, `Control+A`); which keys exist, and which the clipboard rules refuse, is the host's.
pub async fn press(cx: &mut ActionContext<'_>) -> Result<ActionOutput, ActionError> {
    cx.page.invalidate_interaction();
    let step = InputStep::Press(BrowserPressStep { key: text_of(cx.field("key")), modifiers: None, repeat: None });
    let timing = send_input(cx, vec![step], None).await?;
    Ok(finished(false, timing))
}

/// The match pass of scroll-to-text on every frame: what a frame reports of the phrase.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ScrollTextMatch {
    token: String,
    found: bool,
    text: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ScrollTextApplied {
    scrolled: bool,
}

fn scroll_text_sources() -> (&'static str, &'static str) {
    let body = SCROLL_TEXT.strip_prefix(MATCH_MARKER).unwrap_or(SCROLL_TEXT);
    let (matching, applying) = body.split_once(APPLY_MARKER).unwrap_or((body, ""));
    (matching, applying.strip_suffix('\n').unwrap_or(applying))
}

/// `browserScrollTextMatchExpression`: marks the first rendered line holding the phrase (case-insensitively) in every root of a frame.
fn scroll_text_match_expression(wanted: &str) -> String {
    scroll_text_sources().0.replace("__MIXDOG_DOCUMENT_ROOTS__", DOCUMENT_ROOTS).replace("__MIXDOG_WANTED__", &json_string(&js_to_lowercase(wanted)))
}

/// `browserScrollTextApplyExpression`: scrolls the line the frame marked under `token`, if it is still there.
fn scroll_text_apply_expression(token: &str) -> String {
    scroll_text_sources().1.replace("__MIXDOG_TOKEN__", &json_string(token))
}

/// An expression run in the top document and in every child frame of the page, in that order.
async fn collect_frames<T: DeserializeOwned>(cx: &ActionContext<'_>, expression: &str) -> Result<Vec<T>, ActionError> {
    let facts = cx.page.facts();
    let mut frames: Vec<Option<FrameRef>> = vec![None];
    frames.extend(facts.child_sessions.iter().map(|child| Some(FrameRef { session_id: Some(child.session_id.clone()), frame_id: Some(child.frame_id.clone()) })));
    if frames.len() > MAX_FRAME_TARGETS {
        return Err(ActionError::Failed("too many frame targets for a complete observation".to_string()));
    }
    let mut out = Vec::with_capacity(frames.len());
    for frame in frames {
        let params = HostBrowserPageEvalParams {
            page_id: facts.page_id.clone(),
            expression: expression.to_string(),
            frame,
            await_promise: None,
            return_by_value: Some(true),
            world: None,
            timeout_ms: u32::try_from(CDP_REQUEST_TIMEOUT.as_millis()).unwrap_or(u32::MAX),
            expect: Some(cx.page.precondition()),
        };
        let answer = cx.host.page_eval(params, cx.token()).await?;
        if let Some(exception) = answer.exception {
            return Err(ActionError::Failed(exception.text));
        }
        out.push(serde_json::from_value(answer.value.unwrap_or(Value::Null)).map_err(|_| ActionError::Failed("a frame did not answer the observation".to_string()))?);
    }
    Ok(out)
}

/// Two passes over every frame: each one reports whether it holds the phrase, then only the frame the host picked scrolls. One phrase
/// on two frames must not make both of them jump. Returns the matched line, `None` when nothing scrolled.
async fn scroll_text_into_view(cx: &ActionContext<'_>, wanted: &str) -> Result<Option<String>, ActionError> {
    let matches: Vec<ScrollTextMatch> = collect_frames(cx, &scroll_text_match_expression(wanted)).await?;
    let Some(matched) = matches.into_iter().find(|entry| entry.found) else { return Ok(None) };
    let applied: Vec<ScrollTextApplied> = collect_frames(cx, &scroll_text_apply_expression(&matched.token)).await?;
    // The matched line, or empty when the frame did not say which line it was.
    Ok(applied.iter().any(|entry| entry.scrolled).then(|| matched.text.unwrap_or_default()))
}

/// Scrolls the nearest scrollable ancestor of the element the ref names (the function runs with the element as `this`).
fn scroll_within_ref_declaration(dx: i64, dy: Option<i64>) -> String {
    let wants_y = dy.is_none_or(|dy| dy != 0);
    let top = dy.map_or_else(|| "Math.round(scroller.clientHeight * 0.8)".to_string(), |dy| dy.to_string());
    "function() {
    const wantsX = __WANTS_X__;
    const wantsY = __WANTS_Y__;
    let scroller = this;
    while (scroller) {
      const style = getComputedStyle(scroller);
      const canX = /(auto|scroll|overlay)/.test(style.overflowX)
        && scroller.scrollWidth > scroller.clientWidth;
      const canY = /(auto|scroll|overlay)/.test(style.overflowY)
        && scroller.scrollHeight > scroller.clientHeight;
      if ((wantsX && canX) || (wantsY && canY)) break;
      scroller = scroller.parentElement;
    }
    scroller ||= document.scrollingElement || document.documentElement;
    const before = [scroller.scrollLeft, scroller.scrollTop];
    scroller.scrollBy({
      left: __DX__,
      top: __TOP__,
      behavior: 'instant'
    });
    return {
      changed: scroller.scrollLeft !== before[0] || scroller.scrollTop !== before[1],
      scrollLeft: Math.round(scroller.scrollLeft),
      scrollTop: Math.round(scroller.scrollTop),
    };
  }"
    .replace("__WANTS_X__", &(dx != 0).to_string())
    .replace("__WANTS_Y__", &wants_y.to_string())
    .replace("__DX__", &dx.to_string())
    .replace("__TOP__", &top)
}

/// Scrolls the page itself (no target form given).
fn scroll_page_expression(dx: i64, dy: Option<i64>) -> String {
    let top = dy.map_or_else(|| "Math.round(window.innerHeight * 0.8)".to_string(), |dy| dy.to_string());
    "(() => {
        window.scrollBy({
          left: __DX__,
          top: __TOP__,
          behavior: 'instant'
        });
        return {
          scrollY: Math.round(window.scrollY),
          scrollHeight: Math.round(document.documentElement.scrollHeight),
          viewportHeight: Math.round(window.innerHeight),
        };
      })()"
        .replace("__DX__", &dx.to_string())
        .replace("__TOP__", &top)
}

/// `scroll`: by a ref's nearest scroller, at a screenshot coordinate with the wheel, the page itself, or to a phrase (`text`). Exactly
/// one target form is accepted. A phrase that is not on the page fails rather than scrolling blind.
pub async fn scroll(cx: &mut ActionContext<'_>) -> Result<ActionOutput, ActionError> {
    let dx = finite_number(cx.field("dx")).map_or(0, |dx| dx.trunc() as i64);
    let dy = finite_number(cx.field("dy")).map(|dy| dy.trunc() as i64);
    let effective_dy = if dy.is_none() && cx.field("dx").is_some() { Some(0) } else { dy };
    let semantic = truthy(cx.field("ref")) || cx.field("target").is_some_and(|target| !target.is_null());
    let coordinate = cx.field("snapshotId").is_some() || cx.field("x").is_some() || cx.field("y").is_some();
    let wanted = js_trim(&text_of(cx.field("text"))).to_string();
    if [semantic, coordinate, !wanted.is_empty()].into_iter().filter(|form| *form).count() > 1 {
        return Err(ActionError::Failed("scroll accepts only one target form".to_string()));
    }
    if !wanted.is_empty() {
        // Bringing a known phrase into view without knowing where it sits.
        let Some(found) = scroll_text_into_view(cx, &wanted).await? else {
            return Err(ActionError::Failed(format!("scroll text {} was not found on this page; nothing was scrolled", json_string(&wanted))));
        };
        cx.page.invalidate_interaction();
        // Name the line that was reached: the first match may not be the one meant.
        let lead = if found.is_empty() { String::new() } else { format!("Scrolled to {}.\n\n", json_string(&redact_browser_text(&found))) };
        return Ok(ActionOutput { lead, decorate_recovery: true, ..ActionOutput::default() });
    }
    if coordinate && (!truthy(cx.field("snapshotId")) || finite_number(cx.field("x")).is_none() || finite_number(cx.field("y")).is_none()) {
        return Err(ActionError::Failed("scroll coordinate target requires snapshotId, x, and y".to_string()));
    }
    if semantic {
        let source = action_ref(cx).await?.ok_or_else(|| ActionError::Failed("the target resolved to nothing".to_string()))?;
        let (host, cancel) = (cx.host, cx.cancel);
        let page_id = cx.page.facts().page_id;
        let declaration = scroll_within_ref_declaration(dx, effective_dy);
        let page = cx.page;
        let moved = mutate_ref(cx, &source, false, |ref_id| async move {
            let expect = expect_for(page, Some(&ref_id));
            let target = RefTarget { page_id: &page_id, snapshot_id: snapshot_of_ref(&ref_id), ref_id: &ref_id, expect: Some(&expect) };
            call_ref(host, &target, &declaration, Vec::new(), cancel.token()).await
        })
        .await?;
        if moved.get("changed").and_then(Value::as_bool) == Some(true) {
            cx.page.record_scroll();
        }
        cx.page.invalidate_interaction();
        return Ok(ActionOutput { decorate_recovery: true, ..ActionOutput::default() });
    }
    if coordinate {
        let point = visual_point(cx, cx.field("x"), cx.field("y"), "scroll").await?;
        cx.page.invalidate_interaction();
        let mut step = pointer_step(BrowserPointerKind::Wheel, point);
        step.delta_x = Some(dx as f64);
        step.delta_y = Some(effective_dy.map_or_else(|| (f64::from(OFFSCREEN_VIEWPORT.1) * 0.8).round(), |dy| dy as f64));
        let timing = send_input(cx, vec![InputStep::Pointer(step)], None).await?;
        return Ok(finished(false, timing));
    }
    cx.page.invalidate_interaction();
    let params = HostBrowserPageEvalParams {
        page_id: cx.page.facts().page_id,
        expression: scroll_page_expression(dx, effective_dy),
        frame: None,
        await_promise: None,
        return_by_value: Some(true),
        world: None,
        timeout_ms: u32::try_from(CDP_REQUEST_TIMEOUT.as_millis()).unwrap_or(u32::MAX),
        expect: Some(cx.page.precondition()),
    };
    let answer = cx.host.page_eval(params, cx.token()).await?;
    if let Some(exception) = answer.exception {
        return Err(ActionError::Failed(exception.text));
    }
    Ok(ActionOutput::default())
}

#[cfg(test)]
mod tests {
    use mixdog_app_protocol::v2::browser_engine::PageFacts;
    use serde_json::json;

    use super::super::target::testing::Rig;
    use super::super::target::testing::TestPage;
    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::refs::grounding::VisualGrounding;
    use crate::refs::ref_set::RefSet;
    use crate::refs::ref_set::tests::element;
    use crate::refs::ref_set::tests::payload;

    const URL: &str = "https://a.test/";

    fn refs(snapshot_id: &str) -> RefSet {
        RefSet::from_payload(snapshot_id, &payload(snapshot_id, vec![element(&format!("{snapshot_id}-e1"), "button", "Save"), element(&format!("{snapshot_id}-e2"), "region", "Done")], URL))
    }

    fn page() -> TestPage {
        TestPage::with(|state| state.ref_set = Some(refs("p1-s1")))
    }

    fn grounded(page: &TestPage) {
        let set = refs("p1-s2").with_document("p1:1", 7);
        page.set(|state| {
            state.grounding = Some(VisualGrounding::bind(&set, 640.0, 450.0, std::time::Instant::now()));
            state.revision = Some(7);
        });
    }

    fn probe(x: f64, y: f64) -> Expect {
        Expect::ok("host/browser/ref/call", json!({"value": {"x": x, "y": y, "via": "control"}, "facts": page_facts("p1", 2)}))
    }

    fn geometry() -> Expect {
        Expect::ok("host/browser/page/eval", json!({"value": {"url": URL, "width": 1280, "height": 900}, "facts": page_facts("p1", 2)}))
    }

    fn batch(outcome: &str) -> Expect {
        batch_with(outcome, page_facts("p1", 3))
    }

    fn batch_with(outcome: &str, facts: Value) -> Expect {
        Expect::ok(
            "host/browser/input/batch",
            json!({"outcome": outcome, "completedSteps": 1, "timing": {"inputMs": 2.0, "keyEvents": 0, "mouseEvents": 3}, "facts": facts}),
        )
    }

    /// Runs `$handler` on a context over the page and the host with a command; the refs the caller holds are those of snapshot `p1-s1`.
    macro_rules! run {
        ($page:expr, $host:expr, $command:expr, $handler:ident) => {{
            let command: Value = $command;
            let mut rig = Rig::new(Some(refs("p1-s1")));
            let view = rig.source.view();
            let mut cx = ActionContext { host: $host, page: $page, command: &command, cancel: &view, recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
            $handler(&mut cx).await
        }};
    }

    #[tokio::test]
    async fn a_click_on_a_ref_probes_its_point_then_presses_with_a_hit_guard() {
        let host = FakeHost::scripted(vec![
            probe(40.0, 22.5).with_params(json!({"snapshotId": "p1-s1", "ref": "p1-s1-e1"})),
            batch("completed").with_params(json!({
                "pageId": "p1",
                "steps": [{"op": "pointer", "kind": "click", "x": 40.0, "y": 22.5, "button": "left", "hitGuard": {"snapshotId": "p1-s1", "ref": "p1-s1-e1"}}],
                "stopOnDialog": true,
                "expect": {"documentId": "p1:1", "snapshotId": "p1-s1"}
            })),
        ]);
        let page = page();
        let output = run!(&page, &host, json!({"ref": "p1-s1-e1"}), click).await.expect("clicked");
        assert!(output.decorate_recovery);
        assert_eq!(output.input.len(), 1);
        assert_eq!(output.input[0].mouse_events, 3);
        assert_eq!(page.get(|state| state.invalidated), 1);
        host.finish().expect("a probe and one batch");
    }

    #[tokio::test]
    async fn a_right_double_click_with_modifiers_and_a_touch_tap_are_one_step_each() {
        let host = FakeHost::scripted(vec![
            probe(1.0, 2.0),
            batch("completed").with_params(json!({"steps": [{"op": "pointer", "kind": "dblclick", "button": "right", "modifiers": ["ctrl", "shift"]}]})),
        ]);
        let page = page();
        let command = json!({"ref": "p1-s1-e1", "doubleClick": true, "button": " Right ", "modifiers": ["Ctrl", "shift"]});
        run!(&page, &host, command, click).await.expect("double clicked");
        host.finish().expect("done");

        let host = FakeHost::scripted(vec![probe(1.0, 2.0), batch("completed").with_params(json!({"steps": [{"op": "pointer", "kind": "tap", "x": 1.0, "y": 2.0}]}))]);
        run!(&page, &host, json!({"ref": "p1-s1-e1", "pointer": "touch"}), click).await.expect("tapped");
        host.finish().expect("done");
    }

    #[tokio::test]
    async fn invalid_click_arguments_are_refused_before_input() {
        for (command, message) in [
            (json!({"ref": "p1-s1-e1", "pointer": "pen"}), "click pointer must be mouse or touch"),
            (json!({"ref": "p1-s1-e1", "button": "back"}), "click button must be left, right, or middle"),
            (json!({"ref": "p1-s1-e1", "modifiers": "ctrl"}), "click modifiers must be an array"),
            (json!({"ref": "p1-s1-e1", "modifiers": ["hyper"]}), "unsupported click modifier \"hyper\""),
            (json!({"ref": "p1-s1-e1", "pointer": "touch", "doubleClick": true}), "click pointer=touch does not accept button, modifiers, or doubleClick"),
            (json!({"ref": "p1-s1-e1", "pointer": "touch", "button": "left"}), "click pointer=touch does not accept button, modifiers, or doubleClick"),
        ] {
            let host = FakeHost::scripted(if message.starts_with("click pointer must") { Vec::new() } else { vec![probe(1.0, 2.0)] });
            let page = page();
            let error = run!(&page, &host, command, click).await.expect_err(message);
            assert_eq!(error.to_string(), message);
            assert!(host.calls().iter().all(|call| call.method != "host/browser/input/batch"), "{message}: no input");
        }
    }

    #[tokio::test]
    async fn a_ref_that_is_not_from_the_latest_snapshot_is_refused_without_a_call() {
        let host = FakeHost::scripted(Vec::new());
        let page = page();
        let error = run!(&page, &host, json!({"ref": "p9-s1-e1"}), click).await.expect_err("unknown ref");
        assert_eq!(error.to_string(), "ref p9-s1-e1 is not from the latest snapshot; take a fresh snapshot first");
        host.finish().expect("no call");
    }

    #[tokio::test]
    async fn a_screenshot_coordinate_hovers_without_a_hit_guard() {
        let host = FakeHost::scripted(vec![
            geometry(),
            batch("completed").with_params(json!({"steps": [{"op": "pointer", "kind": "hover", "x": 640.0, "y": 450.0}], "expect": {"documentId": "p1:1"}})),
        ]);
        let page = page();
        grounded(&page);
        let output = run!(&page, &host, json!({"snapshotId": "p1-s2", "x": 320, "y": 225}), hover).await.expect("hovered");
        assert!(!output.decorate_recovery);
        let calls = host.calls();
        assert!(calls[1].params["steps"][0].get("hitGuard").is_none());
        host.finish().expect("geometry and one batch");
    }

    #[tokio::test]
    async fn the_outcome_of_the_batch_decides_whether_the_gesture_counts() {
        let cases: [(&str, Value, Result<(), &str>); 5] = [
            ("dialog", page_facts("p1", 3), Ok(())),
            ("hitGuard", page_facts("p1", 3), Err("input target changed or could not be verified; input was not replayed, observe before continuing")),
            ("hitGuard", {
                let mut moved = page_facts("p1", 3);
                moved["url"] = json!("https://a.test/next");
                moved
            }, Ok(())),
            ("userInput", page_facts("p1", 3), Err("the person holds the page")),
            ("cancelled", page_facts("p1", 3), Err("browser command cancelled")),
        ];
        for (outcome, facts, expected) in cases {
            let host = FakeHost::scripted(vec![probe(1.0, 2.0), batch_with(outcome, facts)]);
            let page = page();
            let result = run!(&page, &host, json!({"ref": "p1-s1-e1"}), click).await;
            match expected {
                Ok(()) => assert!(result.is_ok(), "{outcome}: {result:?}"),
                Err(message) => assert_eq!(result.expect_err(outcome).to_string(), message, "{outcome}"),
            }
        }
    }

    #[tokio::test]
    async fn a_drag_between_refs_is_one_drag_step() {
        let host = FakeHost::scripted(vec![
            probe(10.0, 20.0).with_params(json!({"ref": "p1-s1-e1"})),
            probe(300.0, 40.0).with_params(json!({"ref": "p1-s1-e2"})),
            batch("completed").with_params(json!({"steps": [{"op": "pointer", "kind": "dragTo", "x": 10.0, "y": 20.0, "toX": 300.0, "toY": 40.0}]})),
        ]);
        let page = page();
        let output = run!(&page, &host, json!({"ref": "p1-s1-e1", "targetRef": "p1-s1-e2"}), drag).await.expect("dragged");
        assert!(output.decorate_recovery);
        let calls = host.calls();
        assert!(calls[2].params["steps"][0].get("hitGuard").is_none(), "a drag was never guarded");
        host.finish().expect("two probes and one batch");

        let host = FakeHost::scripted(vec![probe(10.0, 20.0)]);
        let error = run!(&page, &host, json!({"ref": "p1-s1-e1"}), drag).await.expect_err("no destination");
        assert!(error.to_string().contains("needs a destination"));
    }

    #[tokio::test]
    async fn a_coordinate_drag_by_touch_is_a_swipe() {
        let host = FakeHost::scripted(vec![
            geometry(),
            geometry(),
            batch("completed").with_params(json!({"steps": [{"op": "pointer", "kind": "swipe", "x": 64.0, "y": 90.0, "toX": 128.0, "toY": 180.0}]})),
        ]);
        let page = page();
        grounded(&page);
        let command = json!({"pointer": "touch", "snapshotId": "p1-s2", "x": 32, "y": 45, "targetX": 64, "targetY": 90});
        run!(&page, &host, command, drag).await.expect("swiped");
        host.finish().expect("two coordinates and one batch");
    }

    #[tokio::test]
    async fn a_key_press_is_one_press_step() {
        let host = FakeHost::scripted(vec![batch("completed").with_params(json!({"steps": [{"op": "press", "key": "Control+A"}], "expect": {"documentId": "p1:1"}}))]);
        let page = page();
        let output = run!(&page, &host, json!({"key": "Control+A"}), press).await.expect("pressed");
        assert!(!output.decorate_recovery);
        assert_eq!(page.get(|state| state.invalidated), 1);
        host.finish().expect("one batch");
    }

    #[tokio::test]
    async fn the_page_scrolls_by_its_viewport_unless_asked_for_less() {
        let host = FakeHost::scripted(vec![
            Expect::ok("host/browser/page/eval", json!({"value": {"scrollY": 700}, "facts": page_facts("p1", 2)})),
            Expect::ok("host/browser/page/eval", json!({"value": {"scrollY": 0}, "facts": page_facts("p1", 2)})),
        ]);
        let page = page();
        run!(&page, &host, json!({}), scroll).await.expect("scrolled");
        run!(&page, &host, json!({"dx": 40.9}), scroll).await.expect("scrolled sideways");
        let calls = host.calls();
        let first = calls[0].params["expression"].as_str().expect("expression");
        assert!(first.contains("left: 0,") && first.contains("top: Math.round(window.innerHeight * 0.8)"), "{first}");
        let second = calls[1].params["expression"].as_str().expect("expression");
        assert!(second.contains("left: 40,") && second.contains("top: 0,"), "dx alone does not scroll down: {second}");
        assert_eq!(page.get(|state| state.invalidated), 2);
    }

    #[tokio::test]
    async fn a_coordinate_scroll_is_a_wheel_step_at_the_point() {
        let host = FakeHost::scripted(vec![
            geometry(),
            batch("completed").with_params(json!({"steps": [{"op": "pointer", "kind": "wheel", "x": 640.0, "y": 450.0, "deltaX": 0.0, "deltaY": 720.0}]})),
        ]);
        let page = page();
        grounded(&page);
        run!(&page, &host, json!({"snapshotId": "p1-s2", "x": 320, "y": 225}), scroll).await.expect("wheeled");
        host.finish().expect("done");
    }

    #[tokio::test]
    async fn the_target_forms_of_a_scroll_exclude_each_other_and_a_coordinate_is_complete() {
        for (command, message) in [
            (json!({"ref": "p1-s1-e1", "text": "Footer"}), "scroll accepts only one target form"),
            (json!({"snapshotId": "p1-s2", "x": 1, "y": 1, "ref": "p1-s1-e1"}), "scroll accepts only one target form"),
            (json!({"x": 1, "y": 2}), "scroll coordinate target requires snapshotId, x, and y"),
            (json!({"snapshotId": "p1-s2", "x": "1", "y": 2}), "scroll coordinate target requires snapshotId, x, and y"),
        ] {
            let host = FakeHost::scripted(Vec::new());
            let page = page();
            let error = run!(&page, &host, command, scroll).await.expect_err(message);
            assert_eq!(error.to_string(), message);
            host.finish().expect("nothing was called");
        }
    }

    fn frame_facts() -> PageFacts {
        let mut facts: PageFacts = serde_json::from_value(page_facts("p1", 1)).expect("facts");
        facts.child_sessions = vec![mixdog_app_protocol::v2::browser_engine::BrowserChildSession { session_id: "c1".into(), frame_id: "f1".into(), url: "https://b.test/".into() }];
        facts
    }

    fn eval(value: Value) -> Expect {
        Expect::ok("host/browser/page/eval", json!({"value": value, "facts": page_facts("p1", 2)}))
    }

    #[tokio::test]
    async fn a_phrase_scrolls_only_the_frame_the_host_picked_and_names_the_line() {
        let host = FakeHost::scripted(vec![
            eval(json!({"token": "t0", "found": false})),
            eval(json!({"token": "t1", "found": true, "text": "Quarterly report"})).with_params(json!({"frame": {"sessionId": "c1", "frameId": "f1"}})),
            eval(json!({"scrolled": false})),
            eval(json!({"scrolled": true})).with_params(json!({"frame": {"sessionId": "c1"}})),
        ]);
        let page = TestPage::with(|state| state.facts = Some(frame_facts()));
        let output = run!(&page, &host, json!({"text": " Quarterly "}), scroll).await.expect("scrolled");
        assert!(output.decorate_recovery);
        assert!(output.lead.starts_with("Scrolled to \"Quarterly report: ") && output.lead.ends_with("\".\n\n"), "{}", output.lead);
        assert_eq!(page.get(|state| state.invalidated), 1);
        let calls = host.calls();
        let matching = calls[0].params["expression"].as_str().expect("expression");
        assert!(matching.contains("\"quarterly\"") && !matching.contains("__MIXDOG_"), "{matching}");
        assert!(calls[3].params["expression"].as_str().expect("expression").contains("\"t1\""));
        host.finish().expect("two frames matched, two frames applied");
    }

    #[tokio::test]
    async fn a_phrase_that_is_not_on_the_page_fails_and_scrolls_nothing() {
        let host = FakeHost::scripted(vec![eval(json!({"token": "t0", "found": false}))]);
        let page = page();
        let error = run!(&page, &host, json!({"text": "Nowhere"}), scroll).await.expect_err("not found");
        assert_eq!(error.to_string(), "scroll text \"Nowhere\" was not found on this page; nothing was scrolled");
        assert_eq!(page.get(|state| state.invalidated), 0);
        host.finish().expect("only the match pass");
    }

    #[tokio::test]
    async fn a_scroll_on_a_ref_runs_inside_its_nearest_scroller_and_is_never_replayed() {
        let connected = Expect::ok("host/browser/ref/call", json!({"value": true, "facts": page_facts("p1", 2)}));
        let host = FakeHost::scripted(vec![
            connected,
            Expect::ok("host/browser/ref/call", json!({"value": {"changed": true, "scrollTop": 300}, "facts": page_facts("p1", 2)})),
        ]);
        let page = page();
        let output = run!(&page, &host, json!({"ref": "p1-s1-e1", "dy": 300}), scroll).await.expect("scrolled");
        assert!(output.decorate_recovery);
        assert_eq!((page.get(|state| state.scrolls), page.get(|state| state.invalidated)), (1, 1));
        let declaration = host.calls()[1].params["functionDeclaration"].as_str().expect("declaration").to_string();
        assert!(declaration.contains("let scroller = this;") && declaration.contains("top: 300,") && !declaration.contains("__"), "{declaration}");

        let host = FakeHost::scripted(vec![
            Expect::ok("host/browser/ref/call", json!({"value": true, "facts": page_facts("p1", 2)})),
            Expect::ok("host/browser/ref/call", json!({"exception": {"text": "node detached after input"}, "facts": page_facts("p1", 2)})),
        ]);
        let page = page();
        let error = run!(&page, &host, json!({"ref": "p1-s1-e1", "dy": 300}), scroll).await.expect_err("failed after dispatch");
        assert!(error.to_string().ends_with("input may have executed and was not replayed; take a fresh snapshot before continuing"), "{error}");
        assert_eq!(page.get(|state| state.fresh_snapshots), 0, "no recovery after the script ran");
        host.finish().expect("preflight and one script");
    }

    #[tokio::test]
    async fn an_unmoved_scroller_is_not_recorded_as_a_scroll() {
        let host = FakeHost::scripted(vec![
            Expect::ok("host/browser/ref/call", json!({"value": true, "facts": page_facts("p1", 2)})),
            Expect::ok("host/browser/ref/call", json!({"value": {"changed": false}, "facts": page_facts("p1", 2)})),
        ]);
        let page = page();
        run!(&page, &host, json!({"ref": "p1-s1-e1", "dy": 0, "dx": 5}), scroll).await.expect("no move");
        assert_eq!(page.get(|state| state.scrolls), 0);
    }

    #[test]
    fn the_scroll_scripts_have_no_placeholder_left() {
        let (matching, applying) = scroll_text_sources();
        assert!(matching.starts_with("(() => {") && applying.starts_with("(() => {") && applying.ends_with("})()"));
        assert!(!scroll_text_match_expression("a \"b\" c").contains("__MIXDOG_"));
        assert!(scroll_text_apply_expression("tok").contains("=== \"tok\""));
        let declaration = scroll_within_ref_declaration(0, None);
        assert!(declaration.contains("const wantsY = true;") && declaration.contains("const wantsX = false;") && declaration.contains("Math.round(scroller.clientHeight * 0.8)"));
        assert!(scroll_within_ref_declaration(5, Some(0)).contains("const wantsY = false;"));
    }
}
