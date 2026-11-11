//! The `account` domain service: provider credentials, the account roster, OAuth flows and
//! the quota history.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_ai::accounts::ACCOUNT_PROVIDERS;
use mixdog_ai::accounts::Account;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_core_config::section_watch::FolderTrigger;
use mixdog_core_config::section_watch::Watched;
use tokio::sync::Notify;
use tokio::sync::watch;
use mixdog_ledger::quota::QuotaHistoryOptions;
use mixdog_protocol::SectionName;
use serde_json::Value;
use serde_json::json;

use super::admin::ProviderAdmin;
use super::collaborators::CustomProviders;
use super::collaborators::ProviderSetup;
use super::collaborators::WebSearchModels;
use super::dashboards::Dashboards;
use super::failure::Failure;
use super::failure::ledger_failure;
use super::flows::OAuthFlows;
use super::usage::LedgerAccess;
use super::usage::dashboard::UsageSources;
use super::usage::now_ms;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;

const DOMAIN: &str = "account";

/// What wakes the `providerSetup` and `providerAccounts` sections besides this service's own
/// methods: a change of the config (`Config::changes`), and of the credential files in the data
/// folder, whoever wrote them.
pub struct SectionWake {
    pub config: watch::Receiver<u64>,
    pub files: Watched,
}

/// What each pushed section holds, so a section is published only when its value changed.
pub struct SectionPush {
    publisher: Arc<dyn StatePublisher>,
    pushed: Mutex<HashMap<(SectionName, Option<String>), Value>>,
}

impl SectionPush {
    pub fn new(publisher: Arc<dyn StatePublisher>) -> Self {
        Self { publisher, pushed: Mutex::new(HashMap::new()) }
    }

    /// Publishes alue as (section, key) unless that is what was published last.
    pub fn push(&self, section: SectionName, key: Option<String>, value: Value) {
        let mut pushed = self.pushed.lock().unwrap_or_else(PoisonError::into_inner);
        if pushed.get(&(section, key.clone())) != Some(&value) {
            self.publisher.publish(section, key.clone(), change_of(&value));
            pushed.insert((section, key), value);
        }
    }
}

/// Runs `publish` once, then after each wake: a change of the config, of an account file, or a complete provider setup
/// filling its cache. The last is what a cold read's background build ends in; Node pushes nothing, its next read
/// answers the built setup, so the pushed section has to follow it.
pub(super) async fn republish_on_wakes<F, Fut>(mut config: watch::Receiver<u64>, files: Arc<Notify>, mut filled: watch::Receiver<u64>, mut publish: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    loop {
        publish().await;
        tokio::select! {
            changed = config.changed() => if changed.is_err() { return },
            () = files.notified() => {}
            changed = filled.changed() => if changed.is_err() { return },
        }
    }
}

pub struct AccountService {
    admin: Arc<ProviderAdmin>,
    flows: OAuthFlows,
    ledger: Arc<dyn LedgerAccess>,
    custom: Arc<dyn CustomProviders>,
    web_search: Arc<dyn WebSearchModels>,
    setup: Arc<dyn ProviderSetup>,
    dashboards: Arc<Dashboards>,
    sources: Arc<dyn UsageSources>,
    ops: OpScopes,
    pushed: SectionPush,
}

/// The methods that read or probe only; every other `account/` method may change credentials,
/// the account pools or the provider list, and so the `providerSetup` and `providerAccounts`
/// sections.
fn leaves_sections(method: &str) -> bool {
    matches!(
        method,
        "account/getOAuthProviderLoginStatus"
            | "account/listWebSearchModels"
            | "account/getQuotaHistory"
            | "account/beginOAuthProviderLogin"
            | "account/cancelOAuthProviderLogin"
            | "account/testCustomProvider"
            | "account/checkCustomProviderKeyEnv"
            | "account/discoverCustomProviderModels"
    )
}

