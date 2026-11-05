//! `system/ports/subscribe` and `unsubscribe`: the listening-ports section on the scoped feed
//! `ports`. The feed exists, and the OS socket table is read, only while a connection views it;
//! a sample is published only when it differs from the previous one.

use std::collections::BTreeMap;
use std::io;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::call::Subscribe;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_protocol::FeedId;
use mixdog_protocol::SectionName;
use mixdog_protocol::SectionUpdate;
use serde_json::Value;
use serde_json::json;

use super::client_of;
use super::connection_key;
use super::domain_error;
use super::feeds::FramePublisher;
use super::invalid_params;
use crate::ports::ListeningPort;
use crate::ports::PortsDiff;
use crate::ports::PortsHub;

#[derive(Default)]
struct PortsFeed {
    /// Present while at least one connection views the ports.
    publisher: Option<Arc<FramePublisher>>,
    current: BTreeMap<u16, ListeningPort>,
    revision: u64,
}

pub struct SystemService {
    scoped: Arc<dyn ScopedFeeds>,
    hub: PortsHub,
    state: Arc<Mutex<PortsFeed>>,
}

fn list_json(ports: &BTreeMap<u16, ListeningPort>) -> Value {
    Value::Array(
        ports
            .values()
            .map(|p| json!({ "port": p.port, "addresses": p.addresses, "process": p.process, "pid": p.pid }))
            .collect(),
    )
}

impl PortsFeed {
    /// Publishes the whole list as the `ports` section with the next revision.
    fn publish(&mut self) {
        let Some(publisher) = self.publisher.clone() else {
            return;
        };
        self.revision += 1;
        let list = list_json(&self.current);
        let update = SectionUpdate {
            section: SectionName::Ports,
            key: None,
            revision: self.revision,
            value: Some(list.clone()),
            removed: None,
            stub: None,
        };
        publisher.publish(
            "system/ports/updated",
            serde_json::to_value(update).expect("a section update serializes"),
            json!({ "ports": list }),
        );
    }
}

impl SystemService {
    /// The production service: the OS socket table every [`crate::ports::SAMPLE_INTERVAL`].
    pub fn new(scoped: Arc<dyn ScopedFeeds>) -> Arc<Self> {
        Self::with_source(scoped, crate::ports::SAMPLE_INTERVAL, crate::ports::sample_listening_ports)
    }

    /// A service reading `source` every `interval`.
    pub fn with_source(
        scoped: Arc<dyn ScopedFeeds>,
        interval: Duration,
        source: impl Fn() -> io::Result<Vec<ListeningPort>> + Send + Sync + 'static,
    ) -> Arc<Self> {
        let state = Arc::new(Mutex::new(PortsFeed::default()));
        let sink_state = Arc::clone(&state);
        let hub = PortsHub::with_source(interval, source, move |diff: &PortsDiff| {
            let mut feed = sink_state.lock().unwrap_or_else(|e| e.into_inner());
            for port in &diff.removed {
                feed.current.remove(port);
            }
            for port in &diff.upserted {
                feed.current.insert(port.port, port.clone());
            }
            feed.publish();
        });
        Arc::new(Self { scoped, hub, state })
    }

    /// The sampler threads still alive (zero once nobody views the ports).
    pub fn sampler_threads(&self) -> usize {
        self.hub.sampler_threads()
    }

    fn release(&self, viewer: &str) {
        self.hub.unsubscribe(viewer);
        if self.hub.viewers() == 0 {
            let mut feed = self.state.lock().unwrap_or_else(|e| e.into_inner());
            feed.current.clear();
            if let Some(publisher) = feed.publisher.take() {
                publisher.close();
            }
        }
    }

    /// A connection closed: its view of the ports ends.
    pub fn connection_closed(&self, connection: ConnectionId) {
        self.release(&connection_key(connection));
    }
}

#[async_trait]
impl DomainService for SystemService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let viewer = client_of(&req);
        match req.method.as_str() {
            "system/ports/subscribe" => {
                // The hub first: its sampler calls the sink under the hub lock, so the state lock
                // is only ever taken after it. The list the hub hands back is empty for the first
                // viewer, and later viewers join a feed whose state is already current.
                self.hub
                    .subscribe(&viewer)
                    .map_err(|_| domain_error("system", "PORTS_UNAVAILABLE"))?;
                let mut feed = self.state.lock().unwrap_or_else(|e| e.into_inner());
                let publisher = match feed.publisher.clone() {
                    Some(publisher) => publisher,
                    None => {
                        let publisher = Arc::new(FramePublisher::create(
                            self.scoped.as_ref(),
                            FeedId::from("ports"),
                            json!({ "ports": list_json(&feed.current) }),
                        ));
                        feed.publisher = Some(Arc::clone(&publisher));
                        publisher
                    }
                };
                Ok(Reply::Subscribe(Subscribe {
                    result: json!({}),
                    feed: publisher.source(),
                    window: Window::Fixed,
                    resume_from: None,
                }))
            }
            "system/ports/unsubscribe" => {
                self.release(&viewer);
                Ok(Reply::Value(json!({})))
            }
            other => Err(invalid_params("method", format!("a method of system, not {other}"))),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &["system/ports/subscribe", "system/ports/unsubscribe"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
