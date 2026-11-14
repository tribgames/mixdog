//! Owner: s4-engine-approval
//! Who is asking (`approval-requester.ts`): the bot whose OWN session a session is, the name the card shows, and the chat the
//! card docks in. Read from the session roster and the agent pool the gate holds, passed in as plain rows. Only a bot's own
//! session (its 1:1 home chat or its room member session) is a bot: a coding session, a task session, a sub-agent at any depth
//! and an unknown id are none. The bot is read from the id alone, so it never depends on a catalog or on a lookup succeeding.

use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_base::rooms::ids::room_session_id;

/// The primary assistant's name where the roster has none.
pub const MIXY_DEFAULT_NAME: &str = "Mixy";

/// The longest chain of spawn parents followed.
const MAX_CHAIN: usize = 16;

/// A listed session (`DesktopSessionSummary`), reduced to what the requester reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionRow {
    pub id: String,
    /// The title as the roster shows it (the session title label, its preview when it has none).
    pub title: String,
    pub cwd: String,
    /// The roster also lists sub-agent sessions: those are no top level.
    pub agent_session: bool,
    /// The agent whose home chat this is; empty for any other session.
    pub agent_home: String,
}

/// A row of the agent pool: a sub-agent session, the top-level session it works for and the one that spawned it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PoolRow {
    pub session_id: String,
    pub owner_session_id: String,
    pub parent_session_id: String,
    pub agent: String,
    pub tag: String,
    pub cwd: String,
}

/// Who is asking, for the card (`name` is empty when the session is unknown).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Requester {
    pub name: String,
    /// The asking session's working directory, when known.
    pub cwd: Option<String>,
}

/// What the requester reads.
pub struct Sources<'a> {
    pub sessions: &'a [SessionRow],
    pub pool: &'a [PoolRow],
    /// The catalog name of an agent (its rename included); `None` when `agent_id` is no listed bot or the catalog is unavailable.
    pub agent_name: &'a dyn Fn(&str) -> Option<String>,
    /// "Lead" in this PC's language: a coding Lead's place in a chain; empty for the default.
    pub lead_name: &'a str,
}

/// The bot whose OWN session `session_id` is; empty for anything else. Only this bot asks, and a standing allow is recorded
/// for / read from it alone.
pub fn own_bot_of_session(session_id: &str) -> String {
    agent_id_of_home_session(session_id).or_else(|| room_member_of_session(session_id).map(|member| member.agent_id)).unwrap_or_default()
}

/// The pool rows from `session_id`'s own up through its spawn parents, nearest first; empty for a session that is no sub-agent.
fn agent_row_chain<'a>(session_id: &str, pool: &'a [PoolRow]) -> Vec<&'a PoolRow> {
    let mut chain: Vec<&PoolRow> = Vec::new();
    let mut id = session_id.trim().to_owned();
    while !id.is_empty() && chain.len() < MAX_CHAIN {
        let Some(row) = pool.iter().find(|entry| entry.session_id == id) else { break };
        if chain.iter().any(|seen| std::ptr::eq(*seen, row)) {
            break;
        }
        chain.push(row);
        id = row.parent_session_id.trim().to_owned();
    }
    chain
}

/// The listed session a session's work belongs to: itself, or a sub-agent's owner; with the sub-agent's pool rows.
fn top_session_of<'a>(session_id: &str, sources: &'a Sources<'a>) -> Option<(&'a SessionRow, Vec<&'a PoolRow>)> {
    let own = sources.sessions.iter().find(|entry| entry.id == session_id);
    if let Some(own) = own.filter(|own| !own.agent_session) {
        return Some((own, Vec::new()));
    }
    let chain = agent_row_chain(session_id, sources.pool);
    let owner = chain.last().map(|row| row.owner_session_id.trim()).unwrap_or_default();
    if let Some(top) = sources.sessions.iter().find(|entry| entry.id == owner) {
        return Some((top, chain));
    }
    // A listed sub-agent with no pool row stands for itself, title and cwd kept.
    own.filter(|_| chain.is_empty()).map(|own| (own, chain))
}

/// A group-room member session (unlisted: the catalog leaves members out) a session is, or works for, with the sub-agent's pool
/// rows; `None` for any other session.
fn room_seat_of<'a>(session_id: &str, sources: &'a Sources<'a>) -> Option<(mixdog_core_base::rooms::ids::RoomMember, Vec<&'a PoolRow>)> {
    let chain = agent_row_chain(session_id, sources.pool);
    let owner = chain.last().map(|row| row.owner_session_id.trim()).filter(|owner| !owner.is_empty()).unwrap_or(session_id);
    room_member_of_session(owner).map(|member| (member, chain))
}

