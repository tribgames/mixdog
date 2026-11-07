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

    /// The `fixtures/tools/code_graph` goldens run through the adapter's three modes.
    const GOLDENS: [(&str, &str); 3] = [
        ("find_symbol", include_str!("../../../../fixtures/tools/code_graph/mode-find_symbol.json")),
        ("symbols", include_str!("../../../../fixtures/tools/code_graph/mode-symbols.json")),
        ("references", include_str!("../../../../fixtures/tools/code_graph/mode-references.json")),
    ];

    /// `src/lib/math.mjs` as the goldens' project has it, in a folder with a project sentinel.
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

    /// Node's `[warning] N source file(s) could not be indexed` over `fixtures/tools/code_graph_warn`:
    /// a project of two good files and seven whose bytes do not decode.
    const WARN_GOLDENS: [(&str, &str); 8] = [
        ("whole-graph-symbol", include_str!("../../../../fixtures/tools/code_graph_warn/whole-graph-symbol.json")),
        ("overview", include_str!("../../../../fixtures/tools/code_graph_warn/overview.json")),
        ("batch-symbols", include_str!("../../../../fixtures/tools/code_graph_warn/batch-symbols.json")),
        ("imports-file", include_str!("../../../../fixtures/tools/code_graph_warn/imports-file.json")),
        ("exact-outline-bad-file", include_str!("../../../../fixtures/tools/code_graph_warn/exact-outline-bad-file.json")),
        ("exact-outline-good-file", include_str!("../../../../fixtures/tools/code_graph_warn/exact-outline-good-file.json")),
        ("find-symbol-good-anchor", include_str!("../../../../fixtures/tools/code_graph_warn/find-symbol-good-anchor.json")),
        ("symbols-fanout", include_str!("../../../../fixtures/tools/code_graph_warn/symbols-fanout.json")),
    ];

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn files_the_graph_could_not_index_are_warned_about_as_node_does() {
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
        for (name, text) in WARN_GOLDENS {
            let case: Value = serde_json::from_str(text).unwrap();
            let got = graph.query(&root, case["input"].clone(), &cancel).await.unwrap();
            assert_eq!(got, case["text"].as_str().unwrap(), "{name}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_adapter_answers_with_the_text_node_returns() {
        let (_tmp, root) = project().await;
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(super::super::GraphCache::new(cache_dir.path().join("cache")));
        let tool = Arc::new(CodeGraphTool::new(Arc::new(NoTrust), cache));
        let graph = WorkspaceCodeGraph::new(tool, mixdog_rt::testing::tokens().maintenance_io);
        let cancel = mixdog_rt::CancellationToken::new();
        let root_text = root.display().to_string();
        for (mode, text) in GOLDENS {
            let case: Value = serde_json::from_str(text).unwrap();
            let got = graph.query(&root, case["input"].clone(), &cancel).await.unwrap().replace(&root_text, "<ROOT>");
            // The goldens were recorded on Windows, where the call federated over its own cwd
            // and gained a `# project ws [<ROOT>]` header (see `code_graph::tests`).
            let want = case["text"].as_str().unwrap().trim_start_matches("# project ws [<ROOT>]\n");
            assert_eq!(got, want, "{mode}");
        }
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
}
