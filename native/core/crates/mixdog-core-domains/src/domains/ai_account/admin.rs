//! `provider-admin.mjs` and the `provider-auth/` wrappers: credential mutations, the account
//! roster, and the refresh chain they trigger — over `AccountStore`, the key vault, the agent
//! config and the registry.

use std::sync::Arc;

use mixdog_ai::accounts::ACCOUNT_PROVIDERS;
use mixdog_ai::accounts::Account;
use mixdog_ai::accounts::AccountChange;
use mixdog_ai::accounts::AccountError;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::accounts::Policy;
use mixdog_ai::accounts::new_account_id;
use mixdog_ai::accounts::policy::Limit;
use mixdog_ai::accounts::policy::account_blocked_until;
use mixdog_ai::accounts::policy::account_limit;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::providers::google::auth::vertex::parse_service_account;
use mixdog_ai::registry::keys::SecretVault;
use mixdog_ai::registry::keys::api_key_account;
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::oauth_usage::OAuthUsage;
use mixdog_ai::service::oauth_usage::RouteInfo;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_rt::CancellationToken;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::collaborators::AuthRefresh;
use super::collaborators::OAuthProvider;
use super::collaborators::VertexAdc;
use super::failure::Failure;
use super::flows::Settle;
use super::js::clean;
use super::js::truthy;
use mixdog_core_config::config::Config;
use mixdog_core_base::support::on_lane;

/// `API_PROVIDERS` ids, in setup order.
const API_PROVIDER_IDS: [&str; 7] = ["openrouter", "openai", "anthropic", "gemini", "vertex-ai", "deepseek", "xai"];
const OPENAI_USAGE_SESSION_KEY_ACCOUNT: &str = "agent.openai.usageSessionKey";
const VERTEX_ADC_MODE: &str = "adc";
const VERTEX_API_KEY_MODE: &str = "api-key";
const MODEL_PROXY_ENV: &str = "MIXDOG_MODEL_PROXY";

pub(crate) fn acct(error: AccountError) -> Failure {
    match error {
        AccountError::Invalid(m) => Failure::type_error(m),
        other => Failure::error(other.to_string()),
    }
}

fn vault_failure(error: mixdog_ai::registry::keys::VaultError) -> Failure {
    Failure::error(error.message)
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(v) if truthy(Some(v)) => mixdog_js::value_to_string(v),
        _ => String::new(),
    }
}

/// `normalizeAccountIdentity`: id and email trimmed and cut to 200.
fn identity_text(value: Option<&Value>) -> String {
    mixdog_js::slice_utf16(&clean(value), 200)
}

/// `sameAccountIdentity`: stable ids decide when both sides have one, else email.
fn same_identity(a: (&Value, &Value), b: (&Value, &Value)) -> bool {
    let left = (identity_text(Some(a.0)), identity_text(Some(a.1)));
    let right = (identity_text(Some(b.0)), identity_text(Some(b.1)));
    if (left.0.is_empty() && left.1.is_empty()) || (right.0.is_empty() && right.1.is_empty()) {
        return false;
    }
    if !left.0.is_empty() && !right.0.is_empty() {
        return left.0 == right.0;
    }
    !left.1.is_empty() && !right.1.is_empty() && left.1.to_lowercase() == right.1.to_lowercase()
}

fn patch(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Map<String, Value> {
    entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// The object at `key`, created (or replaced, when the stored value is not an object) in place.
pub(crate) fn object_at<'a>(doc: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let slot = doc.entry(key).or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    match slot {
        Value::Object(map) => map,
        _ => unreachable!("the slot is an object"),
    }
}

pub struct ProviderAdmin {
    pub(crate) providers: Vec<Arc<dyn OAuthProvider>>,
    builder: Arc<dyn ProviderBuilder>,
    pub(crate) accounts: AccountStore,
    vault: Arc<dyn SecretVault>,
    config: Config,
    pub(crate) refresh: Arc<dyn AuthRefresh>,
    vertex_adc: Arc<dyn VertexAdc>,
    pub(crate) registry: Arc<ProviderRegistry>,
    pub(crate) oauth_usage: Arc<OAuthUsage>,
    /// The lanes the account store's credential files are worked on.
    credential_io: CredentialIo,
    /// `accountUsageSweeps`: the providers whose roster a background usage sweep is measuring now.
    usage_sweeps: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

/// How old an account's reading is before a roster read measures it again. Node's sweep re-measures whatever its
/// 60-second cache no longer holds, on every read of the roster; the desktop reads the roster each time its usage
/// dashboard updates, so every account of every roster would be asked about once a minute. Five minutes is the age
/// other clients keep a per-account reading for (oh-my-pi `USAGE_REPORT_TTL_MS`).
const SWEEP_READING_TTL_MS: i64 = 5 * 60_000;

/// The age at which `account`'s reading is due: [`SWEEP_READING_TTL_MS`] moved by up to a quarter either way, fixed
/// per account, so the accounts of a roster are not all asked in the same second (a provider answers a burst from
/// one address with 429s).
fn sweep_ttl_ms(account: &str) -> i64 {
    let hash = account.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3));
    let quarter = SWEEP_READING_TTL_MS / 4;
    SWEEP_READING_TTL_MS - quarter + (hash % (2 * quarter as u64 + 1)) as i64
}

