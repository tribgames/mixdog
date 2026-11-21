use super::*;

/// How long a size claim holds without being renewed (`SIZE_OWNER_LEASE_MS`): a phone renews every
/// 10 s while it shows the terminal, so a claim that stops renewing (a lost connection) lapses
/// and the PC fits its own pane again.
pub const SIZE_OWNER_LEASE: std::time::Duration = std::time::Duration::from_secs(30);
/// How many gates the operations on claims are spread over (an id always takes the same one).
pub(super) const GATES: usize = 16;
/// How long marker text that may start a marker is held back with no further chunk (`HELD_OUTPUT_FLUSH_MS`): then it is output.
pub const HELD_FLUSH: std::time::Duration = std::time::Duration::from_millis(50);

pub(super) struct SizeClaim {
    pub(super) client: String,
    pub(super) cols: u16,
    pub(super) rows: u16,
    pub(super) lease: Option<mixdog_rt::TimerHandle>,
    /// Which arming of the lease is current: a lapse of an older arming is ignored.
    pub(super) epoch: u64,
    /// On the manual lease clock (debug builds only), when this claim lapses.
    #[cfg(feature = "lease-clock")]
    pub(super) due: Option<std::time::Duration>,
}

/// The lease clock a replay steps by hand. It exists in debug builds only, and only when
/// `MIXDOG_TERMINAL_LEASE_CLOCK=<directory>` is set: the leases then lapse exactly when [`Claims::advance`]
/// moves time past them, instead of on the ticker. A release build has neither the clock nor the switch.
#[cfg(feature = "lease-clock")]
pub(super) struct ManualLeaseClock {
    pub(super) now: Mutex<std::time::Duration>,
    pub(super) secret: Option<String>,
}

/// Per tab id, the connections claiming its size, oldest claim first; the newest claim owns.
/// Claims belong to the id, not to a running process (Node's `sizeClaims`): a claim made before
/// the tab exists stands, and only a dispose forgets it.
pub(super) struct Claims {
    pub(super) map: Mutex<HashMap<String, Vec<SizeClaim>>>,
    /// Orders the operations on one id from the change of its claims to the end of its announcement. Node does this by being one thread:
    /// a claim changes the map, fits the PTY and tells its listeners before any other call runs. The map's own lock is held only to change
    /// the map, so a PTY fit that blocks holds back the ids that share its gate, not every tab.
    pub(super) gates: [Mutex<()>; GATES],
    pub(super) tabs: Arc<Mutex<HashMap<String, Slot>>>,
    pub(super) events: Arc<dyn TerminalEvents>,
    pub(super) epoch: AtomicU64,
    #[cfg(feature = "lease-clock")]
    pub(super) manual: Option<ManualLeaseClock>,
    #[cfg(feature = "core-test")]
    pub(super) gate_waiting: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

/// How many ids one connection may hold a size claim on at once. Node bounds nothing (`sizeClaims`, terminal-manager.ts:455): a
/// client renewing claims on arbitrary ids kept a map entry and a timer alive for each. A phone claims the tabs it shows; a claim
/// beyond this many is ignored, as a claim on a tab that is gone would be.
pub(super) const MAX_CLAIMS_PER_CLIENT: usize = 256;

impl Claims {
    /// Moves the manual lease clock on by `by` and ends, in the order of their lapse, every claim now due. Returns
    /// how many lapsed; without the manual clock nothing is done.
    #[cfg(feature = "lease-clock")]
    pub(super) fn advance(&self, by: std::time::Duration) -> usize {
        let Some(clock) = &self.manual else {
            return 0;
        };
        let now = {
            let mut now = clock.now.lock().unwrap_or_else(|e| e.into_inner());
            *now += by;
            *now
        };
        let mut lapsed = 0;
        loop {
            let next = self
                .lock()
                .iter()
                .flat_map(|(id, list)| list.iter().filter_map(move |c| c.due.filter(|due| *due <= now).map(|due| (due, id.clone(), c.client.clone(), c.epoch))))
                .min();
            let Some((_, id, client, epoch)) = next else {
                return lapsed;
            };
            self.release(&id, &client, Some(epoch));
            lapsed += 1;
        }
    }

