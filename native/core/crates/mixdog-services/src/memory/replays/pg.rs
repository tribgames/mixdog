//! A private PostgreSQL cluster per replay (the shared `memory::tests::support::TestPg`, which reads `MIXDOG_PG_RUNTIME`,
//! starts in its own temp directory and stops the postmaster on drop; the temp directory goes with it), the memory schema
//! over it, and recorded rows written as `entries` rows. The cases that use it live in a `pg` module of their set
//! (nextest group `pg-cluster`).

use std::sync::Arc;
use std::time::Duration;

use mixdog_testkit::Exact;
use tokio_postgres::types::ToSql;

use crate::memory::pg::db::{Db, Schema};
use crate::memory::recall::period::Clock;
use crate::memory::recall::{Recall, RecallDeps};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

const START_DEADLINE: Duration = Duration::from_secs(120);

pub(crate) struct ReplayPg {
    pub db: Db,
    // Dropped after `db`: the cluster stops and its directory is removed.
    _pg: TestPg,
}

/// A fresh cluster with the memory schema.
pub(crate) async fn memory_db() -> ReplayPg {
    assert!(
        std::env::var_os("MIXDOG_PG_RUNTIME").is_some(),
        "MIXDOG_PG_RUNTIME is unset: it names the bundled PostgreSQL runtime the database replays start"
    );
    let pg = tokio::time::timeout(START_DEADLINE, TestPg::start())
        .await
        .unwrap_or_else(|_| panic!("the private PostgreSQL cluster did not start within {START_DEADLINE:?}"));
    let db = tokio::time::timeout(START_DEADLINE, async {
        let db = pg.db(Schema::Memory).await;
        ensure_memory_schema(&db, 384, &serde_json::json!({ "model": crate::memory::embed::config::DEFAULT_MODEL_ID }))
            .await
            .expect("memory schema");
        db
    })
    .await
    .unwrap_or_else(|_| panic!("the memory schema was not ready within {START_DEADLINE:?}"));
    ReplayPg { db, _pg: pg }
}

/// A statement as PostgreSQL received it: its text and its parameters as the server renders them (`NULL` is `None`).
#[derive(Debug, Clone)]
pub(crate) struct Sent {
    pub sql: String,
    pub params: Vec<Option<String>>,
}

/// What a service sends to PostgreSQL, read where PostgreSQL logs it: the database's sessions log every statement
/// (`log_statement = 'all'`, set for the database so a new session has it from its start) to the cluster's log.
pub(crate) struct Wire {
    log: std::path::PathBuf,
}

impl ReplayPg {
    /// A new `Db` over the same cluster whose sessions log what they are sent, and the log to read it from. Sessions of
    /// `self.db` (opened before) are not logged: a replay seeds and reads its tables through them.
    pub(crate) async fn observed(&self) -> (Db, Wire) {
        let database = crate::memory::pg::db::DATABASE;
        self.db
            .batch(&format!("ALTER DATABASE {database} SET log_statement = 'all'"))
            .await
            .unwrap_or_else(|e| panic!("log_statement: {}", e.message()));
        let db = tokio::time::timeout(START_DEADLINE, self._pg.db(Schema::Memory))
            .await
            .unwrap_or_else(|_| panic!("the observed connection did not open within {START_DEADLINE:?}"));
        (db, Wire { log: self._pg.dir.path().join("pg.log") })
    }
}

/// The statements tokio-postgres sends for itself, to learn a custom type's layout (`typeinfo` queries): not the
/// service's statements.
const DRIVER_LOOKUPS: [&str; 3] = [
    "SELECT t.typname, t.typtype, t.typelem, r.rngsubtype, t.typbasetype, n.nspname, t.typrelid",
    "SELECT enumlabel",
    "SELECT attname, atttypid",
];

impl Wire {
    /// Where the log ends now: the statements after it are a later `since`'s.
    pub(crate) fn mark(&self) -> u64 {
        std::fs::metadata(&self.log).map_or(0, |m| m.len())
    }

