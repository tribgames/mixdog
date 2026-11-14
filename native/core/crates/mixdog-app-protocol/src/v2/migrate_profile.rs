//! Params and results of the desktop-profile adoption methods: a core that was started without the Electron profile
//! (it ran standalone, or before the desktop knew the profile directory) is told the profile later, and the files the
//! second generation of the profile move relocates (`mixdog_migrate::desktop_profile::supplement`) are moved then.

use serde::Deserialize;
use serde::Serialize;

/// Params of `migrate/profile/status`: none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MigrateProfileStatusParams {}

/// Result of `migrate/profile/status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MigrateProfileStatus {
    /// The generation of the profile move the data dir is at (1 until the second generation completed).
    pub generation: u32,
    /// The profile directory the core has recorded (the journal's, else the migration's), if any.
    pub profile: Option<String>,
    /// A profile is recorded: a different one named later is refused.
    pub completed_with_profile: bool,
}

/// Params of `migrate/profile/adopt`: the Electron profile directory (absolute, existing).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MigrateProfileAdoptParams {
    pub user_data: String,
}

/// Result of `migrate/profile/adopt`: the generation reached and the profile files whose bytes now stand in the data dir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MigrateProfileAdopted {
    pub generation: u32,
    pub moved: Vec<String>,
}
