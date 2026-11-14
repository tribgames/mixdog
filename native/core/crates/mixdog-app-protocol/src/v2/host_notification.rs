//! Params of the host notification methods that the core sends to the desktop beside `host/notification/show`.

use serde::Deserialize;
use serde::Serialize;

/// `host/notification/close`: closes the toasts still showing for a server's connection (its notifier ended), so a toast cannot be
/// clicked after the link it is about is gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostNotificationCloseParams {
    pub connection_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_close_params_keep_their_wire_name() {
        let params: HostNotificationCloseParams = serde_json::from_str(r#"{"connectionId":"srv"}"#).expect("params");
        assert_eq!(serde_json::to_string(&params).expect("json"), r#"{"connectionId":"srv"}"#);
    }
}
