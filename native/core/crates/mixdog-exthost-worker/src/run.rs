//! The frame loop of a worker (`runWorker` of `src/ext-host/worker-core.mjs`): one call at a time, chunks under a byte window the
//! pool re-grants, cancel through the call's token.

use std::process::ExitCode;
use std::sync::Arc;

use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::task::JoinError;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::ctx::CallCtx;
use crate::ctx::CallLink;
use crate::ctx::Message;
use crate::ctx::Output;
use crate::error::CodedError;
use crate::registry::HandlerResult;
use crate::registry::Registry;
use crate::registry::panic_text;
use crate::wire;
use crate::wire::FrameReader;
use crate::wire::Inbound;
use crate::wire::ProtocolError;

/// The exit code of a worker that met a frame it cannot read.
const PROTOCOL_ERROR_EXIT: u8 = 2;

/// The call being served.
struct Active {
    link: Arc<CallLink>,
    task: JoinHandle<HandlerResult>,
}

/// Serves `registry` over `input` and `output` until the pool says bye or closes the pipe (exit 0), or sends a frame that cannot
/// be read (exit 2, with `ext-host protocol error: <message>` on stderr). Sends READY first. Runs one call at a time.
pub async fn serve<R, W>(registry: Registry, input: R, output: W) -> ExitCode
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (out, writer) = spawn_writer(output);
    out.frame(wire::ready());
    let mut reader = FrameReader::new(input);
    let mut active: Option<Active> = None;

    let status = loop {
        let event = tokio::select! {
            biased;
            joined = finished(&mut active), if active.is_some() => Event::Finished(joined),
            frame = reader.next() => Event::Frame(frame),
        };
        match event {
            Event::Finished(joined) => {
                if let Some(call) = active.take() {
                    out.frame(wire::result(call.link.id(), &answer(&call.link, joined)));
                }
            }
            Event::Frame(Ok(Some(frame))) => match handle(frame, &registry, &out, &mut active) {
                Ok(Next::Continue) => {}
                Ok(Next::Leave) => break 0,
                Err(error) => {
                    eprintln!("ext-host protocol error: {error}");
                    break PROTOCOL_ERROR_EXIT;
                }
            },
            Event::Frame(Ok(None)) => break 0,
            Event::Frame(Err(error)) => {
                eprintln!("ext-host protocol error: {error}");
                break PROTOCOL_ERROR_EXIT;
            }
        }
    };

    if let Some(call) = &active {
        call.link.cancel();
    }
    // The handlers' state gives back what it owns before the process leaves.
    registry.run_exit_hook().await;
    let _ = out.0.send(Message::Close);
    let _ = writer.await;
    ExitCode::from(status)
}

enum Event {
    Finished(Result<HandlerResult, JoinError>),
    Frame(Result<Option<Inbound>, ProtocolError>),
}

enum Next {
    Continue,
    Leave,
}

async fn finished(active: &mut Option<Active>) -> Result<HandlerResult, JoinError> {
    match active {
        Some(call) => (&mut call.task).await,
        None => std::future::pending().await,
    }
}

fn handle(
    frame: Inbound,
    registry: &Registry,
    out: &Output,
    active: &mut Option<Active>,
) -> Result<Next, ProtocolError> {
    match frame {
        Inbound::Call { id, request } => {
            if active.is_some() {
                return Err(ProtocolError(
                    "ext-host: a call arrived while another is running".to_owned(),
                ));
            }
            let link = CallLink::new(
                id,
                out.clone(),
                CancellationToken::new(),
                wire::CALL_WINDOW_BYTES,
            );
            let handler = registry.handler(&request.method);
            let method = request.method.clone();
            let ctx = CallCtx::new(
                link.clone(),
                request.method,
                request.params,
                request.paths,
                request.thread,
                request.cwd,
            );
            let task = tokio::spawn(async move {
                match handler {
                    Some(handler) => handler(ctx).await,
                    None => Err(CodedError::new(
                        "unknown_method",
                        format!("unknown ext-host method {method}"),
                    )),
                }
            });
            *active = Some(Active { link, task });
        }
        Inbound::Cancel { id } => {
            if let Some(call) = active.as_ref().filter(|call| call.link.id() == id) {
                call.link.cancel();
            }
        }
        Inbound::Credit { id, bytes } => {
            if let Some(call) = active.as_ref().filter(|call| call.link.id() == id) {
                call.link.add_credit(bytes);
            }
        }
        Inbound::Browser { id, body } => {
            if let Some(call) = active
                .as_ref()
                .filter(|call| call.link.id() == id && call.link.browser_pending())
            {
                let answer: Value = serde_json::from_slice(&body)
                    .map_err(|e| ProtocolError(format!("ext-host: malformed browser body: {e}")))?;
                call.link.answer_browser(browser_answer(&answer));
            }
        }
        Inbound::Bye => return Ok(Next::Leave),
    }
    Ok(Next::Continue)
}

