//! The grant store on disk: `<dir>/grants.json` (`{"grants":[{id,agentId,
//! action,mode,device,at}]}`, two-space JSON) and `<dir>/audit.jsonl` (one
//! line per decision: `{at,agentId,kind,action,tool,target,decision,device}`).
//! Both formats are those of the files already in a data dir.
//!
//! All file work runs in `mixdog-rt` I/O lanes: reads on the interactive lane
//! (the gate waits on them), writes and the audit append on the durability
//! lane. Reads and writes of `grants.json` are `mixdog-statefile`'s port of `atomic-file.mjs`:
//! a damaged file (empty, torn, not JSON) is moved aside to
//! `grants.json.corrupt-<ms>` and reads as no grants, so every action asks
//! again; no backup copy is ever restored (`restoreBackup: false`), because an older copy could
//! bring back a revoked allow.
//!
//! Grant writes are read-modify-write under the file's lock; one async mutex orders them within
//! the process first, so they do not wait on the lock. Readers and audit appends never take it.

use std::io::ErrorKind;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_protocol::ApprovalRemember;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_statefile::IoLane;
use mixdog_statefile::Opts;
use mixdog_statefile::Peek;
use mixdog_statefile::StateError;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::action::GrantKey;
use super::grants::AuditEntry;
use super::grants::FIELD_LIMIT;
use super::grants::cut_utf16;
use super::grants::Grant;
use super::grants::GrantStore;
use super::grants::GrantTable;
use super::grants::PermissionMode;
use super::grants::PermissionRow;
use super::grants::StoreError;
use super::grants::WouldWiden;

const GRANTS_FILE: &str = "grants.json";
const AUDIT_FILE: &str = "audit.jsonl";

#[derive(Serialize)]
struct GrantRow<'a> {
    id: &'a str,
    #[serde(rename = "agentId")]
    agent_id: &'a str,
    action: String,
    mode: &'static str,
    device: &'a str,
    at: i64,
}

#[derive(Serialize)]
struct GrantsDoc<'a> {
    grants: Vec<GrantRow<'a>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError(error.to_string())
}

/// Rows of the stored document; one that cannot exist is dropped.
fn table_of(doc: &Value) -> GrantTable {
    let rows = doc
        .get("grants")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some(Grant {
                id: row.get("id")?.as_str()?.to_owned(),
                agent_id: row.get("agentId")?.as_str()?.to_owned(),
                action: GrantKey::parse(row.get("action")?.as_str()?)?,
                mode: match row.get("mode")?.as_str()? {
                    "allow" => PermissionMode::Allow,
                    "block" => PermissionMode::Block,
                    _ => return None,
                },
                device: row.get("device").and_then(Value::as_str).unwrap_or("").to_owned(),
                at_ms: row
                    .get("at")
                    .and_then(|at| at.as_i64().or_else(|| at.as_f64().map(|f| f as i64)))
                    .unwrap_or(0),
            })
        });
    GrantTable::from_rows(rows)
}

/// Node's `human-gate/store.mjs` options: no backup is ever restored.
fn grant_opts() -> Opts {
    Opts { restore_backup: false, ..Opts::default() }
}

enum Read {
    Missing,
    Table(GrantTable),
    /// The file's text does not parse.
    Corrupt,
}

/// Reads and parses the file; touches nothing.
fn read_file<L: IoLane>(lane: &InLane<L>, path: &Path) -> Result<Read, StoreError> {
    Ok(match mixdog_statefile::peek(lane, path, None).map_err(io_error)? {
        Peek::Value(doc) => Read::Table(table_of(&doc)),
        Peek::Absent => Read::Missing,
        Peek::Damaged(_) | Peek::Unsupported => Read::Corrupt,
    })
}

/// The grants as the writer sees them: a damaged file is kept aside (under the file's lock, after
/// reading it again, so a file a writer has repaired meanwhile is kept) and reads as none.
fn load_locked(lane: &InLane<DurabilityIo>, path: &Path) -> Result<GrantTable, StoreError> {
    let doc = mixdog_statefile::read_json(lane, path, None, &grant_opts()).map_err(io_error)?;
    Ok(doc.as_ref().map(table_of).unwrap_or_default())
}

/// The stored document of `table`.
fn grants_doc(table: &GrantTable) -> Result<Value, StoreError> {
    let doc = GrantsDoc {
        grants: table
            .rows()
            .iter()
            .map(|g| GrantRow {
                id: &g.id,
                agent_id: &g.agent_id,
                action: g.action.render(),
                mode: g.mode.as_str(),
                device: &g.device,
                at: g.at_ms,
            })
            .collect(),
    };
    serde_json::to_value(&doc).map_err(|e| StoreError(e.to_string()))
}

