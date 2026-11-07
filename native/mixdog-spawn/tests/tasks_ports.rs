//! DS-PROC-5 (job strip) and DS-PROC-7 (ports), and the ports golden corpus.

mod common;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use common::*;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_spawn::ports::*;
use mixdog_spawn::tasks::*;
use serde_json::Value;
use serde_json::json;

// ----- ports corpus ---------------------------------------------------------------------------

fn socket_json(s: &ListeningSocket) -> Value {
    json!({ "address": s.address, "pid": s.pid, "port": s.port, "process": s.process })
}

#[test]
fn ports_corpus_matches_the_node_twin() {
    let corpus = fixture("../core/fixtures/desktop/ports/corpus.json");
    assert_eq!(corpus["domain"], "ports");
    let mut parsed: Vec<ListeningSocket> = Vec::new();
    let mut checked = 0;
    for case in corpus["cases"].as_array().unwrap() {
        let args = case["args"].as_array().unwrap();
        match case["op"].as_str().unwrap() {
            "parseLsofListen" => {
                parsed = parse_lsof_listen(args[0].as_str().unwrap());
                let got: Vec<Value> = parsed.iter().map(socket_json).collect();
                assert_eq!(Value::Array(got), case["result"]);
            }
            "parseProcNetTcp" => {
                let family = if args[1] == 6 { Family::V6 } else { Family::V4 };
                let got: Vec<Value> = parse_proc_net_tcp(args[0].as_str().unwrap(), family)
                    .iter()
                    .map(|s| json!({ "address": s.address, "inode": s.inode, "port": s.port }))
                    .collect();
                assert_eq!(Value::Array(got), case["result"]);
            }
            "mergeListeningSockets" => {
                let own_pid = args[1].as_u64().unwrap() as u32;
                let got: Vec<Value> = merge_listening_sockets(&parsed, own_pid)
                    .iter()
                    .map(|p| json!({ "addresses": p.addresses, "pid": p.pid, "port": p.port, "process": p.process }))
                    .collect();
                assert_eq!(Value::Array(got), case["result"]);
            }
            other => panic!("unknown corpus op {other}"),
        }
        checked += 1;
    }
    assert_eq!(checked, 3);
}

/// The OS table, read for real: a listener another program opens is in it with that program's
/// pid and name, and it leaves the table when the program ends. (This process's own sockets are
/// left out, as in the Node twin.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn os_socket_table_lists_another_programs_listener() {
    let own = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let own_port = own.local_addr().unwrap().port();
    let m = manager();
    let h = handle("listener");
    let command = if cfg!(windows) {
        CommandSpec::Shell {
            script: "$l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); \
                     Write-Output \"PORT=$($l.LocalEndpoint.Port)\"; Start-Sleep 60"
                .to_owned(),
            shell: Some("powershell".to_owned()),
        }
    } else {
        CommandSpec::Shell {
            script: "python3 -c \"import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); \
                     print('PORT=%d' % s.getsockname()[1], flush=True); time.sleep(60)\""
                .to_owned(),
            shell: None,
        }
    };
    m.spawn(request(&h, command)).await.unwrap();
    let port: u16 = tokio::time::timeout(Duration::from_secs(30), async {
        let mut events = m.subscribe(&h, Some(0)).unwrap();
        let mut seen = String::new();
        loop {
            if let Some(mixdog_core_api::domain::process::ProcessEvent::Output { bytes, .. }) = events.next().await {
                seen.push_str(&text(&bytes));
                if let Some(at) = seen.find("PORT=") {
                    let digits: String = seen[at + 5..].chars().take_while(char::is_ascii_digit).collect();
                    if seen[at + 5 + digits.len()..].contains('\n') {
                        return digits.parse().unwrap();
                    }
                }
            }
        }
    })
    .await
    .expect("the listener starts");
    let pid = m.info(&h).unwrap().pid;
    let ports = sample_listening_ports().unwrap();
    let theirs = ports.iter().find(|p| p.port == port).unwrap_or_else(|| panic!("port {port} not in {ports:?}"));
    assert_eq!(theirs.pid, Some(pid), "{theirs:?}");
    assert!(theirs.addresses.contains(&"127.0.0.1".to_owned()), "{theirs:?}");
    assert!(theirs.process.is_some(), "{theirs:?}");
    assert!(ports.iter().all(|p| p.port != own_port), "this process's own listener is left out");
    m.kill(&h).unwrap();
    let _ = collect(&m, &h).await;
    let after = sample_listening_ports().unwrap();
    assert!(after.iter().all(|p| p.port != port), "a closed listener left the table");
}

