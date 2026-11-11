//! Replay of `native/core/fixtures/memory-core-file` (scripts/core-memory-file-test.mjs) through
//! `memory::core::snapshot` (refresh, read, write_snapshot, session_payload) and `CoreMemoryContext::load`.
//!
//! Mappings:
//! - Node's scripted db answered the two selects with the case's `coreRows`; here a private PostgreSQL cluster holds
//!   them as `core_entries` rows (`generatedRows` are rows no recorded statement reads). The scripted db answered
//!   the index's meta select with no rows on every call (it kept no INSERT), so each refresh starts from no saved
//!   index meta here too. Statements are observed
//!   under cfg(test) at `memory::core::index::observe`, with the transaction flag Node records.
//! - `readSessionCoreMemoryPayload(dataDir, cwd)` is `resolve_project_scope(cwd)` then `session_payload`, the two
//!   public steps `CoreMemoryContext::load` takes; Rust's payload has no `dbLines` (Node always answers `[]`, which
//!   is asserted on the recording).
//! - Case 91's `memoryStarts` is 0 by construction in Rust: `CoreMemoryContext` holds only the file lane and data
//!   directory, no memory-runtime handle. Node's `bootProfile('core-memory:done')` hook has no Rust counterpart
//!   (the core has no boot-profile channel); that call is listed as parked, not compared.
//! - UUIDs the product generates are labelled `<uuid-N>` by first appearance in the case, as the recorder labels them.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, int, object, same, string};

const SET: &str = "memory-core-file";

/// `<uuid-N>` for each product UUID in `value`, numbered by first appearance in traversal order.
fn label_uuids(value: &mut Exact, seen: &mut Vec<String>) {
    let pattern = regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").expect("uuid pattern");
    match value {
        Exact::String(text) => {
            *text = pattern
                .replace_all(text, |m: &regex::Captures<'_>| {
                    let uuid = m[0].to_owned();
                    let at = seen.iter().position(|s| *s == uuid).unwrap_or_else(|| {
                        seen.push(uuid);
                        seen.len() - 1
                    });
                    format!("<uuid-{}>", at + 1)
                })
                .into_owned();
        }
        Exact::Array(items) => items.iter_mut().for_each(|item| label_uuids(item, seen)),
        Exact::Object(entries) => entries.iter_mut().for_each(|(_, item)| label_uuids(item, seen)),
        _ => {}
    }
}

/// Every file and directory under `root` (directories as `path/`), sorted by path, as the recorder lists them.
fn files(root: &std::path::Path) -> Exact {
    fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, Exact)>) {
        for entry in std::fs::read_dir(dir).expect("read data dir") {
            let path = entry.expect("dir entry").path();
            let relative = path.strip_prefix(root).expect("under root").to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                out.push((format!("{relative}/"), object(vec![("path", string(format!("{relative}/"))), ("directory", Exact::Bool(true))])));
                walk(root, &path, out);
            } else {
                let bytes = std::fs::read(&path).expect("read file");
                let text = String::from_utf8(bytes.clone()).expect("utf-8 file");
                out.push((relative.clone(), object(vec![("path", string(relative)), ("bytes", int(bytes.len() as i64)), ("text", string(text))])));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Exact::Array(out.into_iter().map(|(_, v)| v).collect())
}

fn written(result: (u64, bool)) -> Exact {
    object(vec![("revision", int(result.0 as i64)), ("written", Exact::Bool(result.1))])
}

fn snapshot_value(snapshot: &crate::memory::core::snapshot::Snapshot) -> Exact {
    Exact::plain(&serde_json::to_value(snapshot).expect("snapshot JSON"))
}

fn lane() -> mixdog_rt::DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}

fn clock(g: &Exact) {
    crate::memory::core::store::NOW_MS.with(|now| now.set(Some(g.get("clock").get("dateNowMs").as_f64() as i64)));
}

fn snapshot_rows(snapshot: &Exact) -> Vec<serde_json::Value> {
    snapshot.get("curated").as_array().iter().map(|row| row.to_plain().expect("JSON row")).collect()
}

fn revision_option(options: &Exact) -> Option<u64> {
    match options {
        Exact::Undefined => None,
        other => Some(other.get("revision").as_f64() as u64),
    }
}

