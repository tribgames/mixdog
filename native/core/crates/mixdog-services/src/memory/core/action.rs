//! The `memory` tool: add / edit / delete / list over curated core memory.
//! The caller (`memory_caller`) decides which pools it may read and write; the
//! store enforces the writes again. The injection snapshot is republished
//! after every mutation.

use mixdog_js::{js_trim, value_to_string};
use std::path::Path;
use std::sync::atomic::AtomicU64;

use serde_json::Value;

use crate::memory::core::access::{MemoryCaller, Pool, valid_agent_id};
use crate::memory::core::list::{self, ListOptions, ProjectScopeOf};
use mixdog_rt::DurabilityIo;

use crate::memory::core::store::{self, Edit, Require};
use crate::memory::core::{index, snapshot};
use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::Db;
use crate::memory::project::resolve_project_scope;
use crate::memory::reply::ToolReply;

/// Everything a call needs besides its arguments.
pub struct CoreContext<'a> {
    pub db: &'a Db,
    pub data_dir: &'a Path,
    /// The calling session's working directory; the only fallback for project scope.
    pub session_cwd: Option<&'a Path>,
    pub snapshot_revision: &'a AtomicU64,
    /// The lane project markers and the snapshot file are read and written on.
    pub lane: DurabilityIo,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Add,
    Edit,
    Delete,
    List,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Edit => "edit",
            Self::Delete => "delete",
            Self::List => "list",
        }
    }
}

/// Unambiguous synonyms of the four verbs; a caller naming the same intent
/// differently used to get a hard rejection.
fn parse_op(value: Option<&Value>) -> Option<Op> {
    let raw = js_trim(&value.filter(|v| !v.is_null()).map(value_to_string).unwrap_or_default()).to_lowercase();
    Some(match raw.as_str() {
        "add" | "create" | "new" | "insert" | "store" | "save" => Op::Add,
        "edit" | "update" | "modify" | "change" | "set" => Op::Edit,
        "delete" | "remove" | "rm" | "del" | "forget" => Op::Delete,
        "list" | "show" | "get" | "read" => Op::List,
        _ => return None,
    })
}

pub(crate) fn is_delete(args: &Value) -> bool {
    parse_op(args.get("op")) == Some(Op::Delete)
}

/// An explicit `project_id` wins ("common" is COMMON); otherwise the pool is
/// inferred from the active cwd, falling back to COMMON.
async fn project_of(args: &Value, ctx: &CoreContext<'_>) -> Result<Option<String>> {
    let given = args.get("project_id");
    let text = given.and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if given.is_none() || text.is_empty() {
        return Ok(resolve_project_scope(ctx.lane, args.get("cwd").and_then(Value::as_str), ctx.session_cwd).await?);
    }
    Ok((text.to_lowercase() != "common").then(|| text.to_owned()))
}

/// The editor pairs its displayed scope with a folder. The caller's `cwd`
/// and the tool's `target_cwd` are not that folder assertion.
async fn check_destination(ctx: &CoreContext<'_>, args: &Value, expected: Option<&str>) -> Result<()> {
    if let Some(cwd) = args.get("destination_cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty())
        && resolve_project_scope(ctx.lane, Some(cwd), None).await?.as_deref() != expected
    {
        return Err(MemoryError::rejected("Destination memory scope changed. Refresh the instructions and try again."));
    }
    Ok(())
}

/// `agent_id` selects an agent's own pool: "self" is the caller's, another id
/// the pool the host or a human session manages.
fn agent_of(args: &Value, caller: &MemoryCaller) -> Result<Option<String>> {
    let raw = args.get("agent_id").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.to_lowercase() == "self" {
        if caller.agent_id.is_empty() {
            return Err(MemoryError::rejected("this session has no agent memory"));
        }
        return Ok(Some(caller.agent_id.clone()));
    }
    valid_agent_id(raw).map(|id| Some(id.to_owned())).ok_or_else(|| MemoryError::rejected(format!("agent_id \"{raw}\" is not an agent id")))
}

async fn edit_target(args: &Value, project: Option<&str>, ctx: &CoreContext<'_>) -> Result<Option<String>> {
    if let Some(target) = args.get("target_project_id") {
        let value = if target.is_null() { String::new() } else { value_to_string(target) };
        let value = js_trim(&value);
        let target = (!value.is_empty() && value.to_lowercase() != "common").then(|| value.to_owned());
        check_destination(ctx, args, target.as_deref()).await?;
        return Ok(target);
    }
    match args.get("target_cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => Ok(resolve_project_scope(ctx.lane, Some(cwd), ctx.session_cwd).await?),
        None => Ok(project.map(str::to_owned)),
    }
}

async fn describe(ctx: &CoreContext<'_>, entry: &store::CoreEntry) -> Result<String> {
    let identity = index::public_identity(ctx.db, entry.project_id.as_deref(), entry.agent_id.as_deref(), entry.id).await?;
    Ok(format!("({identity}): {} — {}", entry.element, entry.summary))
}

async fn refresh_snapshot(ctx: &CoreContext<'_>) -> Result<()> {
    snapshot::refresh(ctx.lane, ctx.db, ctx.data_dir, ctx.snapshot_revision).await?;
    Ok(())
}

/// The host's memory-control operation (the rooms' and agents' `list`/`delete`): it holds the stack's handle privately and runs each whole action as
/// work of the database's owner, so the stop drains it or revokes it, a dropped caller leaves it owned, and a call after the stop began is refused
/// before it touches the database. No raw database handle leaves the memory runtime this way.
#[derive(Clone)]
pub struct ControlScope {
    db: Db,
    data_dir: std::path::PathBuf,
    snapshot_revision: std::sync::Arc<AtomicU64>,
    lane: DurabilityIo,
}

/// The reply of a control call the owner refused (the stack is stopping).
const CONTROL_STOPPING: &str = "core failed: memory service stopping";

impl ControlScope {
    pub fn new(db: Db, data_dir: std::path::PathBuf, snapshot_revision: std::sync::Arc<AtomicU64>, lane: DurabilityIo) -> Self {
        Self { db, data_dir, snapshot_revision, lane }
    }

    /// The `memory` op runner's reply text for `args` (errors included, as text).
    pub async fn call(&self, args: Value) -> String {
        let this = self.clone();
        let work = self.db.scope().spawn("services.memory.control", async move {
            let ctx = CoreContext { db: &this.db, data_dir: &this.data_dir, session_cwd: None, snapshot_revision: &this.snapshot_revision, lane: this.lane };
            run(&ctx, &args).await.text
        });
        match work {
            Some(work) => work.await.unwrap_or_else(|| CONTROL_STOPPING.to_owned()),
            None => CONTROL_STOPPING.to_owned(),
        }
    }
}

/// Runs one `memory` call; failures are reported as an error reply.
pub async fn run(ctx: &CoreContext<'_>, args: &Value) -> ToolReply {
    run_cancellable(ctx, args, None, None).await
}

pub(crate) async fn run_cancellable(
    ctx: &CoreContext<'_>,
    args: &Value,
    cancel: Option<&tokio_util::sync::CancellationToken>,
    settlement: Option<&store::DeleteSettlement>,
) -> ToolReply {
    let Some(op) = parse_op(args.get("op")) else {
        return ToolReply::error("core requires op: add | edit | delete | list");
    };
    match execute(ctx, args, op, cancel, settlement).await {
        Ok(reply) => reply,
        Err(error) => ToolReply::error(format!("core {} failed: {}", op.name(), error.message())),
    }
}

async fn execute(
    ctx: &CoreContext<'_>,
    args: &Value,
    op: Op,
    cancel: Option<&tokio_util::sync::CancellationToken>,
    settlement: Option<&store::DeleteSettlement>,
) -> Result<ToolReply> {
    store::check_write_start(cancel)?;
    let caller = MemoryCaller::from_value(args.get("memory_caller"));
    let agent_id = agent_of(args, &caller)?;
    let project_id = if agent_id.is_some() { None } else { project_of(args, ctx).await? };
    if args.get("source").is_some_and(|source| truthy(source) && source.as_str() != Some("curated")) {
        return Ok(ToolReply::error("memory manages user-curated entries only; use recall for generated history."));
    }
    let project = project_id.as_deref();
    let agent = agent_id.as_deref();
    let write_args = match prepare_write_args(args, op, project) {
        Ok(write_args) => write_args,
        Err(reply) => return Ok(reply),
    };
    if project == Some("*") && op != Op::List {
        return Ok(ToolReply::error(format!("core {}: project_id \"*\" only valid for op=\"list\"", op.name())));
    }
    match op {
        Op::List => run_list(ctx, args, project, agent, &caller).await,
        Op::Add => run_add(ctx, args, &write_args, project, agent, &caller, cancel).await,
        Op::Edit => run_edit(ctx, args, &write_args, project, agent, &caller, cancel).await,
        Op::Delete => run_delete(ctx, args, project, agent, &caller, cancel, settlement).await,
    }
}

/// The arguments a write stores: the category is not part of the public schema, so a new entry takes the internal default and an edit keeps the stored one.
fn prepare_write_args(args: &Value, op: Op, project: Option<&str>) -> std::result::Result<Value, ToolReply> {
    let mut write_args = args.clone();
    if !matches!(op, Op::Add | Op::Edit) {
        return Ok(write_args);
    }
    if let Some(object) = write_args.as_object_mut() {
        object.shift_remove("category");
    }
    let normalized = store::normalize_input(&write_args, Require { element: true, summary: true, category: false });
    let mut errors = normalized.errors.clone();
    if op == Op::Add && project == Some("*") {
        errors.insert(0, "project_id \"*\" only valid for op=\"list\"".to_owned());
    }
    if !errors.is_empty() {
        return Err(ToolReply::error(format!("core {}: {}", op.name(), errors.join("; "))));
    }
    if let Some(object) = write_args.as_object_mut() {
        object.insert("element".into(), normalized.element.into());
        object.insert("summary".into(), normalized.summary.into());
        if op == Op::Add {
            object.insert("category".into(), normalized.category.into());
        }
    }
    Ok(write_args)
}

async fn run_add(
    ctx: &CoreContext<'_>,
    args: &Value,
    write_args: &Value,
    project: Option<&str>,
    agent: Option<&str>,
    caller: &MemoryCaller,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Result<ToolReply> {
    if agent.is_none() && args.get("project_id").and_then(Value::as_str).is_some_and(|id| !id.trim().is_empty()) {
        check_destination(ctx, args, project).await?;
    }
    let entry = store::add_cancellable(ctx.db, write_args, project, agent, caller, cancel).await?;
    refresh_snapshot(ctx).await?;
    Ok(ToolReply::ok(format!("core added {}", describe(ctx, &entry).await?)))
}

async fn run_edit(
    ctx: &CoreContext<'_>,
    args: &Value,
    write_args: &Value,
    project: Option<&str>,
    agent: Option<&str>,
    caller: &MemoryCaller,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Result<ToolReply> {
    if agent.is_some() && (args.get("target_project_id").is_some() || args.get("target_cwd").is_some_and(truthy)) {
        return Err(MemoryError::rejected("agent memory has no project scope"));
    }
    let record = index::resolve(ctx.db, project, agent, args.get("id").unwrap_or(&Value::Null), args.get("index_revision").unwrap_or(&Value::Null)).await?;
    let target = if agent.is_some() { None } else { edit_target(args, project, ctx).await? };
    let entry = store::edit_cancellable(
        ctx.db,
        record,
        Edit { input: write_args, expected_project_id: project, expected_agent_id: agent, target_project_id: target.as_deref(), caller },
        cancel,
    )
    .await?;
    refresh_snapshot(ctx).await?;
    Ok(ToolReply::ok(format!("core edited {}", describe(ctx, &entry).await?)))
}

async fn run_delete(
    ctx: &CoreContext<'_>,
    args: &Value,
    project: Option<&str>,
    agent: Option<&str>,
    caller: &MemoryCaller,
    cancel: Option<&tokio_util::sync::CancellationToken>,
    settlement: Option<&store::DeleteSettlement>,
) -> Result<ToolReply> {
    let id = args.get("id").unwrap_or(&Value::Null);
    let record = index::resolve(ctx.db, project, agent, id, args.get("index_revision").unwrap_or(&Value::Null)).await?;
    let removed = store::delete_cancellable(ctx.db, record, project, agent, caller, cancel, settlement).await?;
    refresh_snapshot(ctx).await?;
    Ok(ToolReply::ok(format!(
        "core deleted ({} id={}): {}. Remaining indices were compacted; list memories before the next write.",
        Pool { project_id: project, agent_id: agent }.label(),
        value_to_string(id),
        removed.element
    )))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

async fn run_list(ctx: &CoreContext<'_>, args: &Value, project: Option<&str>, agent: Option<&str>, caller: &MemoryCaller) -> Result<ToolReply> {
    caller.assert_read(agent)?;
    let mut project_scopes = None;
    if let Some(paths) = args.get("project_paths").and_then(Value::as_array) {
        let mut scopes = Vec::with_capacity(paths.len());
        for path in paths.iter().filter_map(Value::as_str) {
            scopes.push(ProjectScopeOf { path: path.to_owned(), project_id: resolve_project_scope(ctx.lane, Some(path), None).await? });
        }
        project_scopes = Some(scopes);
    }
    let page = list::list(ctx.db, ListOptions { scope: project, agent_id: agent, args, project_scopes }).await?;
    let text = if args.get("format").and_then(Value::as_str) == Some("json") { page_json(&page) } else { list::format(&page) };
    let mut reply = ToolReply::ok(text).with_field("entries", &page.entries).with_field("nextOffset", &page.next_offset);
    if let Some(scopes) = &page.project_scopes {
        reply = reply.with_field("projectScopes", scopes);
    }
    Ok(reply)
}

/// `JSON.stringify(page)`: entries, nextOffset, then projectScopes when asked.
fn page_json(page: &list::Page) -> String {
    let mut out = format!(
        "{{\"entries\":{},\"nextOffset\":{}",
        serde_json::to_string(&page.entries).unwrap_or_default(),
        serde_json::to_string(&page.next_offset).unwrap_or_default()
    );
    if let Some(scopes) = &page.project_scopes {
        out.push_str(&format!(",\"projectScopes\":{}", serde_json::to_string(scopes).unwrap_or_default()));
    }
    out.push('}');
    out
}
