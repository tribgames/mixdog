use super::*;

impl WorkspaceService {
    pub(super) async fn handle_project_fs_list_dir(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (root, rel) = (self.root(req.ctx.origin, params).await?, s(params, "rel")?.to_owned());
        let items = run_fallible(self.lanes.interactive, &cancel, move || fsops::list_dir(&root, &rel)).await?;
        value(json!(items))
    }

    pub(super) async fn handle_project_fs_read_text(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        // A connection carries at most 512 KiB per answer, a file up to 10 MiB: the reader asks for the text a window at a time
        // (code points, so no character is split) and joins the pieces. The first window reads the file once; `readId` names that
        // read, and the windows after it are served from it (readwindow.rs), so the pieces are one version of the file.
        let max = req.params.get("maxChars").and_then(Value::as_u64).map(|max| max as usize);
        if let (Some(max), Some(id)) = (max, req.params.get("readId").and_then(Value::as_str)) {
            let from = req.params.get("fromChar").and_then(Value::as_u64).unwrap_or(0) as usize;
            return value(self.read_windows.next(&Self::owner(req), id, from, max)?);
        }
        // Taken before any await: a close that comes while the file is read is seen by `begin`.
        let first_window = self.read_windows.first_window(&Self::owner(req));
        let (root, rel) = self.file_target(req, params).await?;
        let authorized = opt_bool(params, "authorized");
        let file =
            run_fallible(
                self.lanes.interactive,
                &cancel,
                move || {
                    if authorized { fsops::read_text_authorized(&root, &rel) } else { fsops::read_text(&root, &rel) }
                },
            )
            .await?;
        let answer = json!(file);
        value(match max {
            Some(max) => self.read_windows.begin(&first_window, answer, max),
            None => answer,
        })
    }

    pub(super) async fn handle_project_fs_stat(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (root, rel) = self.file_target(req, params).await?;
        value(json!(run_fallible(self.lanes.interactive, &cancel, move || fsops::stat(&root, &rel)).await?))
    }

    pub(super) async fn handle_project_fs_entry_path(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let (root, rel) = self.file_target(req, params).await?;
        value(json!({ "path": project_entry_path(&root, &rel)?.to_string_lossy() }))
    }

    pub(super) async fn handle_project_fs_browse_dirs(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let path = s(params, "path")?.to_owned();
        let include_hidden = params.get("includeHidden").and_then(Value::as_bool);
        value(run_fallible(self.lanes.interactive, &cancel, move || crate::browse::browse_dirs(&path, include_hidden)).await?)
    }

    pub(super) async fn handle_project_fs_preview_file(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (root, rel) = self.file_target(req, params).await?;
        // A paired device's image, audio or video also gets a lease the relay media lane streams (Node's
        // `authorizedMediaFile`); a pdf, a call of a window and a connection that is no paired device get none and
        // read ranges.
        let lease = (req.ctx.origin == mixdog_protocol::Origin::Relay)
            .then(|| {
                self.phone_grants_for(req).ok().map(|(_, credential, _)| {
                    let authorize = self.preview_authority(req, &root, &rel, &credential);
                    (self.project_leases.clone(), credential, authorize)
                })
            })
            .flatten();
        value(
            run_fallible(self.lanes.interactive, &cancel, move || {
                let mut preview = crate::preview::preview_file(&root, &rel)?;
                if let Some((leases, device, authorize)) = lease
                    && preview["kind"] != "pdf"
                {
                    let mime = preview["mime"].as_str().unwrap_or_default().to_owned();
                    preview["mediaAssetId"] = Value::String(leases.mint_with_authority(&root, &rel, &mime, &device, Some(authorize))?);
                }
                Ok(preview)
            })
            .await?,
        )
    }

    pub(super) async fn handle_project_fs_preview_range(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (root, rel) = self.file_target(req, params).await?;
        let offset = params.get("offset").and_then(Value::as_u64).ok_or_else(|| WsError::invalid("offset is invalid."))?;
        let length = params
            .get("length")
            .and_then(Value::as_u64)
            .filter(|n| (1..=crate::preview::RANGE_MAX).contains(n))
            .ok_or_else(|| WsError::invalid("length is invalid."))?;
        value(run_fallible(self.lanes.interactive, &cancel, move || crate::preview::preview_range(&root, &rel, offset, length)).await?)
    }

