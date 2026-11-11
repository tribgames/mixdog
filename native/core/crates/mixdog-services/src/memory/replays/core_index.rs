//! Replay of `native/core/fixtures/memory-core-index` (core-memory-index.test.mjs) through `memory::core::index::{sync,
//! resolve, address}` (Node's `syncCoreMemoryIndexes`, `resolveCoreMemoryIndex`, `indexedCoreRecord`),
//! `memory::core::list::{list, format}` and `memory::core::action::run` (Node's `handleToolCall("memory", …)`).
//!
//! Mappings (the stand-in shapes of `core_management` apply: integer booleans at `injection_enabled`, parameterless
//! statements as `[]`, `<uuid-N>` labels):
//! - The recording's database is the test file's SQLite stand-in; here a private PostgreSQL cluster. Its initial
//!   `core_entries` rows are the recorded table of the first step (the first sync writes only `meta`), and the
//!   recorder's direct table edits between steps (delete 150, add 201, move 81, add 202, archive 170) are made with the
//!   recorder's statements.
//! - Tables: `core_entries` is read with the stand-in's columns in its order; `meta.value` is `jsonb` here and `TEXT`
//!   there, so the core's stored value is written back as the directory entry's JSON text (`revision`, `recordIds`).
//! - Statements: a `step()` of the recorder reports the statements since it began, an inline step all since the last
//!   inline step (`splice(0)`); the replay keeps the same log.
//! - `indexedCoreRecord(row, directory)` is `address(directory, pool, id)`: `{id: position|null, project_id,
//!   record_id, index_revision|null}`.
//! - Mutations: Node's test passes stand-ins for `editCoreImpl` / `deleteCoreImpl` (manifest `notRun`); the core runs
//!   its real edit and delete. A stand-in call is compared through its effect on the table: `impls` holds, per write, the
//!   impl (`deleteCoreImpl` for a row that is gone, `editCoreImpl` for a changed row), the record id and the row's project
//!   before the write; `writesSoFar` the record ids written so far. The stand-ins' argument objects (`options`, `patch`)
//!   are Node's internal call shape and have no core counterpart. The test's `refreshCoreMemoryFile` stand-in is
//!   `syncCoreMemoryIndexes` alone; the core runs its real refresh (`snapshot::refresh`, Node's
//!   `writeCoreMemoryFileSnapshot`: the same sync, then the curated read `snapshot::CURATED_SQL` that the
//!   memory-core-file replay compares), so that one read is not part of a mutation's recorded statements.
//!   The `editCoreImpl` stand-in writes only `summary` and `project_id` and returns that row; Node's real
//!   `_editCoreImpl` (core-memory-store.mjs:206) writes the patch's `element` too, as the core does. Where the recording
//!   holds the stand-in's element for the edited row (the edit reply, later tables and list entries), the replay expects
//!   the recorded patch's element (`impls[].patch.element`).
//! - `roundTrip`: as in `core_management` (the structured list result is the core's reader).

use mixdog_testkit::Exact;

use super::{assert_case_count, golden};

const SET: &str = "memory-core-index";

#[test]
fn every_recorded_case_has_a_replay() {
    assert_case_count(&golden(SET), 3);
}

mod pg {
    use std::sync::atomic::AtomicU64;
    use std::time::Duration;

    use serde_json::{Value, json};

    use super::*;
    use crate::memory::core::access::Pool;
    use crate::memory::core::action::{CoreContext, run};
    use crate::memory::core::index::{Directory, IndexState, STATEMENTS, address, resolve, sync};
    use crate::memory::core::list::{ListOptions, format, list};
    use crate::memory::pg::db::Db;
    use crate::memory::replays::core_management::pg::{
        label_uuids, page_value, round_trip, stand_in, statements,
    };
    use crate::memory::replays::pg::{ReplayPg, memory_db};
    use crate::memory::replays::{case, int, object, same, string};

    const DEADLINE: Duration = Duration::from_secs(60);