/// A field as Node writes it: `JSON.stringify(value.slice(0, 200))`. A cut that falls inside a
/// surrogate pair leaves the high surrogate alone, and JSON writes it as a `\udXXX` escape.
fn json_field(value: &str) -> String {
    let cut = cut_utf16(value, FIELD_LIMIT);
    let mut text = serde_json::to_string(cut.head).expect("a string serializes");
    if let Some(high) = cut.dangling_high {
        text.pop();
        text.push_str(&format!("\\u{high:04x}\""));
    }
    text
}

/// Replaces the `\uXXXX` escapes of an unpaired surrogate (which Node reads back as a lone
/// surrogate and `serde_json` rejects) with U+FFFD, leaving every other byte as it is.
fn without_lone_surrogates(line: &str) -> std::borrow::Cow<'_, str> {
    let bytes = line.as_bytes();
    let unit = |at: usize| -> Option<u16> {
        let digits = bytes.get(at..at + 6)?;
        (digits[0] == b'\\' && digits[1] == b'u')
            .then(|| u16::from_str_radix(std::str::from_utf8(&digits[2..]).ok()?, 16).ok())
            .flatten()
    };
    let mut out = String::new();
    let (mut copied, mut at) = (0, 0);
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        match unit(at) {
            Some(0xD800..=0xDBFF) if matches!(unit(at + 6), Some(0xDC00..=0xDFFF)) => at += 12,
            Some(0xD800..=0xDFFF) => {
                out.push_str(&line[copied..at]);
                out.push_str("\\ufffd");
                at += 6;
                copied = at;
            }
            Some(_) => at += 6,
            None => at += 2,
        }
    }
    if copied == 0 {
        return std::borrow::Cow::Borrowed(line);
    }
    out.push_str(&line[copied..]);
    std::borrow::Cow::Owned(out)
}

fn append_audit(path: &Path, entry: &AuditEntry) -> Result<(), StoreError> {
    let at = entry.at_ms.unwrap_or_else(now_ms);
    let mut text = format!(
        r#"{{"at":{at},"agentId":{},"kind":{},"action":{},"tool":{},"target":{},"decision":{},"device":{}}}"#,
        json_field(&entry.agent_id),
        json_field(&entry.kind),
        json_field(&entry.action),
        json_field(&entry.tool),
        json_field(&entry.target),
        json_field(&entry.decision),
        json_field(&entry.device),
    );
    text.push('\n');
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io_error)?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .map_err(io_error)
}

/// Newest first; `agent_id` filters to one agent; unparseable lines are skipped.
fn read_audit_lines(path: &Path, agent_id: Option<&str>, limit: usize) -> Result<Vec<AuditEntry>, StoreError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error(error)),
    };
    let text = |row: &Value, key: &str| row.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
    let mut rows = Vec::new();
    for line in raw.lines().rev() {
        if line.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<Value>(&without_lone_surrogates(line))
            && agent_id.is_none_or(|agent| row.get("agentId").and_then(Value::as_str) == Some(agent))
        {
            rows.push(AuditEntry {
                agent_id: text(&row, "agentId"),
                kind: text(&row, "kind"),
                action: text(&row, "action"),
                tool: text(&row, "tool"),
                target: text(&row, "target"),
                decision: text(&row, "decision"),
                device: text(&row, "device"),
                at_ms: row.get("at").and_then(Value::as_i64),
            });
        }
        if rows.len() >= limit {
            break;
        }
    }
    Ok(rows)
}

pub struct FileGrantStore {
    grants_path: PathBuf,
    audit_path: PathBuf,
    interactive: InteractiveIo,
    durability: DurabilityIo,
    /// Orders grant read-modify-writes.
    writes: Mutex<()>,
}

impl FileGrantStore {
    /// `dir` is `<data>/human-gate`.
    pub fn new(dir: impl Into<PathBuf>, interactive: InteractiveIo, durability: DurabilityIo) -> Arc<Self> {
        let dir = dir.into();
        Arc::new(Self {
            grants_path: dir.join(GRANTS_FILE),
            audit_path: dir.join(AUDIT_FILE),
            interactive,
            durability,
            writes: Mutex::new(()),
        })
    }

