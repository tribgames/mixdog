//! The cached-download step of the native tool resolver: only the graph binary has one
//! (`findCachedGraphBinary`); the computer helper is never downloaded.

use std::path::PathBuf;

use async_trait::async_trait;
use mixdog_services::native_asset::GraphBinary;

use crate::run_host::native_tools::{CachedNativeTool, NativeTool};

#[async_trait]
impl CachedNativeTool for GraphBinary {
    async fn find(&self, tool: NativeTool) -> Option<PathBuf> {
        match tool {
            NativeTool::Graph => self.find_cached().await,
            NativeTool::Computer => None,
        }
    }
}