/// The top-level chat a session's approvals surface in: a sub-agent is the session it works for; a room member (and its
/// sub-agents) the room's log, where the room shows its approvals; anything else itself. A task session a bot created is an
/// ordinary top-level session, so it and its sub-agents surface in it, never the bot's home.
pub fn approval_surface_session_id(session_id: &str, sources: &Sources<'_>) -> String {
    if let Some((top, _)) = top_session_of(session_id, sources) {
        return top.id.clone();
    }
    match room_seat_of(session_id, sources) {
        Some((member, _)) => room_session_id(&member.room_id).unwrap_or_else(|| session_id.to_owned()),
        None => session_id.to_owned(),
    }
}

/// A listed bot's catalog name; empty when `agent_id` is no bot. Mixy is never a catalog contact: it is named by its identity
/// (`lead_name`), else the default.
fn agent_home_name(agent_id: &str, sources: &Sources<'_>) -> String {
    if agent_id == MIXY_AGENT_ID {
        let lead = sources.lead_name.trim();
        return if lead.is_empty() { MIXY_DEFAULT_NAME.to_owned() } else { lead.to_owned() };
    }
    (sources.agent_name)(agent_id).unwrap_or_default()
}

fn own_requester(session: &SessionRow, sources: &Sources<'_>) -> Requester {
    let cwd = (!session.cwd.is_empty()).then(|| session.cwd.clone());
    let home = session.agent_home.as_str();
    if home.is_empty() || home == MIXY_AGENT_ID {
        return Requester { name: session.title.clone(), cwd };
    }
    let named = agent_home_name(home, sources);
    Requester { name: if named.is_empty() { session.title.clone() } else { named }, cwd }
}

fn seat_requester(agent_id: &str, sources: &Sources<'_>) -> Requester {
    let named = agent_home_name(agent_id, sources);
    Requester { name: if named.is_empty() { agent_id.to_owned() } else { named }, cwd: None }
}

/// Who is asking: a bot's home chat and its room member session are that bot (its catalog name), any other session (a task
/// session a bot created included) is named by its title and belongs to no bot. A sub-agent is named by its chain ("Mixy >
/// Worker", "Lead > Reviewer") and belongs to no bot.
pub fn resolve_requester(session_id: &str, sources: &Sources<'_>) -> Requester {
    let found = top_session_of(session_id, sources);
    let seat = if found.is_some() { None } else { room_seat_of(session_id, sources) };
    let chain: &[&PoolRow] = match (&found, &seat) {
        (Some((_, chain)), _) | (None, Some((_, chain))) => chain,
        (None, None) => return Requester::default(),
    };
    let own = match (&found, &seat) {
        (Some((top, _)), _) => own_requester(top, sources),
        (None, Some((member, _))) => seat_requester(&member.agent_id, sources),
        (None, None) => return Requester::default(),
    };
    if chain.is_empty() {
        return own;
    }
    let agent_name = |row: &PoolRow| {
        let id = row.agent.trim();
        match (sources.agent_name)(id).filter(|_| !id.is_empty()) {
            Some(name) => name,
            None if !id.is_empty() => id.to_owned(),
            None => row.tag.trim().to_owned(),
        }
    };
    let cwd = chain[0].cwd.trim();
    let head = match &found {
        Some((top, _)) if top.agent_home.is_empty() => {
            let lead = sources.lead_name.trim();
            if lead.is_empty() { "Lead".to_owned() } else { lead.to_owned() }
        }
        _ => own.name,
    };
    let below = chain.iter().rev().map(|row| agent_name(row));
    let name = std::iter::once(head).chain(below).collect::<Vec<_>>().join(" \u{203A} ");
    Requester { name, cwd: (!cwd.is_empty()).then(|| cwd.to_owned()) }
}

#[cfg(test)]
mod tests {
    use mixdog_core_base::rooms::ids::room_member_session_id;

    use super::*;

    const MARKETER: &str = "agent-12c3dee5bf";

    fn session(id: &str, title: &str) -> SessionRow {
        SessionRow { id: id.into(), title: title.into(), ..Default::default() }
    }

    fn home(agent: &str, title: &str) -> SessionRow {
        SessionRow { agent_home: agent.into(), ..session(&format!("sess_home_{agent}"), title) }
    }