    /// Readers never take the writer order unless the file looks damaged. Then (as Node's
    /// `atomic-file` recovery does) they take it, read again, and quarantine only if the file is
    /// still damaged: a writer may have repaired it since the first read.
    async fn read_table(&self) -> Result<GrantTable, StoreError> {
        let path = self.grants_path.clone();
        match run(self.interactive, move |lane| read_file(lane, &path)).await? {
            Read::Table(table) => Ok(table),
            Read::Missing => Ok(GrantTable::default()),
            Read::Corrupt => {
                let _order = self.writes.lock().await;
                let path = self.grants_path.clone();
                run(self.durability, move |lane| load_locked(lane, &path)).await
            }
        }
    }

    /// Read-modify-write under the writer order. `change` returns the result
    /// and whether the table changed (only a change is written).
    async fn update<R: Send + 'static>(
        &self,
        change: impl FnOnce(&mut GrantTable) -> (R, bool) + Send + 'static,
    ) -> Result<R, StoreError> {
        let _order = self.writes.lock().await;
        let path = self.grants_path.clone();
        run(self.durability, move |lane| {
            let mut outcome = None;
            mixdog_statefile::update_json(
                lane,
                &path,
                |current| {
                    let mut table = current.as_ref().map(table_of).unwrap_or_default();
                    let (result, changed) = change(&mut table);
                    outcome = Some(result);
                    if changed { grants_doc(&table).map(Some) } else { Ok(None) }
                },
                &grant_opts(),
            )
            .map_err(|error| match error {
                StateError::Mutator(error) => error,
                StateError::Io(error) => io_error(error),
                StateError::Lock(error) => StoreError(error.to_string()),
            })?;
            Ok(outcome.expect("the mutator ran"))
        })
        .await
    }

    /// Sets one row of the permission table (A236); `Ask` removes the grant.
    /// `Ok(Err(WouldWiden))` when `no_widen` refuses the change.
    pub async fn set_mode(
        &self,
        agent_id: &str,
        action: &GrantKey,
        mode: PermissionMode,
        device: &str,
        no_widen: bool,
    ) -> Result<Result<Option<Grant>, WouldWiden>, StoreError> {
        let (agent, action, device) = (agent_id.to_owned(), action.clone(), device.to_owned());
        self.update(move |table| {
            let result = table.set_mode(&agent, &action, mode, &device, now_ms(), no_widen);
            let changed = result.is_ok();
            (result, changed)
        })
        .await
    }

    pub async fn permissions(&self, agent_id: &str) -> Result<Vec<PermissionRow>, StoreError> {
        Ok(self.read_table().await?.permissions(agent_id))
    }

    /// Grants that apply to `agent_id`; all when omitted.
    pub async fn list_grants(&self, agent_id: Option<&str>) -> Result<Vec<Grant>, StoreError> {
        let table = self.read_table().await?;
        Ok(match agent_id {
            Some(agent) => table.applying_to(agent),
            None => table.rows().to_vec(),
        })
    }

    pub async fn revoke_grant(&self, id: &str) -> Result<bool, StoreError> {
        let id = id.to_owned();
        self.update(move |table| {
            let revoked = table.revoke(&id);
            (revoked, revoked)
        })
        .await
    }

    pub async fn read_audit(&self, agent_id: Option<&str>, limit: usize) -> Result<Vec<AuditEntry>, StoreError> {
        let (path, agent) = (self.audit_path.clone(), agent_id.map(str::to_owned));
        run(self.interactive, move |_| read_audit_lines(&path, agent.as_deref(), limit)).await
    }
}

async fn run<L: LaneToken, R: Send + 'static>(
    lane: L,
    job: impl FnOnce(&mixdog_rt::InLane<L>) -> Result<R, StoreError> + Send + 'static,
) -> Result<R, StoreError> {
    let handle = lane
        .submit(&CancellationToken::new(), job)
        .map_err(|full| StoreError(full.to_string()))?;
    handle.await.map_err(|dropped| StoreError(dropped.to_string()))?
}

#[async_trait]
impl GrantStore for FileGrantStore {
    async fn mode_for(
        &self,
        agent_id: &str,
        action: &GrantKey,
        shared_only: bool,
    ) -> Result<PermissionMode, StoreError> {
        Ok(self.read_table().await?.mode_for(agent_id, action, shared_only))
    }

    async fn grant(
        &self,
        agent_id: &str,
        action: &GrantKey,
        scope: ApprovalRemember,
        device: &str,
    ) -> Result<bool, StoreError> {
        let (agent, action, device) = (agent_id.to_owned(), action.clone(), device.to_owned());
        self.update(move |table| {
            let stored = table.grant(&agent, &action, scope, &device, now_ms()).is_some();
            (stored, stored)
        })
        .await
    }