    /// The statements logged after `mark`, in the order PostgreSQL received them. A statement and its `parameters`
    /// detail are paired by the session that logged them. Each line of a message after its first starts with a tab
    /// the log adds (`append_with_tabs`); it is removed.
    pub(crate) fn since(&self, mark: u64) -> Vec<Sent> {
        use std::io::{Read, Seek};
        let mut file = std::fs::File::open(&self.log).expect("the cluster log");
        file.seek(std::io::SeekFrom::Start(mark)).expect("seek the log");
        let mut text = String::new();
        file.read_to_string(&mut text).expect("read the log");
        let prefix = regex::Regex::new(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+ \[(\d+)\]: ([A-Z]+):  ").expect("prefix");
        let mut records: Vec<(String, String, String)> = Vec::new();
        for line in text.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(m) = prefix.captures(line) {
                let rest = line[m.get(0).expect("match").end()..].to_owned();
                records.push((m[1].to_owned(), m[2].to_owned(), rest));
            } else if let Some(more) = line.strip_prefix('\t')
                && let Some(last) = records.last_mut()
            {
                last.2.push('\n');
                last.2.push_str(more);
            }
        }
        let execute = regex::Regex::new(r"^execute [^:]+: ").expect("execute");
        let mut sent: Vec<Sent> = Vec::new();
        let mut last_of: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (pid, level, message) in records {
            if level == "LOG" {
                let sql = if let Some(sql) = message.strip_prefix("statement: ") {
                    sql.to_owned()
                } else if let Some(m) = execute.find(&message) {
                    message[m.end()..].to_owned()
                } else {
                    continue;
                };
                if DRIVER_LOOKUPS.iter().any(|lookup| sql.starts_with(lookup)) {
                    last_of.remove(&pid);
                    continue;
                }
                last_of.insert(pid, sent.len());
                sent.push(Sent { sql, params: Vec::new() });
            } else if level == "DETAIL"
                && let Some(list) = message.strip_prefix("parameters: ")
                && let Some(at) = last_of.get(&pid)
            {
                sent[*at].params = parameters(list);
            }
        }
        sent
    }
}

/// `$1 = 'text', $2 = NULL, …` (quotes inside a value doubled).
fn parameters(list: &str) -> Vec<Option<String>> {
    let mut out = Vec::new();
    let mut rest = list;
    while let Some(after) = rest.strip_prefix('$') {
        let eq = after.find(" = ").expect("a parameter's ` = `");
        rest = &after[eq + 3..];
        if let Some(after) = rest.strip_prefix("NULL") {
            out.push(None);
            rest = after;
        } else {
            let body = rest.strip_prefix('\'').expect("a quoted parameter");
            let mut value = String::new();
            let mut chars = body.char_indices().peekable();
            let end = loop {
                let (i, c) = chars.next().expect("a closed quote");
                if c == '\'' {
                    if chars.peek().is_some_and(|(_, n)| *n == '\'') {
                        chars.next();
                        value.push('\'');
                        continue;
                    }
                    break i + 1;
                }
                value.push(c);
            };
            out.push(Some(value));
            rest = &body[end..];
        }
        rest = rest.strip_prefix(", ").unwrap_or(rest);
    }
    out
}

/// node-pg's text for a JavaScript parameter (`utils.prepareValue`; arrays as `arrayString`).
fn node_pg_text(value: &Exact) -> Option<String> {
    fn element(value: &Exact) -> String {
        match value {
            Exact::Null | Exact::Undefined => "NULL".to_owned(),
            Exact::Array(items) => format!("{{{}}}", items.iter().map(element).collect::<Vec<_>>().join(",")),
            other => {
                let text = node_pg_text(other).expect("an array element");
                format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
            }
        }
    }
    match value {
        Exact::Null | Exact::Undefined => None,
        Exact::Bool(b) => Some(b.to_string()),
        Exact::Number(n) => Some(mixdog_js::number_to_string(*n)),
        Exact::String(s) => Some(s.clone()),
        Exact::Array(items) => Some(format!("{{{}}}", items.iter().map(element).collect::<Vec<_>>().join(","))),
        Exact::Object(_) => Some(serde_json::to_string(&value.to_plain().expect("a JSON parameter")).expect("JSON")),
        other => panic!("a recorded parameter of a kind node-pg sends no text for here: {other:?}"),
    }
}

