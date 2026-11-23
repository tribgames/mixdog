//! The provider quota dashboard with the ACP agents' quota in it: an agent whose CLI is signed in and reports the
//! account's quota is an entry beside the providers', read from the CLI's own report and refreshed as theirs are.
//! The CLI's report is never waited for: a dashboard carries what the last read found, and a read that ends later is
//! published as the `usage` section's dashboard, the entry the window follows.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use async_trait::async_trait;
use mixdog_acp::agents::Agents;
use mixdog_acp::preset::AgentPreset;
use mixdog_ai::service::oauth_usage::QuotaHistory;
use mixdog_ai::service::oauth_usage::QuotaSample;
use mixdog_ai::service::usage_antigravity::quota_windows;
use mixdog_core::run_host::usage_stats_feed::Clock;
use mixdog_core::run_host::usage_stats_feed::DASHBOARD_KEY;
use mixdog_core::run_host::usage_stats_feed::SectionSource;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_core_domains::domains::ai_account::usage::dashboard::base_row;
use mixdog_core_domains::domains::ai_account::usage::dashboard::display_window;
use mixdog_core_domains::domains::ai_account::usage::dashboard::normalise_windows;
use mixdog_core_domains::domains::ai_account::usage::dashboard::row_tone;
use mixdog_protocol::SectionName;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;

const DASHBOARD: &str = "usage/getUsageDashboard";
/// What a window read from an agent's CLI names as its source.
const SOURCE: &str = "acp-agent-usage";

/// Where the agents' quota is read.
#[async_trait]
pub trait AgentQuotas: Send + Sync {
    fn presets(&self) -> Vec<AgentPreset>;
    /// The agent has a quota to report now: its feature is on and its CLI signed in.
    fn reports(&self, preset: &AgentPreset) -> bool;
    /// The CLI's report (its `command.data`); `None` while it cannot be asked.
    async fn read(&self, preset: &AgentPreset) -> Option<Result<Value, String>>;
}

#[async_trait]
impl AgentQuotas for Arc<Agents> {
    fn presets(&self) -> Vec<AgentPreset> {
        Agents::presets(self).to_vec()
    }

    fn reports(&self, preset: &AgentPreset) -> bool {
        self.reports_usage(preset)
    }

    async fn read(&self, preset: &AgentPreset) -> Option<Result<Value, String>> {
        self.usage(preset).await
    }
}

/// The usage service, its dashboard carrying the agents' entries.
pub struct AgentUsage {
    pub inner: Arc<dyn DomainService>,
    pub quotas: Arc<dyn AgentQuotas>,
    pub history: Arc<dyn QuotaHistory>,
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// Where a read that ends is published: the `usage` section.
    publisher: Arc<dyn StatePublisher>,
    me: Weak<Self>,
    /// What is known of each agent's quota, by preset id.
    known: Mutex<HashMap<String, Known>>,
    /// The providers' dashboard last answered: a read that ends later is published with it.
    providers: Mutex<Option<Value>>,
}

/// What is known of one agent's quota.
#[derive(Default)]
struct Known {
    /// The windows last read, with when they were read.
    reading: Option<(i64, Vec<Value>)>,
    /// Why the last read failed, until one succeeds.
    failure: Option<String>,
    /// A read of the CLI's report runs; no other is started meanwhile.
    asking: bool,
}

/// Whether a dashboard asks an agent's CLI for its report.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    /// No: a preview, and the dashboard published when a read ends.
    Nobody,
    /// Only an agent nothing was asked of yet: a read that is no refresh takes what the last one found or why it
    /// failed, as a provider's does.
    Once,
    /// A refresh: asked again.
    Again,
}

/// The dashboard windows of a CLI's quota report, read as the provider that meters the same quota reads the
/// gateway's own summary: the report names each bucket's fields in its own spelling.
fn windows_of(report: &Value) -> Vec<Value> {
    let groups = report.get("groups").and_then(Value::as_array).into_iter().flatten();
    let groups: Vec<Value> = groups
        .map(|group| {
            let buckets = group.get("buckets").and_then(Value::as_array).into_iter().flatten();
            let buckets: Vec<Value> = buckets
                .map(|bucket| {
                    let mut read = serde_json::Map::new();
                    for (ours, theirs) in [
                        ("bucketId", "id"),
                        ("window", "window"),
                        ("remainingFraction", "remaining_fraction"),
                        ("resetTime", "reset_time"),
                        ("displayName", "name"),
                    ] {
                        if let Some(value) = bucket.get(theirs) {
                            read.insert(ours.to_owned(), value.clone());
                        }
                    }
                    Value::Object(read)
                })
                .collect();
            json!({ "buckets": buckets })
        })
        .collect();
    normalise_windows(Some(&Value::Array(quota_windows(&json!({ "groups": groups })))), SOURCE)
}

