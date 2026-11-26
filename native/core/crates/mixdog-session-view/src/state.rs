//! The projection the UI reads: the fold, the pending server requests and the `hostShellJobs` section joined into one record
//! (`desktopSessionState` of `packages/protocol-client/src/session-state.ts`). `toolApproval` / `toolApprovalsWaiting` come from the
//! server requests (protocol.md §8.5) and `hostShellJobs` from the app feed, which are not part of the thread feed, so they are
//! joined here and nowhere else. [`PROJECTED_FIELDS`] is what the projection produces: it is the list of fields the UI can read.

use mixdog_app_protocol::ServerRequest;
use mixdog_app_server_client::ThreadFold;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::reducer::live_fields;
use crate::rows::coalesce;
use crate::rows::fld;
use crate::rows::is_obj;
use crate::rows::js_string;
use crate::rows::text;

/// The fold of one session: the client's folded thread.
pub type SessionFold = ThreadFold;

/// Every field of the projected state: the fields the sections own, the snapshot's and the feed's, then the ones the projection sets.
pub const PROJECTED_FIELDS: &[&str] = &[
    // thread/runtime/updated
    "busy",
    "commandBusy",
    "thinking",
    "spinner",
    "commandStatus",
    "progressHint",
    "activeTools",
    "clientHostPid",
    "toasts",
    "activeToolSummary",
    "toolMode",
    "setupChanged",
    // thread/route/updated
    "sessionProvider",
    "sessionModel",
    "fast",
    "fastCapable",
    "autoEffort",
    "effortAuto",
    "modelParameters",
    "selectedContextWindow",
    "effort",
    "provider",
    "model",
    "turnEffort",
    "effortOptions",
    "cwd",
    "sessionForkedFrom",
    "systemShell",
    "webSearchRoute",
    "autoClear",
    // thread/context/updated
    "contextPercent",
    "contextTokens",
    "contextDefaultPercent",
    "contextWindow",
    "displayContextWindow",
    "autoCompactTokenLimit",
    "stats",
    "rawContextWindow",
    "effectiveContextWindowPercent",
    "compactBoundaryTokens",
    // thread/agents/updated, thread/workflow/updated, thread/approvals/updated
    "agentWorkers",
    "agentJobs",
    "agentScope",
    "workflow",
    "orchestrationMode",
    "pendingWorkflowSwitch",
    "pendingOrchestrationModeSwitch",
    "toolApprovalResult",
    "handoffQuestions",
    // the one-field sections
    "todo",
    "goal",
    "quotaResume",
    "shellJobs",
    "workspace",
    "promptRestore",
    "providerAccountChange",
    "remoteEnabled",
    "setupUiRequest",
    // the snapshot and the feed's own notifications
    "desktopSessionTitle",
    "transcriptHasOlder",
    "promptHistoryList",
    "queued",
    // set by the projection
    "sessionId",
    "items",
    "structureRevision",
    "streamingTail",
    "streamingPartial",
    "transcriptViewItems",
    "transcriptViewRevision",
    "transcriptHistoryBefore",
    "transcriptHistoryAfter",
    "transcriptArchive",
    "transcriptSpilled",
    "lastTurn",
    "themeEpoch",
    "remoteSessionId",
    "hostShellJobs",
    "toolApproval",
    "toolApprovalsWaiting",
];

/// The shell-job status with no job (the shell-jobs poller's empty status).
fn empty_shell_jobs() -> Value {
    json!({ "count": 0, "elapsedLabel": "", "jobs": [], "finished": [] })
}

/// The wire form of a server request: `{ method, id, params }`.
fn request_value(request: &ServerRequest) -> Value {
    serde_json::to_value(request).unwrap_or_default()
}

fn surface_of(request: &Value) -> Option<&str> {
    let params = fld(Some(request), "params");
    coalesce(fld(params, "surfaceThreadId"), fld(params, "threadId")).and_then(Value::as_str)
}

/// The thread whose approval card a server request belongs to.
pub fn approval_surface(request: &ServerRequest) -> Option<String> {
    surface_of(&request_value(request)).map(str::to_owned)
}

/// The params the core states beside a request's content: not part of its card.
const NOT_IN_CARD: [&str; 10] = ["threadId", "turnId", "itemId", "surfaceThreadId", "chain", "requestedAt", "expiresAt", "order", "request", "kind"];

