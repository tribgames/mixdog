//! Params of `ui/relayPayloadRefused`: the relay refused an oversize frame of this core's leg (Node's `relay-payload-refused` desktop event).

use serde::Deserialize;
use serde::Serialize;

/// The size of the refused frame and the relay's ceiling, each null when the relay reported none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct UiRelayPayloadRefusedParams {
    pub bytes: Option<u64>,
    pub limit: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::UiRelayPayloadRefusedParams;
    use serde_json::json;

    #[test]
    fn the_sizes_travel_as_numbers_or_null() {
        let params = UiRelayPayloadRefusedParams { bytes: Some(70_000_000), limit: None };
        assert_eq!(serde_json::to_value(params).unwrap(), json!({ "bytes": 70_000_000, "limit": null }));
        assert_eq!(serde_json::from_value::<UiRelayPayloadRefusedParams>(json!({ "bytes": null, "limit": 5 })).unwrap().limit, Some(5));
    }
}