/// The accounts of `rows` whose reading a sweep takes again at `now`: never measured, or measured longer ago than
/// their [`sweep_ttl_ms`]. The account in use (`selected`) is left out: the usage dashboard measures it, and every
/// request it serves is followed by one. A roster of one account has nothing else to measure, so the sweep adds no
/// request to it.
fn sweep_due(rows: &[Account], selected: Option<&str>, now: i64) -> Vec<String> {
    rows.iter()
        .filter(|row| Some(row.id.as_str()) != selected)
        .filter(|row| now - row.usage.as_ref().map_or(0, |usage| usage.checked_at) > sweep_ttl_ms(&row.id))
        .map(|row| row.id.clone())
        .collect()
}

impl ProviderAdmin {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        providers: Vec<Arc<dyn OAuthProvider>>,
        builder: Arc<dyn ProviderBuilder>,
        accounts: AccountStore,
        vault: Arc<dyn SecretVault>,
        config: Config,
        refresh: Arc<dyn AuthRefresh>,
        vertex_adc: Arc<dyn VertexAdc>,
        registry: Arc<ProviderRegistry>,
        oauth_usage: Arc<OAuthUsage>,
        credential_io: CredentialIo,
    ) -> Arc<Self> {
        Arc::new(Self {
            providers,
            builder,
            accounts,
            vault,
            config,
            refresh,
            vertex_adc,
            registry,
            oauth_usage,
            credential_io,
            usage_sweeps: Arc::default(),
        })
    }

    /// `getProviderAccounts`' background sweep (`sweepAccountUsage`, accounts.mjs:64-76): the stored readings are
    /// answered as they are, and the accounts whose reading is due are measured behind the answer, four at a time,
    /// one sweep per provider at a time. What it measures lands in the roster for the next read. An account that
    /// is not in use is measured by nothing else until a send moves to it.
    fn sweep_account_usage(&self, provider: &str, rows: &[Account], selected: Option<&str>) {
        let due = sweep_due(rows, selected, chrono::Utc::now().timestamp_millis());
        if due.is_empty() || !self.usage_sweeps.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(provider.to_owned()) {
            return;
        }
        let (usage, sweeps, provider) = (self.oauth_usage.clone(), self.usage_sweeps.clone(), provider.to_owned());
        drop(mixdog_rt::spawn("account-usage-sweep", mixdog_rt::TaskClass::Work, async move {
            for chunk in due.chunks(4) {
                futures::future::join_all(chunk.iter().map(|id| {
                    let route = RouteInfo { provider: provider.clone(), model: String::new(), account_id: id.clone() };
                    let usage = usage.clone();
                    // Not forced: a measurement that just failed is not repeated before its backoff ends.
                    async move { usage.fetch_snapshot(&route, false).await }
                }))
                .await;
            }
            sweeps.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&provider);
        }));
    }

    /// `availableOAuthProvider`.
    pub(crate) fn oauth(&self, id: &str) -> Option<&Arc<dyn OAuthProvider>> {
        self.providers.iter().find(|p| p.id() == id && self.builder.available(id))
    }

    /// `modelProxyClientMode()`.
    pub(crate) fn model_proxy_client_mode() -> bool {
        std::env::var(MODEL_PROXY_ENV).is_ok_and(|v| v == "client")
    }

    pub fn require_local() -> Result<(), Failure> {
        if Self::model_proxy_client_mode() {
            return Err(Failure::Coded {
                code: "MODEL_CREDENTIALS_DISABLED",
                message: format!(
                    "Provider account management are not available on this server: {MODEL_PROXY_ENV}=client runs every model call on the client PC."
                ),
            });
        }
        Ok(())
    }

    /// `updateConfigProvider`: merges `entries` over `providers[id]`; a `null` removes the key.
    async fn update_provider(&self, id: &str, entries: Map<String, Value>) -> Result<(), Failure> {
        let id = id.to_owned();
        self.config
            .update_agent(move |doc| {
                let entry = object_at(object_at(doc, "providers"), &id);
                for (key, value) in entries {
                    if value.is_null() {
                        entry.shift_remove(&key);
                    } else {
                        entry.insert(key, value);
                    }
                }
                Ok(())
            })
            .await
            .map(|_| ())
            .map_err(|e| Failure::error(e.to_string()))
    }

    /// `currentProviderAccountId`. `Err` when the roster read never ran: "default" would stand for
    /// a different account, and a login, a forget or a credit redemption would act on it.
    pub(crate) async fn current_account_id(&self, provider: &str) -> Result<String, Failure> {
        if !ACCOUNT_PROVIDERS.contains(&provider) {
            return Ok("default".into());
        }
        selected_of(self.accounts.pool(provider).await).map_err(acct)
    }

    fn authenticated(auth: &Value) -> bool {
        truthy(auth.get("authenticated"))
    }

    fn status_of(auth: &Value) -> Value {
        auth.get("status").filter(|s| truthy(Some(s))).cloned().unwrap_or(Value::Null)
    }

    pub async fn authenticate_provider(&self, provider: &str, secret: &str) -> Result<Value, Failure> {
        let result = if mixdog_js::js_trim(secret).is_empty() {
            self.login_oauth_provider_inner(provider).await?
        } else {
            self.save_provider_api_key_inner(provider, secret, &Value::Null).await?
        };
        self.refresh.after_credential_change();
        Ok(result)
    }

    pub async fn login_oauth_provider(&self, provider: &str) -> Result<Value, Failure> {
        let result = self.login_oauth_provider_inner(provider).await?;
        self.refresh.after_credential_change();
        Ok(result)
    }

    async fn login_oauth_provider_inner(&self, provider: &str) -> Result<Value, Failure> {
        Self::require_local()?;
        let id = mixdog_js::js_trim(provider);
        let oauth = self.oauth(id).ok_or_else(|| Failure::error(format!("unknown OAuth provider \"{id}\"")))?;
        let account = self.current_account_id(id).await?;
        let flow = oauth
            .login_flow(&account)
            .ok_or_else(|| Failure::error(format!("{id} login did not complete")))?;
        let session = flow.start().await.map_err(|e| Failure::error(format!("{e:?}")))?;
        let done = loop {
            match session.next().await {
                Some(LoginState::Done { .. }) => break true,
                Some(LoginState::Failed(_) | LoginState::Cancelled) | None => break false,
                Some(_) => {}
            }
        };
        if !done {
            return Err(Failure::error(format!("{id} login did not complete")));
        }
        let auth = oauth.describe(&self.current_account_id(id).await?).await;
        // Only a SUCCESSFUL login states `enabled`: a failed one is not a decision to turn the
        // provider off, and disabling is `forgetProviderAuth`'s job alone.
        if Self::authenticated(&auth) {
            self.update_provider(id, patch([("enabled", json!(true))])).await?;
            if ACCOUNT_PROVIDERS.contains(&id) {
                let current = self.current_account_id(id).await?;
                self.accounts.clear_quota_state(id, &current).await.map_err(acct)?;
            }
        }
        Ok(json!({
            "provider": id,
            "type": "oauth",
            "authenticated": Self::authenticated(&auth),
            "status": Self::status_of(&auth),
        }))
    }

    /// `beginOAuthProviderLogin`: the started session and what settles it. Settling registers the
    /// account, so the callback and a pasted code deliver one sign-in once.
    pub async fn begin_oauth_provider_login(
        self: &Arc<Self>,
        provider: &str,
        options: &Value,
    ) -> Result<(Box<dyn LoginSession>, Settle), Failure> {
        Self::require_local()?;
        let id = mixdog_js::js_trim(provider).to_owned();
        let oauth = self
            .oauth(&id)
            .ok_or_else(|| Failure::error(format!("unknown OAuth provider \"{id}\"")))?
            .clone();
        let empty = json!({});
        let options = if options.is_null() { &empty } else { options };
        let supports = oauth.login_flow("default").is_some();
        if !supports {
            return Err(Failure::error(format!("{id} does not support interactive code login")));
        }
        assert_login_options(options)?;
        let id_before = self.current_account_id(&id).await?;
        let add_account = options.get("addAccount") == Some(&Value::Bool(true));
        let requested = options.get("accountId");
        if let Some(requested) = requested {
            let disconnected = add_account || {
                let listed = self.list_provider_accounts(&id).await?;
                !listed["accounts"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row.get("id") == Some(requested)))
            };
            if disconnected {
                return Err(Failure::type_error("Account is no longer connected."));
            }
        }
        let account = if add_account {
            new_account_id()
        } else if requested.is_some_and(|r| truthy(Some(r))) {
            text(requested)
        } else {
            id_before
        };
        let include_default = Self::authenticated(&oauth.describe("default").await);
        if add_account && self.accounts.pool(&id).await.map_err(acct)?.accounts.len() >= 20 {
            return Err(Failure::error("At most 20 accounts can be connected."));
        }
        let flow = oauth.login_flow(&account).ok_or_else(|| Failure::error("login flow unavailable"))?;
        let session = flow.start().await.map_err(|e| Failure::error(format!("{e:?}")))?;
        let label = options.get("label").and_then(Value::as_str).unwrap_or("").to_owned();
        let admin = self.clone();
        let settle: Settle = Box::new(move |via_code| {
            Box::pin(async move {
                let signed_in = admin
                    .settle(&oauth, &id, &account, add_account, include_default, &label)
                    .await
                    .map_err(|f| f.message().to_owned())?;
                if via_code {
                    admin.refresh.after_credential_change();
                } else {
                    admin.refresh.adopt_credentials();
                }
                Ok(signed_in)
            })
        });
        Ok((session, settle))
    }

    /// `settleOAuthLogin`: registration and the enabled flag move together, on success only.
    async fn settle(
        &self,
        oauth: &Arc<dyn OAuthProvider>,
        id: &str,
        signed_in: &str,
        add_account: bool,
        include_default: bool,
        label: &str,
    ) -> Result<bool, Failure> {
        let auth = oauth.describe(signed_in).await;
        if !Self::authenticated(&auth) {
            return Ok(false);
        }
        let mut account = signed_in.to_owned();
        // Signing the same real account in again replaces that roster entry's credentials
        // (label and order stay) instead of minting a second id.
        let existing = if add_account { self.roster_account_for_identity(oauth, id, signed_in, &auth).await? } else { None };
        if let Some(existing) = existing {
            let from = self.accounts.account_path(id, signed_in).map_err(acct)?;
            let to = self.accounts.account_path(id, &existing).map_err(acct)?;
            if let (Some(from), Some(to)) = (from, to) {
                let cancel = CancellationToken::new();
                #[allow(clippy::disallowed_methods, reason = "body of a durability-io lane job")]
                let renamed = on_lane(self.credential_io.write, &cancel, move |_lane| std::fs::rename(from, to));
                renamed.await.map_err(|e| Failure::error(e.to_string()))?.map_err(|e| Failure::error(e.to_string()))?;
            }
            account = existing;
        }
        self.accounts.register(id, &account, label, include_default).await.map_err(acct)?;
        // A re-connect can follow a re-created subscription under the same account id.
        self.accounts.clear_quota_state(id, &account).await.map_err(acct)?;
        self.update_provider(id, patch([("enabled", json!(true))])).await?;
        Ok(true)
    }

    /// The roster account (other than the implicit `default`) the fresh sign-in is the same real
    /// account as.
    async fn roster_account_for_identity(
        &self,
        oauth: &Arc<dyn OAuthProvider>,
        id: &str,
        new_account: &str,
        auth: &Value,
    ) -> Result<Option<String>, Failure> {
        let pool = self.accounts.pool(id).await.map_err(acct)?;
        let null = Value::Null;
        let identity = (auth.get("identityId").unwrap_or(&null), auth.get("email").unwrap_or(&null));
        for row in pool.accounts.iter().filter(|r| r.id != "default" && r.id != new_account) {
            let existing = oauth.describe(&row.id).await;
            let theirs = (existing.get("identityId").unwrap_or(&null), existing.get("email").unwrap_or(&null));
            if same_identity(identity, theirs) {
                return Ok(Some(row.id.clone()));
            }
        }
        Ok(None)
    }

    pub async fn list_provider_accounts(&self, provider: &str) -> Result<Value, Failure> {
        if !self.providers.iter().any(|p| p.id() == provider) {
            return Err(Failure::type_error("Unknown OAuth provider."));
        }
        // Client mode: accounts live on the desktop, so this server's roster is empty.
        if Self::model_proxy_client_mode() {
            return Ok(json!({ "provider": provider, "auto": true, "useCredits": false, "selectedId": null, "accounts": [] }));
        }
        let oauth = self.oauth(provider).ok_or_else(|| Failure::type_error("Unknown OAuth provider."))?;
        let pool = self.accounts.pool(provider).await.map_err(acct)?;
        let rows: Vec<Account> = if pool.accounts.is_empty() {
            if Self::authenticated(&oauth.describe("default").await) {
                let mut row = Account::new("default");
                row.label = Some("Account 1".into());
                vec![row]
            } else {
                Vec::new()
            }
        } else {
            pool.accounts.clone()
        };
        self.sweep_account_usage(provider, &pool.accounts, pool.selected_id.as_deref().filter(|id| !id.is_empty()).or_else(|| pool.accounts.first().map(|row| row.id.as_str())));
        let now = chrono::Utc::now().timestamp_millis();
        let use_credits = pool.uses_credits();
        let mut accounts: Vec<Value> = Vec::with_capacity(rows.len());
        for row in &rows {
            accounts.push(account_row(oauth, row, now, use_credits).await);
        }
        let selected = pool.selected_id.clone().filter(|s| !s.is_empty()).or_else(|| rows.first().map(|r| r.id.clone()));
        let mut out = Map::new();
        out.insert("provider".into(), json!(provider));
        out.insert("auto".into(), json!(pool.auto != Some(false)));
        if let Some(policy) = &pool.policy {
            out.insert("policy".into(), json!(policy));
        }
        out.insert("useCredits".into(), json!(use_credits));
        out.insert("selectedId".into(), json!(selected));
        out.insert("accounts".into(), Value::Array(accounts));
        Ok(Value::Object(out))
    }

    /// Stores the implicit signed-in `default` account in the roster, so a change or a usage
    /// measurement has a row to land on.
    async fn materialize_provider_accounts(&self, provider: &str) -> Result<Value, Failure> {
        Self::require_local()?;
        let current = self.list_provider_accounts(provider).await?;
        let stored = !self.accounts.pool(provider).await.map_err(acct)?.accounts.is_empty();
        if stored || current["accounts"].as_array().is_none_or(Vec::is_empty) {
            return Ok(current);
        }
        self.accounts.register(provider, "default", "Account 1", false).await.map_err(acct)?;
        self.list_provider_accounts(provider).await
    }

    /// Measures each account's quota now (four at a time, errors ignored).
    async fn measure_accounts(&self, provider: &str, ids: &[String], force: bool) {
        for chunk in ids.chunks(4) {
            futures::future::join_all(chunk.iter().map(|id| {
                let route = RouteInfo { provider: provider.to_owned(), model: String::new(), account_id: id.clone() };
                async move { self.oauth_usage.fetch_snapshot(&route, force).await }
            }))
            .await;
        }
    }

    pub async fn update_provider_accounts(&self, provider: &str, change: &Value) -> Result<Value, Failure> {
        // `{ refreshUsage: true }` re-measures every account now and changes nothing else.
        if change.get("refreshUsage") == Some(&Value::Bool(true)) && change.as_object().is_some_and(|c| c.len() == 1) {
            if self.registry.try_get(provider).await.map_err(|e| Failure::error(e.message))?.is_some() {
                let materialized = self.materialize_provider_accounts(provider).await?;
                let ids: Vec<String> = materialized["accounts"]
                    .as_array()
                    .map(|rows| rows.iter().filter_map(|r| r["id"].as_str().map(str::to_owned)).collect())
                    .unwrap_or_default();
                self.measure_accounts(provider, &ids, true).await;
            }
            return self.list_provider_accounts(provider).await;
        }
        self.materialize_provider_accounts(provider).await?;
        let parsed = parse_account_change(change)?;
        self.accounts.change(provider, parsed).await.map_err(acct)?;
        // Picking an account by hand is a decision to use it NOW: the refusal window and meter
        // stored against it describe the state the user just changed.
        let selected = change.get("selectedId").filter(|v| !v.is_null());
        if let Some(selected) = selected {
            self.accounts.clear_quota_state(provider, selected.as_str().unwrap_or("")).await.map_err(acct)?;
        }
        let result = self.list_provider_accounts(provider).await?;
        self.refresh.account_selection_changed();
        if selected.is_some() {
            self.refresh.release_admission_cooldowns();
            // The switch makes every later request use another credential: its quota is fetched
            // right away, not when the surface next asks.
            if let Some(id) = result["selectedId"].as_str().filter(|s| !s.is_empty()) {
                if self.registry.registered(provider).is_some() {
                    let oauth = self.oauth_usage.clone();
                    let route = RouteInfo { provider: provider.to_owned(), model: String::new(), account_id: id.to_owned() };
                    tokio::spawn(async move {
                        oauth.fetch_snapshot(&route, true).await;
                    });
                }
            }
        }
        Ok(result)
    }

    pub async fn save_provider_api_key(&self, provider: &str, secret: &str, options: &Value) -> Result<Value, Failure> {
        let result = self.save_provider_api_key_inner(provider, secret, options).await?;
        self.refresh.after_credential_change();
        Ok(result)
    }

    async fn save_provider_api_key_inner(&self, provider: &str, secret: &str, options: &Value) -> Result<Value, Failure> {
        Self::require_local()?;
        let id = mixdog_js::js_trim(provider).to_owned();
        if !API_PROVIDER_IDS.contains(&id.as_str()) {
            return Err(Failure::error(format!("unknown API-key provider \"{id}\"")));
        }
        let value = mixdog_js::js_trim(secret).to_owned();
        let auth_mode = options.get("authMode").and_then(Value::as_str);
        let adc = id == "vertex-ai" && auth_mode == Some(VERTEX_ADC_MODE);
        let express = id == "vertex-ai" && auth_mode == Some(VERTEX_API_KEY_MODE);
        if value.is_empty() && !adc {
            return Err(Failure::error(format!("API key is required for {id}")));
        }
        let mut entries = patch([("enabled", json!(true))]);
        if id == "vertex-ai" {
            if adc && !value.is_empty() {
                return Err(Failure::error("Vertex AI gcloud login takes no key"));
            }
            if express && value.chars().any(|c| mixdog_js::is_js_space(c) || c == '{') {
                return Err(Failure::error("Vertex AI express mode takes an API key, not a JSON key file"));
            }
            if !adc && !express {
                parse_service_account(&value).map_err(|e| Failure::error(e.message))?;
            }
            // Only a location the user chose is saved: an empty one is unset.
            let location_option = options.get("location");
            let location = match location_option {
                None | Some(Value::Null) => String::new(),
                Some(v) => mixdog_js::js_trim(&mixdog_js::value_to_string(v)).to_lowercase(),
            };
            let project_id = mixdog_js::js_trim(&text(options.get("projectId"))).to_owned();
            let location_valid = location.len() <= 63 && location.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !location.is_empty() && !location_valid {
                return Err(Failure::error("Vertex AI location is invalid"));
            }
            if express && !location.is_empty() && location != "global" {
                return Err(Failure::error("Vertex AI express mode serves only the global location"));
            }
            let location_patch = !location.is_empty() || express || location_option.is_some();
            let location_value = if location.is_empty() { Value::Null } else { json!(location) };
            let project_valid = (1..=128).contains(&project_id.len())
                && project_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b));
            if !project_id.is_empty() && !project_valid {
                return Err(Failure::error("Vertex AI project ID override is invalid"));
            }
            let project_value = if project_id.is_empty() { Value::Null } else { json!(project_id) };
            if adc {
                // gcloud login: nothing secret is stored, and the login must already be usable.
                let project = self.vertex_adc.login(&project_id).await.map_err(Failure::error)?;
                if project.as_deref().is_none_or(str::is_empty) {
                    return Err(Failure::error(
                        "No Google Cloud project found for the gcloud login. Enter a project ID override, or run `gcloud config set project PROJECT_ID`.",
                    ));
                }
                // The login replaces a key saved earlier rather than sitting beside it.
                let account = api_key_account(&id);
                match self.vault.get(&account).await {
                    Ok(Some(v)) if !v.is_empty() => self.vault.delete(&account).await.map_err(vault_failure)?,
                    // A read that never ran leaves the old key in place under the new login.
                    Err(error) if error.unrun => return Err(vault_failure(error)),
                    _ => {}
                }
                let mut entries = patch([("enabled", json!(true))]);
                if location_patch {
                    entries.insert("location".into(), location_value);
                }
                entries.insert("projectId".into(), project_value);
                entries.insert("authMode".into(), json!(VERTEX_ADC_MODE));
                self.update_provider(&id, entries).await?;
                return Ok(json!({ "provider": id, "type": "adc", "authenticated": true }));
            }
            entries = patch([("enabled", json!(true))]);
            if location_patch {
                entries.insert("location".into(), location_value);
            }
            entries.insert("projectId".into(), project_value);
            entries.insert("authMode".into(), json!(if express { VERTEX_API_KEY_MODE } else { "service-account" }));
        }
        self.vault.set(&api_key_account(&id), &value).await.map_err(vault_failure)?;
        self.update_provider(&id, entries).await?;
        let kind = if id == "vertex-ai" && !express { "service-account" } else { "api-key" };
        Ok(json!({ "provider": id, "type": kind, "authenticated": true }))
    }

    pub async fn save_openai_usage_session_key(&self, secret: &str) -> Result<Value, Failure> {
        Self::require_local()?;
        let value = mixdog_js::js_trim(secret);
        if value.is_empty() {
            return Err(Failure::error("OpenAI usage session key is required for credit lookup"));
        }
        self.vault.set(OPENAI_USAGE_SESSION_KEY_ACCOUNT, value).await.map_err(vault_failure)?;
        self.update_provider("openai", patch([("enabled", json!(true))])).await?;
        self.refresh.after_usage_auth_change();
        Ok(json!({ "provider": "openai", "type": "usage-auth", "authenticated": true }))
    }

    /// `account/refreshProviderSetup` with `renewCredential`: the host preflight's forced refresh of the provider's
    /// current account token (`preflightAnthropicOAuthCredentials`). The new expiry reaches the caller through the
    /// `providerSetup` section.
    pub async fn renew_provider_credential(&self, provider: &str, minimum_validity_ms: u64) -> Result<(), Failure> {
        Self::require_local()?;
        let id = mixdog_js::js_trim(provider).to_owned();
        let Some(oauth) = self.oauth(&id) else { return Err(Failure::type_error(format!("Unknown OAuth provider: {id}"))) };
        let account = self.current_account_id(&id).await?;
        oauth.renew(&account, minimum_validity_ms).await.map_err(Failure::error)?;
        self.refresh.after_credential_change();
        Ok(())
    }

    pub async fn forget_provider_auth(&self, provider: &str, requested: Option<&str>) -> Result<Value, Failure> {
        let result = self.forget_inner(provider, requested).await?;
        self.refresh.after_credential_change();
        Ok(result)
    }

    async fn forget_inner(&self, provider: &str, requested: Option<&str>) -> Result<Value, Failure> {
        Self::require_local()?;
        let id = mixdog_js::js_trim(provider).to_owned();
        if let Some(oauth) = self.oauth(&id) {
            let account = match requested {
                Some(requested) => requested.to_owned(),
                None => self.current_account_id(&id).await?,
            };
            if requested.is_some() {
                let listed = self.list_provider_accounts(&id).await?;
                let connected = listed["accounts"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["id"].as_str() == Some(account.as_str())));
                if !connected {
                    return Err(Failure::type_error("Account is no longer connected."));
                }
            }
            let result = oauth.forget(&account).await.map_err(Failure::error)?;
            let pool = self.accounts.remove(&id, &account).await.map_err(acct)?;
            self.update_provider(&id, patch([("enabled", json!(!pool.accounts.is_empty()))])).await?;
            return Ok(json!({
                "provider": id,
                "type": "oauth",
                "forgotten": true,
                "removed": truthy(result.get("removed")),
            }));
        }
        if !API_PROVIDER_IDS.contains(&id.as_str()) {
            return Err(Failure::error(format!("unknown provider \"{id}\"")));
        }
        self.vault.delete(&api_key_account(&id)).await.map_err(vault_failure)?;
        self.update_provider(&id, patch([("enabled", json!(false))])).await?;
        Ok(json!({ "provider": id, "type": "api-key", "forgotten": true }))
    }

    /// `checkCustomProviderKeyEnv`: whether the named environment variable is set non-empty.
    pub fn check_custom_provider_key_env(name: &str) -> Result<Value, Failure> {
        let mut chars = name.chars();
        let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
            && name.len() <= 128;
        if !valid {
            return Err(Failure::type_error("environment variable name is invalid"));
        }
        Ok(json!({ "found": mixdog_ai::registry::keys::process_key_var_os(name).is_some_and(|v| !v.is_empty()) }))
    }

    /// `consumeCodexRateLimitResetCredit`: the server decides the outcome; the dashboard rebuild
    /// after it is a courtesy within a budget.
    pub async fn consume_codex_reset_credit(
        &self,
        options: &Value,
        dashboards: &super::dashboards::Dashboards,
        sources: &dyn super::usage::dashboard::UsageSources,
    ) -> Result<Value, Failure> {
        if self.registry.try_get("openai-oauth").await.map_err(|e| Failure::error(e.message))?.is_none() {
            return Err(Failure::error("Codex is not signed in"));
        }
        let account = self.current_account_id("openai-oauth").await?;
        let result = self
            .oauth_usage
            .consume_codex_reset_credit(&account, &clean(options.get("expectedOfferRevision")), &clean(options.get("idempotencyKey")))
            .await
            .map_err(|e| Failure::error(e.message))?;
        let mut out = Map::new();
        out.insert("outcome".into(), json!(result.outcome));
        out.insert("resetCredits".into(), result.reset_credits.unwrap_or(Value::Null));
        let budget = std::time::Duration::from_millis(15_000);
        if let Ok(Some(dashboard)) = mixdog_rt::time::timeout(budget, dashboards.after_redeem(sources, &self.accounts)).await {
            out.insert("dashboard".into(), dashboard);
        }
        Ok(Value::Object(out))
    }
}

