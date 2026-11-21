//! The webhook endpoint table and the delivery dedup log in the core state store
//! (`state/core.sqlite`, `meta` keys `webhook:endpoint:<name>` and
//! `webhook:delivery:<endpoint>:<id>`). Each statement is one
//! state transaction, so the delivery claim is as indivisible as `INSERT … ON CONFLICT DO
//! NOTHING`: two concurrent POSTs of one id cannot both win.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use mixdog_store::sqlite::DbError;
use mixdog_store::state::{CoreState, StateTx};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::handler::{Claim, Endpoint, WebhookStore};
use crate::scheduler::{Clock, model::PAUSE_AFTER_FAILURES};

pub const ENDPOINT_PREFIX: &str = "webhook:endpoint:";
pub const DELIVERY_PREFIX: &str = "webhook:delivery:";

type Ts = DateTime<Utc>;

/// One stored endpoint. The signing secret and the last payload are stored but only ever
/// read through `read_secret` and `last_payload`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EndpointRecord {
    pub name: String,
    pub description: String,
    pub parser: Option<String>,
    pub secret: Option<String>,
    pub cwd: Option<String>,
    pub attachments: Option<Value>,
    pub delivery: Option<String>,
    pub instructions: String,
    pub enabled: bool,
    #[serde(deserialize_with = "crate::scheduler::model::lead_if_empty")]
    pub owner_agent_id: String,
    pub executor_agent_id: Option<String>,
    pub last_event_at: Option<Ts>,
    pub last_payload: Option<Value>,
    pub last_success_at: Option<Ts>,
    pub last_failed_at: Option<Ts>,
    pub last_skipped_at: Option<Ts>,
    pub consecutive_failures: u32,
    pub result_delivery: Option<Value>,
    pub created_at: Option<Ts>,
    pub updated_at: Option<Ts>,
}

impl Default for EndpointRecord {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            parser: None,
            secret: None,
            cwd: None,
            attachments: None,
            delivery: None,
            instructions: String::new(),
            enabled: true,
            owner_agent_id: "lead".into(),
            executor_agent_id: None,
            last_event_at: None,
            last_payload: None,
            last_success_at: None,
            last_failed_at: None,
            last_skipped_at: None,
            consecutive_failures: 0,
            result_delivery: None,
            created_at: None,
            updated_at: None,
        }
    }
}

/// The outcome of a run, stamped on its endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStamp {
    Success,
    Failed,
    Skipped,
}

impl RunStamp {
    /// The outcome word Node stamps (`success`, `failed`, `skipped`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "success" => Some(Self::Success),
            "failed" => Some(Self::Failed),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }
}

