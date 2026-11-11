//! `pg-schema-db.test.mjs` (Node `b6f10295a`), "same dataDir shares in-flight init" and "init failure evicts the cache
//! and rethrows the same error" (`:35`, `:89`), and `createSharedAbortable`'s withdrawal (`abort-race.mjs:79-123`),
//! replayed from `fixtures/shared-open-cases` (`record-shared-open-cases.mjs`): uses that arrive while the database is
//! opening join that one opening (one install), all of them get its failure, the next use opens again, and the opening is
//! cancelled once every use that could withdraw has and none joined that cannot. Node's `createPgSchemaDb` keys this per
//! data dir; the core's [`MemoryStack`] is the one stack of its data dir and opens both of its schemas in that one opening.
//!
//! A use is a `client()` call of the stack's database, held as the future the first poll leaves waiting (the use has
//! joined by then); withdrawing is dropping it. A use that cannot withdraw is `opened_as(true)`, what the background
//! opening calls. Every wait is an event with a deadline: the install's entry, the cancel the install sees, the opening's end.

use super::*;
use serde_json::Value;
use serde_json::json;

type Use = std::pin::Pin<Box<dyn std::future::Future<Output = String> + Send>>;

/// The core's runtime errors read `postgres runtime: <text>`; Node's is the install's own text (declared in the manifest).
fn unprefixed(text: String) -> String {
    text.strip_prefix("postgres runtime: ").map_or(text.clone(), str::to_owned)
}

#[tokio::test(flavor = "multi_thread")]
async fn uses_during_an_opening_join_it_withdraw_and_share_its_failure_as_in_node() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/shared-open-cases/golden.json")).expect("json");
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let dir = tempfile::tempdir().expect("dir");
        let Held { install, installs, mut entered, gate, mut cancelled, .. } = held_install(failing("pg down"));
        let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
        let uses = case["uses"].as_array().expect("uses");
        // Each use joins at its first poll; the first one starts the opening.
        let mut joined: Vec<Option<Use>> = Vec::new();
        for (index, spec) in uses.iter().enumerate() {
            let mut waiting: Use = if spec["signal"] == true {
                let stack = stack.clone();
                Box::pin(async move { unprefixed(message(stack.db().client().await)) })
            } else {
                let stack = stack.clone();
                Box::pin(async move { unprefixed(message(stack.opened_as(true).await.map(|_| ()))) })
            };
            assert!(futures::poll!(waiting.as_mut()).is_pending(), "{name}: use {index} waits for the opening");
            joined.push(Some(waiting));
            if index == 0 {
                awaiting("the opening's install", entered.recv()).await.expect("entered");
            }
        }
        for (index, spec) in uses.iter().enumerate() {
            if spec["withdraw"] == true {
                joined[index] = None;
            }
        }
        let aborted = case["initAborted"] == true;
        if aborted {
            awaiting("the install to see its opening cancelled", cancelled.recv()).await.expect("cancel");
        }
        let during = installs.load(Ordering::SeqCst);
        gate.send(()).expect("the install waits at its gate");
        let mut results = Vec::new();
        for waiting in joined {
            results.push(match waiting {
                Some(waiting) => awaiting("a use's outcome", waiting).await,
                None => "withdrawn".to_owned(),
            });
        }
        if let Some(opening) = stack.settled() {
            awaiting("the opening to settle", opening).await;
        }
        let saw_cancel = cancelled.try_recv().is_ok() || aborted;
        // The failed opening is forgotten: the next use installs again (the held install's gate is spent, so it fails at once).
        let _ = awaiting("the next use of the database to open it again", stack.db().client()).await;
        let got = json!({ "openingsDuring": during, "initAborted": saw_cancel, "results": results, "openingsAfterNextUse": installs.load(Ordering::SeqCst) });
        let want = json!({ "openingsDuring": case["openingsDuring"], "initAborted": case["initAborted"], "results": case["results"], "openingsAfterNextUse": case["openingsAfterNextUse"] });
        assert_eq!(got, want, "{name}");
        stack.stop().await.expect("stop");
    }
}
