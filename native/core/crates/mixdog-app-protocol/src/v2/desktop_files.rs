//! Params of the desktop file-grant and local page server methods: the one-file grants the
//! desktop's main process kept in `selected-file-access.ts` and the page leases it kept in
//! `local-page-server.ts`, now answered by the core.

use serde::Deserialize;
use serde::Serialize;

/// Params of `projectFs/grant/describe` (Node's `describeLocalPaths`, selected-file-access.ts): stat each path (1 to 100)
/// and say which project it is in, or, when `mint` is true and it is outside every project, hand back a one-file grant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ProjectFsGrantDescribeParams {
    pub paths: Vec<String>,
    /// Mint a grant for a file outside every project (the desktop sends `true` unless a link only needs its name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mint: Option<bool>,
    /// The session the paths are described for; its project list decides which project owns a path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// Params of `projectFs/grant/redeem` (Node's `requireGrant`, selected-file-access.ts): the file a grant names, checked
/// against the path the caller asks for; answers the file's folder and name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsGrantRedeemParams {
    pub access_token: String,
    pub project_path: String,
    pub rel_path: String,
}

/// Params of `projectFs/localPage/revokeOwner` (Node's `revokeLocalPagesForOwner`, local-page-server.ts): end every page
/// lease an owner (a desktop window) holds. Internal: the desktop's main process calls it when a window closes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsLocalPageRevokeOwnerParams {
    pub owner_id: String,
}

/// Params of `projectFs/localPage/origin` (local-page-server.ts `localPageOrigin`): none; answers the page server's origin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsLocalPageOriginParams {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describe_params_are_camel_case_and_skip_none() {
        let p: ProjectFsGrantDescribeParams = serde_json::from_value(json!({"paths": ["a"]})).unwrap();
        assert_eq!(p.mint, None);
        assert_eq!(serde_json::to_value(&p).unwrap(), json!({"paths": ["a"]}));
        let p: ProjectFsGrantDescribeParams = serde_json::from_value(json!({"paths": [], "mint": false, "sessionId": "s"})).unwrap();
        assert_eq!(p.session_id.as_deref(), Some("s"));
        assert_eq!(serde_json::to_value(&p).unwrap(), json!({"paths": [], "mint": false, "sessionId": "s"}));
    }

    #[test]
    fn redeem_and_owner_params_use_camel_case() {
        let p: ProjectFsGrantRedeemParams = serde_json::from_value(json!({"accessToken": "t", "projectPath": "p", "relPath": "r"})).unwrap();
        assert_eq!((p.access_token.as_str(), p.project_path.as_str(), p.rel_path.as_str()), ("t", "p", "r"));
        let p: ProjectFsLocalPageRevokeOwnerParams = serde_json::from_value(json!({"ownerId": "w"})).unwrap();
        assert_eq!(p.owner_id, "w");
        assert_eq!(serde_json::to_value(ProjectFsLocalPageOriginParams {}).unwrap(), json!({}));
    }
}
