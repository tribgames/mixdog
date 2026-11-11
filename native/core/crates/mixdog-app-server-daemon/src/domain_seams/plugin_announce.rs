//! `plugins.announce`: `announceStoredStateChange('plugins')` (`runtime/shared/config.mjs`) —
//! the registry changed, and the other processes of the data folder learn it from the secret
//! change marker `mixdog-secrets-changed.json` beside the config file, under the reserved key
//! `#plugins`, whose value is this change's token (`<pid>:<ms>:<uuid>`).
//!
//! Like Node's `publishSecretChange` it never fails the caller: the registry is already
//! written, and a marker that could not be written only delays what the other processes see.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;
use mixdog_statefile::Opts;
use mixdog_statefile::update_json;
use serde_json::Map;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

const MARKER_FILE: &str = "mixdog-secrets-changed.json";
const KEY: &str = "#plugins";

/// `randomUUID()`: a version 4 UUID.
fn uuid_v4() -> String {
    let mut bytes = rand::random::<u128>().to_be_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

/// `${process.pid}:${Date.now()}:${randomUUID()}`.
fn token_of(pid: u32, now_ms: u128, uuid: &str) -> String {
    format!("{pid}:{now_ms}:{uuid}")
}

fn token() -> String {
    let now = mixdog_rt::wall_clock!().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    token_of(std::process::id(), now, &uuid_v4())
}

/// `withSecretChange(marker, '#plugins', token, false)`: a marker that is not an object starts over.
fn with_change(marker: Option<Value>, token: String) -> Option<Value> {
    let mut next: Map<String, Value> = match marker {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    next.insert(KEY.to_owned(), Value::String(token));
    Some(Value::Object(next))
}

fn publish(lane: &mixdog_rt::InLane<DurabilityIo>, path: &std::path::Path, token: String) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "the marker has no folder".to_owned())?;
    mixdog_statefile::create_private_dir_all(lane, parent).map_err(|error| error.to_string())?;
    let opts = Opts { mode: 0o600, ..Opts::default() };
    update_json(lane, path, |marker| Ok::<_, std::convert::Infallible>(with_change(marker, token)), &opts)
        .map(drop)
        .map_err(|error| format!("{error:?}"))
}

/// The `announce` closure of `PluginSeams`: it queues the marker write and returns.
pub fn plugins_announce(data_dir: PathBuf, durability: DurabilityIo) -> Arc<dyn Fn() + Send + Sync> {
    let path = data_dir.join(MARKER_FILE);
    Arc::new(move || {
        let (path, lane) = (path.clone(), durability);
        mixdog_rt::spawn("plugins-announce", TaskClass::Work, async move {
            let job = lane.submit(&CancellationToken::new(), move |lane| publish(lane, &path, token()));
            let outcome = match job {
                Ok(handle) => handle.await.map_err(|_| "the durability lane dropped the job".to_owned()).and_then(|done| done),
                Err(_) => Err("the durability lane is full".to_owned()),
            };
            if let Err(error) = outcome {
                mixdog_rt::node_stderr!("[config] secret change marker write failed: {error}");
            }
        });
    })
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {
    use super::*;
    use crate::domain_seams::golden;

    #[tokio::test(flavor = "multi_thread")]
    async fn the_marker_bytes_match_nodes_for_each_prior_marker() {
        let marker = &golden()["marker"];
        let (pid, now, uuid) = (marker["pid"].as_u64().unwrap() as u32, marker["now"].as_u64().unwrap() as u128, marker["uuid"].as_str().unwrap());
        let lane = mixdog_rt::testing::tokens().durability_io;
        for case in marker["cases"].as_array().unwrap() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(MARKER_FILE);
            if let Some(prior) = case["prior"].as_str() {
                std::fs::write(&path, prior).unwrap();
            }
            let token = token_of(pid, now, uuid);
            let job = lane.submit(&CancellationToken::new(), {
                let path = path.clone();
                move |lane| publish(lane, &path, token)
            });
            job.unwrap().await.unwrap().unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), case["file"].as_str().unwrap(), "{}", case["name"]);
        }
    }

    #[test]
    fn a_token_names_the_process_the_time_and_a_version_4_uuid() {
        let parts: Vec<String> = token().split(':').map(str::to_owned).collect();
        assert_eq!(parts[0], std::process::id().to_string());
        let uuid = &parts[2];
        let shape: Vec<usize> = uuid.split('-').map(str::len).collect();
        assert_eq!(shape, [8, 4, 4, 4, 12]);
        assert!(uuid[14..].starts_with('4') && matches!(uuid.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }
}