/// The selected account of a roster read: "default" when none is selected, or when the roster could
/// be read and is unusable (Node); an `Err` only when the read never ran.
pub(crate) fn selected_of(pool: Result<mixdog_ai::accounts::Pool, AccountError>) -> Result<String, AccountError> {
    match pool {
        Ok(pool) => Ok(pool.selected_id.filter(|id| !id.is_empty()).unwrap_or_else(|| "default".into())),
        Err(error) if error.unrun() => Err(error),
        Err(_) => Ok("default".into()),
    }
}

/// One roster row of `listProviderAccounts`.
async fn account_row(oauth: &Arc<dyn OAuthProvider>, row: &Account, now: i64, use_credits: bool) -> Value {
    let auth = oauth.describe(&row.id).await;
    let field = |key: &str| auth.get(key).and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or("").to_owned();
    let (email, account_id, org) = (field("email"), field("accountId"), field("orgName"));
    let mut identity = if !email.is_empty() {
        Some(email.clone())
    } else if !account_id.is_empty() {
        Some(account_id)
    } else {
        None
    };
    if !org.is_empty() {
        identity = Some(identity.map_or(org.clone(), |i| format!("{i} · {org}")));
    }
    let limit = account_limit(row, now, use_credits).map_or(Value::Null, |limit| match limit {
        Limit::Account => json!({ "scope": "account" }),
        Limit::Model(families) => json!({ "scope": "model", "families": families }),
    });
    let mut out = Map::new();
    out.insert("id".into(), json!(row.id));
    out.insert("label".into(), json!(row.label));
    out.insert("authenticated".into(), json!(auth.get("authenticated") == Some(&Value::Bool(true))));
    out.insert("reauthRequired".into(), json!(auth.get("reauthRequired") == Some(&Value::Bool(true))));
    out.insert("usage".into(), row.usage.as_ref().map_or(Value::Null, |u| serde_json::to_value(u).unwrap_or(Value::Null)));
    out.insert("blockedUntil".into(), account_blocked_until(row, "").filter(|t| *t != 0).map_or(Value::Null, |t| json!(t)));
    out.insert("limit".into(), limit);
    if let Some(identity) = identity {
        out.insert("identity".into(), json!(identity));
    }
    if !email.is_empty() {
        out.insert("email".into(), json!(email));
    }
    Value::Object(out)
}

