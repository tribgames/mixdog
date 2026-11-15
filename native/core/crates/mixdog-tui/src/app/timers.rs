//! The panel-side timers and the work that Node ran off the event that asked for it.
//!
//! Time is an input: [`AppState::next_deadline`] is the next millisecond on the [`super::Clock`] at which the run loop must call
//! [`AppState::on_timers`]; [`AppState::background_pending`] says there is work to run right now ([`AppState::run_background`]),
//! one item per call so a frame is painted between two of them (they are blocking store calls).

use mixdog_session_view::store::{OAUTH_FLOW_TTL, OAUTH_POLL, StoreEvent};
use serde_json::{Value, json};

use super::AppState;
use crate::handlers::exit::ExitStep;
use crate::panels::context::open_context_panel;
use crate::panels::context_refresh::ContextRefreshFields;
use crate::pickers::extensions::disabled_skills::load_disabled_skills;
use crate::pickers::model::catalog::{PREFETCH_DELAY_MS, prefetch_catalogs, run_catalog_refresh};
use crate::pickers::provider::{oauth_settled, open_auth_step, prefetched_agents, prefetched_provider_models, start_onboarding};
use crate::pickers::settings::picker::run_live_refresh;
use crate::slash::host::Tone;
use crate::slash::notices::truthy;

/// How often a sign-in flow's status is read while it is pending: the store's [`OAUTH_POLL`], in milliseconds.
fn oauth_poll_ms() -> u64 {
    u64::try_from(OAUTH_POLL.as_millis()).unwrap_or(u64::MAX)
}

/// A provider sign-in the user finishes in a browser: its status is read until it settles or expires.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthWatch {
    flow_id: String,
    due_ms: u64,
    expires_ms: u64,
}

impl OAuthWatch {
    /// A watch of the provider flow `flow_id` started at `now_ms`.
    pub fn provider(flow_id: &str, now_ms: u64) -> Self {
        let ttl = u64::try_from(OAUTH_FLOW_TTL.as_millis()).unwrap_or(u64::MAX);
        Self { flow_id: flow_id.to_owned(), due_ms: now_ms + oauth_poll_ms(), expires_ms: now_ms.saturating_add(ttl) }
    }
}

impl AppState {
    /// The next time the application has to be woken at, in clock milliseconds (a time already past is due now).
    pub fn next_deadline(&self) -> Option<u64> {
        let now = self.clock.now();
        let mut deadlines: Vec<u64> = Vec::new();
        deadlines.extend(self.enter_latch.expires_at_ms());
        deadlines.extend(self.surface.latch().expires_at_ms());
        deadlines.extend(self.prompt.hint.dismiss_at());
        deadlines.extend(self.prompt.exit.next_wake());
        deadlines.extend(self.catalog_prefetch_due_ms);
        deadlines.extend(self.spinner_tick_due);
        deadlines.extend(self.zoom_deadline());
        deadlines.extend(self.oauth_watches.iter().map(|watch| watch.due_ms));
        deadlines.extend(self.extensions.as_ref().and_then(|extensions| extensions.login.poll_due_at()));
        if self.background_pending() {
            deadlines.push(now);
        }
        deadlines.into_iter().min()
    }

    /// Work waits to run: the wizard's launch, a catalog refresh, a prefetch or a usage read.
    pub fn background_pending(&self) -> bool {
        self.project_boot_pending
            || self.disabled_skills_pending
            || self.onboarding_launch_pending
            || !self.catalog_jobs.is_empty()
            || !self.prefetches.is_empty()
            || !self.usage_requests.is_empty()
            || self.welcome_pending.is_some()
            || self.catalog_prefetch_due_ms.is_some_and(|due| self.clock.now() >= due)
    }

    /// The timers whose time has come: the Enter latch expiry, the prompt hint, the sign-in polls.
    pub fn on_timers(&mut self) {
        let now = self.clock.now();
        self.enter_latch.tick(now);
        self.surface.tick(now);
        self.prompt.hint.tick(now);
        if self.spinner_tick_due.is_some_and(|due| now >= due) {
            // The spinner animates off the clock: the frame is what moves it.
            self.spinner_tick_due = None;
            self.frame_requested = true;
        }
        self.zoom_restore_due();
        self.finish_paste_jobs();
        self.poll_oauth_watches(now);
        if self.extensions.as_ref().and_then(|extensions| extensions.login.poll_due_at()).is_some_and(|due| now >= due) {
            self.with_extensions(|extensions, host| extensions.login.poll(host));
        }
    }

    /// The step of the two-phase exit at the clock's time.
    pub fn exit_step(&mut self) -> ExitStep {
        let now = self.clock.now();
        self.prompt.exit.step(now)
    }

    /// The store's disposal settled, in time or not.
    pub fn dispose_settled(&mut self) {
        self.prompt.exit.dispose_settled();
    }

    /// An exit was requested (`/exit`, `/quit`, Ctrl+C twice): the input is frozen.
    pub fn exiting(&self) -> bool {
        self.prompt.exit.requested()
    }