/// The admin and run-record side of the endpoint table (webhooks-db.mjs).
#[async_trait]
pub trait EndpointRecords: WebhookStore {
    async fn list(&self) -> Result<Vec<EndpointRecord>, String>;
    async fn load(&self, name: &str) -> Result<Option<EndpointRecord>, String>;
    /// Insert-or-replace by name: every definition column is reset from `def`, the failure
    /// streak clears, and the last event, run stamps and undelivered results survive.
    async fn upsert(&self, def: &EndpointRecord) -> Result<EndpointRecord, String>;
    /// Switching an endpoint back on clears its failure streak.
    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<Option<EndpointRecord>, String>;
    /// The received event: its time and payload `{body, headers}`, kept for a manual re-run.
    async fn record_event(&self, name: &str, payload: Value, at: Ts) -> Result<(), String>;
    async fn last_payload(&self, name: &str) -> Result<Option<Value>, String>;
    /// A success clears the failure streak; the failure reaching the pause limit switches
    /// the endpoint off (the receiver refuses a disabled endpoint).
    async fn mark_run(&self, name: &str, outcome: RunStamp, at: Ts) -> Result<(), String>;
    async fn record_delivery(&self, name: &str, run_id: &str, entry: Option<Value>) -> Result<(), String>;
    /// Drops the endpoint and its delivery log together.
    async fn delete(&self, name: &str) -> Result<bool, String>;
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryRow {
    status: String,
    #[serde(default)]
    retryable: bool,
    #[serde(default)]
    rule_handoff: bool,
    #[serde(default)]
    queue_file: Option<String>,
    event: Option<String>,
    error: Option<String>,
    headers_summary: Value,
    payload_preview: String,
    created_at: Ts,
    updated_at: Ts,
}

pub(crate) fn endpoint_key(name: &str) -> String {
    format!("{ENDPOINT_PREFIX}{name}")
}

fn delivery_key(endpoint: &str, id: &str) -> String {
    format!("{DELIVERY_PREFIX}{endpoint}:{id}")
}

fn db(error: DbError) -> String {
    format!("webhook store: {error}")
}

fn parse<T: serde::de::DeserializeOwned>(what: &str, text: &str) -> Result<T, DbError> {
    serde_json::from_str(text).map_err(|e| DbError::Write(format!("{what} is unreadable: {e}")))
}

fn encode<T: Serialize>(row: &T) -> Result<String, DbError> {
    serde_json::to_string(row).map_err(|e| DbError::Write(e.to_string()))
}

fn read_endpoint(tx: &StateTx<'_>, name: &str) -> Result<Option<EndpointRecord>, DbError> {
    tx.meta(&endpoint_key(name))?.map(|t| parse(&format!("webhook \"{name}\""), &t)).transpose()
}

pub(crate) fn write_endpoint(tx: &StateTx<'_>, row: &EndpointRecord) -> Result<(), DbError> {
    tx.put_meta(&endpoint_key(&row.name), &encode(row)?)
}

/// A delivery row of 1.4.5's `webhooks.deliveries` as PostgreSQL's `to_jsonb(row)` writes it, read as the claim the dedup
/// log holds: the same key and the same row a claim of this id writes.
pub(crate) struct LegacyDelivery {
    pub endpoint: String,
    key: String,
    row: DeliveryRow,
}

pub(crate) fn legacy_delivery(text: &str) -> Result<LegacyDelivery, String> {
    let Value::Object(columns) = serde_json::from_str(text).map_err(|e| format!("delivery row is not JSON: {e}"))? else {
        return Err("delivery row is not an object".to_owned());
    };
    let text_of = |name: &str| columns.get(name).and_then(Value::as_str).filter(|v| !v.is_empty());
    let (Some(endpoint), Some(id)) = (text_of("endpoint"), text_of("delivery_id")) else {
        return Err("delivery row has no endpoint or delivery id".to_owned());
    };
    let stamp = |name: &str| -> Result<Ts, String> {
        text_of(name)
            .ok_or_else(|| format!("delivery \"{endpoint}:{id}\" has no {name}"))?
            .parse()
            .map_err(|e| format!("delivery \"{endpoint}:{id}\" {name} is unreadable: {e}"))
    };
    let row = DeliveryRow {
        status: text_of("status").unwrap_or("pending").to_owned(),
        // Old failed rows do not distinguish an accepted bot run from failed admission.
        retryable: false,
        rule_handoff: false,
        queue_file: None,
        event: text_of("event").map(str::to_owned),
        error: text_of("error").map(str::to_owned),
        headers_summary: columns.get("headers_summary").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::Object(Default::default())),
        payload_preview: columns.get("payload_preview").and_then(Value::as_str).unwrap_or_default().to_owned(),
        created_at: stamp("created_at")?,
        updated_at: stamp("updated_at")?,
    };
    Ok(LegacyDelivery { endpoint: endpoint.to_owned(), key: delivery_key(endpoint, id), row })
}

/// Whether the endpoint a legacy delivery belongs to is in the store: a delivery of an endpoint that was removed since
/// is not brought back (its log went with it, as `delete` drops them together).
pub(crate) fn endpoint_present(tx: &StateTx<'_>, name: &str) -> Result<bool, DbError> {
    Ok(tx.meta(&endpoint_key(name))?.is_some())
}

/// Writes the claim unless the store already holds one under the key (a delivery since received keeps its own row).
pub(crate) fn write_delivery_if_absent(tx: &StateTx<'_>, delivery: &LegacyDelivery) -> Result<bool, DbError> {
    if tx.meta(&delivery.key)?.is_some() {
        return Ok(false);
    }
    tx.put_meta(&delivery.key, &encode(&delivery.row)?)?;
    Ok(true)
}

pub struct StateWebhookStore {
    state: CoreState,
    clock: Arc<dyn Clock>,
}

impl StateWebhookStore {
    pub fn new(state: CoreState, clock: Arc<dyn Clock>) -> Self {
        Self { state, clock }
    }

    /// The reserved file and whether its publication has been acknowledged.
    pub async fn rule_file(&self, name: &str, id: &str) -> Result<Option<(String, bool)>, String> {
        read_delivery(&self.state, name, id).await.map(|row| row.and_then(|row| row.queue_file.map(|file| (file, row.status == "done"))))
    }

