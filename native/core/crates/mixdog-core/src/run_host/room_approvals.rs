//! The production [`RoomApprovals`] of the room host, over the session directory:
//! - **A member's approval** is answered through the session's one decision path
//!   (`SessionDirectory::answer_member_approval`).
//! - **A handed-off question** is answered through the member's own copy
//!   (`HandoffQuestionsHub::finish_question`, Node's `finishToolApproval` of that runtime).
//! - **The members' questions** are read from their threads' approvals sections
//!   (`handoffQuestions`).
//! - **A room's view** goes out as its log thread's `roomView` section
//!   (`RoomSummaries::publish_room`, `thread/roomView/updated`), laid as Node's
//!   `decorateRoomSnapshot` does (`room_approval::room_view`).
//!
//! [`LateRoomMembers`] is the session side's `noteMemberRows`: a member thread's questions moved,
//! so its room is published again.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::Weak;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::room_member_session_id;
use mixdog_core_rooms::rooms::live::ApprovalAnswer;
use mixdog_core_rooms::rooms::live::ExchangeView;
use mixdog_core_rooms::rooms::live::LiveRooms;
use mixdog_core_rooms::rooms::live::RoomApprovals;
use mixdog_core_session::session::RoomMemberEvents;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::delegated_host::Answered;
use mixdog_core_session::session::room_approval::RoomViewState;
use mixdog_core_session::session::room_approval::room_view;
use mixdog_core_session::session::runtime_hooks::HandoffQuestionsHub;
use mixdog_core_session::session::thread_list::RoomSummaries;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

type Pending = Arc<Mutex<HashMap<String, (Option<ExchangeView>, Vec<Value>)>>>;

pub struct SessionRoomApprovals {
    directory: Arc<SessionDirectory>,
    summaries: Arc<RoomSummaries>,
    questions: Arc<HandoffQuestionsHub>,
    /// The newest view of each room not published yet: a publish sends what is newest when it
    /// runs, so views published in quick succession never land out of order.
    pending: Pending,
}

impl SessionRoomApprovals {
    pub fn new(directory: Arc<SessionDirectory>, summaries: Arc<RoomSummaries>, questions: Arc<HandoffQuestionsHub>) -> Self {
        Self { directory, summaries, questions, pending: Arc::default() }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `resolveToolApproval(id, decision)` (`tui/session/session-api/lifecycle.mjs:64-79`): the
/// arguments `finishToolApproval` is called with. `extra` is `humanDecisionFields` (`:15-22`).
fn answered_of(device: String, decision: &Value) -> Answered {
    let approved = decision == &Value::Bool(true) || decision.get("approved") == Some(&Value::Bool(true));
    let reason = match decision.get("reason").and_then(Value::as_str).filter(|reason| !reason.is_empty()) {
        Some(reason) => reason.to_owned(),
        None => (if approved { "approved by user" } else { "denied by user" }).to_owned(),
    };
    let extra: Map<String, Value> =
        ["response", "editedArgs", "remember", "scope"].iter().filter_map(|key| decision.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect();
    Answered {
        approved,
        reason,
        device,
        answers: decision.get("answers").cloned(),
        reply: decision.get("reply").filter(|reply| reply.is_string()).cloned(),
        extra: (!extra.is_empty()).then_some(Value::Object(extra)),
    }
}

#[async_trait]
impl RoomApprovals for SessionRoomApprovals {
    async fn approve(&self, session_id: &str, answer: ApprovalAnswer) -> Result<bool, String> {
        let ApprovalAnswer { request, connection, device, connection_kind, result } = answer;
        self.directory
            .answer_member_approval(&ThreadId::from(session_id.to_owned()), request.as_str(), connection, device, connection_kind, result)
            .map_err(|error| error.to_string())
    }

    async fn answer_question(&self, member_session: &str, answer: ApprovalAnswer) -> Result<bool, String> {
        let answered = answered_of(answer.device.clone(), &answer.result);
        Ok(self.questions.finish_question(&ThreadId::from(member_session.to_owned()), answer.request.as_str(), &answered).unwrap_or(false))
    }

    /// A member thread that is not loaded runs no session and holds no copies (Node's rows of it
    /// carry none).
    fn member_questions(&self, room_id: &str, members: &[String]) -> Vec<Value> {
        let mut out = Vec::new();
        for member in members {
            let Some(session) = room_member_session_id(room_id, member) else { continue };
            for question in self.directory.member_handoff_questions(&ThreadId::from(session.clone())) {
                let Value::Object(mut question) = question else { continue };
                let id = match question.get("id") {
                    Some(Value::String(id)) if !id.is_empty() => id.clone(),
                    Some(id @ Value::Number(_)) => id.to_string(),
                    _ => continue,
                };
                question.insert("id".into(), json!(id));
                question.insert("roomMember".into(), json!(member));
                question.insert("memberSessionId".into(), json!(session));
                out.push(Value::Object(question));
            }
        }
        out
    }

    fn publish_view(&self, room_session_id: &str, view: Option<ExchangeView>, questions: Vec<Value>) {
        lock(&self.pending).insert(room_session_id.to_owned(), (view, questions));
        let (summaries, pending, room) = (self.summaries.clone(), self.pending.clone(), room_session_id.to_owned());
        mixdog_rt::spawn("rooms.publish-view", mixdog_rt::TaskClass::Work, async move {
            let Some((view, questions)) = lock(&pending).remove(&room) else { return };
            let state = view.map(|view| RoomViewState { speaking: view.speaking, speaking_name: view.speaking_name, typing_id: view.typing_id, approval: view.approval });
            summaries.publish_room(&ThreadId::from(room), room_view(state.as_ref(), &questions)).await;
        });
    }
}

/// `SessionDeps.room_members`: a member thread's handed-off questions moved, so its room is
/// published again (`noteMemberRows`). The rooms are built over the directory, which is built over
/// the deps that carry this, so they are bound afterwards. Before the bind no room is hosted.
#[derive(Default)]
pub struct LateRoomMembers(OnceLock<Weak<LiveRooms>>);

impl LateRoomMembers {
    /// Binds the rooms; a second bind is refused.
    pub fn bind(&self, rooms: &Arc<LiveRooms>) -> Result<(), Weak<LiveRooms>> {
        self.0.set(Arc::downgrade(rooms))
    }

    fn rooms(&self) -> Option<Arc<LiveRooms>> {
        self.0.get().and_then(Weak::upgrade)
    }
}

impl RoomMemberEvents for LateRoomMembers {
    fn questions_moved(&self, room_id: &str) {
        if let Some(rooms) = self.rooms() {
            rooms.republish_room(room_id);
        }
    }

    fn approval_resolved(&self, room_id: &str, approval_id: &str) {
        if let Some(rooms) = self.rooms() {
            rooms.member_resolved(room_id, approval_id);
        }
    }
}
