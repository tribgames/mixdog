//! The setup tool's `status providers` answer (`setup-tool/executor.mjs` `SETUP_STATUS_READERS.providers`
//! with `publicProviderRows`, `configuredProviderRows` and `publicAccounts`) over the provider
//! setup snapshot, the account roster and the quota auto-resume switch, and the roster read
//! itself ([`ProviderRoster`], Node's `listProviderAccounts`) that `set_media_default` checks an
//! account id against. The `StatusReader` registration is a thin adapter in `mixdog-core`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::{Obj, truthy};
use mixdog_core_config::config::Config;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::account_actions::public_accounts;
use crate::domains::ai_account::admin::ProviderAdmin;
use crate::domains::ai_account::collaborators::ProviderSetup;

/// `getProviderAccounts(id)`: the roster of an OAuth provider, errors as their message.
#[async_trait]
pub trait ProviderRoster: Send + Sync {
    async fn accounts(&self, id: &str) -> Result<Value, String>;
}

#[async_trait]
impl ProviderRoster for ProviderAdmin {
    async fn accounts(&self, id: &str) -> Result<Value, String> {
        self.list_provider_accounts(id).await.map_err(|failure| failure.message().to_owned())
    }
}

/// `getQuotaAutoResume()`: the global switch (the config's `quotaResume.autoResume !== false`).
pub trait QuotaAutoResumeSetting: Send + Sync {
    fn enabled(&self) -> bool;
}

/// The switch is the config's top-level `quotaResume.autoResume`, on unless it is `false`: read at every
/// call, so a settings change shows at once.
impl QuotaAutoResumeSetting for Config {
    fn enabled(&self) -> bool {
        self.agent().get("quotaResume").and_then(|section| section.get("autoResume")) != Some(&Value::Bool(false))
    }
}

pub struct ProvidersStatus {
    setup: Arc<dyn ProviderSetup>,
    roster: Arc<dyn ProviderRoster>,
    quota: Arc<dyn QuotaAutoResumeSetting>,
}

fn fail(message: &str) -> PortError {
    PortError::Failed { capability: "account".into(), message: message.to_owned() }
}

fn is_true(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

/// `value || null`.
fn or_null(value: Option<&Value>) -> Value {
    value.filter(|v| truthy(Some(*v))).cloned().unwrap_or(Value::Null)
}

/// `${value}` of a field that may be absent.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(v) => mixdog_js::value_to_string(v),
    }
}

/// `apiKeySource`.
fn api_key_source(row: &Value) -> String {
    if truthy(row.get("env")) {
        format!("env:{}", js_text(row.get("envName")))
    } else if truthy(row.get("stored")) {
        "keychain".into()
    } else {
        "none".into()
    }
}

/// The `pick` of `publicProviderRows`: a field the row leaves out stays out.
fn pick(row: &Value, extra: Vec<(&str, Value)>) -> Value {
    let mut out = Obj::new();
    for key in ["id", "name", "type"] {
        if let Some(value) = row.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    out.insert("enabled".into(), json!(is_true(row.get("enabled"))));
    out.insert("authenticated".into(), json!(is_true(row.get("authenticated"))));
    out.insert("status".into(), row.get("status").filter(|v| truthy(Some(*v))).cloned().unwrap_or_else(|| json!("")));
    for (key, value) in extra {
        out.insert(key.into(), value);
    }
    Value::Object(out)
}

fn rows_of<'a>(setup: &'a Value, group: &str) -> &'a [Value] {
    setup.get(group).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
}

/// `publicProviderRows`.
fn public_provider_rows(setup: &Value) -> Obj {
    let mut out = Obj::new();
    if is_true(setup.get("managedByClient")) {
        out.insert("managedByClient".into(), json!(true));
        out.insert("unavailable".into(), json!(is_true(setup.get("unavailable"))));
    }
    out.insert("pendingSecrets".into(), json!(is_true(setup.get("pendingSecrets"))));
    let api = rows_of(setup, "api").iter().map(|row| {
        let key_url = match row.get("url") {
            Some(Value::String(url)) if url.starts_with("https://") => row["url"].clone(),
            _ => Value::Null,
        };
        pick(row, vec![("source", json!(api_key_source(row))), ("custom", json!(is_true(row.get("custom")))), ("keyUrl", key_url)])
    });
    out.insert("api".into(), Value::Array(api.collect()));
    let oauth = rows_of(setup, "oauth").iter().map(|row| {
        pick(
            row,
            vec![
                ("reauthRequired", json!(is_true(row.get("reauthRequired")))),
                ("expiresAt", or_null(row.get("expiresAt"))),
                ("plan", or_null(row.get("plan"))),
            ],
        )
    });
    out.insert("oauth".into(), Value::Array(oauth.collect()));
    let local = rows_of(setup, "local").iter().map(|row| {
        let base = [row.get("baseURL"), row.get("defaultURL")].into_iter().flatten().find(|v| truthy(Some(*v)));
        pick(row, vec![("detected", json!(is_true(row.get("detected")))), ("baseURL", base.cloned().unwrap_or_else(|| json!("")))])
    });
    out.insert("local".into(), Value::Array(local.collect()));
    out
}