/// `{error}` is a refusal with its reason; otherwise `{ws}` is the endpoint.
fn browser_answer(answer: &Value) -> Result<String, String> {
    let text = |value: &Value| {
        value
            .as_str()
            .map_or_else(|| value.to_string(), str::to_owned)
    };
    match answer.get("error") {
        Some(error)
            if !error.is_null() && error != &Value::Bool(false) && error.as_str() != Some("") =>
        {
            Err(text(error))
        }
        _ => answer
            .get("ws")
            .filter(|ws| !ws.is_null())
            .map(text)
            .ok_or_else(|| "the pool answered without an endpoint".to_owned()),
    }
}

/// The RESULT body of a finished call. A call that was cancelled answers `cancelled` whatever its handler returned, with the pin
/// the handler reported.
fn answer(link: &CallLink, joined: Result<HandlerResult, JoinError>) -> Value {
    let outcome = joined.unwrap_or_else(|error| match error.try_into_panic() {
        Ok(payload) => Err(CodedError::failed(panic_text(&*payload))),
        Err(error) => Err(CodedError::failed(error.to_string())),
    });
    let pin = matches!(&outcome, Ok(outcome) if outcome.pin);
    if link.is_cancelled() {
        let cancelled = CodedError::cancelled();
        return json!({"err": {"code": cancelled.code, "message": cancelled.message}, "pin": pin});
    }
    match outcome {
        Ok(outcome) => json!({"ok": outcome.value, "pin": pin}),
        Err(error) => json!({"err": {"code": error.code, "message": error.message}, "pin": pin}),
    }
}

/// The task that owns `output`: it writes the frames in the order they were sent, and flushes before it waits for more.
fn spawn_writer<W>(mut output: W) -> (Output, JoinHandle<()>)
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let task = tokio::spawn(async move {
        let mut broken = false;
        'frames: while let Some(mut message) = rx.recv().await {
            loop {
                match message {
                    Message::Frame(bytes) => {
                        // A pipe nobody reads any more: the pool's end of the pipe closing ends the loop too.
                        broken = broken || output.write_all(&bytes).await.is_err();
                    }
                    Message::Close => {
                        let _ = output.flush().await;
                        break 'frames;
                    }
                }
                match rx.try_recv() {
                    Ok(next) => message = next,
                    Err(_) => break,
                }
            }
            if !broken && output.flush().await.is_err() {
                broken = true;
            }
        }
    });
    (Output(tx), task)
}

/// The pipes of the real worker process: the pool's input, and a private duplicate of standard output taken before anything else
/// can write to it. Standard output itself is pointed at standard error, so nothing a handler, a library or a child prints can
/// land in the frame stream.
#[allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the frame pipe is a descriptor, not a file on disk: tokio's file wrapper is its only async writer on every platform"
)]
pub fn stdio() -> std::io::Result<(tokio::io::Stdin, tokio::fs::File)> {
    let frames = take_stdout()?;
    Ok((tokio::io::stdin(), tokio::fs::File::from_std(frames)))
}

#[cfg(unix)]
#[allow(clippy::disallowed_types, reason = "owns the duplicated standard output descriptor, not a file on disk")]
fn take_stdout() -> std::io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    // SAFETY: plain descriptor calls; the duplicate is owned by the returned file and nothing else.
    unsafe {
        let frames = libc::fcntl(libc::STDOUT_FILENO, libc::F_DUPFD_CLOEXEC, 3);
        if frames < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let frames = std::fs::File::from_raw_fd(frames);
        if libc::dup2(libc::STDERR_FILENO, libc::STDOUT_FILENO) < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(frames)
    }
}

#[cfg(windows)]
#[allow(clippy::disallowed_types, reason = "owns the duplicated standard output handle, not a file on disk")]
fn take_stdout() -> std::io::Result<std::fs::File> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::DUPLICATE_SAME_ACCESS;
    use windows_sys::Win32::Foundation::DuplicateHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::GetStdHandle;
    use windows_sys::Win32::System::Console::STD_ERROR_HANDLE;
    use windows_sys::Win32::System::Console::STD_OUTPUT_HANDLE;
    use windows_sys::Win32::System::Console::SetStdHandle;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: plain handle calls; the duplicate (not inheritable, so no child gets it) is owned by the returned file.
    unsafe {
        let stdout = GetStdHandle(STD_OUTPUT_HANDLE);
        if stdout.is_null() || stdout == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::other("the worker has no standard output"));
        }
        let me = GetCurrentProcess();
        let mut frames: HANDLE = std::ptr::null_mut();
        if DuplicateHandle(me, stdout, me, &mut frames, 0, 0, DUPLICATE_SAME_ACCESS) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let frames = std::fs::File::from_raw_handle(frames);
        if SetStdHandle(STD_OUTPUT_HANDLE, GetStdHandle(STD_ERROR_HANDLE)) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(frames)
    }
}
