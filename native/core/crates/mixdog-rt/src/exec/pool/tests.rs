//! The lane executors, driven by gates and explicit decisions, never by timing: deadlines only detect a hung test.

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering::SeqCst;

use tokio_util::sync::CancellationToken;

use super::*;

fn refuse(_: Priority) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::PermissionDenied))
}

fn take(_: Priority) -> io::Result<()> {
    Ok(())
}

/// A job that reports `7` through the returned receiver whatever it is answered; dropped
/// unanswered, the receiver disconnects.
fn job(lane: LaneKind) -> (QueuedJob, mpsc::Receiver<i32>) {
    let (tx, rx) = mpsc::channel();
    let run = Box::new(move |_: Answer| {
        let _ = tx.send(7);
    });
    (QueuedJob::new(lane, CancellationToken::new(), run), rx)
}

/// A job that reports how it was answered: run, or why it never ran.
fn answering_job(lane: LaneKind) -> (QueuedJob, mpsc::Receiver<Answer>) {
    with_token(lane, CancellationToken::new())
}

/// [`answering_job`] with the token `cancel`.
fn with_token(lane: LaneKind, cancel: CancellationToken) -> (QueuedJob, mpsc::Receiver<Answer>) {
    let (tx, rx) = mpsc::channel();
    let run = Box::new(move |answer: Answer| {
        let _ = tx.send(answer);
    });
    (QueuedJob::new(lane, cancel, run), rx)
}

/// An [`answering_job`] whose body holds `marker` until it is answered: the job's captures.
fn capturing(lane: LaneKind, cancel: CancellationToken) -> (QueuedJob, mpsc::Receiver<Answer>, Arc<()>) {
    let marker = Arc::new(());
    let held = marker.clone();
    let (tx, rx) = mpsc::channel();
    let run = Box::new(move |answer: Answer| {
        let _held = held;
        let _ = tx.send(answer);
    });
    (QueuedJob::new(lane, cancel, run), rx, marker)
}

/// A job that sends `n` when it runs, and nothing when answered unrun.
fn numbered(n: usize, order: &mpsc::Sender<usize>) -> QueuedJob {
    let order = order.clone();
    QueuedJob::new(
        LaneKind::CpuBulk,
        CancellationToken::new(),
        Box::new(move |answer: Answer| {
            if answer == Answer::Run {
                order.send(n).unwrap();
            }
        }),
    )
}

/// A job that, when run, signals `started`, then blocks until `release` is sent or dropped, then
/// sends on the returned channel: its late "effect". Answered unrun, it does nothing; dropped,
/// the channel disconnects.
fn blocking_job(started: mpsc::Sender<()>, release: mpsc::Receiver<()>) -> (QueuedJob, mpsc::Receiver<()>) {
    let (done_tx, done_rx) = mpsc::channel();
    let run = Box::new(move |answer: Answer| {
        if answer != Answer::Run {
            return;
        }
        started.send(()).unwrap();
        let _ = release.recv_timeout(TEST_WAIT);
        done_tx.send(()).unwrap();
    });
    (QueuedJob::new(LaneKind::CpuBulk, CancellationToken::new(), run), done_rx)
}

/// Like [`blocking_job`], but after `step` is received it reports progress and signals
/// `progressed`, then blocks on `release`.
fn advancing_job(started: mpsc::Sender<()>, step: mpsc::Receiver<()>, progressed: mpsc::Sender<()>, release: mpsc::Receiver<()>) -> QueuedJob {
    let run = Box::new(move |_: Answer| {
        started.send(()).unwrap();
        step.recv_timeout(TEST_WAIT).expect("the test steps the advancing job");
        job_progress();
        progressed.send(()).unwrap();
        let _ = release.recv_timeout(TEST_WAIT);
    });
    QueuedJob::new(LaneKind::CpuBulk, CancellationToken::new(), run)
}

const LEASE: Duration = Duration::from_secs(3600);

/// The deadline of every wait in these tests.
const TEST_WAIT: Duration = Duration::from_secs(60);

fn started(rx: &mpsc::Receiver<()>) {
    rx.recv_timeout(TEST_WAIT).expect("the held job starts on a lane thread");
}

fn answered<T: std::fmt::Debug>(rx: &mpsc::Receiver<T>) -> T {
    rx.recv_timeout(TEST_WAIT).expect("the job is answered")
}

/// Far enough past every job's start for its lease to have expired, without sleeping.
fn after_lease() -> Instant {
    Instant::now() + LEASE
}

/// A held job: the lane's thread is taken until the returned sender is dropped.
fn hold(lane: &LaneExec) -> (mpsc::Sender<()>, mpsc::Receiver<()>) {
    let (started_tx, started_rx) = mpsc::channel();
    let (release, gate) = mpsc::channel::<()>();
    let (holder, done) = blocking_job(started_tx, gate);
    lane.submit(holder).unwrap();
    started(&started_rx);
    (release, done)
}

fn waiting(entered: Entered) -> Ticket {
    match entered {
        Entered::Waiting(ticket) => ticket,
        _ => panic!("the job waits"),
    }
}

