//! `initialize.capabilities.remote`: Node's relay challenge flags as this core offers them to a phone, from one table
//! (`remote_flags.json`). A flag is on only when every Node call it opens on the phone's page is served for a phone end to end
//! (the table names the core method the phone's adapter calls) and nothing else it needs waits; `nativePush` also only while the
//! relay offers native platforms (Node's `relayNativePlatforms().length > 0`, `remote-relay-client-lifecycle.ts:150`).

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::v1::RemoteCapabilities;

/// The table, as `remote_flags.json` holds it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteFlagTable {
    pub note: String,
    pub flags: BTreeMap<String, RemoteFlag>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteFlag {
    /// Node call → how a phone gets it.
    pub calls: BTreeMap<String, FlagCall>,
    /// What the flag waits for beyond its calls.
    #[serde(default)]
    pub unserved: Option<String>,
    /// A numeric flag's value when it is on (the WebRTC live view's version).
    #[serde(default)]
    pub version: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FlagCall {
    /// The core method the phone's adapter calls for it: served end to end.
    #[serde(default)]
    pub method: Option<String>,
    /// Who brings it while it is not served.
    #[serde(default)]
    pub owner: Option<String>,
}

pub fn table() -> RemoteFlagTable {
    serde_json::from_str(include_str!("remote_flags.json")).expect("remote_flags.json is the table")
}

impl RemoteFlag {
    /// Every call served end to end and nothing else waiting.
    pub fn served(&self) -> bool {
        self.unserved.is_none() && self.calls.values().all(|call| call.method.is_some())
    }
}

/// The flags this core offers a phone; `native_push_offered`: the relay offers native platforms now.
pub fn remote_capabilities(native_push_offered: bool) -> RemoteCapabilities {
    let flags = table()
        .flags
        .into_iter()
        .map(|(name, flag)| {
            let on = flag.served() && (name != "nativePush" || native_push_offered);
            let value = match flag.version {
                Some(version) => Value::from(if on { version } else { 0 }),
                None => Value::Bool(on),
            };
            (name, value)
        })
        .collect::<serde_json::Map<_, _>>();
    serde_json::from_value(Value::Object(flags)).expect("remote_flags.json names every flag of RemoteCapabilities")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    /// The table names exactly the flags `RemoteCapabilities` carries, each call is either served or owned, never both, and a
    /// numeric flag says its value.
    #[test]
    fn the_table_is_whole() {
        let table = table();
        let fields: BTreeSet<String> = serde_json::to_value(RemoteCapabilities::default()).unwrap().as_object().unwrap().keys().cloned().collect();
        assert_eq!(table.flags.keys().cloned().collect::<BTreeSet<_>>(), fields, "the table's flags are RemoteCapabilities'");
        for (name, flag) in &table.flags {
            for (call, how) in &flag.calls {
                assert!(how.method.is_some() != how.owner.is_some(), "{name}.{call}: a method or an owner, one of them");
            }
            let numeric = serde_json::to_value(RemoteCapabilities::default()).unwrap()[name].is_number();
            assert_eq!(flag.version.is_some(), numeric, "{name}: a numeric flag says its version, a boolean one does not");
        }
    }

    /// Every method the table names is in the method table, a relay connection may call it (a request) or send it (a notification).
    #[test]
    fn every_served_call_is_a_method_a_phone_may_use() {
        let methods: Value = serde_json::from_str(mixdog_testkit::fixture!("schema/method_table.json")).unwrap();
        let usable = |name: &str| {
            methods["clientMethods"].as_array().unwrap().iter().any(|entry| {
                entry["method"] == name && entry["origins"].as_array().is_some_and(|origins| origins.iter().any(|origin| origin == "relay"))
            }) || methods["clientNotifications"].as_array().unwrap().iter().any(|entry| entry["method"] == name)
        };
        for (name, flag) in table().flags {
            for (call, how) in flag.calls {
                if let Some(method) = how.method {
                    assert!(usable(&method), "{name}.{call}: `{method}` is not a method a relay connection may use");
                }
            }
        }
    }
}