    fn pool(id: &str, owner: &str, parent: &str, agent: &str) -> PoolRow {
        PoolRow { session_id: id.into(), owner_session_id: owner.into(), parent_session_id: parent.into(), agent: agent.into(), ..Default::default() }
    }

    fn catalog(id: &str) -> Option<String> {
        match id {
            MARKETER => Some("\u{B9C8}\u{CF00}\u{D130}".to_owned()),
            "worker" => Some("Worker".to_owned()),
            "reviewer" => Some("Reviewer".to_owned()),
            _ => None,
        }
    }

    fn none(_: &str) -> Option<String> {
        None
    }

    fn sources<'a>(sessions: &'a [SessionRow], pool: &'a [PoolRow], agent_name: &'a dyn Fn(&str) -> Option<String>) -> Sources<'a> {
        Sources { sessions, pool, agent_name, lead_name: "" }
    }

    #[test]
    fn only_a_bots_own_session_id_is_a_bot() {
        let seat = room_member_session_id("abc123", MARKETER).expect("seat");
        assert_eq!(own_bot_of_session(&format!("sess_home_{MARKETER}")), MARKETER);
        assert_eq!(own_bot_of_session("sess_home_agent-gone"), "agent-gone");
        assert_eq!(own_bot_of_session("sess_home_lead"), "lead");
        assert_eq!(own_bot_of_session(&seat), MARKETER);
        let room = room_session_id("abc123").expect("room");
        for id in ["sess_code", "sess_unknown", "sess_w1", "sess_task", room.as_str(), ""] {
            assert_eq!(own_bot_of_session(id), "", "{id}");
        }
    }

    #[test]
    fn a_bot_home_chat_is_named_by_the_bot_and_any_other_session_by_its_title() {
        let sessions = [home(MARKETER, "hello"), home("agent-gone", "Old chat"), session("sess_code", "Image")];
        let at = sources(&sessions, &[], &catalog);
        assert_eq!(resolve_requester(&format!("sess_home_{MARKETER}"), &at).name, "\u{B9C8}\u{CF00}\u{D130}");
        // A deleted agent's home keeps its title but is still that agent's own session.
        assert_eq!(resolve_requester("sess_home_agent-gone", &at).name, "Old chat");
        assert_eq!(resolve_requester("sess_code", &at).name, "Image");
        assert_eq!(resolve_requester("sess_unknown", &at), Requester::default());
    }

    #[test]
    fn mixy_home_is_named_by_its_title_and_an_unavailable_catalog_falls_back_to_it() {
        let sessions = [home("lead", "Mixy chat"), home(MARKETER, "hello")];
        assert_eq!(resolve_requester("sess_home_lead", &sources(&sessions, &[], &catalog)).name, "Mixy chat");
        assert_eq!(resolve_requester(&format!("sess_home_{MARKETER}"), &sources(&sessions, &[], &none)).name, "hello");
    }

    #[test]
    fn a_sub_agent_is_named_by_its_chain_and_is_no_bot() {
        let sessions = [home(MARKETER, "hello"), session("sess_task", "Report"), session("sess_lead", "Refactor")];
        let mut first = pool("sess_w1", &format!("sess_home_{MARKETER}"), &format!("sess_home_{MARKETER}"), "worker");
        first.cwd = "/w".into();
        let rows = [
            first,
            pool("sess_t1", "sess_task", "sess_task", "worker"),
            pool("sess_t2", "sess_task", "sess_t1", "reviewer"),
            pool("sess_r1", "sess_lead", "sess_lead", "reviewer"),
            pool("sess_x", "sess_lead", "sess_lead", ""),
        ];
        let at = sources(&sessions, &rows, &catalog);
        let w1 = resolve_requester("sess_w1", &at);
        assert_eq!((w1.name.as_str(), w1.cwd.as_deref()), ("\u{B9C8}\u{CF00}\u{D130} \u{203A} Worker", Some("/w")));
        assert_eq!(resolve_requester("sess_r1", &at).name, "Lead \u{203A} Reviewer");
        assert_eq!(resolve_requester("sess_task", &at).name, "Report");
        assert_eq!(resolve_requester("sess_t2", &at).name, "Lead \u{203A} Worker \u{203A} Reviewer");
        // A pool row naming neither an agent nor a tag has an empty name in the chain.
        assert_eq!(resolve_requester("sess_x", &at).name, "Lead \u{203A} ");
        assert_eq!(own_bot_of_session("sess_w1"), "");
        let named_lead = Sources { lead_name: "Boss", ..sources(&sessions, &rows, &catalog) };
        assert_eq!(resolve_requester("sess_r1", &named_lead).name, "Boss \u{203A} Reviewer");
        // A pool row whose owner is unlisted stays unknown.
        assert_eq!(resolve_requester("sess_w1", &sources(&[], &rows, &catalog)), Requester::default());
    }

    #[test]
    fn the_card_docks_in_the_top_level_chat() {
        let sessions = [home(MARKETER, "hello"), session("sess_task", "Report"), session("sess_lead", "Refactor")];
        let rows = [
            pool("sess_w1", &format!("sess_home_{MARKETER}"), &format!("sess_home_{MARKETER}"), "worker"),
            pool("sess_t1", "sess_task", "sess_task", "worker"),
            pool("sess_t2", "sess_task", "sess_t1", "reviewer"),
        ];
        let at = sources(&sessions, &rows, &catalog);
        assert_eq!(approval_surface_session_id("sess_w1", &at), format!("sess_home_{MARKETER}"));
        assert_eq!(approval_surface_session_id("sess_t2", &at), "sess_task");
        assert_eq!(approval_surface_session_id("sess_task", &at), "sess_task");
        assert_eq!(approval_surface_session_id("sess_lead", &at), "sess_lead");
        assert_eq!(approval_surface_session_id("sess_unknown", &at), "sess_unknown");
    }

    #[test]
    fn a_room_member_is_its_bot_its_sub_agents_are_no_bot_and_cards_dock_in_the_room_log() {
        let room = "abc123";
        let seat = room_member_session_id(room, MARKETER).expect("seat");
        let gone = room_member_session_id(room, "agent-gone").expect("seat");
        let log = room_session_id(room).expect("log");
        let sessions = [home(MARKETER, "hello"), session(&log, "Standup")];
        let rows = [pool("sess_rw", &seat, &seat, "worker"), pool("sess_rw2", &seat, "sess_rw", "reviewer")];
        let at = sources(&sessions, &rows, &catalog);
        assert_eq!(resolve_requester(&seat, &at), Requester { name: "\u{B9C8}\u{CF00}\u{D130}".into(), cwd: None });
        // A seat of a bot the catalog no longer lists is named by its id.
        assert_eq!(resolve_requester(&gone, &at).name, "agent-gone");
        assert_eq!(resolve_requester("sess_rw", &at).name, "\u{B9C8}\u{CF00}\u{D130} \u{203A} Worker");
        assert_eq!(resolve_requester("sess_rw2", &at).name, "\u{B9C8}\u{CF00}\u{D130} \u{203A} Worker \u{203A} Reviewer");
        assert_eq!(own_bot_of_session("sess_rw"), "");
        for id in [seat.as_str(), "sess_rw", "sess_rw2"] {
            assert_eq!(approval_surface_session_id(id, &at), log, "{id}");
        }
        // Mixy's seat is named by its identity.
        let lead_seat = room_member_session_id(room, "lead").expect("seat");
        assert_eq!(resolve_requester(&lead_seat, &at).name, "Mixy");
    }

    #[test]
    fn a_listed_sub_agent_surfaces_in_its_owner_and_one_with_no_pool_row_stands_for_itself() {
        let mut worker = session("sess_w9", "Worker chat");
        worker.agent_session = true;
        worker.cwd = "/x".into();
        let sessions = [session("sess_lead", "Refactor"), worker];
        let rows = [pool("sess_w9", "sess_lead", "sess_lead", "worker")];
        let at = sources(&sessions, &rows, &catalog);
        assert_eq!(approval_surface_session_id("sess_w9", &at), "sess_lead");
        let alone = sources(&sessions, &[], &catalog);
        assert_eq!(approval_surface_session_id("sess_w9", &alone), "sess_w9");
        assert_eq!(resolve_requester("sess_w9", &alone), Requester { name: "Worker chat".into(), cwd: Some("/x".into()) });
    }

    #[test]
    fn a_cycle_of_spawn_parents_ends() {
        let sessions = [session("sess_top", "Top")];
        let rows = [pool("a", "sess_top", "b", "worker"), pool("b", "sess_top", "a", "reviewer")];
        let at = sources(&sessions, &rows, &catalog);
        assert_eq!(resolve_requester("a", &at).name, "Lead \u{203A} Reviewer \u{203A} Worker");
    }
}