/// Waits, on the lane's own signal, until `done` holds.
fn until(lane: &LaneExec, done: impl Fn(&LaneExec) -> bool) {
    let freed = lane.freed();
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(async {
        let wait = async {
            loop {
                let notified = freed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if done(lane) {
                    return;
                }
                notified.await;
            }
        };
        tokio::time::timeout(TEST_WAIT, wait).await.expect("the lane reaches the state");
    });
}

#[test]
fn wedged_workers_are_replaced_then_the_lane_refuses_and_drops_its_queue() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 4, 4, LEASE, &failures, take).unwrap();
    let (started_tx, started_rx) = mpsc::channel();

    // Job A takes the only worker and never returns.
    let (release_a, a_gate) = mpsc::channel::<()>();
    let (a, a_done) = blocking_job(started_tx.clone(), a_gate);
    lane.submit(a).unwrap();
    started(&started_rx);

    // Lease expiry: a replacement worker takes over the lane. A is not abandoned: it is
    // still running, neither finished nor dropped.
    lane.sweep(after_lease());
    assert_eq!(a_done.try_recv(), Err(mpsc::TryRecvError::Empty));
    assert!(!lane.is_wedged());
    assert_eq!(lane.snapshot().wedged, 1);
    let (queued, rx) = job(LaneKind::CpuBulk);
    lane.submit(queued).unwrap();
    assert_eq!(rx.recv_timeout(TEST_WAIT), Ok(7));

    // Job B wedges the replacement too: no healthy worker is left.
    let (release_b, b_gate) = mpsc::channel::<()>();
    let (b, b_done) = blocking_job(started_tx, b_gate);
    lane.submit(b).unwrap();
    started(&started_rx);
    let (c, c_answer) = answering_job(LaneKind::CpuBulk);
    lane.submit(c).unwrap();
    lane.sweep(after_lease());
    assert!(lane.is_wedged());
    // The queued job never runs: it is answered `Wedged`, not left waiting; new work is
    // refused at once.
    assert_eq!(c_answer.recv_timeout(TEST_WAIT), Ok(Answer::Wedged));
    let (d, _d_rx) = job(LaneKind::CpuBulk);
    assert_eq!(lane.submit(d), Err(LaneFull { lane: LaneKind::CpuBulk }));

    // The stuck jobs return late: their effects happened, and the lane comes back.
    drop(release_a);
    drop(release_b);
    assert_eq!(a_done.recv_timeout(TEST_WAIT), Ok(()));
    assert_eq!(b_done.recv_timeout(TEST_WAIT), Ok(()));
    until(&lane, |lane| !lane.is_wedged());
    let (e, e_rx) = job(LaneKind::CpuBulk);
    lane.submit(e).unwrap();
    assert_eq!(e_rx.recv_timeout(TEST_WAIT), Ok(7));
}

/// The lease still works on an elastic lane: the watchdog counts a stuck worker wedged and
/// starts a replacement, and the lane keeps serving.
#[test]
fn an_elastic_lanes_wedged_worker_is_replaced_and_the_lane_keeps_serving() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::elastic_with(LaneKind::InteractiveIo, Priority::Normal, 1, 2, 4, 4, LEASE, Duration::MAX, &failures, take).unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (release, gate) = mpsc::channel::<()>();
    let (stuck, stuck_done) = blocking_job(started_tx, gate);
    lane.submit(stuck).unwrap();
    started(&started_rx);
    lane.sweep(after_lease());
    let snapshot = lane.snapshot();
    assert_eq!((snapshot.wedged, snapshot.threads), (1, 2));
    assert!(!lane.is_wedged());
    let (queued, rx) = job(LaneKind::InteractiveIo);
    lane.submit(queued).unwrap();
    assert_eq!(rx.recv_timeout(TEST_WAIT), Ok(7));
    drop(release);
    assert_eq!(stuck_done.recv_timeout(TEST_WAIT), Ok(()));
}

#[test]
fn a_job_that_reports_progress_keeps_its_lease() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 4, 4, LEASE, &failures, take).unwrap();
    let base = Instant::now();
    let (started_tx, started_rx) = mpsc::channel();
    let (step_tx, step_rx) = mpsc::channel();
    let (progressed_tx, progressed_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    lane.submit(advancing_job(started_tx, step_rx, progressed_tx, release_rx)).unwrap();
    started(&started_rx);

    // Three quarters of the lease with no progress: still within it. The sweep notes the
    // time at which it last saw the job's progress counter.
    lane.sweep(base + LEASE * 3 / 4);
    assert_eq!(lane.snapshot().wedged, 0);

    // The job advances: its lease restarts at the next sweep, so another three quarters
    // later (1.5 leases after it started) it is still healthy.
    step_tx.send(()).unwrap();
    progressed_rx.recv_timeout(TEST_WAIT).expect("the job reports progress");
    lane.sweep(base + LEASE * 3 / 4);
    lane.sweep(base + LEASE * 3 / 2);
    assert_eq!(lane.snapshot().wedged, 0);

    // A full lease with no further progress wedges it.
    lane.sweep(base + LEASE * 7 / 4 + Duration::from_secs(1));
    assert_eq!(lane.snapshot().wedged, 1);
    drop(release_tx);
}

