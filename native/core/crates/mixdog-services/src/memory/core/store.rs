//! User-curated core memory in `core_entries`. Each pool (project or agent)
//! has one advisory lock key; a mutation takes it for its transaction, so
//! writers of different pools never wait on each other and writers of one pool
//! serialise inside Postgres rather than in this process. Every mutation
//! checks its caller against the pool (`access`). Explicit add/edit/delete
//! affect only the requested entry; generated history never enters this
//! store. Saving never embeds: entries are injected verbatim and recalled by
//! term match.

use mixdog_js::{js_trim, slice_utf16, value_to_string};
use serde::Serialize;
use serde_json::Value;
use tokio_postgres::{Client, Row};

use crate::memory::core::access::{MemoryCaller, Pool};
use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::{Db, transaction};

/// The category vocabulary shared by curated memory, recall filters and the
/// score table, in display order.
pub const VALID_CATEGORIES: [&str; 8] =
    ["rule", "constraint", "decision", "fact", "goal", "preference", "task", "issue"];

const ELEMENT_DERIVE_LENGTH: usize = 40;
const LOCK_TIMEOUT: &str = "SET LOCAL lock_timeout = '5s'";

#[derive(Debug, Clone, Serialize)]
pub struct CoreEntry {
    pub id: i64,
    pub element: String,
    pub summary: String,
    pub category: String,
    pub project_id: Option<String>,
    pub agent_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl CoreEntry {
    /// The entry's columns by name: a row of `SELECT *`, `RETURNING *` or the stores' column list.
    fn from_row(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            element: row.get("element"),
            summary: row.get("summary"),
            category: row.get("category"),
            project_id: row.get("project_id"),
            agent_id: row.get("agent_id"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        }
    }

    pub fn pool(&self) -> Pool<'_> {
        Pool { project_id: self.project_id.as_deref(), agent_id: self.agent_id.as_deref() }
    }
}

/// The advisory-lock key of one pool.
fn pool_lock_key(project_id: Option<&str>, agent_id: Option<&str>) -> String {
    match agent_id {
        Some(agent) => format!("core:agent:{agent}"),
        None => format!("core:{}", project_id.unwrap_or("COMMON")),
    }
}

