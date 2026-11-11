//! `pg-schema-db.test.mjs` (Node `b6f10295a`), "same dataDir shares in-flight init" and "init failure evicts the cache
//! and rethrows the same error" (`:35`, `:89`): uses that arrive while the database is opening join that one opening
//! (one install), all of them get its failure, and the next use opens again. Node's `createPgSchemaDb` keys this per data
//! dir; the core's [`MemoryStack`] is the one stack of its data dir and opens both of its schemas in that one opening.

use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn uses_during_an_opening_join_it_and_share_its_failure_and_the_next_use_opens_again() {
    let dir = tempfile::tempdir().expect("dir");
    let Held { install, installs, mut entered, gate, .. } = held_install(failing("pg down"));
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let first = tokio::spawn({
        let stack = stack.clone();
        async move { message(stack.db().client().await) }
    });
    awaiting("the opening's install", entered.recv()).await.expect("entered");
    let second = tokio::spawn({
        let stack = stack.clone();
        async move { message(stack.db().client().await) }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    gate.send(()).expect("the install waits at its gate");
    let (first, second) = (awaiting("the first use", first).await.expect("task"), awaiting("the second use", second).await.expect("task"));
    assert!(first.contains("pg down"), "{first}");
    assert_eq!(second, first, "the joined use gets the same failure");
    assert_eq!(installs.load(Ordering::SeqCst), 1, "one opening for both uses");

    // The failed opening is forgotten: the next use installs again (the held install's gate is spent, so it fails at once).
    let _ = stack.db().client().await;
    assert_eq!(installs.load(Ordering::SeqCst), 2, "the next use opens again");
    stack.stop().await.expect("stop");
}
