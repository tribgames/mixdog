//! memory-embedding-cache-retention: the embedding cache's row cap and its prune.
//!
//! - The cap (`resolve`, `fromEnv`): `resolve_cache_max_rows`, which `RawEmbedFlush::new` applies to
//!   `MIXDOG_EMBED_CACHE_MAX_ROWS`. The recording is Node with `node-patches/node-fix-embedding-cache-max-rows.patch`
//!   (a fraction below one floored to a zero-row cap that wiped the cache; it is invalid as 0 is), as the core resolves it.
//!   `fromEnv` sets the variable in this test only; nothing else in the crate reads it.
//! - The prune's rate limit is Node's (`Date.now()` against the next allowed time, `core::store::now_ms`); a flush's
//!   first prune is never limited, so no clock reading changes what is compared.
//! - Each prune: `RawEmbedFlush::flush` (the public entry) over a private cluster (module `pg`) whose cache table holds
//!   the recorded `count` rows, one of them the cached vector of the one raw row the flush claims, so the batch needs no
//!   model and ends in the prune. The prune's statements (text and bound row count) are observed in order
//!   (`PRUNE_STATEMENTS`, test builds) and compared with Node's; the outcome or error is `FlushOutcome::pruned`. Node's
//!   scripted DELETE answers and failures are the database's own: a `BEFORE DELETE` row trigger that keeps every row
//!   (answer 0) or raises, a `BEFORE TRUNCATE` trigger that raises (`XX000`, the recorded text). An error compares code
//!   and message; the core's database error has no `name` (Node's is that of the scripted `Error`).
//! - Not reachable through the flush, so not replayed: the prune of an empty cache (case 3, prune 0: the row the batch
//!   just read or wrote is in the cache) and the three prunes with a `batchSize` option (prunes 5 to 7: no product path
//!   sets it, Node's flush prunes in batches of 5000 as the core's).

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, int, same};
use crate::memory::ingest::embed_flush::resolve_cache_max_rows;

const SET: &str = "memory-embedding-cache-retention";

#[test]
fn the_recording_has_four_cases() {
    assert_case_count(&golden(SET), 4);
}

#[test]
fn embedding_cache_defaults_to_ten_thousand_rows_with_a_positive_override() {
    let g = golden(SET);
    let c = case(&g, 0, "embedding cache defaults to ten thousand rows with a positive override");
    let default = resolve_cache_max_rows(None);
    same("defaultMaxRows", c.get("defaultMaxRows"), &int(default));
    for step in c.get("resolve").as_array() {
        let value = match step.get("value") {
            Exact::String(s) => Some(s.as_str()),
            Exact::Null | Exact::Undefined => None,
            other => panic!("resolve value {other:?}"),
        };
        let rust = resolve_cache_max_rows(value);
        same(&format!("resolve {value:?}"), step.get("result"), &int(rust));
    }
    let from_env = c.get("fromEnv").as_array();
    // SAFETY: no other test reads or writes this variable.
    unsafe { std::env::remove_var("MIXDOG_EMBED_CACHE_MAX_ROWS") };
    same("fromEnv unset", from_env[0].get("result"), &int(resolve_cache_max_rows(std::env::var("MIXDOG_EMBED_CACHE_MAX_ROWS").ok().as_deref())));
    unsafe { std::env::set_var("MIXDOG_EMBED_CACHE_MAX_ROWS", "321") };
    let set = resolve_cache_max_rows(std::env::var("MIXDOG_EMBED_CACHE_MAX_ROWS").ok().as_deref());
    unsafe { std::env::remove_var("MIXDOG_EMBED_CACHE_MAX_ROWS") };
    same("fromEnv 321", from_env[1].get("result"), &int(set));
}

mod pg {
    use std::path::PathBuf;
    use std::sync::Arc;

    use sha2::{Digest, Sha256};