/// `assertOAuthLoginOptions`.
pub(crate) fn assert_login_options(options: &Value) -> Result<(), Failure> {
    let bad = || Failure::type_error("Invalid OAuth account login options.");
    let Some(map) = options.as_object() else { return Err(bad()) };
    if map.keys().any(|k| !["addAccount", "label", "accountId", "openBrowser"].contains(&k.as_str())) {
        return Err(bad());
    }
    if map.get("addAccount").is_some_and(|v| !v.is_boolean()) || map.get("openBrowser").is_some_and(|v| !v.is_boolean()) {
        return Err(bad());
    }
    if map.get("label").is_some_and(|v| v.as_str().is_none_or(|s| mixdog_js::utf16_len(s) > 80)) {
        return Err(bad());
    }
    Ok(())
}

/// `changeProviderAccounts`' argument checks, in Node's order and words.
pub(crate) fn parse_account_change(change: &Value) -> Result<AccountChange, Failure> {
    let type_error = |m: &str| Failure::type_error(m);
    let Some(map) = change.as_object() else { return Err(type_error("Invalid provider account change.")) };
    if map.keys().any(|k| !["selectedId", "order", "auto", "policy", "useCredits", "rename"].contains(&k.as_str())) {
        return Err(type_error("Invalid provider account change."));
    }
    let mut out = AccountChange::default();
    if let Some(rename) = map.get("rename") {
        let label = rename.get("label").and_then(Value::as_str);
        let Some(label) = label.filter(|l| !mixdog_js::js_trim(l).is_empty() && mixdog_js::utf16_len(l) <= 80) else {
            return Err(type_error("Invalid account name."));
        };
        let id = rename.get("id").and_then(Value::as_str).unwrap_or("\u{0}");
        out.rename = Some((id.to_owned(), label.to_owned()));
    }
    if let Some(selected) = map.get("selectedId") {
        out.selected_id = Some(selected.as_str().unwrap_or("").to_owned());
    }
    if let Some(order) = map.get("order") {
        let Some(list) = order.as_array() else {
            return Err(type_error("Account order must contain every connected account exactly once."));
        };
        out.order = Some(list.iter().map(|v| v.as_str().unwrap_or("\u{0}").to_owned()).collect());
    }
    if let Some(auto) = map.get("auto") {
        out.auto = Some(auto.as_bool().ok_or_else(|| type_error("Automatic account switching must be boolean."))?);
    }
    if let Some(policy) = map.get("policy") {
        out.policy = Some(
            policy.as_str().and_then(Policy::parse).ok_or_else(|| type_error("Unknown account switching policy."))?,
        );
    }
    if let Some(credits) = map.get("useCredits") {
        out.use_credits = Some(credits.as_bool().ok_or_else(|| type_error("Credit use must be boolean."))?);
    }
    Ok(out)
}