/// Both readings are one account's: a window both name has begun (something of it is used) and ends at the same
/// instant in both. A window nothing was used of ends a fixed time after whenever it is read, so it tells nothing.
fn same_account(ours: &[Value], theirs: &[Value]) -> bool {
    let begun = |window: &Value| window.get("usedPct").and_then(Value::as_f64).is_some_and(|used| used > 0.0);
    let ends = |window: &Value| window.get("resetAt").and_then(Value::as_f64);
    ours.iter().filter(|window| begun(window)).any(|ours| {
        theirs
            .iter()
            .filter(|window| begun(window))
            .any(|theirs| ours.get("label") == theirs.get("label") && ends(ours).is_some() && ends(ours) == ends(theirs))
    })
}

/// The dashboard row of `preset`'s agent: connected, with `windows` read at `read_at`, or with why none could be read.
fn entry(preset: &AgentPreset, windows: Vec<Value>, read_at: Option<i64>, failure: Option<&str>) -> Value {
    let item = json!({ "id": preset.provider, "name": preset.label, "type": "acp", "enabled": true, "authenticated": true });
    let mut row = base_row(&item, "acp", &json!({}));
    let mut set = |key: &str, value: Value| {
        row.insert(key.to_owned(), value);
    };
    set("updatedAt", read_at.map_or(Value::Null, Value::from));
    if windows.is_empty() {
        set("status", "hidden".into());
        set("source", "usage-disabled".into());
        set("sourceLabel", "disabled".into());
        set("primary", "".into());
        set("detail", failure.unwrap_or("No current usage query result").into());
    } else {
        set("status", "partial".into());
        set("source", SOURCE.into());
        set("sourceLabel", "CLI".into());
        set("primary", windows.iter().map(display_window).take(2).collect::<Vec<_>>().join(" · ").into());
        set("detail", "subscription quota".into());
        set("windows", Value::Array(windows));
    }
    let tone = row_tone(&row);
    row.insert("tone".to_owned(), tone.into());
    Value::Object(row)
}

