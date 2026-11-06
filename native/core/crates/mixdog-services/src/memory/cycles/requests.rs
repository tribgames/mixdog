//! The coalesced cycle request ledger in `meta` (`memory-cycle-requests.mjs`): the scheduled slot
//! claim, the request counter a skipped run leaves, its drain, the retry limits and the retry
//! timers.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use mixdog_js::{slice_utf16, string_to_number, to_number_of};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::log;
use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::Db;

const KEY_PREFIX: &str = "cycle_request.";

fn meta_key(prefix: &str, label: &str, kind: &str, signature: &str) -> Result<String> {
    let normalized = mixdog_js::js_trim(kind).to_lowercase();
    if normalized != "cycle1" {
        return Err(MemoryError::Runtime(format!("invalid cycle {label} kind: {kind}")));
    }
    let sig: String = signature.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-') { c } else { '_' }).collect();
    Ok(format!("{prefix}{normalized}.{}", slice_utf16(&sig, 120)))
}

fn request_key(kind: &str, signature: &str) -> Result<String> {
    meta_key(KEY_PREFIX, "request", kind, signature)
}

fn schedule_key(kind: &str, signature: &str) -> Result<String> {
    meta_key("cycle_schedule.", "schedule", kind, signature)
}

/// One coalesced-request counter upsert: `$1` key, `$2` now (ms), `$3` reason.
const UPSERT_CYCLE_REQUEST: &str = "INSERT INTO meta(key, value)
   VALUES ($1, jsonb_build_object(
     'count', 1,
     'first_requested_at', $2::bigint,
     'last_requested_at', $2::bigint,
     'last_reason', $3::text
   ))
   ON CONFLICT(key) DO UPDATE SET value = jsonb_build_object(
     'count',
       CASE WHEN jsonb_typeof(meta.value->'count') = 'number'
         THEN (meta.value->>'count')::integer + 1
         ELSE 1
       END,
     'first_requested_at', COALESCE(meta.value->'first_requested_at', to_jsonb($2::bigint)),
     'last_requested_at', to_jsonb($2::bigint),
     'last_reason', to_jsonb($3::text),
     'last_drained_at', meta.value->'last_drained_at',
     'last_drained_count', meta.value->'last_drained_count'
   )";

const CLAIM_SLOT: &str = "INSERT INTO meta(key, value)
         VALUES ($1, jsonb_build_object(
           'last_attempt_at', $2::bigint,
           'next_allowed_at', $3::bigint,
           'claimed_count', 1,
           'last_reason', $4::text
         ))
         ON CONFLICT(key) DO UPDATE SET value = jsonb_build_object(
           'last_attempt_at', $2::bigint,
           'next_allowed_at', $3::bigint,
           'claimed_count',
             CASE WHEN jsonb_typeof(meta.value->'claimed_count') = 'number'
               THEN (meta.value->>'claimed_count')::integer + 1
               ELSE 1
             END,
           'last_reason', $4::text,
           'last_skipped_at', meta.value->'last_skipped_at'
         )
         WHERE CASE WHEN jsonb_typeof(meta.value->'next_allowed_at') = 'number'
           THEN (meta.value->>'next_allowed_at')::bigint
           ELSE 0
         END <= $2::bigint
         RETURNING value";

#[derive(Debug, PartialEq)]
pub struct Claim {
    pub claimed: bool,
    pub next_allowed_at: i64,
}

