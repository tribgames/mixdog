//! The grant book's transaction ordering using only temporary files and an async publication gate.
use super::*;
use std::time::Duration;

fn setup() -> (tempfile::TempDir, Arc<DesktopGrantStore>, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first.txt");
    let second = root.path().join("second.txt");
    mixdog_testkit::write(&first, "first");
    mixdog_testkit::write(&second, "second");
    let tokens = mixdog_rt::testing::tokens();
    let lanes = Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk };
    let store = DesktopGrantStore::new(root.path().join(GRANTS_FILE), lanes);
    (root, store, first, second)
}

fn pause(store: &DesktopGrantStore, fail: bool) -> Arc<PublishProbe> {
    let probe = Arc::new(PublishProbe {
        remaining: std::sync::atomic::AtomicUsize::new(1),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        fail,
    });
    assert!(store.publish_probe.set(probe.clone()).is_ok());
    probe
}

async fn describe(store: &DesktopGrantStore, path: &Path) -> WsResult<String> {
    let rows = store.describe(&[path.to_string_lossy().into_owned()], true, &[]).await?;
    Ok(rows[0].access_token.clone().unwrap())
}

#[tokio::test]
async fn started_publication_survives_caller_drop_and_queued_cancellation_never_mints() {
    let (_root, store, first, second) = setup();
    let probe = pause(&store, false);
    let task_store = store.clone();
    let task_first = first.clone();
    let minting = mixdog_rt::spawn("grant-test-mint", mixdog_rt::TaskClass::Work, async move { describe(&task_store, &task_first).await });
    tokio::time::timeout(Duration::from_secs(2), probe.entered.notified()).await.unwrap();

    // A command cancelled while still queued must never add authority or persist a token.
    let (reply, cancelled) = oneshot::channel();
    let row = LocalPathEntry {
        absolute_path: second.to_string_lossy().into_owned(),
        name: "second.txt".into(),
        dir: false,
        size: 6,
        project_path: None,
        rel_path: None,
        access_token: None,
    };
    store.queue().send(Command::Mint { rows: vec![row], minted: vec![(0, second)], reply }).unwrap();
    drop(cancelled);
    let (reply, mut lookup) = oneshot::channel();
    store.queue().send(Command::Lookup { token: "unknown".into(), reply }).unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut lookup).await.is_err(), "lookup passed a pending publication");
    minting.abort();
    assert!(minting.await.is_err());
    probe.release.notify_one();
    assert_eq!(tokio::time::timeout(Duration::from_secs(2), lookup).await.unwrap().unwrap().unwrap(), None);

    let before = mixdog_testkit::read_string(&store.path);
    assert_eq!(parse_grants(&before).0.len(), 1, "cancelled queued mutation was published");
    // Re-describing reuses the token from the completed but abandoned transaction.
    let token = describe(&store, &first).await.unwrap();
    assert!(store.still_granted(&token, &first).await.unwrap());
    assert_eq!(parse_grants(&mixdog_testkit::read_string(&store.path)).0, parse_grants(&before).0);
}

#[tokio::test]
async fn publication_failure_keeps_the_previous_authority_and_token_reuse() {
    let (_root, store, first, second) = setup();
    let token = describe(&store, &first).await.unwrap();
    let previous = mixdog_testkit::read_string(&store.path);
    let probe = pause(&store, true);
    let next = store.clone();
    let minting = mixdog_rt::spawn("grant-test-failure", mixdog_rt::TaskClass::Work, async move { describe(&next, &second).await });
    tokio::time::timeout(Duration::from_secs(2), probe.entered.notified()).await.unwrap();
    probe.release.notify_one();
    assert_eq!(minting.await.unwrap().unwrap_err().message, "fixture publication failure");
    assert_eq!(mixdog_testkit::read_string(&store.path), previous);
    assert!(store.still_granted(&token, &first).await.unwrap());
    assert_eq!(describe(&store, &first).await.unwrap(), token);
}
