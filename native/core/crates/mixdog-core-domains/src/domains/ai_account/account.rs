//! The `account` domain service: provider credentials, the account roster, OAuth flows and
//! the quota history.

use std::collections::BTreeMap;
use std::sync::Arc;

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
use mixdog_ledger::quota::QuotaHistoryOptions;
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
}

fn str_param<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or("")
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
    ) -> Arc<Self> {
        Arc::new(Self { admin, flows, ledger, custom, web_search, setup, dashboards, sources, ops })
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

    async fn dispatch(&self, method: &str, params: &Value) -> Result<Value, CoreError> {
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
            "account/saveCustomProvider" => self.custom.save(params["input"].clone()).await.map_err(into)?,
            "account/saveCustomProviderKey" => {
                self.custom.save_key(provider, &params["secret"]).await.map_err(into)?
            }
            "account/removeCustomProvider" => self.custom.remove(provider).await.map_err(into)?,
            "account/updateCustomProviderModel" => self
                .custom
                .update_model(provider, str_param(params, "modelId"), params.get("patch").cloned())
                .await
                .map_err(into)?,
            "account/testCustomProvider" => self.custom.test(params["input"].clone()).await.map_err(into)?,
            "account/checkCustomProviderKeyEnv" => {
                ProviderAdmin::check_custom_provider_key_env(str_param(params, "name")).map_err(into)?
            }
            "account/discoverCustomProviderModels" => {
                self.custom.discover_models(params["input"].clone()).await.map_err(into)?
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
        match method {
            "account/getOAuthProviderLoginStatus" | "account/listWebSearchModels" | "account/getQuotaHistory" => {
                Ok(Reply::Value(self.dispatch(method, &req.params).await?))
            }
            m if m.starts_with("account/") => {
                let external = external_effect(method, &req.params);
                self.ops
                    .run(
                        &req,
                        external,
                        || async { self.dispatch(method, &req.params).await },
                        || async { Ok(Value::Null) },
                    )
                    .await
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