    pub async fn reserve_rule_file(&self, name: &str, id: &str, file: &str) -> Result<(), String> {
        let (key, file) = (delivery_key(name, id), file.to_owned());
        self.state
            .write(move |tx| {
                let text = tx.meta(&key)?.ok_or_else(|| DbError::Write("webhook delivery lost its claim".into()))?;
                let mut row: DeliveryRow = parse("webhook delivery", &text)?;
                row.queue_file = Some(file);
                row.rule_handoff = true;
                row.retryable = true;
                tx.put_meta(&key, &encode(&row)?)
            })
            .await
            .map_err(db)
    }

    /// Settle the receipt before the file is eligible for execution. Do not recreate a
    /// deleted endpoint's history if its already accepted queue work gets another tick.
    pub async fn record_queued_rule(&self, name: &str, id: &str, file: &str) -> Result<(), String> {
        let (key, file, now) = (delivery_key(name, id), file.to_owned(), self.clock.now());
        self.state
            .write(move |tx| {
                let Some(text) = tx.meta(&key)? else { return Ok(()) };
                let mut row: DeliveryRow = parse("webhook delivery", &text)?;
                if row.queue_file.as_deref() != Some(file.as_str()) || row.status == "done" {
                    return Ok(());
                }
                row.status = "done".into();
                row.error = None;
                row.retryable = false;
                row.updated_at = now;
                tx.put_meta(&key, &encode(&row)?)
            })
            .await
            .map_err(db)
    }

    /// A delivery's `(status, error)`, for the tests of what a dispatch left behind.
    #[cfg(test)]
    pub(crate) async fn delivery_row(&self, endpoint: &str, id: &str) -> Option<(String, Option<String>)> {
        let text = self.state.meta(&delivery_key(endpoint, id)).await.unwrap()?;
        let row: DeliveryRow = serde_json::from_str(&text).unwrap();
        Some((row.status, row.error))
    }

    /// Every delivery row with the columns webhooks-db.mjs reads (`DELIVERY_COLS`), ordered by delivery id as Node's
    /// `ORDER BY delivery_id`; the stamps as JSON writes a PostgreSQL `timestamptz` (ISO, milliseconds, `Z`).
    pub async fn delivery_rows(&self) -> Vec<Value> {
        let stamp = |at: Ts| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut rows: Vec<Value> = self
            .state
            .meta_prefix(DELIVERY_PREFIX)
            .await
            .unwrap()
            .iter()
            .map(|(key, text)| {
                let (endpoint, id) = key[DELIVERY_PREFIX.len()..].split_once(':').unwrap();
                let row: DeliveryRow = serde_json::from_str(text).unwrap();
                serde_json::json!({
                    "endpoint": endpoint, "delivery_id": id, "status": row.status, "event": row.event, "error": row.error,
                    "headers_summary": row.headers_summary, "payload_preview": row.payload_preview,
                    "created_at": stamp(row.created_at), "updated_at": stamp(row.updated_at),
                })
            })
            .collect();
        rows.sort_by(|a, b| a["delivery_id"].as_str().cmp(&b["delivery_id"].as_str()));
        rows
    }

    async fn edit<R: Send + 'static>(&self, name: &str, f: impl FnOnce(&mut EndpointRecord) -> R + Send + 'static) -> Result<Option<R>, String> {
        let name = name.to_owned();
        self.state
            .write(move |tx| {
                let Some(mut row) = read_endpoint(tx, &name)? else { return Ok(None) };
                let out = f(&mut row);
                write_endpoint(tx, &row)?;
                Ok(Some(out))
            })
            .await
            .map_err(db)
    }
}

async fn read_delivery(state: &CoreState, name: &str, id: &str) -> Result<Option<DeliveryRow>, String> {
    state.meta(&delivery_key(name, id)).await.map_err(db)?.map(|text| parse("webhook delivery", &text).map_err(db)).transpose()
}

#[async_trait]
impl WebhookStore for StateWebhookStore {
    async fn load_endpoint(&self, name: &str) -> Result<Option<Endpoint>, String> {
        Ok(self.load(name).await?.map(|e| Endpoint { enabled: Some(e.enabled), parser: e.parser, allow_unsigned: None }))
    }

    async fn any_enabled_endpoint(&self) -> Result<bool, String> {
        Ok(EndpointRecords::list(self).await?.iter().any(|e| e.enabled))
    }

