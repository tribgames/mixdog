//! Params of the desktop's residual methods (`DesktopResidualService`, mixdog-core-domains `domains/desktop_residual.rs`): the
//! logic of the desktop's session-attachments.ts, transcript-file-links.ts, workflow-config.ts and system-fonts.ts. The service
//! answers untyped JSON, so the results are `JsonValue`.

use serde::Deserialize;
use serde::Serialize;

/// Params of `desktop/link/resolve`: a conversation link's href and the session's folder. Answers `{path: string | null}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopLinkResolveParams {
    pub href: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Params of `desktop/link/resolvePath`: an already decoded path and the session's folder. Answers `{path: string | null}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopLinkResolvePathParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Params of `desktop/attachment/resolve` and `desktop/attachment/stage`: an attachment (content hash) of a session.
/// Resolve answers `{attachment: {id, name, mimeType, kind, size}, bytes, viewName, dataUrl}`; stage answers `{path, attachment}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopAttachmentParams {
    pub session_id: String,
    pub attachment_id: String,
}

/// Params of `desktop/workflowConfig/read`: the JSONC settings file. Answers `{config: object | null}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopWorkflowConfigReadParams {
    pub path: String,
}

/// Params of `desktop/fonts/list`: none. Answers `{families: string[]}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopFontsListParams {}
