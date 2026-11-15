//! Reading and writing `<DATA_DIR>/devices.json` (`lib/device-store-persistence.mjs`). The file is `JSON.stringify(rows, null,
//! 2)` in the form Node writes, so either program reads what the other wrote.

use std::io::Write;
use std::path::Path;

use mixdog_rt::{DurabilityIo, InLane};
use serde_json::{Map, Number, Value};

use super::auth::{DEFAULT_CLIENT_NAME, clip_field, text_or};
use super::devices::{finite, number_value};
use super::version::apply_stored_version;
use crate::ids::is_routing_id;
use crate::js;
use crate::logline;
use crate::rate_limit::now_ms;

fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

/// `HEX_HASH.test(String(value || ''))`: `^[0-9a-f]{64}$`.
fn is_hex_hash(value: Option<&Value>) -> bool {
    let text = text_or(value, "");
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `applyStoredClient`: the profile clipped as a browser registers it, the times finite.
fn apply_stored_client(client: &mut Map<String, Value>, now: i64) {
    for (key, fallback) in [("name", DEFAULT_CLIENT_NAME), ("platform", ""), ("browser", "")] {
        let clipped = clip_field(client.get(key), fallback);
        client.insert(key.to_owned(), Value::String(clipped));
    }
    let created = finite(client.get("createdAt")).map_or_else(|| Value::Number(Number::from(now)), number_value);
    client.insert("createdAt".to_owned(), created);
    let seen = finite(client.get("lastSeenAt")).map_or_else(|| client["createdAt"].clone(), number_value);
    client.insert("lastSeenAt".to_owned(), seen);
}

/// `loadDeviceStore`: the rows of the file, strictly. A missing file is an empty store; anything else that is wrong is the
/// reason the relay refuses to start (`failed to load device store: <reason>`).
pub(super) fn load(lane: &InLane<DurabilityIo>, path: &Path) -> Result<Map<String, Value>, String> {
    let bytes = match mixdog_fsio::read(lane, path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error.to_string()),
    };
    let text = js::decode_utf8(&bytes);
    let parsed = js::parse(&text).map_err(|error| mixdog_js::v8_json_parse_error(&text).unwrap_or_else(|| error.to_string()))?;
    let Value::Object(parsed) = parsed else { return Err("device store root is invalid".to_owned()) };
    let now = now_ms();
    let mut rows = Map::new();
    for id in mixdog_js::js_object_keys(&parsed) {
        let row_value = &parsed[id.as_str()];
        let valid = is_routing_id(id)
            && is_plain_object(row_value)
            && is_hex_hash(row_value.get("secretHash"))
            && row_value.get("clientTokenHash").is_none_or(|hash| !super::auth::truthy(hash) || is_hex_hash(Some(hash)))
            && row_value.get("clients").is_none_or(|clients| !super::auth::truthy(clients) || is_plain_object(clients));
        if !valid {
            return Err("device store row is invalid".to_owned());
        }
        let mut row = row_value.as_object().cloned().unwrap_or_default();
        apply_stored_version(&mut row, now);
        if !row.get("clientTokenHash").is_some_and(super::auth::truthy) {
            row.insert("clientTokenHash".to_owned(), Value::String(String::new()));
        }
        if !row.get("clients").is_some_and(super::auth::truthy) {
            row.insert("clients".to_owned(), Value::Object(Map::new()));
        }
        if let Some(Value::Object(clients)) = row.get_mut("clients") {
            let ids: Vec<String> = mixdog_js::js_object_keys(clients).into_iter().cloned().collect();
            for client_id in ids {
                let usable = is_routing_id(&client_id) && clients[client_id.as_str()].is_object() && is_hex_hash(clients[client_id.as_str()].get("tokenHash"));
                if !usable {
                    return Err("device store client row is invalid".to_owned());
                }
                if let Some(Value::Object(client)) = clients.get_mut(&client_id) {
                    apply_stored_client(client, now);
                }
            }
        }
        rows.insert(id.clone(), Value::Object(row));
    }
    Ok(rows)
}

/// `chmodSync(path, 0o600)`; the permission bits mean nothing elsewhere.
fn tighten(lane: &InLane<DurabilityIo>, path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        mixdog_fsio::set_permissions(lane, path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        let _ = (lane, path);
        Ok(())
    }
}

/// `saveDeviceStore`: the whole database through a temporary file of the same directory, then renamed over the old one, so an
/// interruption leaves the previous file intact. The replacement is owner-only. Fails when the write did not land; a chmod
/// that fails after the rename is only logged, because the state is committed by then.
pub(super) fn write(lane: &InLane<DurabilityIo>, path: &Path, rows: Map<String, Value>) -> std::io::Result<()> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    let temporary = directory.join(format!(".devices-{}-{}.tmp", std::process::id(), uuid::Uuid::new_v4()));
    let landed = (|| -> std::io::Result<()> {
        mixdog_fsio::create_dir_all(lane, directory)?;
        let mut options = mixdog_fsio::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(lane, &temporary)?;
        file.write_all(js::pretty(&Value::Object(rows)).as_bytes())?;
        drop(file);
        tighten(lane, &temporary)?;
        mixdog_fsio::rename(lane, &temporary, path)?;
        // Past the rename the state IS committed: a chmod hiccup (an exotic filesystem) is not a failed write.
        if let Err(error) = tighten(lane, path) {
            logline::emit(&logline::device_store_not_tightened(&error.to_string()));
        }
        Ok(())
    })();
    let _ = mixdog_fsio::remove_file(lane, &temporary);
    landed
}
