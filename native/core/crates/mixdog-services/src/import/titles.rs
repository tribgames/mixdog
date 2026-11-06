//! The thread titles Codex itself stores, by thread id (read-only):
//!
//! - `state_<N>.sqlite` `threads.title`, overridden by `threads.name` (a rename)
//! - `session_index.jsonl`: append-only `{ id, thread_name }`; the latest non-empty name of an
//!   id wins and overrides the database
//!
//! Anything unreadable is skipped: a missing or locked store leaves the conversation to the
//! title derived from its messages.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[allow(clippy::disallowed_types, reason = "Codex's foreign database, read in a maintenance-lane job")]
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use super::turns::title_from_text;

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a maintenance-lane job")]
fn newest_state_db(home: &Path) -> Option<PathBuf> {
    let mut newest: Option<(u64, String)> = None;
    for entry in std::fs::read_dir(home).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        let Some(version) = lower.strip_prefix("state_").and_then(|r| r.strip_suffix(".sqlite")) else { continue };
        if version.is_empty() || !version.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(version) = version.parse::<u64>() else { continue };
        if newest.as_ref().is_none_or(|(v, _)| version > *v) {
            newest = Some((version, name));
        }
    }
    newest.map(|(_, name)| home.join(name))
}

// Codex's own state database is read-only foreign data: mixdog-store::sqlite serves only the
// index it owns, so this one connection is opened here, inside a maintenance-lane job.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "reads Codex's foreign database; runs as a maintenance-lane job")]
fn read_state_titles(home: &Path, titles: &mut HashMap<String, String>) -> rusqlite::Result<()> {
    let Some(path) = newest_state_db(home) else { return Ok(()) };
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(threads)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    let wanted: Vec<&str> = ["title", "name"].into_iter().filter(|c| columns.iter().any(|x| x == c)).collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let mut statement = db.prepare(&format!("SELECT id, {} FROM threads", wanted.join(", ")))?;
    let rows: Vec<(Option<String>, Vec<Option<String>>)> = statement
        .query_map([], |row| {
            let id = row.get::<_, Option<String>>(0).ok().flatten();
            let values = (0..wanted.len()).map(|i| row.get::<_, Option<String>>(i + 1).ok().flatten()).collect();
            Ok((id, values))
        })?
        .collect::<rusqlite::Result<_>>()?;
    // `title` first, then `name`: a rename overrides.
    for (column, _) in wanted.iter().enumerate() {
        for (id, values) in &rows {
            if let (Some(id), Some(Some(text))) = (id, values.get(column)) {
                if let Some(title) = title_from_text(text) {
                    titles.insert(id.clone(), title);
                }
            }
        }
    }
    Ok(())
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job")]
fn read_index_titles(home: &Path, titles: &mut HashMap<String, String>) {
    let Ok(text) = std::fs::read_to_string(home.join("session_index.jsonl")) else { return };
    for line in text.split('\n').filter(|l| !mixdog_js::js_trim(l).is_empty()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        let title = entry.get("thread_name").and_then(Value::as_str).and_then(title_from_text);
        if let (Some(title), Some(id)) = (title, entry.get("id").and_then(Value::as_str)) {
            titles.insert(id.to_owned(), title);
        }
    }
}

/// Codex thread id → its stored title (whitespace-normalized, at most 100 characters).
pub fn load_codex_thread_titles(home: &Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    // An unreadable store falls back to the session index and derived titles.
    let _ = read_state_titles(home, &mut titles);
    read_index_titles(home, &mut titles);
    titles
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_overrides_title_and_the_index_overrides_both() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        for (n, title) in [(1, "stale db"), (3, "db title")] {
            let db = Connection::open(home.join(format!("state_{n}.sqlite"))).unwrap();
            db.execute_batch("CREATE TABLE threads (id TEXT, title TEXT, name TEXT)").unwrap();
            db.execute("INSERT INTO threads VALUES ('t1', ?1, NULL), ('t2', 'two', 'renamed  two'), ('t3', 'three', '')", [title]).unwrap();
        }
        std::fs::write(
            home.join("session_index.jsonl"),
            "{\"id\":\"t3\",\"thread_name\":\"from index\"}\nbroken\n{\"id\":\"t3\",\"thread_name\":\"  \"}\n",
        )
        .unwrap();
        let titles = load_codex_thread_titles(home);
        assert_eq!(titles["t1"], "db title", "the newest state database wins");
        assert_eq!(titles["t2"], "renamed two");
        assert_eq!(titles["t3"], "from index");
    }

    #[test]
    fn missing_home_is_empty() {
        assert!(load_codex_thread_titles(Path::new("/definitely/not/here")).is_empty());
    }
}
