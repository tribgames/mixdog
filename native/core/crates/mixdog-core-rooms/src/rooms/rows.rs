//! Room log rows and what a member is shown of them.

use serde::{Deserialize, Serialize};

/// First-time members see at most this many earlier rows.
const FIRST_TURN_ROWS: usize = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RowKind {
    User,
    Speech,
    Pass,
    Cap,
    Stopped,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomRow {
    pub id: String,
    pub kind: RowKind,
    #[serde(default)]
    pub speaker: String,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub text: String,
    /// Handed to the member before (context, never a new request).
    #[serde(default)]
    pub seen: bool,
}

/// True while the user's newest message has no member speech after it.
pub fn room_user_waiting(rows: &[RoomRow]) -> bool {
    for row in rows.iter().rev() {
        match row.kind {
            RowKind::User => return true,
            RowKind::Speech => return false,
            _ => {}
        }
    }
    false
}

/// The rows a member has not seen: everything after `cursor` (the last row id it was shown), or
/// the recent tail on its first turn. `seen_id` is the newest row a prompt its session took was
/// handed: that row and those before it come back marked `seen`. `rows` are in log order, so a
/// cursor they no longer hold is older than all of them: the rows after `seen_id` are new, or,
/// when neither id is held, the open request (from the user's newest message). Its own words,
/// passes and notices are left out.
pub fn rows_since_cursor(rows: &[RoomRow], cursor: &str, agent_id: &str, seen_id: &str) -> Vec<RoomRow> {
    let position = |id: &str| (!id.is_empty()).then(|| rows.iter().position(|row| row.id == id)).flatten();
    let at = position(cursor);
    let seen = position(seen_id);
    let tail = rows.len().saturating_sub(FIRST_TURN_ROWS);
    let start = if let Some(at) = at {
        at + 1
    } else if cursor.is_empty() {
        tail
    } else if let Some(seen) = seen {
        seen + 1
    } else {
        rows.iter().rposition(|row| row.kind == RowKind::User).unwrap_or(tail)
    };
    let mut fresh = Vec::new();
    for (index, row) in rows.iter().enumerate().skip(start) {
        let counts = row.kind == RowKind::User || (row.kind == RowKind::Speech && row.speaker != agent_id);
        if !counts {
            continue;
        }
        let mut row = row.clone();
        if seen.is_some_and(|seen| index <= seen) {
            row.seen = true;
        }
        fresh.push(row);
    }
    fresh
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, kind: RowKind, speaker: &str) -> RoomRow {
        RoomRow { id: id.into(), kind, speaker: speaker.into(), to: vec![], text: String::new(), seen: false }
    }

    #[test]
    fn waiting_until_a_speech_follows_the_user() {
        let user = row("1", RowKind::User, "");
        let speech = row("2", RowKind::Speech, "a");
        assert!(room_user_waiting(&[user.clone()]));
        assert!(room_user_waiting(&[user.clone(), row("3", RowKind::Pass, "a")]));
        assert!(!room_user_waiting(&[user, speech]));
        assert!(!room_user_waiting(&[]));
    }

    #[test]
    fn rows_after_the_cursor_exclude_own_speech_and_notices() {
        let rows = vec![
            row("1", RowKind::User, ""),
            row("2", RowKind::Speech, "a"),
            row("3", RowKind::Speech, "b"),
            row("4", RowKind::Pass, "b"),
            row("5", RowKind::User, ""),
        ];
        let ids = |rows: Vec<RoomRow>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(rows_since_cursor(&rows, "1", "a", "")), ["3", "5"]);
        assert_eq!(ids(rows_since_cursor(&rows, "", "a", "")), ["1", "3", "5"]);
    }

    #[test]
    fn a_lost_cursor_resumes_after_the_seen_row_or_at_the_open_request() {
        let rows = vec![row("1", RowKind::User, ""), row("2", RowKind::Speech, "b"), row("3", RowKind::User, "")];
        let got = rows_since_cursor(&rows, "gone", "a", "2");
        assert_eq!(got.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["3"]);
        let got = rows_since_cursor(&rows, "gone", "a", "gone2");
        assert_eq!(got.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["3"]);
    }

    #[test]
    fn rows_up_to_the_seen_id_are_context() {
        let rows = vec![row("1", RowKind::User, ""), row("2", RowKind::Speech, "b"), row("3", RowKind::User, "")];
        let got = rows_since_cursor(&rows, "", "a", "2");
        assert_eq!(got.iter().map(|r| r.seen).collect::<Vec<_>>(), [true, true, false]);
    }
}
