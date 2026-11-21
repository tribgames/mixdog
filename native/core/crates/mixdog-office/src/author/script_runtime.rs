//! A pptxgenjs script runs in a process of the install's interpreter, `<program> <package root>/src/runtime/office/authoring/pptx-script-entry.mjs`:
//! the request on standard input, the answer as one line of standard output after [`ANSWER_MARKER`].

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// The interpreter of an install and the package its entry lives in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptRuntime {
    /// The interpreter: Node, or the Electron of the desktop (run as Node).
    pub program: PathBuf,
    /// The package root: the entry is `src/runtime/office/authoring/pptx-script-entry.mjs` under it.
    pub package_root: PathBuf,
    /// The program is Electron and is started with `ELECTRON_RUN_AS_NODE=1`.
    pub electron: bool,
}

static RUNTIME: OnceLock<ScriptRuntime> = OnceLock::new();

/// Names the interpreter of the install this process belongs to. The first call wins; a process calls it once, before it serves.
pub fn install(runtime: ScriptRuntime) {
    let _ = RUNTIME.set(runtime);
}

/// The interpreter [`install`] named.
pub fn installed() -> Option<&'static ScriptRuntime> {
    RUNTIME.get()
}

/// `\0mixdog-pptx-script-answer\0`: what precedes the answer on standard output (pptx-script-entry.mjs).
const ANSWER_MARKER: &str = "\u{0}mixdog-pptx-script-answer\u{0}";
const ENTRY: &str = "src/runtime/office/authoring/pptx-script-entry.mjs";
/// The limit of a script is 90 s (`PPTX_SCRIPT_CONTRACT.timeoutMs`) and is enforced inside the interpreter; a script that
/// never yields to it (a loop with no `await`) is ended here.
const HARD_LIMIT: Duration = Duration::from_secs(150);
const NO_RUNTIME: &str =
    "A pptxgenjs script cannot run: this install has no script interpreter. Author the deck as HTML slides (a source that opens with <) instead.";

/// `runPptxAuthoringScript(script, output, { cwd })` on the installed interpreter: `Ok` is the answer of the function, `Err` what
/// it threw or why the interpreter could not answer.
pub async fn run_pptx_script(script: &str, output: &Path, cwd: &Path) -> Result<Value, String> {
    let Some(runtime) = installed().cloned() else { return Err(NO_RUNTIME.to_owned()) };
    run_pptx_script_on(runtime, script, output, cwd).await
}

/// [`run_pptx_script`] on a named interpreter.
pub async fn run_pptx_script_on(runtime: ScriptRuntime, script: &str, output: &Path, cwd: &Path) -> Result<Value, String> {
    let request = json!({ "script": script, "output": output.to_string_lossy(), "cwd": cwd.to_string_lossy() }).to_string();
    let (answer, result) = tokio::sync::oneshot::channel();
    // The interpreter is waited on outside the async runtime: the thread of the call stays free and no lane job is held.
    #[allow(clippy::disallowed_methods, reason = "one thread per script run, which blocks until the interpreter exits")]
    std::thread::Builder::new()
        .name("pptx-script".to_owned())
        .spawn(move || {
            let _ = answer.send(run_blocking(&runtime, &request, HARD_LIMIT));
        })
        .map_err(|error| format!("The pptxgenjs script could not start: {error}"))?;
    result.await.map_err(|_| "The pptxgenjs script run ended without an answer".to_owned())?
}

fn read_all(pipe: Option<Box<dyn Read + Send>>) -> std::thread::JoinHandle<Vec<u8>> {
    #[allow(clippy::disallowed_methods, reason = "drains one pipe of the interpreter while the run thread waits for its exit")]
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    })
}

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs on the thread of the script run: starts the interpreter and blocks on its pipes")]
fn run_blocking(runtime: &ScriptRuntime, request: &str, limit: Duration) -> Result<Value, String> {
    let mut child = spawn_interpreter(runtime)?;
    let stdin = child.stdin.take();
    let out = read_all(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let err = read_all(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let request = request.to_owned();
    let feeder = std::thread::spawn(move || {
        if let Some(mut pipe) = stdin {
            let _ = pipe.write_all(request.as_bytes());
        }
    });
    let status = wait_for_exit(&mut child, limit)?;
    let _ = feeder.join();
    let out = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    let err = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    let Some(status) = status else {
        return Ok(
            json!({ "ok": false, "error": { "message": "Authoring script exceeded 90000 ms", "line": null, "excerpt": "" }, "logs": [], "elapsedMs": 90_000 }),
        );
    };
    answer_of(&out, &err, status)
}

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs on the thread of the script run: starts the interpreter")]
fn spawn_interpreter(runtime: &ScriptRuntime) -> Result<Child, String> {
    let entry = runtime.package_root.join(ENTRY);
    let mut command = Command::new(&runtime.program);
    command.arg(&entry).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if runtime.electron {
        command.env("ELECTRON_RUN_AS_NODE", "1");
    } else {
        command.env_remove("ELECTRON_RUN_AS_NODE");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the interpreter of a windowless core opens no console.
        command.creation_flags(0x0800_0000);
    }
    command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!(
                "A pptxgenjs script cannot run: the script interpreter {} is not there. Author the deck as HTML slides (a source that opens with <) instead.",
                runtime.program.display()
            )
        } else {
            format!("The script interpreter {} could not start: {error}", runtime.program.display())
        }
    })
}

/// The exit status, or `None` when the interpreter outlived `limit` and was killed.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs on the thread of the script run: blocks on the interpreter's exit")]
fn wait_for_exit(child: &mut Child, limit: Duration) -> Result<Option<ExitStatus>, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) if started.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(format!("Waiting for the script interpreter failed: {error}")),
        }
    }
}

/// The function's answer after the marker on standard output; what it threw is an error.
fn answer_of(out: &str, err: &str, status: ExitStatus) -> Result<Value, String> {
    let answer = out.rfind(ANSWER_MARKER).map(|at| out[at + ANSWER_MARKER.len()..].lines().next().unwrap_or_default());
    let Some(answer) = answer.and_then(|line| serde_json::from_str::<Value>(line).ok()) else {
        let said = err.trim();
        let tail: String = said.chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
        let detail = if tail.is_empty() { String::new() } else { format!(": {tail}") };
        return Err(format!("The script interpreter ended ({status}) without an answer{detail}"));
    };
    match answer.get("thrown").and_then(Value::as_str) {
        Some(thrown) => Err(thrown.to_owned()),
        None => Ok(answer),
    }
}