    async fn record_audit(&self, entry: AuditEntry) -> Result<(), StoreError> {
        let path = self.audit_path.clone();
        run(self.durability, move |_| append_audit(&path, &entry)).await
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::approval::ActionKind;

    use super::*;

    fn store_in(dir: &Path) -> Arc<FileGrantStore> {
        let tokens = mixdog_rt::testing::tokens();
        FileGrantStore::new(dir, tokens.interactive_io, tokens.durability_io)
    }

    fn comment() -> GrantKey {
        GrantKey::Kind(ActionKind::Comment)
    }

    #[tokio::test]
    async fn a_grant_is_written_in_the_stored_format_and_read_back() {
        let dir = tempfile::tempdir().expect("dir");
        let store = store_in(dir.path());
        assert_eq!(store.mode_for("bot", &comment(), false).await, Ok(PermissionMode::Ask));
        assert_eq!(store.grant("bot", &comment(), ApprovalRemember::Agent, "Pixel").await, Ok(true));
        assert_eq!(store.mode_for("bot", &comment(), false).await, Ok(PermissionMode::Allow));
        assert_eq!(store.mode_for("other", &comment(), false).await, Ok(PermissionMode::Ask));

        let text = std::fs::read_to_string(dir.path().join(GRANTS_FILE)).expect("grants.json");
        let doc: Value = serde_json::from_str(&text).expect("json");
        let row = &doc["grants"][0];
        assert_eq!(row["agentId"], "bot");
        assert_eq!(row["action"], "comment");
        assert_eq!(row["mode"], "allow");
        assert_eq!(row["device"], "Pixel");
        assert!(row["id"].as_str().is_some_and(|id| id.starts_with("grant_") && id.len() == 30));
        assert!(row["at"].is_i64());
        assert!(text.starts_with("{\n  \"grants\": [\n    {\n      \"id\":"), "{text}");
        assert!(text.ends_with("}\n"));
    }

    #[tokio::test]
    async fn existing_files_of_the_node_daemon_are_read_as_they_are() {
        let dir = tempfile::tempdir().expect("dir");
        let id = super::super::grants::grant_id("*", &GrantKey::tool("shell").expect("key"));
        let text = format!(
            "\u{feff}{{\n  \"grants\": [\n    {{\"id\":\"{id}\",\"agentId\":\"*\",\"action\":\"tool:shell\",\"mode\":\"allow\",\"device\":\"\",\"at\":1700000000000}},\n    {{\"id\":\"x\",\"agentId\":\"a\",\"action\":\"nonsense\",\"mode\":\"allow\"}}\n  ]\n}}\n"
        );
        std::fs::write(dir.path().join(GRANTS_FILE), text).expect("write");
        let store = store_in(dir.path());
        let shell = GrantKey::tool("shell").expect("key");
        assert_eq!(store.mode_for("any", &shell, false).await, Ok(PermissionMode::Allow));
        assert_eq!(store.list_grants(None).await.expect("list").len(), 1);
    }

    #[tokio::test]
    async fn a_damaged_file_is_kept_aside_and_reads_as_no_grants() {
        let dir = tempfile::tempdir().expect("dir");
        std::fs::write(dir.path().join(GRANTS_FILE), "{ torn").expect("write");
        let store = store_in(dir.path());
        assert_eq!(store.mode_for("bot", &comment(), false).await, Ok(PermissionMode::Ask));
        assert!(!dir.path().join(GRANTS_FILE).exists());
        let kept: Vec<_> = std::fs::read_dir(dir.path())
            .expect("dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("grants.json.corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read_to_string(kept[0].path()).expect("kept"), "{ torn");
    }

    /// Regression: a reader that saw the file damaged must not quarantine a file a writer has
    /// repaired in the meantime.
    #[tokio::test]
    async fn a_late_reader_does_not_quarantine_a_repaired_file() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join(GRANTS_FILE);
        std::fs::write(&path, "{ torn").expect("write");
        let store = store_in(dir.path());
        // A writer holds the order while the reader looks at the damaged file.
        let order = store.writes.lock().await;
        let reader = {
            let store = store.clone();
            tokio::spawn(async move { store.mode_for("bot", &comment(), false).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!reader.is_finished(), "the reader waits for the writer order");
        let mut repaired = GrantTable::default();
        repaired.grant("bot", &comment(), ApprovalRemember::Agent, "", 1);
        std::fs::write(&path, serde_json::to_vec(&grants_doc(&repaired).expect("doc")).expect("json")).expect("repair");
        drop(order);
        assert_eq!(reader.await.expect("join"), Ok(PermissionMode::Allow));
        let aside = std::fs::read_dir(dir.path())
            .expect("dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(aside, 0);
        assert_eq!(store.mode_for("bot", &comment(), false).await, Ok(PermissionMode::Allow));
    }

    #[tokio::test]
    async fn revoking_and_setting_back_to_ask_rewrite_the_file() {
        let dir = tempfile::tempdir().expect("dir");
        let store = store_in(dir.path());
        store.grant("bot", &comment(), ApprovalRemember::Agent, "").await.expect("grant");
        let id = store.list_grants(Some("bot")).await.expect("list")[0].id.clone();
        assert_eq!(store.revoke_grant(&id).await, Ok(true));
        assert_eq!(store.revoke_grant(&id).await, Ok(false));
        assert!(store.list_grants(None).await.expect("list").is_empty());
        // A payment can be blocked but never allowed.
        let payment = GrantKey::Kind(ActionKind::Payment);
        let blocked = store.set_mode("bot", &payment, PermissionMode::Block, "", false).await;
        assert!(matches!(blocked, Ok(Ok(Some(_)))));
        let allowed = store.set_mode("bot", &payment, PermissionMode::Allow, "", false).await;
        assert_eq!(allowed, Ok(Ok(None)));
        assert_eq!(store.mode_for("bot", &payment, false).await, Ok(PermissionMode::Block));
    }

    /// Regression: audit fields are cut by UTF-16 units; a cut pair leaves the lone high
    /// surrogate as Node's `JSON.stringify` writes it, and reading it back still works.
    #[tokio::test]
    async fn audit_fields_are_cut_by_utf16_units_and_a_cut_pair_is_a_lone_surrogate_escape() {
        let dir = tempfile::tempdir().expect("dir");
        let store = store_in(dir.path());
        // 201 emoji = 402 units: 100 whole emoji fit in 200 units exactly.
        let entry = |tool: String| AuditEntry {
            agent_id: "bot".into(),
            tool,
            decision: "approve".into(),
            ..AuditEntry::default()
        };
        store.record_audit(entry("😀".repeat(201))).await.expect("audit");
        // Odd cut: 99 emoji (198 units) + "a" (199) + a pair cut after its high surrogate (200).
        store.record_audit(entry(format!("{}a😀😀", "😀".repeat(99)))).await.expect("audit");
        let raw = std::fs::read_to_string(dir.path().join(AUDIT_FILE)).expect("audit.jsonl");
        let mut lines = raw.lines();
        let first: Value = serde_json::from_str(lines.next().expect("line")).expect("json");
        assert_eq!(first["tool"], "😀".repeat(100));
        let second = lines.next().expect("line");
        assert!(second.contains(&format!(r#""tool":"{}a\ud83d","target""#, "😀".repeat(99))), "{second}");
        let rows = store.read_audit(None, 10).await.expect("read");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].tool, format!("{}a\u{fffd}", "😀".repeat(99)));
        assert_eq!(rows[1].tool, "😀".repeat(100));
    }

    #[test]
    fn only_unpaired_surrogate_escapes_are_replaced_when_reading() {
        assert_eq!(without_lone_surrogates(r#"{"a":"\ud83d\ude00 \\ud83d \ud83d!"}"#), r#"{"a":"\ud83d\ude00 \\ud83d \ufffd!"}"#);
        assert_eq!(without_lone_surrogates(r#"{"a":"\ude00"}"#), r#"{"a":"\ufffd"}"#);
    }

    #[tokio::test]
    async fn the_audit_is_one_line_per_decision_newest_first() {
        let dir = tempfile::tempdir().expect("dir");
        let store = store_in(dir.path());
        for (agent, decision) in [("a", "approve"), ("b", "deny"), ("a", "remembered")] {
            store
                .record_audit(AuditEntry {
                    agent_id: agent.into(),
                    kind: "outbound".into(),
                    action: "comment".into(),
                    tool: "github:pr.comment".into(),
                    decision: decision.into(),
                    ..AuditEntry::default()
                })
                .await
                .expect("audit");
        }
        let raw = std::fs::read_to_string(dir.path().join(AUDIT_FILE)).expect("audit.jsonl");
        let first = raw.lines().next().expect("line");
        assert!(
            first.contains(r#""agentId":"a","kind":"outbound","action":"comment","tool":"github:pr.comment","target":"","decision":"approve","device":"""#),
            "{first}"
        );
        assert!(first.starts_with(r#"{"at":"#));
        let all = store.read_audit(None, 100).await.expect("read");
        assert_eq!(all.iter().map(|e| e.decision.as_str()).collect::<Vec<_>>(), ["remembered", "deny", "approve"]);
        let only_a = store.read_audit(Some("a"), 1).await.expect("read");
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].decision, "remembered");
    }
}
