//! A recall row: one `entries` record plus the retrieval evidence and render
//! annotations the pipeline attaches to it. Every query selects its own subset
//! of columns; a column a query leaves out reads as absent.

use std::cmp::Ordering;

use tokio_postgres::types::{FromSql, IsNull, ToSql, Type, to_sql_checked};

/// A bind parameter. Each variant is sent in the binary format of the type the
/// statement declares for its placeholder, so a placeholder must be matched
/// with the variant of that type.
#[derive(Debug, Clone)]
pub enum P {
    /// bigint
    I(i64),
    /// smallint
    I2(i16),
    /// integer
    I4(i32),
    /// text
    T(String),
    TA(Vec<String>),
    IA(Vec<i64>),
    /// jsonb
    J(serde_json::Value),
    /// SQL NULL, for a placeholder of any type.
    Null,
    /// A literal in the text format, parsed by the placeholder type's input function (as node-postgres sends every
    /// parameter): a `halfvec` from `[1,2,…]`.
    Lit(String),
}

impl ToSql for P {
    fn to_sql(&self, ty: &Type, out: &mut bytes::BytesMut) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match self {
            Self::I(v) => v.to_sql(ty, out),
            Self::I2(v) => v.to_sql(ty, out),
            Self::I4(v) => v.to_sql(ty, out),
            Self::T(v) => v.to_sql(ty, out),
            Self::TA(v) => v.to_sql(ty, out),
            Self::IA(v) => v.to_sql(ty, out),
            Self::J(v) => v.to_sql(ty, out),
            Self::Null => Ok(IsNull::Yes),
            Self::Lit(v) => {
                out.extend_from_slice(v.as_bytes());
                Ok(IsNull::No)
            }
        }
    }

    fn accepts(_: &Type) -> bool {
        true
    }

    fn encode_format(&self, _: &Type) -> tokio_postgres::types::Format {
        match self {
            Self::Lit(_) => tokio_postgres::types::Format::Text,
            _ => tokio_postgres::types::Format::Binary,
        }
    }

    to_sql_checked!();
}

/// `&[&dyn ToSql]` over a parameter list.
pub fn refs(params: &[P]) -> Vec<&(dyn ToSql + Sync)> {
    params.iter().map(|p| p as &(dyn ToSql + Sync)).collect()
}

#[derive(Debug, Clone, Default)]
pub struct Row {
    pub id: i64,
    pub ts: i64,
    pub role: Option<String>,
    pub content: Option<String>,
    pub source_ref: Option<String>,
    pub session_id: Option<String>,
    pub source_turn: Option<i32>,
    pub time_source: Option<String>,
    pub chunk_root: Option<i64>,
    pub is_root: i16,
    pub concept_id: Option<i64>,
    pub supersedes_id: Option<i64>,
    pub element: Option<String>,
    pub category: Option<String>,
    pub summary: Option<String>,
    pub project_id: Option<String>,
    pub status: Option<String>,
    pub score: Option<f64>,
    pub last_seen_at: Option<i64>,
    pub duplicate_of: Option<i64>,
    pub chunk_quality: Option<serde_json::Value>,
    pub matched_concept_id: Option<i64>,
    pub anchor_order: Option<i32>,
    pub event_key: Option<String>,
    // Retrieval lanes of the hybrid candidate query.
    pub dense_sim: Option<f64>,
    pub dense_rank: Option<i64>,
    pub sparse_lex: Option<f64>,
    pub sparse_rank: Option<i64>,
    pub trg_sim: Option<f64>,
    pub trgm_rank: Option<i64>,
    pub exact_hits: Option<f64>,
    pub exact_phrase_hits: Option<f64>,
    pub exact_rarity: Option<f64>,
    pub exact_rank: Option<i64>,
    // Pipeline annotations.
    pub rrf: Option<f64>,
    pub retrieval_score: Option<f64>,
    pub retrieval_rank: Option<usize>,
    pub retrieval_evidence: Option<&'static str>,
    pub concept_expanded: bool,
    pub concept_ids: Vec<i64>,
    pub members: Option<Vec<Row>>,
    pub dup_stub: bool,
    pub dup_of: Option<i64>,
    pub historical_root_element: Option<String>,
    pub historical_root_summary: Option<String>,
    pub compact_body: bool,
    /// The member ids a compact body stands for (`_compactMemberIds`), as strings.
    pub compact_member_ids: Option<Vec<String>>,
    pub compact_raw: bool,
    /// A curated core-memory row: `id` is the negated core id, shown as `core:N`.
    pub core: bool,
}

/// Text of any column type that is sent as text on the wire (enums).
struct AnyText(String);

impl<'a> FromSql<'a> for AnyText {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(Self(std::str::from_utf8(raw)?.to_owned()))
    }

    fn accepts(_: &Type) -> bool {
        true
    }
}

fn column<'a, T: FromSql<'a>>(row: &'a tokio_postgres::Row, name: &str) -> Option<T> {
    let index = row.columns().iter().position(|c| c.name() == name)?;
    row.get::<_, Option<T>>(index)
}

