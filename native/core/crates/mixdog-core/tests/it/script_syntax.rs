//! The shell tool's `ExtSyntax` against the real extension-host worker: V8 itself decides whether
//! an `await` in a `node -e` body is top-level. Lives here because `mixdog-core` depends on both
//! `mixdog-tools` and `mixdog-exthost`, which must not depend on each other.

use std::future::Future;
use std::path::Path;
use std::sync::Arc;

use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::ExtSyntax;
use mixdog_tools::exec::ScriptSyntax;

async fn within<T>(fut: impl Future<Output = T>) -> T {
    fut.await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_shell_tools_script_syntax_asks_the_real_worker() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap();
    let worker = root.join("src").join("ext-host").join("worker.mjs");
    let pool = ExtHostPool::new(ExtHostConfig {
        program: "node".into(),
        args: vec![worker.into_os_string()],
        electron: false,
        workers: 1,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: None,
            profile_root: std::env::temp_dir().join("mixdog-core-script-syntax"),
            no_sandbox: false,
        },
    })
    .unwrap();
    let syntax = ExtSyntax::new(Arc::new(pool));
    let thread = ThreadId::from("t");

    // Top-level `await` is not a CommonJS body, so a `node -e` run must stay inline.
    assert!(!within(syntax.compiles_as_commonjs(&thread, "await 1")).await.unwrap());
    assert!(within(syntax.compiles_as_commonjs(&thread, "(async()=>{await 1})()")).await.unwrap());
    assert!(within(syntax.compiles_as_commonjs(&thread, "const a = 1")).await.unwrap());
}