    use super::*;
    use crate::memory::embed::engine::EmbedConfig;
    use crate::memory::embed::provider::EmbeddingProvider;
    use crate::memory::ingest::embed_flush::{PRUNE_STATEMENTS, PruneOutcome, RawEmbedFlush};
    use crate::memory::replays::pg::{ReplayPg, insert_entries, memory_db};
    use crate::memory::replays::{object, string};

    const TEXT: &str = "cached raw row";

    fn provider() -> Arc<EmbeddingProvider> {
        // Never loaded: the one text is a cache hit.
        Arc::new(EmbeddingProvider::new(EmbedConfig {
            model_id: crate::memory::embed::config::DEFAULT_MODEL_ID.into(),
            cache_dir: PathBuf::from("<no models>"),
            ort_library: PathBuf::from("<no runtime>"),
            dtype: None,
            sessions: 1,
            lane: mixdog_rt::testing::tokens().cpu_bulk,
        }))
    }

    /// One recorded prune over `pg`, whose memory schema is as a new cluster has it.
    async fn prune(pg: &ReplayPg, name: &str, recorded: &Exact) {
        let db = &pg.db;
        let count = recorded.get("count").as_f64() as i64;
        assert!(count >= 1, "{name}: a flush prunes a cache that holds its batch's row");
        db.batch(
            "CREATE TABLE IF NOT EXISTS memory.embedding_cache (
               model_id  text   NOT NULL,
               text_hash bytea  NOT NULL,
               vector    halfvec NOT NULL,
               PRIMARY KEY (model_id, text_hash)
             )",
        )
        .await
        .expect("cache table");
        let model = crate::memory::embed::config::DEFAULT_MODEL_ID;
        let hash = Sha256::digest(TEXT.as_bytes()).to_vec();
        db.execute("INSERT INTO memory.embedding_cache VALUES ($1, $2, '[0.5,0.5]')", &[&model, &hash]).await.expect("hit row");
        db.execute(
            "INSERT INTO memory.embedding_cache
             SELECT 'filler', int8send(i), '[0.5,0.5]' FROM generate_series(1, $1::bigint - 1) AS i",
            &[&count],
        )
        .await
        .expect("filler rows");
        insert_entries(
            db,
            &[&object(vec![
                ("id", int(1)),
                ("ts", int(1)),
                ("role", string("user")),
                ("content", string(TEXT)),
                ("session_id", string("s")),
                ("is_root", int(0)),
            ])],
        )
        .await;
        let answers = recorded.get("deleteAnswers");
        let fail_on = recorded.get("failOn");
        // The recorded error: its message and code (its name is that of Node's scripted `Error`).
        let error = recorded.try_get("error").map(|e| match e {
            Exact::Error { message, code: Some(code), .. } => (message.clone(), code.as_str().to_owned()),
            other => panic!("{name}: error {other:?}"),
        });
        // The recorded failure, raised by the database.
        let raise = || {
            let (message, code) = error.as_ref().unwrap_or_else(|| panic!("{name}: a failure without an error"));
            format!("BEGIN RAISE EXCEPTION USING MESSAGE = '{}', ERRCODE = '{code}'; END;", message.replace('\'', "''"))
        };
        let mut triggers = Vec::new();
        match (fail_on, answers) {
            (Exact::String(on), _) if on == "DELETE" => triggers.push(format!(
                "CREATE FUNCTION memory.replay_delete() RETURNS trigger LANGUAGE plpgsql AS $f$ {} $f$;
                 CREATE TRIGGER replay_delete BEFORE DELETE ON memory.embedding_cache FOR EACH ROW EXECUTE FUNCTION memory.replay_delete();",
                raise()
            )),
            (Exact::String(on), _) if on == "TRUNCATE" => triggers.push(format!(
                "CREATE FUNCTION memory.replay_truncate() RETURNS trigger LANGUAGE plpgsql AS $f$ {} $f$;
                 CREATE TRIGGER replay_truncate BEFORE TRUNCATE ON memory.embedding_cache FOR EACH STATEMENT EXECUTE FUNCTION memory.replay_truncate();",
                raise()
            )),
            (Exact::Null, Exact::String(a)) if a == "requested" => {}
            (Exact::Null, Exact::Number(n)) if *n == 0.0 => triggers.push(
                "CREATE FUNCTION memory.replay_keep() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END; $f$;
                 CREATE TRIGGER replay_keep BEFORE DELETE ON memory.embedding_cache FOR EACH ROW EXECUTE FUNCTION memory.replay_keep();"
                    .to_owned(),
            ),
            other => panic!("{name}: no database answer for {other:?}"),
        }
        for sql in triggers {
            db.batch(&sql).await.expect("trigger");
        }

