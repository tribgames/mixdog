//! The run's shown reports forwarded to the port in order, with their media preparation.

use super::*;

// ---- the commit sink ---------------------------------------------------------------------------------

/// Where a row stands among the run's shown reports ([`Shown::Row`]): answered by the forwarder once every report before the
/// row has reached the port, with the sender it waits on until the row is handed over. Dropped unanswered when the forwarder
/// stops (the run cancelled, its task ended or panicked, its channel gone).
pub(super) type RowPlace = tokio::sync::oneshot::Receiver<tokio::sync::oneshot::Sender<()>>;

/// How a row's hand-over stands after [`row_handover`].
pub(super) enum Handover {
    /// Every report before the row reached the port: the row goes now, and the forwarder, waiting on this sender, takes the
    /// reports after it once the row is handed over.
    Reached(tokio::sync::oneshot::Sender<()>),
    /// The row has no place (a sink that shows nothing): it goes now.
    Unplaced,
    /// The forwarder stopped before reaching the row's place: nothing it still held will reach the port, so the row goes now.
    Gone,
}

/// The one wait of a row's hand-over (hence of `accepted`, which the tool start waits on): the forwarder reaching the row's
/// place among the shown reports. What it can wait for, and why that is bounded:
/// - the reports ahead of the row being sent to the port: each is a send into the producer lane, which waits only for
///   lane room, as the row's own send does;
/// - the media preparation of a report ahead of it ([`Shown::Prepared`]): every preparation starts when its report is
///   produced and runs beside the others, so the wait is the remaining preparation of the slowest report ahead, never a
///   sum of preparations run one after another; a text delta, a card or any other report waits on nothing;
/// - the hand-over of the row before it, which is this same wait.
///
/// It never outlasts the forwarder: a cancelled run ends the forwarder and its preparations, and a forwarder that ends any
/// other way (its task panicked or was dropped, its channel closed) drops the place unanswered. The row then goes at once
/// ([`Handover::Gone`]), so neither the run's flush nor its saves ever wait on forwarding that will not happen.
pub(super) async fn row_handover(place: Option<RowPlace>) -> Handover {
    match place {
        None => Handover::Unplaced,
        Some(place) => match place.await {
            Ok(handed) => Handover::Reached(handed),
            Err(_) => Handover::Gone,
        },
    }
}

pub(super) enum Shown {
    Section(mixdog_core_ports::ports::threads::Section),
    Started(ThreadItem),
    Delta(ItemId, String),
    ReasoningDelta(ItemId, String),
    ReasoningDone(ItemId, String),
    TextSettled(ItemId),
    Notice(String, mixdog_agent::env::Tone),
    Usage(mixdog_core_session::session::UsageReport),
    Compact(mixdog_agent::env::CompactEvent),
    Check(mixdog_core_session::session::run::SendCheck),
    Pass(Box<mixdog_agent::env::CompactPass>),
    ToolStream,
    CompactUsage(mixdog_core_session::session::CompactUsageReport),
    /// Answered once every report before it has reached the port.
    Barrier(tokio::sync::oneshot::Sender<()>),
    /// A row's place among the reports ([`Jobs::row`], [`row_handover`]): once every report before it has reached the port the
    /// forwarder answers it, then waits for the row's hand-over before it takes the reports after it.
    Row(tokio::sync::oneshot::Sender<tokio::sync::oneshot::Sender<()>>),
    /// A report whose media is prepared before it is sent ([`send_prepared`]): the preparation, started when the report was
    /// produced, answers the report.
    Prepared(Preparation),
    /// A hosted web search's spend, as `reportNativeWebSearchUsage` shapes it.
    SearchUsage(Value),
    /// A stage the client shows as its status, with its detail.
    Stage(String, Option<Value>),
    /// A step of the model call the spinner follows.
    Call(mixdog_core_session::session::run::CallMark),
    /// A call's result row, before its batch commits it: its card closes.
    EarlyResult(Value),
    ModelRequest(u32, mixdog_app_protocol::v2::thread::ModelRequestPhase, Option<Vec<Value>>),
    ToolBatch(u32, mixdog_app_protocol::v2::thread::ToolBatchPhase, Option<(u32, u32, u64)>),
}

/// A report's media preparation, owned by the run's forwarding for its whole life: the forwarder awaits it in the report's
/// place, and dropping it (the forwarder ended any way: the run's cancel, its task aborted or panicked, its channel closed,
/// with this queued or being awaited) ends the preparation. It is never detached.
pub(super) struct Preparation(tokio::task::JoinHandle<Shown>);

