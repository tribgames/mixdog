//! The app side of the helper's pipe, as a library: connect to the installed
//! helper as the installing user, prove both ends know the install secret,
//! then read frames and desktop changes and send input. One owner thread
//! drives a `Link`: the pipe handle is synchronous, so a blocked read would
//! hold up a write from another thread.

use crate::protocol::{self, Decoded, FrameHeader, InputEvent, Message, PROTOCOL_VERSION};
use crate::security::{self, InstallState};
use crate::winutil::OwnedHandle;
use crate::{ipc, paths};
use std::io;
use std::time::{Duration, Instant};
use windows::Win32::System::Pipes::PeekNamedPipe;

/// What the helper says about itself once the handshake succeeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub protocol: u32,
    pub version: String,
    pub session: u32,
    /// The input desktop's object name (`Default`, `Winlogon`, ...).
    pub desktop: String,
    pub locked: Option<bool>,
}

/// What arrives from the helper after the handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A captured frame: BGRA pixels with their header.
    Frame(FrameHeader, Vec<u8>),
    DesktopChanged {
        desktop: String,
        session: u32,
        locked: Option<bool>,
    },
    /// A condition the helper reports; `code` is stable.
    Error { code: String, message: String },
    /// A grant challenge for the paired phone to sign.
    GrantChallenge { nonce: String, challenge: String },
}

/// Performs the mutual challenge-response as the client. The on-disk secret
/// is never sent; the server must prove it knows the secret first, and this
/// aborts without revealing its own proof if that fails, so a same-name
/// squatter that lacks the secret learns nothing usable.
pub fn authenticate(io: &mut ipc::PipeIo, state: &InstallState) -> Result<Hello, String> {
    let client_nonce_b64 = security::generate_nonce();
    let client_nonce =
        security::decode_nonce(&client_nonce_b64).ok_or("failed to generate a client nonce")?;
    protocol::write_all(
        io,
        &protocol::encode_control(&Message::ClientHello {
            protocol: PROTOCOL_VERSION,
            client_nonce: client_nonce_b64,
        }),
    )
    .map_err(|error| format!("failed to send client-hello: {error}"))?;

    // The server proves knowledge of the secret before we send ours.
    let (server_nonce, server_mac) = match protocol::read_frame(io) {
        Ok(Decoded::Control(Message::ServerAuth {
            protocol,
            server_nonce,
            mac,
        })) => {
            if protocol != PROTOCOL_VERSION {
                return Err(format!(
                    "server speaks protocol {protocol}, expected {PROTOCOL_VERSION}"
                ));
            }
            (server_nonce, mac)
        }
        Ok(Decoded::Control(Message::Error { code, message })) => {
            return Err(format!("handshake rejected code={code} message={message}"))
        }
        Ok(other) => return Err(format!("unexpected handshake reply: {other:?}")),
        Err(error) => return Err(format!("reading server-auth: {error}")),
    };
    let server_nonce_bytes =
        security::decode_nonce(&server_nonce).ok_or("server sent a malformed nonce")?;
    let expected = security::server_auth_tag(&state.secret, &client_nonce, &server_nonce_bytes);
    if !security::secret_matches(&expected, &server_mac) {
        return Err(
            "server authentication failed (not the real helper); aborting before sending our proof"
                .into(),
        );
    }

    // Only after the server is proven do we reveal our own proof.
    let client_mac = security::client_auth_tag(&state.secret, &server_nonce_bytes, &client_nonce);
    protocol::write_all(
        io,
        &protocol::encode_control(&Message::ClientAuth { mac: client_mac }),
    )
    .map_err(|error| format!("failed to send client-auth: {error}"))?;

    match protocol::read_frame(io) {
        Ok(Decoded::Control(Message::ServerHello {
            protocol,
            version,
            session,
            desktop,
            locked,
        })) => Ok(Hello {
            protocol,
            version,
            session,
            desktop,
            locked,
        }),
        Ok(Decoded::Control(Message::Error { code, message })) => {
            Err(format!("handshake rejected code={code} message={message}"))
        }
        Ok(other) => Err(format!("unexpected reply after client-auth: {other:?}")),
        Err(error) => Err(format!("reading server-hello: {error}")),
    }
}