/// A PostgreSQL array literal's elements (`{a,"b c",NULL}`), one level.
fn array_elements(text: &str) -> Option<Vec<Option<String>>> {
    let body = text.strip_prefix('{')?.strip_suffix('}')?;
    if body.is_empty() {
        return Some(Vec::new());
    }
    let mut out = Vec::new();
    let mut chars = body.chars().peekable();
    loop {
        let mut value = String::new();
        let quoted = chars.peek() == Some(&'"');
        if quoted {
            chars.next();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => value.push(chars.next()?),
                    '"' => break,
                    c => value.push(c),
                }
            }
            out.push(Some(value));
        } else {
            while let Some(c) = chars.peek().copied().filter(|c| *c != ',') {
                chars.next();
                value.push(c);
            }
            out.push((value != "NULL").then_some(value));
        }
        match chars.next() {
            Some(',') => continue,
            None => return Some(out),
            Some(_) => return None,
        }
    }
}

/// Whether node-pg's text and the text PostgreSQL rendered for the core's parameter are the same value. node-pg
/// sends every parameter as text, tokio-postgres in binary, which the server renders with the type's output: the same
/// boolean is `true` / `t`, the same number may print differently, an array quotes its elements or not, and `jsonb`
/// renders with its own spacing and key order.
fn same_value(node: &Option<String>, core: &Option<String>) -> bool {
    match (node, core) {
        (None, None) => true,
        (Some(n), Some(c)) => {
            n == c
                || matches!((n.as_str(), c.as_str()), ("true", "t") | ("false", "f"))
                || matches!((n.parse::<f64>(), c.parse::<f64>()), (Ok(a), Ok(b)) if a == b)
                || matches!((array_elements(n), array_elements(c)), (Some(a), Some(b)) if a.len() == b.len() && a.iter().zip(&b).all(|(x, y)| same_value(x, y)))
                || matches!((serde_json::from_str::<serde_json::Value>(n), serde_json::from_str::<serde_json::Value>(c)), (Ok(a), Ok(b)) if a.is_object() && a == b)
        }
        _ => false,
    }
}

/// The recorded statements (`{sql, params}` as node-pg was called) against what the core sent, in order: the text byte
/// for byte, each parameter as the same value (`same_value`). A parameter that is the same value is written as the
/// recorded one, any other as the server rendered it, so the comparison shows every difference.
pub(crate) fn sent_as_recorded(recorded: &Exact, sent: &[Sent]) -> Exact {
    let recorded = recorded.as_array();
    Exact::Array(
        sent.iter()
            .enumerate()
            .map(|(i, statement)| {
                let want = recorded.get(i).map(|r| r.get("params").as_array().to_vec()).unwrap_or_default();
                let params = statement
                    .params
                    .iter()
                    .enumerate()
                    .map(|(j, got)| match want.get(j) {
                        Some(w) if same_value(&node_pg_text(w), got) => w.clone(),
                        _ => got.clone().map_or(Exact::Null, Exact::String),
                    })
                    .collect();
                crate::memory::replays::object(vec![
                    ("sql", Exact::String(statement.sql.clone())),
                    ("params", Exact::Array(params)),
                ])
            })
            .collect(),
    )
}

/// A value of any type read as its binary bytes as UTF-8: an enum's binary form is its label.
struct Label(String);

impl<'a> tokio_postgres::types::FromSql<'a> for Label {
    fn from_sql(_: &tokio_postgres::types::Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(Self(std::str::from_utf8(raw)?.to_owned()))
    }