/// A REAL column as the shortest decimal that round-trips, so `1.4` stays `1.4`.
fn real(row: &tokio_postgres::Row, name: &str) -> Option<f64> {
    column::<f32>(row, name).and_then(|v| v.to_string().parse().ok())
}

/// A column that is REAL in one form of a statement and DOUBLE PRECISION in another (`ts_rank_cd` vs `NULL::float8`).
fn real_or_double(row: &tokio_postgres::Row, name: &str) -> Option<f64> {
    let column = row.columns().iter().find(|c| c.name() == name)?;
    if *column.type_() == Type::FLOAT4 { real(row, name) } else { self::column(row, name) }
}

impl Row {
    pub fn from_pg(row: &tokio_postgres::Row) -> Self {
        Self {
            id: column(row, "id").unwrap_or_default(),
            ts: column(row, "ts").unwrap_or_default(),
            role: column(row, "role"),
            content: column(row, "content"),
            source_ref: column(row, "source_ref"),
            session_id: column(row, "session_id"),
            source_turn: column(row, "source_turn"),
            time_source: column(row, "time_source"),
            chunk_root: column(row, "chunk_root"),
            is_root: column(row, "is_root").unwrap_or_default(),
            concept_id: column(row, "concept_id"),
            supersedes_id: column(row, "supersedes_id"),
            element: column(row, "element"),
            category: column(row, "category"),
            summary: column(row, "summary"),
            project_id: column(row, "project_id"),
            status: column::<AnyText>(row, "status").map(|s| s.0),
            score: real(row, "score"),
            last_seen_at: column(row, "last_seen_at"),
            duplicate_of: column(row, "duplicate_of"),
            chunk_quality: column(row, "chunk_quality"),
            matched_concept_id: column(row, "matched_concept_id"),
            anchor_order: column(row, "_anchor_order"),
            event_key: column(row, "_event_key"),
            dense_sim: column(row, "dense_sim"),
            dense_rank: column(row, "dense_rank"),
            sparse_lex: real_or_double(row, "sparse_lex"),
            sparse_rank: column(row, "sparse_rank"),
            trg_sim: column(row, "trg_sim"),
            trgm_rank: column(row, "trgm_rank"),
            exact_hits: column(row, "exact_hits"),
            exact_phrase_hits: column(row, "exact_phrase_hits"),
            exact_rarity: column(row, "exact_rarity"),
            exact_rank: column(row, "exact_rank"),
            ..Self::default()
        }
    }

    /// The id as it is printed after `#`.
    pub fn display_id(&self) -> String {
        if self.core { format!("core:{}", -self.id) } else { self.id.to_string() }
    }

    /// The id comparators see: a core id is not a number there.
    pub fn sort_id(&self) -> i64 {
        if self.core { 0 } else { self.id }
    }

    pub fn content(&self) -> &str {
        self.content.as_deref().unwrap_or_default()
    }

    pub fn element(&self) -> &str {
        self.element.as_deref().unwrap_or_default()
    }

    pub fn summary(&self) -> &str {
        self.summary.as_deref().unwrap_or_default()
    }

    pub fn session(&self) -> &str {
        self.session_id.as_deref().unwrap_or_default()
    }

    pub fn role(&self) -> &str {
        self.role.as_deref().unwrap_or_default()
    }

    /// `retrievalScore ?? rrf ?? 0`.
    pub fn retrieval_value(&self) -> f64 {
        self.retrieval_score.or(self.rrf).unwrap_or(0.0)
    }

    pub fn member_list(&self) -> &[Row] {
        self.members.as_deref().unwrap_or_default()
    }
}

/// The sign of a JS comparator difference: negative sorts first, and a NaN or
/// zero difference falls through to the next key.
pub fn by_diff(diff: f64) -> Ordering {
    if diff < 0.0 {
        Ordering::Less
    } else if diff > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// Newest first: ts, then the turn within the same session, then id.
pub fn compare_newest_first(a: &Row, b: &Row) -> Ordering {
    if a.ts != b.ts {
        return b.ts.cmp(&a.ts);
    }
    if !a.session().is_empty() && a.session() == b.session()
        && let (Some(turn_a), Some(turn_b)) = (a.source_turn, b.source_turn)
            && turn_a != turn_b {
                return turn_b.cmp(&turn_a);
            }
    b.sort_id().cmp(&a.sort_id())
}

/// Oldest first, the reverse of `compare_newest_first`.
pub fn compare_oldest_first(a: &Row, b: &Row) -> Ordering {
    compare_newest_first(b, a)
}

/// Relevance order: retrieval score, stored score, newest ts, id ascending.
pub fn compare_by_score(a: &Row, b: &Row) -> Ordering {
    by_diff(b.retrieval_value() - a.retrieval_value())
        .then_with(|| by_diff(b.score.unwrap_or(0.0) - a.score.unwrap_or(0.0)))
        .then_with(|| by_diff((b.ts - a.ts) as f64))
        .then_with(|| a.sort_id().cmp(&b.sort_id()))
}

/// Rows with a unique id, first occurrence kept.
pub fn unique_rows_by_id(rows: impl IntoIterator<Item = Row>) -> Vec<Row> {
    let mut seen = std::collections::HashSet::new();
    rows.into_iter().filter(|row| seen.insert(row.id)).collect()
}