#[test]
fn pooled_lane_that_cannot_take_its_priority_fails_to_start() {
    let failures = Arc::new(AtomicU64::new(0));
    let err = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::BelowNormal, 2, 4, 4, LEASE, &failures, refuse).err().expect("start must fail");
    assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    assert!(err.to_string().contains("cpu-bulk"));
    assert!(failures.load(Relaxed) >= 1);
}

#[test]
fn per_job_lane_drops_a_job_whose_thread_cannot_take_the_priority() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::per_job_with(LaneKind::PtyIo, Priority::Normal, 2, 4, &failures, refuse, spawn_thread).unwrap();
    let (queued, rx) = job(LaneKind::PtyIo);
    lane.submit(queued).unwrap();
    // The submitter sees the failure: the result channel closes without a value.
    assert!(rx.recv_timeout(TEST_WAIT).is_err());
    assert_eq!(failures.load(Relaxed), 1);
    assert_eq!(lane.snapshot().priority_failed, 1);
    assert_eq!(lane.snapshot().completed, 0);
}

/// Only a tool call's job past the threshold is logged, once, naming the tool, the lane, the
/// wait and the run time. Enqueue times are set, not waited for: one far enough in the past,
/// one in the future (its wait reads as zero).
#[test]
fn a_tool_calls_job_that_waited_past_the_threshold_is_logged_once() {
    let stats = LaneStats::new();
    let (lines, _guard) = crate::node_log::capture();
    let long_ago = Instant::now().checked_sub(SLOW_WAIT * 3).expect("an instant before the threshold");
    let ahead = Instant::now() + Duration::from_secs(3600);
    run_job(&stats, QueuedJob::queued_at(LaneKind::SpawnIo, Some("shell"), long_ago, Box::new(|_: Answer| {})));
    run_job(&stats, QueuedJob::queued_at(LaneKind::SpawnIo, Some("shell"), ahead, Box::new(|_: Answer| {})));
    run_job(&stats, QueuedJob::queued_at(LaneKind::MaintenanceIo, None, long_ago, Box::new(|_: Answer| {})));
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 1, "{lines:?}");
    let line = &lines[0].2;
    assert!(line.starts_with("[lane-wait] tool=shell lane=io-spawn waited="), "{line}");
    let waited: u128 = line.split("waited=").nth(1).and_then(|rest| rest.split("ms").next()).unwrap().parse().unwrap();
    assert!(waited >= SLOW_WAIT.as_millis() * 3, "{line}");
    assert!(line.contains("ms ran=") && line.ends_with("ms"), "{line}");
    assert_eq!(stats.completed.load(Relaxed), 3);
}

#[test]
fn per_job_lane_runs_the_job_when_the_priority_applies() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::per_job(LaneKind::PtyIo, Priority::Normal, 2, 4, &failures).unwrap();
    let (queued, rx) = job(LaneKind::PtyIo);
    lane.submit(queued).unwrap();
    assert_eq!(rx.recv_timeout(TEST_WAIT), Ok(7));
    assert_eq!(failures.load(Relaxed), 0);
}

/// The lane shuts down holding an admitted job, a waiter inside its far bound and one beyond it:
/// each is answered that the lane shut down and each waiter's ticket ends `ShutDown`, none left
/// pending while the running job still holds the only thread. Both lane shapes.
#[test]
fn a_lane_that_shuts_down_answers_every_queued_job_and_waiter() {
    let failures = Arc::new(AtomicU64::new(0));
    let pooled = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 4, LEASE, &failures, take).unwrap();
    let per_job = LaneExec::per_job_with(LaneKind::PtyIo, Priority::Normal, 1, 4, &failures, take, spawn_thread).unwrap();
    for lane in [pooled, per_job] {
        let (release, held_done) = hold(&lane);
        let (queued, queued_answer) = answering_job(lane.kind());
        lane.submit(queued).unwrap();
        let (inside, inside_answer) = answering_job(lane.kind());
        let inside_ticket = waiting(lane.enter(inside));
        let fillers: Vec<_> = (0..2)
            .map(|_| {
                let (filler, answer) = answering_job(lane.kind());
                lane.submit(filler).unwrap();
                answer
            })
            .collect();
        let (beyond, beyond_answer) = answering_job(lane.kind());
        let beyond_ticket = waiting(lane.enter(beyond));
        let snapshot = lane.snapshot();
        assert_eq!((snapshot.queue_depth, snapshot.waiters, snapshot.outside), (4, 1, 1));

        drop(lane);
        assert_eq!(answered(&queued_answer), Answer::ShutDown, "the queued job is answered");
        assert_eq!(inside_ticket.end(), Some(TicketEnd::ShutDown), "the waiter inside is answered");
        assert_eq!(answered(&inside_answer), Answer::ShutDown, "its job never runs");
        for answer in fillers {
            assert_eq!(answered(&answer), Answer::ShutDown);
        }
        assert_eq!(beyond_ticket.end(), Some(TicketEnd::ShutDown), "the waiter beyond the bound is answered");
        assert_eq!(answered(&beyond_answer), Answer::ShutDown, "its job, which the lane held, never runs");
        drop(release);
        assert_eq!(held_done.recv_timeout(TEST_WAIT), Ok(()), "the running job finishes on its thread");
    }
}