/// `claimAndMarkScheduledCycle`: one slot per `spacing_ms`, claimed and counted as a request in
/// one transaction; a failure is logged and answers not claimed.
pub async fn claim_and_mark_scheduled_cycle(db: &Db, kind: &str, interval_ms: f64, signature: &str, reason: &str, spacing_ms: Option<f64>, now: i64) -> Claim {
    let raw = spacing_ms.unwrap_or(interval_ms);
    let spacing = if raw.is_finite() && raw > 0.0 { raw } else { 60_000.0 }.max(1000.0);
    let next_allowed_at = now + spacing as i64;
    let safe_reason = slice_utf16(reason, 80);
    let attempt = async {
        let (schedule, request) = (schedule_key(kind, signature)?, request_key(kind, signature)?);
        let mut client = db.client().await?;
        let tx = client.transaction().await?;
        let claimed = tx.query(CLAIM_SLOT, &[&schedule, &now, &next_allowed_at, &safe_reason]).await?;
        if claimed.is_empty() {
            tx.commit().await?;
            return Ok::<bool, MemoryError>(false);
        }
        tx.execute(UPSERT_CYCLE_REQUEST, &[&request, &now, &safe_reason]).await?;
        tx.commit().await?;
        Ok(true)
    };
    match attempt.await {
        Ok(claimed) => Claim { claimed, next_allowed_at },
        Err(error) => {
            log(&format!("[{kind}] scheduled claim+mark failed: {}\n", error.message()));
            Claim { claimed: false, next_allowed_at: 0 }
        }
    }
}

/// `markCycleRequest`: counts one skipped run; false when the write failed.
pub async fn mark_cycle_request(db: &Db, kind: &str, reason: &str, signature: &str, now: i64) -> bool {
    let reason = if reason.is_empty() { "coalesced" } else { reason };
    let safe_reason = slice_utf16(reason, 80);
    let written = async {
        let key = request_key(kind, signature)?;
        db.execute(UPSERT_CYCLE_REQUEST, &[&key, &now, &safe_reason]).await
    };
    match written.await {
        Ok(_) => true,
        Err(error) => {
            log(&format!("[{kind}] coalesced request mark failed: {}\n", error.message()));
            false
        }
    }
}

/// `consumeCycleRequests`: the pending count, drained to zero under a row lock.
pub async fn consume_cycle_requests(db: &Db, kind: &str, signature: &str, now: i64) -> Result<f64> {
    let key = request_key(kind, signature)?;
    let mut client = db.client().await?;
    let tx = client.transaction().await?;
    let selected = tx.query("SELECT value FROM meta WHERE key = $1 FOR UPDATE", &[&key]).await?;
    let Some(row) = selected.first() else {
        tx.commit().await?;
        return Ok(0.0);
    };
    let value: Option<Value> = row.get(0);
    let count = to_number_of(value.as_ref().and_then(|v| v.get("count")).or(Some(&Value::from(0))));
    if !count.is_finite() || count <= 0.0 {
        tx.commit().await?;
        return Ok(0.0);
    }
    let drained = count.min(2_147_483_647.0) as i32;
    tx.execute(
        "UPDATE meta
       SET value = jsonb_set(
         jsonb_set(
           jsonb_set(COALESCE(value, '{}'::jsonb), '{count}', '0'::jsonb, true),
           '{last_drained_at}', to_jsonb($2::bigint), true
         ),
         '{last_drained_count}', to_jsonb($3::integer), true
       )
       WHERE key = $1",
        &[&key, &now, &drained],
    )
    .await?;
    tx.commit().await?;
    Ok(count)
}

fn resolve_setting(config: &Value, direct: &str, nested: &str, env_var: &str, fallback: f64, min: f64, max: f64) -> f64 {
    let env = std::env::var(env_var).map_or(f64::NAN, |text| string_to_number(&text));
    let candidates = [to_number_of(config.get(direct)), to_number_of(config.get("coalesce").and_then(|c| c.get(nested))), env];
    let value = candidates.into_iter().find(|n| n.is_finite()).unwrap_or(fallback);
    value.floor().clamp(min, max)
}

pub fn resolve_coalesce_max_drains(config: &Value, fallback: f64) -> f64 {
    resolve_setting(config, "coalesce_max_drains", "max_drains", "MIXDOG_MEMORY_CYCLE_COALESCE_MAX_DRAINS", fallback, 0.0, 10.0)
}

