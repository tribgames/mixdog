//! The channels' config hot reload (`config-reload-watch.mjs`): a change of the sections the channels runtime reads
//! (`channels`: webhook, events, …; `voice`) reloads it, whoever wrote the file: this process or another one (the
//! external edit reaches the document through [`super::ConfigWatcher`]). A change of any other section restarts no
//! listener. Reloads are not awaited one by one, as Node's: they overlap, and the runtime applies the newest
//! (`ChannelRuntime::reload_runtime`).

use std::sync::Arc;

use mixdog_services::channels::ChannelLifecycle;
use serde_json::Value;
use tokio::task::JoinHandle;

use super::Config;

/// Keeps the follow alive; dropping it stops it (`watch.stop()`), a reload already started runs on.
pub struct ChannelConfigFollow {
    task: JoinHandle<()>,
}

impl Drop for ChannelConfigFollow {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// `channelsConfigSnapshot`: the two sections, an absent one as null.
fn snapshot(config: &Config) -> Value {
    Value::Array(vec![config.get("channels").unwrap_or(Value::Null), config.get("voice").unwrap_or(Value::Null)])
}

impl ChannelConfigFollow {
    /// `watch.start()`: the sections as they stand now are the applied ones.
    pub fn start(config: Config, channels: Arc<dyn ChannelLifecycle>) -> Self {
        let mut changes = config.changes();
        changes.mark_unchanged();
        let mut applied = snapshot(&config);
        let task = tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                let next = snapshot(&config);
                if next == applied {
                    continue;
                }
                applied = next;
                let channels = channels.clone();
                tokio::spawn(async move {
                    let _ = channels.reload_config().await;
                });
            }
        });
        Self { task }
    }
}