fn str_param<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The provider and lease of an `account/refreshProviderSetup` that renews a credential first.
fn renewal_of(params: &Value) -> Result<Option<(&str, u64)>, CoreError> {
    let Some(provider) = params.get("renewCredential").and_then(Value::as_str) else { return Ok(None) };
    let minimum = params
        .get("minimumValidityMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("minimumValidityMs", "a number of milliseconds with renewCredential"))?;
    Ok(Some((provider, minimum)))
}

fn options_of(params: &Value) -> Value {
    match params.get("options") {
        Some(v) if !v.is_null() => v.clone(),
        _ => json!({}),
    }
}

impl AccountService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        admin: Arc<ProviderAdmin>,
        flows: OAuthFlows,
        ledger: Arc<dyn LedgerAccess>,
        custom: Arc<dyn CustomProviders>,
        web_search: Arc<dyn WebSearchModels>,
        setup: Arc<dyn ProviderSetup>,
        dashboards: Arc<Dashboards>,
        sources: Arc<dyn UsageSources>,
        ops: OpScopes,
        publisher: Arc<dyn StatePublisher>,
        wake: SectionWake,
    ) -> Result<Arc<Self>, String> {
        let files_changed = Arc::new(Notify::new());
        let trigger = FolderTrigger::start("account-files", wake.files, files_changed.clone()).map_err(|error| error.to_string())?;
        let service = Arc::new(Self { admin, flows, ledger, custom, web_search, setup, dashboards, sources, ops, pushed: SectionPush::new(publisher) });
        // The sections hold a value from the start; a change of the config or of an account file
        // (another process's included: Node reads them on every call) pushes the next one.
        let task = service.clone();
        let (config, filled) = (wake.config, service.setup.filled());
        mixdog_rt::spawn("account-sections", mixdog_rt::TaskClass::Work, async move {
            // The file watch lives as long as the task.
            let _trigger = trigger;
            republish_on_wakes(config, files_changed, filled, || task.publish_sections()).await;
        });
        Ok(service)
    }

    /// The `providerSetup` section (`getProviderSetup()`) and a `providerAccounts` entry per
    /// account provider (`getProviderAccounts(provider)`). A value that cannot be read keeps
    /// the last one pushed.
    async fn publish_sections(&self) {
        if let Ok(setup) = self.setup.get(false, false, false, false).await {
            self.pushed.push(SectionName::ProviderSetup, None, setup);
        }
        for provider in ACCOUNT_PROVIDERS {
            if let Ok(accounts) = self.admin.list_provider_accounts(provider).await {
                self.pushed.push(SectionName::ProviderAccounts, Some((*provider).to_owned()), accounts);
            }
        }
    }

    /// `getQuotaHistory`: the ledger's history, labelled with each account's place in its pool.
    async fn get_quota_history(&self, options: Value) -> Result<Value, CoreError> {
        let options: QuotaHistoryOptions =
            serde_json::from_value(options).map_err(|e| invalid("options", &e.to_string()))?;
        // The account each subscription is used through now: the one a question naming no
        // account is about.
        let mut in_use = BTreeMap::new();
        for provider in ACCOUNT_PROVIDERS {
            if let Ok(pool) = self.admin.accounts.pool(provider).await {
                let id = mixdog_js::slice_utf16(pool.selected_id.as_deref().unwrap_or(""), 200);
                if !id.is_empty() {
                    in_use.insert(provider.to_owned(), id);
                }
            }
        }
        let ledger = self.ledger.ledger().await.map_err(|e| ledger_failure(e, DOMAIN))?;
        let history = ledger.get_quota_history(options, in_use, now_ms()).await.map_err(|e| ledger_failure(e, DOMAIN))?;
        Ok(self.label_quota_history(history).await)
    }

    /// `labelQuotaHistory`: what the ledger cannot know — each subscription account's label and
    /// place in its provider's account pool, the order the account picker lists them in.
    async fn label_quota_history(&self, mut history: Value) -> Value {
        let rows = history.get("subscriptions").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut rosters: BTreeMap<String, Vec<Account>> = BTreeMap::new();
        let mut emails: BTreeMap<String, Value> = BTreeMap::new();
        let mut out = Vec::new();
        for mut row in rows {
            let provider = row["provider"].as_str().unwrap_or("").to_owned();
            let account = row["account"].as_str().unwrap_or("").to_owned();
            let account_provider = ACCOUNT_PROVIDERS.contains(&provider.as_str());
            if account_provider && !rosters.contains_key(&provider) {
                let pool = self.admin.accounts.pool(&provider).await.map(|p| p.accounts).unwrap_or_default();
                rosters.insert(provider.clone(), pool);
            }
            let roster: &[Account] = rosters.get(&provider).map_or(&[], Vec::as_slice);
            let rank = roster.iter().position(|r| r.id == account);
            let mut email = String::new();
            if rank.is_some() {
                if !emails.contains_key(&provider) {
                    let map = match self.admin.list_provider_accounts(&provider).await {
                        Ok(list) => Value::Object(
                            list["accounts"]
                                .as_array()
                                .map(|rows| {
                                    rows.iter()
                                        .map(|r| (r["id"].as_str().unwrap_or("").to_owned(), r["email"].clone()))
                                        .collect()
                                })
                                .unwrap_or_default(),
                        ),
                        Err(_) => json!({}),
                    };
                    emails.insert(provider.clone(), map);
                }
                email = emails
                    .get(&provider)
                    .and_then(|m| m.get(&account))
                    .and_then(Value::as_str)
                    .map(|s| mixdog_js::slice_utf16(s, 200))
                    .unwrap_or_default();
            }
            // History of an account that left the roster stays stored, but the picker must not
            // offer it. The implicit `default` account of a provider with no stored roster is
            // still current.
            let in_roster = !account_provider || rank.is_some() || (account == "default" && roster.is_empty());
            row["accountLabel"] = json!(rank.and_then(|i| roster[i].label.clone()).unwrap_or_default());
            row["accountRank"] = rank.map_or(Value::Null, |i| json!(i));
            row["accountInRoster"] = json!(in_roster);
            if !email.is_empty() {
                row["accountEmail"] = json!(email);
            }
            out.push(row);
        }
        history["subscriptions"] = Value::Array(out);
        history
    }

    async fn dispatch(&self, method: &str, params: &Value, body_lone_units: usize) -> Result<Value, CoreError> {
        let admin = &self.admin;
        let provider = str_param(params, "providerId");
        let ok = Value::Bool(true);
        let into = |f: Failure| f.into_core(DOMAIN);
        Ok(match method {
            "account/getOAuthProviderLoginStatus" => self.flows.status(str_param(params, "flowId")).map_err(into)?,
            "account/listWebSearchModels" => {
                let o = options_of(params);
                let force = o.get("force") == Some(&Value::Bool(true)) || o.get("refresh") == Some(&Value::Bool(true));
                let thread = Some(str_param(params, "threadId")).filter(|id| !id.is_empty()).map(ThreadId::from);
                self.web_search.list(thread.as_ref(), force).await.map_err(into)?
            }
            "account/getQuotaHistory" => self.get_quota_history(options_of(params)).await?,
            "account/authenticateProvider" => {
                admin.authenticate_provider(provider, str_param(params, "secret")).await.map_err(into)?;
                ok
            }
            "account/loginOAuthProvider" => {
                admin.login_oauth_provider(provider).await.map_err(into)?;
                ok
            }
            "account/beginOAuthProviderLogin" => {
                let (session, settle) =
                    admin.begin_oauth_provider_login(provider, &options_of(params)).await.map_err(into)?;
                self.flows.register(provider, session, settle).map_err(into)?
            }
            "account/completeOAuthProviderLogin" => self
                .flows
                .complete(str_param(params, "flowId"), str_param(params, "callbackUrl"))
                .await
                .map_err(into)?,
            "account/cancelOAuthProviderLogin" => self.flows.cancel(str_param(params, "flowId")).await.map_err(into)?,
            "account/forgetProviderAuth" => {
                let account = params.get("accountId").and_then(Value::as_str);
                admin.forget_provider_auth(provider, account).await.map_err(into)?;
                ok
            }
            "account/updateProviderAccounts" => admin
                .update_provider_accounts(provider, params.get("change").unwrap_or(&Value::Null))
                .await
                .map_err(into)?,
            "account/saveProviderApiKey" => {
                admin
                    .save_provider_api_key(provider, str_param(params, "secret"), &options_of(params))
                    .await
                    .map_err(into)?;
                ok
            }
            "account/saveCustomProvider" => self.custom.save(params["input"].clone(), body_lone_units).await.map_err(into)?,
            "account/saveCustomProviderKey" => {
                self.custom.save_key(provider, &params["secret"]).await.map_err(into)?
            }
            "account/removeCustomProvider" => self.custom.remove(provider).await.map_err(into)?,
            "account/updateCustomProviderModel" => self
                .custom
                .update_model(provider, str_param(params, "modelId"), params.get("patch").cloned())
                .await
                .map_err(into)?,
            "account/testCustomProvider" => self.custom.test(params["input"].clone(), body_lone_units).await.map_err(into)?,
            "account/checkCustomProviderKeyEnv" => {
                ProviderAdmin::check_custom_provider_key_env(str_param(params, "name")).map_err(into)?
            }
            "account/discoverCustomProviderModels" => {
                self.custom.discover_models(params["input"].clone(), body_lone_units).await.map_err(into)?
            }
            "account/saveOpenAIUsageSessionKey" => {
                admin.save_openai_usage_session_key(str_param(params, "secret")).await.map_err(into)?;
                ok
            }
            "account/consumeCodexRateLimitResetCredit" => admin
                .consume_codex_reset_credit(&options_of(params), &self.dashboards, self.sources.as_ref())
                .await
                .map_err(into)?,
            "account/refreshProviderSetup" => {
                let flag = |k: &str| params.get(k) == Some(&Value::Bool(true));
                // The credential is renewed first, so the setup read below reports its new expiry.
                if let Some((provider, minimum)) = renewal_of(params)? {
                    admin.renew_provider_credential(provider, minimum).await.map_err(into)?;
                }
                self.setup
                    .get(flag("force"), flag("refresh"), flag("unlockKeychain"), flag("recheckKeychain"))
                    .await
                    .map_err(into)?;
                json!({})
            }
            other => return Err(wrong_method(DOMAIN, other)),
        })
    }
}

