//! Postgres-backed session transcript search (schema `session_search`): the
//! raw user/assistant text of every session under a full-text index, with no
//! embeddings. Rows are append-only: compaction may drop old messages from a
//! session, but their search rows stay, so earlier conversation remains
//! findable until the session itself is deleted. The one rewrite: a value
//! marked sensitive replaces the rows that hold it (`replace_messages`).

use mixdog_js::{js_trim, js_words, JsRegex, utf16_len};
use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::Value;

use crate::memory::error::Result;
use crate::memory::ingest_shape::{
    normalize_ingest_role, session_message_content_for_ingest, should_exclude_ingest_message, stable_session_source_ref,
};
use crate::memory::pg::db::Db;
use crate::memory::query_terms::build_fts_prefix_query;

const DDL: &str = "
CREATE SCHEMA IF NOT EXISTS session_search;
CREATE TABLE IF NOT EXISTS session_search.messages (
  source_ref  text PRIMARY KEY,
  session_id  text NOT NULL,
  ordinal     integer NOT NULL,
  role        text NOT NULL CHECK (role IN ('user','assistant')),
  ts          bigint,
  content     text NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE TABLE IF NOT EXISTS session_search.backfill (
  session_id text PRIMARY KEY,
  stamp      text NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON session_search.messages (session_id, ordinal);
CREATE INDEX IF NOT EXISTS messages_tsv_idx ON session_search.messages USING GIN (tsv);
";

/// `to_tsvector` rejects a document over 1 MB; a single message never needs
/// more searchable text than this (in UTF-16 code units).
const MAX_CONTENT_UNITS: usize = 100_000;
const SNIPPET_START: char = '\u{2}';
const SNIPPET_STOP: char = '\u{3}';

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRow {
    pub source_ref: String,
    pub session_id: String,
    pub ordinal: i32,
    pub role: &'static str,
    pub ts: Option<i64>,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionHit {
    pub session_id: String,
    pub rank: f64,
    pub snippet: String,
}

fn message_ts(message: &Value) -> Option<i64> {
    let raw = message.get("ts").filter(|v| !v.is_null()).or_else(|| message.get("timestamp"))?;
    let numeric = match raw {
        Value::Number(n) => n.as_f64(),
        Value::String(text) if js_trim(text).is_empty() => Some(0.0),
        Value::String(text) => Some(mixdog_js::string_to_number(text)),
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        _ => None,
    };
    if let Some(n) = numeric.filter(|n| n.is_finite() && *n > 0.0) {
        return Some(n.floor() as i64);
    }
    let text = match raw {
        Value::String(text) => text.as_str(),
        _ => return None,
    };
    chrono::DateTime::parse_from_rfc3339(js_trim(text))
        .map(|time| time.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(js_trim(text), "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|time| time.and_utc().timestamp_millis())
        })
}

/// Cuts `text` to at most `MAX_CONTENT_UNITS` UTF-16 code units.
fn cap_content(text: &str) -> String {
    if utf16_len(text) <= MAX_CONTENT_UNITS {
        return text.to_owned();
    }
    mixdog_js::slice_utf16(text, MAX_CONTENT_UNITS)
}

fn strip_system_reminders(text: &str) -> String {
    static REMINDER: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| {
        JsRegex::new_static(r"<system-reminder>[\s\S]*?</system-reminder>", "gi")
    });
    REMINDER.replace_all_with(text, |_| " ".into())
}

/// Search rows for a transcript: the human/model prose the memory ingest keeps
/// (synthetic, tool and runtime rows excluded), minus system reminders.
/// `ordinal` is the message's index in `messages`.
pub fn search_rows(session_id: &str, messages: &[Value]) -> Vec<SearchRow> {
    let mut rows = Vec::new();
    if session_id.is_empty() {
        return rows;
    }
    for (index, message) in messages.iter().enumerate() {
        if !message.is_object() {
            continue;
        }
        let Some(role) = normalize_ingest_role(message.get("role")) else { continue };
        if should_exclude_ingest_message(message) {
            continue;
        }
        let raw = session_message_content_for_ingest(message);
        let content = cap_content(js_trim(&strip_system_reminders(&raw)));
        if content.is_empty() {
            continue;
        }
        rows.push(SearchRow {
            source_ref: stable_session_source_ref(session_id, message, role, &raw, index),
            session_id: session_id.to_owned(),
            ordinal: i32::try_from(index).unwrap_or(i32::MAX),
            role,
            ts: message_ts(message),
            content,
        });
    }
    rows
}

#[derive(Clone)]
pub struct SessionSearchDb {
    db: Db,
}

async fn insert_rows(client: &impl tokio_postgres::GenericClient, rows: &[SearchRow]) -> Result<u64> {
    if rows.is_empty() {
        return Ok(0);
    }
    let refs: Vec<&str> = rows.iter().map(|r| r.source_ref.as_str()).collect();
    let sessions: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
    let ordinals: Vec<i32> = rows.iter().map(|r| r.ordinal).collect();
    let roles: Vec<&str> = rows.iter().map(|r| r.role).collect();
    let stamps: Vec<Option<i64>> = rows.iter().map(|r| r.ts).collect();
    let contents: Vec<&str> = rows.iter().map(|r| r.content.as_str()).collect();
    Ok(client
        .execute(
            "INSERT INTO session_search.messages (source_ref, session_id, ordinal, role, ts, content)
             SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::bigint[], $6::text[])
             ON CONFLICT (source_ref) DO NOTHING",
            &[&refs, &sessions, &ordinals, &roles, &stamps, &contents],
        )
        .await?)
}

impl SessionSearchDb {
    pub async fn open(db: Db) -> Result<Self> {
        db.bootstrap_schema(DDL).await?;
        Ok(Self { db })
    }

    /// Idempotent append of a transcript's searchable messages; returns the
    /// count of newly stored rows. Re-sending a stored message is a no-op.
    pub async fn append(&self, session_id: &str, messages: &[Value]) -> Result<u64> {
        let rows = search_rows(session_id, messages);
        if rows.is_empty() {
            return Ok(0);
        }
        let client = self.db.client().await?;
        insert_rows(&**client, &rows).await
    }

    /// In one transaction: every stored row of `session_id` whose content
    /// `redact` changes is deleted, the rows of the transcript as stored
    /// (`redacted_messages`) are written, and a deleted row that is no message
    /// of the transcript is written again with its content redacted.
    ///
    /// A row is matched to its message by its own identity (role, original
    /// timestamp or else ordinal, tool ids, content): the identity
    /// `plain_messages` — the same transcript before redaction — gives that
    /// message. Every other deleted row (its message was compacted away) has
    /// no message to derive an identity from; its replacement gets a fresh
    /// random id, so no two rows merge and no id is derived from the
    /// plaintext. Returns the count of deleted rows.
    ///
    /// `FOR UPDATE` locks only rows that exist: a write of the same session
    /// still in flight is not seen, so callers must not overlap it with this
    /// one (the ingest queue runs a session's writes one at a time).
    pub async fn replace(
        &self,
        session_id: &str,
        plain_messages: &[Value],
        redacted_messages: &[Value],
        redact: &(dyn Fn(&str) -> String + Sync),
    ) -> Result<usize> {
        let rows = search_rows(session_id, redacted_messages);
        let previous: HashSet<String> =
            search_rows(session_id, plain_messages).into_iter().map(|row| row.source_ref).collect();
        let mut client = self.db.client().await?;
        let tx = client.transaction().await?;
        let stored = tx
            .query(
                "SELECT source_ref, ordinal, role, ts, content FROM session_search.messages
                  WHERE session_id = $1 FOR UPDATE",
                &[&session_id],
            )
            .await?;
        let mut changed = Vec::new();
        for row in &stored {
            let content: String = row.get(4);
            let redacted = redact(&content);
            if redacted != content {
                changed.push((row, redacted));
            }
        }
        if !changed.is_empty() {
            let refs: Vec<String> = changed.iter().map(|(row, _)| row.get::<_, String>(0)).collect();
            tx.execute("DELETE FROM session_search.messages WHERE source_ref = ANY($1::text[])", &[&refs]).await?;
        }
        let mut all = rows;
        for (row, content) in &changed {
            let source_ref: String = row.get(0);
            if previous.contains(&source_ref) {
                continue;
            }
            let role: String = row.get(2);
            all.push(SearchRow {
                source_ref: format!("session:{session_id}:{}", random_hex()),
                session_id: session_id.to_owned(),
                ordinal: row.get(1),
                role: if role == "user" { "user" } else { "assistant" },
                ts: row.get(3),
                content: content.clone(),
            });
        }
        insert_rows(&*tx, &all).await?;
        let deleted = changed.len();
        tx.commit().await?;
        Ok(deleted)
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        self.db.execute("DELETE FROM session_search.messages WHERE session_id = $1", &[&session_id]).await?;
        self.db.execute("DELETE FROM session_search.backfill WHERE session_id = $1", &[&session_id]).await?;
        Ok(())
    }

    /// Every session id that still has search rows or a backfill stamp.
    pub async fn session_ids(&self) -> Result<BTreeSet<String>> {
        let rows = self
            .db
            .query(
                "SELECT DISTINCT session_id FROM session_search.messages
                 UNION SELECT session_id FROM session_search.backfill",
                &[],
            )
            .await?;
        Ok(rows.iter().map(|row| row.get::<_, String>(0)).collect())
    }

    /// Backfill progress: session id → stamp of the record last ingested.
    pub async fn backfill_stamps(&self) -> Result<BTreeMap<String, String>> {
        let rows = self.db.query("SELECT session_id, stamp FROM session_search.backfill", &[]).await?;
        Ok(rows.iter().map(|row| (row.get(0), row.get(1))).collect())
    }

    pub async fn record_backfill_stamp(&self, session_id: &str, stamp: &str) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO session_search.backfill (session_id, stamp) VALUES ($1, $2)
                 ON CONFLICT (session_id) DO UPDATE SET stamp = EXCLUDED.stamp",
                &[&session_id, &stamp],
            )
            .await?;
        Ok(())
    }

    /// The best-matching message of each session, strongest sessions first.
    /// An empty or unsearchable query returns nothing.
    pub async fn search(&self, query: &str, limit: i64) -> Result<Vec<SessionHit>> {
        let Some(fts) = build_fts_prefix_query(query) else {
            return Ok(Vec::new());
        };
        let rows = self
            .db
            .query(
                &format!(
                    "WITH q AS (SELECT to_tsquery('simple', $1) AS query),
                     hits AS (
                       SELECT m.session_id, m.content, ts_rank_cd(m.tsv, q.query) AS rank,
                              row_number() OVER (
                                PARTITION BY m.session_id
                                ORDER BY ts_rank_cd(m.tsv, q.query) DESC, m.ordinal DESC
                              ) AS pick
                       FROM session_search.messages m, q
                       WHERE m.tsv @@ q.query
                     )
                     SELECT hits.session_id, hits.rank::float8 AS rank,
                            ts_headline('simple', hits.content, q.query,
                              'StartSel={SNIPPET_START}, StopSel={SNIPPET_STOP}, MaxWords=24, MinWords=8, MaxFragments=1') AS snippet
                     FROM hits, q
                     WHERE hits.pick = 1
                     ORDER BY hits.rank DESC
                     LIMIT $2"
                ),
                &[&fts, &limit],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let snippet: Option<String> = row.get("snippet");
                let cleaned: String = snippet.unwrap_or_default().replace([SNIPPET_START, SNIPPET_STOP], "");
                SessionHit {
                    session_id: row.get("session_id"),
                    rank: row.get::<_, f64>("rank"),
                    snippet: js_words(&cleaned).collect::<Vec<_>>().join(" "),
                }
            })
            .collect())
    }
}

fn random_hex() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
