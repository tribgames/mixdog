use super::*;

impl WorkspaceService {
    pub(super) async fn handle_transfer_begin_read(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let source = params.get("source").ok_or_else(|| WsError::invalid("source is invalid."))?;
        let owner = Self::owner(req);
        let t = self.transfers.clone();
        let opened = match source.get("kind").and_then(Value::as_str) {
            Some("file") => {
                let root = self.root(req.ctx.origin, source).await?;
                let rel = s(source, "rel")?.to_owned();
                self.hide_from_device(req, vec![root.join(&rel)]).await?;
                run_fallible(self.lanes.interactive, &cancel, move || t.begin_project_read(&owner, &root, &rel)).await?
            }
            Some("granted") => {
                let (grants, credential, connection) = self.phone_grants_for(req)?;
                let granted = grants.redeem(&credential, connection, s(source, "accessToken")?, s(source, "projectPath")?, s(source, "relPath")?).await?;
                let (root, rel) = (granted.root, granted.rel);
                run_fallible(self.lanes.interactive, &cancel, move || t.begin_project_read(&owner, &root, &rel)).await?
            }
            Some("localFile") => {
                // An absolute path is the desktop's and an SSH window's; a paired device reads outside its
                // projects only through a grant (`granted`).
                if matches!(req.ctx.origin, mixdog_protocol::Origin::Relay) {
                    return Err(WsError::denied("A paired device reads local files through a granted-file permission."));
                }
                let path = s(source, "path")?.to_owned();
                run_fallible(self.lanes.interactive, &cancel, move || t.begin_local_read(&owner, &path)).await?
            }
            Some("export") if req.ctx.origin == mixdog_protocol::Origin::Relay => {
                return Err(WsError::denied("A paired device downloads exports through a download grant."));
            }
            Some(kind) => match self.sources.iter().find(|x| x.kind() == kind) {
                Some(found) => {
                    let file = found.open(source, &cancel).await?;
                    self.transfers.begin_source(&owner, file)?
                }
                None => return Err(WsError::new(Reason::Unsupported, "This transfer source is served by another domain.")),
            },
            None => return Err(WsError::invalid("source.kind is invalid.")),
        };
        value(json!({ "transferId": opened.transfer_id, "size": opened.size, "mimeType": opened.mime_type,
            "entry": { "name": opened.name, "version": opened.version, "rangeMaxBytes": opened.range_max_bytes } }))
    }

    pub(super) async fn handle_transfer_begin_zip(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let (rel, owner) = (s(params, "rel")?.to_owned(), Self::owner(req));
        let opened = self.transfers.begin_zip(&owner, self.tracked.as_ref(), self.lanes, &cancel, &root, &rel).await?;
        value(json!({ "transferId": opened.transfer_id, "size": opened.size, "mimeType": opened.mime_type,
            "entry": { "name": opened.name, "version": opened.version, "rangeMaxBytes": opened.range_max_bytes } }))
    }

    pub(super) async fn handle_transfer_read_range(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let offset = params.get("offset").and_then(Value::as_u64).ok_or_else(|| WsError::invalid("offset is invalid."))?;
        let length = params.get("length").and_then(Value::as_u64).ok_or_else(|| WsError::invalid("length is invalid."))?;
        // `serverFileReadRange(root, rel, offset, length)` names the file and opens no transfer.
        if params.get("transferId").is_none() {
            if length == 0 {
                return Err(WsError::invalid("length is invalid."));
            }
            let (root, rel) = (self.root(req.ctx.origin, params).await?, s(params, "rel")?.to_owned());
            self.hide_from_device(req, vec![root.join(&rel)]).await?;
            return value(run_fallible(self.lanes.interactive, &cancel, move || crate::transfer::read_path_range(&root, &rel, offset, length)).await?);
        }
        let id = s(params, "transferId")?.to_owned();
        let (owner, connection, t) = (self.download_owner(req), Self::owner(req), self.transfers.clone());
        let owners = [owner.as_str(), connection.as_str()];
        let version = params.get("version").and_then(Value::as_str).map(str::to_owned);
        let range = run_fallible(self.lanes.interactive, &cancel, {
            let (owners, id) = (owners.map(str::to_owned), id.clone());
            move || t.read_range(&[owners[0].as_str(), owners[1].as_str()], &id, offset, length, version.as_deref())
        })
        .await?;
        // The lane answered some time after the range took its last look: a revoke that landed since is never followed by bytes.
        if !self.transfers.holds(&owners, &id) {
            return Err(WsError::expired());
        }
        value(json!(range))
    }

