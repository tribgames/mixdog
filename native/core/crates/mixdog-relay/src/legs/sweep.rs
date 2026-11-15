//! The heartbeat (`sweepLegs` of `server.mjs`): every 10 s over every upgraded socket (`wss.clients`: the desktop legs, the phone legs,
//! the hook legs and the sockets answered only with a close code). NAT and middleboxes drop idle WebSockets silently, so a dead desktop
//! leg must release its registration (phones otherwise blackhole) and a dead phone leg must stop holding broadcast fan-out slots; a
//! leg that vanishes with no close frame (WiFi/LTE handover, task kill, Doze) keeps the desktop producing frames this relay can only
//! discard until a sweep terminates it, so the sweep interval IS the waste window.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::TaskClass;
use mixdog_rt::time::{Instant, MissedTickBehavior, interval_at};
use tokio::task::AbortHandle;

use super::hub::{Hub, LegSocket, SweepLeg};
use super::ingress::{IngressLeg, Sweep};
use crate::hook::{HookHub, HookLeg};
use crate::logline;

/// `setInterval(() => sweepLegs(wss), 10_000)`.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(10);

/// `SWEEP_DRAIN_GRACE_WINDOWS`: the extra windows a leg that is busy moving bytes gets before it is cut. Its ping sits behind the
/// frames queued ahead of it, and a leg whose reads this relay paused (backpressure) never READS the pong at all; the queue budgets
/// already bound what such a leg can hold, so it is not cut as a bare 1006 while it drains.
pub const SWEEP_DRAIN_GRACE_WINDOWS: u32 = 2;

/// One socket as the sweep walks it.
trait Swept {
    fn ingress(&self) -> Option<&IngressLeg>;
    fn socket(&self) -> &dyn LegSocket;
    fn is_alive(&self) -> bool;
    /// A new window: the leg is presumed dead until it answers, and its grace starts over.
    fn start_window(&mut self);
    /// One more extra window given; returns how many the leg has had.
    fn bump_grace(&mut self) -> u32;
}

impl Swept for SweepLeg {
    fn ingress(&self) -> Option<&IngressLeg> {
        self.ingress.as_ref()
    }

    fn socket(&self) -> &dyn LegSocket {
        &*self.socket
    }

    fn is_alive(&self) -> bool {
        self.liveness.is_alive()
    }

    fn start_window(&mut self) {
        self.liveness.start_window();
    }

    fn bump_grace(&mut self) -> u32 {
        self.liveness.bump_grace()
    }
}

/// A hook leg keeps its liveness inside the hook hub; its grace is kept by the sweeper, under the address of the leg's socket (the
/// entry lives in an `Arc`, so the address is stable while the leg is live, and the table is pruned to the live legs on every pass).
struct HookSwept<'a> {
    leg: &'a HookLeg,
    graces: &'a mut HashMap<usize, u32>,
}

impl HookSwept<'_> {
    fn key(&self) -> usize {
        std::ptr::from_ref(self.leg.socket()) as usize
    }
}

impl Swept for HookSwept<'_> {
    fn ingress(&self) -> Option<&IngressLeg> {
        Some(self.leg.ingress())
    }

    fn socket(&self) -> &dyn LegSocket {
        self.leg.socket()
    }

    fn is_alive(&self) -> bool {
        self.leg.is_alive()
    }

    fn start_window(&mut self) {
        self.leg.set_alive(false);
        let key = self.key();
        self.graces.insert(key, 0);
    }

    fn bump_grace(&mut self) -> u32 {
        let key = self.key();
        let grace = self.graces.entry(key).or_insert(0);
        *grace += 1;
        *grace
    }
}

/// The body of `sweepLegs` for one socket.
fn sweep_one(leg: &mut dyn Swept, now: Instant) {
    // A leg holding a slice of the receive budget without making progress is box memory pinned by a peer that went quiet mid-frame; a
    // leg parked for ingress admission is not being READ, so it cannot answer a ping: sweeping it would turn backpressure into a
    // disconnect, and its wait is what is bounded instead.
    if let Some(ingress) = leg.ingress()
        && matches!(ingress.sweep(now), Sweep::Closed | Sweep::Parked)
    {
        return;
    }
    if !leg.is_alive() {
        let draining = {
            let socket = leg.socket();
            socket.read_held() || socket.buffered_amount() > 0
        };
        if draining && leg.bump_grace() <= SWEEP_DRAIN_GRACE_WINDOWS {
            return;
        }
        // A terminate reaches the peer as a bare 1006 that names nobody, so the sweep says here that IT was the one that cut a silent
        // leg.
        logline::emit(&logline::sweep_terminated_leg());
        leg.socket().terminate();
        return;
    }
    leg.start_window();
    // A ping that cannot be sent is surfaced as a close.
    leg.socket().ping();
}

/// `sweepLegs(wss)`: one pass over the sockets of the hub's table.
pub fn sweep_legs(legs: &[SweepLeg], now: Instant) {
    for leg in legs {
        sweep_one(&mut leg.clone(), now);
    }
}

/// The sweep with the state it carries between passes: the grace of the hook legs.
#[derive(Default)]
pub struct Sweeper {
    hook_graces: HashMap<usize, u32>,
}

impl Sweeper {
    /// One pass over the hub's sockets and the hook legs.
    pub fn pass(&mut self, legs: &[SweepLeg], hook_legs: &[HookLeg], now: Instant) {
        sweep_legs(legs, now);
        let mut live = HashSet::new();
        for leg in hook_legs {
            let mut swept = HookSwept { leg, graces: &mut self.hook_graces };
            live.insert(swept.key());
            sweep_one(&mut swept, now);
        }
        self.hook_graces.retain(|key, _| live.contains(key));
    }
}

/// The running heartbeat: stop it when the relay closes (`clearInterval(heartbeat)`).
pub struct SweepTask {
    task: AbortHandle,
}

impl SweepTask {
    pub fn stop(&self) {
        self.task.abort();
    }
}

impl Drop for SweepTask {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start the heartbeat on the relay's runtime: the first pass is one interval from now, as `setInterval`'s is.
pub fn start_sweep(hub: Arc<Hub>, hooks: Option<Arc<HookHub>>) -> SweepTask {
    start_sweep_every(hub, hooks, SWEEP_INTERVAL)
}

/// [`start_sweep`] with its interval given.
pub fn start_sweep_every(hub: Arc<Hub>, hooks: Option<Arc<HookHub>>, period: Duration) -> SweepTask {
    let mut ticker = interval_at(Instant::now() + period, period);
    // `setInterval` does not catch up on ticks it was too late for.
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let task = mixdog_rt::spawn("relay-sweep", TaskClass::Control, async move {
        let mut sweeper = Sweeper::default();
        loop {
            ticker.tick().await;
            let hook_legs = hooks.as_ref().map(|hooks| hooks.legs()).unwrap_or_default();
            sweeper.pass(&hub.legs(), &hook_legs, Instant::now());
        }
    });
    SweepTask { task: task.abort_handle() }
}
