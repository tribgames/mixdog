//! The core-memory key at start-up, replayed from Node's memory database opening (`record-memory-core-key.mjs`,
//! `fixtures/memory-core-key`): each step's SQL on the store, then the start-up's schema step (Node's opening runs
//! `ensureCoreKeyIndex` on every opening); compared per step: the opening's outcome, the step's follow-up write, the
//! `[core-memory]` lines, the whole index and constraint listing of core_entries and its rows. The race is made where the
//! recording made it: the recorded write committed between the conflict check and the index build.

use std::sync::Arc;

use mixdog_rt::node_log::{Channel, Origin};
use serde_json::{Value, json};

use crate::memory::pg::db::{Db, Schema};
use crate::memory::schema::{AFTER_KEY_CHECK, AfterKeyCheck, ensure_memory_schema};
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
async fn start_up_leaves_the_core_key_node_leaves_including_a_racing_duplicate() {
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
        let opening = ensure_memory_schema(&db, dims, identity);
        let opened = match text_of(&step["raceSql"]) {
            Some(race) => {
                let (writer, race) = (db.clone(), race.to_owned());
                let write: AfterKeyCheck = Arc::new(move || {
                    let (writer, race) = (writer.clone(), race.clone());
                    Box::pin(async move { writer.batch(&race).await.expect("the racing write") })
                });
                AFTER_KEY_CHECK.scope(write, opening).await
            }
            None => opening.await,
        };
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
            got["raceSql"] = step["raceSql"].clone();
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