#[test]
fn every_recorded_case_has_a_replay() {
    assert_case_count(&golden(SET), 3);
}

#[test]
fn atomic_revision_guard_rejects_an_older_snapshot() {
    let g = golden(SET);
    let name = "atomic revision guard rejects an older snapshot (test line 57; later steps are further shapes)";
    let c = case(&g, 1, name);
    clock(&g);
    let dir = tempfile::tempdir().expect("data dir");
    let reserved = std::sync::atomic::AtomicU64::new(0);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let mut actual = Vec::new();
    for step in c.get("steps").as_array() {
        let label = step.get("label").as_str();
        let value = runtime.block_on(async {
            if label == "readCoreMemoryFile(dataDir)" {
                let snapshot = crate::memory::core::snapshot::read(lane(), dir.path()).await.expect("snapshot");
                return object(vec![("label", string(label)), ("result", snapshot_value(&snapshot))]);
            }
            let result = crate::memory::core::snapshot::write_snapshot(
                lane(),
                dir.path(),
                &snapshot_rows(step.get("snapshot")),
                revision_option(step.get("options")),
                &reserved,
            )
            .await
            .unwrap_or_else(|e| panic!("{name}: {label}: {e}"));
            object(vec![
                ("label", string(label)),
                ("snapshot", step.get("snapshot").clone()),
                ("options", step.get("options").clone()),
                ("result", written(result)),
                ("files", files(dir.path())),
            ])
        });
        actual.push(value);
    }
    same(name, c.get("steps"), &Exact::Array(actual));
}

#[test]
fn session_core_context_reads_the_file_without_starting_memory_runtime() {
    let g = golden(SET);
    let name = "session core context reads the file without starting memory runtime (test line 91)";
    let c = case(&g, 2, name);
    clock(&g);
    assert_eq!(c.get("env").get("MIXDOG_BOOT_CORE_MEMORY").as_str(), "1", "{name}: the recording does not opt out");
    assert_eq!(c.get("memoryStarts").as_f64(), 0.0, "{name}: memory-runtime starts");
    let dir = tempfile::tempdir().expect("data dir");
    let reserved = std::sync::atomic::AtomicU64::new(0);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    runtime.block_on(async {
        let rows = vec![serde_json::json!({ "id": 1, "summary": "instant context", "project_id": null })];
        let result = crate::memory::core::snapshot::write_snapshot(lane(), dir.path(), &rows, None, &reserved)
            .await
            .unwrap_or_else(|e| panic!("{name}: write: {e}"));
        same(&format!("{name}: written"), c.get("written").get("result"), &written(result));
        same(&format!("{name}: filesBefore"), c.get("filesBefore"), &files(dir.path()));
        let context = crate::memory::core::context::CoreMemoryContext::new(
            lane(),
            dir.path().to_path_buf(),
            std::sync::Arc::new(|| false),
        );
        let cwd = dir.path().to_string_lossy().into_owned();
        let text = tokio::time::timeout(std::time::Duration::from_secs(30), context.load(&cwd, ""))
            .await
            .unwrap_or_else(|_| panic!("{name}: the context did not load within 30 s"));
        same(&format!("{name}: context"), c.get("context").get("result"), &string(text));
        same(&format!("{name}: filesAfter"), c.get("filesAfter"), &files(dir.path()));
    });
}

mod pg {
    use super::*;
    use crate::memory::replays::pg::memory_db;

