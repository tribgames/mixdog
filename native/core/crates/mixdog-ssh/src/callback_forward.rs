//! The callback forward of a server login: this PC listens on the provider's loopback callback port and carries each
//! accepted connection to the same port on the server through its own `ssh -W`. The listener is this PC's own bind, so
//! a port something else holds is found by the bind itself, never by a check that a later bind could contradict (on
//! Windows ssh's own `-L` bind can share a port another program already listens on, and that program keeps the
//! traffic).

use std::io;
use std::net::Ipv4Addr;
use std::sync::Mutex;

use tokio::io::{AsyncWriteExt, copy};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};

use crate::command::{stdio_forward_args, SshTarget};
use crate::context::{AttemptContext, SshEnv};
use crate::spawn::spawn_ssh;
use crate::tunnel::pump;

/// A login's redirect needs one or two connections (a retry, a favicon); one ssh runs per connection, so a burst of
/// connections is bounded here.
pub const MAX_CONNECTIONS: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum CallbackForwardError {
    /// Something on this PC holds the port.
    #[error("Port {0} is in use on this PC.")]
    PortInUse(u16),
    #[error("{0}")]
    Io(#[from] io::Error),
}

/// An open callback forward. Dropping it stops the listener; [`CallbackForward::close`] also waits for the connections to end.
pub struct CallbackForward {
    closing: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

/// Listens on 127.0.0.1:`port` here; `PortInUse` when the port is taken on this PC. Every ssh it starts runs under
/// `ctx` (the server's key file, batch mode).
pub async fn open_callback_forward(env: SshEnv, ctx: Option<AttemptContext>, target: SshTarget, port: u16) -> Result<CallbackForward, CallbackForwardError> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await.map_err(|error| match error.kind() {
        io::ErrorKind::AddrInUse | io::ErrorKind::PermissionDenied => CallbackForwardError::PortInUse(port),
        _ => CallbackForwardError::Io(error),
    })?;
    let (closing, closed) = watch::channel(false);
    let task = tokio::spawn(accept_loop(listener, closed, env, ctx, target, port));
    Ok(CallbackForward { closing, task: Mutex::new(Some(task)) })
}

impl CallbackForward {
    /// Stops listening and ends every connection still carried, each with its ssh; resolves once they are gone.
    pub async fn close(&self) {
        self.closing.send_replace(true);
        let task = self.task.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

async fn accept_loop(listener: TcpListener, mut closed: watch::Receiver<bool>, env: SshEnv, ctx: Option<AttemptContext>, target: SshTarget, port: u16) {
    let mut carried = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = closed.changed() => break,
            Some(_) = carried.join_next(), if !carried.is_empty() => {}
            accepted = listener.accept() => {
                let Ok((socket, _)) = accepted else { continue };
                if carried.len() >= MAX_CONNECTIONS {
                    drop(socket);
                    continue;
                }
                carried.spawn(carry(socket, env.clone(), ctx.clone(), target.clone(), port));
            }
        }
    }
    drop(listener);
    // Ending the tasks drops each child, which kills its ssh, and each socket.
    carried.shutdown().await;
}

/// One browser connection over one `ssh -W`. It ends when the browser's socket and the answer are both done, when ssh
/// fails (the browser's connection is then dropped at once), or when the task is dropped.
async fn carry(socket: TcpStream, env: SshEnv, ctx: Option<AttemptContext>, target: SshTarget, port: u16) {
    let Ok(mut child) = spawn_ssh(&env, "ssh", &stdio_forward_args(&target, port), ctx.as_ref()) else { return };
    let (Some(mut stdin), Some(mut stdout)) = (child.take_stdin(), child.take_stdout()) else { return };
    pump(child.take_stderr(), None);
    let (mut from_browser, mut to_browser) = socket.into_split();
    let mut upstream = std::pin::pin!(async move {
        let _ = copy(&mut from_browser, &mut stdin).await;
        let _ = stdin.shutdown().await;
    });
    // The answer ends the browser's socket once ssh's stdout reaches EOF, so a clean ssh exit before its stdout is
    // read out still delivers all of it.
    let mut downstream = std::pin::pin!(async move {
        let _ = copy(&mut stdout, &mut to_browser).await;
        let _ = to_browser.shutdown().await;
    });
    let (mut upstream_done, mut exited) = (false, false);
    loop {
        tokio::select! {
            biased;
            () = &mut downstream => break,
            exit = child.wait(), if !exited => {
                exited = true;
                if !matches!(exit, Ok(done) if done.code == Some(0)) {
                    break;
                }
            }
            () = &mut upstream, if !upstream_done => upstream_done = true,
        }
    }
    child.kill();
}