/// Admission is arrival: a waiter behind another is admitted only after it, and a withdrawn
/// head waiter's job is taken out without running while those behind keep their order.
#[test]
fn waiters_are_admitted_and_run_in_arrival_order_and_a_withdrawn_head_never_runs() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 8, LEASE, &failures, take).unwrap();
    let (release, _held_done) = hold(&lane);
    let (order_tx, order) = mpsc::channel();
    let entered: Vec<_> = (0..4).map(|n| lane.enter(numbered(n, &order_tx))).collect();
    // The first is admitted (room 1); the three behind it wait.
    assert!(matches!(entered[0], Entered::Admitted));
    let tickets: Vec<Ticket> = entered.into_iter().skip(1).map(waiting).collect();
    assert_eq!(lane.snapshot().waiters, 3);
    // The head waiter withdraws; the others keep their places.
    assert!(lane.withdraw(&tickets[0]));
    assert_eq!(tickets[0].end(), Some(TicketEnd::Withdrawn));
    assert!(tickets[1..].iter().all(|t| t.end().is_none()));
    drop(release);
    let ran: Vec<usize> = (0..3).map(|_| answered(&order)).collect();
    assert_eq!(ran, [0, 2, 3], "arrival order, the withdrawn job never runs");
    assert_eq!(tickets[1].end(), Some(TicketEnd::Admitted));
    assert_eq!(tickets[2].end(), Some(TicketEnd::Admitted));
}

/// Interactive sizing, 512 jobs held behind a blocked worker: waiters beyond the bound keep it at
/// 512 and are never refused, plain attempts are, and a waiter cancelled or withdrawn in the
/// middle or at the tail is taken out at once, its captures released, without a pop. The work
/// done under the lock is counted in node visits: one per registration, one per withdrawal, none
/// for a plain refusal, so twice the waiters cost twice the work.
#[test]
fn a_full_queue_keeps_its_bound_refuses_only_plain_work_and_takes_withdrawn_waiters_out_at_once() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 16, 512, LEASE, &failures, take).unwrap();
    let (release, _held_done) = hold(&lane);
    let queued: Vec<_> = (0..512)
        .map(|_| {
            let (queued, answer) = answering_job(LaneKind::CpuBulk);
            lane.submit(queued).unwrap();
            answer
        })
        .collect();
    assert_eq!(lane.snapshot().queue_depth, 512);

    let register = |count: usize| {
        let before = lane.visits();
        let waiters: Vec<_> = (0..count)
            .map(|n| {
                let cancel = CancellationToken::new();
                let (waiter, answer, marker) = capturing(LaneKind::CpuBulk, cancel.clone());
                let ticket = waiting(lane.enter(waiter));
                if n % 25 == 0 {
                    let visits = lane.visits();
                    let (plain, _) = job(LaneKind::CpuBulk);
                    assert_eq!(lane.submit(plain), Err(LaneFull { lane: LaneKind::CpuBulk }), "a plain attempt is refused at the bound");
                    assert_eq!(lane.visits(), visits, "a plain refusal walks neither segment");
                }
                (cancel, answer, marker, ticket)
            })
            .collect::<Vec<_>>();
        (waiters, lane.visits() - before)
    };
    let (mut waiters, first) = register(100);
    let (more, second) = register(200);
    waiters.extend(more);
    assert_eq!((first, second), (100, 200), "registration work is linear in the waiters");
    let snapshot = lane.snapshot();
    assert_eq!((snapshot.queue_depth, snapshot.outside), (512, 300));

    // A waiter in the middle is cancelled: its token's listener takes it out with no pop or poll.
    let visits = lane.visits();
    waiters[150].0.cancel();
    assert_eq!(waiters[150].3.end(), Some(TicketEnd::Withdrawn));
    assert_eq!(waiters[150].1.try_recv(), Ok(Answer::Cancelled));
    assert_eq!(Arc::strong_count(&waiters[150].2), 1, "its captures are released");
    assert_eq!(lane.visits() - visits, 1);
    // The tail waiter's wait is dropped: withdrawn by its key.
    let visits = lane.visits();
    assert!(lane.withdraw(&waiters[299].3));
    assert_eq!(waiters[299].3.end(), Some(TicketEnd::Withdrawn));
    assert_eq!(waiters[299].1.try_recv(), Ok(Answer::Cancelled));
    assert_eq!(Arc::strong_count(&waiters[299].2), 1);
    assert_eq!(lane.visits() - visits, 1);
    let snapshot = lane.snapshot();
    assert_eq!((snapshot.queue_depth, snapshot.outside), (512, 298));
    assert_eq!(lane.dispatched().len(), 1, "only the held job was given to a thread");
    drop(release);
    for answer in &queued {
        assert_eq!(answered(answer), Answer::Run);
    }
}

