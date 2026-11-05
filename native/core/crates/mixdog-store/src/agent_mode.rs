//! Which mode a Lead session runs in (1.4.5 `session/agent-mode.mjs`) and the reserved
//! session-id grammars it reads: an agent's home thread (`agent-home.mjs`), a group room and
//! its member sessions (`agent-room.mjs`), and the agent owner (`agent-owner.mjs`).

use serde_json::Map;
use serde_json::Value;
use mixdog_js::js_trim;

use crate::summary::truthy;

const HOME_PREFIX: &str = "sess_home_";
const ROOM_PREFIX: &str = "sess_room_";
const MEMBER_PREFIX: &str = "sess_rmem_";
const MAX_AGENT_ID_LENGTH: usize = 200;

/// The home session id of `agent_id`, or "" when it is not a normalized id.
pub fn agent_home_session_id(agent_id: &str) -> String {
    let mut bytes = agent_id.bytes();
    let first_ok = bytes.next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let rest_ok = agent_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    if agent_id.len() > MAX_AGENT_ID_LENGTH || !first_ok || !rest_ok {
        return String::new();
    }
    format!("{HOME_PREFIX}{}", agent_id.replace('.', "_"))
}

/// The agent id a home session belongs to, or "" for any other session.
pub fn agent_id_of_home_session(session_id: &str) -> String {
    let Some(rest) = session_id.strip_prefix(HOME_PREFIX) else { return String::new() };
    let id = rest.replace('_', ".");
    if agent_home_session_id(&id) == session_id { id } else { String::new() }
}

fn is_room_id(v: &str) -> bool {
    (6..=32).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// The room a log session belongs to, or "" for any other session.
pub fn room_id_of_session(session_id: &str) -> String {
    match session_id.strip_prefix(ROOM_PREFIX) {
        Some(id) if is_room_id(id) => id.to_owned(),
        _ => String::new(),
    }
}

fn room_member_session_id(room_id: &str, agent_id: &str) -> String {
    let home = agent_home_session_id(agent_id);
    if !is_room_id(room_id) || home.is_empty() {
        return String::new();
    }
    format!("{MEMBER_PREFIX}{room_id}_{}", &home[HOME_PREFIX.len()..])
}

/// The agent id of a member session; `None` for any other session.
fn room_member_agent(session_id: &str) -> Option<String> {
    let rest = session_id.strip_prefix(MEMBER_PREFIX)?;
    let cut = rest.find('_')?;
    let (room_id, agent_id) = (&rest[..cut], rest[cut + 1..].replace('_', "."));
    (room_member_session_id(room_id, &agent_id) == session_id).then_some(agent_id)
}

/// Whether the session wants the incoming tail: a bot's home thread or a room's log.
pub fn wants_incoming_tail(session_id: &str) -> bool {
    !agent_id_of_home_session(session_id).is_empty() || !room_id_of_session(session_id).is_empty()
}

fn js_text(v: Option<&Value>) -> String {
    if truthy(v) { mixdog_js::value_to_string(v.expect("truthy")) } else { String::new() }
}

fn valid_agent_id(v: Option<&Value>) -> String {
    let id = match v {
        Some(Value::String(s)) => js_trim(s),
        _ => "",
    };
    if !id.is_empty() && !agent_home_session_id(id).is_empty() { id.to_owned() } else { String::new() }
}

/// `resolveSessionMode({ session }).mode` for a session record header.
fn resolve_mode(session: &Map<String, Value>) -> &'static str {
    let owner = js_trim(&js_text(session.get("owner"))).to_lowercase();
    if owner == "agent" || session.get("visibility").and_then(Value::as_str) == Some("agent-only") {
        return "coding";
    }
    let id = js_text(session.get("id"));
    let agent = room_member_agent(&id)
        .or_else(|| Some(agent_id_of_home_session(&id)).filter(|a| !a.is_empty()))
        .unwrap_or_else(|| valid_agent_id(session.get("ownerAgentId")));
    if agent.is_empty() { "coding" } else { "agent" }
}

/// `sessionModeOf(session)`: the stored mode; older records resolve it.
pub fn session_mode_of(session: &Map<String, Value>) -> &'static str {
    match session.get("sessionMode").and_then(Value::as_str) {
        Some("agent") => "agent",
        Some("coding") => "coding",
        _ => resolve_mode(session),
    }
}
