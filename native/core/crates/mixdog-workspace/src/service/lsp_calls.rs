use super::*;

impl WorkspaceService {
    pub(super) async fn handle_lsp_subscribe(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        // The feed is named by the project string `lsp/document` was given, which is what the
        // events carry as `projectPath`.
        let feed = self.lsp_feeds.source(s(params, "root")?);
        Ok(Reply::Subscribe(Subscribe { result: json!({}), feed, window: Window::Fixed, resume_from: None }))
    }

    // The subscription itself is the server's; the feed outlives it (servers keep running).
    pub(super) async fn handle_lsp_unsubscribe(self: &Arc<Self>) -> WsResult<Reply> {
        let value = |v: Value| Ok(Reply::Value(v));
        value(json!({}))
    }

    pub(super) async fn handle_lsp_document(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        // `projectPath` names the project the events carry; `root` is the folder the host
        // resolved for it (a worktree may differ), as Node's `lspDocument(projectPath, root, input)`.
        let project = s(params, "projectPath")?;
        let root = self.root(req.ctx.origin, params).await?;
        let document = DocumentInput::from_value(params.get("document").unwrap_or(&Value::Null))?;
        value(self.lsp.document(project, &root, document).await?)
    }

    pub(super) async fn handle_lsp_request(self: &Arc<Self>, req: &CoreRequest) -> WsResult<Reply> {
        let params = &req.params;
        let value = |v: Value| Ok(Reply::Value(v));
        let project = s(params, "projectPath")?;
        let root = self.root(req.ctx.origin, params).await?;
        let r = params.get("request").unwrap_or(&Value::Null);
        value(self.lsp.request(project, &root, s(r, "relPath")?, s(r, "languageId")?, s(r, "method")?, r.get("params").unwrap_or(&Value::Null)).await?)
    }
}