/// One worker: the holder runs, A is queued, B waits, then C. B's token is cancelled with its
/// listener off, before any place frees; the worker then takes A. The decision that would admit B
/// sees the cancellation: B hears `Withdrawn`, its job `Cancelled`, never run, and C advances. B
/// beyond the bound (`room = bound = 1`) and B inside it behind the room edge (`bound = 4`).
#[test]
fn a_waiter_cancelled_before_a_place_frees_hears_cancelled_and_the_next_one_advances() {
    for bound in [1, 4] {
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, bound, LEASE, &failures, take).unwrap();
        lane.listening(false);
        let (release, _held_done) = hold(&lane);
        let (a, a_answer) = answering_job(LaneKind::CpuBulk);
        lane.submit(a).unwrap();
        let b_cancel = CancellationToken::new();
        let (b, b_answer) = with_token(LaneKind::CpuBulk, b_cancel.clone());
        let b_ticket = waiting(lane.enter(b));
        let (c, c_answer) = answering_job(LaneKind::CpuBulk);
        let c_ticket = waiting(lane.enter(c));
        assert_eq!(lane.snapshot().outside, if bound == 1 { 2 } else { 0 });
        b_cancel.cancel();
        assert_eq!(b_ticket.end(), None, "with its listener off, nothing decided B yet");

        drop(release);
        assert_eq!(answered(&a_answer), Answer::Run);
        assert_eq!(answered(&c_answer), Answer::Run, "the oldest live waiter advances");
        assert_eq!(b_ticket.end(), Some(TicketEnd::Withdrawn));
        assert_eq!(answered(&b_answer), Answer::Cancelled, "B's job never runs");
        assert_eq!(c_ticket.end(), Some(TicketEnd::Admitted));
    }

    // Listening: the cancellation alone takes B out, with no free place, pop or poll.
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 1, LEASE, &failures, take).unwrap();
    let (release, _held_done) = hold(&lane);
    let (a, _a_answer) = answering_job(LaneKind::CpuBulk);
    lane.submit(a).unwrap();
    let b_cancel = CancellationToken::new();
    let (b, b_answer) = with_token(LaneKind::CpuBulk, b_cancel.clone());
    let b_ticket = waiting(lane.enter(b));
    b_cancel.cancel();
    assert_eq!(b_ticket.end(), Some(TicketEnd::Withdrawn));
    assert_eq!(b_answer.try_recv(), Ok(Answer::Cancelled));
    assert_eq!((lane.snapshot().queue_depth, lane.snapshot().outside), (1, 0));
    assert_eq!(lane.dispatched().len(), 1, "no pop: only the held job was given to a thread");
    drop(release);
}

/// Waiters beyond the bound are dispatched in arrival order, never in the order they are woken or
/// polled; moving inside the bound alone does not admit a waiter; a plain job arriving after a
/// waiter is dispatched after it, or refused while the queue is full.
#[test]
fn waiters_beyond_the_bound_keep_their_arrival_order() {
    // One worker, room 1, bound 2: X1 and X2 fill the queue, B and C wait beyond it.
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 2, LEASE, &failures, take).unwrap();
    let (release, _held_done) = hold(&lane);
    let (order_tx, order) = mpsc::channel();
    lane.submit(numbered(1, &order_tx)).unwrap();
    lane.submit(numbered(2, &order_tx)).unwrap();
    let b = waiting(lane.enter(numbered(3, &order_tx)));
    let c = waiting(lane.enter(numbered(4, &order_tx)));
    drop(release);
    let ran: Vec<usize> = (0..4).map(|_| answered(&order)).collect();
    assert_eq!(ran, [1, 2, 3, 4]);
    assert_eq!((b.end(), c.end()), (Some(TicketEnd::Admitted), Some(TicketEnd::Admitted)));
    assert!(lane.dispatched().is_sorted(), "{:?}", lane.dispatched());

    // B alone beyond the bound; the first free place brings B inside but not into the room, and a
    // plain D is refused; the second admits B, and D then queues behind it.
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 2, LEASE, &failures, take).unwrap();
    let (release, _held_done) = hold(&lane);
    let (x1_started_tx, x1_started) = mpsc::channel();
    let (release_x1, x1_gate) = mpsc::channel::<()>();
    let (x1, _x1_done) = blocking_job(x1_started_tx.clone(), x1_gate);
    lane.submit(x1).unwrap();
    let (release_x2, x2_gate) = mpsc::channel::<()>();
    let (x2, _x2_done) = blocking_job(x1_started_tx, x2_gate);
    lane.submit(x2).unwrap();
    let (order_tx, order) = mpsc::channel();
    let b = waiting(lane.enter(numbered(1, &order_tx)));
    drop(release);
    started(&x1_started);
    assert_eq!((lane.snapshot().queue_depth, lane.snapshot().outside), (2, 0), "B moved inside the bound");
    assert_eq!(b.end(), None, "inside the bound but behind the room: not admitted");
    assert_eq!(lane.submit(numbered(9, &order_tx)), Err(LaneFull { lane: LaneKind::CpuBulk }), "D is refused while full");
    drop(release_x1);
    started(&x1_started);
    assert_eq!(b.end(), Some(TicketEnd::Admitted));
    lane.submit(numbered(2, &order_tx)).unwrap();
    drop(release_x2);
    assert_eq!([answered(&order), answered(&order)], [1, 2], "B, then the later plain D");

    // Two workers: dispatch (claim) order is arrival order.
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 2, 1, 2, LEASE, &failures, take).unwrap();
    let (release_1, _done_1) = hold(&lane);
    let (release_2, _done_2) = hold(&lane);
    let (order_tx, order) = mpsc::channel();
    for n in 0..5 {
        let _ = lane.enter(numbered(n, &order_tx));
    }
    drop(release_1);
    drop(release_2);
    for _ in 0..5 {
        answered(&order);
    }
    let dispatched = lane.dispatched();
    assert_eq!(dispatched.len(), 7);
    assert!(dispatched.is_sorted(), "{dispatched:?}");
}

