//! A daemon whose `state/core.sqlite` is damaged still composes: the file is kept aside (`<file>.corrupt-<ms>`), a new one is started
//! and the daemon log says once where the old one is (Node does the same for each state file it finds corrupt:
//! `fixtures/corrupt-state-file-cases`; the store-level replay is `mixdog-store`'s `state_set_aside_tests`).
use super::*;
use std::time::Duration;

/// A good state file, closed: enough room rows to span many pages.
async fn good_state_file(path: &Path, tokens: &LaneTokens) {
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, path).unwrap();
    state
        .write(|tx| {
            for n in 0..40 {
                tx.put_room(&format!("room{n:03}"), &"x".repeat(900))?;
            }
            Ok(())
        })
        .await
        .unwrap();
    state.close();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_core_state_file_does_not_stop_the_daemon_from_composing() {
    let tokens = mixdog_rt::testing::tokens();
    for damage in ["garbage", "truncated", "another database"] {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let state_dir = data.join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let file = state_dir.join("core.sqlite");
        match damage {
            "garbage" => std::fs::write(&file, "{broken, not a database at all").unwrap(),
            "truncated" => {
                good_state_file(&file, &tokens).await;
                let len = std::fs::metadata(&file).unwrap().len();
                std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_len(len / 2).unwrap();
            }
            _ => {
                // The header's application id (bytes 68..72) names another program: `DbError::Rebuild`, a damaged database.
                good_state_file(&file, &tokens).await;
                let mut bytes = std::fs::read(&file).unwrap();
                bytes[68..72].copy_from_slice(&7_i32.to_be_bytes());
                std::fs::write(&file, bytes).unwrap();
            }
        }
        let damaged = std::fs::read(&file).unwrap();
        let stop = mixdog_rt::CancellationToken::new();
        let log = crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone());
        log.enable_file_logging();
        let mut js = crate::js_runtime::fixture(dir.path());
        js.program = "node".into();
        let core = mixdog_rt::time::timeout(Duration::from_secs(60), compose(&tokens, ComposeConfig {
            data_dir: data.clone(), user_data_dir: dir.path().join("userdata"), runtime_root: dir.path().join("runtime"),
            js_runtime: js, ort_library: OrtRuntime::NoBinding,
            outgoing: mixdog_app_server::Outgoing::new(),
            ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
            log: log.clone(),
            stop, catalog_http: crate::compose_test_support::offline_http(),
            pg_install: Some(Arc::new(|_| Box::pin(async {
                Err(mixdog_services::memory::error::MemoryError::Runtime("the state test must not install PostgreSQL".into()))
            }))),
        })).await.expect("composition did not complete within 60 seconds").unwrap_or_else(|e| panic!("{damage}: the daemon must compose: {e}"));
        core.flush_log().await;

        let kept: Vec<PathBuf> = std::fs::read_dir(&state_dir).unwrap().map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("core.sqlite.corrupt-")
                && !p.to_string_lossy().ends_with("-wal") && !p.to_string_lossy().ends_with("-shm")).collect();
        assert_eq!(kept.len(), 1, "{damage}: the damaged file is kept aside");
        assert_eq!(std::fs::read(&kept[0]).unwrap(), damaged, "{damage}: as it was");
        let text = std::fs::read_to_string(data.join("daemon.log")).unwrap();
        let said = text.lines().filter(|l| l.contains("is not a usable database")).collect::<Vec<_>>();
        assert_eq!(said.len(), 1, "{damage}: said once: {text}");
        assert!(said[0].contains(&kept[0].display().to_string()), "{damage}: with the path of what was kept: {}", said[0]);
        mixdog_rt::time::timeout(Duration::from_secs(30), core.stop("state set-aside test")).await.expect("core shutdown did not complete within 30 seconds");
    }
}