impl AgentUsage {
    pub fn new(
        inner: Arc<dyn DomainService>,
        quotas: Arc<dyn AgentQuotas>,
        history: Arc<dyn QuotaHistory>,
        now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
        publisher: Arc<dyn StatePublisher>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self { inner, quotas, history, now_ms, publisher, me: me.clone(), known: Mutex::default(), providers: Mutex::default() })
    }

    /// A reading enters the quota history the usage window draws, as a provider account's does. The CLI holds one
    /// sign-in, so its windows are the agent's `default` account's.
    async fn record(&self, preset: &AgentPreset, (at, windows): &(i64, Vec<Value>)) {
        let samples: Vec<QuotaSample> = windows
            .iter()
            .filter_map(|window| {
                Some(QuotaSample {
                    provider: preset.provider.clone(),
                    account: "default".to_owned(),
                    label: window.get("label")?.as_str()?.chars().take(40).collect(),
                    ts: *at,
                    used_pct: window.get("usedPct")?.as_f64()?,
                    reset_at: window.get("resetAt").and_then(Value::as_f64).map(|reset| reset.round() as i64),
                })
            })
            .collect();
        if samples.is_empty() {
            return;
        }
        if let Err(why) = self.history.record(samples).await {
            tracing::warn!("[usage] the quota history of {} could not be saved: {why}", preset.label);
        }
    }

    fn known(&self) -> std::sync::MutexGuard<'_, HashMap<String, Known>> {
        self.known.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn providers(&self) -> std::sync::MutexGuard<'_, Option<Value>> {
        self.providers.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The providers' `dashboard` with the agents' entries added; the reads `ask` calls for start and are not waited for.
    /// A `preview`'s rows are kept for nothing: a read that ends is published with the newest rows answered otherwise.
    pub fn with_agents(&self, mut dashboard: Value, ask: &dyn Fn(&AgentPreset) -> Ask, preview: bool) -> Value {
        if !preview {
            self.keep_providers(&dashboard);
        }
        self.add_entries(&mut dashboard, ask);
        dashboard
    }

    /// Keeps `dashboard` as the providers' rows a read publishes with, unless the one kept was checked later (a cached
    /// answer keeps the time its rows were checked).
    fn keep_providers(&self, dashboard: &Value) {
        let checked = |dashboard: &Value| dashboard.get("checkedAt").and_then(Value::as_f64);
        let mut kept = self.providers();
        let older = kept.as_ref().and_then(checked).zip(checked(dashboard)).is_some_and(|(kept, answered)| answered < kept);
        if !older {
            *kept = Some(dashboard.clone());
        }
    }

    fn add_entries(&self, dashboard: &mut Value, ask: &dyn Fn(&AgentPreset) -> Ask) {
        let rows = dashboard.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
        for preset in self.quotas.presets() {
            if let Some(entry) = self.entry(&preset, ask(&preset), &rows)
                && let Some(rows) = dashboard.get_mut("rows").and_then(Value::as_array_mut)
            {
                rows.push(entry);
            }
        }
    }

    /// `preset`'s entry for a dashboard whose provider rows are `rows`, from what is known now; `None` for an agent
    /// with no quota to show (off, signed out, nothing read yet) and for an account a provider's entry already shows.
    fn entry(&self, preset: &AgentPreset, ask: Ask, rows: &[Value]) -> Option<Value> {
        let report = preset.usage.as_ref()?;
        let reports = self.quotas.reports(preset);
        let (start, read, failure) = {
            let mut known = self.known();
            let known = known.entry(preset.id.clone()).or_default();
            if !reports {
                // A read still running is not doubled when the agent comes back; it ends with nothing to keep.
                (known.reading, known.failure) = (None, None);
                return None;
            }
            let wanted = match ask {
                Ask::Nobody => false,
                Ask::Once => known.reading.is_none() && known.failure.is_none(),
                Ask::Again => true,
            };
            let start = wanted && !known.asking;
            known.asking |= start;
            (start, known.reading.clone(), known.failure.clone())
        };
        if start {
            self.ask(preset);
        }
        if read.is_none() && failure.is_none() {
            return None;
        }
        let (read_at, windows) = read.map_or((None, Vec::new()), |(at, windows)| (Some(at), windows));
        let shown_by_provider = report.same_quota_as.as_deref().is_some_and(|provider| {
            let theirs =
                rows.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(provider)).and_then(|row| row.get("windows")).and_then(Value::as_array);
            theirs.is_some_and(|theirs| same_account(&windows, theirs))
        });
        (!shown_by_provider).then(|| entry(preset, windows, read_at, failure.as_deref()))
    }

    /// Reads `preset`'s report on its own task; what it finds is published when it ends.
    fn ask(&self, preset: &AgentPreset) {
        let (me, preset) = (self.me.clone(), preset.clone());
        drop(mixdog_rt::spawn("acp.usage", TaskClass::Work, async move {
            let Some(usage) = me.upgrade() else { return };
            let answer = usage.quotas.read(&preset).await;
            usage.answered(&preset, answer).await;
        }));
    }

    async fn answered(&self, preset: &AgentPreset, answer: Option<Result<Value, String>>) {
        let found = match answer {
            Some(Ok(report)) => Some(Ok(((self.now_ms)(), windows_of(&report)))),
            Some(Err(why)) => {
                tracing::warn!("[usage] {} did not report its quota: {why}", preset.label);
                Some(Err(why))
            }
            // The CLI could not be asked (off, signed out, being checked): nothing was learned.
            None => None,
        };
        // An agent turned off or signed out meanwhile keeps nothing of the account it left.
        let reports = self.quotas.reports(preset);
        let kept = {
            let mut known = self.known();
            let known = known.entry(preset.id.clone()).or_default();
            known.asking = false;
            match &found {
                Some(Ok(read)) if reports => {
                    (known.reading, known.failure) = (Some(read.clone()), None);
                    true
                }
                Some(Err(why)) if reports => {
                    known.failure = Some(why.clone());
                    true
                }
                _ => false,
            }
        };
        if !kept {
            return;
        }
        if let Some(Ok(read)) = &found {
            self.record(preset, read).await;
        }
        self.publish();
    }

    /// The last providers' dashboard with the agents' entries as known now, as the `usage` section's dashboard.
    fn publish(&self) {
        let Some(mut dashboard) = self.providers().clone() else { return };
        self.add_entries(&mut dashboard, &|_| Ask::Nobody);
        match change_of(&dashboard) {
            SectionChange::Stub { count } => tracing::warn!(count, "[usage] the dashboard exceeds the inline section limit and was not published"),
            change => self.publisher.publish(SectionName::Usage, Some(DASHBOARD_KEY.to_owned()), change),
        }
    }
}