    async fn read_secret(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.load(name).await?.and_then(|e| e.secret).map(|s| mixdog_js::js_trim(&s).to_string()).filter(|s| !s.is_empty()))
    }

    async fn claim_delivery(&self, endpoint: &str, delivery_id: &str, claim: Claim<'_>) -> Result<bool, String> {
        let key = delivery_key(endpoint, delivery_id);
        let mut row = DeliveryRow {
            status: claim.status.to_string(),
            retryable: false,
            rule_handoff: false,
            queue_file: None,
            event: claim.event.map(str::to_string),
            error: None,
            headers_summary: claim.headers_summary,
            payload_preview: claim.payload_preview,
            created_at: self.clock.now(),
            updated_at: self.clock.now(),
        };
        self.state
            .write(move |tx| {
                if let Some(text) = tx.meta(&key)? {
                    let earlier: DeliveryRow = parse("webhook delivery", &text)?;
                    if !earlier.retryable {
                        return Ok(false);
                    }
                    row.rule_handoff = earlier.rule_handoff;
                    row.retryable = earlier.rule_handoff;
                    row.queue_file = earlier.queue_file;
                }
                tx.put_meta(&key, &encode(&row)?)?;
                Ok(true)
            })
            .await
            .map_err(db)
    }

    async fn fail_handoff(&self, endpoint: &str, delivery_id: &str, error: &str) -> Result<(), String> {
        let (key, error, now) = (delivery_key(endpoint, delivery_id), error.to_owned(), self.clock.now());
        self.state
            .write(move |tx| {
                let Some(text) = tx.meta(&key)? else { return Ok(()) };
                let mut row: DeliveryRow = parse("webhook delivery", &text)?;
                if matches!(row.status.as_str(), "done" | "skipped" | "self-comment-skip") {
                    return Ok(());
                }
                row.status = "failed".into();
                row.error = Some(error);
                row.retryable = true;
                row.updated_at = now;
                tx.put_meta(&key, &encode(&row)?)
            })
            .await
            .map_err(db)
    }

    async fn resuming_rule_handoff(&self, name: &str, id: &str) -> Result<bool, String> {
        Ok(read_delivery(&self.state, name, id).await?.is_some_and(|row| row.rule_handoff))
    }

    async fn update_delivery_status(&self, endpoint: &str, delivery_id: &str, status: &str, error: Option<&str>) -> Result<(), String> {
        let key = delivery_key(endpoint, delivery_id);
        let (status, error, now) = (status.to_string(), error.map(str::to_string), self.clock.now());
        self.state
            .write(move |tx| {
                let Some(text) = tx.meta(&key)? else { return Ok(()) };
                let mut row: DeliveryRow = parse("webhook delivery", &text)?;
                if row.queue_file.is_some() && row.status == "done" {
                    return Ok(());
                }
                row.status = status;
                if row.status != "pending" {
                    row.retryable = false;
                }
                row.error = error.or(row.error);
                row.updated_at = now;
                tx.put_meta(&key, &encode(&row)?)
            })
            .await
            .map_err(db)
    }
}

#[async_trait]
impl EndpointRecords for StateWebhookStore {
    async fn list(&self) -> Result<Vec<EndpointRecord>, String> {
        let rows = self.state.meta_prefix(ENDPOINT_PREFIX).await.map_err(db)?;
        let mut all = rows
            .iter()
            .map(|(k, text)| parse(&format!("webhook \"{}\"", &k[ENDPOINT_PREFIX.len()..]), text))
            .collect::<Result<Vec<EndpointRecord>, _>>()
            .map_err(db)?;
        // Node's `ORDER BY name` on a PG initdb'd `--no-locale -E UTF8`: C collation, byte
        // order of the UTF-8, which is `str::cmp`.
        all.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(all)
    }

    async fn load(&self, name: &str) -> Result<Option<EndpointRecord>, String> {
        let text = self.state.meta(&endpoint_key(name)).await.map_err(db)?;
        text.map(|t| parse(&format!("webhook \"{name}\""), &t)).transpose().map_err(db)
    }

