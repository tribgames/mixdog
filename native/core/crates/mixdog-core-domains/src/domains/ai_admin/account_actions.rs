//! The provider-account setup actions (`executor.mjs` `forget_provider_auth` and
//! `set_provider_account`): the setup tool's own checks and receipts over the provider
//! admin (`ai_account`). The admin's forget and roster change are the runtime facade's
//! `forgetProviderAuth` / `updateProviderAccounts`; what the executor asks of the facade, and in
//! which order, is [`AccountOps`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::{Obj, clean, truthy};
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_ports::ports::setup_actions::{SetupActions, SetupCall};
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use crate::domains::ai_account::admin::ProviderAdmin;

/// What `rt.getProviderSetup({})` tells these actions: whether the desktop manages the accounts
/// (`managedByClient`) and the ids of the OAuth providers the setup lists.
pub struct ProviderRows {
    pub managed_by_client: bool,
    pub oauth: Vec<String>,
}

/// The four provider calls of the runtime facade the executor makes, errors as their message.
#[async_trait]
pub trait AccountOps: Send + Sync {
    async fn setup(&self) -> ProviderRows;
    /// `getProviderAccounts(id)`: the roster (`listProviderAccounts`).
    async fn accounts(&self, id: &str) -> Result<Value, String>;
    /// `forgetProviderAuth(id, accountId?)`.
    async fn forget(&self, id: &str, account: Option<&str>) -> Result<Value, String>;
    /// `updateProviderAccounts(id, change)`: the roster after the change.
    async fn update(&self, id: &str, change: &Value) -> Result<Value, String>;
}

#[async_trait]
impl AccountOps for ProviderAdmin {
    async fn setup(&self) -> ProviderRows {
        // Client mode: the desktop owns the accounts and the server lists none.
        if Self::model_proxy_client_mode() {
            return ProviderRows { managed_by_client: true, oauth: Vec::new() };
        }
        let oauth = self.providers.iter().map(|p| p.id()).filter(|id| self.oauth(id).is_some()).map(str::to_owned).collect();
        ProviderRows { managed_by_client: false, oauth }
    }

    async fn accounts(&self, id: &str) -> Result<Value, String> {
        self.list_provider_accounts(id).await.map_err(|failure| failure.message().to_owned())
    }

    async fn forget(&self, id: &str, account: Option<&str>) -> Result<Value, String> {
        self.forget_provider_auth(id, account).await.map_err(|failure| failure.message().to_owned())
    }

    async fn update(&self, id: &str, change: &Value) -> Result<Value, String> {
        self.update_provider_accounts(id, change).await.map_err(|failure| failure.message().to_owned())
    }
}

pub struct AccountActions {
    ops: Arc<dyn AccountOps>,
    /// The `setup` tool's input schema: the executor validates every call against it first
    /// (`validateSetupInput`), the same one `RouteActions` is given.
    schema: Value,
}

const ACTIONS: [&str; 2] = ["forget_provider_auth", "set_provider_account"];
const MANAGED: &str = "Manage provider accounts in the local desktop window.";

fn fail(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "account".into(), message: message.into() }
}

fn require_text(args: &Value, field: &str) -> Result<String, PortError> {
    let text = clean(args.get(field));
    if text.is_empty() { Err(fail(format!("{field} is required"))) } else { Ok(text) }
}

/// `publicAccounts`: the roster without its usage, limits and identities. A field the roster
/// leaves out (`undefined`, which `JSON.stringify` drops) is left out here.
fn public_accounts(pool: &Value) -> Value {
    let mut out = Obj::new();
    for key in ["selectedId", "auto"] {
        if let Some(value) = pool.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if truthy(pool.get("policy")) {
        out.insert("policy".into(), pool["policy"].clone());
    }
    out.insert("useCredits".into(), json!(pool.get("useCredits") == Some(&Value::Bool(true))));
    let rows = pool.get("accounts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let rows = rows.iter().map(|row| {
        let mut account = Obj::new();
        for key in ["id", "label", "authenticated", "reauthRequired"] {
            match row.get(key) {
                None => {}
                // A roster row without a label has none.
                Some(Value::Null) if key == "label" => {}
                Some(value) => {
                    account.insert(key.into(), value.clone());
                }
            }
        }
        Value::Object(account)
    });
    out.insert("accounts".into(), Value::Array(rows.collect()));
    Value::Object(out)
}

impl AccountActions {
    pub fn new(ops: Arc<dyn AccountOps>, schema: Value) -> Self {
        Self { ops, schema }
    }

    pub fn over(admin: Arc<ProviderAdmin>, schema: Value) -> Self {
        Self::new(admin, schema)
    }

    async fn forget_provider_auth(&self, args: &Value) -> Result<Value, PortError> {
        let name = require_text(args, "name")?;
        let setup = self.ops.setup().await;
        if setup.managed_by_client {
            return Err(fail(MANAGED));
        }
        if !setup.oauth.contains(&name) {
            if args.get("accountId").is_some() {
                return Err(fail("accountId applies only to OAuth providers"));
            }
            return self.ops.forget(&name, None).await.map_err(fail);
        }
        let pool = self.ops.accounts(&name).await.map_err(fail)?;
        let rows = pool.get("accounts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        if rows.is_empty() {
            return Err(fail(format!("{name} has no connected account")));
        }
        let given = args.get("accountId").is_some();
        if !given && rows.len() > 1 {
            return Err(fail(format!("{name} has {} accounts; pass accountId from status providers", rows.len())));
        }
        let account = if given { require_text(args, "accountId")? } else { clean(rows[0].get("id")) };
        let mut out = self.ops.forget(&name, Some(&account)).await.map_err(fail)?.as_object().cloned().unwrap_or_default();
        out.insert("accountId".into(), json!(account));
        Ok(Value::Object(out))
    }

    async fn set_provider_account(&self, args: &Value) -> Result<Value, PortError> {
        if self.ops.setup().await.managed_by_client {
            return Err(fail(MANAGED));
        }
        let name = require_text(args, "name")?;
        let pool = self.ops.update(&name, args.get("providerAccount").unwrap_or(&Value::Null)).await.map_err(fail)?;
        Ok(public_accounts(&pool))
    }
}

#[async_trait]
impl SetupActions for AccountActions {
    fn actions(&self) -> &'static [&'static str] {
        &ACTIONS
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let args = call.args;
        // The executor validates every call first: field lists, types and the account change's
        // own shape are refused with the schema's text.
        mixdog_tools::orch::setup_input::validate(args, &self.schema).map_err(|error| PortError::Invalid {
            field: "setup".into(),
            reason: match error.code {
                ToolErrorCode::InvalidArgs { reason, .. } => reason,
                _ => error.message_for_model,
            },
        })?;
        match call.action {
            "forget_provider_auth" => self.forget_provider_auth(args).await,
            "set_provider_account" => self.set_provider_account(args).await,
            other => Err(PortError::Unavailable { capability: format!("setup.{other}"), message: format!("setup {other} is not an account action") }),
        }
    }
}