    /// The replay's handle on the manual clock, with no wire method (the method table is shared with release builds): a loopback
    /// socket whose port is written to `<dir>/port`. A client sends `advance <ms>\n`; the clock steps by `ms`, ends every claim then due,
    /// and answers `lapsed <n>\n` (`n` claims ended), so the answer is the completion signal. Each connection has a thread of its own.
    #[cfg(feature = "lease-clock")]
    pub(super) fn serve_manual_clock(claims: &Arc<Self>, dir: std::path::PathBuf) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("the manual lease clock binds a loopback port");
        let port = listener.local_addr().expect("the bound port").port();
        std::fs::write(dir.join("port.tmp"), port.to_string())
            .and_then(|()| std::fs::rename(dir.join("port.tmp"), dir.join("port")))
            .expect("the manual lease clock publishes its port");
        let claims = Arc::downgrade(claims);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                // A connection of its own thread: one that leaves a line unfinished cannot hold back another's advance request.
                let claims = claims.clone();
                std::thread::spawn(move || Self::serve_manual_clock_connection(&claims, stream));
            }
        });
    }

    /// One control connection, served on its own thread: a client that leaves a line unfinished holds only its own connection.
    #[cfg(feature = "lease-clock")]
    pub(super) fn serve_manual_clock_connection(claims: &std::sync::Weak<Self>, stream: std::net::TcpStream) {
        use clock_control::{Ended, IDLE_DEADLINE, LINE_DEADLINE, WRITE_DEADLINE};
        let Ok(reader) = stream.try_clone() else { return };
        let mut stream = stream;
        let mut lines = std::io::BufReader::new(reader);
        // Any local process can reach a loopback port: only a client that knows the run's secret (set by the test that started
        // this core) moves the clock. Without a secret nobody does.
        let Some(secret) = claims.upgrade().and_then(|claims| claims.manual.as_ref().map(|manual| manual.secret.clone())) else { return };
        let mut admitted = false;
        loop {
            let answer = match clock_control::read_command(&mut lines, IDLE_DEADLINE, LINE_DEADLINE) {
                Ok(line) if !admitted => {
                    if secret.as_deref().is_some_and(|secret| line.trim_end() == format!("secret {secret}")) {
                        admitted = true;
                        "admitted\n".to_owned()
                    } else {
                        let _ = clock_control::answer(&mut stream, "refused: the first line must be `secret <the run's secret>`\n", WRITE_DEADLINE);
                        return;
                    }
                }
                Ok(line) => match (line.strip_prefix("advance ").and_then(|ms| ms.trim().parse::<u64>().ok()), claims.upgrade()) {
                    (Some(ms), Some(claims)) => format!("lapsed {}\n", claims.advance(std::time::Duration::from_millis(ms))),
                    _ => "refused\n".to_owned(),
                },
                Err(Ended::Closed) => return,
                Err(Ended::Refused(message)) => {
                    // The client is told what was awaited and the connection ends (its thread and sockets are released).
                    let _ = clock_control::answer(&mut stream, &format!("refused: {message}\n"), WRITE_DEADLINE);
                    eprintln!("mixdog lease clock: {message}; the control connection was closed");
                    return;
                }
            };
            if let Err(message) = clock_control::answer(&mut stream, &answer, WRITE_DEADLINE) {
                eprintln!("mixdog lease clock: {message}; the control connection was closed");
                return;
            }
        }
    }
    #[cfg(feature = "lease-clock")]
    pub(super) fn due_at(&self) -> Option<std::time::Duration> {
        self.manual.as_ref().map(|clock| *clock.now.lock().unwrap_or_else(|e| e.into_inner()) + SIZE_OWNER_LEASE)
    }

    pub(super) fn gate(&self, id: &str) -> MutexGuard<'_, ()> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        id.hash(&mut hasher);
        let gate = &self.gates[hasher.finish() as usize % GATES];
        #[cfg(feature = "core-test")]
        if let Some(waiting) = &self.gate_waiting {
            match gate.try_lock() {
                Ok(guard) => return guard,
                Err(std::sync::TryLockError::Poisoned(e)) => return e.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => waiting(id),
            }
        }
        gate.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, HashMap<String, Vec<SizeClaim>>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn owner_in(list: &[SizeClaim]) -> Option<SizeOwner> {
        list.last().map(|claim| SizeOwner { cols: claim.cols, rows: claim.rows, owner: claim.client.clone() })
    }

    /// The owner once every change of the id's claims under way has fitted the PTY and been announced (read under the id's gate):
    /// an attach never shows an owner whose fit and announcement are still to come.
    pub(super) fn owner_of(&self, id: &str) -> Option<SizeOwner> {
        let _gate = self.gate(id);
        self.lock().get(id).and_then(|list| Self::owner_in(list))
    }

    /// Fits the running tab's PTY to `cols` x `rows`; a missing or exited tab is left alone.
    pub(super) fn apply_size(&self, id: &str, cols: u16, rows: u16) {
        let tab = match self.tabs.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            Some(Slot::Live(tab)) => Arc::clone(tab),
            _ => return,
        };
        if !tab.running() {
            return;
        }
        tab.lock().size = (cols, rows);
        tab.sync_size();
    }

    /// Applies and announces the new effective owner when it differs. Called under the id's gate,
    /// so the PTY sizes and the announcements keep the order of the changes.
    pub(super) fn changed(&self, id: &str, before: Option<SizeOwner>, after: Option<SizeOwner>) {
        if before == after {
            return;
        }
        if let Some(owner) = &after {
            self.apply_size(id, owner.cols, owner.rows);
        }
        self.events.size_owner(&SizeOwnerChange {
            id: id.to_owned(),
            cols: after.as_ref().map_or(0, |o| o.cols),
            rows: after.as_ref().map_or(0, |o| o.rows),
            owner: after.map(|o| o.owner).unwrap_or_default(),
        });
    }

    pub(super) fn arm(self: &Arc<Self>, id: &str, client: &str, epoch: u64) -> Option<mixdog_rt::TimerHandle> {
        #[cfg(feature = "lease-clock")]
        if self.manual.is_some() {
            return None;
        }
        let claims = Arc::downgrade(self);
        let (id, client) = (id.to_owned(), client.to_owned());
        // The ticker's callback only hands the lapse to a task: releasing fits a PTY.
        Some(mixdog_rt::ticker().register(std::time::Instant::now() + SIZE_OWNER_LEASE, move || {
            if let Some(claims) = claims.upgrade() {
                drop(mixdog_rt::spawn("terminal-size-lease", mixdog_rt::TaskClass::Work, async move {
                    claims.release(&id, &client, Some(epoch));
                }));
            }
        }))
    }

    /// `client` claims (or renews its claim on) the size; a renewal keeps the claim's place in the order.
    pub(super) fn claim(self: &Arc<Self>, id: &str, client: &str, cols: u16, rows: u16) {
        let _gate = self.gate(id);
        let (before, after) = {
            let mut map = self.lock();
            let renewing = map.get(id).is_some_and(|list| list.iter().any(|claim| claim.client == client));
            if !renewing && map.values().filter(|list| list.iter().any(|claim| claim.client == client)).count() >= MAX_CLAIMS_PER_CLIENT {
                return;
            }
            let list = map.entry(id.to_owned()).or_default();
            let before = Self::owner_in(list);
            let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
            let lease = self.arm(id, client, epoch);
            #[cfg(feature = "lease-clock")]
            let due = self.due_at();
            match list.iter_mut().find(|claim| claim.client == client) {
                Some(claim) => {
                    if let Some(old) = claim.lease.take() {
                        let _ = old.cancel();
                    }
                    claim.cols = cols;
                    claim.rows = rows;
                    claim.lease = lease;
                    claim.epoch = epoch;
                    #[cfg(feature = "lease-clock")]
                    {
                        claim.due = due;
                    }
                }
                None => list.push(SizeClaim {
                    client: client.to_owned(),
                    cols,
                    rows,
                    lease,
                    epoch,
                    #[cfg(feature = "lease-clock")]
                    due,
                }),
            }
            let after = Self::owner_in(list);
            (before, after)
        };
        self.changed(id, before, after);
    }

    /// Ends `client`'s claim: by its own release (`epoch` none) or by its lease lapsing.
    pub(super) fn release(&self, id: &str, client: &str, epoch: Option<u64>) {
        let _gate = self.gate(id);
        let (before, after) = {
            let mut map = self.lock();
            let Some(list) = map.get_mut(id) else {
                return;
            };
            let Some(at) = list.iter().position(|claim| claim.client == client) else {
                return;
            };
            if epoch.is_some_and(|epoch| epoch != list[at].epoch) {
                return;
            }
            let before = Self::owner_in(list);
            if let Some(lease) = list.remove(at).lease {
                let _ = lease.cancel();
            }
            let after = Self::owner_in(list);
            if list.is_empty() {
                map.remove(id);
            }
            (before, after)
        };
        self.changed(id, before, after);
    }

    /// A resize no phone claimed: ignored while any claim stands.
    pub(super) fn resize_unclaimed(&self, id: &str, cols: u16, rows: u16) {
        let _gate = self.gate(id);
        if self.lock().contains_key(id) {
            return;
        }
        self.apply_size(id, cols, rows);
    }

    /// The tab was disposed: its claims go with it, and no owner change is announced (Node's `forgetSizeClaims`,
    /// terminal-manager.ts:490, emits nothing). The caller holds the id's gate for the whole disposal, so a claim made right
    /// after is queued behind it and is not undone by it.
    pub(super) fn forget_held(&self, id: &str) {
        let Some(list) = self.lock().remove(id) else {
            return;
        };
        for claim in list {
            if let Some(lease) = claim.lease {
                let _ = lease.cancel();
            }
        }
        self.events.size_claims_forgotten(id);
    }
}