    pub(super) async fn handle_project_fs_read_local(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let path = s(params, "path")?.to_owned();
        if params.get("paged").and_then(Value::as_bool) == Some(true) {
            // The checks of the whole read, then the file held open as a transfer of this connection to page through.
            let (owner, t) = (Self::owner(req), self.transfers.clone());
            return value(
                run_fallible(self.lanes.interactive, &cancel, move || {
                    let (file, name, _) = fsops::local_file(&path)?;
                    let opened = t.begin_local_read(&owner, &file.to_string_lossy())?;
                    Ok(json!({ "name": name, "size": opened.size, "mimeType": opened.mime_type, "transferId": opened.transfer_id, "version": opened.version }))
                })
                .await?,
            );
        }
        value(json!(run_fallible(self.lanes.interactive, &cancel, move || fsops::read_local(&path)).await?))
    }

    pub(super) async fn handle_project_fs_stat_local(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let paths: Vec<String> = params
            .get("paths")
            .and_then(Value::as_array)
            .ok_or_else(|| WsError::invalid("paths is invalid."))?
            .iter()
            .filter_map(|p| p.as_str().map(str::to_owned))
            .collect();
        let entries = run_fallible(self.lanes.interactive, &cancel, move || {
            Ok(paths.iter().map(|p| fsops::stat_local(p).map(|e| json!(e)).unwrap_or_else(|e| json!({ "error": e.message }))).collect::<Vec<_>>())
        })
        .await?;
        value(json!(entries))
    }

