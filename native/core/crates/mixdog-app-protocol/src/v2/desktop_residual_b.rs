//! Params of the desktop's second batch of residual methods (`DesktopResidualBService`, mixdog-core-domains `domains/desktop_residual_b.rs`).
//! The service answers untyped JSON, so the results are `JsonValue`.

use serde::Deserialize;
use serde::Serialize;

/// Params of `desktop/localLink/open`: the project folder (absolute), the link's href, and the path the user confirmed (an executable target).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopLocalLinkOpenParams {
    pub project_path: String,
    pub href: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_path: Option<String>,
}

/// Params of `desktop/attachment/write`: a `data:` URL and the attachment's name (any text; its extension is checked against an allowlist).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopAttachmentWriteParams {
    pub data_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Params of `desktop/attachment/thumbnail`: the attachment's content hash (anything else answers `dataUrl: null`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopAttachmentThumbnailParams {
    pub attachment_ref: String,
}

/// Params of `desktop/launchVersion/record`: the record file, the launched version and the process arguments (`--updated` marks a relaunch after an update).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopLaunchVersionRecordParams {
    pub path: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub argv: Vec<String>,
}

/// Params of `desktop/launchVersion/acknowledge`: the record file and the version whose notice was shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopLaunchVersionAcknowledgeParams {
    pub path: String,
    pub version: String,
}

/// Params of `desktop/modelBootstrap/read`: none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopModelBootstrapReadParams {}

/// Params of `desktop/nativeToolCache/gc`: the kinds of native tool a bundled copy now serves (`graph`, `patch`, `spawn`, `supervisor`; others are ignored).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopNativeToolCacheGcParams {
    pub bundled_kinds: Vec<String>,
}

/// Params of `desktop/userFile/write`: the file and exactly one of `text` (UTF-8) and `dataBase64`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopUserFileWriteParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

/// Params of `desktop/computer/inputAccess/request`: none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopComputerInputAccessRequestParams {}
