//! Room log rows and what a member is shown of them. Rows are the log's JSON rows: what a member or
//! the supervisor is handed is those rows themselves, every field kept.

use serde_json::Value;

/// First-time members see at most this many earlier rows.
const FIRST_TURN_ROWS: usize = 40;

fn kind_of(row: &Value) -> Option<&str> {
    row.get("kind").and_then(Value::as_str)
}

fn id_of(row: &Value) -> Option<&str> {
    row.get("id").and_then(Value::as_str)
}

/// True while the user's newest message has no member speech after it.
pub fn room_user_waiting(rows: &[Value]) -> bool {
    for row in rows.iter().rev() {
        match kind_of(row) {
            Some("user") => return true,
            Some("speech") => return false,
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
/// passes and notices are left out. `""` is no cursor / no seen row.
pub fn rows_since_cursor(rows: &[Value], cursor: &str, agent_id: &str, seen_id: &str) -> Vec<Value> {
    let position = |id: &str| (!id.is_empty()).then(|| rows.iter().position(|row| id_of(row) == Some(id))).flatten();
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
        rows.iter().rposition(|row| kind_of(row) == Some("user")).unwrap_or(tail)
    };
    let mut fresh = Vec::new();
    for (index, row) in rows.iter().enumerate().skip(start) {
        let speaker = row.get("speaker").and_then(Value::as_str);
        let counts = match kind_of(row) {
            Some("user") => true,
            Some("speech") => speaker != Some(agent_id),
            _ => false,
        };
        if !counts {
            continue;
        }
        let mut row = row.clone();
        if seen.is_some_and(|seen| index <= seen) {
            row["seen"] = Value::Bool(true);
        }
        fresh.push(row);
    }
    fresh
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str, kind: &str, speaker: &str) -> Value {
        json!({ "id": id, "kind": kind, "speaker": speaker, "text": "" })
    }

    fn ids(rows: &[Value]) -> Vec<&str> {
        rows.iter().map(|r| r["id"].as_str().unwrap()).collect()
    }

    #[test]
    fn waiting_until_a_speech_follows_the_user() {
        let user = row("1", "user", "");
        let speech = row("2", "speech", "a");
        assert!(room_user_waiting(&[user.clone()]));
        assert!(room_user_waiting(&[user.clone(), row("3", "pass", "a")]));
        assert!(!room_user_waiting(&[user, speech]));
        assert!(!room_user_waiting(&[]));
    }

    #[test]
    fn rows_after_the_cursor_exclude_own_speech_and_notices() {
        let rows = vec![row("1", "user", ""), row("2", "speech", "a"), row("3", "speech", "b"), row("4", "pass", "b"), row("5", "user", "")];
        assert_eq!(ids(&rows_since_cursor(&rows, "1", "a", "")), ["3", "5"]);
        assert_eq!(ids(&rows_since_cursor(&rows, "", "a", "")), ["1", "3", "5"]);
    }

    #[test]
    fn a_lost_cursor_resumes_after_the_seen_row_or_at_the_open_request() {
        let rows = vec![row("1", "user", ""), row("2", "speech", "b"), row("3", "user", "")];
        assert_eq!(ids(&rows_since_cursor(&rows, "gone", "a", "2")), ["3"]);
        assert_eq!(ids(&rows_since_cursor(&rows, "gone", "a", "gone2")), ["3"]);
    }

    #[test]
    fn rows_up_to_the_seen_id_are_context() {
        let rows = vec![row("1", "user", ""), row("2", "speech", "b"), row("3", "user", "")];
        let got = rows_since_cursor(&rows, "", "a", "2");
        assert_eq!(got.iter().map(|r| r.get("seen").is_some()).collect::<Vec<_>>(), [true, true, false]);
    }
}
