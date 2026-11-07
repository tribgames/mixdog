//! The `export` transfer source's renderer: a paired device's PNG/PDF of a visualize pane, drawn
//! by the desktop host (Node main's `exportForDevice`, reached by `hostRequest('visualizeExport',
//! [command])`, `remote-visualize.ts:329`).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::Method;
use mixdog_core_domains::domains::visualize_export::ExportRenderer;
use mixdog_core_domains::domains::visualize_export::RenderedExport;
use mixdog_workspace::error::Reason;
use mixdog_workspace::error::WsError;
use mixdog_workspace::error::WsResult;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// The host method of the visualize pane commands; an `export` carrying `forDevice` is
/// `exportForDevice`: it draws into a fresh `mixdog-visualize-export-*` temp folder without the
/// save dialog and answers `{path, pages?}`.
const HOST_VISUALIZE_COMMAND: &str = "host/visualize/command";

/// The project folder of a session: the `cwd` that `HostVisualizeCommandParams` carries.
#[async_trait]
pub trait SessionCwds: Send + Sync {
    /// `Ok(None)`: no such session. `Err`: the record read never ran.
    async fn cwd(&self, session_id: &str) -> Result<Option<String>, mixdog_core_api::CoreError>;
}

/// The sessions' stored headers as the cwd source: a header's `cwd` text.
pub struct HeaderCwds(pub Arc<dyn mixdog_core::run_host::config_hosts::ThreadHeaders>);

#[async_trait]
impl SessionCwds for HeaderCwds {
    async fn cwd(&self, session_id: &str) -> Result<Option<String>, mixdog_core_api::CoreError> {
        let Some(header) = self.0.header(&session_id.into()).await? else { return Ok(None) };
        Ok(header.get("cwd").and_then(Value::as_str).map(str::to_owned))
    }
}

pub(super) struct HostExportRenderer {
    host: Arc<dyn HostChannel>,
    cwds: Arc<dyn SessionCwds>,
}

impl HostExportRenderer {
    pub(super) fn new(host: Arc<dyn HostChannel>, cwds: Arc<dyn SessionCwds>) -> Arc<Self> {
        Arc::new(Self { host, cwds })
    }
}

fn unavailable(error: HostError) -> WsError {
    match error {
        // The host's redacted message is what the user reads.
        HostError::Rpc { message, .. } => WsError::new(Reason::Io, message),
        HostError::Core(error) => WsError::new(Reason::Unsupported, format!("{error}")),
    }
}