/// The thread-per-job lane, one thread and a queue of one: A queued, B, C and D waiting beyond the
/// bound. Once the held job ends, its thread runs A, B, C and D in order and exits, with no poll or
/// submission to start them; the idle lane then serves new work.
#[test]
fn a_thread_per_job_lane_serves_its_waiters_in_order_without_a_poll() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::per_job_with(LaneKind::PtyIo, Priority::Normal, 1, 1, &failures, take, spawn_thread).unwrap();
    let (release, _held_done) = hold(&lane);
    let (order_tx, order) = mpsc::channel();
    lane.submit(numbered(1, &order_tx)).unwrap();
    let tickets: Vec<Ticket> = (2..5).map(|n| waiting(lane.enter(numbered(n, &order_tx)))).collect();
    assert_eq!(lane.snapshot().outside, 3);
    drop(release);
    let ran: Vec<usize> = (0..4).map(|_| answered(&order)).collect();
    assert_eq!(ran, [1, 2, 3, 4], "D cannot pass C");
    assert!(tickets.iter().all(|ticket| ticket.end() == Some(TicketEnd::Admitted)));
    until(&lane, |lane| lane.snapshot().threads == 0);
    let snapshot = lane.snapshot();
    assert_eq!((snapshot.queue_depth, snapshot.outside), (0, 0));
    lane.submit(numbered(5, &order_tx)).unwrap();
    assert_eq!(answered(&order), 5);
}

/// Withdrawal by key wherever the job lies (beyond the bound, inside it, admitted but not yet
/// taken): it releases the job's captures, moves the next one up and calls no body but the unrun
/// answer. A stale key never touches its slot's next occupant. Once a thread took a job, a
/// withdrawal is too late and the job runs once.
#[test]
fn withdrawal_by_key_releases_the_job_and_never_touches_a_later_occupant() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 2, LEASE, &failures, take).unwrap();
    let (release, _held_done) = hold(&lane);
    let (a_started_tx, a_started) = mpsc::channel();
    let (release_a, a_gate) = mpsc::channel::<()>();
    let (a, _a_done) = blocking_job(a_started_tx, a_gate);
    lane.submit(a).unwrap();
    let (b, b_answer, b_marker) = capturing(LaneKind::CpuBulk, CancellationToken::new());
    let b = (waiting(lane.enter(b)), b_answer, b_marker);
    let (c, c_answer, c_marker) = capturing(LaneKind::CpuBulk, CancellationToken::new());
    let c = (waiting(lane.enter(c)), c_answer, c_marker);
    let (d, d_answer, _d_marker) = capturing(LaneKind::CpuBulk, CancellationToken::new());
    let d = (waiting(lane.enter(d)), d_answer);

    assert!(lane.withdraw(&c.0), "withdrawn beyond the bound");
    assert_eq!((c.1.try_recv(), Arc::strong_count(&c.2)), (Ok(Answer::Cancelled), 1));
    assert!(lane.withdraw(&b.0), "withdrawn inside the bound");
    assert_eq!((b.1.try_recv(), Arc::strong_count(&b.2)), (Ok(Answer::Cancelled), 1));
    assert_eq!((lane.snapshot().queue_depth, lane.snapshot().outside), (2, 0), "D moved inside");

    // E takes the slot B left; B's stale key does nothing to it.
    let (e, e_answer) = answering_job(LaneKind::CpuBulk);
    let e = waiting(lane.enter(e));
    assert_eq!(e.key().index, b.0.key().index);
    assert!(!lane.withdraw(&b.0));
    assert_eq!(lane.snapshot().outside, 1);

    // The worker takes A: D is admitted (not taken), E moves inside. D's wait is dropped: it wins.
    drop(release);
    started(&a_started);
    assert_eq!(d.0.end(), Some(TicketEnd::Admitted));
    assert!(lane.withdraw(&d.0), "an admitted job no thread took yet is still withdrawn");
    assert_eq!(d.1.try_recv(), Ok(Answer::Cancelled));
    // A thread takes E: a withdrawal after that is too late, and E runs exactly once.
    drop(release_a);
    assert_eq!(answered(&e_answer), Answer::Run);
    assert!(!lane.withdraw(&e));
    assert_eq!(e_answer.recv_timeout(TEST_WAIT), Err(mpsc::RecvTimeoutError::Disconnected), "one answer: the run");
}

static REFUSE_REPLACEMENTS: AtomicBool = AtomicBool::new(false);

/// The boot worker takes its priority; a later worker does not while the flag is set.
fn boot_then_refuse(_: Priority) -> io::Result<()> {
    if REFUSE_REPLACEMENTS.load(SeqCst) { Err(io::Error::from(io::ErrorKind::PermissionDenied)) } else { Ok(()) }
}

