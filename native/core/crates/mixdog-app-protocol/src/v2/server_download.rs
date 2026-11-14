//! Params and answers of "download to this PC" (`transfer/serverDownload/*`): the stepwise, cancellable copy of one file of a
//! server (ssh) window into this PC's download folder, served by the workspace service of this PC's core through its link to
//! the server. The desktop's main process is the only caller (it holds the window's server id and the folder). The answers of
//! `abort` (whether a download was cancelled) and `check` (whether the path is a file this core downloaded, the only kind that
//! may be handed to the OS) are a bare boolean, so those two rows have the result `JsonValue`.

use serde::Deserialize;
use serde::Serialize;

/// Params of `transfer/serverDownload/begin`: the file `rel` of the server's folder `root`, copied into `downloads_dir` of this PC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferServerDownloadBeginParams {
    /// The server window's connection id (the id of the link this PC holds to the server).
    pub server_id: String,
    /// This PC's download folder (created when missing).
    pub downloads_dir: String,
    pub root: String,
    pub rel: String,
}

/// The answer of `transfer/serverDownload/begin`: the download, the plain name it will take and the file's size in bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TransferServerDownloadBeginResponse {
    pub download_id: String,
    pub name: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub size: u64,
}

/// Params of `transfer/serverDownload/step`, `/finish` and `/abort`: the download `begin` answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferServerDownloadIdParams {
    pub download_id: String,
}

/// The answer of `transfer/serverDownload/step`: the bytes written so far, the file's size, and whether it is all here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TransferServerDownloadStepResponse {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub received: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub size: u64,
    pub done: bool,
}

/// The answer of `transfer/serverDownload/finish`: where the file now is, under the first free name in the folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TransferServerDownloadFinishResponse {
    pub path: String,
}

/// Params of `transfer/serverDownload/check`: a path on this PC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferServerDownloadCheckParams {
    pub path: String,
}