impl Drop for Preparation {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Future for Preparation {
    /// The prepared report; `None` when the preparation panicked.
    type Output = Option<Shown>;

    fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        Pin::new(&mut self.get_mut().0).poll(cx).map(Result::ok)
    }
}

/// Hands the forwarder a report with media, its preparation (`RunPort::prepare_report`) started now, as the report is produced,
/// beside every other report's: the forwarder sends the report in its place once its own preparation is done
/// ([`Shown::Prepared`]). Once the forwarding is gone nothing is started (and a forwarder that goes between the check and the
/// send drops, so ends, the preparation it never took).
pub(super) fn send_prepared(out: &mpsc::UnboundedSender<Shown>, port: &RunPort, shown: Shown) {
    if out.is_closed() {
        return;
    }
    let port = port.clone();
    let preparation = Preparation(mixdog_rt::spawn(
        "run-report-prepare",
        TaskClass::Work,
        turn_task(async move {
            match &shown {
                Shown::Usage(report) => port.prepare_report(&report.outgoing).await,
                Shown::Check(check) => port.prepare_report(&check.messages).await,
                Shown::Pass(pass) => {
                    port.prepare_report(&pass.request).await;
                    if let mixdog_agent::env::PassStage::Done { after, .. } = &pass.stage {
                        port.prepare_report(after).await;
                    }
                }
                _ => {}
            }
            shown
        }),
    ));
    let _ = out.send(Shown::Prepared(preparation));
}

/// The run's shown reports to the port, one at a time, in the order the run produced them. Per report it awaits only the
/// report's send and, for a report with media, the rest of that report's own preparation, already under way
/// ([`send_prepared`]). The run's cancel ends it, and what it still holds is dropped: a row's place ([`row_handover`]) and every
/// preparation ([`Preparation`]) with it.
pub(super) fn spawn_forwarder(
    port: RunPort,
    mut shown_rx: mpsc::UnboundedReceiver<Shown>,
    cancel: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    mixdog_rt::spawn(
        "run-shown",
        TaskClass::Work,
        turn_task(async move {
            let forward = async {
                while let Some(mut shown) = turn_input(shown_rx.recv()).await {
                    if let Shown::Prepared(preparation) = shown {
                        match preparation.await {
                            Some(ready) => shown = ready,
                            // The preparation panicked: the report is not sent.
                            None => continue,
                        }
                    }
                    let _ = forward_report(&port, shown).await;
                }
            };
            let _ = cancel.run_until_cancelled(forward).await;
        }),
    )
}

/// Sends one report to the port; a report with media arrives here prepared.
pub(super) async fn forward_report(port: &RunPort, shown: Shown) -> Result<(), RunError> {
    match shown {
        Shown::Section(section) => port.section(section).await,
        Shown::Started(item) => port.item_started(item).await,
        Shown::Delta(id, text) => port.delta(id, text).await,
        Shown::ReasoningDelta(id, text) => port.reasoning_delta(id, text).await,
        Shown::ReasoningDone(id, text) => port.reasoning_completed(id, text).await,
        Shown::TextSettled(id) => port.text_settled(id).await,
        Shown::Notice(text, tone) => port.notice(text, tone).await,
        Shown::Usage(report) => port.usage_prepared(report).await,
        Shown::Compact(event) => port.compact_event(event).await,
        Shown::Check(check) => port.send_check_prepared(check).await,
        Shown::SearchUsage(delta) => port.search_usage(delta).await,
        Shown::Stage(stage, detail) => port.stage(stage, detail).await,
        Shown::ModelRequest(index, phase, calls) => port.model_request(index, phase, calls).await,
        Shown::ToolBatch(index, phase, completed) => port.tool_batch(index, phase, completed).await,
        Shown::Call(mark) => port.call_mark(mark).await,
        Shown::EarlyResult(row) => port.early_result(row).await,
        Shown::Pass(pass) => port.compact_pass_prepared(pass).await,
        Shown::ToolStream => port.tool_stream().await,
        Shown::CompactUsage(report) => port.compact_usage(report).await,
        Shown::Barrier(done) => {
            let _ = done.send(());
            Ok(())
        }
        // Every report before the row is on the port: the row goes, and the reports after it wait for its hand-over.
        Shown::Row(reached) => {
            let (handed, on_port) = tokio::sync::oneshot::channel();
            if reached.send(handed).is_ok() {
                let _ = on_port.await;
            }
            Ok(())
        }
        // Unwrapped by the forwarder before it gets here.
        Shown::Prepared(_) => Ok(()),
    }
}
