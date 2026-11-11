//! Fixed session ids: an agent's home thread, a room's log and a member's session in a room.
//! Ids are derived keys, never stored pointers, so every surface resolves the same session.

/// The primary assistant's contact: the Lead configuration itself.
pub const MIXY_AGENT_ID: &str = "lead";

/// What a session id is (`SESSION_ID_PATTERN`, `runtime-core/session-id.mjs`): the pattern's source
/// and flags, as a `JsRegex` compiles them.
pub const SESSION_ID_PATTERN: (&str, &str) = ("^[A-Za-z0-9_-]+$", "");

/// `meta.source` of every row stored in a room's log.
pub const ROOM_ROW_SOURCE: &str = "agent-room";

const HOME_PREFIX: &str = "sess_home_";
const ROOM_PREFIX: &str = "sess_room_";
const MEMBER_PREFIX: &str = "sess_rmem_";
const MAX_AGENT_ID_LENGTH: usize = 200;

/// A normalized agent id: `[a-z0-9][a-z0-9.-]*`.
fn is_agent_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

fn is_room_id(id: &str) -> bool {
    (6..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// The home session id of `agent_id`, or `None` when it is not a normalized id.
pub fn agent_home_session_id(agent_id: &str) -> Option<String> {
    (agent_id.len() <= MAX_AGENT_ID_LENGTH && is_agent_id(agent_id))
        .then(|| format!("{HOME_PREFIX}{}", agent_id.replace('.', "_")))
}

/// The agent id a home session belongs to, `None` for any other session.
pub fn agent_id_of_home_session(session_id: &str) -> Option<String> {
    let id = session_id.strip_prefix(HOME_PREFIX)?.replace('_', ".");
    (agent_home_session_id(&id).as_deref() == Some(session_id)).then_some(id)
}

pub fn room_session_id(room_id: &str) -> Option<String> {
    is_room_id(room_id).then(|| format!("{ROOM_PREFIX}{room_id}"))
}

pub fn room_id_of_session(session_id: &str) -> Option<String> {
    let id = session_id.strip_prefix(ROOM_PREFIX)?;
    is_room_id(id).then(|| id.to_owned())
}

/// The session `agent_id` speaks from in room `room_id`.
pub fn room_member_session_id(room_id: &str, agent_id: &str) -> Option<String> {
    let home = agent_home_session_id(agent_id)?;
    is_room_id(room_id).then(|| format!("{MEMBER_PREFIX}{room_id}_{}", &home[HOME_PREFIX.len()..]))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomMember {
    pub room_id: String,
    pub agent_id: String,
}

/// `{room, agent}` of a member session; `None` for any other session.
pub fn room_member_of_session(session_id: &str) -> Option<RoomMember> {
    let rest = session_id.strip_prefix(MEMBER_PREFIX)?;
    let (room_id, tail) = rest.split_once('_')?;
    let agent_id = tail.replace('_', ".");
    (room_member_session_id(room_id, &agent_id).as_deref() == Some(session_id))
        .then(|| RoomMember { room_id: room_id.to_owned(), agent_id })
}

/// A room's log or one of its member sessions: permanent, never scratch.
pub fn is_room_thread_session_id(session_id: &str) -> bool {
    room_id_of_session(session_id).is_some() || room_member_of_session(session_id).is_some()
}

#[cfg(test)]
#[path = "ids_home_replay.rs"]
mod home_replay;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_ids_round_trip_and_reject_others() {
        assert_eq!(agent_home_session_id("a.b-c").as_deref(), Some("sess_home_a_b-c"));
        assert_eq!(agent_id_of_home_session("sess_home_a_b-c").as_deref(), Some("a.b-c"));
        assert_eq!(agent_home_session_id("Upper"), None);
        assert_eq!(agent_home_session_id("-x"), None);
        assert_eq!(agent_home_session_id(""), None);
        assert_eq!(agent_id_of_home_session("sess_home_"), None);
        assert_eq!(agent_id_of_home_session("sess_desktop_x"), None);
        assert_eq!(agent_home_session_id(&"a".repeat(201)), None);
    }

    #[test]
    fn room_and_member_ids() {
        assert_eq!(room_session_id("abc123").as_deref(), Some("sess_room_abc123"));
        assert_eq!(room_session_id("abc"), None);
        assert_eq!(room_id_of_session("sess_room_abc123").as_deref(), Some("abc123"));
        let member = room_member_session_id("abc123", "gh.bot").unwrap();
        assert_eq!(member, "sess_rmem_abc123_gh_bot");
        assert_eq!(
            room_member_of_session(&member),
            Some(RoomMember { room_id: "abc123".into(), agent_id: "gh.bot".into() })
        );
        assert!(is_room_thread_session_id(&member));
        assert!(is_room_thread_session_id("sess_room_abc123"));
        assert!(!is_room_thread_session_id("sess_home_x"));
        assert_eq!(room_member_of_session("sess_rmem_abc123"), None);
    }
}
