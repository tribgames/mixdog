//! Where a native helper binary is: the one resolver for `mixdog-graph` and `mixdog-computer`.
//!
//! Node resolves each as follows, and so does this:
//! - graph (`code-graph/graph-binary.mjs` `_graphBinaryPath`): `MIXDOG_GRAPH_BIN` when it names an
//!   existing file, then a local cargo build (`native/mixdog-graph/target/release/`), then the
//!   package's `native-tools/`, then a binary a verified download cached (`findCachedGraphBinary`).
//! - computer (`apps/desktop/src/main/index.ts:356`, where the desktop's main process picks its
//!   helper): `MIXDOG_COMPUTER_BIN`, else the bundled `native-tools/mixdog-computer`, else the
//!   local cargo build (`native/mixdog-computer/target/release/`). Unlike Node, which keeps a
//!   PowerShell worker on Windows, the Rust core runs Computer Use through this helper on every
//!   OS (decision D-DESKTOP), so Windows resolves it too.
//!
//! The packaged desktop sets those variables itself from its resources, so for it the first step
//! is the answer. `root` is the package root, the directory that holds `native/` and
//! `native-tools/`.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_rt::InteractiveIo;

use crate::run_host::run_seams::EnvReader;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NativeTool {
    Graph,
    Computer,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Step {
    Env,
    LocalBuild,
    Package,
    Cached,
}

impl NativeTool {
    fn env_name(self) -> &'static str {
        match self {
            Self::Graph => "MIXDOG_GRAPH_BIN",
            Self::Computer => "MIXDOG_COMPUTER_BIN",
        }
    }

    fn stem(self) -> &'static str {
        match self {
            Self::Graph => "mixdog-graph",
            Self::Computer => "mixdog-computer",
        }
    }

    /// The order Node tries the places in.
    fn steps(self) -> &'static [Step] {
        match self {
            Self::Graph => &[Step::Env, Step::LocalBuild, Step::Package, Step::Cached],
            Self::Computer => &[Step::Env, Step::Package, Step::LocalBuild],
        }
    }

    fn file_name(self) -> String {
        format!("{}{}", self.stem(), if cfg!(windows) { ".exe" } else { "" })
    }
}

/// Whether a path exists (`existsSync`).
#[async_trait]
pub trait PathExists: Send + Sync {
    async fn exists(&self, path: &Path) -> bool;
}

/// Existence through the file service on the interactive lane.
pub struct FileServiceExists {
    pub files: Arc<dyn FileService>,
    pub lane: InteractiveIo,
}

#[async_trait]
impl PathExists for FileServiceExists {
    async fn exists(&self, path: &Path) -> bool {
        match AbsPath::new(path.to_owned()) {
            Some(abs) => self.files.stat(self.lane, abs).await.is_ok(),
            None => false,
        }
    }
}

/// A binary an earlier verified download left in the data directory (`findCachedGraphBinary`).
#[async_trait]
pub trait CachedNativeTool: Send + Sync {
    async fn find(&self, tool: NativeTool) -> Option<PathBuf>;
}

pub struct NativeToolPaths {
    env: EnvReader,
    root: PathBuf,
    exists: Arc<dyn PathExists>,
    /// `None` where nothing downloads native tools.
    cached: Option<Arc<dyn CachedNativeTool>>,
}

impl NativeToolPaths {
    pub fn new(env: EnvReader, root: PathBuf, exists: Arc<dyn PathExists>, cached: Option<Arc<dyn CachedNativeTool>>) -> Self {
        Self { env, root, exists, cached }
    }

    /// The absolute path of `tool`, or `None` when no place has it.
    pub async fn resolve(&self, tool: NativeTool) -> Option<PathBuf> {
        for step in tool.steps() {
            let found = match step {
                Step::Env => match (self.env)(tool.env_name()).filter(|value| !value.is_empty()) {
                    Some(path) if self.exists.exists(Path::new(&path)).await => Some(PathBuf::from(path)),
                    _ => None,
                },
                Step::LocalBuild => self.present(self.root.join("native").join(tool.stem()).join("target").join("release").join(tool.file_name())).await,
                Step::Package => self.present(self.root.join("native-tools").join(tool.file_name())).await,
                Step::Cached => match &self.cached {
                    Some(cache) => cache.find(tool).await,
                    None => None,
                },
            };
            if found.is_some() {
                return found;
            }
        }
        None
    }

    async fn present(&self, path: PathBuf) -> Option<PathBuf> {
        self.exists.exists(&path).await.then_some(path)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::collections::HashMap;

    use super::*;

    struct Present(HashSet<PathBuf>);

    #[async_trait]
    impl PathExists for Present {
        async fn exists(&self, path: &Path) -> bool {
            self.0.contains(path)
        }
    }

    struct Cache(Option<PathBuf>);

    #[async_trait]
    impl CachedNativeTool for Cache {
        async fn find(&self, _: NativeTool) -> Option<PathBuf> {
            self.0.clone()
        }
    }

    fn paths(env: &[(&str, &str)], present: &[PathBuf], cached: Option<PathBuf>) -> NativeToolPaths {
        let vars: HashMap<String, String> = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        NativeToolPaths::new(
            Arc::new(move |name| vars.get(name).cloned()),
            PathBuf::from("/pkg"),
            Arc::new(Present(present.iter().cloned().collect())),
            Some(Arc::new(Cache(cached))),
        )
    }

    fn built(tool: NativeTool) -> PathBuf {
        PathBuf::from("/pkg/native").join(tool.stem()).join("target/release").join(tool.file_name())
    }

    fn bundled(tool: NativeTool) -> PathBuf {
        PathBuf::from("/pkg/native-tools").join(tool.file_name())
    }

    #[tokio::test]
    async fn the_graph_binary_is_looked_for_in_nodes_order() {
        let tool = NativeTool::Graph;
        let cached = Some(PathBuf::from("/data/graph-bin/mixdog-graph-1"));
        let everything = [PathBuf::from("/x/graph"), built(tool), bundled(tool)];
        assert_eq!(paths(&[("MIXDOG_GRAPH_BIN", "/x/graph")], &everything, cached.clone()).resolve(tool).await, Some(PathBuf::from("/x/graph")));
        // An override that names nothing is skipped, not an error.
        assert_eq!(paths(&[("MIXDOG_GRAPH_BIN", "/x/gone")], &everything, cached.clone()).resolve(tool).await, Some(built(tool)));
        assert_eq!(paths(&[], &everything[2..], cached.clone()).resolve(tool).await, Some(bundled(tool)));
        assert_eq!(paths(&[], &[], cached.clone()).resolve(tool).await, cached);
        assert_eq!(paths(&[], &[], None).resolve(tool).await, None);
    }

    #[tokio::test]
    async fn the_computer_helper_has_no_download() {
        let tool = NativeTool::Computer;
        let cached = Some(PathBuf::from("/data/never"));
        let all = [PathBuf::from("/x/c"), bundled(tool), built(tool)];
        assert_eq!(paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &all, cached.clone()).resolve(tool).await, Some(PathBuf::from("/x/c")));
        assert_eq!(paths(&[], &all[1..], cached.clone()).resolve(tool).await, Some(bundled(tool)));
        assert_eq!(paths(&[], &all[2..], cached.clone()).resolve(tool).await, Some(built(tool)));
        assert_eq!(paths(&[], &[], cached).resolve(tool).await, None, "the computer helper is never taken from the graph cache");
    }
}