/// Methods that act outside the process (a sign-in, a provider call): a crash in between reads
/// as `externalOutcomeUnknown`.
fn external_effect(method: &str, params: &Value) -> Option<(&'static str, String)> {
    let target = || str_param(params, "providerId").to_owned();
    match method {
        "account/authenticateProvider" | "account/loginOAuthProvider" | "account/beginOAuthProviderLogin" => {
            Some(("providerLogin", target()))
        }
        "account/testCustomProvider" | "account/discoverCustomProviderModels" => Some(("providerProbe", target())),
        "account/consumeCodexRateLimitResetCredit" => Some(("codexResetCredit", "openai-oauth".into())),
        _ => None,
    }
}

#[async_trait]
impl DomainService for AccountService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let method = req.method.as_str();
        // The lone surrogates a custom provider's `requestBody` held (only its top-level values are free text): its size limit
        // counts each as Node's `JSON.stringify` writes it.
        let body_lone_units = req
            .ctx
            .lone_surrogates
            .iter()
            .filter(|at| matches!(at, mixdog_js::LoneAt::Unit { pointer, .. } if pointer.starts_with("/input/requestBody/")))
            .count();
        match method {
            "account/getOAuthProviderLoginStatus" | "account/listWebSearchModels" | "account/getQuotaHistory" => {
                Ok(Reply::Value(self.dispatch(method, &req.params, body_lone_units).await?))
            }
            m if m.starts_with("account/") => {
                let external = external_effect(method, &req.params);
                let reply = self
                    .ops
                    .run(
                        &req,
                        external,
                        || async { self.dispatch(method, &req.params, body_lone_units).await },
                        || async { Ok(Value::Null) },
                    )
                    .await?;
                if !leaves_sections(method) {
                    self.publish_sections().await;
                }
                Ok(reply)
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "account/getOAuthProviderLoginStatus",
            "account/listWebSearchModels",
            "account/getQuotaHistory",
            "account/authenticateProvider",
            "account/loginOAuthProvider",
            "account/beginOAuthProviderLogin",
            "account/completeOAuthProviderLogin",
            "account/cancelOAuthProviderLogin",
            "account/forgetProviderAuth",
            "account/updateProviderAccounts",
            "account/saveProviderApiKey",
            "account/saveCustomProvider",
            "account/saveCustomProviderKey",
            "account/removeCustomProvider",
            "account/updateCustomProviderModel",
            "account/testCustomProvider",
            "account/checkCustomProviderKeyEnv",
            "account/discoverCustomProviderModels",
            "account/saveOpenAIUsageSessionKey",
            "account/consumeCodexRateLimitResetCredit",
            "account/refreshProviderSetup",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod section_tests {
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_api::state::SectionChange;
    use serde_json::json;

    use super::*;

    #[test]
    fn a_section_is_pushed_only_when_its_value_changed() {
        let publisher = Arc::new(MockStatePublisher::default());
        let pushed = SectionPush::new(publisher.clone());
        pushed.push(SectionName::ProviderSetup, None, json!({ "providers": [] }));
        pushed.push(SectionName::ProviderSetup, None, json!({ "providers": [] }));
        pushed.push(SectionName::ProviderAccounts, Some("openai-oauth".into()), json!({ "accounts": [] }));
        pushed.push(SectionName::ProviderAccounts, Some("anthropic-oauth".into()), json!({ "accounts": [] }));
        pushed.push(SectionName::ProviderSetup, None, json!({ "providers": [1] }));
        let published = publisher.published();
        let seen: Vec<(SectionName, Option<String>)> = published.iter().map(|(section, key, _)| (*section, key.clone())).collect();
        assert_eq!(
            seen,
            [
                (SectionName::ProviderSetup, None),
                (SectionName::ProviderAccounts, Some("openai-oauth".into())),
                (SectionName::ProviderAccounts, Some("anthropic-oauth".into())),
                (SectionName::ProviderSetup, None),
            ]
        );
        let SectionChange::Set(bytes) = &published[3].2 else { panic!("a small value is carried whole") };
        assert_eq!(serde_json::from_slice::<Value>(bytes).unwrap(), json!({ "providers": [1] }));
    }

    #[test]
    fn a_credential_renewal_names_its_provider_and_lease() {
        assert_eq!(renewal_of(&json!({ "force": true })).unwrap(), None, "a plain refresh renews nothing");
        assert_eq!(renewal_of(&json!({ "renewCredential": "anthropic-oauth", "minimumValidityMs": 3_600_000 })).unwrap(), Some(("anthropic-oauth", 3_600_000)));
        assert!(renewal_of(&json!({ "renewCredential": "anthropic-oauth" })).is_err(), "a renewal needs its lease");
        assert!(renewal_of(&json!({ "renewCredential": "anthropic-oauth", "minimumValidityMs": -1 })).is_err());
    }

    #[test]
    fn only_reads_and_probes_leave_the_sections_alone() {
        for method in ["account/getQuotaHistory", "account/beginOAuthProviderLogin", "account/testCustomProvider"] {
            assert!(leaves_sections(method), "{method}");
        }
        for method in ["account/authenticateProvider", "account/updateProviderAccounts", "account/refreshProviderSetup", "account/forgetProviderAuth", "account/completeOAuthProviderLogin"] {
            assert!(!leaves_sections(method), "{method}");
        }
    }
}
