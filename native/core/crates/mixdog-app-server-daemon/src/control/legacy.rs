//! The refusal surface for 1.4.5 clients (LR §7.1, SPEC R23): fixed bodies, no behaviour.
//!
//! `/health` answers as a daemon that is newer than any 1.4.5 client (`protocol:1`, maximal
//! revision), so a 1.4.5 client attaches and meets the `426` on `/client/register` instead of
//! trying to replace the core. There is no `buildHash`, so the 1.4.5 SSH installer can never
//! classify the core as one it installed and never stops it.

use serde::Serialize;

use super::http::Response;

pub const LEGACY_PROTOCOL: u32 = 1;
pub const LEGACY_REVISION: u32 = 2_147_483_647;

pub const UPDATE_TEXT: &str = "A new version is required. Please update to continue.";

#[derive(Debug, Clone)]
pub struct Legacy {
    pub pid: u32,
    pub version: String,
    /// The run and build identity the discovery file names (`core.instanceId`, `core.build`): a
    /// desktop that probed the core compares them, so a process that reused the pid is refused.
    /// Not `buildHash`: that name would let the 1.4.5 SSH installer classify the core.
    pub instance_id: String,
    pub build: String,
    pub update_text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health<'a> {
    status: &'static str,
    pid: u32,
    protocol: u32,
    revision: u32,
    version: &'a str,
    instance_id: &'a str,
    build: &'a str,
    package_version: String,
    clients: u32,
    busy: u32,
}

#[derive(Serialize)]
struct Refusal<'a> {
    error: &'a str,
    code: &'static str,
}

impl Legacy {
    pub fn health(&self) -> Response {
        Response::json(
            200,
            &Health {
                status: "ok",
                pid: self.pid,
                protocol: LEGACY_PROTOCOL,
                revision: LEGACY_REVISION,
                version: &self.version,
                instance_id: &self.instance_id,
                build: &self.build,
                package_version: format!("{} \u{2014} {}", self.version, self.update_text),
                clients: 0,
                busy: 0,
            },
        )
    }

    /// `POST /client/register` and every other legacy route.
    pub fn refuse(&self) -> Response {
        Response::json(426, &Refusal { error: &self.update_text, code: "clientOutdated" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy() -> Legacy {
        Legacy {
            pid: 42,
            version: "1.4.6".into(),
            instance_id: "inst-1".into(),
            build: "dev".into(),
            update_text: "Update Mixdog.".into(),
        }
    }

    #[test]
    fn health_has_the_fixed_shape() {
        let response = legacy().health();
        assert_eq!(response.status, 200);
        let json: serde_json::Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "status": "ok", "pid": 42, "protocol": 1, "revision": 2147483647,
                "version": "1.4.6", "instanceId": "inst-1", "build": "dev", "packageVersion": "1.4.6 \u{2014} Update Mixdog.",
                "clients": 0, "busy": 0
            })
        );
        assert!(json.get("buildHash").is_none());
    }

    #[test]
    fn refusal_carries_the_update_text() {
        let response = legacy().refuse();
        assert_eq!(response.status, 426);
        let json: serde_json::Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(json["error"], "Update Mixdog.");
        assert_eq!(json["code"], "clientOutdated");
    }
}