    pub(super) async fn handle_transfer_authorize_read(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        // Node's `requiredFileDownloadRequest`, check for check and before anything is looked up: the core is the boundary, whoever
        // calls it, and each identifier is the trimmed text Node goes on with.
        let source = params.get("source").filter(|source| source.is_object()).ok_or_else(|| WsError::invalid("download source is invalid."))?;
        if !matches!(params.get("purpose").and_then(Value::as_str), Some("save" | "share" | "open")) {
            return Err(WsError::invalid("download purpose is invalid."));
        }
        let session = crate::transfer::required_session_id(params.get("sessionId"))?;
        let requested = crate::transfer::DownloadRequest::of(source)?;
        let owner = self.download_owner(req);
        let mark = self.transfers.mark(&owner, &session);
        let t = self.transfers.clone();
        // Node's `sessionRow`: the conversation must be in the host's catalog now, whoever asks, and its project is the catalog's, never
        // the caller's.
        let grants = self.phone_grants.get().ok_or_else(|| WsError::new(Reason::Unsupported, "Paired-device downloads are not available."))?;
        let row = grants.store.session_row(&session).await?.ok_or_else(unavailable)?;
        // `projectRoot`: only a project conversation whose project is still a registered one has a root.
        let project = match (&row.project_path, row.project) {
            (Some(given), true) => self.catalog.resolve(given).await.ok(),
            _ => None,
        };
        let given = row.project_path.as_deref().map(PathBuf::from);
        let folders = (req.ctx.origin == mixdog_protocol::Origin::Relay).then(|| self.secret_folders());
        let mut left_out = None;
        let opened = match requested {
            crate::transfer::DownloadRequest::Export(mut input) => {
                let owner = if req.ctx.origin == mixdog_protocol::Origin::Relay {
                    let (_, credential, _) = self.phone_grants_for(req)?;
                    let paired = Owner::device(&credential);
                    if paired != owner {
                        return Err(WsError::expired());
                    }
                    paired
                } else {
                    owner
                };
                let render = self
                    .sources
                    .iter()
                    .find(|x| x.kind() == "export")
                    .ok_or_else(|| WsError::new(Reason::Unsupported, "Visualize exports are not available."))?;
                // The catalog-validated conversation, not any session named inside the render input, owns the grant.
                input.insert("sessionId".into(), json!(&session));
                let file = render.open(&json!({ "kind": "export", "input": input }), &cancel).await.map_err(crate::transfer::source_refusal)?;
                // Once the host has rendered a file, authorization takes cleanup ownership even on refusal.
                return value(json!(t.authorize_source(&owner, &session, mark, file)?));
            }
            crate::transfer::DownloadRequest::Project(rel) => {
                let root = project
                    .ok_or_else(|| WsError::new(Reason::Download("file-download:outside-project"), "The file is outside the conversation's project."))?;
                run_fallible(self.lanes.interactive, &cancel, move || {
                    not_secret(crate::transfer::open_project_download(&root, &rel, &|point| t.point(point))?, folders.as_deref())
                })
                .await?
            }
            crate::transfer::DownloadRequest::Session(path) => {
                let cwd = row.cwd.clone();
                run_fallible(self.lanes.interactive, &cancel, move || {
                    let file = crate::transfer::open_session_download(&path, &cwd, project.as_deref(), given.as_deref(), &|point| t.point(point))?;
                    not_secret(file, folders.as_deref())
                })
                .await?
            }
            crate::transfer::DownloadRequest::Media(asset) => {
                // Node's `authorizeMediaAsset`: the conversation is in the catalog (above), the asset is the media store's.
                let entry = grants.store.media(&asset).await?;
                run_fallible(self.lanes.interactive, &cancel, move || crate::transfer::open_media_download(entry.as_ref(), &|point| t.point(point))).await?
            }
            crate::transfer::DownloadRequest::Link(href) => {
                // Node's `authorizeLinkedFile`: the link decoded as the desktop decodes it, then opened as a path the conversation names.
                let path = crate::transfer::link_path(&href)
                    .ok_or_else(|| WsError::new(Reason::Download("file-download:not-a-file"), "Only files on this PC can be downloaded."))?;
                let cwd = row.cwd.clone();
                run_fallible(self.lanes.interactive, &cancel, move || {
                    let file = crate::transfer::open_session_download(&path, &cwd, project.as_deref(), given.as_deref(), &|point| t.point(point))?;
                    not_secret(file, folders.as_deref())
                })
                .await?
            }
            crate::transfer::DownloadRequest::Attachment(id) => {
                // Node's `authorizeAttachment`: an id the conversation the core resolved names, staged by the attachment domain.
                let source = self
                    .sources
                    .iter()
                    .find(|x| x.kind() == "attachment")
                    .ok_or_else(|| WsError::new(Reason::Unsupported, "Attachments are not available."))?;
                let read = source.bytes(&json!({ "sessionId": session, "attachmentId": id }), &cancel).await.map_err(crate::transfer::source_refusal)?;
                let (owner, session) = (owner.clone(), session.clone());
                run_fallible(self.lanes.interactive, &cancel, move || t.stage(&owner, &session, &read.bytes, read.name, read.mime_type)).await?
            }
            crate::transfer::DownloadRequest::Folder(path) => {
                // Node's `authorizeFolderZip`: the folder as the conversation names it, zipped as `zipFolder` zips it, staged.
                let cwd = row.cwd.clone();
                let (root, given, kept) = (project.clone(), given.clone(), folders.clone());
                let folder = run_fallible(self.lanes.maintenance, &cancel, move || {
                    let folder = crate::transfer::phone_folder(&path, &cwd, root.as_deref(), given.as_deref())?;
                    match &kept {
                        Some(kept) if crate::sensitive::is_sensitive(&folder, &crate::sensitive::scopes(kept)) => Err(download_gone()),
                        _ => Ok(folder),
                    }
                })
                .await?;
                let scan = crate::zip::scan_folder(
                    self.tracked.as_ref(),
                    self.lanes,
                    &cancel,
                    &folder,
                    crate::transfer::ZIP_MAX_BYTES,
                    crate::transfer::ZIP_MAX_FILES,
                    None,
                )
                .await
                .map_err(crate::transfer::phone_folder_refusal)?;
                let ignored = scan.ignored;
                let (t, owner, session) = (self.transfers.clone(), owner.clone(), session.clone());
                let (opened, secret) = run_fallible(self.lanes.cpu_bulk, &cancel, move || {
                    // A paired device's archive leaves the secret files out and says how many.
                    let scopes = folders.as_deref().map(crate::sensitive::scopes);
                    let (secret, files): (Vec<_>, Vec<_>) =
                        scan.files.into_iter().partition(|file| scopes.as_ref().is_some_and(|scopes| crate::sensitive::is_sensitive(&file.absolute, scopes)));
                    let (archive, name) = crate::transfer::folder_zip(&folder, &files, &|point| t.point(point))?;
                    Ok((t.stage(&owner, &session, &archive, name, "application/zip".into())?, secret.len() as u64))
                })
                .await?;
                left_out = Some(crate::transfer::LeftOut { ignored, secret });
                opened
            }
        };
        let t = self.transfers.clone();
        let mut authorized = t.authorize(&owner, &session, mark, opened)?;
        authorized.left_out = left_out;
        value(json!(authorized))
    }

