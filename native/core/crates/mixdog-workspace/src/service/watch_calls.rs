use super::*;

impl WorkspaceService {
    pub(super) async fn handle_fs_watch(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let id = s(params, "watchId")?.to_owned();
        // Any absolute path, as Node's `folderWatch` (`absoluteLocalPath`, then `fs.watch` of that resolved string,
        // desktop-operations.ts:185-213): the watch is of the path as resolved, not of its real path, so a junction
        // watched under two names is two watches that each report under their own name, and a failure is `fs.watch`'s own
        // (`ENOENT: no such file or directory, watch '<path>'`). Every touch of the file system is on the lane below.
        let Some(given) = params.get("path").and_then(Value::as_str) else { return Err(WsError::invalid("path must be a string.")) };
        let path = crate::pathguard::absolute_local_path(given)?;
        let recursive = opt_bool(params, "recursive");
        let publisher = Arc::new(Publisher::create_ordered(self.search_feeds(), &format!("fs:{id}"), json!({})));
        self.router.fs.lock().expect("fs watches").insert(id.clone(), publisher.clone());
        let (watcher, watch_id, watch_path) = (self.watcher.clone(), id.clone(), path.clone());
        let attached = run_fallible(self.lanes.interactive, &cancel, move || watcher.watch(&watch_id, &watch_path, recursive)).await;
        if let Err(error) = attached {
            self.router.fs.lock().expect("fs watches").remove(&id);
            return Err(error);
        }
        self.watches.lock().expect("watches").insert(id, Owned { connection: Self::owner(req).to_string(), publisher: publisher.clone() });
        Ok(Reply::Subscribe(Subscribe { result: json!({}), feed: publisher.source(), window: Window::Fixed, resume_from: None }))
    }

    pub(super) async fn handle_fs_unwatch(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let id = s(params, "watchId")?;
        let owned = self.watches.lock().expect("watches").get(id).is_some_and(|w| w.connection == *Self::owner(req));
        if owned {
            // Ending the OS watch closes its handle, which a path that does not answer can hold: on the lane, not here. The job is
            // admitted before the watch's record goes, with a token no cancel reaches, so the OS watch never outlives its record:
            // a lane that refuses it leaves the watch whole, and a request cancelled meanwhile does not drop it.
            let (watcher, watch_id) = (self.watcher.clone(), id.to_owned());
            let job = move |_: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>| crate::lanes::counted(move || watcher.unwatch(&watch_id))();
            let cleanup = mixdog_rt::LaneToken::submit(self.lanes.interactive, &CancellationToken::new(), job)?;
            self.forget_watch(id);
            let _ = cleanup.await;
        }
        value(json!({}))
    }

    pub(super) async fn handle_search_start(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let id = s(params, "sessionId")?.to_owned();
        let roots = params
            .get("roots")
            .and_then(Value::as_array)
            .filter(|r| !r.is_empty() && r.len() <= 16)
            .ok_or_else(|| WsError::invalid("roots is invalid."))?
            .iter()
            .map(|r| r.as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        let mut resolved = Vec::new();
        for root in roots {
            resolved.push(self.catalog.resolve(root).await?);
        }
        let roots = resolved;
        let config = SessionConfig {
            roots,
            limit: params.get("limit").and_then(Value::as_u64).map(|n| n as usize),
            include_ignored: opt_bool(params, "includeIgnored"),
            include_directories: opt_bool(params, "includeDirectories"),
            consumer: params.get("consumer").and_then(Value::as_str).map(str::to_owned),
            scan_cap: None,
            beyond_budget: None,
        };
        let publisher = self.search.start_owned(&id, Some(Self::owner(req).to_string()), config)?;
        Ok(Reply::Subscribe(Subscribe { result: json!({}), feed: publisher.source(), window: Window::Fixed, resume_from: None }))
    }

    pub(super) async fn handle_search_update(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        self.search.update(s(params, "sessionId")?, s(params, "query")?.to_owned(), Self::held_lone(req, "/query"))?;
        value(json!({}))
    }

    pub(super) async fn handle_search_stop(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let id = s(params, "sessionId")?;
        self.search.stop(id);
        value(json!({}))
    }
}
