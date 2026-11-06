//! The account a connector tool call acts as (Node `connector-accounts-mcp.mjs` `choose` and
//! `client.mjs` `resolveMcpToolAccount`).
//!
//! A catalog connector is one MCP server holding several accounts. The account a call uses is
//! the one it names; else the one last used in its conversation, else the connector's
//! last-used account, else the topmost one. A named or remembered account that is switched
//! off, removed or needs a sign-in fails the call with the usable accounts listed; no other
//! account stands in for it. A remembered account is bound to its identity (`id`), not its
//! name.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::connectors;

const IN_USE_FILE: &str = "connector-accounts-in-use.json";
const CONVERSATION_FILE: &str = "connector-accounts-by-conversation.json";

/// Why an account could not be chosen. Both read as the message the model sees.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AccountError {
    /// The call named, or last used, an account that cannot be used; the usable ones are listed.
    #[error("{0}")]
    Refused(String),
    /// The remembered choice could not be read.
    #[error("{0}")]
    State(String),
}

/// The account a call is bound to: `name` is unique and binds the call; `label` is what it is
/// shown as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chosen {
    pub name: String,
    pub label: String,
}

/// What the last connect or call of an account found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Health {
    pub email: String,
    pub error: String,
    pub auth_required: bool,
}

/// Account name → [`Health`]. Account names share the server-name space, so one registry
/// serves every connector.
#[derive(Default)]
pub struct AccountHealth(Mutex<HashMap<String, Health>>);

impl AccountHealth {
    pub fn get(&self, name: &str) -> Option<Health> {
        self.lock().get(name).cloned()
    }

    pub fn forget(&self, name: &str) {
        self.lock().remove(name);
    }

