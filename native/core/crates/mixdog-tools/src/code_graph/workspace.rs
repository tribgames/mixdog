//! The workspace service's `project/codeGraph` over the `code_graph` tool (Node's
//! `codeGraphQueryIn`, `apps/desktop/src/main/project-files.ts`): the editor's symbol lookup runs
//! `executeCodeGraphTool('code_graph', args, <project root>)` and returns its text. The service
//! checks the mode and query and builds `args`; this is the call itself, on the tool's own graph
//! and cache.

use std::path::Path;
use std::sync::Arc;

use mixdog_workspace::error::{Reason, WsError, WsResult};
use serde_json::Value;

use super::{CodeGraphTool, Failure};

pub struct WorkspaceCodeGraph {
    tool: Arc<CodeGraphTool>,
    io: mixdog_rt::MaintenanceIo,
}

impl WorkspaceCodeGraph {
    /// `tool` is the composition's one `code_graph` tool (the agent pool's, so both answer from
    /// one cache); `io` is the maintenance lane the tool's calls run on (`ToolContext.io.maintenance`).
    pub fn new(tool: Arc<CodeGraphTool>, io: mixdog_rt::MaintenanceIo) -> Self {
        Self { tool, io }
    }
}

#[async_trait::async_trait]
impl mixdog_workspace::service::CodeGraph for WorkspaceCodeGraph {
    async fn query(&self, cwd: &Path, args: Value, cancel: &mixdog_rt::CancellationToken) -> WsResult<String> {
        match self.tool.answer(cwd.to_path_buf(), &args, self.io, cancel).await {
            Ok(answer) => Ok(answer.text),
            // Node throws the dispatcher's `Error`; the wire carries its message.
            Err(Failure::Refused(message)) => Err(WsError::new(Reason::Io, message)),
            Err(Failure::Lane(mixdog_scm::error::ScmFailure::Cancelled)) => Err(WsError::new(Reason::Cancelled, "aborted")),
            Err(Failure::Lane(mixdog_scm::error::ScmFailure::QueueFull { queue })) => {
                Err(WsError::new(Reason::Overloaded, format!("lane {queue} is full")))
            }
            Err(Failure::Lane(other)) => Err(WsError::new(Reason::Io, format!("code_graph failed: {other}"))),
        }
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test builds its project folder with a blocking canonicalize")]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use mixdog_rt::LaneToken;
    use mixdog_workspace::service::CodeGraph;
    use serde_json::{Value, json};

    use super::{super::CodeGraphTool, WorkspaceCodeGraph};

    struct NoTrust;

    #[async_trait::async_trait]
    impl super::super::TrustedRoots for NoTrust {
        async fn registered(&self) -> Vec<PathBuf> {
            Vec::new()
        }

        async fn selected(&self) -> Vec<PathBuf> {
            Vec::new()
        }
    }

    /// A small JavaScript project (`src/lib/math.mjs` and its users) in a folder with a project sentinel.
    async fn project() -> (tempfile::TempDir, PathBuf) {
        let files = [
            ("package.json", "{}"),
            ("src/lib/math.mjs", "export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n"),
            ("src/lib/util.mjs", "import { add } from './math.mjs';\n\nexport const twice = (x) => add(x, x);\n"),
            (
                "src/main.mjs",
                "import { add, sub } from './lib/math.mjs';\n\nexport function main() {\n  return add(1, 2) + sub(5, 3);\n}\n\nexport function other() {\n  return add(3, 4);\n}\n",
            ),
        ];
        project_of(files.map(|(rel, text)| (rel.to_owned(), text.as_bytes().to_vec())).to_vec()).await
    }

    /// A project folder holding `files` (path under it, bytes), written on the maintenance lane.
    async fn project_of(files: Vec<(String, Vec<u8>)>) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap().join("ws");
        let at = root.clone();
        mixdog_rt::testing::tokens()
            .maintenance_io
            .submit_wait(&mixdog_rt::CancellationToken::new(), move |lane| {
                for (rel, bytes) in files {
                    mixdog_statefile::write_file(lane, &at.join(rel), &bytes, &mixdog_statefile::Opts::default()).unwrap();
                }
            })
            .await
            .unwrap()
            .await
            .unwrap();
        (tmp, root)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_call_carries_the_dispatchers_message() {
        let (_tmp, root) = project().await;
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(super::super::GraphCache::new(cache_dir.path().join("cache")));
        let tool = Arc::new(CodeGraphTool::new(Arc::new(NoTrust), cache));
        let graph = WorkspaceCodeGraph::new(tool, mixdog_rt::testing::tokens().maintenance_io);
        let cancel = mixdog_rt::CancellationToken::new();
        let error = graph.query(&root, json!({ "mode": "bogus", "symbols": "add" }), &cancel).await.unwrap_err();
        assert_eq!(error.message, "code_graph: unknown mode \"bogus\"");
    }


    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_answer_from_the_whole_graph_warns_of_unindexed_files_and_names_the_first_five() {
        let mut files = vec![
            ("package.json".to_owned(), b"{}".to_vec()),
            ("src/ok.mjs".to_owned(), b"export function good() {\n  return 1;\n}\n".to_vec()),
            ("src/use.mjs".to_owned(), b"import { good } from './ok.mjs';\nexport const v = good();\n".to_vec()),
        ];
        files.extend((1..=7).map(|n| (format!("src/bad{n}.mjs"), vec![0x65, 0x78, 0x70, 0xff, 0xfe, 0x0a])));
        let (_tmp, root) = project_of(files).await;
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(super::super::GraphCache::new(cache_dir.path().join("cache")));
        let tool = Arc::new(CodeGraphTool::new(Arc::new(NoTrust), cache));
        let graph = WorkspaceCodeGraph::new(tool, mixdog_rt::testing::tokens().maintenance_io);
        let cancel = mixdog_rt::CancellationToken::new();
        // A declaration search reads the whole graph, so the files it left out qualify the answer. Seven are unindexed: the
        // warning counts all seven and shows five.
        let found = graph.query(&root, json!({ "mode": "find_symbol", "symbols": "good" }), &cancel).await.unwrap();
        let header = "[warning] 7 source file(s) could not be indexed; graph results are partial:\n";
        let warned = found.split_once(header).unwrap_or_else(|| panic!("{found}")).1;
        let listed: Vec<&str> = warned.lines().take_while(|line| line.starts_with("src/bad")).collect();
        assert_eq!(listed.len(), 5, "{found}");
        assert!(found.contains("src/ok.mjs"), "{found}");
        // An outline of one verified file does not depend on the files that failed to index.
        let outline = graph.query(&root, json!({ "mode": "symbols", "files": "src/ok.mjs" }), &cancel).await.unwrap();
        assert!(!outline.contains("could not be indexed") && outline.contains("good"), "{outline}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_adapter_answers_declaration_outline_and_reference_queries_with_the_tools_text() {
        let (_tmp, root) = project().await;
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(super::super::GraphCache::new(cache_dir.path().join("cache")));
        let tool = Arc::new(CodeGraphTool::new(Arc::new(NoTrust), cache));
        let graph = WorkspaceCodeGraph::new(tool, mixdog_rt::testing::tokens().maintenance_io);
        let cancel = mixdog_rt::CancellationToken::new();
        let ask = |args: Value| graph.query(&root, args, &cancel);
        let found = ask(json!({ "mode": "find_symbol", "symbols": "add" })).await.unwrap();
        assert!(found.contains("src/lib/math.mjs:1-3") && found.contains("export function add(a, b) {"), "{found}");
        let outline = ask(json!({ "mode": "symbols", "files": "src/lib/math.mjs" })).await.unwrap();
        assert!(outline.contains("add") && outline.contains("sub"), "{outline}");
        let references = ask(json!({ "mode": "references", "symbols": "add" })).await.unwrap();
        assert!(references.contains("src/main.mjs") && references.contains("src/lib/util.mjs"), "{references}");
    }
}