#[async_trait]
impl ExportRenderer for HostExportRenderer {
    async fn render(&self, command: &Map<String, Value>, cancel: &CancellationToken) -> WsResult<RenderedExport> {
        let mut input = command.clone();
        input.shift_remove("action");
        input.insert("forDevice".into(), Value::Bool(true));
        let session_id = input.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_owned();
        // The session is gone: the desktop answers the same for a tab it no longer has.
        let cwd = match self.cwds.cwd(&session_id).await {
            Ok(Some(cwd)) => cwd,
            Ok(None) => return Err(WsError::new(Reason::Io, "This visualize tab is closed.")),
            // The record was not read: the tab is not known to be closed.
            Err(_) => return Err(WsError::new(Reason::Io, "This visualize tab's session could not be read: its lane did not run the read.")),
        };
        let sent = json!({ "sessionId": session_id, "cwd": cwd, "action": "export", "input": input });
        let request = self.host.request(HostCapability::Visualize, Method(HOST_VISUALIZE_COMMAND), sent);
        let result = tokio::select! {
            () = cancel.cancelled() => return Err(WsError::new(Reason::Cancelled, "The export was cancelled.")),
            result = request => result.map_err(unavailable)?,
        };
        match result.get("path").and_then(Value::as_str) {
            Some(path) if !path.is_empty() => Ok(RenderedExport { path: PathBuf::from(path) }),
            _ => Err(WsError::new(Reason::Io, "The export did not produce a file.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::mock::MockHostChannel;

    use super::*;

    struct Cwds(Option<&'static str>);

    #[async_trait]
    impl SessionCwds for Cwds {
        async fn cwd(&self, _: &str) -> Result<Option<String>, mixdog_core_api::CoreError> {
            Ok(self.0.map(str::to_owned))
        }
    }

    fn renderer(host: Arc<MockHostChannel>) -> Arc<HostExportRenderer> {
        HostExportRenderer::new(host, Arc::new(Cwds(Some("/work"))))
    }

    fn command() -> Map<String, Value> {
        json!({ "sessionId": "s", "tabId": "t", "action": "export", "format": "png", "pane": 1 })
            .as_object()
            .unwrap()
            .clone()
    }

    #[tokio::test]
    async fn the_host_renders_the_command_and_its_path_is_the_export() {
        let host = Arc::new(MockHostChannel::default());
        host.claim(HostCapability::Visualize);
        host.reply(Method(HOST_VISUALIZE_COMMAND), json!({ "path": "/tmp/mixdog-visualize-export-a/x.png" }));
        let rendered = renderer(host.clone()).render(&command(), &CancellationToken::new()).await.unwrap();
        assert_eq!(rendered.path, PathBuf::from("/tmp/mixdog-visualize-export-a/x.png"));
        let sent = host.sent();
        assert_eq!((sent[0].0, sent[0].1.as_str()), (HostCapability::Visualize, HOST_VISUALIZE_COMMAND));
        assert_eq!(
            sent[0].2,
            json!({ "sessionId": "s", "cwd": "/work", "action": "export", "input": { "sessionId": "s", "tabId": "t", "format": "png", "pane": 1, "forDevice": true } })
        );
    }

    #[tokio::test]
    async fn an_answer_without_a_path_is_no_export() {
        let host = Arc::new(MockHostChannel::default());
        host.claim(HostCapability::Visualize);
        host.reply(Method(HOST_VISUALIZE_COMMAND), json!({ "path": "" }));
        let error = renderer(host).render(&command(), &CancellationToken::new()).await.err().unwrap();
        assert_eq!(error.message, "The export did not produce a file.");
    }

    struct Headers;

    #[async_trait]
    impl mixdog_core::run_host::config_hosts::ThreadHeaders for Headers {
        async fn header(&self, thread: &mixdog_core_api::ids::ThreadId) -> Result<Option<mixdog_store::schema::record::Header>, mixdog_core_api::CoreError> {
            Ok((thread.as_str() == "s").then(|| json!({ "cwd": "/work", "title": "x" }).as_object().unwrap().clone()))
        }
    }

    #[tokio::test]
    async fn a_sessions_cwd_is_its_stored_headers_cwd() {
        let cwds = HeaderCwds(Arc::new(Headers));
        assert_eq!(cwds.cwd("s").await.unwrap().as_deref(), Some("/work"));
        assert_eq!(cwds.cwd("other").await.unwrap(), None);
    }

    struct UnreadableCwds;

    #[async_trait]
    impl SessionCwds for UnreadableCwds {
        async fn cwd(&self, _: &str) -> Result<Option<String>, mixdog_core_api::CoreError> {
            Err(mixdog_core_api::CoreError::QueueFull { queue: "interactive".into() })
        }
    }

    #[tokio::test]
    async fn a_session_record_that_was_not_read_is_not_a_closed_tab() {
        let host = Arc::new(MockHostChannel::default());
        host.claim(HostCapability::Visualize);
        let error = HostExportRenderer::new(host.clone(), Arc::new(UnreadableCwds))
            .render(&command(), &CancellationToken::new())
            .await
            .err()
            .unwrap();
        assert_eq!(error.message, "This visualize tab's session could not be read: its lane did not run the read.");
        assert!(host.sent().is_empty());
    }

    #[tokio::test]
    async fn a_session_that_is_gone_has_no_export_and_asks_the_host_nothing() {
        let host = Arc::new(MockHostChannel::default());
        host.claim(HostCapability::Visualize);
        let error = HostExportRenderer::new(host.clone(), Arc::new(Cwds(None))).render(&command(), &CancellationToken::new()).await.err().unwrap();
        assert_eq!(error.message, "This visualize tab is closed.");
        assert!(host.sent().is_empty());
    }

    #[tokio::test]
    async fn no_desktop_is_unsupported() {
        let host = Arc::new(MockHostChannel::default());
        let error = renderer(host).render(&command(), &CancellationToken::new()).await.err().unwrap();
        assert_eq!(error.reason, Reason::Unsupported);
    }
}