/// The only worker wedges and its replacement cannot take the priority: the lane has no healthy
/// worker. An admitted job (its wait already resolved), a waiter inside the bound and one beyond it
/// are answered `Wedged` in that decision; none runs after the stuck job returns and the lane
/// recovers, while the stuck job keeps its own result. Work arriving meanwhile is refused as
/// unhealthy; after recovery it is served.
#[test]
fn a_lane_that_loses_its_last_healthy_worker_answers_what_it_holds_and_never_runs_it_later() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 2, LEASE, &failures, boot_then_refuse).unwrap();
    let (release, held_done) = hold(&lane);
    let (admitted, admitted_answer) = answering_job(LaneKind::CpuBulk);
    assert!(matches!(lane.enter(admitted), Entered::Admitted));
    let (inside, inside_answer) = answering_job(LaneKind::CpuBulk);
    let inside = waiting(lane.enter(inside));
    let (beyond, beyond_answer) = answering_job(LaneKind::CpuBulk);
    let beyond = waiting(lane.enter(beyond));

    REFUSE_REPLACEMENTS.store(true, SeqCst);
    lane.sweep(after_lease());
    assert_eq!(answered(&admitted_answer), Answer::Wedged);
    assert_eq!(answered(&inside_answer), Answer::Wedged);
    assert_eq!(answered(&beyond_answer), Answer::Wedged);
    assert_eq!((inside.end(), beyond.end()), (Some(TicketEnd::Wedged), Some(TicketEnd::Wedged)));
    let (late, _late_answer) = answering_job(LaneKind::CpuBulk);
    assert!(matches!(lane.enter(late), Entered::Wedged));
    REFUSE_REPLACEMENTS.store(false, SeqCst);

    drop(release);
    assert_eq!(held_done.recv_timeout(TEST_WAIT), Ok(()), "the stuck job keeps its own result");
    until(&lane, |lane| !lane.is_wedged());
    let (after, after_answer) = answering_job(LaneKind::CpuBulk);
    lane.submit(after).unwrap();
    assert_eq!(answered(&after_answer), Answer::Run);
    for answer in [&admitted_answer, &inside_answer, &beyond_answer] {
        assert_eq!(answer.try_recv(), Err(mpsc::TryRecvError::Disconnected), "answered once, never run");
    }
}

/// A cancellation the lane has not acted on yet (listener off) and a close: whichever came first
/// names the outcome, for an admitted job and a waiter.
#[test]
fn cancellation_and_close_keep_the_cause_that_came_first() {
    for cancel_first in [true, false] {
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 2, LEASE, &failures, take).unwrap();
        lane.listening(false);
        let (release, _held_done) = hold(&lane);
        let cancel = CancellationToken::new();
        let (admitted, admitted_answer) = with_token(LaneKind::CpuBulk, cancel.clone());
        assert!(matches!(lane.enter(admitted), Entered::Admitted));
        let (waiter, waiter_answer) = with_token(LaneKind::CpuBulk, cancel.clone());
        let waiter = waiting(lane.enter(waiter));
        if cancel_first {
            cancel.cancel();
            lane.shut_down_now();
        } else {
            lane.shut_down_now();
            cancel.cancel();
        }
        let (answer, end) = if cancel_first { (Answer::Cancelled, TicketEnd::Withdrawn) } else { (Answer::ShutDown, TicketEnd::ShutDown) };
        assert_eq!(answered(&admitted_answer), answer);
        assert_eq!(answered(&waiter_answer), answer);
        assert_eq!(waiter.end(), Some(end));
        drop(release);
    }
}

static FIRST_START: AtomicBool = AtomicBool::new(true);
static FIRST_GATE: std::sync::OnceLock<std::sync::Barrier> = std::sync::OnceLock::new();

/// The first thread start holds until the test has queued behind it, then fails; later starts succeed.
fn first_held_then_refused(builder: std::thread::Builder, body: Box<dyn FnOnce() + Send>) -> io::Result<()> {
    if FIRST_START.swap(false, SeqCst) {
        let gate = FIRST_GATE.get_or_init(|| std::sync::Barrier::new(2));
        gate.wait();
        gate.wait();
        return Err(io::Error::from(io::ErrorKind::OutOfMemory));
    }
    spawn_thread(builder, body)
}