    struct Fixture {
        pg: ReplayPg,
        /// Statements since the last inline step.
        log: Vec<Exact>,
    }

    impl Fixture {
        async fn new(g: &Exact) -> Self {
            let pg = memory_db().await;
            let now = g.get("clock").get("dateNowMs").as_f64() as i64;
            let first = case(g, 0, "real scoped indices persist, compact independently, append on move, and reject stale requests (test line 44)");
            for row in first.get("steps").as_array()[0].get("tables").get("core_entries").as_array() {
                let text = |key: &str| match row.get(key) {
                    Exact::String(s) => Some(s.clone()),
                    Exact::Null => None,
                    other => panic!("table {key}: {other:?}"),
                };
                let id = row.get("id").as_f64() as i64;
                pg.db
                    .execute(
                        "INSERT INTO core_entries (id, project_id, status, element, summary, agent_id, category, created_at, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, 'rule', $7, $7)",
                        &[&id, &text("project_id"), &text("status"), &text("element"), &text("summary"), &text("agent_id"), &now],
                    )
                    .await
                    .unwrap_or_else(|e| panic!("insert core row {id}: {}", e.message()));
            }
            STATEMENTS.with(|log| *log.borrow_mut() = Some(Vec::new()));
            Self { pg, log: Vec::new() }
        }

        fn db(&self) -> &Db {
            &self.pg.db
        }

        /// Moves the observed statements into the log; returns where they start.
        fn collect(&mut self) -> usize {
            let before = self.log.len();
            let (Exact::Array(new), _) = statements() else { unreachable!("statements are an array") };
            self.log.extend(new);
            before
        }

        /// The statements since `before` (a `step()`).
        fn since(&self, before: usize) -> Exact {
            Exact::Array(self.log[before..].to_vec())
        }

        /// Every statement since the last inline step (`splice(0)`).
        fn splice(&mut self) -> Exact {
            Exact::Array(std::mem::take(&mut self.log))
        }

        /// A recorder's direct table edit; `$now` is the recorded clock (the columns PostgreSQL requires).
        async fn exec(&self, sql: &str) {
            let sql = sql.replace("$now", "1800000000000");
            self.db().batch(&sql).await.unwrap_or_else(|e| panic!("{sql}: {}", e.message()));
        }