    pub(super) async fn handle_transfer_redeem_grant(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (owner, t, id) = (self.download_owner(req), self.transfers.clone(), crate::transfer::required_download_id(params.get("grantId"), "grant id")?);
        value(json!(run_fallible(self.lanes.interactive, &cancel, move || t.begin_grant(&owner, &id)).await?))
    }

    pub(super) async fn handle_transfer_finish_read(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let (owner, t, id) =
            (self.download_owner(req), self.transfers.clone(), crate::transfer::required_download_id(params.get("transferId"), "transfer id")?);
        value(json!(run_fallible(self.lanes.interactive, &cancel, move || t.finish_read(&owner, &id)).await?))
    }

    pub(super) async fn handle_transfer_end_read(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let (owner, connection, id) = (self.download_owner(req), Self::owner(req), s(params, "transferId")?);
        value(json!({ "ended": self.transfers.end_read(&[owner.as_str(), connection.as_str()], id) }))
    }

    pub(super) async fn handle_transfer_begin_write_staged(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        // `serverUploadBegin(name, size, scope)`: staged under the data dir, named at commit.
        let scope = s(params, "scope")?.trim();
        if scope.is_empty()
            || scope.len() > 128
            || scope == "."
            || scope == ".."
            || !scope.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(WsError::invalid("The upload scope is invalid."));
        }
        let size = params
            .get("size")
            .and_then(Value::as_u64)
            .filter(|size| (1..=UPLOAD_MAX_BYTES).contains(size))
            .ok_or_else(|| WsError::invalid("size is invalid."))?;
        let dir = self.user_data.join("attachments").join(scope);
        let (owner, name, t) = (Self::owner(req), s(params, "name")?.to_owned(), self.transfers.clone());
        let id = run_fallible(self.lanes.durability, &cancel, move || t.begin_staged(&owner, &dir, &name, size)).await?;
        value(json!({ "transferId": id, "uploadId": id, "chunkBytes": self.upload_chunk_bytes, "maxBytes": UPLOAD_MAX_BYTES }))
    }

    pub(super) async fn handle_transfer_begin_write(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let root = self.root(req.ctx.origin, params).await?;
        let rel = s(params, "rel")?.to_owned();
        let size = params.get("size").and_then(Value::as_u64).ok_or_else(|| WsError::invalid("size is invalid."))?;
        let (owner, t) = (Self::owner(req), self.transfers.clone());
        let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel])?).await;
        let id = run_fallible(self.lanes.durability, &cancel, move || t.begin_write(&owner, &root, &rel, size)).await?;
        value(json!({ "transferId": id }))
    }

    pub(super) async fn handle_transfer_write_chunk(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let id = s(params, "transferId")?.to_owned();
        // Validated in `Transfers::write_chunk`, in Node's order and with its sentences.
        let offset = params.get("offset").and_then(Value::as_u64);
        let encoded = params.get("bytesB64").and_then(Value::as_str).unwrap_or_default().to_owned();
        let (owner, t) = (Self::owner(req), self.transfers.clone());
        let received = run_fallible(self.lanes.durability, &cancel, move || t.write_chunk(&owner, &id, offset, &encoded)).await?;
        value(json!({ "received": received }))
    }

    pub(super) async fn handle_transfer_commit(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        let id = s(params, "transferId")?.to_owned();
        let (owner, t) = (Self::owner(req), self.transfers.clone());
        let (size, path) = run_fallible(self.lanes.durability, &cancel, move || t.commit(&owner, &id)).await?;
        self.note_anything();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        value(json!({ "size": size, "absolutePath": path.to_string_lossy(), "name": name, "dir": false }))
    }

    pub(super) async fn handle_transfer_abort(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        value(json!({ "aborted": self.transfers.abort(&Self::owner(req), s(params, "transferId")?) }))
    }

    pub(super) async fn handle_transfer_server_download_begin(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let not_connected = || WsError::plain("This SSH server is not connected. Connect it from the SSH server dialog.");
        let server = s(params, "serverId")?;
        let reader = self.remote_files.get().and_then(|links| links.reader(server)).ok_or_else(not_connected)?;
        let begun = self.server_downloads.begin(reader, Path::new(s(params, "downloadsDir")?), s(params, "root")?, s(params, "rel")?).await?;
        value(json!({ "downloadId": begun.download_id, "name": begun.name, "size": begun.size }))
    }

    pub(super) async fn handle_transfer_server_download_step(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let stepped = self.server_downloads.step(s(params, "downloadId")?).await?;
        value(json!({ "received": stepped.received, "size": stepped.size, "done": stepped.done }))
    }

    pub(super) async fn handle_transfer_server_download_finish(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let path = self.server_downloads.finish(s(params, "downloadId")?).await?;
        value(json!({ "path": path.to_string_lossy() }))
    }

    pub(super) async fn handle_transfer_server_download_abort(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        value(json!(self.server_downloads.abort(s(params, "downloadId")?)))
    }

    pub(super) async fn handle_transfer_server_download_check(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        value(json!(self.server_downloads.was_downloaded(Path::new(s(params, "path")?))))
    }

    pub(super) async fn handle_transfer_trash_info(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        // `serverTrashInfo` is handed `projectDirectory` of a registered project (ipc-server-files.ts:132), whatever the
        // connection: a path that names none is the registry's refusal, and a relative one is read by the registry's rule.
        let root = self.project_directory(s(params, "path")?, false, &cancel).await?;
        value(run_fallible(self.lanes.interactive, &cancel, move || Ok(crate::servertrash::info(&root))).await?)
    }

    pub(super) async fn handle_transfer_grant_mint(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        // `resolveLocalPaths` / `attachmentOpen` of a paired device: the described path, with a one-file
        // grant when it lies outside every project (a conversation's attachment always gets one).
        let (grants, credential, connection) = self.phone_grants_for(req)?;
        if params.get("attachmentId").is_some() {
            // `attachmentOpen` (remote-attachments.ts): the attachment this conversation names, staged as a named file in the
            // PC's temp folder (`stageSessionAttachment`) and opened through a one-file grant of that conversation.
            // Node's `requiredSessionId` first, then the attachment.
            let session = crate::transfer::required_session_id(params.get("sessionId"))?;
            let source =
                self.sources.iter().find(|x| x.kind() == "attachment").ok_or_else(|| WsError::new(Reason::Unsupported, "Attachments are not available."))?;
            let read = source.bytes(params, &cancel).await.map_err(crate::transfer::source_refusal)?;
            let id = s(params, "attachmentId")?.to_owned();
            let (bytes, name) = (read.bytes, read.name);
            let size = bytes.len();
            let path = run_fallible(self.lanes.durability, &cancel, move || crate::transfer::stage_attachment(&id, &name, &bytes)).await?;
            let token = grants.mint(&credential, connection, &path, &session).await?;
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let folder = path.parent().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
            return value(json!({ "absolutePath": path.to_string_lossy(), "name": name, "dir": false, "size": size,
                "mimeType": read.mime_type, "projectPath": folder, "relPath": name, "accessToken": token }));
        }
        let path = s(params, "path")?.to_owned();
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_owned();
        self.hide_from_device(req, vec![crate::pathguard::absolute_local_path(&path)?]).await?;
        let entry = run_fallible(self.lanes.interactive, &cancel, move || fsops::stat_local(&path)).await?;
        let mut row = json!(entry);
        if !entry.dir {
            let absolute = PathBuf::from(&entry.absolute_path);
            let projects: Vec<String> = self.catalog.list().await?.into_iter().map(|project| project.path).collect();
            let owner = if session.is_empty() { crate::grants::owning_project(&projects, &absolute) } else { None };
            match owner {
                Some((project, relative)) => {
                    row["projectPath"] = json!(project);
                    row["relPath"] = json!(relative);
                }
                None => {
                    row["projectPath"] = json!(absolute.parent().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default());
                    row["relPath"] = json!(absolute.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default());
                    row["accessToken"] = json!(grants.mint(&credential, connection, &absolute, &session).await?);
                }
            }
        }
        value(row)
    }

    pub(super) async fn handle_transfer_trash_entry(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        // Root and entry as `server-file-operations.ts` takes them; `path` is the root.
        let root = self.catalog.resolve(s(params, "path")?).await?;
        let rel = params.get("rel").and_then(Value::as_str).unwrap_or_default().to_owned();
        let permanent = opt_bool(params, "permanent");
        let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel])?).await;
        let (note_root, note_rel) = (root.clone(), rel.clone());
        let outcome = run_fallible(self.lanes.durability, &cancel, move || crate::servertrash::entry(&root, &rel, permanent)).await?;
        self.note_written(&note_root, &[&note_rel]);
        value(outcome)
    }
}

/// What a paired device's download finds of a file that is not there.
fn download_gone() -> WsError {
    WsError::new(Reason::Download("file-download:not-found"), "The file no longer exists.")
}

/// A paired device's download of a secret file ([`crate::sensitive`], judged where the open file really is) finds no file; `folders`
/// is `None` for a caller that is not judged.
fn not_secret(file: crate::transfer::DownloadFile, folders: Option<&[PathBuf]>) -> WsResult<crate::transfer::DownloadFile> {
    match folders {
        Some(folders) if crate::sensitive::is_sensitive(&file.location, &crate::sensitive::scopes(folders)) => Err(download_gone()),
        _ => Ok(file),
    }
}