impl ProvidersStatus {
    pub fn new(setup: Arc<dyn ProviderSetup>, roster: Arc<dyn ProviderRoster>, quota: Arc<dyn QuotaAutoResumeSetting>) -> Self {
        Self { setup, roster, quota }
    }

    async fn roster_of(&self, row: &Value) -> Result<Value, PortError> {
        self.roster.accounts(row.get("id").and_then(Value::as_str).unwrap_or("")).await.map_err(|message| fail(&message))
    }

    /// `configuredProviderRows`: only providers with a credential (or needing re-authentication),
    /// with account counts when `counts` (the desktop-owned accounts report none).
    async fn configured(&self, rows: &Obj, counts: bool) -> Result<Obj, PortError> {
        let mut providers = Vec::new();
        let mut not_configured = 0;
        for kind in ["api", "oauth", "local"] {
            for row in rows[kind].as_array().map(Vec::as_slice).unwrap_or_default() {
                let authenticated = is_true(row.get("authenticated"));
                let reauth = is_true(row.get("reauthRequired"));
                if !authenticated && !reauth {
                    not_configured += 1;
                    continue;
                }
                let mut entry = Obj::new();
                if let Some(id) = row.get("id") {
                    entry.insert("id".into(), id.clone());
                }
                entry.insert("kind".into(), json!(kind));
                entry.insert("authenticated".into(), json!(authenticated));
                entry.insert("status".into(), row["status"].clone());
                if kind == "oauth" {
                    entry.insert("plan".into(), or_null(row.get("plan")));
                }
                if reauth {
                    entry.insert("reauthRequired".into(), json!(true));
                }
                if kind == "oauth" && counts {
                    let count = if authenticated {
                        self.roster_of(row).await?["accounts"].as_array().map_or(0, Vec::len)
                    } else {
                        0
                    };
                    entry.insert("accounts".into(), json!(count));
                }
                providers.push(Value::Object(entry));
            }
        }
        let mut out = Obj::new();
        if is_true(rows.get("pendingSecrets")) {
            out.insert("pendingSecrets".into(), json!(true));
        }
        out.insert("providers".into(), Value::Array(providers));
        out.insert("notConfigured".into(), json!(not_configured));
        Ok(out)
    }

    /// The reader's object for `detail` (without the `domain` key).
    pub async fn read(&self, detail: bool) -> Result<Value, PortError> {
        let setup = self.setup.get(false, false, false, false).await.map_err(|failure| fail(failure.message()))?;
        let mut rows = public_provider_rows(&setup);
        let quota = self.quota.enabled();
        let with_quota = |mut out: Obj| {
            out.insert("quotaAutoResume".into(), json!(quota));
            Value::Object(out)
        };
        // Client mode: the desktop owns accounts, so the server roster is never read.
        if is_true(rows.get("managedByClient")) {
            if detail {
                return Ok(with_quota(rows));
            }
            let mut out = Obj::new();
            out.insert("managedByClient".into(), json!(true));
            out.insert("unavailable".into(), rows["unavailable"].clone());
            out.extend(self.configured(&rows, false).await?);
            return Ok(with_quota(out));
        }
        if !detail {
            return Ok(with_quota(self.configured(&rows, true).await?));
        }
        rows.insert("quotaAutoResume".into(), json!(quota));
        let mut oauth = Vec::new();
        for row in rows["oauth"].as_array().map(Vec::as_slice).unwrap_or_default() {
            let mut row = row.clone();
            if is_true(row.get("authenticated")) {
                let pool = self.roster_of(&row).await?;
                row["accounts"] = public_accounts(&pool);
            }
            oauth.push(row);
        }
        rows.insert("oauth".into(), Value::Array(oauth));
        Ok(Value::Object(rows))
    }
}