pub struct Link {
    pipe: OwnedHandle,
    hello: Hello,
}

impl Link {
    /// Connects to the installed helper and authenticates. Errors say whether
    /// the helper is not installed, not reachable, or not the real one.
    pub fn connect() -> Result<Link, String> {
        let state = std::fs::read_to_string(paths::state_file())
            .ok()
            .and_then(|text| InstallState::from_json(&text).ok())
            .ok_or_else(|| {
                format!(
                    "secure_desktop_not_installed: no readable state at {}",
                    paths::state_file().display()
                )
            })?;
        let pipe = ipc::connect(&state.pipe_name).map_err(|error| {
            format!(
                "secure_desktop_unreachable: cannot connect to {}: {error}",
                state.pipe_name
            )
        })?;
        let hello = authenticate(&mut ipc::PipeIo(pipe.get()), &state)?;
        Ok(Link { pipe, hello })
    }

    pub fn hello(&self) -> &Hello {
        &self.hello
    }

    fn io(&self) -> ipc::PipeIo {
        ipc::PipeIo(self.pipe.get())
    }

    fn send(&mut self, message: &Message) -> io::Result<()> {
        protocol::write_all(&mut self.io(), &protocol::encode_control(message))
    }

    /// Starts or stops the remote-control session; capture is inert until it
    /// is active, and `false` stops capture and injection.
    pub fn set_active(&mut self, active: bool) -> io::Result<()> {
        self.send(&Message::Control { active })
    }

    /// Declares the video run the phone is shown; a grant names the run it
    /// was signed for.
    pub fn set_video_run(&mut self, epoch: u64) -> io::Result<()> {
        self.send(&Message::VideoRun { epoch })
    }

    /// Hands the helper the paired phone's signature over a grant challenge.
    pub fn grant(&mut self, challenge: String, epoch: u64, signature: String) -> io::Result<()> {
        self.send(&Message::Grant {
            challenge,
            epoch,
            signature,
        })
    }

    /// One input action in desktop pixels. The helper applies it only while
    /// control is active and a grant is live.
    pub fn send_input(&mut self, event: InputEvent) -> io::Result<()> {
        self.send(&Message::Input { event })
    }

    /// Presses the secure attention sequence (Ctrl+Alt+Del).
    pub fn send_sas(&mut self) -> io::Result<()> {
        self.send(&Message::Sas)
    }

    fn available(&self) -> io::Result<bool> {
        let mut bytes = 0u32;
        // SAFETY: a plain availability probe on the owned pipe handle.
        unsafe { PeekNamedPipe(self.pipe.get(), None, 0, None, Some(&mut bytes), None) }
            .map_err(|error| io::Error::other(error.message()))?;
        Ok(bytes > 0)
    }

    /// The next event, or `None` when nothing arrived within `wait`. A frame
    /// that has begun arriving is read to its end. The pipe closing is an error.
    pub fn next(&mut self, wait: Duration) -> io::Result<Option<Event>> {
        let deadline = Instant::now() + wait;
        while !self.available()? {
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(Some(match protocol::read_frame(&mut self.io())? {
            Decoded::Video(header, pixels) => Event::Frame(header, pixels),
            Decoded::Control(Message::DesktopChanged {
                desktop,
                session,
                locked,
            }) => Event::DesktopChanged {
                desktop,
                session,
                locked,
            },
            Decoded::Control(Message::Error { code, message }) => Event::Error { code, message },
            Decoded::Control(Message::GrantChallenge { nonce, challenge }) => {
                Event::GrantChallenge { nonce, challenge }
            }
            Decoded::Control(other) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unexpected message from the helper: {other:?}"),
                ))
            }
        }))
    }
}
