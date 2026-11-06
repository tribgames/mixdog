//! The statusline's gateway session routes, `<data>/gateway-session-routes.json`
//! (`vendor/statusline/src/gateway/session-routes.mjs`), kept in 1.4.5's format (the store
//! migration preserves it for its owner): a deleted or released session's route leaves it.

use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `STORE_FILE`.
pub const STORE_FILE: &str = "gateway-session-routes.json";

/// `normalizeGatewaySessionId`: the trimmed id when it matches `/^[0-9a-z][0-9a-z._-]{7,}$/i`.
pub fn normalize_session_id(value: &str) -> Option<&str> {
    let id = mixdog_js::js_trim(value);
    let mut chars = id.chars();
    let first = chars.next()?.is_ascii_alphanumeric();
    let rest = chars.clone().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    (first && rest && chars.count() >= 7).then_some(id)
}

/// `{ ...map }` of a field read as `x && typeof x === 'object'`: an array spreads to its
/// index keys; anything else is empty.
fn spread(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        _ => Map::new(),
    }
}

/// `clearGatewaySessionRoute(sessionId)` (no host pid) on `path`: the session's `sessions` entry
/// goes. As Node's mutator, the store read (`{}` when missing) is written back unchanged when the
/// session has no entry. False for an id the store never keys.
pub fn clear_session_route(lane: &InLane<MaintenanceIo>, path: &Path, session_id: &str, now_ms: i64) -> Result<bool, String> {
    let Some(sid) = normalize_session_id(session_id) else { return Ok(false) };
    let drop_route = |raw: Option<Value>| {
        let cur = match raw {
            Some(value @ (Value::Object(_) | Value::Array(_))) => value,
            _ => Value::Object(Map::new()),
        };
        let mut sessions = spread(cur.get("sessions"));
        if sessions.shift_remove(sid).is_none() {
            return Ok::<_, std::convert::Infallible>(Some(cur));
        }
        let hosts = spread(cur.get("sessionHosts"));
        Ok(Some(json!({ "version": 2, "updatedAt": now_ms, "sessions": sessions, "sessionHosts": hosts })))
    };
    let opts = mixdog_statefile::Opts { compact: true, backup: true, ..mixdog_statefile::Opts::default() };
    mixdog_statefile::update_json(lane, path, drop_route, &opts).map(|_| true).map_err(|e| e.to_string())
}

/// The data dir's gateway route store.
#[derive(Clone)]
pub struct GatewaySessionRoutes {
    path: PathBuf,
    maintenance: MaintenanceIo,
}

impl GatewaySessionRoutes {
    /// Over `resolvePluginData()`.
    pub fn new(data_dir: &Path, maintenance: MaintenanceIo) -> Self {
        Self { path: data_dir.join(STORE_FILE), maintenance }
    }

    /// `statusRoutes.clearGatewaySessionRoute(id)` on the maintenance lane; returns once it has
    /// run. A failure is logged, as Node's caller ignores it.
    pub async fn clear(&self, session_id: &str) {
        let (path, id) = (self.path.clone(), session_id.to_owned());
        // `Date.now()`.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        let job = self.maintenance.submit(&CancellationToken::new(), move |lane| clear_session_route(lane, &path, &id, now));
        match job {
            Ok(job) => match job.await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => tracing::warn!(%error, "session delete: gateway route not cleared"),
                Err(_) => tracing::warn!("session delete: the gateway route job did not run"),
            },
            Err(error) => tracing::warn!(?error, "session delete: the gateway route job was refused"),
        }
    }
}