#[cfg(test)]
mod feature_tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_services::channels::ChannelLifecycle;
    use mixdog_services::scheduler::ScheduleError;
    use serde_json::Value;
    use serde_json::json;
    use tokio::sync::mpsc;

    use super::ChannelConfigFollow;
    use crate::config::Config;
    use crate::config::ConfigLanes;

    struct Reloads(mpsc::UnboundedSender<()>);

    #[async_trait]
    impl ChannelLifecycle for Reloads {
        fn bridge_active(&self) -> bool {
            false
        }
        async fn set_bridge_active(&self, _: bool) {}
        async fn start_bridge(&self) -> Result<(), String> {
            Ok(())
        }
        async fn stop_owned_runtime(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn reload_config(&self) -> Result<String, String> {
            let _ = self.0.send(());
            Ok(String::new())
        }
        async fn rename_schedule(&self, _: &str, _: &Value, _: bool) -> Result<Value, ScheduleError> {
            unreachable!("the follow never renames a schedule")
        }
    }

    async fn followed() -> (Config, ChannelConfigFollow, mpsc::UnboundedReceiver<()>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, json!({ "agent": {}, "channels": { "webhook": { "port": 1 } } }).to_string()).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let (sender, reloads) = mpsc::unbounded_channel();
        let follow = ChannelConfigFollow::start(config.clone(), Arc::new(Reloads(sender)));
        (config, follow, reloads, dir)
    }

    #[tokio::test]
    async fn a_change_of_the_channels_or_voice_section_reloads_the_channels_runtime() {
        let (config, _follow, mut reloads, _dir) = followed().await;
        config
            .update(|doc| {
                doc.insert("channels".into(), json!({ "webhook": { "port": 2 } }));
                Ok(())
            })
            .await
            .unwrap();
        reloads.recv().await.expect("a channels change reloads");
        config
            .update(|doc| {
                doc.insert("voice".into(), json!({ "enabled": true }));
                Ok(())
            })
            .await
            .unwrap();
        reloads.recv().await.expect("a voice change reloads");
    }

    #[tokio::test]
    async fn a_change_elsewhere_in_the_config_restarts_no_listener() {
        let (config, _follow, mut reloads, _dir) = followed().await;
        config
            .update(|doc| {
                doc.insert("theme".into(), json!("dark"));
                Ok(())
            })
            .await
            .unwrap();
        config
            .update(|doc| {
                doc.insert("channels".into(), json!({ "webhook": { "port": 3 } }));
                Ok(())
            })
            .await
            .unwrap();
        reloads.recv().await.expect("the channels change reloads");
        assert!(reloads.try_recv().is_err(), "the theme change reloaded nothing");
    }

    #[tokio::test]
    async fn a_rewrite_with_the_same_sections_reloads_nothing() {
        let (config, _follow, mut reloads, _dir) = followed().await;
        config
            .update(|doc| {
                doc.insert("channels".into(), json!({ "webhook": { "port": 1 } }));
                Ok(())
            })
            .await
            .unwrap();
        config
            .update(|doc| {
                doc.insert("voice".into(), json!({ "x": 1 }));
                Ok(())
            })
            .await
            .unwrap();
        reloads.recv().await.expect("the voice change reloads");
        assert!(reloads.try_recv().is_err());
    }

    struct Overlapping {
        calls: std::sync::atomic::AtomicUsize,
        second: tokio::sync::Notify,
        done: mpsc::UnboundedSender<usize>,
    }

    #[async_trait]
    impl ChannelLifecycle for Overlapping {
        fn bridge_active(&self) -> bool {
            false
        }
        async fn set_bridge_active(&self, _: bool) {}
        async fn start_bridge(&self) -> Result<(), String> {
            Ok(())
        }
        async fn stop_owned_runtime(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn reload_config(&self) -> Result<String, String> {
            let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if n == 1 {
                // The first load is slow: it ends only once the second has begun.
                self.second.notified().await;
            } else {
                self.second.notify_one();
            }
            let _ = self.done.send(n);
            Ok(String::new())
        }
        async fn rename_schedule(&self, _: &str, _: &Value, _: bool) -> Result<Value, ScheduleError> {
            unreachable!("the follow never renames a schedule")
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reloads_overlap_so_a_slow_load_never_holds_up_a_newer_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, json!({ "agent": {}, "channels": { "webhook": { "port": 1 } } }).to_string()).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let (done, mut finished) = mpsc::unbounded_channel();
        let lifecycle = Arc::new(Overlapping { calls: Default::default(), second: Default::default(), done });
        let _follow = ChannelConfigFollow::start(config.clone(), lifecycle);
        config
            .update(|doc| {
                doc.insert("channels".into(), json!({ "webhook": { "port": 2 } }));
                Ok(())
            })
            .await
            .unwrap();
        config
            .update(|doc| {
                doc.insert("channels".into(), json!({ "webhook": { "port": 3 } }));
                Ok(())
            })
            .await
            .unwrap();
        let first_done = mixdog_rt::time::timeout(std::time::Duration::from_secs(10), finished.recv()).await.expect("a reload finished").unwrap();
        assert_eq!(first_done, 2, "the newer change's reload finished while the older one was still loading");
        assert_eq!(finished.recv().await, Some(1));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_edit_of_the_channels_section_by_another_process_reloads_the_channels_runtime() {
        let (config, _follow, mut reloads, dir) = followed().await;
        let _watch = crate::config::ConfigWatcher::start(config.clone()).unwrap();
        std::fs::write(dir.path().join("mixdog-config.json"), json!({ "agent": {}, "channels": { "webhook": { "port": 9 } } }).to_string()).unwrap();
        mixdog_rt::time::timeout(std::time::Duration::from_secs(10), reloads.recv()).await.expect("the external edit was heard").expect("a reload");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_write_by_another_process_reloads_and_a_write_after_the_follow_ended_reloads_nothing() {
        let (config, follow, mut reloads, dir) = followed().await;
        let _watch = crate::config::ConfigWatcher::start(config.clone()).unwrap();
        let path = dir.path().join("mixdog-config.json");
        for revision in 1..=3 {
            let tmp = dir.path().join("mixdog-config.json.foreign-tmp");
            std::fs::write(&tmp, json!({ "agent": {}, "channels": { "revision": revision } }).to_string()).unwrap();
            std::fs::rename(&tmp, &path).unwrap();
            mixdog_rt::time::timeout(std::time::Duration::from_secs(10), reloads.recv())
                .await
                .unwrap_or_else(|_| panic!("write {revision} was not heard"))
                .expect("a reload");
        }
        assert!(reloads.try_recv().is_err(), "one reload per write, not more");
        drop(follow);
        config
            .update(|doc| {
                doc.insert("channels".into(), json!({ "revision": 4 }));
                Ok(())
            })
            .await
            .unwrap();
        mixdog_rt::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(reloads.try_recv().is_err(), "an in-process write after the follow ended reloads nothing");
    }
}