#[cfg(test)]
mod sweep_tests {
    use mixdog_ai::accounts::Usage;

    use super::*;

    fn measured(id: &str, checked_at: i64) -> Account {
        let mut row = Account::new(id);
        row.usage = Some(Usage { windows: Vec::new(), checked_at });
        row
    }

    #[test]
    fn a_roster_read_measures_the_accounts_whose_reading_is_due() {
        let now = 1_800_000_000_000;
        let rows = [
            Account::new("never-measured"),
            measured("a-minute-ago", now - 60_000),
            measured("ten-minutes-ago", now - 10 * 60_000),
            measured("a-day-ago", now - 24 * 3_600_000),
        ];
        assert_eq!(sweep_due(&rows, None, now), ["never-measured", "ten-minutes-ago", "a-day-ago"]);
        // The account in use is the dashboard's to measure; a roster of that one account is asked nothing.
        assert_eq!(sweep_due(&rows, Some("a-day-ago"), now), ["never-measured", "ten-minutes-ago"]);
        assert!(sweep_due(&rows[3..], Some("a-day-ago"), now).is_empty());
    }

    #[test]
    fn each_account_is_due_at_its_own_age_within_a_quarter_of_five_minutes() {
        let ids: Vec<String> = (0..200).map(|n| format!("account-{n}")).collect();
        let ttls: Vec<i64> = ids.iter().map(|id| sweep_ttl_ms(id)).collect();
        assert!(ttls.iter().all(|ttl| (225_000..=375_000).contains(ttl)), "{ttls:?}");
        assert!(ttls.iter().max().unwrap() - ttls.iter().min().unwrap() > 60_000, "the accounts are spread");
        assert_eq!(sweep_ttl_ms("account-7"), sweep_ttl_ms("account-7"), "an account keeps its age");
    }
}
