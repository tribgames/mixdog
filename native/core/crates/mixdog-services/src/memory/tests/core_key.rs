//! The core-memory key at start-up, replayed from Node's memory database opening (`record-memory-core-key.mjs`,
//! `fixtures/memory-core-key`): each step's SQL on the store, then the start-up's schema step (Node's opening runs
//! `ensureCoreKeyIndex` on every opening); compared per step: the opening's outcome, the step's follow-up write, the
//! `[core-memory]` lines, the whole index and constraint listing of core_entries and its rows. The race is the recording's:
//! two starters opening the store at once, each held just before the key build and released together.

use std::sync::Arc;

use mixdog_rt::node_log::{Channel, Origin};
use serde_json::{Value, json};

use crate::memory::pg::db::{Db, Schema};
use super::awaiting::awaiting;
use crate::memory::schema::{BEFORE_KEY_BUILD, BeforeKeyBuild, ensure_memory_schema};
use crate::memory::tests::support::TestPg;

const LISTING: &str = "SELECT 'index' AS kind, indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = 'memory' AND tablename = 'core_entries'
  UNION ALL SELECT 'constraint', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'memory.core_entries'::regclass
  ORDER BY 1, 2";
const ROWS: &str = "SELECT id::int AS id, project_id, agent_id, element, summary, category, status FROM core_entries ORDER BY id";

async fn rows_of(db: &Db, sql: &str) -> Value {
    let text: String = db.query_opt(&format!("SELECT coalesce(jsonb_agg(t), '[]'::jsonb)::text FROM ({sql}) t"), &[]).await.expect("listing").expect("one row").get(0);
    serde_json::from_str(&text).expect("json")
}

/// A recorded value that may be absent (`{"$exact":"undefined"}`).
fn text_of(value: &Value) -> Option<&str> {
    value.as_str()
}

#[tokio::test]
async fn start_up_leaves_the_core_key_node_leaves_including_two_starters_at_once() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/memory-core-key/golden.json")).expect("golden");
    let identity = &golden["identity"];
    let dims = golden["dims"].as_u64().expect("dims") as usize;
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    let (lines, _guard) = mixdog_rt::node_log::capture();
    let logs = || -> Value {
        let taken = std::mem::take(&mut *lines.lock().expect("lines"));
        taken.into_iter().filter(|(origin, channel, line)| *origin == Origin::MemoryWorker && *channel == Channel::Stderr && line.starts_with("[core-memory]")).map(|(_, _, line)| json!(line)).collect()
    };

    for step in golden["steps"].as_array().expect("steps") {
        if let Some(sql) = text_of(&step["sql"]) {
            db.batch(sql).await.expect("the step's store");
        }
        if let Some(starters) = step["starters"].as_array() {
            // Two starters, each its own opening of the store, held just before the key build until both arrived, then
            // released together. The log lines come from one process here, so they are compared as the two starters'
            // lines together; which starter wins is not fixed (the recording lists the outcomes sorted).
            let arrived = Arc::new(tokio::sync::Semaphore::new(0));
            let (release, released) = tokio::sync::watch::channel(false);
            let stores = [pg.db(Schema::Memory).await, pg.db(Schema::Memory).await];
            let openings: Vec<_> = stores
                .into_iter()
                .map(|store| {
                    let (arrived, released) = (arrived.clone(), released.clone());
                    let identity = identity.clone();
                    let gate: BeforeKeyBuild = Arc::new(move || {
                        let (arrived, mut released) = (arrived.clone(), released.clone());
                        Box::pin(async move {
                            arrived.add_permits(1);
                            released.wait_for(|go| *go).await.expect("the release");
                        })
                    });
                    tokio::spawn(BEFORE_KEY_BUILD.scope(gate, async move { ensure_memory_schema(&store, dims, &identity).await.map_err(|e| e.message()) }))
                })
                .collect();
            let both = awaiting("both starters at the key build", arrived.acquire_many(2)).await.expect("permits");
            both.forget();
            release.send(true).expect("the starters wait");
            let mut opened = Vec::new();
            for opening in openings {
                opened.push(match awaiting("a starter's opening", opening).await.expect("the starter ran") {
                    Ok(()) => json!({ "result": "opened" }),
                    Err(message) => json!({ "error": message }),
                });
            }
            let together = |outcomes: Vec<Value>, mut lines: Vec<Value>| {
                let mut outcomes: Vec<String> = outcomes.iter().map(Value::to_string).collect();
                outcomes.sort();
                lines.sort_by_key(Value::to_string);
                json!({ "opened": outcomes, "logs": lines })
            };
            let recorded = together(
                starters.iter().map(|s| s["opened"].clone()).collect(),
                starters.iter().flat_map(|s| s["logs"].as_array().expect("logs").clone()).collect(),
            );
            let got = json!({ "label": step["label"], "sql": step["sql"], "starters": together(opened, logs().as_array().expect("lines").clone()), "listing": rows_of(&db, LISTING).await, "rows": rows_of(&db, ROWS).await });
            let want = json!({ "label": step["label"], "sql": step["sql"], "starters": recorded, "listing": step["listing"], "rows": step["rows"] });
            assert_eq!(got, want, "{}", step["label"]);
            continue;
        }
        let opened = ensure_memory_schema(&db, dims, identity).await;
        let after_out = match text_of(&step["after"]) {
            Some(after) => json!({ "result": db.execute(after, &[]).await.expect("the follow-up write") }),
            None => json!({ "$exact": "undefined" }),
        };
        let mut got = json!({
            "label": step["label"],
            "logs": logs(),
            "listing": rows_of(&db, LISTING).await,
            "rows": rows_of(&db, ROWS).await,
        });
        if step.get("opened").is_some() {
            got["sql"] = step["sql"].clone();
            got["after"] = step["after"].clone();
            got["opened"] = match opened {
                Ok(()) => json!({ "result": "opened" }),
                Err(error) => json!({ "error": error.message() }),
            };
            got["afterOut"] = after_out;
        } else {
            opened.expect("a fresh profile opens");
        }
        assert_eq!(got, *step, "{}", step["label"]);
    }
}