    fn set(&self, name: &str, health: Health) {
        self.lock().insert(name.to_owned(), health);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Health>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A stored account as the connector server holds it.
#[derive(Debug, Clone)]
pub struct AccountSeed {
    pub name: String,
    /// The random identity stored with the account; empty while it has none.
    pub id: String,
    pub email: String,
}

/// What a connect or call found, for [`ConnectorAccounts::record`].
#[derive(Debug, Clone, Default)]
pub struct AccountReport {
    pub email: Option<String>,
    pub error: String,
    pub auth_required: bool,
}

/// One tool call's inputs to the choice.
#[derive(Debug, Clone, Copy)]
pub struct ChooseCall<'a> {
    /// The server's own name of the tool.
    pub tool: &'a str,
    /// `args.account`, when it is a string.
    pub wanted: Option<&'a str>,
    /// The conversation (session id) the call is made in, trimmed; empty for none.
    pub conversation: &'a str,
}

#[derive(Default)]
struct Inner {
    emails: Vec<String>,
    /// Account name → the names of the tools it lists (set once it answered).
    tools_of: HashMap<String, HashSet<String>>,
    /// The tools the accounts list in union.
    listed: HashSet<String>,
}

pub struct ConnectorAccounts {
    connector: String,
    service: String,
    accounts: Vec<AccountSeed>,
    inner: Mutex<Inner>,
    health: Arc<AccountHealth>,
    data_dir: PathBuf,
    maintenance: MaintenanceIo,
}

#[derive(Clone, PartialEq, Debug)]
struct Remembered {
    name: String,
    id: String,
}

/// `same(a, b)`: both non-empty-left and equal ignoring case.
fn same(a: &str, b: &str) -> bool {
    !a.is_empty() && a.to_lowercase() == b.to_lowercase()
}

impl ConnectorAccounts {
    /// The accounts of connector `connector`, topmost first. `None` when it has none: a
    /// connector server exists only with an account. `data_dir` is the plugin data directory
    /// holding the remembered choices.
    pub fn new(
        connector: &str,
        accounts: Vec<AccountSeed>,
        health: Arc<AccountHealth>,
        data_dir: PathBuf,
        maintenance: MaintenanceIo,
    ) -> Option<Arc<Self>> {
        if accounts.is_empty() {
            return None;
        }
        let service = connectors::connector(connector).map_or(connector, |c| c.name).to_owned();
        let emails = accounts.iter().map(|a| a.email.clone()).collect();
        Some(Arc::new(Self {
            connector: connector.to_owned(),
            service,
            accounts,
            inner: Mutex::new(Inner { emails, ..Inner::default() }),
            health,
            data_dir,
            maintenance,
        }))
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records what the last connect or call of account `name` found: its address (when it
    /// told one) and its health.
    pub fn record(&self, name: &str, report: &AccountReport) {
        let Some(at) = self.accounts.iter().position(|a| a.name == name) else { return };
        let email = {
            let mut inner = self.inner();
            if let Some(email) = report.email.as_deref().filter(|e| !e.is_empty()) {
                inner.emails[at] = email.to_owned();
            }
            inner.emails[at].clone()
        };
        self.health.set(name, Health { email, error: report.error.clone(), auth_required: report.auth_required });
    }

    /// The tools account `name` listed when it answered.
    pub fn note_tools(&self, name: &str, tools: impl IntoIterator<Item = String>) {
        self.inner().tools_of.insert(name.to_owned(), tools.into_iter().collect());
    }

    /// The union of the tools the accounts list (what the connector server publishes).
    pub fn set_listed(&self, tools: impl IntoIterator<Item = String>) {
        self.inner().listed = tools.into_iter().collect();
    }

    /// What an account is called to the model: its address, with its name when another
    /// account shares that address.
    fn label_of(&self, emails: &[String], at: usize) -> String {
        let email = &emails[at];
        if email.is_empty() {
            return self.accounts[at].name.clone();
        }
        let shared = emails.iter().enumerate().any(|(other, e)| other != at && same(e, email));
        if shared { format!("{email} ({})", self.accounts[at].name) } else { email.clone() }
    }

    fn usable(&self, at: usize) -> bool {
        self.health.get(&self.accounts[at].name).is_none_or(|h| !h.auth_required)
    }

    fn refuse(&self, emails: &[String], why: &str) -> AccountError {
        let list = (0..self.accounts.len()).filter(|at| self.usable(*at)).map(|at| self.label_of(emails, at)).collect::<Vec<_>>().join(", ");
        let list = if list.is_empty() { "none" } else { &list };
        AccountError::Refused(format!("{why} Usable {} accounts: {list}. Pass one as `account`.", self.service))
    }

    /// The account `call` uses; the refusal otherwise.
    pub async fn choose(&self, call: &ChooseCall<'_>) -> Result<Chosen, AccountError> {
        let named = call.wanted.map_or("", js_trim);
        let remembered = if named.is_empty() { self.remembered(call.conversation).await? } else { None };
        self.pick(call.tool, named, remembered)
    }

    fn pick(&self, tool: &str, named: &str, remembered: Option<Remembered>) -> Result<Chosen, AccountError> {
        let emails = self.inner().emails.clone();
        let service = &self.service;
        let refuse = |why: &str| self.refuse(&emails, why);
        let at = if !named.is_empty() {
            // Its unique name, else the one account its address or label is.
            let mut matches: Vec<usize> = (0..self.accounts.len()).filter(|i| same(&self.accounts[*i].name, named)).collect();
            if matches.is_empty() {
                matches = (0..self.accounts.len()).filter(|i| same(&emails[*i], named) || same(&self.label_of(&emails, *i), named)).collect();
            }
            if matches.is_empty() {
                return Err(refuse(&format!("No connected {service} account is \"{named}\".")));
            }
            if matches.len() > 1 {
                let names = matches.iter().map(|i| self.accounts[*i].name.as_str()).collect::<Vec<_>>().join(", ");
                return Err(refuse(&format!("\"{named}\" is more than one {service} account ({names}); name one.")));
            }
            matches[0]
        } else if let Some(remembered) = remembered {
            let found = self.accounts.iter().position(|a| a.name == remembered.name);
            // The name must still be the account it named: one removed and its name given to a
            // new account, or a record without an identity, fails closed until an account is
            // picked again.
            match found {
                Some(_) if remembered.id.is_empty() => {
                    return Err(refuse(&format!("The {service} account used last ({}) cannot be confirmed as the same account.", remembered.name)));
                }
                Some(at) if self.accounts[at].id != remembered.id => {
                    return Err(refuse(&format!("The {service} account used last ({} (removed)) is not connected now.", remembered.name)));
                }
                Some(at) => at,
                None => return Err(refuse(&format!("The {service} account used last ({}) is not connected now.", remembered.name))),
            }
        } else {
            0
        };
        if !self.usable(at) {
            return Err(refuse(&format!("{} needs a sign-in in Connectors.", self.label_of(&emails, at))));
        }
        {
            let inner = self.inner();
            if inner.tools_of.get(&self.accounts[at].name).is_some_and(|has| !has.contains(tool)) && inner.listed.contains(tool) {
                return Err(refuse(&format!("{} has no {tool} tool.", self.label_of(&emails, at))));
            }
        }
        Ok(Chosen { name: self.accounts[at].name.clone(), label: self.label_of(&emails, at) })
    }

    /// The account `conversation` used last on this connector, else the one the connector used
    /// last. Read together, so the conversation's own choice short-circuits the shared one.
    async fn remembered(&self, conversation: &str) -> Result<Option<Remembered>, AccountError> {
        let (dir, connector, conversation) = (self.data_dir.clone(), self.connector.clone(), conversation.to_owned());
        let cancel = CancellationToken::new();
        let job = move |lane: &InLane<MaintenanceIo>| -> std::io::Result<Option<Remembered>> {
            if !conversation.is_empty() {
                let all = read_state(lane, &dir.join(CONVERSATION_FILE))?;
                if let Some(found) = conversation_account(&all, &conversation, &connector) {
                    return Ok(Some(found));
                }
            }
            Ok(in_use_record(&read_state(lane, &dir.join(IN_USE_FILE))?, &connector))
        };
        let handle = self.maintenance.submit_wait(&cancel, job).await.map_err(|e| AccountError::State(e.to_string()))?;
        handle.await.map_err(|e| AccountError::State(e.to_string()))?.map_err(|e| AccountError::State(e.to_string()))
    }
}

fn account_of(value: &Value) -> Option<Remembered> {
    let record = value.as_object()?;
    let name = record.get("name")?.as_str().filter(|n| !n.is_empty())?;
    Some(Remembered { name: name.to_owned(), id: record.get("id").and_then(Value::as_str).unwrap_or_default().to_owned() })
}

/// The account connector `connector` used last; a bare name (from before identities) has an
/// empty `id`.
fn in_use_record(all: &Map<String, Value>, connector: &str) -> Option<Remembered> {
    match all.get(connector)? {
        Value::String(name) => (!name.is_empty()).then(|| Remembered { name: name.clone(), id: String::new() }),
        other => account_of(other),
    }
}

fn conversation_account(all: &Map<String, Value>, conversation: &str, connector: &str) -> Option<Remembered> {
    account_of(all.get(conversation)?.get("accounts")?.as_object()?.get(connector)?)
}

/// Node `readJsonStateSync` with an object `validate` and an empty `fallback`: the object, `{}`
/// when the file is missing; a damaged file is handled as in [`mixdog_statefile::read_json`].
fn read_state(lane: &InLane<MaintenanceIo>, path: &Path) -> std::io::Result<Map<String, Value>> {
    let object = |value: &Value| {
        if value.is_object() { Ok(()) } else { Err(mixdog_statefile::Invalid::Damaged("the accounts in use must be an object".to_owned())) }
    };
    Ok(match mixdog_statefile::read_json(lane, path, Some(&object), &mixdog_statefile::Opts::default())? {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    })
}

/// `{ server, tool }` of an MCP tool name, as Node's `/^mcp__(.+?)__(.+)$/` reads it.
pub fn split_mcp_tool_name(name: &str) -> Option<(String, String)> {
    let caps = JsRegex::new_static("^mcp__(.+?)__(.+)$", "").captures(name)?;
    Some((caps.get(1)?.to_owned(), caps.get(2)?.to_owned()))
}