    /// One reading of each pending sign-in whose poll is due: a flow that is no longer pending settles, one that outlived its
    /// time expires.
    fn poll_oauth_watches(&mut self, now: u64) {
        let due: Vec<usize> = (0..self.oauth_watches.len()).filter(|index| now >= self.oauth_watches[*index].due_ms).collect();
        for index in due.into_iter().rev() {
            let watch = self.oauth_watches[index].clone();
            let status = self.call_store("getOAuthProviderLoginStatus", json!([watch.flow_id]));
            let pending = matches!(&status, Ok(value) if value.get("state").and_then(Value::as_str) == Some("pending"));
            let expired = now >= watch.expires_ms;
            if pending && !expired {
                self.oauth_watches[index].due_ms = now + oauth_poll_ms();
                continue;
            }
            self.oauth_watches.remove(index);
            let result = if pending { Err("OAuth login expired.".to_owned()) } else { status };
            oauth_settled(self, &watch.flow_id, result);
        }
    }

    /// Runs one item of the waiting background work; whether more remains.
    pub fn run_background(&mut self) -> bool {
        let now = self.clock.now();
        if std::mem::take(&mut self.project_boot_pending) {
            self.with_extensions(|extensions, host| extensions.open_project(host, true));
        } else if std::mem::take(&mut self.disabled_skills_pending) {
            load_disabled_skills(self);
        } else if std::mem::take(&mut self.onboarding_launch_pending) {
            open_auth_step(self);
        } else if let Some(job) = self.catalog_jobs.pop_front() {
            run_catalog_refresh(self, job);
        } else if self.welcome_pending.is_some() {
            self.run_welcome_probe();
        } else if let Some(wants) = self.prefetches.pop_front() {
            if wants.provider_models {
                let result = self.call_store("listProviderModels", json!([]));
                prefetched_provider_models(self, wants.seq, result);
            }
            if wants.agents {
                let result = self.call_store("listAgents", json!([]));
                prefetched_agents(self, result);
            }
        } else if let Some(request) = self.usage_requests.pop_front() {
            if request.due(self) {
                let result = self.call_store("getUsageDashboard", json!([request.args()]));
                request.settle(self, result);
            }
        } else if self.catalog_prefetch_due_ms.is_some_and(|due| now >= due) {
            self.catalog_prefetch_due_ms = None;
            prefetch_catalogs(self);
        }
        self.background_pending()
    }

    /// A state was published: the effects that follow a commit (`state.setupChanged`, the open `/context` panel's refresh, the
    /// `/btw` panel's session sync). The store's [`super::store::AppStore::tick`] published it.
    pub fn on_state_published(&mut self) {
        let state = self.store.state();
        self.sync_welcome_hint();
        let setup = state.get("setupChanged").cloned().unwrap_or(Value::Null);
        if setup != self.setup_changed_seen {
            self.setup_changed_seen = setup.clone();
            if truthy(&setup) {
                run_live_refresh(self);
            }
        }
        let field = |name: &str| state.get(name).cloned().unwrap_or(Value::Null);
        let fields = ContextRefreshFields {
            stats: field("stats"),
            context_window: field("contextWindow"),
            raw_context_window: field("rawContextWindow"),
            session_id: field("sessionId"),
            tool_mode: field("toolMode"),
            agent_workers: field("agentWorkers"),
            agent_jobs: field("agentJobs"),
            provider: field("provider"),
            model: field("model"),
            effort: field("effort"),
            fast: field("fast"),
            cwd: field("cwd"),
            client_host_pid: field("clientHostPid"),
        };
        let context_open = self.surface.context().is_some();
        if self.context_refresh.observe(context_open, &fields) {
            open_context_panel(self);
        }
        let mut btw = std::mem::take(&mut self.btw);
        btw.sync(self);
        self.btw = btw;
    }

    /// The setup tool's `open` request (`useUiOpenRequest`): each new `seq` runs that slash command as typed.
    pub fn on_ui_open_request(&mut self, command: &str, seq: u64) {
        let mut gate = std::mem::take(&mut self.ui_open);
        gate.run(self, &json!({ "command": command, "seq": seq }));
        self.ui_open = gate;
    }

    /// What the store told its subscribers: a published state runs the effects of a commit, a setup `open` request runs its
    /// command, a lost session is said.
    pub fn on_store_event(&mut self, event: &StoreEvent) {
        match event {
            StoreEvent::State(_) => self.on_state_published(),
            StoreEvent::UiOpenRequest { command, seq } => self.on_ui_open_request(command, *seq),
            StoreEvent::SessionLost { reason } => self.notice(&format!("session lost: {reason}"), Tone::Error),
            StoreEvent::Notice { .. } | StoreEvent::Toast(_) | StoreEvent::ConnectionStatus(_) | StoreEvent::PromptRestore(_) => {}
        }
    }

    /// The boot-time schedule: the catalog warm-up `PREFETCH_DELAY_MS` after the mount.
    pub(crate) fn schedule_catalog_prefetch(&mut self) {
        self.catalog_prefetch_due_ms = Some(self.clock.now() + PREFETCH_DELAY_MS);
    }

    /// `useOnboardingStart`: whether the wizard launches (once per mount); it opens its first step on the next turn.
    pub(crate) fn start_onboarding_gate(&mut self) {
        let force = self.options.force_onboarding;
        let verdict = self.options.onboarding_completed;
        if start_onboarding(self, force, verdict) {
            self.onboarding_launch_pending = true;
        }
    }
}