        let flush = RawEmbedFlush::new(db.clone(), Some(provider()));
        PRUNE_STATEMENTS.with(|log| *log.borrow_mut() = Some(Vec::new()));
        let outcome = flush.flush(32, Some(&[1])).await;
        let statements = PRUNE_STATEMENTS.with(|log| log.borrow_mut().take()).expect("statement log");
        let statements = Exact::Array(
            statements
                .into_iter()
                .map(|(sql, param)| {
                    object(vec![("sql", string(sql)), ("params", param.map_or(Exact::Undefined, |n| Exact::Array(vec![int(n)])))])
                })
                .collect(),
        );
        same(&format!("{name}: statements"), recorded.get("statements"), &statements);
        match outcome.pruned.unwrap_or_else(|| panic!("{name}: the flush ran no prune")) {
            Ok(PruneOutcome { removed, truncated, remaining }) => {
                assert!(error.is_none(), "{name}: Node failed, the core pruned");
                same(
                    &format!("{name}: result"),
                    recorded.get("result"),
                    &object(vec![("removed", int(removed)), ("truncated", Exact::Bool(truncated)), ("remaining", int(remaining))]),
                );
            }
            Err(e) => {
                let (message, code) = error.unwrap_or_else(|| panic!("{name}: the core failed, Node did not: {e}"));
                let db_error = match &e {
                    crate::memory::error::MemoryError::Pg(pg) => pg.as_db_error().unwrap_or_else(|| panic!("{name}: {e}")),
                    other => panic!("{name}: not a database error: {other}"),
                };
                assert_eq!(db_error.message(), message, "{name}: error message");
                assert_eq!(db_error.code().code(), code, "{name}: error code");
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_legacy_oversized_embedding_cache_is_truncated_to_reclaim_disk_pages() {
        let g = golden(SET);
        let name = "a legacy oversized embedding cache is truncated to reclaim disk pages";
        prune(&memory_db().await, name, case(&g, 1, name).get("prune")).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn small_overflow_deletes_only_the_oldest_excess_rows() {
        let g = golden(SET);
        let name = "small overflow deletes only the oldest excess rows";
        prune(&memory_db().await, name, case(&g, 2, name).get("prune")).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn further_shapes_beyond_the_test_file() {
        let g = golden(SET);
        let name = "further shapes (beyond the test file)";
        let prunes = case(&g, 3, name).get("prunes").as_array();
        // One cluster for every prune; each starts from the memory schema a new cluster has.
        let mut pg = memory_db().await;
        let mut used = false;
        for (at, recorded) in prunes.iter().enumerate() {
            // Not reachable through the flush (module header): the empty cache and the `batchSize` options.
            if at == 0 {
                same("prune 0 is the empty cache", recorded.get("count"), &int(0));
                continue;
            }
            if recorded.get("options").try_get("batchSize").is_some() {
                assert!((5..=7).contains(&at), "prune {at}: an unexpected batchSize");
                continue;
            }
            if used {
                pg.reset().await;
            }
            used = true;
            prune(&pg, &format!("{name}: prune {at}"), recorded).await;
        }
    }
}