    pub(super) async fn handle_project_fs_write_text(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (root, rel) = self.file_target(req, params).await?;
        let (content, expected) = (s(params, "content")?.to_owned(), s(params, "expectedContent")?.to_owned());
        let encoding = params.get("encoding").and_then(Value::as_str).map(fsops::parse_encoding).transpose()?;
        let lone = (Self::held_lone(req, "/content"), Self::held_lone(req, "/expectedContent"));
        let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel])?).await;
        let fs = self.fs.clone();
        let (note_root, note_rel) = (root.clone(), rel.clone());
        let mtime = run_fallible(self.lanes.durability, &cancel, move || fs.write_text(&root, &rel, &content, &expected, encoding, lone)).await?;
        self.note_written(&note_root, &[&note_rel]);
        value(json!({ "mtimeMs": mtime }))
    }

    pub(super) async fn handle_project_fs_write_text_batch(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let files = Self::batch_files(req, params)?;
        let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
        let _claim = self.paths.acquire(Self::claim_keys(&root, &rels)?).await;
        let fs = self.fs.clone();
        let (note_root, note_rels) = (root.clone(), files.iter().map(|f| f.rel_path.clone()).collect::<Vec<_>>());
        run_fallible(self.lanes.durability, &cancel, move || fs.write_batch(&root, &files, true)).await?;
        self.note_written(&note_root, &note_rels);
        value(json!({}))
    }

    pub(super) async fn handle_project_fs_create(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let (dir, name, directory) = (s(params, "relDir")?.to_owned(), s(params, "name")?.to_owned(), opt_bool(params, "directory"));
        // Node names the segments invalid before it joins and claims the path.
        fsops::entry_segments(&name)?;
        let target = PathBuf::from(&dir).join(name.replace('\\', "/"));
        let _claim = self.paths.acquire(Self::claim_keys(&root, &[&target.to_string_lossy()])?).await;
        let note_root = root.clone();
        run_fallible(self.lanes.durability, &cancel, move || fsops::create_entry(&root, &dir, &name, directory)).await?;
        self.note_written(&note_root, &[&target.to_string_lossy()]);
        value(json!({}))
    }

    pub(super) async fn handle_project_fs_rename(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let (rel, new_name) = (s(params, "rel")?.to_owned(), s(params, "newName")?.to_owned());
        let destination = fsops::rename_destination_rel(&rel, &new_name)?;
        let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel, &destination])?).await;
        let (note_root, note_rel) = (root.clone(), rel.clone());
        run_fallible(self.lanes.durability, &cancel, move || fsops::rename_entry(&root, &rel, &new_name)).await?;
        self.note_written(&note_root, &[&note_rel, &destination]);
        value(json!({}))
    }

    pub(super) async fn handle_project_fs_move_or_copy(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let (rel, target) = (s(params, "rel")?.to_owned(), s(params, "targetDirRel")?.to_owned());
        let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel, &target])?).await;
        let note_root = root.clone();
        let leaf = |rel: &str| rel.rsplit('/').next().unwrap_or_default().to_owned();
        if req.method.as_str() == "projectFs/move" {
            let (from, to) = (rel.clone(), format!("{}/{}", target, leaf(&rel)));
            run_fallible(self.lanes.durability, &cancel, move || fsops::move_entry(&root, &rel, &target)).await?;
            self.note_written(&note_root, &[&from, &to]);
            value(json!({}))
        } else {
            let dir = target.clone();
            let name = run_fallible(self.lanes.durability, &cancel, move || fsops::copy_entry(&root, &rel, &target)).await?;
            self.note_written(&note_root, &[&format!("{dir}/{name}")]);
            value(json!({ "name": name }))
        }
    }

    pub(super) async fn handle_project_fs_trash(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let rel = s(params, "rel")?;
        let target = project_entry_path(&root, rel)?;
        if target == crate::pathguard::lexical(&root) {
            return Err(WsError::invalid("Cannot trash the project root."));
        }
        let _claim = self.paths.acquire(Self::claim_keys(&root, &[rel])?).await;
        let moved = target.clone();
        run_fallible(self.lanes.durability, &cancel, move || trash::delete(&moved).map_err(|e| WsError::new(Reason::Io, e.to_string()))).await?;
        self.note_written(&root, &[rel]);
        value(json!({}))
    }

    pub(super) async fn handle_project_fs_search_text(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let query = text_query(params.get("options").unwrap_or(&Value::Null), Self::held_lone(req, "/options/query"))?;
        let token = cancel.clone();
        let found = run_fallible(self.lanes.maintenance, &cancel, move || crate::textsearch::search(&root, &query, &|| token.is_cancelled())).await?;
        value(json!(found))
    }

    pub(super) async fn handle_project_fs_replace_text(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let options = params.get("options").unwrap_or(&Value::Null);
        let query = text_query(options, Self::held_lone(req, "/options/query"))?;
        let replacement = s(params, "replacement")?.to_owned();
        // Every planned write holds the replacement; one that held a lone surrogate is refused (Node: project-files.ts:744).
        let content_lone = Self::held_lone(req, "/replacement");
        // An empty list names no file, as in Node: every matching file is replaced.
        let rel_paths: Option<Vec<String>> = params
            .get("relPaths")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|p| p.as_str().map(str::to_owned)).collect::<Vec<_>>())
            .filter(|paths| !paths.is_empty());
        let token = cancel.clone();
        let plan_root = root.clone();
        let plan = run_fallible(self.lanes.maintenance, &cancel, move || {
            crate::textsearch::plan_replace(&plan_root, &query, &replacement, rel_paths.as_deref(), &|| token.is_cancelled())
        })
        .await?;
        if plan.writes.is_empty() {
            return value(json!({ "filesChanged": 0, "replacements": 0, "paths": [] }));
        }
        let files: Vec<BatchFile> = plan
            .writes
            .iter()
            .map(|w| BatchFile {
                rel_path: w.rel_path.clone(),
                content: w.content.clone(),
                expected_content: w.expected_content.clone(),
                content_lone,
                expected_lone: false,
            })
            .collect();
        let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
        let _claim = self.paths.acquire(Self::claim_keys(&root, &rels)?).await;
        let paths: Vec<String> = files.iter().map(|f| f.rel_path.clone()).collect();
        let fs = self.fs.clone();
        let note_root = root.clone();
        run_fallible(self.lanes.durability, &cancel, move || fs.write_batch(&root, &files, true)).await?;
        self.note_written(&note_root, &paths);
        value(json!({ "filesChanged": paths.len(), "replacements": plan.replacements, "paths": paths }))
    }

    pub(super) async fn handle_project_fs_recovery(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.recovery_root(req.ctx.origin, params).await?;
        let action = Action::parse(s(params, "action")?, params.get("id").and_then(Value::as_str), params.get("revision").and_then(Value::as_str))?;
        let (mutating, store_use) = match action {
            Action::List | Action::Inspect { .. } => (false, RecoveryUse::Inspect),
            Action::Restore { .. } => (true, RecoveryUse::Restore),
            Action::Discard { .. } => (true, RecoveryUse::Discard),
        };
        let _claim = if mutating { Some(self.paths.acquire(vec![root.clone()]).await) } else { None };
        let this2 = self.clone();
        let lane_root = root.clone();
        let (durability, interactive) = (self.lanes.durability, self.lanes.interactive);
        let task_cancel = cancel.clone();
        let run: std::pin::Pin<Box<dyn std::future::Future<Output = WsResult<Value>> + Send>> = Box::pin(async move {
            let job = move || this2.fs.recovery.execute(&lane_root, action);
            let response = if mutating { run_fallible(durability, &task_cancel, job).await? } else { run_fallible(interactive, &task_cancel, job).await? };
            Ok(json!(response))
        });
        let response = match self.managed.get() {
            Some(managed) => managed.recovery_store(&root, &self.fs.recovery.store_path(&root), store_use, run).await?,
            None => run.await?,
        };
        if mutating {
            // A restore or discard may touch any file of the project.
            self.note_anything();
        }
        value(response)
    }

    pub(super) async fn handle_project_fs_backup_read(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (backups, source) = (self.backups.clone(), self.relay_backup(req, s(params, "sourcePath")?.to_owned()).await?);
        value(run_fallible(self.lanes.interactive, &cancel, move || backups.read(&source)).await?)
    }

    pub(super) async fn handle_project_fs_backup_write(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (backups, source) = (self.backups.clone(), self.relay_backup(req, s(params, "sourcePath")?.to_owned()).await?);
        let (content, expected) = (s(params, "content")?.to_owned(), s(params, "expectedContent")?.to_owned());
        let _claim = self.paths.acquire(vec![self.backups.path_of(&source)?]).await;
        value(run_fallible(self.lanes.durability, &cancel, move || backups.write(&source, &content, &expected)).await?)
    }

    pub(super) async fn handle_project_fs_backup_delete(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (backups, source) = (self.backups.clone(), self.relay_backup(req, s(params, "sourcePath")?.to_owned()).await?);
        let _claim = self.paths.acquire(vec![self.backups.path_of(&source)?]).await;
        run_fallible(self.lanes.durability, &cancel, move || backups.delete(&source)).await?;
        value(json!({}))
    }

    pub(super) async fn handle_project_fs_workspace_file_read(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let file = PathBuf::from(s(params, "workspaceFile")?);
        value(run_fallible(self.lanes.interactive, &cancel, move || crate::editorcfg::read_workspace_file(&file)).await?)
    }

    pub(super) async fn handle_project_fs_workspace_file_write(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let file = PathBuf::from(s(params, "workspaceFile")?);
        let folders = params.get("folders").cloned().unwrap_or(Value::Null);
        let _claim = self.paths.acquire(vec![file.clone()]).await;
        value(run_fallible(self.lanes.durability, &cancel, move || crate::editorcfg::write_workspace_file(&file, &folders)).await?)
    }

    pub(super) async fn handle_project_fs_read_editor_settings(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let rel = s(params, "rel")?.to_owned();
        let workspace = params.get("workspaceFile").and_then(Value::as_str).map(PathBuf::from);
        let user_data = self.user_data.clone();
        let markdown_view = self.user_markdown_view.get().and_then(|read| read());
        value(
            run_fallible(self.lanes.interactive, &cancel, move || {
                crate::editorcfg::read_editor_settings(&user_data, &root, &rel, workspace.as_deref(), markdown_view)
            })
            .await?,
        )
    }
}