    async fn upsert(&self, def: &EndpointRecord) -> Result<EndpointRecord, String> {
        let (def, now) = (def.clone(), self.clock.now());
        self.state
            .write(move |tx| {
                let existing = read_endpoint(tx, &def.name)?;
                let kept = existing.clone().unwrap_or_default();
                let row = EndpointRecord {
                    owner_agent_id: if def.owner_agent_id.is_empty() { "lead".into() } else { def.owner_agent_id.clone() },
                    executor_agent_id: def.executor_agent_id.clone().filter(|e| !e.is_empty()),
                    consecutive_failures: 0,
                    last_event_at: kept.last_event_at,
                    last_payload: kept.last_payload,
                    last_success_at: kept.last_success_at,
                    last_failed_at: kept.last_failed_at,
                    last_skipped_at: kept.last_skipped_at,
                    result_delivery: kept.result_delivery,
                    created_at: existing.and_then(|e| e.created_at).or(Some(now)),
                    updated_at: Some(now),
                    ..def
                };
                write_endpoint(tx, &row)?;
                Ok(row)
            })
            .await
            .map_err(db)
    }

    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<Option<EndpointRecord>, String> {
        let now = self.clock.now();
        self.edit(name, move |e| {
            e.enabled = enabled;
            if enabled {
                e.consecutive_failures = 0;
            }
            e.updated_at = Some(now);
            e.clone()
        })
        .await
    }

    async fn record_event(&self, name: &str, payload: Value, at: Ts) -> Result<(), String> {
        let now = self.clock.now();
        self.edit(name, move |e| {
            e.last_event_at = Some(at);
            e.last_payload = Some(payload);
            e.updated_at = Some(now);
        })
        .await
        .map(drop)
    }

    async fn last_payload(&self, name: &str) -> Result<Option<Value>, String> {
        Ok(self.load(name).await?.and_then(|e| e.last_payload))
    }

    async fn mark_run(&self, name: &str, outcome: RunStamp, at: Ts) -> Result<(), String> {
        self.edit(name, move |e| match outcome {
            RunStamp::Success => {
                e.last_success_at = Some(at);
                e.consecutive_failures = 0;
            }
            RunStamp::Skipped => e.last_skipped_at = Some(at),
            RunStamp::Failed => {
                e.last_failed_at = Some(at);
                e.consecutive_failures += 1;
                e.enabled = e.enabled && e.consecutive_failures < PAUSE_AFTER_FAILURES;
            }
        })
        .await
        .map(drop)
    }

    async fn record_delivery(&self, name: &str, run_id: &str, entry: Option<Value>) -> Result<(), String> {
        let run_id = run_id.to_string();
        self.edit(name, move |e| {
            let mut map = match e.result_delivery.take() {
                Some(Value::Object(map)) => map,
                _ => Default::default(),
            };
            match entry {
                Some(entry) => {
                    map.insert(run_id, entry);
                }
                None => {
                    map.shift_remove(&run_id);
                }
            }
            e.result_delivery = (!map.is_empty()).then_some(Value::Object(map));
        })
        .await
        .map(drop)
    }

    async fn delete(&self, name: &str) -> Result<bool, String> {
        let name = name.to_owned();
        self.state
            .write(move |tx| {
                tx.delete_meta_prefix(&format!("{DELIVERY_PREFIX}{name}:"))?;
                tx.delete_meta(&endpoint_key(&name))
            })
            .await
            .map_err(db)
    }
}

#[cfg(test)]
mod tests {
    use mixdog_rt::testing::tokens;
    use serde_json::json;

    use super::*;
    use crate::scheduler::SystemClock;

