//! String identifiers. Each is a transparent string on the wire.

use serde::Deserialize;
use serde::Serialize;

macro_rules! string_id {
    ($($(#[doc = $doc:literal])* $name:ident;)*) => {$(
        $(#[doc = $doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    )*};
}

string_id! {
    /// A thread (today's session, including agent homes, group-room logs and sub-agent sessions).
    ThreadId;
    /// One run: user input to final answer.
    TurnId;
    /// A transcript item; assigned when the item starts and never reused.
    ItemId;
    /// Client-generated UUIDv7 that makes a mutation idempotent (P §9.1).
    OpId;
    /// A queued input entry of a busy thread.
    QueuedId;
    /// One subscription of one connection to one feed.
    SubscriptionId;
    /// Feed id: `app`, a thread id, or a scoped feed `<kind>:<key>` (see `ScopedFeedKind`).
    FeedId;
    /// 128-bit random feed epoch, lowercase hex.
    FeedEpoch;
    /// Process handle of `process/*` (client-chosen, connection-owned).
    ProcessHandle;
    /// Terminal tab id.
    TerminalTabId;
    /// Client-chosen, connection-owned watch id of `fs/watch`.
    WatchId;
    /// Client-chosen fuzzy file search session id.
    SearchSessionId;
    /// One read or write transfer.
    TransferId;
    /// A login flow (GitHub CLI, provider OAuth, MCP OAuth).
    LoginFlowId;
    /// Per-install desktop host id claimed with `host/claim`.
    HostId;
    /// Media job id.
    MediaJobId;
    /// A model tool call (the provider's call id as received).
    ToolCallId;
    /// A provider (`anthropic`, `openai-oauth`, `custom-<uuid>`, …).
    ProviderId;
}

/// Content digest `sha256:<64 lowercase hex>`.
// The only ways in are `FromStr`, `TryFrom<String>` and `Deserialize`, all of which
// check the format, so every value of this type is well formed.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(transparent)]
pub struct BlobDigest(String);

/// The text is not `sha256:` followed by 64 lowercase hex digits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidBlobDigest;

impl std::fmt::Display for InvalidBlobDigest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("not a blob digest: expected `sha256:` and 64 lowercase hex digits")
    }
}

impl std::error::Error for InvalidBlobDigest {}

impl BlobDigest {
    const PREFIX: &'static str = "sha256:";
    const HEX_LEN: usize = 64;

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for BlobDigest {
    type Error = InvalidBlobDigest;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let well_formed = value.strip_prefix(Self::PREFIX).is_some_and(|hex| {
            hex.len() == Self::HEX_LEN
                && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        });
        if well_formed {
            Ok(Self(value))
        } else {
            Err(InvalidBlobDigest)
        }
    }
}

impl std::str::FromStr for BlobDigest {
    type Err = InvalidBlobDigest;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::try_from(text.to_owned())
    }
}

impl<'de> Deserialize<'de> for BlobDigest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_from(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl std::fmt::Display for BlobDigest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(hex: &str) -> String {
        format!("sha256:{hex}")
    }

    #[test]
    fn blob_digest_is_validated_wherever_it_is_parsed() {
        let good = digest(&"0123456789abcdef".repeat(4));
        assert_eq!(good.parse::<BlobDigest>().unwrap().as_str(), good);
        assert_eq!(
            serde_json::from_str::<BlobDigest>(&format!("{good:?}"))
                .unwrap()
                .as_str(),
            good
        );
        assert_eq!(
            serde_json::to_string(&good.parse::<BlobDigest>().unwrap()).unwrap(),
            format!("{good:?}")
        );

        for bad in [
            String::new(),
            digest(""),
            digest(&"a".repeat(63)),
            digest(&"a".repeat(65)),
            digest(&"A".repeat(64)),
            digest(&"g".repeat(64)),
            digest(&format!("é{}", "a".repeat(62))),
            format!("sha512:{}", "a".repeat(64)),
            "a".repeat(64),
        ] {
            assert!(bad.parse::<BlobDigest>().is_err(), "{bad:?}");
            assert!(BlobDigest::try_from(bad.clone()).is_err(), "{bad:?}");
            assert!(
                serde_json::from_value::<BlobDigest>(serde_json::json!(bad)).is_err(),
                "{bad:?}"
            );
        }
        assert!(serde_json::from_value::<BlobDigest>(serde_json::json!(7)).is_err());
    }

    #[test]
    fn blob_descriptor_refuses_a_malformed_digest() {
        let text =
            |digest: &str| format!(r#"{{"digest":"{digest}","bytes":1,"mediaType":"text/plain"}}"#);
        let good = digest(&"b".repeat(64));
        assert!(serde_json::from_str::<crate::BlobDescriptor>(&text(&good)).is_ok());
        assert!(serde_json::from_str::<crate::BlobDescriptor>(&text("sha256:AB")).is_err());
    }
}
