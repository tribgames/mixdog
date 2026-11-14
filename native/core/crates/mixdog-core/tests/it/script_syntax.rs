//! The shell tool's `ExtSyntax`: the in-process checker decides whether an `await` in a `node -e`
//! body is top-level, with no worker.

use mixdog_protocol::ThreadId;
use mixdog_tools::exec::ExtSyntax;
use mixdog_tools::exec::ScriptSyntax;

#[tokio::test]
async fn the_shell_tools_script_syntax_decides_in_process() {
    let syntax = ExtSyntax::new();
    let thread = ThreadId::from("t");

    // Top-level `await` is not a CommonJS body, so a `node -e` run must stay inline.
    assert!(!syntax.compiles_as_commonjs(&thread, "await 1").await.unwrap());
    assert!(syntax.compiles_as_commonjs(&thread, "(async()=>{await 1})()").await.unwrap());
    assert!(syntax.compiles_as_commonjs(&thread, "const a = 1").await.unwrap());
}