    fn accepts(ty: &tokio_postgres::types::Type) -> bool {
        matches!(ty.kind(), tokio_postgres::types::Kind::Enum(_))
    }
}

/// A row as node-pg hands it to Node: columns in the statement's order; `bigint` (and `numeric`) as text, the other
/// numbers as numbers (`real` parsed from its shortest text, as node-pg parses the server's text), `jsonb` parsed,
/// enums as their label, arrays element by element.
pub(crate) fn node_pg_row(row: &tokio_postgres::Row) -> Exact {
    use tokio_postgres::types::Type;
    let value = |i: usize| -> Exact {
        let ty = row.columns()[i].type_();
        let opt = |v: Option<Exact>| v.unwrap_or(Exact::Null);
        match *ty {
            Type::INT8 => opt(row.get::<_, Option<i64>>(i).map(|n| Exact::String(n.to_string()))),
            Type::INT4 => opt(row.get::<_, Option<i32>>(i).map(|n| Exact::from(f64::from(n)))),
            Type::INT2 => opt(row.get::<_, Option<i16>>(i).map(|n| Exact::from(f64::from(n)))),
            Type::FLOAT8 => opt(row.get::<_, Option<f64>>(i).map(Exact::from)),
            Type::FLOAT4 => opt(row.get::<_, Option<f32>>(i).map(|n| Exact::from(n.to_string().parse::<f64>().expect("a real")))),
            Type::BOOL => opt(row.get::<_, Option<bool>>(i).map(Exact::Bool)),
            Type::TEXT | Type::VARCHAR | Type::NAME | Type::BPCHAR => opt(row.get::<_, Option<String>>(i).map(Exact::String)),
            Type::JSON | Type::JSONB => opt(row.get::<_, Option<serde_json::Value>>(i).map(|v| Exact::plain(&v))),
            Type::INT8_ARRAY => opt(row
                .get::<_, Option<Vec<Option<i64>>>>(i)
                .map(|v| Exact::Array(v.into_iter().map(|n| n.map_or(Exact::Null, |n| Exact::String(n.to_string()))).collect()))),
            Type::TEXT_ARRAY => opt(row
                .get::<_, Option<Vec<Option<String>>>>(i)
                .map(|v| Exact::Array(v.into_iter().map(|s| s.map_or(Exact::Null, Exact::String)).collect()))),
            _ if matches!(ty.kind(), tokio_postgres::types::Kind::Enum(_)) => opt(row.get::<_, Option<Label>>(i).map(|l| Exact::String(l.0))),
            _ => panic!("a column type this mapping has no node-pg form for: {} {ty}", row.columns()[i].name()),
        }
    };
    Exact::Object(row.columns().iter().enumerate().map(|(i, c)| (c.name().to_owned(), value(i))).collect())
}

/// The read-path statements (`recall::store::STATEMENTS`) and their answers (`recall::store::ANSWERS`) of `work`.
pub(crate) async fn read_path<T>(work: impl std::future::Future<Output = T>) -> (T, Vec<(String, Vec<P>)>, Vec<Vec<Exact>>) {
    use crate::memory::recall::store::{ANSWERS, STATEMENTS};
    STATEMENTS.with(|log| *log.borrow_mut() = Some(Vec::new()));
    ANSWERS.with(|log| *log.borrow_mut() = Some(Vec::new()));
    let out = work.await;
    let statements = STATEMENTS.with(|log| log.borrow_mut().take()).expect("statement log");
    let answers = ANSWERS.with(|log| log.borrow_mut().take()).expect("answer log");
    (out, statements, answers)
}

/// A typed parameter as node-pg's caller would have passed it (`bigint` as a number).
pub(crate) fn param(p: &P) -> Exact {
    use crate::memory::replays::{int, string};
    match p {
        P::I(n) => int(*n),
        P::I2(n) => int(i64::from(*n)),
        P::I4(n) => int(i64::from(*n)),
        P::T(text) => string(text.clone()),
        P::TA(list) => Exact::Array(list.iter().cloned().map(Exact::String).collect()),
        P::IA(list) => Exact::Array(list.iter().map(|n| int(*n)).collect()),
        P::J(value) => Exact::plain(value),
        P::Null => Exact::Null,
        P::Lit(text) => string(text.clone()),
    }
}

