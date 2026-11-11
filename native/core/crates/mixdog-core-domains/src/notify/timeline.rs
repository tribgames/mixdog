//! `remote/connectionTimeline`: a paired phone's account of a slow reconnect, written to the PC's log as Node's relay wrote it
//! (`remote-relay-client-calls.ts:181-186` at b6f10295a: `console.info` in the desktop main process, which hosted the relay). The
//! relay lives in the core, so the line is the core's `console.info` (`DaemonLog::console`), as the rooms log is its `console.warn`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::RemoteConnectionTimelineParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_remote::registry::DeviceRegistry;
use serde_json::Value;

use mixdog_core_base::support::wrong_method;

const TIMELINE: &str = "remote/connectionTimeline";
/// Node's `.slice(0, 1_500)`, in UTF-16 units.
const TEXT_MAX_UNITS: usize = 1_500;
/// Node's `clientId.slice(0, 8)`.
const CLIENT_ID_UNITS: usize = 8;

pub struct ConnectionTimeline {
    registry: Arc<DeviceRegistry>,
    /// `console.info(line)` of the process that hosts the relay.
    log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl ConnectionTimeline {
    pub fn new(registry: Arc<DeviceRegistry>, log: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        Self { registry, log }
    }
}

/// The first `units` UTF-16 units of `text`. A pair the cut would split is left out: Node keeps its lone half, which neither
/// the timeline's character filter nor a relay client id (ASCII) lets through.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut taken = 0;
    text.chars()
        .take_while(|c| {
            taken += c.len_utf16();
            taken <= units
        })
        .collect()
}

/// Node's `.slice(0, 1_500).replace(/[^\w=@:. -]/gu, '')`.
pub fn sanitized(text: &str) -> String {
    utf16_prefix(text, TEXT_MAX_UNITS)
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '=' | '@' | ':' | '.' | ' ' | '-'))
        .collect()
}

#[async_trait]
impl DomainService for ConnectionTimeline {
    fn methods(&self) -> &'static [&'static str] {
        &[TIMELINE]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Err(wrong_method("remote", req.method.as_str()))
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        if method.as_str() == TIMELINE
            && let Ok(RemoteConnectionTimelineParams { text }) = serde_json::from_value(params)
            && let Some(peer) = self.registry.attached_peer(from.0)
        {
            let text = sanitized(&text);
            if !text.is_empty() {
                (self.log)(&format!("[mixdog-remote-timeline] client={} {text}", utf16_prefix(&peer, CLIENT_ID_UNITS)));
            }
        }
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    #[test]
    fn an_attached_phones_timeline_is_logged_as_node_logged_it_and_nothing_else_is() {
        let registry = Arc::new(DeviceRegistry::default());
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        let timeline = ConnectionTimeline::new(registry.clone(), Arc::new(move |line| sink.lock().unwrap().push(line.to_owned())));
        let send = |from: u64, params: Value| timeline.notify(Method(TIMELINE), params, ConnectionId(from));
        registry.connect_local(1, "desk", mixdog_remote::registry::LocalKind::Desktop);
        registry.connect_relay(2, "client-plumbing");
        send(2, json!({ "text": "phase=open@0" }));
        registry.attach_peer("client-plumbing", "cred-a", "Pixel", "Chrome");
        send(1, json!({ "text": "phase=open@0" }));
        send(2, json!({ "text": "phase=open@0 state=ready@12 <b>é\u{1F600}!" }));
        send(2, json!({ "text": "<>!" }));
        send(2, json!({ "text": 5 }));
        let long = "a".repeat(1_499) + "\u{1F600}b";
        send(2, json!({ "text": long }));
        assert_eq!(
            *lines.lock().unwrap(),
            vec![
                "[mixdog-remote-timeline] client=client-p phase=open@0 state=ready@12 b".to_owned(),
                format!("[mixdog-remote-timeline] client=client-p {}", "a".repeat(1_499)),
            ]
        );
    }
}
