//! The receipt of one new-task submission (`apps/desktop/src/main/new-task-requests.ts`): the bytes Node keeps in
//! `<userData>/new-task-receipts/<sha256(id)>.json`, read and written here as Node does, so the same file is read by either.
//! Pure: the lane jobs that read and write it belong to the caller.

use serde_json::Map;
use serde_json::Value;

/// `RECEIPT_MAX_BYTES`: a larger file is no receipt.
pub const MAX_BYTES: u64 = 4096;

/// `Phase`: `configured` records that the draft was applied; `accepted` that the first prompt was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Reserved,
    Configured,
    Accepted,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Reserved => "reserved",
            Phase::Configured => "configured",
            Phase::Accepted => "accepted",
        }
    }

    fn of(name: &str) -> Option<Self> {
        [Phase::Reserved, Phase::Configured, Phase::Accepted].into_iter().find(|phase| phase.name() == name)
    }
}

/// A receipt as stored. The object is kept whole, in its key order: a commit rewrites `phase` in place, as
/// `{ ...receipt, phase }` does.
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt(Map<String, Value>);

/// `isSessionId` (`SESSION_ID_PATTERN`).
pub fn is_session_id(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

impl Receipt {
    /// `{ signature, sessionId, phase: 'reserved' }`, refused when `refused`.
    pub fn reserved(signature: &str, session_id: &str, refused: bool) -> Self {
        let mut map = Map::new();
        map.insert("signature".into(), signature.into());
        map.insert("sessionId".into(), session_id.into());
        map.insert("phase".into(), Phase::Reserved.name().into());
        if refused {
            map.insert("refused".into(), Value::Bool(true));
        }
        Self(map)
    }

    /// `readReceipt`'s judgement of a file's bytes: `None` for what is no receipt (empty, NUL-filled, truncated, oversized, of
    /// another shape), which binds nothing.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() as u64 > MAX_BYTES {
            return None;
        }
        let Value::Object(map) = crate::parse_json_text(bytes).ok()? else { return None };
        let receipt = Self(map);
        let valid = receipt.0.get("signature").is_some_and(Value::is_string)
            && receipt.0.get("sessionId").and_then(Value::as_str).is_some_and(is_session_id)
            && receipt.0.get("phase").and_then(Value::as_str).and_then(Phase::of).is_some();
        valid.then_some(receipt)
    }

    pub fn signature(&self) -> &str {
        self.0.get("signature").and_then(Value::as_str).unwrap_or_default()
    }

    pub fn session_id(&self) -> &str {
        self.0.get("sessionId").and_then(Value::as_str).unwrap_or_default()
    }

    pub fn phase(&self) -> Phase {
        self.0.get("phase").and_then(Value::as_str).and_then(Phase::of).unwrap_or(Phase::Reserved)
    }

    /// `stored?.refused === true`.
    pub fn refused(&self) -> bool {
        self.0.get("refused") == Some(&Value::Bool(true))
    }

    /// `{ ...receipt, phase }`.
    pub fn with_phase(&self, phase: Phase) -> Self {
        let mut map = self.0.clone();
        map.insert("phase".into(), phase.name().into());
        Self(map)
    }

    /// `JSON.stringify(receipt)`.
    pub fn to_bytes(&self) -> Vec<u8> {
        mixdog_js::json_stringify(&Value::Object(self.0.clone())).into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_that_is_no_receipt_binds_nothing_and_a_receipt_round_trips_byte_for_byte() {
        let text = r#"{"signature":"s","sessionId":"sess_desktop_a-b","phase":"configured","refused":true}"#;
        let receipt = Receipt::parse(text.as_bytes()).expect("a receipt");
        assert_eq!((receipt.phase(), receipt.refused()), (Phase::Configured, true));
        assert_eq!(receipt.to_bytes(), text.as_bytes());
        assert_eq!(receipt.with_phase(Phase::Accepted).to_bytes(), text.replace("configured", "accepted").as_bytes());
        for bytes in [&b""[..], &[0u8; 40][..], br#"{"signature":"s","sessionId":"x y","phase":"reserved"}"#, br#"{"signature":1,"sessionId":"x","phase":"reserved"}"#, br#"{"signature":"s","sessionId":"x","phase":"done"}"#, b"[]", b"null", br#"{"signature":"s""#] {
            assert_eq!(Receipt::parse(bytes), None, "{}", String::from_utf8_lossy(bytes));
        }
        let padded = format!(r#"{{"signature":"s","sessionId":"x","phase":"reserved","pad":"{}"}}"#, "p".repeat(4096));
        assert_eq!(Receipt::parse(padded.as_bytes()), None);
    }
}