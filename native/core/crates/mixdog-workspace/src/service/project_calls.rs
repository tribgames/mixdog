use super::*;

impl WorkspaceService {
    pub(super) async fn handle_project_list(self: &Arc<Self>) -> WsResult<Reply> {
        let value = |v: Value| Ok(Reply::Value(v));
        let projects: Vec<Value> = self.catalog.list().await?.iter().map(crate::catalog::project_json).collect();
        value(json!({ "projects": projects }))
    }

    pub(super) async fn handle_project_read(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        // Node's `inspectProjectPath` (project-catalog.mjs:32): any path, registered or not (the TUI asks it about a folder before
        // adding it as a project), resolved by `resolveProjectPath` and probed.
        let path = crate::pathguard::project_path(s(params, "path")?).ok_or_else(|| WsError::invalid("project path is required"))?;
        let probe = path.clone();
        let (exists, directory) = run_fallible(self.lanes.interactive, &cancel, move || {
            #[allow(clippy::disallowed_methods, reason = "lane job")]
            Ok((probe.exists(), probe.is_dir()))
        })
        .await?;
        value(json!({ "path": path.to_string_lossy(), "exists": exists, "directory": directory }))
    }

    pub(super) async fn handle_project_create(self: &Arc<Self>, req: &CoreRequest, op: Option<OpRecord>) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        value(json!({ "project": self.catalog.add(s(params, "path")?, &cancel, op).await? }))
    }

    pub(super) async fn handle_project_touch(self: &Arc<Self>, req: &CoreRequest, op: Option<OpRecord>) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        // Node's `touchProject` takes the registered Project (`knownProject`: a managed worktree names its owner).
        let (project, _) = self.scope(s(params, "path")?).await?;
        value(json!({ "project": self.catalog.touch(&project.to_string_lossy(), op).await? }))
    }

    pub(super) async fn handle_project_update(self: &Arc<Self>, req: &CoreRequest, op: Option<OpRecord>) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let alias = params.get("alias").and_then(Value::as_str).unwrap_or_default();
        value(json!({ "project": self.catalog.rename(s(params, "path")?, alias, op).await? }))
    }

    pub(super) async fn handle_project_delete(self: &Arc<Self>, req: &CoreRequest, op: Option<OpRecord>) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        // What holds the removed folder open is released with it (DS §4.1: Node's
        // `lspDisposeUnder` / `termDisposeUnder`); a hook that fails is named in the answer.
        let path = s(params, "path")?;
        let mut removed = self.catalog.remove(path, op).await?;
        let failures = self.releases.release_under(Path::new(path)).await;
        if !failures.is_empty() {
            removed["releaseFailures"] = failures.iter().map(|f| json!({ "name": f.name, "error": f.error })).collect();
        }
        value(removed)
    }

    pub(super) async fn handle_project_ensure_directory(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let path = self.catalog.ensure_directory(s(params, "path")?, &cancel).await?;
        value(json!({ "path": path.to_string_lossy() }))
    }

    pub(super) async fn handle_project_directory(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        // `projectDirectory`: the managed worktree's folder, else the Project's real path. `owner` asks for the
        // Project's real path even for a worktree (`startProjectTask`'s `canonicalDirectory(knownProject(path))`).
        let path = s(params, "path")?;
        match self.project_directory(path, opt_bool(params, "owner"), &cancel).await {
            Ok(folder) => value(json!({ "path": folder.to_string_lossy() })),
            // `standalone`: a folder that is no registered Project answers every file call as its own root (the desktop's
            // `standaloneRoot`): an absolute path of an existing directory, for a window's own call. A file or a missing
            // path keeps the registry's refusal.
            Err(refusal) if opt_bool(params, "standalone") && req.ctx.origin != mixdog_protocol::Origin::Relay => {
                let Ok(folder) = crate::pathguard::absolute_local_path(path) else { return Err(refusal) };
                let probe = folder.clone();
                let directory = run_fallible(self.lanes.interactive, &cancel, move || {
                    #[allow(clippy::disallowed_methods, reason = "lane job")]
                    Ok(probe.is_dir())
                })
                .await?;
                if !directory {
                    return Err(refusal);
                }
                value(json!({ "path": folder.to_string_lossy(), "standalone": true }))
            }
            Err(refusal) => Err(refusal),
        }
    }

    pub(super) async fn handle_project_fs_grant_describe(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let paths: Vec<String> =
            serde_json::from_value(params.get("paths").cloned().unwrap_or(Value::Null)).map_err(|_| WsError::invalid("paths are invalid."))?;
        let mint = params.get("mint").and_then(Value::as_bool).unwrap_or(true);
        let projects: Vec<PathBuf> = self.catalog.list().await?.into_iter().map(|row| PathBuf::from(row.path)).collect();
        value(json!(self.desktop_grants()?.describe(&paths, mint, &projects).await?))
    }

    pub(super) async fn handle_project_fs_grant_redeem(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let granted = self.desktop_grants()?.redeem(s(params, "accessToken")?, s(params, "projectPath")?, s(params, "relPath")?).await?;
        value(json!({ "root": granted.root.to_string_lossy(), "rel": granted.rel, "absolute": granted.absolute.to_string_lossy() }))
    }

    pub(super) async fn handle_project_fs_local_page_revoke_owner(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        self.page_server()?.revoke_owner(s(params, "ownerId")?);
        value(json!({}))
    }

    pub(super) async fn handle_project_fs_local_page_origin(self: &Arc<Self>) -> WsResult<Reply> {
        let value = |v: Value| Ok(Reply::Value(v));
        value(Value::String(self.page_server()?.origin().await?))
    }

    pub(super) async fn handle_project_fs_local_page_asset_type(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let root = PathBuf::from(s(params, "root")?);
        let file = PathBuf::from(s(params, "file")?);
        let data_root = params.get("dataRoot").and_then(Value::as_str).map(PathBuf::from);
        let found = crate::pageserver::policy::page_asset_type(&root, &file, data_root.as_deref());
        value(json!({ "type": found.unwrap_or("") }))
    }

    pub(super) async fn handle_project_fs_local_page_virtual(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct VirtualFileParam {
            path: String,
            #[serde(default)]
            data_base64: Option<String>,
            #[serde(default)]
            text: Option<String>,
            #[serde(rename = "type")]
            content_type: String,
        }
        let files: Vec<VirtualFileParam> =
            serde_json::from_value(params.get("files").cloned().unwrap_or(Value::Null)).map_err(|_| WsError::invalid("files are invalid."))?;
        let owner_id = match params.get("ownerId") {
            None | Some(Value::Null) => None,
            Some(owner) => Some(owner.as_str().ok_or_else(|| WsError::invalid("ownerId is invalid."))?.to_owned()),
        };
        let files = crate::pageserver::virtual_pages::build_files(files.into_iter().map(|file| crate::pageserver::virtual_pages::VirtualFileInput {
            path: file.path,
            data_base64: file.data_base64,
            text: file.text,
            content_type: file.content_type,
        }))?;
        let url = self.page_server()?.lease_virtual(files, owner_id).await?;
        value(json!({ "url": url }))
    }

    pub(super) async fn handle_project_recovery_directory(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.catalog.resolve(s(params, "path")?).await?;
        value(json!({ "path": self.fs.recovery.store_path(&root).to_string_lossy() }))
    }

    pub(super) async fn handle_project_task_workspace(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let path = self.task_workspace(&cancel).await?;
        value(json!({ "path": path.to_string_lossy() }))
    }

    pub(super) async fn handle_project_code_graph(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let mode = s(params, "mode")?;
        let query = s(params, "query")?.trim();
        // Node's `codeGraphQueryIn`: the same checks, arguments and text.
        let symbols = mode == "symbols";
        if !matches!(mode, "find_symbol" | "references" | "symbols") {
            return Err(WsError::invalid("mode is invalid."));
        }
        if query.is_empty() || query.encode_utf16().count() > if symbols { 1_024 } else { 256 } {
            return Err(WsError::invalid(if symbols { "File path is invalid." } else { "Symbol is invalid." }));
        }
        let args = if symbols { json!({ "mode": mode, "files": query, "limit": 200 }) } else { json!({ "mode": mode, "symbols": query, "limit": 20 }) };
        let root = self.root_of(req.ctx.origin, params, "path").await?;
        let graph = self.code_graph.as_ref().ok_or_else(|| WsError::new(Reason::Unsupported, "The code graph is not available."))?;
        value(Value::String(graph.query(&root, args, &cancel).await?))
    }
}