/// The card of a server request, shaped like today's `toolApproval`: the request's own content plus its id.
fn approval_card(request: &Value) -> Value {
    let request = Some(request);
    let params = fld(request, "params");
    // The core's copy of Node's card (`normalizeToolApprovalRequest` of the hook request), with the row-shaped id the card shows
    // (room_approval.rs `card_id`; `approvalRequestOf` finds the request back from it).
    if let Some(card) = fld(params, "card").filter(|card| card.is_object()) {
        return card.clone();
    }
    let mut card: Map<String, Value> = params
        .and_then(Value::as_object)
        .map(|own| own.iter().filter(|(key, _)| !NOT_IN_CARD.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect())
        .unwrap_or_default();
    if let Some(Value::Object(inner)) = fld(params, "request") {
        card.extend(inner.clone());
    }
    // An `ask_user` question carries no kind on the wire (its method says it); Node's card said `kind: 'question'` (the push notifier
    // and the card's Allow rules tell a question from an approval by it).
    if text(fld(request, "method")) == "item/tool/requestUserInput" {
        card.insert("kind".to_owned(), json!("question"));
    }
    card.insert("id".to_owned(), json!(js_string(fld(request, "id"))));
    Value::Object(card)
}

/// The state of the folded session, with the pending server requests and the host's shell jobs joined in. Pure: a caller that
/// renders often memoizes on the fold, the requests and the host's shell jobs.
/// - `toolApproval` is the pending request with the lowest `order` on this surface, `toolApprovalsWaiting` the others (§8.5).
///   Both start from the engine's initial state (`null`, 0: initial-state.mjs); the counter is the queue length
///   (tool-approval.mjs `presentNextToolApproval`) whether or not a `toolApprovalResult` is shown.
pub fn desktop_session_state(fold: &SessionFold, requests: &[ServerRequest], host_shell_jobs: Option<&Value>) -> Value {
    let state = Some(&fold.state);
    let fields: Map<String, Value> = fld(state, "fields").and_then(Value::as_object).cloned().unwrap_or_default();
    let session_id = text(fld(state, "sessionId"));
    let has_items = matches!(fld(state, "items"), Some(Value::Array(items)) if !items.is_empty());
    // The transcript window is the TUI store's (`createInitialSessionState`): the core keeps the whole log (no spill, no paged view, no
    // archive range: decisions.md, the `transcriptArchive` row), so these hold the store's idle values; `lastTurn` is only ever cleared and
    // `themeEpoch` is the TUI process's theme counter. The store's first draft has no `streamingPartial` (turn-stream.mjs sets it while
    // a line streams) and no `transcriptSpilled`: transcript-store.mjs publishes it with the first row pushed or swapped in, as the
    // unspilled `{ epoch: 0, rows: 0 }` here, since the core never spills.
    // The one-field sections the store always holds, null while unset: `promptRestore` and `agentScope` (initial-state.mjs), `workspace`,
    // `goal`, `quotaResume` and `todo` (context-state.mjs `baseRouteState`, republished whole by every pass), and the session's own route,
    // `sessionProvider` / `sessionModel` (`runtime.sessionProvider ?? null`), null before the thread has a session.
    let mut out = Map::new();
    for key in ["sessionProvider", "sessionModel", "promptRestore", "workspace", "goal", "quotaResume", "todo", "agentScope"] {
        out.insert(key.to_owned(), Value::Null);
    }
    out.extend(fields.clone());
    out.insert("sessionId".to_owned(), json!(session_id));
    out.insert("items".to_owned(), fld(state, "transcript").cloned().unwrap_or_else(|| json!([])));
    out.insert("structureRevision".to_owned(), fld(state, "structureRevision").cloned().unwrap_or_else(|| json!(0)));
    out.insert("streamingTail".to_owned(), Value::Null);
    if fld(state, "partialShown") == Some(&Value::Bool(true)) {
        out.insert("streamingPartial".to_owned(), Value::Null);
    }
    out.insert("promptHistoryList".to_owned(), json!([]));
    out.insert("transcriptViewItems".to_owned(), Value::Null);
    out.insert("transcriptViewRevision".to_owned(), json!(0));
    out.insert("transcriptHistoryBefore".to_owned(), json!(false));
    out.insert("transcriptHistoryAfter".to_owned(), json!(false));
    out.insert("transcriptArchive".to_owned(), Value::Null);
    out.insert("lastTurn".to_owned(), Value::Null);
    out.insert("themeEpoch".to_owned(), json!(0));
    // The host's fields Node's session state always carries, empty while it has none; a section the core removed (`with_section`: JSON
    // null removes) reads as that value, not as an absent key: the remote fields (session-host-publication.ts:281-288) and shell-job
    // status (session-host.ts:485-495, the poller's empty status).
    out.insert("remoteEnabled".to_owned(), json!(false));
    out.insert("remoteSessionId".to_owned(), Value::Null);
    out.insert("shellJobs".to_owned(), empty_shell_jobs());
    out.insert("hostShellJobs".to_owned(), empty_shell_jobs());
    out.extend(fields);
    out.insert("toolApproval".to_owned(), Value::Null);
    out.insert("toolApprovalsWaiting".to_owned(), json!(0));
    if has_items {
        out.insert("transcriptSpilled".to_owned(), json!({ "epoch": 0, "rows": 0 }));
    }
    if let Some(jobs) = host_shell_jobs {
        out.insert("hostShellJobs".to_owned(), jobs.clone());
    }
    if let Some(live) = fld(state, "live").filter(|live| live.is_object()) {
        out.extend(live_fields(live));
    }
    let mut pending: Vec<(f64, Value)> = requests
        .iter()
        .map(request_value)
        .filter(|request| surface_of(request) == Some(session_id))
        .map(|request| (fld(fld(Some(&request), "params"), "order").and_then(Value::as_f64).unwrap_or(0.0), request))
        .collect();
    // Arrival breaks a tie: the sort is stable.
    pending.sort_by(|a, b| a.0.total_cmp(&b.0));
    if let Some((_, first)) = pending.first() {
        out.insert("toolApproval".to_owned(), approval_card(first));
        out.insert("toolApprovalsWaiting".to_owned(), json!(pending.len() - 1));
    }
    with_room_view(out)
}

/// `desktop_session_state` as Node's frame publisher published it (frame-batched-store.mjs): its `structureRevision` is the frames'
/// (one up per frame that changed the rows' structure). The phone shows these; a reader of every change uses
/// `desktop_session_state`.
pub fn framed_session_state(fold: &SessionFold, requests: &[ServerRequest], host_shell_jobs: Option<&Value>) -> Value {
    let mut state = desktop_session_state(fold, requests, host_shell_jobs);
    let held = Some(&fold.state);
    let framed = fld(held, "framedRevision").or_else(|| fld(held, "structureRevision")).cloned();
    if let (Some(framed), Some(map)) = (framed, state.as_object_mut()) {
        map.insert("structureRevision".to_owned(), framed);
    }
    state
}

/// How many `thread/frame` announcements the fold has taken: a framed state is published once per frame.
pub fn frames_of(fold: &SessionFold) -> u64 {
    fld(Some(&fold.state), "frames").and_then(Value::as_u64).unwrap_or(0)
}

/// A room log's `roomView` laid over its state as Node's `decorateRoomSnapshot` decorates the room's session state
/// (`agent-room-views.ts`): busy while the room has an exchange state, the speaking member's `toolApproval`, the handed-off
/// questions, and the typing row after the transcript. `roomView` itself is not a `DesktopSessionState` field.
fn with_room_view(mut out: Map<String, Value>) -> Value {
    let view = out.shift_remove("roomView");
    let Some(room) = view.filter(|view| view.is_object()) else { return Value::Object(out) };
    let room = Some(&room);
    if let Some(Value::Array(questions)) = fld(room, "handoffQuestions")
        && !questions.is_empty()
    {
        out.insert("handoffQuestions".to_owned(), Value::Array(questions.clone()));
    }
    if fld(room, "busy") != Some(&Value::Bool(true)) {
        return Value::Object(out);
    }
    out.insert("busy".to_owned(), json!(true));
    // `typeof v === 'object'`: an array is one too.
    let object_like = |value: &&Value| is_obj(Some(*value)) || value.is_array();
    if let Some(approval) = fld(room, "toolApproval").filter(object_like) {
        out.insert("toolApproval".to_owned(), approval.clone());
    }
    if let Some(typing) = fld(room, "typing").filter(object_like) {
        let mut items = match out.get("items") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        items.push(typing.clone());
        out.insert("items".to_owned(), Value::Array(items));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use mixdog_app_protocol::JsonRpcNotification;
    use mixdog_app_server_client::FeedStamp;
    use mixdog_app_server_client::ThreadReducer;

    use super::*;
    use crate::reducer::SessionReducer;

    fn fold_of(snapshot: Value) -> SessionFold {
        let state = SessionReducer.initial(&snapshot);
        ThreadFold { feed: serde_json::from_value::<FeedStamp>(json!({ "id": "t", "epoch": "e", "seq": 0 })).expect("a stamp"), state }
    }

    fn request(id: &str, method: &str, params: Value) -> ServerRequest {
        serde_json::from_value(json!({ "method": method, "id": id, "params": params })).expect("a server request")
    }

    fn hello() -> Value {
        json!({ "type": "agentMessage", "id": "a", "text": "hi", "meta": {} })
    }

    #[test]
    fn an_idle_session_shows_the_stores_idle_values() {
        let fold = fold_of(json!({ "thread": { "id": "t" }, "items": [hello()], "state": {}, "hasOlder": false }));
        let state = desktop_session_state(&fold, &[], None);
        for (key, want) in [
            ("sessionId", json!("t")),
            ("sessionProvider", Value::Null),
            ("toolApproval", Value::Null),
            ("toolApprovalsWaiting", json!(0)),
            ("transcriptSpilled", json!({ "epoch": 0, "rows": 0 })),
            ("hostShellJobs", json!({ "count": 0, "elapsedLabel": "", "jobs": [], "finished": [] })),
            ("remoteEnabled", json!(false)),
            ("streamingTail", Value::Null),
        ] {
            assert_eq!(state[key], want, "{key}");
        }
        assert!(state.get("streamingPartial").is_none());
        assert_eq!(state["items"][0]["text"], "hi");
    }

    #[test]
    fn the_host_shell_jobs_the_app_feed_states_replace_the_empty_status() {
        let fold = fold_of(json!({ "thread": { "id": "t" }, "items": [], "state": {} }));
        let jobs = json!({ "count": 1, "elapsedLabel": "1s", "jobs": [{ "id": "j" }], "finished": [] });
        assert_eq!(desktop_session_state(&fold, &[], Some(&jobs))["hostShellJobs"], jobs);
    }

    #[test]
    fn the_pending_request_with_the_lowest_order_is_the_approval_and_the_others_wait() {
        let fold = fold_of(json!({ "thread": { "id": "t" }, "items": [], "state": {} }));
        let ask = |id: &str, order: u64, thread: &str| {
            request(
                id,
                "item/tool/requestApproval",
                json!({ "threadId": thread, "requestedAt": 1, "order": order, "kind": "shell", "tool": "bash", "request": { "command": id } }),
            )
        };
        let requests = [ask("r2", 2, "t"), ask("r1", 1, "t"), ask("other", 0, "elsewhere")];
        let state = desktop_session_state(&fold, &requests, None);
        assert_eq!(state["toolApprovalsWaiting"], 1);
        assert_eq!(
            (state["toolApproval"]["id"].clone(), state["toolApproval"]["command"].clone(), state["toolApproval"]["tool"].clone()),
            (json!("r1"), json!("r1"), json!("bash"))
        );
        assert!(state["toolApproval"].get("order").is_none());
    }

    #[test]
    fn a_question_card_says_so_and_a_cards_own_object_is_the_card() {
        let fold = fold_of(json!({ "thread": { "id": "t" }, "items": [], "state": {} }));
        let question =
            request("q", "item/tool/requestUserInput", json!({ "threadId": "t", "requestedAt": 1, "order": 1, "questions": [{ "question": "ok?" }] }));
        assert_eq!(
            desktop_session_state(&fold, &[question], None)["toolApproval"],
            json!({ "questions": [{ "question": "ok?" }], "kind": "question", "id": "q" })
        );
        // The core states the card it shows in `params.card`.
        let carded = json!({ "method": "item/tool/requestApproval", "id": "c", "params": { "threadId": "t", "order": 1, "kind": "shell", "card": { "id": "row-1", "tool": "bash" } } });
        assert_eq!(approval_card(&carded), json!({ "id": "row-1", "tool": "bash" }));
    }

    #[test]
    fn a_running_room_lays_its_view_over_the_logs_state() {
        let fold = fold_of(json!({
            "thread": { "id": "t" }, "items": [hello()],
            "state": { "roomView": { "busy": true, "typing": { "kind": "typing", "id": "ty" }, "handoffQuestions": [{ "q": 1 }] } }
        }));
        let state = desktop_session_state(&fold, &[], None);
        assert!(state.get("roomView").is_none());
        assert_eq!((state["busy"].clone(), state["handoffQuestions"].clone()), (json!(true), json!([{ "q": 1 }])));
        assert_eq!(state["items"][1]["id"], "ty");
    }

    #[test]
    fn a_framed_state_takes_the_frames_revision() {
        let mut fold = fold_of(json!({ "thread": { "id": "t" }, "items": [hello()], "state": {} }));
        let frame: JsonRpcNotification = serde_json::from_value(json!({ "method": "thread/frame", "params": { "structureChanged": true } })).expect("a frame");
        fold.state = SessionReducer.apply(&fold.state, &frame);
        let framed = framed_session_state(&fold, &[], None);
        assert_eq!((framed["structureRevision"].clone(), frames_of(&fold)), (json!(2), 1));
        assert_eq!(desktop_session_state(&fold, &[], None)["structureRevision"], 1);
    }
}