pub fn resolve_coalesce_retry_delay_ms(config: &Value, fallback: f64) -> f64 {
    resolve_setting(config, "coalesce_retry_delay_ms", "retry_delay_ms", "MIXDOG_MEMORY_CYCLE_COALESCE_RETRY_MS", fallback, 50.0, 60_000.0)
}

pub fn resolve_coalesce_max_retries(config: &Value, fallback: f64) -> f64 {
    resolve_setting(config, "coalesce_max_retries", "max_retries", "MIXDOG_MEMORY_CYCLE_COALESCE_MAX_RETRIES", fallback, 0.0, 10.0)
}

/// What a retry timer runs once it fires.
pub type RetryRunner = Box<dyn FnOnce() -> BoxFuture<'static, std::result::Result<(), String>> + Send>;

/// `_retryTimersByDb` of one database: at most one pending retry per request key.
#[derive(Default)]
pub struct RetryTimers {
    pending: Mutex<HashMap<String, CancellationToken>>,
}

impl RetryTimers {
    /// `scheduleCoalescedCycleRetry`: false when one is already pending for the key. The delay
    /// runs on `spawn`; once it elapses the key is free again and `runner` runs to its end
    /// (cancelling only stops timers still waiting).
    pub fn schedule(self: &Arc<Self>, kind: &str, signature: &str, config: &Value, runner: RetryRunner) -> Result<bool> {
        let key = request_key(kind, signature)?;
        let token = CancellationToken::new();
        {
            let mut pending = self.pending.lock().expect("retry timers");
            if pending.contains_key(&key) {
                return Ok(false);
            }
            pending.insert(key.clone(), token.clone());
        }
        let delay = Duration::from_millis(resolve_coalesce_retry_delay_ms(config, 1000.0) as u64);
        let (timers, kind) = (Arc::clone(self), kind.to_owned());
        spawn_work("memory-cycle-retry", async move {
            tokio::select! {
                () = token.cancelled() => return,
                () = tokio::time::sleep(delay) => {}
            }
            timers.pending.lock().expect("retry timers").remove(&key);
            if let Err(error) = runner().await {
                log(&format!("[{kind}] coalesced retry failed: {error}\n"));
            }
        });
        Ok(true)
    }

    /// `cancelCoalescedCycleRetries`: how many waiting timers were stopped.
    pub fn cancel_all(&self) -> usize {
        let mut pending = self.pending.lock().expect("retry timers");
        let cancelled = pending.len();
        for token in pending.values() {
            token.cancel();
        }
        pending.clear();
        cancelled
    }
}

/// Spawns a cycle task on the work executor.
pub(crate) fn spawn_work(name: &'static str, fut: impl Future<Output = ()> + Send + 'static) -> tokio::task::JoinHandle<()> {
    mixdog_rt::spawn(name, mixdog_rt::TaskClass::Work, fut)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_sanitize_the_signature_and_refuse_other_kinds() {
        assert_eq!(request_key("Cycle1 ", "a b/c").unwrap(), "cycle_request.cycle1.a_b_c");
        assert_eq!(schedule_key("cycle1", "").unwrap(), "cycle_schedule.cycle1.");
        assert!(request_key("cycle2", "x").is_err());
    }

    #[test]
    fn limits_follow_direct_then_nested_then_env_then_fallback() {
        let direct = serde_json::json!({"coalesce_max_retries": 7.9, "coalesce": {"max_retries": 2}});
        assert_eq!(resolve_coalesce_max_retries(&direct, 3.0), 7.0);
        let nested = serde_json::json!({"coalesce": {"max_retries": 99}});
        assert_eq!(resolve_coalesce_max_retries(&nested, 3.0), 10.0);
        assert_eq!(resolve_coalesce_max_retries(&serde_json::json!({}), 3.0), 3.0);
        assert_eq!(resolve_coalesce_retry_delay_ms(&serde_json::json!({"coalesce_retry_delay_ms": 1}), 1000.0), 50.0);
        assert_eq!(resolve_coalesce_max_drains(&serde_json::json!({"coalesce_max_drains": null}), 1.0), 0.0);
    }
}