    fn statements() -> Exact {
        let log = crate::memory::core::index::STATEMENTS.with(|log| log.borrow_mut().replace(Vec::new())).unwrap_or_default();
        Exact::Array(
            log.into_iter()
                .map(|(sql, params, in_transaction)| {
                    let mut entries = vec![
                        ("sql", string(sql)),
                        ("params", params.map_or(Exact::Undefined, |p| Exact::plain(&serde_json::Value::Array(p)))),
                    ];
                    if in_transaction {
                        entries.push(("inTransaction", Exact::Bool(true)));
                    }
                    object(entries)
                })
                .collect(),
        )
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refresh_migrates_pg_rows_and_session_reads_common_plus_project_scope_from_file() {
        let g = golden(SET);
        let name = "refresh migrates PG rows and session reads common plus project scope from file (test line 18)";
        let c = case(&g, 0, name);
        clock(&g);
        let pg = memory_db().await;
        for row in c.get("coreRows").as_array() {
            let id = row.get("id").as_f64() as i64;
            let project = match row.get("project_id") {
                Exact::String(p) => Some(p.clone()),
                _ => None,
            };
            pg.db
                .execute(
                    "INSERT INTO core_entries (id, element, summary, category, project_id, created_at, updated_at)
                     VALUES ($1, $2, $2, 'rule', $3, $4, $4)",
                    &[&id, &row.get("summary").as_str(), &project, &(row.get("updated_at").as_f64() as i64)],
                )
                .await
                .unwrap_or_else(|e| panic!("insert core row {id}: {}", e.message()));
        }
        let dir = tempfile::tempdir().expect("data dir");
        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join(".mixdog")).expect("project dir");
        std::fs::write(project.join(".mixdog").join("project.id"), format!("{}\n", c.get("projectId").as_str())).expect("project.id");
        let reserved = std::sync::atomic::AtomicU64::new(0);
        let mut actual = Vec::new();
        for step in c.get("steps").as_array() {
            let label = step.get("label").as_str();
            let value = match label {
                "refreshCoreMemoryFile(db, dataDir)" | "refreshCoreMemoryFile again (same rows)" => {
                    // Node's scripted db answers the meta select with no rows every time (it keeps no INSERT): the
                    // cluster is given the same state before each refresh.
                    pg.db.execute("DELETE FROM meta WHERE key LIKE 'memory.core.index.%'", &[]).await.expect("clear index meta");
                    crate::memory::core::index::STATEMENTS.with(|log| *log.borrow_mut() = Some(Vec::new()));
                    let result = tokio::time::timeout(
                        std::time::Duration::from_secs(60),
                        crate::memory::core::snapshot::refresh(lane(), &pg.db, dir.path(), &reserved),
                    )
                    .await
                    .unwrap_or_else(|_| panic!("{name}: {label}: did not settle within 60 s"))
                    .unwrap_or_else(|e| panic!("{name}: {label}: {e}"));
                    object(vec![
                        ("label", string(label)),
                        ("result", written(result)),
                        ("statements", statements()),
                        ("files", files(dir.path())),
                    ])
                }
                "readCoreMemoryFile(dataDir)" => {
                    let snapshot = crate::memory::core::snapshot::read(lane(), dir.path()).await.expect("snapshot");
                    // `generatedIsUndefined`: the Rust snapshot type has no generated section at all.
                    let has_generated = serde_json::to_value(&snapshot).expect("JSON").get("generated").is_some();
                    object(vec![
                        ("label", string(label)),
                        ("result", snapshot_value(&snapshot)),
                        ("generatedIsUndefined", Exact::Bool(!has_generated)),
                    ])
                }
                _ => {
                    let cwd = if label.contains("project.id alpha") { project.clone() } else { dir.path().to_path_buf() };
                    let snapshot = crate::memory::core::snapshot::read(lane(), dir.path()).await.expect("snapshot");
                    let project_id = crate::memory::project::resolve_project_scope(lane(), Some(&cwd.to_string_lossy()), None)
                        .await
                        .unwrap_or_else(|e| panic!("{name}: {label}: project scope: {e}"));
                    let payload = crate::memory::core::snapshot::session_payload(&snapshot, project_id.as_deref(), "");
                    assert!(step.get("result").get("dbLines").as_array().is_empty(), "{name}: {label}: Node's dbLines");
                    object(vec![
                        ("label", string(label)),
                        (
                            "result",
                            object(vec![
                                ("projectId", payload.project_id.map_or(Exact::Null, string)),
                                ("revision", int(payload.revision as i64)),
                                ("userLines", Exact::Array(payload.user_lines.into_iter().map(string).collect())),
                                ("dbLines", step.get("result").get("dbLines").clone()),
                            ]),
                        ),
                    ])
                }
            };
            actual.push(value);
        }
        crate::memory::core::index::STATEMENTS.with(|log| *log.borrow_mut() = None);
        let mut actual = Exact::Array(actual);
        label_uuids(&mut actual, &mut Vec::new());
        same(name, c.get("steps"), &actual);
    }
}