/// DS-PROC-7: subscribe starts sampling and pushes differences; unsubscribe stops the sampler
/// (the thread count returns to its baseline).
#[test]
fn ports_sampler_pushes_diffs_and_stops_with_the_last_viewer() {
    let table: Arc<Mutex<Vec<ListeningPort>>> = Arc::new(Mutex::new(vec![ListeningPort {
        port: 3000,
        addresses: vec!["0.0.0.0".into()],
        process: Some("node".into()),
        pid: Some(100),
    }]));
    let diffs: Arc<Mutex<Vec<PortsDiff>>> = Arc::new(Mutex::new(Vec::new()));
    let (source_table, sink_diffs) = (Arc::clone(&table), Arc::clone(&diffs));
    let hub = PortsHub::with_source(
        Duration::from_millis(20),
        move || Ok(source_table.lock().unwrap().clone()),
        move |diff| sink_diffs.lock().unwrap().push(diff.clone()),
    );
    let baseline = thread_count();
    assert_eq!(hub.sampler_threads(), 0);
    std::thread::sleep(Duration::from_millis(100));
    assert!(diffs.lock().unwrap().is_empty(), "nothing is sampled before anyone views");

    hub.subscribe("viewer-1").unwrap();
    hub.subscribe("viewer-2").unwrap();
    assert_eq!(hub.sampler_threads(), 1, "one sampler for any number of viewers");
    wait_for(|| diffs.lock().unwrap().len() == 1);
    assert_eq!(diffs.lock().unwrap()[0].upserted[0].port, 3000);

    table.lock().unwrap().push(ListeningPort {
        port: 5173,
        addresses: vec!["127.0.0.1".into()],
        process: Some("vite".into()),
        pid: Some(200),
    });
    wait_for(|| diffs.lock().unwrap().len() == 2);
    assert_eq!(diffs.lock().unwrap()[1].upserted.len(), 1);
    assert_eq!(diffs.lock().unwrap()[1].upserted[0].port, 5173);
    table.lock().unwrap().remove(0);
    wait_for(|| diffs.lock().unwrap().len() == 3);
    assert_eq!(diffs.lock().unwrap()[2].removed, vec![3000]);
    // Unchanged samples publish nothing.
    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(diffs.lock().unwrap().len(), 3);

    hub.unsubscribe("viewer-1");
    assert_eq!(hub.sampler_threads(), 1, "a viewer is left");
    hub.unsubscribe("viewer-2");
    wait_for(|| hub.sampler_threads() == 0);
    wait_for(|| thread_count() <= baseline);
    let published = diffs.lock().unwrap().len();
    table.lock().unwrap().push(ListeningPort { port: 9, addresses: vec![], process: None, pid: None });
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(diffs.lock().unwrap().len(), published, "no sampling after the last viewer left");
}

