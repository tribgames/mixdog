//! Params and results of the PC access methods: the secure-desktop service as Computer Use setup on
//! Windows grants it (`apps/desktop/src/main/pc-access.ts`), read and approved through the core.

use serde::Deserialize;
use serde::Serialize;

/// Params of `pcAccess/readiness`: none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PcAccessReadinessParams {}

/// Params of `pcAccess/approve`: none. The person is at the PC: this is the one UAC prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PcAccessApproveParams {}

/// The revocations still owed to the service: the access keys of removed pairings whose revoke is not confirmed,
/// and a count that is above zero while revocations may be missing (a damaged or full record, an unreadable key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PcAccessOwed {
    pub keys: Vec<String>,
    pub unknown: u32,
}

/// Result of `pcAccess/readiness`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PcAccessReadiness {
    /// The service is installed and matches the bundled one.
    pub installed: bool,
    /// The service is installed but differs from the bundled one: Approve updates it.
    pub outdated: bool,
    /// Paired phones' keys the installed service holds.
    pub enrolled_keys: u32,
    /// Paired phones' keys it lacks (all of them while it is not installed): what Approve enrolls.
    pub missing_keys: Vec<String>,
    /// Revocations still owed; nothing is enrolled while any is owed, until Approve applies them.
    pub owed: PcAccessOwed,
    /// PC access exists on this machine (false where the helper cannot be asked).
    pub supported: bool,
    /// Another Windows account owns the service (informational: Approve changes nothing).
    pub other_user: bool,
}

/// How an Approve ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum PcAccessOutcome {
    Installed,
    Updated,
    Enrolled,
    Declined,
    Failed,
    InProgress,
    /// Nothing to install, enroll or revoke.
    Nothing,
    /// Another Windows account owns the service.
    OtherUser,
    /// PC access cannot be asked on this machine.
    Unavailable,
}

/// Result of `pcAccess/approve`. `detail` is an English diagnostic for logs, never shown as copy; `exitCode` is
/// the installer's own exit code when a `failed` came from it exiting (the row shows it as a translated line).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct PcAccessApproval {
    pub outcome: PcAccessOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}
