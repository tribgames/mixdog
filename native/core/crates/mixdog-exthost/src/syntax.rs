//! `syntax.check`: asks a worker whether Node's V8 compiles a source, for callers that must decide
//! exactly as Node does. It is an ordinary pool call (the `ExtPool` contract is unchanged); this is
//! the typed front for it.

use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_protocol::ThreadId;
use serde_json::json;

/// What the source is compiled as.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SyntaxKind {
    /// `new vm.Script(source)`.
    CommonJsScript,
}

impl SyntaxKind {
    fn wire(self) -> &'static str {
        match self {
            Self::CommonJsScript => "commonjs-script",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SyntaxCheck {
    Ok,
    /// V8's message for the first error.
    Invalid { message: String },
}

/// Compiles `source` as `kind` in a worker. A pool failure (no Node, overload, a worker exit)
/// is the `ExtError`; a source that does not compile is `Invalid`, not an error.
pub async fn check_syntax(
    pool: &dyn ExtPool,
    thread: ThreadId,
    source: &str,
    kind: SyntaxKind,
) -> Result<SyntaxCheck, ExtError> {
    let mut stream = pool.call(ExtCall {
        thread,
        method: "syntax.check".to_owned(),
        params: json!({ "source": source, "kind": kind.wire() }),
        paths: Vec::new(),
    })?;
    let answer = loop {
        match stream.next().await {
            Some(ExtFrame::Chunk(_)) => {}
            Some(ExtFrame::Done(outcome)) => break outcome?,
            None => return Err(ExtError::UnknownWorker),
        }
    };
    if answer["ok"] == true {
        return Ok(SyntaxCheck::Ok);
    }
    Ok(SyntaxCheck::Invalid {
        message: answer["message"].as_str().unwrap_or_default().to_owned(),
    })
}