    async fn open(dir: &std::path::Path) -> StateWebhookStore {
        let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &dir.join("core.sqlite")).unwrap();
        StateWebhookStore::new(state, Arc::new(SystemClock))
    }

    fn def(name: &str) -> EndpointRecord {
        EndpointRecord { name: name.into(), instructions: "do it".into(), secret: Some(" s3cret ".into()), ..Default::default() }
    }

    fn claim(event: Option<&str>) -> Claim<'_> {
        Claim { status: "received", event, headers_summary: json!({}), payload_preview: "{}".into() }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_claims_of_one_delivery_have_one_winner_and_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(open(dir.path()).await);
        store.upsert(&def("gh")).await.unwrap();
        let claims = (0..8).map(|_| {
            let store = store.clone();
            tokio::spawn(async move { store.claim_delivery("gh", "d1", claim(None)).await.unwrap() })
        });
        let wins = futures::future::join_all(claims).await.into_iter().filter(|w| *w.as_ref().unwrap()).count();
        assert_eq!(wins, 1);
        drop(store);
        let store = open(dir.path()).await;
        assert!(!store.claim_delivery("gh", "d1", claim(None)).await.unwrap());
        assert!(store.claim_delivery("gh", "d2", claim(Some("push"))).await.unwrap());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn endpoint_secret_is_trimmed_and_an_edit_keeps_the_last_event() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path()).await;
        store.upsert(&def("gh")).await.unwrap();
        assert_eq!(store.read_secret("gh").await.unwrap().as_deref(), Some("s3cret"));
        assert_eq!(store.read_secret("nope").await.unwrap(), None);
        store.record_event("gh", json!({"body":{"a":1},"headers":{}}), Utc::now()).await.unwrap();
        store.mark_run("gh", RunStamp::Failed, Utc::now()).await.unwrap();
        let mut edited = def("gh");
        edited.instructions = "new".into();
        let saved = store.upsert(&edited).await.unwrap();
        assert_eq!((saved.consecutive_failures, saved.instructions.as_str()), (0, "new"));
        assert!(saved.last_payload.is_some() && saved.last_failed_at.is_some());
        assert_eq!(store.last_payload("gh").await.unwrap(), Some(json!({"body":{"a":1},"headers":{}})));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failures_pause_the_endpoint_and_the_receiver_then_refuses_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path()).await;
        store.upsert(&def("gh")).await.unwrap();
        for _ in 0..PAUSE_AFTER_FAILURES {
            store.mark_run("gh", RunStamp::Failed, Utc::now()).await.unwrap();
        }
        assert_eq!(store.load_endpoint("gh").await.unwrap().unwrap().enabled, Some(false));
        let on = store.set_enabled("gh", true).await.unwrap().unwrap();
        assert_eq!((on.enabled, on.consecutive_failures), (true, 0));
        store.mark_run("gh", RunStamp::Success, Utc::now()).await.unwrap();
        assert!(store.load("gh").await.unwrap().unwrap().last_success_at.is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_a_failed_handoff_can_be_claimed_again_not_a_failed_run() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path()).await;
        store.upsert(&def("gh")).await.unwrap();
        assert!(store.claim_delivery("gh", "d1", claim(None)).await.unwrap());
        for status in ["received", "pending", "processing", "done", "skipped", "self-comment-skip"] {
            store.update_delivery_status("gh", "d1", status, None).await.unwrap();
            assert!(!store.claim_delivery("gh", "d1", claim(None)).await.unwrap(), "{status} is a duplicate");
        }
        store.update_delivery_status("gh", "d1", "failed", Some("boom")).await.unwrap();
        assert!(!store.claim_delivery("gh", "d1", claim(None)).await.unwrap(), "a failed execution was already accepted");
        store.fail_handoff("gh", "d1", "could not enqueue").await.unwrap();
        assert!(store.claim_delivery("gh", "d1", claim(None)).await.unwrap(), "a failed handoff can retry");
        assert_eq!(store.delivery_row("gh", "d1").await, Some(("received".to_string(), None)));
        assert!(!store.claim_delivery("gh", "d1", claim(None)).await.unwrap(), "and is then a duplicate itself");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deleting_an_endpoint_drops_its_deliveries_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path()).await;
        store.upsert(&def("gh")).await.unwrap();
        store.upsert(&def("gh2")).await.unwrap();
        assert!(store.claim_delivery("gh", "d1", claim(None)).await.unwrap());
        assert!(store.claim_delivery("gh2", "d1", claim(None)).await.unwrap());
        store.update_delivery_status("gh", "d1", "failed", Some("boom")).await.unwrap();
        assert!(store.delete("gh").await.unwrap());
        assert!(!store.delete("gh").await.unwrap());
        assert!(store.claim_delivery("gh", "d1", claim(None)).await.unwrap(), "the log went with the endpoint");
        assert!(!store.claim_delivery("gh2", "d1", claim(None)).await.unwrap(), "a neighbouring prefix is untouched");
        assert_eq!(store.list().await.unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undelivered_results_are_recorded_by_run_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path()).await;
        store.upsert(&def("gh")).await.unwrap();
        store.record_delivery("gh", "r1", Some(json!({"state":"pending"}))).await.unwrap();
        assert_eq!(store.load("gh").await.unwrap().unwrap().result_delivery, Some(json!({"r1":{"state":"pending"}})));
        store.record_delivery("gh", "r1", None).await.unwrap();
        assert_eq!(store.load("gh").await.unwrap().unwrap().result_delivery, None);
    }
}