/// The thread-per-job lane cannot start the thread that would serve its queue: the job given to
/// that start, the queued job and the waiter beyond the bound are each answered once that the lane
/// has no healthy worker, the slot is released, and a later submission starts a fresh thread.
#[test]
fn a_thread_per_job_lane_whose_last_thread_cannot_start_answers_what_waits_as_wedged() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = Arc::new(LaneExec::per_job_with(LaneKind::PtyIo, Priority::Normal, 1, 1, &failures, take, first_held_then_refused).unwrap());
    let gate = FIRST_GATE.get_or_init(|| std::sync::Barrier::new(2));
    let (first, first_answer) = answering_job(LaneKind::PtyIo);
    let starting = {
        let lane = lane.clone();
        std::thread::spawn(move || lane.submit(first))
    };
    gate.wait();
    let (queued, queued_answer) = answering_job(LaneKind::PtyIo);
    lane.submit(queued).unwrap();
    let (beyond, beyond_answer) = answering_job(LaneKind::PtyIo);
    let ticket = waiting(lane.enter(beyond));
    gate.wait();

    assert_eq!(starting.join().unwrap(), Ok(()));
    assert_eq!(answered(&first_answer), Answer::Wedged, "the start's own job is answered, not lost with the start");
    assert_eq!(answered(&queued_answer), Answer::Wedged);
    assert_eq!(answered(&beyond_answer), Answer::Wedged);
    assert_eq!(ticket.end(), Some(TicketEnd::Wedged));
    let snapshot = lane.snapshot();
    assert_eq!((snapshot.threads, snapshot.queue_depth, snapshot.outside), (0, 0, 0));
    let (fresh, fresh_answer) = answering_job(LaneKind::PtyIo);
    lane.submit(fresh).unwrap();
    assert_eq!(answered(&fresh_answer), Answer::Run);
}

static SECOND_STARTS: AtomicUsize = AtomicUsize::new(0);
static SECOND_GATE: std::sync::OnceLock<std::sync::Barrier> = std::sync::OnceLock::new();

/// The second thread start holds until the test has queued behind it, then fails; the others succeed.
fn second_held_then_refused(builder: std::thread::Builder, body: Box<dyn FnOnce() + Send>) -> io::Result<()> {
    if SECOND_STARTS.fetch_add(1, SeqCst) == 1 {
        let gate = SECOND_GATE.get_or_init(|| std::sync::Barrier::new(2));
        gate.wait();
        gate.wait();
        return Err(io::Error::from(io::ErrorKind::OutOfMemory));
    }
    spawn_thread(builder, body)
}

/// With another thread alive, a failed start answers only its own job (`NotStarted`); the queue is
/// not drained, and the surviving thread serves it in order.
#[test]
fn a_failed_start_beside_a_live_thread_answers_only_its_own_job() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = Arc::new(LaneExec::per_job_with(LaneKind::PtyIo, Priority::Normal, 2, 1, &failures, take, second_held_then_refused).unwrap());
    let gate = SECOND_GATE.get_or_init(|| std::sync::Barrier::new(2));
    let (release, _held_done) = hold(&lane);
    let (refused, refused_answer) = answering_job(LaneKind::PtyIo);
    let starting = {
        let lane = lane.clone();
        std::thread::spawn(move || lane.submit(refused))
    };
    gate.wait();
    let (queued, queued_answer) = answering_job(LaneKind::PtyIo);
    lane.submit(queued).unwrap();
    let (beyond, beyond_answer) = answering_job(LaneKind::PtyIo);
    let ticket = waiting(lane.enter(beyond));
    gate.wait();
    assert_eq!(starting.join().unwrap(), Ok(()));
    assert_eq!(answered(&refused_answer), Answer::NotStarted);
    assert_eq!(queued_answer.try_recv(), Err(mpsc::TryRecvError::Empty), "the queue is not drained");
    assert_eq!((lane.snapshot().threads, lane.snapshot().queue_depth, lane.snapshot().outside), (1, 1, 1));
    drop(release);
    assert_eq!(answered(&queued_answer), Answer::Run);
    assert_eq!(answered(&beyond_answer), Answer::Run);
    assert_eq!(ticket.end(), Some(TicketEnd::Admitted));
}

static CLOSE_STARTS: AtomicBool = AtomicBool::new(true);
static CLOSE_GATE: std::sync::OnceLock<std::sync::Barrier> = std::sync::OnceLock::new();

/// The first thread start holds until the test has closed the lane, then succeeds.
fn first_held_then_started(builder: std::thread::Builder, body: Box<dyn FnOnce() + Send>) -> io::Result<()> {
    if CLOSE_STARTS.swap(false, SeqCst) {
        let gate = CLOSE_GATE.get_or_init(|| std::sync::Barrier::new(2));
        gate.wait();
        gate.wait();
    }
    spawn_thread(builder, body)
}

/// The lane closes while a thread for a job is being started: close answers the job `ShutDown`,
/// and the thread that starts later finds nothing to run and exits.
#[test]
fn a_close_during_a_thread_start_answers_its_job_and_the_late_thread_runs_nothing() {
    let failures = Arc::new(AtomicU64::new(0));
    let lane = Arc::new(LaneExec::per_job_with(LaneKind::PtyIo, Priority::Normal, 1, 1, &failures, take, first_held_then_started).unwrap());
    let gate = CLOSE_GATE.get_or_init(|| std::sync::Barrier::new(2));
    let (first, first_answer) = answering_job(LaneKind::PtyIo);
    let starting = {
        let lane = lane.clone();
        std::thread::spawn(move || lane.submit(first))
    };
    gate.wait();
    lane.shut_down_now();
    gate.wait();
    assert_eq!(starting.join().unwrap(), Ok(()));
    assert_eq!(answered(&first_answer), Answer::ShutDown);
    until(&lane, |lane| lane.snapshot().threads == 0);
    assert_eq!(first_answer.try_recv(), Err(mpsc::TryRecvError::Disconnected), "answered once, never run");
}
