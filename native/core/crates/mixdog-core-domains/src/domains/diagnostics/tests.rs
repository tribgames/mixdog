//! `goldens/doctor.json` is what `runDoctorChecks` and `formatDoctorReport` of the 1.4.5
//! daemon answered (`tools/gen-doctor-golden.mjs`) for scripted runtimes over scripted data
//! folders; the same status contracts are fed to the sources here.

#![allow(clippy::disallowed_methods, reason = "test setup: builds the scripted data folders on the test thread")]

use std::sync::Mutex;

use mixdog_core_api::ids::ThreadId;

use super::*;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;

const GOLDEN: &str = include_str!("../goldens/doctor.json");

/// The status contracts a case scripts; `{"$throw": true}` fails the reader, `{"$hang": true}`
/// never answers, an absent key is a runtime without that status.
struct Scripted {
    fixture: Value,
    node: Value,
    bridges: Value,
    migration: Value,
    notices: Mutex<Vec<(Option<ThreadId>, String)>>,
}

impl Scripted {
    async fn probe(&self, key: &str) -> Probe {
        match self.fixture.get(key) {
            None => Ok(None),
            Some(v) if v.get("$throw").is_some() => Err(ProbeFailed),
            Some(v) if v.get("$hang").is_some() => std::future::pending().await,
            Some(v) => Ok(Some(v.clone())),
        }
    }
}

#[async_trait]
impl DoctorSources for Scripted {
    async fn update(&self) -> Probe {
        self.probe("update").await
    }
    async fn node_runtime(&self) -> Probe {
        Ok(Some(self.node.clone()))
    }
    async fn provider_setup(&self) -> Probe {
        self.probe("providerSetup").await
    }
    fn active_provider(&self) -> Option<String> {
        self.fixture
            .get("provider")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
    }
    async fn mcp_status(&self, _thread: Option<&ThreadId>) -> Probe {
        self.probe("mcpStatus").await
    }
    async fn tool_module_settings(&self) -> Probe {
        self.probe("toolModules").await
    }
    async fn recap_settings(&self) -> Probe {
        self.probe("recap").await
    }
    async fn voice_status(&self) -> Probe {
        self.probe("voice").await
    }
    async fn channel_settings(&self) -> Probe {
        self.probe("channelSettings").await
    }
    async fn channel_worker_status(&self) -> Probe {
        self.probe("channelWorker").await
    }
    async fn channel_setup(&self) -> Probe {
        self.probe("channelSetup").await
    }
    async fn skills_status(&self) -> Probe {
        self.probe("skills").await
    }
    async fn plugins_status(&self) -> Probe {
        self.probe("plugins").await
    }
    async fn hooks_status(&self) -> Probe {
        self.probe("hooks").await
    }
    async fn session_log_migration(&self) -> Probe {
        Ok(Some(self.migration.clone()))
    }
    fn bridge_active(&self, id: &str) -> bool {
        self.bridges[id].as_bool().unwrap()
    }
    async fn notice(&self, thread: Option<&ThreadId>, text: &str) {
        self.notices
            .lock()
            .unwrap()
            .push((thread.cloned(), text.to_owned()));
    }
}

/// The data folder the generator built for `layout`.
fn layout(dir: &std::path::Path, layout: &str) {
    match layout {
        "ok" => {
            std::fs::write(dir.join("mixdog-config.json"), "{}").unwrap();
            for name in ["a.log", "b.log", "c.txt"] {
                std::fs::write(dir.join(name), "").unwrap();
            }
            std::fs::create_dir(dir.join("dir.log")).unwrap();
        }
        "broken" => std::fs::write(dir.join("mixdog-config.json"), "[1]").unwrap(),
        "many" => {
            std::fs::write(dir.join("mixdog-config.json"), "{").unwrap();
            for i in 0..301 {
                std::fs::write(dir.join(format!("p{i}.log")), "").unwrap();
            }
        }
        _ => {}
    }
}

