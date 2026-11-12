//! The room host registry (`runtime/shared/agent-room-host.mjs`): `registerAgentRoomHost(host)` adds a host and returns its unregister,
//! `agentRoomHost()` is the most recently registered one and throws Node's error when none is. The delivery looks the host up on every relay
//! (`agent-home-delivery.mjs:1206`), so a host that registers or unregisters changes the next relay at once.
//!
//! Node's desktop service (hosted in the daemon) registers its host at start and unregisters it when it ends. Rooms are core-owned here (spec
//! desktop-services §9), so the core registers its [`super::room_relay::MemberRelay`] when the rooms are recovered and unregisters it in its
//! stop procedure; there is no `host/*` wire for rooms, so no desktop connection carries a relay.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_services::bots::delivery::env::{RoomRelay, WakeFollow};
use mixdog_services::bots::live::{WakeOptions, WakeTurn};

use super::room_ask::RoomAsk;

/// `agentRoomHost()` with nothing registered.
pub const NO_HOST: &str = "group rooms run in the desktop app, and no desktop app is attached to this runtime";

/// A registered host: its relay, and its `member` / `ask` when it takes messages from other sessions.
type Host = (u64, Arc<dyn RoomRelay>, Option<Arc<dyn RoomAsk>>);

#[derive(Default)]
struct Hosts {
    next: u64,
    list: Vec<Host>,
}

/// The registered room hosts, newest last.
#[derive(Default)]
pub struct RoomHostRegistry {
    hosts: Mutex<Hosts>,
}

impl RoomHostRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, Hosts> {
        self.hosts.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `registerAgentRoomHost`: the host is now the active one. The same host registered twice is two entries.
    pub fn register(self: &Arc<Self>, host: Arc<dyn RoomRelay>) -> Registration {
        self.register_host(host, None)
    }

    /// `registerAgentRoomHost` of a host that also takes messages from other sessions.
    pub fn register_host(self: &Arc<Self>, host: Arc<dyn RoomRelay>, ask: Option<Arc<dyn RoomAsk>>) -> Registration {
        let mut hosts = self.lock();
        let id = hosts.next;
        hosts.next += 1;
        hosts.list.push((id, host, ask));
        Registration { registry: self.clone(), id }
    }

    /// `agentRoomHost()`: the most recently registered host, else Node's error.
    pub fn active(&self) -> Result<Arc<dyn RoomRelay>, String> {
        self.lock().list.last().map(|(_, host, _)| host.clone()).ok_or_else(|| NO_HOST.to_owned())
    }

    /// `agentRoomHost()`'s `member` / `ask`: the most recently registered host's, else Node's error.
    pub fn active_ask(&self) -> Result<Arc<dyn RoomAsk>, String> {
        self.lock().list.last().and_then(|(_, _, ask)| ask.clone()).ok_or_else(|| NO_HOST.to_owned())
    }
}

/// The unregister `registerAgentRoomHost` returns.
#[derive(Clone)]
pub struct Registration {
    registry: Arc<RoomHostRegistry>,
    id: u64,
}

impl Registration {
    /// Removes the entry this registration added; a second call finds nothing and does nothing.
    pub fn unregister(&self) {
        self.registry.lock().list.retain(|(id, _, _)| *id != self.id);
    }
}

/// The delivery's `roomRelay`: `agentRoomHost().relay(..)`, looked up per call.
#[async_trait]
impl RoomRelay for RoomHostRegistry {
    async fn relay(&self, session_id: &str, prompt: &str, options: WakeOptions, follow: WakeFollow) -> Result<Option<WakeTurn>, String> {
        let host = self.active()?;
        host.relay(session_id, prompt, options, follow).await
    }
}

#[cfg(test)]
mod tests;
