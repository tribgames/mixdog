//! The provider tool-exclusion hookup of a turn (Node `send-phase.mjs:117`): each provider request
//! of the turn begins a new exclusion set for the session, the adapters report the tools they leave
//! out through `RequestOptions.on_tool_excluded`, and the report is recorded for the session. The
//! user is told once per tool (stage `notice`); a later call of an excluded tool is answered with
//! the reason, which the session's tool surface does from the exclusions it is re-derived with.

use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;

use mixdog_agent::env::RunEvent;
use mixdog_agent::env::RunObserver;
use mixdog_agent::env::Stage;
use mixdog_agent::env::Tone;
use mixdog_core_api::domain::provider::ToolExclusionSink;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::ExcludedTool;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::SessionToolExclusions;

/// The run's observer, known once the factory has built the turn's gate.
pub type ObserverSlot = Arc<OnceLock<Arc<dyn RunObserver>>>;

/// The gate reads the session's tool surface per call: re-derive it from the exclusions now.
fn refresh_surface(directory: &Weak<SessionDirectory>, thread: &ThreadId) {
    let Some(handle) = directory.upgrade().and_then(|directory| directory.handle(thread)) else { return };
    if let Err(error) = handle.refresh_surface() {
        tracing::warn!(thread = %thread.as_str(), ?error, "tool surface refresh after an exclusion change was not queued");
    }
}

/// `opts.onToolExcluded = (e) => recordProviderToolExclusion(session, e, opts.onStageChange)`:
/// records the report, shows the notice (tone `warn`) the first time the tool is excluded, and
/// re-derives the surface so a call of the tool is answered with why.
pub fn sink(exclusions: Arc<SessionToolExclusions>, thread: ThreadId, observer: ObserverSlot, directory: Weak<SessionDirectory>) -> ToolExclusionSink {
    ToolExclusionSink(Arc::new(move |report| {
        let tool = ExcludedTool { name: report.name, pointer: report.pointer, reason: report.reason };
        if let Some(message) = exclusions.record(&thread, tool)
            && let Some(observer) = observer.get()
        {
            observer.event(RunEvent::Stage(Stage::Notice { message, tone: Tone::Warn }));
        }
        refresh_surface(&directory, &thread);
    }))
}

/// `RunConfig.request_begin`: `beginProviderToolExclusions` before each provider attempt of the
/// turn (the loop calls it, so a route hop is covered): the exclusions describe the latest request.
pub fn request_begin(exclusions: Arc<SessionToolExclusions>, thread: ThreadId, directory: Weak<SessionDirectory>) -> Arc<dyn Fn() + Send + Sync> {
    Arc::new(move || {
        exclusions.begin_request(&thread);
        refresh_surface(&directory, &thread);
    })
}

#[cfg(test)]
mod tests {

}