struct Rig {
    service: Arc<DiagnosticsService>,
    sources: Arc<Scripted>,
    data: tempfile::TempDir,
    state: tempfile::TempDir,
}

async fn rig(golden: &Value, case: &Value) -> Rig {
    let data = tempfile::tempdir().unwrap();
    layout(data.path(), case["layout"].as_str().unwrap());
    let state = tempfile::tempdir().unwrap();
    let sources = Arc::new(Scripted {
        fixture: case["fixture"].clone(),
        node: golden["node"].clone(),
        bridges: golden["bridges"].clone(),
        migration: case["migration"].clone(),
        notices: Mutex::new(Vec::new()),
    });
    let service = DiagnosticsService::new(
        sources.clone(),
        DoctorConfig {
            data_dir: data.path().to_owned(),
            package_version: golden["packageVersion"].as_str().map(str::to_owned),
            check_timeout: Duration::from_millis(case["timeoutMs"].as_u64().unwrap()),
        },
        scopes(state.path(), "diagnostics").await,
        &mixdog_rt::testing::tokens(),
    );
    Rig {
        service,
        sources,
        data,
        state,
    }
}

/// `<DATA>` for the data folder, no `checkedAt`, `/` separators as the golden normalizes them.
fn normal(mut result: Value, data: &std::path::Path) -> Value {
    result.as_object_mut().unwrap().shift_remove("checkedAt");
    let text = result
        .to_string()
        .replace(&data.to_string_lossy().replace('\\', "\\\\"), "<DATA>")
        .replace("\\\\", "/");
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn every_case_answers_what_the_node_doctor_answered() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let rig = rig(&golden, case).await;
        let got = value(
            &*rig.service,
            request("diagnostics/runDoctor", with_op(json!({}), 1), Some(1)),
        )
        .await
        .unwrap();
        let want = normal(case["result"].clone(), std::path::Path::new("<none>"));
        let got = normal(got, rig.data.path());
        assert_eq!(got, want, "case {name}");
        assert_eq!(
            format_report(&got),
            case["report"].as_str().unwrap(),
            "report of {name}"
        );
        let _ = &rig.state;
    }
}

#[tokio::test]
async fn the_text_report_is_a_notice_only_when_asked_and_a_second_run_is_busy() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let case = &golden["cases"][0];
    let rig = rig(&golden, case).await;
    value(
        &*rig.service,
        request("diagnostics/runDoctor", with_op(json!({}), 1), Some(1)),
    )
    .await
    .unwrap();
    assert!(rig.sources.notices.lock().unwrap().is_empty());
    let params = with_op(
        json!({ "threadId": "th-1", "options": { "notice": true } }),
        2,
    );
    value(
        &*rig.service,
        request("diagnostics/runDoctor", params, Some(2)),
    )
    .await
    .unwrap();
    {
        let notices = rig.sources.notices.lock().unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].0, Some(ThreadId::from("th-1")));
        assert_eq!(
            notices[0]
                .1
                .replace(&*rig.data.path().to_string_lossy(), "<DATA>"),
            case["report"].as_str().unwrap()
        );
    }

    rig.service.running.store(true, AtomicOrdering::SeqCst);
    let busy = value(
        &*rig.service,
        request("diagnostics/runDoctor", with_op(json!({}), 3), Some(3)),
    )
    .await
    .unwrap();
    assert_eq!(busy, json!({ "busy": true }));
}

#[tokio::test]
async fn a_repeated_op_runs_the_checks_once() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let rig = rig(&golden, &golden["cases"][0]).await;
    let params = with_op(json!({ "options": { "notice": true } }), 5);
    let first = value(
        &*rig.service,
        request("diagnostics/runDoctor", params.clone(), Some(5)),
    )
    .await
    .unwrap();
    let again = value(
        &*rig.service,
        request("diagnostics/runDoctor", params, Some(5)),
    )
    .await
    .unwrap();
    assert_eq!(first, again);
    assert_eq!(rig.sources.notices.lock().unwrap().len(), 1);
}
