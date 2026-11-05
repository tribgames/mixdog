//! The webhook server's lifecycle (`webhook/listener-lifecycle.mjs`): the loopback listener and,
//! once it is bound, the relay tunnel that forwards a public URL to it. The tunnel itself is a
//! [`TunnelStarter`]; this module owns only when it starts, stops and what URL it makes public.

use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};

use async_trait::async_trait;

use super::handler::WebhookService;
use super::listener::WebhookListener;

/// The listener's bound port, 0 while it is not listening (`getLocalPort`).
#[derive(Clone, Default)]
pub struct LocalPort(Arc<AtomicU16>);

impl LocalPort {
    #[cfg(test)]
    pub(crate) fn with(port: u16) -> Self {
        Self(Arc::new(AtomicU16::new(port)))
    }

    pub fn get(&self) -> Option<u16> {
        Some(self.0.load(Ordering::SeqCst)).filter(|port| *port != 0)
    }
}

/// A running tunnel: its public base (`https://<relay>/hook/<deviceId>`) and the way to end it.
pub trait HookTunnel: Send {
    fn public_base(&self) -> String;
    /// Ends the leg and its redial loop; idempotent.
    fn close(&mut self);
}

/// Starts the tunnel against the local port. `Ok(None)` is a relay switched off
/// (`MIXDOG_RELAY_URL=off`); `Err` is a start that failed, which leaves the server local-only.
#[async_trait]
pub trait TunnelStarter: Send + Sync {
    async fn start(&self, local_port: LocalPort) -> Result<Option<Box<dyn HookTunnel>>, String>;
}

pub struct WebhookServer {
    service: Arc<WebhookService>,
    tunnels: Arc<dyn TunnelStarter>,
    base_port: u16,
    port: LocalPort,
    listener: Option<WebhookListener>,
    tunnel: Option<Box<dyn HookTunnel>>,
}

impl WebhookServer {
    pub fn new(service: Arc<WebhookService>, tunnels: Arc<dyn TunnelStarter>, base_port: u16) -> Self {
        Self { service, tunnels, base_port, port: LocalPort::default(), listener: None, tunnel: None }
    }

    /// Binds the listener, then starts the tunnel. Starting a started server does nothing; a
    /// listener that cannot bind leaves the server stopped, with the error returned.
    pub async fn start(&mut self) -> Result<(), String> {
        if self.listener.is_some() {
            return Ok(());
        }
        let listener = WebhookListener::start(Arc::clone(&self.service), self.base_port).await?;
        self.port.0.store(listener.port(), Ordering::SeqCst);
        self.listener = Some(listener);
        self.start_tunnel().await;
        Ok(())
    }

    async fn start_tunnel(&mut self) {
        if self.tunnel.is_some() {
            return;
        }
        match self.tunnels.start(self.port.clone()).await {
            Ok(None) => tracing::info!("webhook: hook tunnel disabled (MIXDOG_RELAY_URL=off)"),
            Ok(Some(tunnel)) => {
                tracing::info!("webhook: public hook base: {}", tunnel.public_base());
                self.tunnel = Some(tunnel);
            }
            Err(e) => tracing::warn!("webhook: hook tunnel start failed: {e}"),
        }
    }

    /// Closes the tunnel first, then releases the port.
    pub async fn stop(&mut self) {
        if let Some(mut tunnel) = self.tunnel.take() {
            tunnel.close();
        }
        if let Some(listener) = self.listener.take() {
            listener.stop().await;
        }
        self.port.0.store(0, Ordering::SeqCst);
    }

    pub fn port(&self) -> Option<u16> {
        self.port.get()
    }

    /// `getUrl`: the public URL when a tunnel runs, else the local one.
    pub fn url(&self, name: &str) -> String {
        match &self.tunnel {
            Some(tunnel) => format!("{}/webhook/{name}", tunnel.public_base()),
            None => format!("http://localhost:{}/webhook/{name}", self.port().unwrap_or(self.base_port)),
        }
    }
}
