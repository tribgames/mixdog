//! The stored shapes of `provider-accounts.json`: field names are Node's
//! (camelCase), unknown fields survive a rewrite, and timestamps are integer
//! milliseconds (a float written by another build reads as its integer part).

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

fn ms<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    Ok(f64::deserialize(d)? as i64)
}

fn opt_ms<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.map(|v| v as i64))
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub used_pct: Option<f64>,
    #[serde(default, deserialize_with = "opt_ms")]
    pub reset_at: Option<i64>,
    /// Model-id tokens the window gates (empty: a display-only meter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    /// Gates every model but these.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub except: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub windows: Vec<Window>,
    #[serde(default, deserialize_with = "ms")]
    pub checked_at: i64,
}

/// One refusal window. `blocked_source` is `retry-after` when the server
/// scheduled it; `blocked_quota` marks quota evidence.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    #[serde(deserialize_with = "ms")]
    pub blocked_until: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_limit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_quota: Option<bool>,
}

/// One account row. The latest block's fields sit on the row; earlier blocks
/// of other buckets still running are in `blocked_buckets`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default, deserialize_with = "opt_ms", skip_serializing_if = "Option::is_none")]
    pub blocked_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_limit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_quota: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_buckets: Option<Vec<Block>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Account {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            ..Self::default()
        }
    }

    /// Every block the account holds, oldest first.
    pub fn blocks(&self) -> Vec<Block> {
        let mut blocks = self.blocked_buckets.clone().unwrap_or_default();
        if let Some(blocked_until) = self.blocked_until {
            blocks.push(Block {
                blocked_until,
                blocked_model: self.blocked_model.clone(),
                blocked_limit: self.blocked_limit.clone(),
                blocked_source: self.blocked_source.clone(),
                blocked_quota: self.blocked_quota,
            });
        }
        blocks
    }

    pub fn clear_blocks(&mut self) {
        self.blocked_until = None;
        self.blocked_model = None;
        self.blocked_limit = None;
        self.blocked_source = None;
        self.blocked_quota = None;
        self.blocked_buckets = None;
    }

    pub fn set_blocks(&mut self, mut blocks: Vec<Block>) {
        self.clear_blocks();
        let Some(latest) = blocks.pop() else { return };
        self.blocked_until = Some(latest.blocked_until);
        self.blocked_model = latest.blocked_model;
        self.blocked_limit = latest.blocked_limit;
        self.blocked_source = latest.blocked_source;
        self.blocked_quota = latest.blocked_quota;
        if !blocks.is_empty() {
            self.blocked_buckets = Some(blocks);
        }
    }

    /// The row holding only the blocks `keep` accepts.
    pub fn with_blocks(&self, keep: impl Fn(&Block) -> bool) -> Account {
        let mut row = self.clone();
        row.set_blocks(self.blocks().into_iter().filter(keep).collect());
        row
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Manual,
    Limit,
    Headroom,
}

impl Policy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Limit => "limit",
            Self::Headroom => "headroom",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "manual" => Some(Self::Manual),
            "limit" => Some(Self::Limit),
            "headroom" => Some(Self::Headroom),
            _ => None,
        }
    }
}

/// One provider's roster.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub selected_id: Option<String>,
    /// Written beside `policy` for builds that know only `auto`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_credits: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Pool {
    fn default() -> Self {
        Self {
            accounts: Vec::new(),
            selected_id: None,
            auto: Some(true),
            policy: Some("limit".into()),
            use_credits: None,
            extra: Map::new(),
        }
    }
}

impl Pool {
    /// `auto` decides whether switching is on at all; otherwise `headroom`
    /// when stored, else `limit`.
    pub fn policy(&self) -> Policy {
        if self.auto == Some(false) {
            return Policy::Manual;
        }
        if self.policy.as_deref() == Some("headroom") {
            Policy::Headroom
        } else {
            Policy::Limit
        }
    }

    pub fn set_policy(&mut self, policy: Policy) {
        self.policy = Some(policy.as_str().into());
        self.auto = Some(policy != Policy::Manual);
    }

    pub fn uses_credits(&self) -> bool {
        self.use_credits == Some(true)
    }

    pub fn account(&self, id: &str) -> Option<&Account> {
        self.accounts.iter().find(|row| row.id == id)
    }

    pub fn selected(&self) -> Option<&Account> {
        self.selected_id.as_deref().and_then(|id| self.account(id))
    }
}