        async fn core_rows(&self) -> Vec<(i64, Option<String>, Option<String>, String, String, Option<String>)> {
            self.db()
                .query("SELECT id, project_id, status, element, summary, agent_id FROM core_entries ORDER BY id", &[])
                .await
                .expect("core_entries")
                .iter()
                .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5)))
                .collect()
        }

        async fn tables(&self) -> Exact {
            let meta = self
                .db()
                .query("SELECT key, value FROM meta WHERE key LIKE 'memory.core.index.%' ORDER BY key", &[])
                .await
                .expect("meta")
                .iter()
                .map(|r| {
                    let value: Value = r.get(1);
                    let state: IndexState = serde_json::from_value(value).expect("an index entry");
                    object(vec![
                        ("key", string(r.get::<_, String>(0))),
                        ("value", string(serde_json::to_string(&state).expect("index JSON"))),
                    ])
                })
                .collect();
            let opt = |v: &Option<String>| v.clone().map_or(Exact::Null, string);
            let core = self
                .core_rows()
                .await
                .iter()
                .map(|(id, project, status, element, summary, agent)| {
                    object(vec![
                        ("id", int(*id)),
                        ("project_id", opt(project)),
                        ("status", opt(status)),
                        ("element", string(element.clone())),
                        ("summary", string(summary.clone())),
                        ("agent_id", opt(agent)),
                    ])
                })
                .collect();
            object(vec![("meta", Exact::Array(meta)), ("core_entries", Exact::Array(core))])
        }
    }

    fn directory(value: &Directory) -> Exact {
        Exact::Map(
            value
                .iter()
                .map(|(key, state)| {
                    (
                        string(key.clone()),
                        object(vec![
                            ("revision", string(state.revision.clone())),
                            ("recordIds", Exact::Array(state.record_ids.iter().map(|id| int(*id)).collect())),
                        ]),
                    )
                })
                .collect(),
        )
    }

    fn record(directory: &Directory, id: i64, project: Option<&str>) -> Vec<(&'static str, Exact)> {
        let at = address(directory, &Pool { project_id: project, agent_id: None }, id);
        vec![
            ("id", at.as_ref().map_or(Exact::Null, |(position, _)| int(*position as i64))),
            ("project_id", project.map_or(Exact::Null, string)),
            ("record_id", int(id)),
            ("index_revision", at.map_or(Exact::Null, |(_, revision)| string(revision))),
        ]
    }

    fn error(message: &str) -> Exact {
        Exact::Error { name: "Error".into(), message: message.to_owned(), code: None, cause: None, props: Vec::new() }
    }

    async fn settle<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(DEADLINE, future).await.unwrap_or_else(|_| panic!("{what}: did not settle within {DEADLINE:?}"))
    }

    async fn synced(f: &mut Fixture, what: &str) -> Directory {
        let out = settle(what, sync(f.db())).await.unwrap_or_else(|e| panic!("{what}: {}", e.message()));
        f.collect();
        out
    }

    async fn resolved(f: &mut Fixture, what: &str, scope: Option<&str>, index: Value, revision: Value) -> (&'static str, Exact) {
        let out = settle(what, resolve(f.db(), scope, None, &index, &revision)).await;
        f.collect();
        match out {
            Ok(id) => ("result", int(id)),
            Err(e) => ("error", error(&e.message())),
        }
    }

    /// The recording labels UUIDs over the whole file: a case's labels start after the earlier cases'.
    fn label_offset(recorded: &Exact) -> usize {
        let text = format!("{recorded:?}");
        regex::Regex::new(r"<uuid-(\d+)>")
            .expect("label pattern")
            .captures_iter(&text)
            .map(|m| m[1].parse::<usize>().expect("label"))
            .min()
            .map_or(0, |first| first - 1)
    }

    fn finish(name: &str, expected: &Exact, actual: Vec<Exact>) {
        STATEMENTS.with(|log| *log.borrow_mut() = None);
        let mut actual = Exact::Array(actual);
        label_uuids(&mut actual, &mut Vec::new());
        relabel(&mut actual, label_offset(expected));
        by_step(name, expected, &actual);
    }

    /// Step by step (a difference names its step), then whole (no step missing or extra).
    fn by_step(name: &str, expected: &Exact, actual: &Exact) {
        for (want, got) in expected.as_array().iter().zip(actual.as_array()) {
            let label = want.get("label").as_str();
            if want != got {
                // The long steps differ deep inside: name where.
                let (w, g) = (format!("{want:?}"), format!("{got:?}"));
                let at = w.bytes().zip(g.bytes()).take_while(|(a, b)| a == b).count();
                let from = w[..at].char_indices().rev().nth(200).map_or(0, |(i, _)| i);
                panic!("{name}: {label}: first difference after\n  {}\n  Node: {}\n  Rust: {}", &w[from..at],
                    w[at..].chars().take(300).collect::<String>(), g[at..].chars().take(300).collect::<String>());
            }
            same(&format!("{name}: {label}"), want, got);
        }
        same(name, expected, actual);
    }

    fn revision_of(directory: &Directory, key: &str) -> Value {
        Value::String(directory[key].revision.clone())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn real_scoped_indices_persist_compact_independently_append_on_move_and_reject_stale_requests() {
        let g = golden(SET);
        let name = "real scoped indices persist, compact independently, append on move, and reject stale requests (test line 44)";
        let c = case(&g, 0, name);
        let mut f = Fixture::new(&g).await;
        let mut steps = Vec::new();

        let first = synced(&mut f, "first sync").await;
        steps.push(object(vec![
            ("label", string("first sync")),
            ("result", directory(&first)),
            ("statements", f.splice()),
            ("tables", f.tables().await),
        ]));
        let probe = |label: &str, id: i64, project: Option<&str>| {
            let row = object(vec![("id", int(id)), ("project_id", project.map_or(Exact::Null, string))]);
            let mut fields = vec![("label", string(label)), ("row", row)];
            fields.extend(record(&first, id, project));
            object(fields)
        };
        steps.push(object(vec![
            ("label", string("indexedCoreRecord after the first sync")),
            (
                "probes",
                Exact::Array(vec![
                    probe("common 81", 81, None),
                    probe("alpha 150", 150, Some("alpha")),
                    probe("beta 200", 200, Some("beta")),
                    probe("alpha 170", 170, Some("alpha")),
                    probe("unknown 999", 999, Some("alpha")),
                ]),
            ),
        ]));
        let alpha = revision_of(&first, "\"alpha\"");
        let beta = first["\"beta\""].revision.clone();
        let common = revision_of(&first, "null");

        let label = "sync again returns the same indices";
        let before = f.log.len();
        let again = synced(&mut f, label).await;
        steps.push(object(vec![
            ("label", string(label)),
            ("result", directory(&again)),
            ("statements", f.since(before)),
            ("tables", f.tables().await),
        ]));
        for (label, scope, revision) in [
            ("resolve alpha 1 with its revision", Some("alpha"), alpha.clone()),
            ("resolve beta 1 with alpha's revision", Some("beta"), alpha.clone()),
            ("resolve alpha 1 without a revision", Some("alpha"), Value::Null),
        ] {
            let before = f.log.len();
            let out = resolved(&mut f, label, scope, json!(1), revision).await;
            steps.push(object(vec![("label", string(label)), out, ("statements", f.since(before)), ("tables", f.tables().await)]));
        }

        f.exec("DELETE FROM core_entries WHERE id=150").await;
        let compacted = synced(&mut f, "after deleting alpha 150").await;
        let mut remaining = record(&compacted, 170, Some("alpha"));
        let remaining_revision = match &remaining[3].1 {
            Exact::String(s) => Value::String(s.clone()),
            other => panic!("{name}: alpha 170 has no revision after the compaction: {other:?}"),
        };
        steps.push(object(vec![
            ("label", string("after deleting alpha 150: sync (compaction)")),
            ("result", directory(&compacted)),
            ("remaining", object(std::mem::take(&mut remaining))),
            ("alphaRevisionChanged", Exact::Bool(remaining_revision != alpha)),
            ("betaRevisionKept", Exact::Bool(compacted["\"beta\""].revision == beta)),
            ("statements", f.splice()),
            ("tables", f.tables().await),
        ]));
        for (label, revision) in
            [("resolve alpha 1 with the old revision", alpha.clone()), ("resolve alpha 1 with the new revision", remaining_revision)]
        {
            let before = f.log.len();
            let out = resolved(&mut f, label, Some("alpha"), json!(1), revision).await;
            steps.push(object(vec![("label", string(label)), out, ("statements", f.since(before)), ("tables", f.tables().await)]));
        }

        f.exec("INSERT INTO core_entries(id, project_id, status, element, summary, category, created_at, updated_at) VALUES(201, 'alpha', 'active', 'New', 'New alpha memory', 'rule', $now, $now)").await;
        let added = synced(&mut f, "after adding alpha 201").await;
        steps.push(object(vec![
            ("label", string("after adding alpha 201: sync")),
            ("result", directory(&added)),
            ("probe", object(record(&added, 201, Some("alpha")))),
            ("statements", f.splice()),
            ("tables", f.tables().await),
        ]));
        f.exec("UPDATE core_entries SET project_id='alpha' WHERE id=81").await;
        let moved = synced(&mut f, "after moving common 81").await;
        steps.push(object(vec![
            ("label", string("after moving common 81 to alpha: sync (append on move)")),
            ("result", directory(&moved)),
            (
                "probes",
                Exact::Array(vec![object(record(&moved, 81, Some("alpha"))), object(record(&moved, 170, Some("alpha")))]),
            ),
            ("statements", f.splice()),
            ("tables", f.tables().await),
        ]));
        let label = "resolve common 1 with the old common revision";
        let before = f.log.len();
        let out = resolved(&mut f, label, None, json!(1), common).await;
        steps.push(object(vec![("label", string(label)), out, ("statements", f.since(before)), ("tables", f.tables().await)]));
        f.exec("INSERT INTO core_entries(id, project_id, status, element, summary, category, created_at, updated_at) VALUES(202, NULL, 'active', 'New common', 'New common memory', 'rule', $now, $now)").await;
        let with_common = synced(&mut f, "after adding common 202").await;
        steps.push(object(vec![
            ("label", string("after adding common 202: sync")),
            ("result", directory(&with_common)),
            ("probe", object(record(&with_common, 202, None))),
            ("statements", f.splice()),
            ("tables", f.tables().await),
        ]));
        f.exec("UPDATE core_entries SET status='archived' WHERE id=170").await;
        let archived = synced(&mut f, "after archiving alpha 170").await;
        let summary: String = f
            .db()
            .query_opt("SELECT summary FROM core_entries WHERE id=170", &[])
            .await
            .expect("row 170")
            .expect("row 170 is kept")
            .get(0);
        steps.push(object(vec![
            ("label", string("after archiving alpha 170: sync")),
            ("result", directory(&archived)),
            (
                "probes",
                Exact::Array(vec![object(record(&archived, 201, Some("alpha"))), object(record(&archived, 170, Some("alpha")))]),
            ),
            ("statements", f.splice()),
            ("tables", f.tables().await),
            ("summaryOf170", string(summary)),
        ]));
        finish(name, c.get("steps"), steps);
    }

    async fn listed(f: &mut Fixture, label: &str, scope: &str, args: Value) -> (Exact, Vec<crate::memory::core::list::ListEntry>) {
        let options = ListOptions { scope: Some(scope), agent_id: None, args: &args, project_scopes: None };
        let page = settle(label, list(f.db(), options)).await.unwrap_or_else(|e| panic!("{label}: {}", e.message()));
        f.collect();
        let text = format(&page);
        // This recorder's `roundTrip` also carries the text it parsed.
        let Exact::Object(mut trip) = round_trip(&text, &page) else { unreachable!("a round trip is an object") };
        trip.insert(0, ("formatted".to_owned(), string(text.clone())));
        let step = object(vec![
            ("label", string(label)),
            ("result", page_value(&page)),
            ("formatted", string(text)),
            ("roundTrip", Exact::Object(trip)),
            ("statements", f.splice()),
        ]);
        (step, page.entries)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lists_and_tui_requests_carry_per_scope_indices_and_their_matching_revisions() {
        let g = golden(SET);
        let name = "lists and TUI requests carry per-scope indices and their matching revisions (test line 94; the TUI parser is not recorded, its formatted input is)";
        let c = case(&g, 1, name);
        let mut f = Fixture::new(&g).await;
        let mut steps = Vec::new();
        let (step, entries) = listed(&mut f, "list '*' curated", "*", json!({ "source": "curated" })).await;
        steps.push(step);
        let mut resolves = Vec::new();
        for entry in &entries {
            let what = format!("resolve {:?} {:?}", entry.project_id, entry.id);
            let index = entry.id.map_or(Value::Null, |id| json!(id));
            let revision = entry.index_revision.clone().map_or(Value::Null, Value::String);
            let out = resolved(&mut f, &what, entry.project_id.as_deref(), index, revision).await;
            resolves.push(object(vec![
                ("projectId", entry.project_id.clone().map_or(Exact::Null, string)),
                ("id", entry.id.map_or(Exact::Null, |id| int(id as i64))),
                out,
                ("expectRecordId", int(entry.record_id)),
            ]));
        }
        steps.push(object(vec![
            ("label", string("resolve every listed entry with its own revision (what a list consumer sends back)")),
            ("resolves", Exact::Array(resolves)),
            ("statements", f.splice()),
        ]));
        let args = json!({ "source": "curated", "scope_only": true, "limit": 1 });
        let (step, _) = listed(&mut f, "alpha scope_only limit 1", "alpha", args).await;
        let next = match step.get("result").get("nextOffset") {
            Exact::Number(n) => *n as i64,
            other => panic!("{name}: the first alpha page has no nextOffset: {other:?}"),
        };
        steps.push(step);
        let args = json!({ "source": "curated", "scope_only": true, "limit": 1, "offset": next });
        steps.push(listed(&mut f, "alpha scope_only limit 1 at nextOffset", "alpha", args).await.0);
        finish(name, c.get("steps"), steps);
    }

    /// The stand-in's integer booleans inside reply text (the JSON list format).
    fn stand_in_text(value: &mut Value) {
        match value {
            Value::String(text) => {
                *text = text.replace("\"injection_enabled\":true", "\"injection_enabled\":1").replace(
                    "\"injection_enabled\":false",
                    "\"injection_enabled\":0",
                );
            }
            Value::Array(items) => items.iter_mut().for_each(stand_in_text),
            Value::Object(entries) => entries.values_mut().for_each(stand_in_text),
            _ => {}
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn public_mutations_resolve_scope_and_version_before_touching_the_stable_record() {
        let g = golden(SET);
        let name = "public mutations resolve scope and version before touching the stable record (test line 125)";
        let c = case(&g, 2, name);
        let mut f = Fixture::new(&g).await;
        let data_dir = tempfile::tempdir().expect("data dir");
        let revision = AtomicU64::new(0);
        let offset = label_offset(c.get("steps"));
        let mut steps = Vec::new();
        let mut writes: Vec<Exact> = Vec::new();
        let mut impls = Vec::new();
        for recorded in c.get("steps").as_array() {
            let label = recorded.get("label").as_str();
            let mut args = recorded.get("args").to_plain().expect("args JSON");
            // A recorded revision argument is a label: the replay sends the revision its own earlier step returned
            // under that label.
            if let Some(Value::String(rev)) = args.get("index_revision") {
                let mut seen = Vec::new();
                label_uuids(&mut Exact::Array(steps.clone()), &mut seen);
                let at: usize = rev
                    .strip_prefix("<uuid-")
                    .and_then(|r| r.strip_suffix('>'))
                    .and_then(|n| n.parse().ok())
                    .unwrap_or_else(|| panic!("{name}: {label}: revision {rev} is not a label"));
                let own = seen.get(at - offset - 1).unwrap_or_else(|| panic!("{name}: {label}: {rev} not seen yet"));
                args["index_revision"] = Value::String(own.clone());
            }
            let rows_before = f.core_rows().await;
            let ctx = CoreContext {
                db: f.db(),
                data_dir: data_dir.path(),
                session_cwd: None,
                snapshot_revision: &revision,
                lane: mixdog_rt::testing::tokens().durability_io,
            };
            let reply = settle(label, run(&ctx, &args)).await;
            f.collect();
            // The real refresh's snapshot read (see the header); the test's refresh stand-in is the sync alone.
            f.log.retain(|statement| statement.get("sql").as_str() != crate::memory::core::snapshot::CURATED_SQL);
            let rows_after = f.core_rows().await;
            for row in &rows_before {
                let after = rows_after.iter().find(|r| r.0 == row.0);
                let impl_name = match after {
                    None => "deleteCoreImpl",
                    Some(after) if after != row => "editCoreImpl",
                    Some(_) => continue,
                };
                writes.push(int(row.0));
                impls.push(object(vec![
                    ("impl", string(impl_name)),
                    ("recordId", int(row.0)),
                    ("rowProjectId", row.1.clone().map_or(Exact::Null, string)),
                ]));
            }
            let mut result: Value = serde_json::from_str(&reply.envelope()).expect("reply JSON");
            stand_in(&mut result);
            stand_in_text(&mut result);
            steps.push(object(vec![
                ("label", string(label)),
                ("args", Exact::plain(&args)),
                ("result", Exact::plain(&result)),
                ("writesSoFar", Exact::Array(writes.clone())),
                ("statements", f.since(0)),
                ("tables", f.tables().await),
            ]));
            f.log.clear();
        }
        let mut actual = Exact::Array(steps);
        label_uuids(&mut actual, &mut Vec::new());
        STATEMENTS.with(|log| *log.borrow_mut() = None);
        relabel(&mut actual, offset);
        let mut expected = c.get("steps").clone();
        for call in c.get("impls").as_array().iter().filter(|call| call.get("impl").as_str() == "editCoreImpl") {
            real_edit(&mut expected, call);
        }
        by_step(name, &expected, &actual);
        let recorded_impls = Exact::Array(
            c.get("impls")
                .as_array()
                .iter()
                .map(|call| {
                    object(vec![
                        ("impl", call.get("impl").clone()),
                        ("recordId", call.get("recordId").clone()),
                        ("rowProjectId", call.get("rowProjectId").clone()),
                    ])
                })
                .collect(),
        );
        same(&format!("{name}: impls"), &recorded_impls, &Exact::Array(impls));
    }

    /// The real edit's element where the recording holds the stand-in's (see the header): the edited row, its listed
    /// entries and the replies that name it carry the recorded patch's element once they carry its summary.
    fn real_edit(steps: &mut Exact, call: &Exact) {
        let id = call.get("recordId").clone();
        let patch = call.get("patch");
        let (Exact::String(after), Exact::String(summary)) = (patch.get("element"), patch.get("summary")) else {
            panic!("the recorded edit patch has no element and summary: {patch:?}");
        };
        let before = steps
            .as_array()
            .iter()
            .flat_map(|step| match step.try_get("tables") {
                Some(tables) => tables.get("core_entries").as_array().to_vec(),
                None => Vec::new(),
            })
            .find(|row| row.get("id") == &id)
            .map(|row| row.get("element").as_str().to_owned())
            .expect("the edited row is in a recorded table");
        fn walk(value: &mut Exact, before: &str, after: &str, summary: &str) {
            match value {
                Exact::String(text) => {
                    *text = text
                        .replace(
                            &format!("\"element\":\"{before}\",\"summary\":\"{summary}\""),
                            &format!("\"element\":\"{after}\",\"summary\":\"{summary}\""),
                        )
                        .replace(&format!("): {before} — {summary}"), &format!("): {after} — {summary}"));
                }
                Exact::Array(items) => items.iter_mut().for_each(|item| walk(item, before, after, summary)),
                Exact::Object(entries) => {
                    let has = |key: &str, want: &str| {
                        entries.iter().any(|(k, v)| k == key && matches!(v, Exact::String(s) if s == want))
                    };
                    let edited = has("element", before) && has("summary", summary);
                    for (key, item) in entries.iter_mut() {
                        if edited && key == "element" {
                            *item = Exact::String(after.to_owned());
                        } else {
                            walk(item, before, after, summary);
                        }
                    }
                }
                _ => {}
            }
        }
        walk(steps, &before, after, summary);
    }

    /// `<uuid-N>` → `<uuid-N+offset>`.
    fn relabel(value: &mut Exact, offset: usize) {
        let pattern = regex::Regex::new(r"<uuid-(\d+)>").expect("label pattern");
        match value {
            Exact::String(text) => {
                *text = pattern
                    .replace_all(text, |m: &regex::Captures<'_>| {
                        format!("<uuid-{}>", m[1].parse::<usize>().expect("label") + offset)
                    })
                    .into_owned();
            }
            Exact::Array(items) => items.iter_mut().for_each(|item| relabel(item, offset)),
            Exact::Object(entries) => entries.iter_mut().for_each(|(_, item)| relabel(item, offset)),
            Exact::Map(entries) => entries.iter_mut().for_each(|(key, item)| {
                relabel(key, offset);
                relabel(item, offset);
            }),
            _ => {}
        }
    }
}