use crate::memory::recall::row::P;

type Param = Box<dyn ToSql + Sync + Send>;

fn text(row: &Exact, key: &str) -> Option<String> {
    match row.try_get(key) {
        Some(Exact::String(s)) => Some(s.clone()),
        Some(Exact::Null | Exact::Undefined) | None => None,
        Some(other) => panic!("{key}: not a string: {other:?}"),
    }
}

fn number(row: &Exact, key: &str) -> Option<i64> {
    match row.try_get(key) {
        Some(Exact::Number(n)) if n.fract() == 0.0 => Some(*n as i64),
        Some(Exact::Null | Exact::Undefined) | None => None,
        Some(other) => panic!("{key}: not an integer: {other:?}"),
    }
}

/// Writes recorded row objects as `entries` rows with their own ids, then their links (a link may name a later row).
/// `source_ref` is `NOT NULL UNIQUE`: a row recorded without one gets `replay:<id>`, which no rendering reads as a
/// legacy reference.
pub(crate) async fn insert_entries(db: &Db, rows: &[&Exact]) {
    for row in rows {
        let id = number(row, "id").expect("a recorded row has an id");
        let params: Vec<Param> = vec![
            Box::new(id),
            Box::new(number(row, "ts").expect("a recorded row has a ts")),
            Box::new(text(row, "role").unwrap_or_default()),
            Box::new(text(row, "content").unwrap_or_default()),
            Box::new(text(row, "source_ref").unwrap_or_else(|| format!("replay:{id}"))),
            Box::new(text(row, "session_id")),
            Box::new(text(row, "project_id")),
            Box::new(number(row, "source_turn").map(|t| t as i32)),
            Box::new(text(row, "time_source")),
            Box::new(number(row, "is_root").unwrap_or(0) as i16),
            Box::new(text(row, "element")),
            Box::new(text(row, "category")),
            Box::new(text(row, "summary")),
            Box::new(text(row, "status")),
            Box::new(number(row, "last_seen_at")),
            Box::new(row.try_get("chunk_quality").filter(|v| !matches!(v, Exact::Null | Exact::Undefined)).map(|v| {
                v.to_plain().expect("a recorded chunk_quality is JSON")
            })),
        ];
        let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p.as_ref() as &(dyn ToSql + Sync)).collect();
        db.execute(
            "INSERT INTO entries (id, ts, role, content, source_ref, session_id, project_id, source_turn, time_source, is_root,
               element, category, summary, status, last_seen_at, chunk_quality)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text::entry_status,$15,$16)",
            &refs,
        )
        .await
        .unwrap_or_else(|e| panic!("insert entry {id}: {}", e.message()));
    }
    for row in rows {
        let id = number(row, "id");
        let links = (number(row, "chunk_root"), number(row, "duplicate_of"), number(row, "concept_id"), number(row, "supersedes_id"));
        db.execute(
            "UPDATE entries SET chunk_root = $2, duplicate_of = $3, concept_id = $4, supersedes_id = $5 WHERE id = $1",
            &[&id, &links.0, &links.1, &links.2, &links.3],
        )
        .await
        .unwrap_or_else(|e| panic!("link entry {id:?}: {}", e.message()));
    }
    db.query("SELECT setval(pg_get_serial_sequence('entries','id'), (SELECT max(id) FROM entries))", &[])
        .await
        .expect("sequence");
}

/// The recall the `memory/recall` request reaches, at the recorded clock in UTC, with no embedder.
pub(crate) fn recall(db: &Db, now_ms: i64) -> Recall {
    Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(move || Clock { now_ms, zone: chrono_tz::UTC }),
        embedder: None,
        session_cwd: None,
        lane: mixdog_rt::testing::tokens().durability_io,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    })
}