/// The dashboard the `usage` section is fed: the providers' reading with the agents' entries, as a refresh answers.
pub struct WithAgents {
    pub providers: Arc<dyn SectionSource>,
    pub usage: Arc<AgentUsage>,
}

#[async_trait]
impl SectionSource for WithAgents {
    async fn read(&self, clock: &Clock) -> Result<Value, String> {
        let dashboard = self.providers.read(clock).await?;
        Ok(self.usage.with_agents(dashboard, &|_| Ask::Again, false))
    }

    fn ready(&self) -> bool {
        self.providers.ready()
    }
}

#[async_trait]
impl DomainService for AgentUsage {
    fn methods(&self) -> &'static [&'static str] {
        self.inner.methods()
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        if req.method.as_str() != DASHBOARD {
            return self.inner.call(req).await;
        }
        let options = req.params.get("options").cloned().unwrap_or(Value::Null);
        let asked = |key: &str| options.get(key) == Some(&Value::Bool(true));
        let scope: Vec<String> = options
            .get("refreshProviders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|id| id.trim().to_lowercase())
            .collect();
        let (refresh, preview) = (asked("refresh"), asked("preview"));
        let Reply::Value(dashboard) = self.inner.call(req).await? else {
            return Err(CoreError::Internal { incident_id: "the usage dashboard answered no value".into() });
        };
        let ask = |preset: &AgentPreset| {
            if preview {
                Ask::Nobody
            } else if refresh && (scope.is_empty() || scope.contains(&preset.provider.to_lowercase())) {
                Ask::Again
            } else {
                Ask::Once
            }
        };
        Ok(Reply::Value(self.with_agents(dashboard, &ask, preview)))
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        self.inner.notify(method, params, from)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use mixdog_core_api::CallContext;
    use tokio::sync::watch;

    use super::*;

    /// The usage service's own dashboard: what it is set to answer now.
    struct Providers(Mutex<Value>);

    impl Providers {
        fn answer(&self, dashboard: Value) {
            *self.0.lock().unwrap() = dashboard;
        }
    }

    #[async_trait]
    impl DomainService for Providers {
        fn methods(&self) -> &'static [&'static str] {
            &[DASHBOARD]
        }

        async fn call(&self, _: CoreRequest) -> Result<Reply, CoreError> {
            Ok(Reply::Value(self.0.lock().unwrap().clone()))
        }

        fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
            Admit::Accepted
        }
    }

    /// An agent's CLI: whether it is signed in, what its report says, how many times it was asked, and whether it
    /// answers (a CLI that hangs holds its report until `answers` opens).
    struct Cli {
        signed_in: AtomicBool,
        report: Mutex<Result<Value, String>>,
        asked: AtomicUsize,
        answers: watch::Sender<bool>,
    }

    #[async_trait]
    impl AgentQuotas for Cli {
        fn presets(&self) -> Vec<AgentPreset> {
            crate::acp_tools::builtin_presets()
        }

        fn reports(&self, _: &AgentPreset) -> bool {
            self.signed_in.load(Ordering::SeqCst)
        }

        async fn read(&self, _: &AgentPreset) -> Option<Result<Value, String>> {
            self.asked.fetch_add(1, Ordering::SeqCst);
            let _ = self.answers.subscribe().wait_for(|open| *open).await;
            Some(self.report.lock().unwrap().clone())
        }
    }

    /// The report `agy --print /usage --output-format json` printed for a signed-in account (1.5.15), its `command.data`.
    fn report() -> Value {
        json!({ "groups": [
            { "name": "Gemini Models", "buckets": [
                { "id": "gemini-weekly", "name": "Weekly Limit Remaining", "window": "weekly", "remaining_fraction": 0.75, "reset_time": "2030-01-08T00:00:00Z" },
                { "id": "gemini-5h", "name": "Five Hour Limit Remaining", "window": "5h", "remaining_fraction": 0.5, "reset_time": "2030-01-01T05:00:00Z" },
            ] },
            { "name": "Claude and GPT models", "buckets": [
                { "id": "3p-weekly", "name": "Weekly Limit Remaining", "window": "weekly", "remaining_fraction": 1, "reset_time": "2030-01-08T03:00:00Z" },
            ] },
        ] })
    }

    /// The quota history: every sample recorded.
    #[derive(Default)]
    struct History(Mutex<Vec<QuotaSample>>);

    #[async_trait]
    impl QuotaHistory for History {
        async fn record(&self, samples: Vec<QuotaSample>) -> Result<(), String> {
            self.0.lock().unwrap().extend(samples);
            Ok(())
        }
    }

    /// The `usage` section: each dashboard published to it, in order.
    struct Section(watch::Sender<Vec<Value>>);

    impl StatePublisher for Section {
        fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
            assert!(matches!(section, SectionName::Usage) && key.as_deref() == Some(DASHBOARD_KEY), "{key:?}");
            let SectionChange::Set(encoded) = change else { panic!("a dashboard that is not inline: {change:?}") };
            let dashboard: Value = serde_json::from_slice(&encoded).expect("JSON");
            self.0.send_modify(|published| published.push(dashboard));
        }
    }

    impl Section {
        /// The rows of the `n`th dashboard published (from 1), once it is.
        async fn nth(&self, n: usize) -> Vec<Value> {
            let mut published = self.0.subscribe();
            let waited = mixdog_rt::time::timeout(Duration::from_secs(10), published.wait_for(|published| published.len() >= n)).await;
            let dashboard = waited.expect("the dashboard to be published").expect("the section")[n - 1].clone();
            dashboard["rows"].as_array().expect("rows").clone()
        }

        fn count(&self) -> usize {
            self.0.borrow().len()
        }
    }

    struct Rig {
        usage: Arc<AgentUsage>,
        providers: Arc<Providers>,
        cli: Arc<Cli>,
        history: Arc<History>,
        section: Arc<Section>,
    }

    fn rig(providers: Vec<Value>) -> Rig {
        mixdog_rt::testing::tokens();
        let cli =
            Arc::new(Cli { signed_in: AtomicBool::new(true), report: Mutex::new(Ok(report())), asked: AtomicUsize::new(0), answers: watch::channel(true).0 });
        let history = Arc::new(History::default());
        let section = Arc::new(Section(watch::channel(Vec::new()).0));
        let providers = Arc::new(Providers(Mutex::new(json!({ "rows": providers }))));
        let usage = AgentUsage::new(providers.clone(), cli.clone(), history.clone(), Arc::new(|| 42), section.clone());
        Rig { usage, providers, cli, history, section }
    }

    impl Rig {
        fn asked(&self) -> usize {
            self.cli.asked.load(Ordering::SeqCst)
        }

        /// Whether a read of the agent's report runs now.
        fn asking(&self) -> bool {
            self.usage.known().values().any(|known| known.asking)
        }
    }

    async fn dashboard(usage: &AgentUsage, options: Value) -> Vec<Value> {
        let req = CoreRequest { method: Method(DASHBOARD), params: json!({ "options": options }), op: None, ctx: CallContext::internal("test") };
        let Reply::Value(dashboard) = usage.call(req).await.expect("the dashboard") else { panic!("a dashboard is a value") };
        dashboard["rows"].as_array().expect("rows").clone()
    }

    fn agent_row(rows: &[Value]) -> Option<&Value> {
        rows.iter().find(|row| row["id"] == "acp-antigravity")
    }

    /// Each reading of the agent's quota enters the quota history under the agent's provider, once per read.
    #[tokio::test]
    async fn each_reading_of_an_agents_quota_enters_the_quota_history_the_usage_window_draws() {
        let rig = rig(Vec::new());
        dashboard(&rig.usage, json!({})).await;
        rig.section.nth(1).await;
        dashboard(&rig.usage, json!({})).await;
        let recorded: Vec<(String, String, String, i64, f64, Option<i64>)> =
            rig.history.0.lock().unwrap().iter().map(|s| (s.provider.clone(), s.account.clone(), s.label.clone(), s.ts, s.used_pct, s.reset_at)).collect();
        let sample = |label: &str, used: f64, reset: i64| ("acp-antigravity".to_owned(), "default".to_owned(), label.to_owned(), 42, used, Some(reset));
        assert_eq!(recorded, [sample("5H", 50.0, 1_893_474_000_000), sample("7D", 25.0, 1_894_060_800_000), sample("7D Claude/GPT", 0.0, 1_894_071_600_000)]);
    }

    /// An agent whose CLI is signed in is an entry of the dashboard with the windows its report gives, from the
    /// dashboard published when the first read ends; it is read again on a refresh and not between, and gone once
    /// the agent is off or signed out.
    #[tokio::test]
    async fn a_signed_in_agents_quota_is_an_entry_of_the_dashboard_until_it_is_off_or_signed_out() {
        let rig = rig(vec![json!({ "id": "openai-oauth", "windows": [] })]);

        assert!(agent_row(&dashboard(&rig.usage, json!({})).await).is_none(), "nothing is read yet: the entry comes with the reading");
        let rows = rig.section.nth(1).await;
        assert_eq!(rows[0]["id"], "openai-oauth", "the providers' rows stay as they were");
        let row = agent_row(&rows).expect("the agent's entry").clone();
        assert_eq!((&row["label"], &row["authenticated"], &row["updatedAt"]), (&json!("Antigravity ACP"), &json!(true), &json!(42)));
        let shown: Vec<(&str, f64, f64)> = row["windows"]
            .as_array()
            .expect("windows")
            .iter()
            .map(|w| (w["label"].as_str().unwrap(), w["usedPct"].as_f64().unwrap(), w["resetAt"].as_f64().unwrap()))
            .collect();
        assert_eq!(shown, [("5H", 50.0, 1_893_474_000_000.0), ("7D", 25.0, 1_894_060_800_000.0), ("7D Claude/GPT", 0.0, 1_894_071_600_000.0)]);

        assert_eq!(agent_row(&dashboard(&rig.usage, json!({})).await), Some(&row), "a dashboard answers the last reading");
        assert!(!rig.asking());
        assert_eq!(rig.asked(), 1, "a read that is no refresh takes what the last one found");
        dashboard(&rig.usage, json!({ "refresh": true, "refreshProviders": ["openai-oauth"] })).await;
        assert!(!rig.asking(), "a refresh of another provider does not ask the agent");
        dashboard(&rig.usage, json!({ "refresh": true })).await;
        rig.section.nth(2).await;
        assert_eq!(rig.asked(), 2);

        rig.cli.signed_in.store(false, Ordering::SeqCst);
        assert!(agent_row(&dashboard(&rig.usage, json!({})).await).is_none(), "an agent that is off or signed out has no entry");
    }

    /// The account a provider's entry already shows is not shown a second time under the agent; another account is.
    #[tokio::test]
    async fn an_account_the_provider_already_shows_is_not_shown_again_under_the_agent() {
        let provider = |weekly_reset: f64| json!({ "id": "antigravity-oauth", "windows": [{ "label": "7D", "usedPct": 25.2, "resetAt": weekly_reset }] });
        let read = |providers: Value| async move {
            let rig = rig(vec![providers]);
            dashboard(&rig.usage, json!({})).await;
            rig.section.nth(1).await;
            agent_row(&dashboard(&rig.usage, json!({})).await).is_some()
        };

        assert!(!read(provider(1_894_060_800_000.0)).await, "the same account: its weekly window ends at the same instant");
        assert!(read(provider(1_894_000_000_000.0)).await, "another account's window ends at another instant");
        // A window nothing was used of ends a fixed time after it is read: two accounts read in the same second agree
        // on it, and are still two accounts.
        let unused = json!({ "id": "antigravity-oauth", "windows": [{ "label": "7D Claude/GPT", "usedPct": 0, "resetAt": 1_894_071_600_000.0_f64 }] });
        assert!(read(unused).await);
    }

    /// A report that fails leaves the entry connected, with the CLI's words and no windows; the CLI is asked again on
    /// a refresh, not by each dashboard.
    #[tokio::test]
    async fn a_report_that_fails_leaves_the_agent_connected_with_no_windows() {
        let rig = rig(Vec::new());
        *rig.cli.report.lock().unwrap() = Err("quota service unavailable".into());
        dashboard(&rig.usage, json!({})).await;
        let rows = rig.section.nth(1).await;
        let row = agent_row(&rows).expect("the agent's entry").clone();
        assert_eq!((&row["authenticated"], &row["windows"], &row["detail"]), (&json!(true), &json!([]), &json!("quota service unavailable")));

        for _ in 0..3 {
            assert_eq!(agent_row(&dashboard(&rig.usage, json!({})).await), Some(&row));
        }
        assert!(!rig.asking());
        assert_eq!(rig.asked(), 1, "a failed read is not started again by each dashboard");
        dashboard(&rig.usage, json!({ "refresh": true })).await;
        rig.section.nth(2).await;
        assert_eq!(rig.asked(), 2);
    }

    /// A read that ends is published with the newest provider rows answered: a preview's rows, and a plain answer's
    /// rows checked before the refresh's, are not what the section is sent.
    #[tokio::test]
    async fn a_read_that_ends_after_a_preview_publishes_the_refreshs_provider_rows_with_the_agents_row() {
        let rig = rig(Vec::new());
        rig.cli.answers.send_replace(false);
        let provider = |used: u64| json!({ "id": "openai-oauth", "windows": [{ "label": "5H", "usedPct": used }] });
        rig.providers.answer(json!({ "checkedAt": 2_000, "rows": [provider(30)] }));
        dashboard(&rig.usage, json!({ "refresh": true })).await;

        // While the agent's CLI has not answered: a preview (whatever its time), then a plain answer from rows checked earlier.
        rig.providers.answer(json!({ "checkedAt": 3_000, "rows": [provider(10)] }));
        assert_eq!(dashboard(&rig.usage, json!({ "preview": true })).await, [provider(10)], "the preview answers its own rows");
        rig.providers.answer(json!({ "checkedAt": 1_000, "cached": true, "rows": [provider(20)] }));
        assert_eq!(dashboard(&rig.usage, json!({})).await, [provider(20)]);

        rig.cli.answers.send_replace(true);
        let rows = rig.section.nth(1).await;
        assert_eq!(rows[0], provider(30), "the refresh's provider rows");
        assert!(agent_row(&rows).is_some_and(|row| row["windows"].as_array().is_some_and(|windows| windows.len() == 3)), "{rows:?}");
        assert_eq!(rows.len(), 2);
        assert_eq!(rig.section.count(), 1);
    }

    /// A CLI that does not answer is not waited for: each dashboard answers with what is known (nothing yet), one read
    /// runs however often the dashboard is asked, and the reading reaches the usage section when the CLI answers.
    #[tokio::test]
    async fn a_dashboard_call_returns_while_the_agents_usage_read_has_not_answered() {
        let rig = rig(vec![json!({ "id": "openai-oauth", "windows": [] })]);
        rig.cli.answers.send_replace(false);
        for options in [json!({}), json!({ "refresh": true }), json!({ "refresh": true })] {
            let answered = mixdog_rt::time::timeout(Duration::from_secs(10), dashboard(&rig.usage, options)).await;
            let rows = answered.expect("the dashboard waited on the agent's CLI");
            assert_eq!(rows.iter().map(|row| row["id"].clone()).collect::<Vec<_>>(), [json!("openai-oauth")]);
        }
        mixdog_rt::time::timeout(Duration::from_secs(10), async {
            while rig.asked() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the read to start");
        assert!(rig.asking());
        assert_eq!(rig.section.count(), 0, "nothing is published before the CLI answers");

        rig.cli.answers.send_replace(true);
        let rows = rig.section.nth(1).await;
        assert!(agent_row(&rows).is_some_and(|row| row["windows"].as_array().is_some_and(|windows| windows.len() == 3)), "{rows:?}");
        assert_eq!(rig.asked(), 1, "one read ran for the three dashboards");
        assert!(agent_row(&dashboard(&rig.usage, json!({})).await).is_some());
    }
}
