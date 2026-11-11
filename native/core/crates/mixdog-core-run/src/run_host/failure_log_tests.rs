use std::future::Future;
use std::pin::Pin;
use std::task::Context;
use std::task::Waker;

use super::*;

struct At(i64);

impl Clock for At {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

fn row(tool: &str) -> Map<String, Value> {
    let Value::Object(row) = json!({ "sessionId": "s", "toolName": tool, "resultText": "failed", "resultKind": "error" }) else { unreachable!() };
    row
}

type Flush = Pin<Box<dyn Future<Output = ()> + Send>>;

/// A flush stuck on the lane with seven more asked for behind it once spent a lane worker on each of them (they waited for the
/// turn inside their lane jobs). The seven are asked for from the lane, right after the first job wrote its chunk: they submit
/// nothing, and one more job, started after they asked, writes the row queued meanwhile and answers all of them.
#[tokio::test]
async fn flushes_asked_for_while_one_runs_wait_off_the_lane_and_share_the_next_flush() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    let config = TraceConfig::from_env(data.path(), &|_| None, false);
    let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
    let writer = Arc::new(FailureWriter::new(&config, io, Arc::new(At(1))));
    let asked: Arc<Mutex<Vec<Flush>>> = Arc::default();
    {
        let (writer_on_lane, asked) = (Arc::downgrade(&writer), Arc::clone(&asked));
        *writer.on_lane.lock().unwrap() = Some(Arc::new(move || {
            let writer = writer_on_lane.upgrade().unwrap();
            if writer.submitted.load(Ordering::Acquire) != 1 {
                return;
            }
            writer.trace.tool_failure(&row("second"), 2);
            for _ in 0..7 {
                let writer = Arc::clone(&writer);
                let mut flush: Flush = Box::pin(async move { writer.flush().await });
                assert!(flush.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending(), "a flush asked for while one runs did not wait");
                asked.lock().unwrap().push(flush);
            }
            assert_eq!(writer.submitted.load(Ordering::Acquire), 1, "a flush asked for while one runs went to the lane");
        }));
    }

    writer.trace.tool_failure(&row("first"), 1);
    writer.flush().await;

    let asked = std::mem::take(&mut *asked.lock().unwrap());
    assert_eq!(asked.len(), 7);
    for flush in asked {
        mixdog_rt::time::timeout(Duration::from_secs(30), flush).await.expect("a flush asked for while one ran was not answered within 30 s");
    }
    assert_eq!(writer.submitted.load(Ordering::Acquire), 2, "the seven flushes asked for meanwhile share one lane job");
    let written = mixdog_testkit::read_string(data.path().join("history").join("tool-failures.jsonl"));
    let tools: Vec<String> = written.lines().map(|line| serde_json::from_str::<Value>(line).unwrap()["tool_name"].as_str().unwrap().to_owned()).collect();
    assert_eq!(tools, ["first", "second"]);
    assert!(!writer.turn.lock().unwrap().running);
}

/// A running flush cancelled while the lane still has its job keeps the turn until that job ends: the job still writes its
/// chunk, and a flush that took the turn at the cancellation would write a later chunk before it.
#[tokio::test]
async fn a_cancelled_flush_keeps_the_turn_until_its_lane_job_ends() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    let config = TraceConfig::from_env(data.path(), &|_| None, false);
    let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
    let writer = Arc::new(FailureWriter::new(&config, io, Arc::new(At(1))));

    // The first flush as its cancellation finds it: the turn taken, its job on the lane.
    let running = Running { writer: &writer, served: Vec::new(), finished: false };
    let job = {
        let mut turn = writer.turn.lock().unwrap();
        turn.running = true;
        turn.job_live = true;
        JobEnd(Arc::clone(&writer.turn))
    };
    drop(running);

    writer.trace.tool_failure(&row("second"), 2);
    let next = Arc::clone(&writer);
    let mut next: Flush = Box::pin(async move { next.flush().await });
    assert!(next.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending(), "a flush took the turn while the cancelled one's job lived");
    assert_eq!(writer.submitted.load(Ordering::Acquire), 0);

    drop(job);
    mixdog_rt::time::timeout(Duration::from_secs(30), next).await.expect("the waiting flush did not take the turn within 30 s of the job's end");
    assert_eq!(writer.submitted.load(Ordering::Acquire), 1);
    assert!(mixdog_testkit::read_string(data.path().join("history").join("tool-failures.jsonl")).contains("\"second\""));
    let turn = writer.turn.lock().unwrap();
    assert!(!turn.running && !turn.job_live && !turn.orphaned);
}

/// A running flush whose task is cancelled with no job on the lane gives the turn up at once: the flush that waited on it
/// takes the turn and writes.
#[tokio::test]
async fn a_flush_waiting_on_a_cancelled_one_takes_the_turn() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    let config = TraceConfig::from_env(data.path(), &|_| None, false);
    let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
    let writer = Arc::new(FailureWriter::new(&config, io, Arc::new(At(1))));

    let running = Running { writer: &writer, served: Vec::new(), finished: false };
    writer.turn.lock().unwrap().running = true;
    writer.trace.tool_failure(&row("first"), 1);
    let waiting = Arc::clone(&writer);
    let mut waiting: Flush = Box::pin(async move { waiting.flush().await });
    assert!(waiting.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
    drop(running);

    mixdog_rt::time::timeout(Duration::from_secs(30), waiting).await.expect("the waiting flush did not take the turn within 30 s");
    assert_eq!(writer.submitted.load(Ordering::Acquire), 1);
    assert!(mixdog_testkit::read_string(data.path().join("history").join("tool-failures.jsonl")).contains("\"first\""));
}