fn trim_or_null(value: Option<&Value>) -> Option<String> {
    let value = value.filter(|value| !value.is_null())?;
    let text = value_to_string(value);
    let trimmed = js_trim(&text);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Fields of a curated entry, as callers spell them.
#[derive(Debug, Default)]
pub struct CoreInput {
    pub element: Option<String>,
    pub summary: Option<String>,
    pub category: String,
    pub supplied_category: Option<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Require {
    pub element: bool,
    pub summary: bool,
    pub category: bool,
}

/// `summary` also arrives as `content`, `text`, `value` or `note`: callers send
/// the synonym they would use in prose, and accepting them removes a measured
/// class of bounced calls. The element defaults to the first 40 characters.
pub fn normalize_input(input: &Value, require: Require) -> CoreInput {
    let first = ["summary", "content", "text", "value", "note"]
        .iter()
        .find_map(|key| input.get(*key).filter(|value| !value.is_null()));
    let summary = trim_or_null(first);
    let element = trim_or_null(input.get("element"))
        .or_else(|| summary.as_deref().map(|text| slice_utf16(text, ELEMENT_DERIVE_LENGTH)));
    let supplied_category = trim_or_null(input.get("category"));
    let category = supplied_category.clone().unwrap_or_else(|| "fact".to_owned()).to_lowercase();
    let mut errors = Vec::new();
    if require.element && element.is_none() {
        errors.push("element required".to_owned());
    }
    if require.summary && summary.is_none() {
        errors.push("summary required".to_owned());
    }
    if require.category && supplied_category.is_none() {
        errors.push("category required".to_owned());
    }
    if supplied_category.is_some() && !VALID_CATEGORIES.contains(&category.as_str()) {
        errors.push(format!("invalid category \"{category}\". Valid: {}", VALID_CATEGORIES.join(", ")));
    }
    CoreInput { element, summary, category, supplied_category, errors }
}

async fn lock_pool(tx: &Client, keys: &[String]) -> Result<()> {
    tx.batch_execute(LOCK_TIMEOUT).await?;
    for key in keys {
        tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", &[key]).await?;
    }
    Ok(())
}

/// Rows already holding `element` in the pool (`findCoreKeyRows`, core-memory-uniqueness.mjs:37, its statement text).
/// Called under the pool lock; this also protects writes while a legacy store still has key conflicts and cannot
/// carry the unique index.
async fn key_rows(
    tx: &Client,
    project_id: Option<&str>,
    agent_id: Option<&str>,
    element: &str,
    except_id: Option<i64>,
) -> Result<Vec<(i64, Option<String>)>> {
    let rows = tx
        .query(
            "
    SELECT id, status FROM core_entries
    WHERE project_id IS NOT DISTINCT FROM $1 AND agent_id IS NOT DISTINCT FROM $4 AND element = $2
      AND ($3::bigint IS NULL OR id <> $3)
    ORDER BY id LIMIT 2 FOR UPDATE
  ",
            &[&project_id, &element, &except_id, &agent_id],
        )
        .await?;
    Ok(rows.iter().map(|row| (row.get(0), row.get::<_, Option<String>>(1))).collect())
}

fn already_exists(pool: Pool<'_>, element: &str) -> MemoryError {
    MemoryError::rejected(format!(
        "core entry already exists: {} element={}",
        pool.label(),
        serde_json::to_string(&slice_utf16(element, 200)).unwrap_or_default()
    ))
}

/// Adds an entry to a pool; an archived entry of the same key is revived.
pub async fn add(
    db: &Db,
    input: &Value,
    project_id: Option<&str>,
    agent_id: Option<&str>,
    caller: &MemoryCaller,
) -> Result<CoreEntry> {
    if agent_id.is_some() && project_id.is_some() {
        return Err(MemoryError::rejected("agent memory has no project scope"));
    }
    let pool = Pool { project_id, agent_id };
    caller.assert_write("add", &pool)?;
    let normalized = normalize_input(input, Require { element: true, summary: true, category: true });
    if !normalized.errors.is_empty() {
        return Err(MemoryError::rejected(normalized.errors.join("; ")));
    }
    let (element, summary) = (normalized.element.unwrap_or_default(), normalized.summary.unwrap_or_default());
    let now = now_ms();
    // `_addCoreImpl` (core-memory-store.mjs:132), its statement text.
    transaction(db, async |tx| {
        lock_pool(tx, &[pool_lock_key(project_id, agent_id)]).await?;
        let collisions = key_rows(tx, project_id, agent_id, &element, None).await?;
        if !collisions.is_empty() {
            let revivable = collisions.len() == 1 && collisions[0].1.as_deref() == Some("archived");
            if !revivable {
                return Err(MemoryError::rejected(format!("{}; use an explicit edit/delete", already_exists(pool, &element).message())));
            }
            let revived = tx
                .query_one(
                    "UPDATE core_entries SET summary = $1, category = $2,
           status = 'active', archived_at = NULL, updated_at = $3
         WHERE id = $4
         RETURNING id, element, summary, category, project_id, agent_id, created_at, updated_at",
                    &[&summary, &normalized.category, &now, &collisions[0].0],
                )
                .await?;
            return Ok(CoreEntry::from_row(&revived));
        }
        let inserted = tx
            .query_one(
                "INSERT INTO core_entries(element, summary, category, project_id, agent_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, element, summary, category, project_id, agent_id, created_at, updated_at",
                &[&element, &summary, &normalized.category, &project_id, &agent_id, &now, &now],
            )
            .await?;
        Ok(CoreEntry::from_row(&inserted))
    })
    .await
}

/// What an edit may change: the text, and the project of a project-pool entry.
pub struct Edit<'a> {
    pub input: &'a Value,
    pub expected_project_id: Option<&'a str>,
    pub expected_agent_id: Option<&'a str>,
    pub target_project_id: Option<&'a str>,
    pub caller: &'a MemoryCaller,
}

/// `_editCoreImpl` (core-memory-store.mjs:192), its statement text.
pub async fn edit(db: &Db, id: i64, request: Edit<'_>) -> Result<CoreEntry> {
    let current = db
        .query_opt("SELECT * FROM core_entries WHERE id = $1", &[&id])
        .await?
        .map(|row| CoreEntry::from_row(&row))
        .ok_or_else(|| MemoryError::rejected(format!("no entry with id={id}")))?;
    if request.expected_project_id != current.project_id.as_deref() {
        return Err(MemoryError::rejected(format!(
            "entry id={id} is not in project {}",
            request.expected_project_id.unwrap_or("COMMON")
        )));
    }
    if request.expected_agent_id != current.agent_id.as_deref() {
        return Err(MemoryError::rejected(format!(
            "entry id={id} is not in {}",
            Pool { project_id: None, agent_id: request.expected_agent_id }.label()
        )));
    }
    let agent_id = current.agent_id.as_deref();
    let incoming = normalize_input(request.input, Require::default());
    let element = incoming.element.unwrap_or_else(|| current.element.clone());
    let summary = incoming.summary.unwrap_or_else(|| current.summary.clone());
    let category = if incoming.supplied_category.is_some() { incoming.category } else { current.category.clone() };
    let target_project = request.target_project_id;
    if agent_id.is_some() && target_project.is_some() {
        return Err(MemoryError::rejected("agent memory has no project scope"));
    }
    request.caller.assert_write("edit", &current.pool())?;
    if target_project != current.project_id.as_deref() {
        request.caller.assert_write("edit", &Pool { project_id: target_project, agent_id })?;
    }
    let changed = normalize_input(
        &serde_json::json!({ "element": element, "summary": summary, "category": category }),
        Require { element: true, summary: true, category: true },
    );
    if !changed.errors.is_empty() {
        return Err(MemoryError::rejected(changed.errors.join("; ")));
    }
    let project_changed = target_project != current.project_id.as_deref();
    let text_changed = element != current.element || summary != current.summary;
    if !text_changed && !project_changed && category == current.category {
        return Err(MemoryError::rejected("no change"));
    }
    let now = now_ms();
    let edited = |current: CoreEntry| CoreEntry {
        element: element.clone(),
        summary: summary.clone(),
        category: category.clone(),
        project_id: target_project.map(str::to_owned),
        updated_at: now,
        ..current
    };
    if !text_changed && !project_changed {
        // Optimistic guard on the snapshot this patch was computed against.
        let updated = db
            .execute(
                "UPDATE core_entries SET category = $1, updated_at = $2
       WHERE id = $3 AND element = $4 AND summary = $5
         AND updated_at IS NOT DISTINCT FROM $6::bigint",
                &[&category, &now, &id, &current.element, &current.summary, &current.updated_at],
            )
            .await?;
        if updated == 0 {
            return Err(MemoryError::rejected(format!("core entry id={id} changed concurrently — re-read and retry")));
        }
        return Ok(edited(current));
    }
    let mut lock_keys =
        vec![pool_lock_key(current.project_id.as_deref(), agent_id), pool_lock_key(target_project, agent_id)];
    lock_keys.sort();
    lock_keys.dedup();
    transaction(db, async |tx| {
        lock_pool(tx, &lock_keys).await?;
        // The snapshot above was read before any lock: revalidate under it, so a
        // concurrent edit is never silently overwritten by a patch computed from
        // older content.
        let fresh = tx
            .query_opt("SELECT * FROM core_entries WHERE id = $1 FOR UPDATE", &[&id])
            .await?
            .map(|row| CoreEntry::from_row(&row))
            .ok_or_else(|| MemoryError::rejected(format!("no entry with id={id}")))?;
        if fresh.element != current.element
            || fresh.summary != current.summary
            || fresh.category != current.category
            || fresh.project_id != current.project_id
            || fresh.agent_id != current.agent_id
            || fresh.updated_at != current.updated_at
        {
            return Err(MemoryError::rejected(format!("core entry id={id} changed concurrently — re-read and retry")));
        }
        if (element != current.element || project_changed)
            && !key_rows(tx, target_project, agent_id, &element, Some(id)).await?.is_empty()
        {
            return Err(already_exists(Pool { project_id: target_project, agent_id }, &element));
        }
        tx.execute(
            "UPDATE core_entries
       SET element = $1, summary = $2, category = $3, project_id = $4, updated_at = $5
       WHERE id = $6",
            &[&element, &summary, &category, &target_project, &now, &id],
        )
        .await?;
        Ok(())
    })
    .await?;
    Ok(edited(current))
}

/// Deletes one entry of the pool the caller named and was authorised for.
pub async fn delete(
    db: &Db,
    id: i64,
    expected_project_id: Option<&str>,
    expected_agent_id: Option<&str>,
    caller: &MemoryCaller,
) -> Result<CoreEntry> {
    let current = db
        .query_opt("SELECT project_id, agent_id FROM core_entries WHERE id = $1", &[&id])
        .await?;
    let missing = || MemoryError::rejected(format!("no entry with id={id}"));
    let current = current.ok_or_else(missing)?;
    let (project, agent): (Option<String>, Option<String>) = (current.get(0), current.get(1));
    if expected_project_id != project.as_deref() || expected_agent_id != agent.as_deref() {
        return Err(missing());
    }
    caller.assert_write("delete", &Pool { project_id: project.as_deref(), agent_id: agent.as_deref() })?;
    // The pool just authorised: a concurrent move out of it deletes nothing.
    let removed = db
        .query_opt(
            "DELETE FROM core_entries WHERE id = $1
       AND project_id IS NOT DISTINCT FROM $2 AND agent_id IS NOT DISTINCT FROM $3 RETURNING *",
            &[&id, &project, &agent],
        )
        .await?;
    removed.map(|row| CoreEntry::from_row(&row)).ok_or_else(missing)
}

#[cfg(test)]
thread_local! {
    /// When set, the `Date.now()` of core memory on this thread (a replay's recorded clock).
    pub(crate) static NOW_MS: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
}

pub fn now_ms() -> i64 {
    #[cfg(test)]
    if let Some(now) = NOW_MS.with(std::cell::Cell::get) {
        return now;
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