fn wait_for(condition: impl Fn() -> bool) {
    while !condition() {
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ----- job strip ------------------------------------------------------------------------------

#[derive(Default)]
struct Recorder {
    threads: Mutex<Vec<(String, ShellJobsState)>>,
    hosts: Mutex<Vec<HostShellJobs>>,
    /// The expiry wake-ups asked for, in order.
    wakeups: Mutex<Vec<u64>>,
}

impl TaskPublisher for Recorder {
    fn schedule_expiry(&self, at_ms: u64) {
        self.wakeups.lock().unwrap().push(at_ms);
    }

    fn thread_updated(&self, thread: &str, state: &ShellJobsState) {
        self.threads.lock().unwrap().push((thread.to_owned(), state.clone()));
    }

    fn host_updated(&self, state: &HostShellJobs) {
        self.hosts.lock().unwrap().push(state.clone());
    }
}

fn spec(id: &str, owner: &str, started: u64) -> TaskSpec {
    TaskSpec {
        task_id: id.to_owned(),
        surface: "shell".into(),
        op: "run".into(),
        command: format!("cmd {id}"),
        cwd: "C:\\work".into(),
        owner: Some(owner.to_owned()),
        foreground: false,
        process: None,
        started_at_ms: started,
    }
}

fn ids(rows: &[ShellJobRow]) -> Vec<&str> {
    rows.iter().map(|r| r.task_id.as_str()).collect()
}

/// DS-PROC-5: start / finish / stop / release of 20 jobs publishes the states the Node poller
/// would have sampled — running jobs newest first, finished jobs newest finish first with their
/// status and exit code, foreground commands absent until promoted — with no polling.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn job_strip_follows_twenty_jobs_without_polling() {
    let baseline = thread_count();
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let recorder = Arc::new(Recorder::default());
    let tick = Arc::clone(&clock);
    let registry = TaskRegistry::new(Arc::clone(&recorder) as Arc<dyn TaskPublisher>, move || {
        tick.load(Ordering::SeqCst)
    });
    let manager = manager();

    // Twenty background jobs, the last three backed by real processes.
    let mut processes = Vec::new();
    for i in 0..20u64 {
        let id = format!("t{i}");
        let mut task = spec(&id, "th", 1_000_000 + i);
        if i >= 17 {
            let h = handle(&format!("job-{i}"));
            manager.spawn(request(&h, shell("ping -n 60 127.0.0.1 >nul", "sleep 60"))).await.unwrap();
            task.process = Some(h.clone());
            processes.push(h);
        }
        registry.start(task).unwrap();
        let (_, state) = recorder.threads.lock().unwrap().last().cloned().unwrap();
        assert_eq!(state.count as u64, i + 1);
        assert_eq!(state.jobs[0].task_id, id, "newest first");
        assert_eq!(state.jobs.len() as u64, i + 1);
    }
    assert_eq!(recorder.threads.lock().unwrap().len(), 20, "one state per transition");
    assert_eq!(registry.host_state().count, 20);
    assert_eq!(registry.start(spec("t0", "th", 5)), Err(TaskError::Exists));

    // A foreground command is awaited in its own tool card: not listed, nothing published.
    let published = recorder.threads.lock().unwrap().len();
    let mut fg = spec("fg", "th", 1_000_100);
    fg.foreground = true;
    registry.start(fg).unwrap();
    assert_eq!(recorder.threads.lock().unwrap().len(), published);
    assert!(!ids(&registry.thread_state("th").jobs).contains(&"fg"));
    registry.promote("fg").unwrap();
    let (_, state) = recorder.threads.lock().unwrap().last().cloned().unwrap();
    assert_eq!(state.jobs[0].task_id, "fg");
    assert_eq!(state.count, 21);

    // Finish the first five, each differently.
    let outcomes = [
        TaskOutcome { status: TaskStatus::Completed, exit_code: Some(0) },
        TaskOutcome { status: TaskStatus::Failed, exit_code: Some(2) },
        TaskOutcome::of_exit(&ProcessExit { status: ExitStatus::Code(1), killed: Some(KillReason::TimeLimit) }),
        TaskOutcome::of_exit(&ProcessExit { status: ExitStatus::Code(1), killed: Some(KillReason::Requested) }),
        TaskOutcome::of_exit(&ProcessExit { status: ExitStatus::Signal(9), killed: None }),
    ];
    for (i, outcome) in outcomes.iter().enumerate() {
        clock.fetch_add(1000, Ordering::SeqCst);
        registry.finish(&format!("t{i}"), *outcome).unwrap();
        let (_, state) = recorder.threads.lock().unwrap().last().cloned().unwrap();
        assert_eq!(state.count, 20 - i);
        assert!(!ids(&state.jobs).contains(&format!("t{i}").as_str()));
        assert_eq!(state.finished[0].task_id, format!("t{i}"), "newest finish first");
        assert_eq!(state.finished.len(), i + 1);
    }
    let state = registry.thread_state("th");
    let finished: Vec<(&str, Option<TaskStatus>, Option<i32>)> = state
        .finished
        .iter()
        .map(|r| (r.task_id.as_str(), r.status, r.exit_code))
        .collect();
    assert_eq!(
        finished,
        vec![
            ("t4", Some(TaskStatus::Failed), None),
            ("t3", Some(TaskStatus::Cancelled), Some(137)),
            ("t2", Some(TaskStatus::Failed), Some(124)),
            ("t1", Some(TaskStatus::Failed), Some(2)),
            ("t0", Some(TaskStatus::Completed), Some(0)),
        ]
    );
    // Finishing twice changes nothing.
    let published = recorder.threads.lock().unwrap().len();
    registry.finish("t0", outcomes[1]).unwrap();
    assert_eq!(recorder.threads.lock().unwrap().len(), published);

    // Stop: terminate kills the real process tree; the exit finishes the task as cancelled/137.
    for (n, h) in processes.iter().enumerate() {
        let task = format!("t{}", 17 + n);
        registry.terminate(&task, &manager).unwrap();
        let (_, exit) = collect(&manager, h).await;
        assert_eq!(exit.killed, Some(KillReason::Requested));
        registry.finish(&task, TaskOutcome::of_exit(&exit)).unwrap();
        let row = registry.get(&task).unwrap();
        assert_eq!((row.status, row.exit_code), (TaskStatus::Cancelled, Some(137)));
    }
    assert_eq!(registry.terminate("t5", &manager), Err(TaskError::NoProcess));
    assert_eq!(registry.terminate("nope", &manager), Err(TaskError::UnknownTask));
    let state = registry.thread_state("th");
    assert_eq!(state.count, 21 - 5 - 3);
    assert_eq!(ids(&state.finished)[..3], ["t19", "t18", "t17"]);

    // A killed command whose processes are not confirmed gone is listed again; its closed owner
    // makes it orphaned for every thread of the host.
    registry.set_termination_unconfirmed("t2", true).unwrap();
    let host = registry.host_state();
    assert!(ids(&host.jobs).contains(&"t2"));
    assert!(host.orphaned.is_empty());
    registry.owner_closed("th");
    let host = registry.host_state();
    assert_eq!(ids(&host.orphaned), vec!["t2"]);
    registry.release("t2").unwrap();
    assert!(registry.host_state().orphaned.is_empty());
    assert_eq!(registry.release("t2"), Err(TaskError::UnknownTask));

    // Finished rows age out of the strip after 30 minutes, without a timer.
    clock.fetch_add(FINISHED_RETENTION_MS + 1, Ordering::SeqCst);
    assert!(registry.thread_state("th").finished.is_empty());
    clock.store(1_000_000 + 5000, Ordering::SeqCst);
    assert!(!registry.thread_state("th").finished.is_empty());

    // clean drops the finished rows and publishes once.
    let before = recorder.threads.lock().unwrap().len();
    registry.clean("th");
    assert_eq!(recorder.threads.lock().unwrap().len(), before + 1);
    assert!(registry.thread_state("th").finished.is_empty());
    assert!(registry.list().iter().all(|r| r.status == TaskStatus::Running));

    // The registry runs no thread of its own, and nothing asked for a job listing.
    wait_for(|| thread_count() <= baseline + 1);
}

fn outcome_of(status: &str, exit_code: &Value) -> TaskOutcome {
    TaskOutcome {
        status: match status {
            "completed" => TaskStatus::Completed,
            "failed" => TaskStatus::Failed,
            "cancelled" => TaskStatus::Cancelled,
            other => panic!("status {other}"),
        },
        exit_code: exit_code.as_i64().map(|c| c as i32),
    }
}

/// DS-PROC-5 against a real Node run: every step of a recorded life of shell jobs (see
/// `fixtures/record-shell-jobs.mjs`, which runs the poller's `shellJobsStatusFresh` on real job
/// records) must leave the registry's published strips equal to what the poller listed at that
/// moment, including the retention expiry, which the core ticker delivers at the scheduled time.
#[test]
fn job_strip_equals_the_node_poller_at_every_step() {
    let recorded = fixture("tests/fixtures/shell-jobs.json");
    let owners: Vec<&str> = recorded["owners"].as_array().unwrap().iter().map(|o| o.as_str().unwrap()).collect();
    assert_eq!(recorded["retentionMs"].as_u64().unwrap(), FINISHED_RETENTION_MS);
    let clock = Arc::new(AtomicU64::new(0));
    let recorder = Arc::new(Recorder::default());
    let tick = Arc::clone(&clock);
    let registry = TaskRegistry::new(Arc::clone(&recorder) as Arc<dyn TaskPublisher>, move || tick.load(Ordering::SeqCst));
    let (mut fired, mut expiries) = (0u64, 0);
    let steps = recorded["steps"].as_array().unwrap();
    for (n, step) in steps.iter().enumerate() {
        let now = step["now"].as_u64().unwrap();
        // The core ticker: every wake-up the registry asked for that falls before this step.
        loop {
            let due = recorder.wakeups.lock().unwrap().last().copied();
            match due {
                Some(at) if at > fired && at <= now => {
                    clock.store(at, Ordering::SeqCst);
                    registry.expire_finished();
                    fired = at;
                    expiries += 1;
                }
                _ => break,
            }
        }
        clock.store(now, Ordering::SeqCst);
        let id = step["id"].as_str().unwrap_or_default();
        match step["op"].as_str().unwrap() {
            "start" => {
                let mut task = spec(id, step["owner"].as_str().unwrap(), step["startMs"].as_u64().unwrap());
                task.foreground = step["fg"] == json!(true);
                registry.start(task).unwrap();
            }
            "promote" => registry.promote(id).unwrap(),
            "finish" => registry.finish(id, outcome_of(step["status"].as_str().unwrap(), &step["exitCode"])).unwrap(),
            "finishUnconfirmed" => {
                registry.finish(id, outcome_of(step["status"].as_str().unwrap(), &step["exitCode"])).unwrap();
                registry.set_termination_unconfirmed(id, true).unwrap();
            }
            "confirm" => registry.set_termination_unconfirmed(id, false).unwrap(),
            "ownerClosed" => registry.owner_closed(step["owner"].as_str().unwrap()),
            "release" => registry.release(id).unwrap(),
            "clean" => registry.clean(step["owner"].as_str().unwrap()),
            "advance" => {}
            other => panic!("unknown op {other}"),
        }
        // What the clients were last told, not a fresh read.
        let mut told: std::collections::HashMap<String, ShellJobsState> = std::collections::HashMap::new();
        for (thread, state) in recorder.threads.lock().unwrap().iter() {
            told.insert(thread.clone(), state.clone());
        }
        let host = recorder.hosts.lock().unwrap().last().cloned().unwrap_or_default();
        let node = &step["snapshot"];
        for owner in &owners {
            let want = &node["threads"][*owner];
            let have = told.get(*owner).cloned().unwrap_or_default();
            let jobs: Vec<(String, bool)> = have.jobs.iter().map(|j| (j.task_id.clone(), j.termination_unconfirmed)).collect();
            let want_jobs: Vec<(String, bool)> = want["jobs"].as_array().unwrap().iter().map(|j| (j["id"].as_str().unwrap().to_owned(), j["unconfirmed"] == json!(true))).collect();
            assert_eq!(jobs, want_jobs, "step {n} ({}) jobs of {owner}", step["op"]);
            let finished: Vec<Value> = have
                .finished
                .iter()
                .map(|f| json!([f.task_id, f.status.map(TaskStatus::as_str), f.exit_code, f.finished_at_ms]))
                .collect();
            assert_eq!(Value::Array(finished), want["finished"], "step {n} ({}) finished of {owner}", step["op"]);
        }
        let host_jobs: Vec<&str> = host.jobs.iter().map(|j| j.task_id.as_str()).collect();
        let want_host: Vec<&str> = node["host"]["jobs"].as_array().unwrap().iter().map(|j| j.as_str().unwrap()).collect();
        assert_eq!(host_jobs, want_host, "step {n} host jobs");
        assert_eq!(host.count as u64, node["host"]["count"].as_u64().unwrap());
        let orphaned: Vec<&str> = host.orphaned.iter().map(|j| j.task_id.as_str()).collect();
        let want_orphaned: Vec<&str> = node["host"]["orphaned"].as_array().unwrap().iter().map(|j| j.as_str().unwrap()).collect();
        assert_eq!(orphaned, want_orphaned, "step {n} orphaned");
    }
    assert!(expiries >= 2, "the ticker delivered {expiries} expiries");
}
