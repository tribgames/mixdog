//! The session helper (`mixdog-secure-desktop helper <shutdown-token> <service-pid>`).
//!
//! Launched by the service as SYSTEM in the active console session, it owns the
//! app-facing named pipe, captures the current input desktop, and injects the
//! input the app requests — all gated on an explicit remote-control session.
//!
//! The loop is single-threaded on purpose: GDI capture and `SendInput` both act
//! on the thread's attached desktop, so keeping capture, injection, and the
//! desktop re-attach on one thread means they can never disagree about which
//! desktop is live. No pipe operation blocks the loop on its peer (see
//! [`ServerPipe`]): inbound bytes are taken only when already buffered, output
//! is queued and written overlapped under a total per-frame deadline, and the
//! accept and every sleep also wake on the service's stop event. On stop the
//! helper releases everything it holds, acknowledges, and exits
//! ([`crate::shutdown`]).
//!
//! Security posture enforced here: frames stream only while the app has sent
//! `control { active: true }`; new input and `sas` additionally need a live
//! **control grant** — a challenge this helper issued on this connection,
//! signed by the paired phone's enrolled key for the current video run
//! ([`crate::security::GrantBook`]) — because the pipe admits every process of
//! the installing user, and input from this SYSTEM helper is not subject to
//! UIPI (a same-user process must not be able to click "Yes" on its own UAC
//! prompt). Without a grant, only an in-place release of a button/key this
//! connection still holds is applied. A connection can never release input it
//! did not press; the handshake rejects a wrong protocol version or a bad
//! secret before anything else happens; the pipe's DACL (built from the
//! installing user's SID) is applied at creation; and before the handshake,
//! the connecting client is verified to be the installing user running in the
//! console session this helper serves. Held pointer/keyboard input is tracked
//! and released on every transition — including a grant's lapse — so a press
//! can never be stranded on the (possibly secure) desktop. No message is
//! logged with the secret, and no frame pixels are ever logged.
//!
//! The service instance that launched this helper is watched as its parent
//! ([`HelperEnd`]): if it dies, the helper releases everything and exits like
//! on a stop request.

use std::time::{Duration, Instant};

use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;

use crate::ipc::{Accept, SendError, ServerPipe};
use crate::protocol::{self, Decoded, FrameHeader, InputEvent, Message, PROTOCOL_VERSION};
use crate::security::{
    client_auth_tag, decode_nonce, encode_nonce, generate_challenge, generate_nonce,
    is_shutdown_token, sas_policy, secret_matches, server_auth_tag, GrantBook, InstallState,
    SasPolicy, CONTROLLER_KEY_BYTES,
};
use crate::shutdown::HelperEnd;
use crate::winutil::{client_user_sid, now_ms};
use crate::{capture, desktop, inject, ipc, log, paths};

/// Target capture cadence while active. The WebRTC transport drives real pacing;
/// this bounds CPU on the secure desktop where GDI is the only option.
const CAPTURE_INTERVAL: Duration = Duration::from_millis(66);
const IDLE_SLEEP: Duration = Duration::from_millis(50);
const ACTIVE_SLEEP: Duration = Duration::from_millis(8);

/// How long a connected client may take to complete the challenge-response handshake
/// before it is dropped. Decision (not derived from the capture cadence, which
/// paces a steady stream, whereas the handshake is a single local round-trip
/// that completes in well under a millisecond): a 10-second human-scale ceiling
/// frees the single pipe instance from a stuck or hostile peer without any risk
/// of a false timeout on a healthy client.
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

/// The **total** time one frame may take, in either direction:
///
/// - inbound: from the frame's first byte until it is dispatched — checked at
///   dispatch, so a frame completing late is dropped unexecuted;
/// - outbound: from when the frame is queued until its write completes. That
///   bounds *backpressure* (the write's bytes reached the small outbound pipe
///   buffer), not delivery — there are no frame acks — and because that buffer
///   is far smaller than any video frame, a client that stops reading stalls
///   the next write and trips it.
///
/// Same 10-second ceiling and reasoning as the handshake: a local frame
/// transfers in a continuous write, so one still incomplete after 10 s means a
/// stalled or hostile peer (one that dribbles bytes, or one that stopped
/// reading). It is a total deadline, not an inactivity timer, so trickling a
/// byte at a time cannot extend it.
pub(crate) const FRAME_DEADLINE: Duration = Duration::from_secs(10);

/// How long the service waits for this helper to acknowledge a stop and exit
/// before force-killing it. It is the frame deadline, reused rather than a new
/// number: no step of the helper's loop blocks on its peer for longer — accept
/// and every sleep also wake on the stop event, and writes are overlapped and
/// polled — so a helper that has not acknowledged within it is wedged.
pub const SHUTDOWN_DEADLINE: Duration = FRAME_DEADLINE;

/// Per-iteration read size. Matches the pipe's buffer so a full buffer drains
/// in one read.
const READ_CHUNK: usize = 1 << 16;

/// While the input desktop cannot be attached, attaching is retried once per
/// frame interval: that is when a frame would next be captured, so retrying
/// faster gains nothing and retrying slower would delay the first frame of
/// the new desktop.
const REATTACH_INTERVAL: Duration = CAPTURE_INTERVAL;

/// The shutdown token of `helper <shutdown-token>`: exactly one argument, a
/// well-formed token. Anything else (including the retired
/// `<token> <service-pid>` form) is refused.
fn parse_helper_args(args: &[String]) -> Option<&str> {
    match args {
        [token] if is_shutdown_token(token) => Some(token),
        _ => None,
    }
}

/// Entry point for `helper <shutdown-token>`. Returns an exit code.
///
/// The token names the service's per-launch events and parent section; the
/// parent watch's handle was duplicated into this process by the service
/// before it was resumed ([`crate::shutdown`]). Once the channel is open the
/// parent watch is armed: the helper confirms that and serves nothing until
/// the service has disarmed the kill-on-close bootstrap job it was created in.
/// Every return after the channel is open acknowledges — by then no injector
/// is alive, so everything the helper held has been released (see
/// `Injector`'s `Drop`).
pub fn run(args: &[String]) -> i32 {
    let shutdown = match parse_helper_args(args) {
        Some(token) => match HelperEnd::open(token) {
            Ok(shutdown) => shutdown,
            Err(error) => {
                log::event("helper", &format!("shutdown channel unavailable: {error}"));
                return 2;
            }
        },
        None => {
            log::event("helper", "missing or malformed shutdown token");
            return 2;
        }
    };
    let code = if shutdown.confirm_parent_watch() {
        serve(&shutdown)
    } else {
        log::event(
            "helper",
            if shutdown.service_gone() {
                "service exited before releasing the bootstrap"
            } else {
                "stop requested before the bootstrap was released"
            },
        );
        0
    };
    shutdown.acknowledge();
    log::event(
        "helper",
        &format!("exiting ({code}); all held input released"),
    );
    code
}

/// Accept and serve clients one at a time until stop is requested or the pipe
/// fails.
fn serve(shutdown: &HelperEnd) -> i32 {
    let state = match load_state() {
        Ok(state) => state,
        Err(error) => {
            log::event("helper", &format!("state unavailable: {error}"));
            return 2;
        }
    };
    let sddl = match crate::security::pipe_sddl(&state.user_sid) {
        Some(sddl) => sddl,
        None => {
            log::event("helper", "install state has an invalid user SID");
            return 2;
        }
    };

    log::event("helper", "started");
    // One server instance, reused across client reconnects. First-instance
    // creation refuses a squatter that already owns the name.
    let mut server = match ServerPipe::create(&state.pipe_name, &sddl, true, FRAME_DEADLINE) {
        Ok(server) => server,
        Err(error) => {
            log::event("helper", &format!("pipe create failed: {error}"));
            return 2;
        }
    };

    loop {
        match server.accept(&shutdown.stop_handles()) {
            Ok(Accept::Connected) => {}
            Ok(Accept::Stopped) => {
                log::event(
                    "helper",
                    if shutdown.service_gone() {
                        "service exited while idle"
                    } else {
                        "stop requested while idle"
                    },
                );
                return 0;
            }
            Err(error) => {
                log::event("helper", &format!("accept failed ({error}); exiting"));
                return 1;
            }
        }
        let pid = ipc::client_pid(server.handle()).unwrap_or(0);
        log::event("helper", &format!("client connected pid={pid}"));
        serve_client(&mut server, &state, shutdown);
        server.disconnect();
        log::event("helper", "client disconnected");
        if shutdown.stop_requested() {
            log::event(
                "helper",
                if shutdown.service_gone() {
                    "service exited"
                } else {
                    "stop requested"
                },
            );
            return 0;
        }
    }
}

/// Confirm the connected client is the installing user, running in the console
/// session this helper serves. This is the per-connection half of the session
/// policy: the DACL already limits the pipe to the installing user and SYSTEM,
/// and this additionally rejects any client whose session is not the serviced
/// console session (so a client left over in a fast-user-switched-away session
/// cannot be served) and whose token user is not the installing user.
fn verify_client(server: &ServerPipe, state: &InstallState) -> Result<(), String> {
    let serviced = session_id();
    match ipc::client_session_id(server.handle()) {
        Some(session) if session == serviced => {}
        Some(session) => {
            return Err(format!(
                "client is in session {session}, not the serviced console session {serviced}"
            ))
        }
        None => return Err("cannot determine the client session".into()),
    }
    match client_user_sid(server.handle().get()) {
        Some(sid) if sid.eq_ignore_ascii_case(&state.user_sid) => Ok(()),
        Some(sid) => Err(format!("client user {sid} is not the installing user")),
        None => Err("cannot determine the client user".into()),
    }
}

fn load_state() -> Result<InstallState, String> {
    let text = std::fs::read_to_string(paths::state_file())
        .map_err(|error| format!("cannot read install state: {error}"))?;
    InstallState::from_json(&text)
}

fn session_id() -> u32 {
    unsafe { WTSGetActiveConsoleSessionId() }
}

/// Serve one connected client until it disconnects, a fatal write fails, the
/// framing is violated, a deadline passes, or the console session changes.
fn serve_client(server: &mut ServerPipe, state: &InstallState, shutdown: &HelperEnd) {
    if let Err(reason) = verify_client(server, state) {
        // No error frame to an unverified client: it has not proven it is the
        // installing user, so it gets nothing but a disconnect.
        log::event("helper", &format!("client rejected: {reason}"));
        return;
    }

    // Dropped (releasing anything still held) on every return from here.
    let mut injector = inject::Injector::new();

    // Attach to the current input desktop before the handshake so the first
    // ServerHello already names the right desktop.
    let (mut _attached, mut attached_name) = match desktop::attach_to_input_desktop() {
        Ok(pair) => pair,
        Err(error) => {
            log::event("helper", &format!("desktop attach failed: {error}"));
            let _ = protocol::write_all(
                server,
                &protocol::encode_control(&Message::error(
                    "desktop_attach_failed",
                    error.to_string(),
                )),
            );
            linger(server, shutdown);
            return;
        }
    };

    let launch_session = session_id();
    let mut acc = protocol::FrameAccumulator::new();
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut handshake = Handshake::new();
    // Created once the handshake completes (it is bound to its server nonce).
    let mut control: Option<Control> = None;
    let mut replies: Vec<Message> = Vec::new();
    let mut seq: u64 = 0;
    let mut locked = desktop::session_locked(launch_session);
    let mut next_reattach = Instant::now();
    // Failed attempts of the current outage, logged once when it ends.
    let mut reattach_failures: u32 = 0;
    let connected_at = Instant::now();
    let mut next_capture = Instant::now();
    // The committed key set reaches this live connection by re-reading the
    // protected state file before every authorization-bearing step — right
    // after the handshake, before each post-handshake control frame (input,
    // `sas`, grant; [`dispatch_refreshed`]) and before each pass's grant upkeep
    // (challenges, lapse) — and comparing its *bytes* with the last good load
    // (never its mtime, which can collide or be preserved by a replace): a
    // small, OS-cached file read, parsed only when the content changed. The
    // write side is atomic, so a reader never sees partial JSON; an
    // unreadable/unparseable state suspends authorization (fail closed) until a
    // good read. `loaded_state` advances only after a successful load.
    let mut loaded_state: Option<Vec<u8>> = None;
    let mut read_state = || std::fs::read(paths::state_file());
    // Set when the connection ends with an error frame the client should get
    // to read before the disconnect discards it.
    let mut farewell = false;

    'serve: loop {
        if shutdown.stop_requested() {
            log::event("helper", "stop requested; ending client");
            break 'serve;
        }
        // Revoke immediately if the console session changed under us (fast user
        // switch): this helper serves exactly one console session.
        if session_id() != launch_session {
            log::event("helper", "console session changed; ending client");
            break 'serve;
        }

        // Pull whatever bytes are waiting into the accumulator without blocking,
        // so a partial length prefix can never stall capture or monitoring.
        match server.read_available(&mut buffer) {
            None => break 'serve, // peer gone
            Some(0) => {}
            Some(read) => acc.extend(&buffer[..read], Instant::now()),
        }

        // Drain every complete frame the accumulator can produce.
        loop {
            // Each frame is checked against its own first-byte deadline at
            // dispatch time; a late frame drops the client unexecuted.
            match acc.next_frame(Instant::now(), FRAME_DEADLINE) {
                Ok(None) => break,
                Err(reason) => {
                    log::event("helper", &format!("framing error: {reason}"));
                    break 'serve;
                }
                Ok(Some(Decoded::Video(..))) => { /* clients never send video */ }
                Ok(Some(Decoded::Control(message))) => {
                    if let Some(control) = control.as_mut() {
                        let now = Instant::now();
                        let effect = dispatch_refreshed(
                            &mut injector,
                            control,
                            &mut loaded_state,
                            &mut read_state,
                            message,
                            now,
                            &crate::security::ecdsa_p256_verify,
                            &mut replies,
                        );
                        if matches!(effect, Effect::Sas) {
                            request_sas(
                                &mut injector,
                                control,
                                crate::service::software_sas_generation,
                                || shutdown.request_sas(),
                                &mut replies,
                            );
                        }
                    } else {
                        match handshake.advance(server, state, &attached_name, message) {
                            HandshakeStep::Fail => {
                                // A rejection may have queued an error frame.
                                farewell = !server.is_idle();
                                break 'serve;
                            }
                            HandshakeStep::Done => {
                                let nonce =
                                    handshake.connection_nonce().unwrap_or_default().to_vec();
                                let mut fresh = Control::new(nonce, state.controller_keys_bytes());
                                // Never start from `serve`'s snapshot: load the
                                // committed set before anything is dispatched.
                                apply_refresh(
                                    &mut injector,
                                    &mut fresh,
                                    &mut loaded_state,
                                    read_state(),
                                    &mut replies,
                                );
                                control = Some(fresh);
                            }
                            HandshakeStep::Continue => {}
                        }
                    }
                }
            }
        }

        // Grant upkeep: a lapse releases held input, a fresh challenge is
        // issued on cadence, and a failed injection is reported. The committed
        // key set is refreshed first, so a revoke on an idle connection (no
        // frames this pass) still ends its grant and releases held input.
        if let Some(control) = control.as_mut() {
            apply_refresh(
                &mut injector,
                control,
                &mut loaded_state,
                read_state(),
                &mut replies,
            );
            tick(&mut injector, control, Instant::now(), &mut replies);
        }
        for reply in replies.drain(..) {
            let _ = protocol::write_all(server, &protocol::encode_control(&reply));
        }

        // Move queued output along. Never blocks; a client that stopped reading
        // fails here once a frame outlives FRAME_DEADLINE.
        match server.pump() {
            Ok(()) => {}
            Err(SendError::TimedOut) => {
                log::event(
                    "helper",
                    "write deadline exceeded (client stopped reading); dropping client",
                );
                break 'serve;
            }
            Err(SendError::Closed(reason)) => {
                log::event(
                    "helper",
                    &format!("write failed ({reason}); dropping client"),
                );
                break 'serve;
            }
        }

        // Deadlines free the single pipe instance from a stuck or hostile peer.
        if !handshake.is_done() && connected_at.elapsed() > HANDSHAKE_DEADLINE {
            log::event("helper", "handshake deadline exceeded; dropping client");
            break 'serve;
        }
        if acc.frame_overdue(Instant::now(), FRAME_DEADLINE) {
            log::event("helper", "inbound frame deadline exceeded; dropping client");
            break 'serve;
        }

        if let Some(control) = control.as_mut() {
            let now = Instant::now();
            // Follow the input desktop across UAC / lock transitions, releasing
            // any held input first so nothing is stranded on the old desktop.
            // An input desktop that cannot be named or attached is an outage:
            // the client is told once (`desktop_unavailable`), capture and
            // injection stop rather than act on the old desktop, and attaching
            // is retried once per frame interval (REATTACH_INTERVAL). Injection
            // can find the outage first (a blocked insert whose re-attach
            // fails): it suspends at once (`suspend_if_desktop_lost`) and
            // recovery is this same path. The log gets a line when the outage
            // is found and one when it ends.
            let input_name = desktop::input_desktop_name();
            let current =
                control.desktop_available && input_name.as_deref() == Some(attached_name.as_str());
            if !current && now >= next_reattach {
                injector.release_all();
                // This path attaches next; a loss those releases met is its own.
                let _ = injector.take_desktop_lost();
                match desktop::attach_to_input_desktop() {
                    Ok((owned, name)) => {
                        _attached = owned;
                        let changed_name = name != attached_name || !control.desktop_available;
                        attached_name = name;
                        control.desktop_available = true;
                        if reattach_failures > 0 {
                            log::event(
                                "helper",
                                &format!("input desktop attached again after {reattach_failures} failed attempts"),
                            );
                            reattach_failures = 0;
                        }
                        if changed_name {
                            let changed = Message::DesktopChanged {
                                desktop: attached_name.clone(),
                                session: session_id(),
                                locked,
                            };
                            let _ =
                                protocol::write_all(server, &protocol::encode_control(&changed));
                            log::event("helper", &format!("desktop changed to {attached_name}"));
                        }
                    }
                    Err(error) => {
                        if control.desktop_available {
                            control.desktop_available = false;
                            let message = Message::error("desktop_unavailable", error.to_string());
                            let _ =
                                protocol::write_all(server, &protocol::encode_control(&message));
                        }
                        if reattach_failures == 0 {
                            log::event(
                                "helper",
                                &format!("input desktop unavailable: {error}; retrying"),
                            );
                        }
                        reattach_failures = reattach_failures.saturating_add(1);
                        next_reattach = now + REATTACH_INTERVAL;
                    }
                }
            }

            // The lock state (WTS) tells the lock screen apart from UAC, which
            // share the Winlogon desktop. It is re-read when the service
            // relays a lock / unlock notification for this session.
            if shutdown.session_state_changed() {
                let current = desktop::session_locked(launch_session);
                if current != locked {
                    locked = current;
                    let changed = Message::DesktopChanged {
                        desktop: attached_name.clone(),
                        session: session_id(),
                        locked,
                    };
                    let _ = protocol::write_all(server, &protocol::encode_control(&changed));
                }
            }

            // Capture only when the previous output's writes completed: a slow
            // reader gets fewer frames instead of a growing backlog.
            if control.active
                && control.desktop_available
                && server.is_idle()
                && Instant::now() >= next_capture
            {
                match capture::capture_virtual_screen() {
                    Ok(frame) => {
                        seq += 1;
                        let header = FrameHeader {
                            seq,
                            width: frame.width,
                            height: frame.height,
                            stride: frame.stride,
                            format: "bgra".to_string(),
                            timestamp_ms: now_ms(),
                            origin_x: frame.origin_x,
                            origin_y: frame.origin_y,
                            desktop: attached_name.clone(),
                            dirty: Vec::new(),
                        };
                        let _ = protocol::write_all(
                            server,
                            &protocol::encode_video(&header, &frame.pixels),
                        );
                    }
                    Err(error) => {
                        // Log the OS error and the desktop name only — never pixels.
                        let message =
                            Message::error("capture_failed", format!("{error} on {attached_name}"));
                        let _ = protocol::write_all(server, &protocol::encode_control(&message));
                    }
                }
                next_capture = Instant::now() + CAPTURE_INTERVAL;
            }
        }

        // Sleep, but wake at once on a stop request or the service's exit.
        let active = control.as_ref().is_some_and(|control| control.active);
        if shutdown.wait_stop(if active { ACTIVE_SLEEP } else { IDLE_SLEEP }) {
            log::event("helper", "stop requested; ending client");
            break 'serve;
        }
    }

    // Release any still-held pointer buttons / keys on every exit path:
    // disconnect, framing error, deadline, session change, or stop — before
    // lingering, so a slow farewell never delays the release.
    injector.release_all();
    if farewell {
        linger(server, shutdown);
    }
}

/// Give the client a bounded chance to read a final error frame before the
/// disconnect discards unread pipe data: wait until it closes its end, the
/// frame deadline passes, the write fails, or stop is requested.
fn linger(server: &mut ServerPipe, shutdown: &HelperEnd) {
    let deadline = Instant::now() + FRAME_DEADLINE;
    while Instant::now() < deadline && server.peer_connected() {
        if server.pump().is_err() || shutdown.wait_stop(IDLE_SLEEP) {
            return;
        }
    }
}

/// The outcome of feeding one control frame to the [`Handshake`].
enum HandshakeStep {
    /// Progress made (e.g. `server-auth` sent); keep reading.
    Continue,
    /// Mutual authentication complete; `server-hello` has been sent.
    Done,
    /// Wrong protocol, a failed/forged MAC, or an out-of-order message. The
    /// caller drops the client. The secret is never put on the wire or logged.
    Fail,
}

/// Server side of the mutual HMAC-SHA256 challenge-response. The per-install
/// secret never crosses the wire. The server proves it knows the secret first —
/// so a client that lacks the secret only ever sees a nonce and a MAC it cannot
/// forge — and the client must then prove the same before any session info or
/// frame is sent. Fresh per-connection nonces and domain-separated labels
/// ("server" vs "client") stop a captured tag from being replayed in either
/// direction.
enum Handshake {
    /// Waiting for the client's opening `client-hello` (its nonce).
    AwaitingHello,
    /// `server-auth` sent; waiting for the client's `client-auth` reply.
    AwaitingAuth {
        client_nonce: Vec<u8>,
        server_nonce: Vec<u8>,
    },
    /// Mutually authenticated; `server-hello` sent. Keeps this connection's
    /// server nonce, which every control grant on it is bound to.
    Done { server_nonce: Vec<u8> },
}

impl Handshake {
    fn new() -> Self {
        Handshake::AwaitingHello
    }

    fn is_done(&self) -> bool {
        matches!(self, Handshake::Done { .. })
    }

    /// The connection's server nonce, once authenticated.
    fn connection_nonce(&self) -> Option<&[u8]> {
        match self {
            Handshake::Done { server_nonce } => Some(server_nonce),
            _ => None,
        }
    }

    /// Generic over the writer so the state machine is unit-tested against an
    /// in-memory fake client; production passes the pipe.
    fn advance<W: std::io::Write>(
        &mut self,
        io: &mut W,
        state: &InstallState,
        desktop: &str,
        message: Message,
    ) -> HandshakeStep {
        match self {
            Handshake::AwaitingHello => {
                let Message::ClientHello {
                    protocol: version,
                    client_nonce,
                } = message
                else {
                    log::event("helper", "handshake rejected: expected client-hello");
                    return HandshakeStep::Fail;
                };
                if version != PROTOCOL_VERSION {
                    let _ = protocol::write_all(
                        io,
                        &protocol::encode_control(&Message::error(
                            "protocol_mismatch",
                            format!("helper speaks protocol {PROTOCOL_VERSION}"),
                        )),
                    );
                    log::event("helper", "handshake rejected: protocol mismatch");
                    return HandshakeStep::Fail;
                }
                let Some(client_nonce) = decode_nonce(&client_nonce) else {
                    log::event("helper", "handshake rejected: malformed client nonce");
                    return HandshakeStep::Fail;
                };
                let server_nonce_b64 = generate_nonce();
                let Some(server_nonce) = decode_nonce(&server_nonce_b64) else {
                    log::event("helper", "handshake aborted: nonce generation failed");
                    return HandshakeStep::Fail;
                };
                // The server proves knowledge of the secret before the client
                // reveals anything, so a secret-less client learns nothing.
                let mac = server_auth_tag(&state.secret, &client_nonce, &server_nonce);
                let reply = Message::ServerAuth {
                    protocol: PROTOCOL_VERSION,
                    server_nonce: server_nonce_b64,
                    mac,
                };
                if protocol::write_all(io, &protocol::encode_control(&reply)).is_err() {
                    return HandshakeStep::Fail;
                }
                *self = Handshake::AwaitingAuth {
                    client_nonce,
                    server_nonce,
                };
                HandshakeStep::Continue
            }
            Handshake::AwaitingAuth {
                client_nonce,
                server_nonce,
            } => {
                let client_nonce = client_nonce.clone();
                let server_nonce = server_nonce.clone();
                let Message::ClientAuth { mac } = message else {
                    log::event("helper", "handshake rejected: expected client-auth");
                    return HandshakeStep::Fail;
                };
                let expected = client_auth_tag(&state.secret, &server_nonce, &client_nonce);
                if !secret_matches(&expected, &mac) {
                    let _ = protocol::write_all(
                        io,
                        &protocol::encode_control(&Message::error(
                            "unauthorized",
                            "authentication failed",
                        )),
                    );
                    log::event("helper", "handshake rejected: client authentication failed");
                    return HandshakeStep::Fail;
                }
                let session = session_id();
                let hello = Message::ServerHello {
                    protocol: PROTOCOL_VERSION,
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    session,
                    desktop: desktop.to_string(),
                    locked: crate::desktop::session_locked(session),
                };
                if protocol::write_all(io, &protocol::encode_control(&hello)).is_err() {
                    return HandshakeStep::Fail;
                }
                *self = Handshake::Done { server_nonce };
                log::event("helper", "client authenticated");
                HandshakeStep::Done
            }
            Handshake::Done { .. } => HandshakeStep::Done,
        }
    }
}

/// While remote control is inactive or has no live grant, the only input
/// applied is a **release of a button or key this connection pressed and still holds** — performed in
/// place: no pointer movement, and the event's coordinates are ignored. Any
/// other event, and a release of anything this connection does not hold, is
/// dropped. (A release can only end this connection's own press, so it cannot
/// move, click, or type on the — possibly secure — desktop.)
fn release_while_inactive<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    event: InputEvent,
) {
    match event {
        InputEvent::PointerButton {
            button,
            down: false,
            ..
        } => {
            injector.release_button(button);
        }
        InputEvent::Key {
            down: false,
            vk,
            scan,
            extended,
        } => {
            injector.release_key(vk, scan, extended);
        }
        _ => {}
    }
}

/// One authenticated connection's control state.
struct Control {
    /// `control { active }` as last sent: capture runs, and grants are
    /// solicited, only while true.
    active: bool,
    grants: GrantBook,
    /// The enrolled phone keys (one per paired phone); empty refuses every
    /// grant (`grant_key_missing`). A grant is accepted when any one of these
    /// verifies it. Refreshed from the committed install state before every
    /// post-handshake dispatch ([`dispatch_refreshed`]), so an enroll/revoke
    /// takes effect on the live connection without a reconnect.
    keys: Vec<[u8; CONTROLLER_KEY_BYTES]>,
    /// A grant was live at the last check, so its lapse is noticed once.
    granted: bool,
    /// The enrolled key that signed the live grant: each grant is bound to the
    /// key that signed it. `None` when no grant is live.
    granted_key: Option<[u8; CONTROLLER_KEY_BYTES]>,
    /// `grant_required` was reported since control was last authorized.
    refusal_reported: bool,
    /// The thread is attached to the current input desktop.
    desktop_available: bool,
    /// The install state could not be read/parsed, so the key set cannot be
    /// trusted: authorization is suspended (fail closed) until a good read.
    suspended: bool,
}

impl Control {
    fn new(connection_nonce: Vec<u8>, keys: Vec<[u8; CONTROLLER_KEY_BYTES]>) -> Self {
        Control {
            active: false,
            grants: GrantBook::new(connection_nonce),
            keys,
            granted: false,
            granted_key: None,
            refusal_reported: false,
            desktop_available: true,
            suspended: false,
        }
    }

    /// New input and `sas` may act at `now`: control is active, the desktop
    /// is attached, a grant is live, and authorization is not suspended.
    fn authorized(&self, now: Instant) -> bool {
        self.active && self.desktop_available && !self.suspended && self.grants.live(now)
    }
}

/// Checks a grant signature: `(enrolled key, payload, signature)`.
type Verify<'a> = &'a dyn Fn(&[u8; CONTROLLER_KEY_BYTES], &[u8], &[u8]) -> bool;

/// What the caller must do after a control message.
enum Effect {
    None,
    /// An authorized `sas`: ask the service for Ctrl+Alt+Del.
    Sas,
}

/// Apply one post-handshake control message at `now`. Replies (advisory
/// `error`s) are appended to `replies`. A grant that lapsed before `now` is
/// settled first ([`settle_lapse`]), so a renewal later in the same batch
/// can never hide the lapse. Deactivating, and declaring a new video run,
/// release held input and revoke the grant on the spot; input without a live
/// grant is dropped except for an in-place release of this connection's own
/// press; an injection that finds the input desktop gone suspends at once
/// ([`suspend_if_desktop_lost`]). A desktop loss still pending from anything
/// done since the last message (e.g. the releases of a `sas`) is settled
/// before this message is dispatched, like a lapse.
fn apply_control<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    message: Message,
    now: Instant,
    verify: Verify<'_>,
    replies: &mut Vec<Message>,
) -> Effect {
    settle_lapse(injector, control, now, replies);
    suspend_if_desktop_lost(injector, control, replies);
    let effect = dispatch_control(injector, control, message, now, verify, replies);
    suspend_if_desktop_lost(injector, control, replies);
    effect
}

/// Reads the committed install state: production reads the protected state
/// file; tests substitute an in-memory one they can change between dispatches.
type ReadState<'a> = &'a mut dyn FnMut() -> std::io::Result<Vec<u8>>;

/// Refresh the committed key set, then dispatch one post-handshake control
/// message. **Every** post-handshake message goes through here — each input,
/// `sas` and grant, one frame at a time, even within one read's batch — so a
/// revoke committed before this call returns ends the removed key's grant
/// before the message acts, and an unreadable state suspends it (fail closed).
/// There is no change signal to miss: the check is the read itself (bytes
/// compared with the last good load, parsed only when they differ).
#[allow(clippy::too_many_arguments)]
fn dispatch_refreshed<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    last: &mut Option<Vec<u8>>,
    read_state: ReadState<'_>,
    message: Message,
    now: Instant,
    verify: Verify<'_>,
    replies: &mut Vec<Message>,
) -> Effect {
    apply_refresh(injector, control, last, read_state(), replies);
    apply_control(injector, control, message, now, verify, replies)
}

fn dispatch_control<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    message: Message,
    now: Instant,
    verify: Verify<'_>,
    replies: &mut Vec<Message>,
) -> Effect {
    match message {
        Message::Control { active: on } => {
            if control.active && !on {
                injector.release_all();
                control.grants.revoke();
                control.granted = false;
                control.granted_key = None;
            }
            if on && !control.active {
                // Activation is what makes the first challenge due at once.
                control.grants.restart_cadence();
                if control.keys.is_empty() {
                    replies.push(Message::error(
                        "grant_key_missing",
                        "no phone key is enrolled; pair a phone or enroll its key",
                    ));
                }
            }
            control.active = on;
            control.refusal_reported = false;
            log::event(
                "helper",
                if on {
                    "remote control active"
                } else {
                    "remote control idle"
                },
            );
        }
        Message::VideoRun { epoch } => {
            // A new run ends the grant here, not at the next `tick`: what was
            // pressed under the old run is released and every open challenge
            // revoked before a later message of the same batch is dispatched,
            // so no grant can make control live again while that input is held.
            if control.grants.set_epoch(epoch) {
                injector.release_all();
                control.grants.revoke();
                control.granted_key = None;
                if std::mem::take(&mut control.granted) {
                    replies.push(Message::error(
                        "grant_expired",
                        "a new video run ended the control grant; held input released",
                    ));
                }
            }
        }
        Message::Grant {
            challenge,
            epoch,
            signature,
        } => {
            if control.suspended {
                replies.push(Message::error(
                    "grant_key_missing",
                    "control is suspended; the install state is unreadable",
                ));
            } else if control.keys.is_empty() {
                replies.push(Message::error(
                    "grant_key_missing",
                    "no phone key is enrolled",
                ));
            } else {
                // Try every enrolled key; the first that verifies accepts the
                // grant and is the key it is bound to. `accept` consumes the
                // challenge once, so the loop runs inside the single call.
                let keys = &control.keys;
                let mut signer: Option<[u8; CONTROLLER_KEY_BYTES]> = None;
                let verdict = control.grants.accept(
                    now,
                    &challenge,
                    epoch,
                    &signature,
                    |payload, signature| {
                        for key in keys {
                            if verify(key, payload, signature) {
                                signer = Some(*key);
                                return true;
                            }
                        }
                        false
                    },
                );
                match verdict {
                    Ok(()) => {
                        // Log a fresh grant, and a mid-session switch to a
                        // different paired phone's key.
                        if !control.granted || control.granted_key != signer {
                            log::event("helper", "control grant accepted");
                        }
                        control.granted = true;
                        control.granted_key = signer;
                        control.refusal_reported = false;
                    }
                    Err(refusal) => {
                        log::event(
                            "helper",
                            &format!("control grant refused: {}", refusal.code()),
                        );
                        replies.push(Message::error(refusal.code(), "control grant refused"));
                    }
                }
            }
        }
        Message::Input { event } => {
            if control.authorized(now) {
                inject_event(injector, event);
            } else {
                let release = matches!(
                    event,
                    InputEvent::PointerButton { down: false, .. }
                        | InputEvent::Key { down: false, .. }
                );
                release_while_inactive(injector, event);
                if control.active
                    && control.desktop_available
                    && !release
                    && !control.refusal_reported
                {
                    control.refusal_reported = true;
                    replies.push(Message::error(
                        "grant_required",
                        "input needs a live control grant",
                    ));
                }
            }
        }
        Message::Sas => {
            if !control.authorized(now) {
                replies.push(Message::error(
                    "grant_required",
                    "Ctrl+Alt+Del needs active control and a live grant",
                ));
            } else {
                // Requests made before the service handles one coalesce: the
                // SAS event is auto-reset, and setting a set event has no effect.
                return Effect::Sas;
            }
        }
        // A second hello, or a server-only message echoed back, is ignored.
        _ => {}
    }
    Effect::None
}

/// What a fresh read of the state file means for the live key set.
enum KeyRefresh {
    /// Byte-identical to the last successful load: nothing to do.
    Unchanged,
    /// A new, parseable state: its key set, and the bytes to remember.
    Loaded {
        keys: Vec<[u8; CONTROLLER_KEY_BYTES]>,
        bytes: Vec<u8>,
    },
    /// Unreadable or unparseable: fail closed (suspend authorization).
    Suspend,
}

/// Decide a key-set refresh from a fresh read of the state file and the bytes
/// last successfully loaded. Compares **content**, so a timestamp-preserving
/// replace is still seen; an `Err` read or an unparseable body suspends
/// authorization. Pure; unit-tested. `last` is advanced by the caller only on
/// [`KeyRefresh::Loaded`], never on a failure, so one bad read cannot suppress
/// the next retry.
fn decide_refresh(read: std::io::Result<Vec<u8>>, last: &Option<Vec<u8>>) -> KeyRefresh {
    let bytes = match read {
        Ok(bytes) => bytes,
        Err(_) => return KeyRefresh::Suspend,
    };
    if last.as_deref() == Some(bytes.as_slice()) {
        return KeyRefresh::Unchanged;
    }
    match std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| InstallState::from_json(text).ok())
    {
        Some(state) => KeyRefresh::Loaded {
            keys: state.controller_keys_bytes(),
            bytes,
        },
        None => KeyRefresh::Suspend,
    }
}

/// Apply a fresh read to the live connection: a changed set is installed
/// ([`apply_key_set`]), a failure suspends authorization. `last` advances only
/// on a successful load.
fn apply_refresh<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    last: &mut Option<Vec<u8>>,
    read: std::io::Result<Vec<u8>>,
    replies: &mut Vec<Message>,
) {
    match decide_refresh(read, last) {
        // Identical to the last good load: still valid, so an outage ends.
        KeyRefresh::Unchanged => {
            if control.suspended {
                control.suspended = false;
                log::event(
                    "helper",
                    "install state readable again; authorization resumed",
                );
            }
        }
        KeyRefresh::Loaded { keys, bytes } => {
            *last = Some(bytes);
            if control.suspended {
                control.suspended = false;
                log::event(
                    "helper",
                    "install state readable again; authorization resumed",
                );
            }
            apply_key_set(injector, control, keys, replies);
        }
        KeyRefresh::Suspend => suspend_authorization(injector, control, replies),
    }
}

/// Fail closed: the install state could not be read or parsed, so no set can be
/// trusted. Revoke any live grant, release everything held, and refuse new
/// grants and input/SAS ([`Control::authorized`] and the grant branch both
/// gate on `suspended`) until a good read resumes it. Acts once per outage.
fn suspend_authorization<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    replies: &mut Vec<Message>,
) {
    if control.suspended {
        return;
    }
    control.suspended = true;
    control.grants.revoke();
    control.granted = false;
    control.granted_key = None;
    injector.release_all();
    log::event(
        "helper",
        "install state unreadable; authorization suspended (held input released)",
    );
    replies.push(Message::error(
        "grant_key_missing",
        "the install state is unreadable; control is suspended until it recovers",
    ));
}

/// Install the current enrolled key set on a live connection. If the key that
/// signed the live grant is no longer enrolled (the phone was unpaired), the
/// grant is revoked and everything held released before any further input or
/// SAS — authority ends at once, without a reconnect or restart. A newly
/// enrolled key simply becomes verifiable for the next grant. Pure; unit-tested.
fn apply_key_set<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    keys: Vec<[u8; CONTROLLER_KEY_BYTES]>,
    replies: &mut Vec<Message>,
) {
    control.keys = keys;
    if let Some(signer) = control.granted_key {
        if !control.keys.contains(&signer) {
            control.grants.revoke();
            control.granted = false;
            control.granted_key = None;
            injector.release_all();
            replies.push(Message::error(
                "grant_key_missing",
                "the controlling phone's key was revoked; held input released",
            ));
        }
    }
}

/// A grant that was live and has expired by `now` releases everything held
/// and is reported once (`grant_expired`). Run before every message is
/// dispatched and on every loop pass.
fn settle_lapse<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    now: Instant,
    replies: &mut Vec<Message>,
) {
    if control.granted && !control.grants.live(now) {
        control.granted = false;
        control.granted_key = None;
        injector.release_all();
        replies.push(Message::error(
            "grant_expired",
            "the control grant lapsed; held input released",
        ));
    }
}

/// An injection found the input desktop gone (its re-attach failed): capture
/// and new input stop at once (`desktop_available = false`), everything held
/// is released, and the client is told `desktop_unavailable` — once per
/// outage. Recovery is the serve loop's frame-paced attach path, whose next
/// success ends the outage with a `desktop-changed`.
fn suspend_if_desktop_lost<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    replies: &mut Vec<Message>,
) {
    let Some(reason) = injector.take_desktop_lost() else {
        return;
    };
    if !control.desktop_available {
        return;
    }
    control.desktop_available = false;
    injector.release_all();
    // The releases met the same missing desktop; that is this outage too.
    let _ = injector.take_desktop_lost();
    log::event(
        "helper",
        &format!("input desktop lost while injecting: {reason}; suspended"),
    );
    replies.push(Message::error("desktop_unavailable", reason));
}

/// Per-loop grant upkeep at `now`: a lapse is settled ([`settle_lapse`]);
/// while control is active a fresh challenge is issued on the refresh
/// cadence; a failed injection is reported (`input_failed`, once per failure
/// streak — see [`inject::Injector::take_failure`]); and a desktop lost by a
/// release on this pass suspends ([`suspend_if_desktop_lost`]).
fn tick<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    now: Instant,
    replies: &mut Vec<Message>,
) {
    settle_lapse(injector, control, now, replies);
    suspend_if_desktop_lost(injector, control, replies);
    if control.active
        && !control.suspended
        && !control.keys.is_empty()
        && control.grants.needs_challenge(now)
    {
        let challenge = generate_challenge();
        replies.push(Message::GrantChallenge {
            nonce: encode_nonce(control.grants.connection_nonce()),
            challenge: encode_nonce(&challenge),
        });
        control.grants.issue(now, challenge);
    }
    if injector.take_failure() {
        replies.push(Message::error(
            "input_failed",
            "SendInput inserted no events after a desktop resync",
        ));
    }
}

/// Ask the service for Ctrl+Alt+Del, unless an administrator's policy
/// excludes services — then the client is told `sas_disabled_by_policy` and
/// nothing is changed. Everything this connection holds (the Ctrl and Alt of
/// the combo) is released first so no modifier rides into the SAS screen. If
/// those releases find the input desktop gone, the outage is settled on the
/// spot ([`suspend_if_desktop_lost`]: suspended, `desktop_unavailable`) and no
/// SAS is raised — nothing acts while the desktop is unavailable — so the
/// next message of the same batch is already refused. The service re-reads
/// the policy before it acts; `policy` (the registry read) only lets the
/// client learn the outcome. `raise` sets the SAS-request event.
fn request_sas<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    control: &mut Control,
    policy: impl FnOnce() -> Result<Option<u32>, String>,
    raise: impl FnOnce(),
    replies: &mut Vec<Message>,
) {
    if let Ok(SasPolicy::DisabledByPolicy) = policy().map(sas_policy) {
        replies.push(Message::error(
            "sas_disabled_by_policy",
            "the SoftwareSASGeneration policy does not allow services to send Ctrl+Alt+Del",
        ));
        return;
    }
    injector.release_all();
    suspend_if_desktop_lost(injector, control, replies);
    if !control.desktop_available {
        return;
    }
    raise();
    log::event("helper", "Ctrl+Alt+Del requested");
}

fn inject_event<S: inject::InputSink>(injector: &mut inject::Injector<S>, event: InputEvent) {
    match event {
        InputEvent::PointerMove { x, y } => injector.pointer_move(x, y),
        InputEvent::PointerButton { button, down, x, y } => {
            injector.pointer_button(button, down, x, y)
        }
        InputEvent::PointerWheel { x, y, dx, dy } => injector.pointer_wheel(x, y, dx, dy),
        InputEvent::Key {
            down,
            vk,
            scan,
            extended,
        } => injector.key(down, vk, scan, extended),
        InputEvent::Text { text } => injector.text(&text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::generate_secret;

    fn state() -> InstallState {
        InstallState::new("0.1.0", "S-1-5-21-1-2-3-1001", r"\\.\pipe\test", 0)
    }

    /// Decode every control frame the fake client received from the helper.
    fn replies(wire: &[u8]) -> Vec<Message> {
        let mut cursor = std::io::Cursor::new(wire);
        let mut out = Vec::new();
        while (cursor.position() as usize) < wire.len() {
            match protocol::read_frame(&mut cursor).unwrap() {
                Decoded::Control(message) => out.push(message),
                other => panic!("unexpected frame {other:?}"),
            }
        }
        out
    }

    /// Run the opening exchange and return the helper's server nonce + MAC.
    fn open(handshake: &mut Handshake, st: &InstallState, client_nonce: &str) -> (String, String) {
        let mut wire = Vec::new();
        let step = handshake.advance(
            &mut wire,
            st,
            "Default",
            Message::ClientHello {
                protocol: PROTOCOL_VERSION,
                client_nonce: client_nonce.into(),
            },
        );
        assert!(matches!(step, HandshakeStep::Continue));
        match replies(&wire).pop() {
            Some(Message::ServerAuth {
                server_nonce, mac, ..
            }) => (server_nonce, mac),
            other => panic!("expected server-auth, got {other:?}"),
        }
    }

    #[test]
    fn honest_client_authenticates_and_never_sees_the_secret() {
        let st = state();
        let mut hs = Handshake::new();
        let client_nonce_b64 = generate_nonce();
        let client_nonce = decode_nonce(&client_nonce_b64).unwrap();
        let (server_nonce_b64, server_mac) = open(&mut hs, &st, &client_nonce_b64);
        let server_nonce = decode_nonce(&server_nonce_b64).unwrap();
        // The server proved knowledge of the secret first.
        assert!(secret_matches(
            &server_auth_tag(&st.secret, &client_nonce, &server_nonce),
            &server_mac
        ));
        let mut wire = Vec::new();
        let step = hs.advance(
            &mut wire,
            &st,
            "Default",
            Message::ClientAuth {
                mac: client_auth_tag(&st.secret, &server_nonce, &client_nonce),
            },
        );
        assert!(matches!(step, HandshakeStep::Done));
        assert!(hs.is_done());
        assert!(matches!(
            replies(&wire).pop(),
            Some(Message::ServerHello { .. })
        ));
        // Nothing the helper wrote contains the secret.
        let all = format!(
            "{server_nonce_b64}{server_mac}{}",
            String::from_utf8_lossy(&wire)
        );
        assert!(!all.contains(&st.secret));
    }

    #[test]
    fn fake_client_without_the_secret_is_rejected() {
        let st = state();
        let mut hs = Handshake::new();
        let client_nonce_b64 = generate_nonce();
        let client_nonce = decode_nonce(&client_nonce_b64).unwrap();
        let (server_nonce_b64, _) = open(&mut hs, &st, &client_nonce_b64);
        let server_nonce = decode_nonce(&server_nonce_b64).unwrap();
        let guess = generate_secret();
        let mut wire = Vec::new();
        let step = hs.advance(
            &mut wire,
            &st,
            "Default",
            Message::ClientAuth {
                mac: client_auth_tag(&guess, &server_nonce, &client_nonce),
            },
        );
        assert!(matches!(step, HandshakeStep::Fail));
        assert!(!hs.is_done());
        assert!(!replies(&wire)
            .iter()
            .any(|m| matches!(m, Message::ServerHello { .. })));
    }

    #[test]
    fn a_replayed_client_mac_fails_on_a_new_connection() {
        let st = state();
        // Record a legitimate exchange.
        let mut first = Handshake::new();
        let client_nonce_b64 = generate_nonce();
        let client_nonce = decode_nonce(&client_nonce_b64).unwrap();
        let (sn1, _) = open(&mut first, &st, &client_nonce_b64);
        let recorded = client_auth_tag(&st.secret, &decode_nonce(&sn1).unwrap(), &client_nonce);

        // Replay the same client-hello and the recorded MAC on a new connection:
        // the helper picks a fresh server nonce, so the old MAC no longer verifies.
        let mut second = Handshake::new();
        let (sn2, _) = open(&mut second, &st, &client_nonce_b64);
        assert_ne!(sn1, sn2, "every connection gets a fresh server nonce");
        let mut wire = Vec::new();
        let step = second.advance(
            &mut wire,
            &st,
            "Default",
            Message::ClientAuth { mac: recorded },
        );
        assert!(matches!(step, HandshakeStep::Fail));

        // Reflecting the server's own MAC back as the client's proof also fails.
        let mut third = Handshake::new();
        let (_, server_mac) = open(&mut third, &st, &client_nonce_b64);
        let step = third.advance(
            &mut Vec::new(),
            &st,
            "Default",
            Message::ClientAuth { mac: server_mac },
        );
        assert!(matches!(step, HandshakeStep::Fail));
    }

    use std::cell::RefCell;
    use std::rc::Rc;
    use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, MOUSEEVENTF_LEFTUP};

    /// Records synthesized input instead of calling `SendInput`.
    #[derive(Clone, Default)]
    struct Recorder(Rc<RefCell<Vec<INPUT>>>);

    impl inject::InputSink for Recorder {
        fn send(&mut self, inputs: &[INPUT]) -> usize {
            self.0.borrow_mut().extend_from_slice(inputs);
            inputs.len()
        }

        fn resync(&mut self) -> Result<(), String> {
            Ok(())
        }
    }

    /// Records what it inserts; while `blocked` it inserts nothing, and a
    /// resync then attaches unless `desktop_gone`.
    #[derive(Clone, Default)]
    struct Gate {
        blocked: Rc<RefCell<bool>>,
        desktop_gone: Rc<RefCell<bool>>,
        inserted: Rc<RefCell<Vec<INPUT>>>,
        sends: Rc<RefCell<usize>>,
    }

    impl inject::InputSink for Gate {
        fn send(&mut self, inputs: &[INPUT]) -> usize {
            *self.sends.borrow_mut() += 1;
            if *self.blocked.borrow() {
                return 0;
            }
            self.inserted.borrow_mut().extend_from_slice(inputs);
            inputs.len()
        }

        fn resync(&mut self) -> Result<(), String> {
            if *self.desktop_gone.borrow() {
                Err("no input desktop".into())
            } else {
                Ok(())
            }
        }
    }

    /// Whether `input` is a key-up.
    fn is_key_up(input: &INPUT) -> bool {
        use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT_KEYBOARD, KEYEVENTF_KEYUP};
        input.r#type == INPUT_KEYBOARD
            && unsafe { input.Anonymous.ki.dwFlags }.contains(KEYEVENTF_KEYUP)
    }

    /// Feed one message to a [`Gate`]-backed injector.
    fn feed_gate(
        injector: &mut inject::Injector<Gate>,
        control: &mut Control,
        message: Message,
        now: Instant,
    ) -> Vec<Message> {
        let mut replies = Vec::new();
        apply_control(injector, control, message, now, &fake_verify, &mut replies);
        replies
    }

    /// The challenge of the single `grant-challenge` among `replies`.
    fn issued_challenge(replies: &[Message]) -> String {
        let issued: Vec<_> = replies
            .iter()
            .filter_map(|reply| match reply {
                Message::GrantChallenge { challenge, .. } => Some(challenge.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(issued.len(), 1, "{replies:?}");
        issued[0].clone()
    }

    fn input(event: InputEvent) -> Message {
        Message::Input { event }
    }

    const KEY: [u8; CONTROLLER_KEY_BYTES] = [4; CONTROLLER_KEY_BYTES];
    const GOOD_SIGNATURE: [u8; crate::security::GRANT_SIGNATURE_BYTES] =
        [1; crate::security::GRANT_SIGNATURE_BYTES];
    /// A second paired phone's key, and the signature only it produces.
    const KEY2: [u8; CONTROLLER_KEY_BYTES] = {
        let mut key = [4u8; CONTROLLER_KEY_BYTES];
        key[1] = 9;
        key
    };
    const GOOD_SIGNATURE2: [u8; crate::security::GRANT_SIGNATURE_BYTES] =
        [2; crate::security::GRANT_SIGNATURE_BYTES];

    /// Accepts `GOOD_SIGNATURE` under `KEY` or `GOOD_SIGNATURE2` under `KEY2`,
    /// so a grant is bound to whichever enrolled key signed it.
    fn fake_verify(key: &[u8; CONTROLLER_KEY_BYTES], _payload: &[u8], signature: &[u8]) -> bool {
        (key == &KEY && signature == GOOD_SIGNATURE)
            || (key == &KEY2 && signature == GOOD_SIGNATURE2)
    }

    /// Feed one message with the fake verifier; returns the effect and replies.
    fn feed(
        injector: &mut inject::Injector<Recorder>,
        control: &mut Control,
        message: Message,
        now: Instant,
    ) -> (Effect, Vec<Message>) {
        let mut replies = Vec::new();
        let effect = apply_control(injector, control, message, now, &fake_verify, &mut replies);
        (effect, replies)
    }

    fn codes(replies: &[Message]) -> Vec<String> {
        replies
            .iter()
            .filter_map(|m| match m {
                Message::Error { code, .. } => Some(code.clone()),
                _ => None,
            })
            .collect()
    }

    /// Active control on video run 1, with a challenge issued at `now`.
    fn active_control(now: Instant) -> (Control, String) {
        active_control_keys(now, vec![KEY])
    }

    /// Like [`active_control`] but with an explicit enrolled key set.
    fn active_control_keys(
        now: Instant,
        keys: Vec<[u8; CONTROLLER_KEY_BYTES]>,
    ) -> (Control, String) {
        let mut control = Control::new(vec![0x33; 16], keys);
        control.active = true;
        control.grants.set_epoch(1);
        let mut replies = Vec::new();
        tick(
            &mut inject::Injector::with_sink(Recorder::default()),
            &mut control,
            now,
            &mut replies,
        );
        let challenge = match replies.as_slice() {
            [Message::GrantChallenge { challenge, nonce }] => {
                assert_eq!(
                    nonce,
                    &encode_nonce(&[0x33; 16]),
                    "the challenge names the connection nonce"
                );
                challenge.clone()
            }
            other => panic!("expected one grant-challenge, got {other:?}"),
        };
        (control, challenge)
    }

    fn grant(challenge: &str, epoch: u64, signature: &[u8]) -> Message {
        Message::Grant {
            challenge: challenge.into(),
            epoch,
            signature: encode_nonce(signature),
        }
    }

    #[test]
    fn active_control_without_a_grant_injects_nothing_and_says_so_once() {
        let t0 = Instant::now();
        let sink = Recorder::default();
        let mut injector = inject::Injector::with_sink(sink.clone());
        let (mut control, _) = active_control(t0);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            input(InputEvent::PointerMove { x: 1, y: 1 }),
            t0,
        );
        assert_eq!(codes(&replies), ["grant_required"]);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            input(InputEvent::Text { text: "y".into() }),
            t0,
        );
        assert!(replies.is_empty(), "reported once per lapse");
        let (effect, replies) = feed(&mut injector, &mut control, Message::Sas, t0);
        assert!(matches!(effect, Effect::None));
        assert_eq!(codes(&replies), ["grant_required"]);
        assert!(sink.0.borrow().is_empty());
    }

    #[test]
    fn a_valid_grant_authorizes_input_and_sas_until_it_lapses() {
        let t0 = Instant::now();
        let sink = Recorder::default();
        let mut injector = inject::Injector::with_sink(sink.clone());
        let (mut control, challenge) = active_control(t0);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        assert!(replies.is_empty(), "{replies:?}");
        feed(
            &mut injector,
            &mut control,
            input(InputEvent::Key {
                down: true,
                vk: 0x11,
                scan: 0x1d,
                extended: false,
            }),
            t0,
        );
        assert_eq!(sink.0.borrow().len(), 1, "the key went in");
        let (effect, _) = feed(&mut injector, &mut control, Message::Sas, t0);
        assert!(matches!(effect, Effect::Sas));
        let (effect, _) = feed(&mut injector, &mut control, Message::Sas, t0);
        assert!(
            matches!(effect, Effect::Sas),
            "repeats coalesce in the auto-reset SAS event, not here"
        );

        // The grant lapses: held input is released and the lapse reported.
        sink.0.borrow_mut().clear();
        let lapse = t0 + crate::security::GRANT_LIFETIME;
        let mut replies = Vec::new();
        tick(&mut injector, &mut control, lapse, &mut replies);
        assert!(codes(&replies).contains(&"grant_expired".to_string()));
        assert_eq!(sink.0.borrow().len(), 1, "the held Ctrl was released");
        sink.0.borrow_mut().clear();
        feed(
            &mut injector,
            &mut control,
            input(InputEvent::PointerMove { x: 1, y: 1 }),
            lapse,
        );
        assert!(sink.0.borrow().is_empty());
    }

    #[test]
    fn challenges_keep_their_cadence_through_grants_and_restart_on_activation() {
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        let (mut control, challenge) = active_control(t0);
        let challenges_at =
            |control: &mut Control, injector: &mut inject::Injector<Recorder>, at| {
                let mut replies = Vec::new();
                tick(injector, control, at, &mut replies);
                replies
                    .iter()
                    .filter(|reply| matches!(reply, Message::GrantChallenge { .. }))
                    .count()
            };
        let answered = t0 + Duration::from_millis(150);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            answered,
        );
        assert!(replies.is_empty(), "{replies:?}");
        assert_eq!(
            challenges_at(&mut control, &mut injector, answered),
            0,
            "a grant does not prompt a new challenge"
        );
        let refresh = t0 + crate::security::GRANT_REFRESH;
        assert_eq!(
            challenges_at(
                &mut control,
                &mut injector,
                refresh - Duration::from_millis(1)
            ),
            0
        );
        assert_eq!(
            challenges_at(&mut control, &mut injector, refresh),
            1,
            "due one refresh after the last"
        );

        // A new video run (the UAC prompt appearing) makes the next one due at once.
        let switched = refresh + Duration::from_millis(50);
        assert_eq!(
            challenges_at(&mut control, &mut injector, switched),
            0,
            "mid-cadence"
        );
        feed(
            &mut injector,
            &mut control,
            Message::VideoRun { epoch: 2 },
            switched,
        );
        assert_eq!(
            challenges_at(&mut control, &mut injector, switched),
            1,
            "no wait for the next refresh"
        );

        // Deactivating and reactivating control makes the next one due at once.
        let later = refresh + Duration::from_millis(100);
        feed(
            &mut injector,
            &mut control,
            Message::Control { active: false },
            later,
        );
        feed(
            &mut injector,
            &mut control,
            Message::Control { active: true },
            later,
        );
        assert_eq!(challenges_at(&mut control, &mut injector, later), 1);
    }

    #[test]
    fn forged_stale_or_foreign_run_grants_are_refused() {
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        let (mut control, challenge) = active_control(t0);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &[2; 64]),
            t0,
        );
        assert_eq!(codes(&replies), ["grant_bad_signature"]);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        assert_eq!(codes(&replies), ["grant_unknown_challenge"], "one shot");

        let (mut control, challenge) = active_control(t0);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 2, &GOOD_SIGNATURE),
            t0,
        );
        assert_eq!(codes(&replies), ["grant_wrong_video_run"]);

        // A grant for the current run goes live; declaring a new run ends it.
        let (mut control, challenge) = active_control(t0);
        feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        assert!(control.authorized(t0));
        feed(
            &mut injector,
            &mut control,
            Message::VideoRun { epoch: 2 },
            t0,
        );
        assert!(!control.authorized(t0));

        // Deactivating revokes the grant and every open challenge.
        let (mut control, challenge) = active_control(t0);
        feed(
            &mut injector,
            &mut control,
            Message::Control { active: false },
            t0,
        );
        feed(
            &mut injector,
            &mut control,
            Message::Control { active: true },
            t0,
        );
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        assert_eq!(codes(&replies), ["grant_unknown_challenge"]);
    }

    #[test]
    fn without_an_enrolled_key_control_is_never_granted() {
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        let mut control = Control::new(vec![0x33; 16], Vec::new());
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            Message::Control { active: true },
            t0,
        );
        assert_eq!(codes(&replies), ["grant_key_missing"]);
        let mut replies = Vec::new();
        tick(&mut injector, &mut control, t0, &mut replies);
        assert!(
            replies.is_empty(),
            "no challenge is solicited without a key"
        );
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant("AAAAAAAAAAAAAAAAAAAAAA==", 1, &GOOD_SIGNATURE),
            t0,
        );
        assert_eq!(codes(&replies), ["grant_key_missing"]);
    }

    #[test]
    fn a_grant_verifies_against_any_enrolled_key_and_binds_to_the_signer() {
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        // Two phones enrolled; the grant is signed only by the second one.
        let (mut control, challenge) = active_control_keys(t0, vec![KEY, KEY2]);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE2),
            t0,
        );
        assert!(
            codes(&replies).is_empty(),
            "the second enrolled key's grant is accepted"
        );
        assert!(control.authorized(t0), "control is live under that grant");
        assert_eq!(
            control.granted_key,
            Some(KEY2),
            "the live grant is bound to the key that signed it"
        );
    }

    #[test]
    fn a_committed_revoke_ends_control_on_a_live_connection_without_a_restart() {
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        // KEY is enrolled and holds a live grant.
        let (mut control, challenge) = active_control_keys(t0, vec![KEY]);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        assert!(codes(&replies).is_empty());
        assert!(control.authorized(t0), "control is live under KEY");
        // The phone is unpaired: the committed set no longer has KEY. Without
        // the refresh the snapshot would keep KEY and control would survive.
        let mut after = Vec::new();
        apply_key_set(&mut injector, &mut control, Vec::new(), &mut after);
        assert!(!control.authorized(t0), "control ends at once");
        assert_eq!(control.granted_key, None);
        assert!(codes(&after).iter().any(|code| code == "grant_key_missing"));
        // A further input is refused — no live grant.
        let (_, refused) = feed(
            &mut injector,
            &mut control,
            input(InputEvent::Key {
                down: true,
                vk: 0x41,
                scan: 0,
                extended: false,
            }),
            t0,
        );
        assert!(codes(&refused).iter().any(|code| code == "grant_required"));
    }

    /// Serialize an install state whose enrolled keys are `fills` (each a
    /// 65-byte uncompressed point filled with that byte), for the delivery tests.
    fn state_bytes_with(fills: &[u8]) -> Vec<u8> {
        use base64::Engine as _;
        let mut state = state();
        // A fixed secret, so equal key sets serialize to equal bytes.
        state.secret =
            base64::engine::general_purpose::STANDARD.encode([5u8; crate::security::SECRET_BYTES]);
        for &fill in fills {
            let mut point = [4u8; CONTROLLER_KEY_BYTES];
            point[1] = fill;
            state
                .enroll_key(&base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(point))
                .unwrap();
        }
        state.to_json().into_bytes()
    }

    #[test]
    fn decide_refresh_fails_closed_on_unparseable_state() {
        assert!(matches!(
            decide_refresh(Ok(b"{\"schema\":".to_vec()), &None),
            KeyRefresh::Suspend
        ));
        assert!(matches!(
            decide_refresh(Ok(vec![0xff, 0xfe]), &None),
            KeyRefresh::Suspend
        ));
        let good = state_bytes_with(&[4]);
        assert!(matches!(
            decide_refresh(Err(std::io::Error::other("locked")), &Some(good)),
            KeyRefresh::Suspend
        ));
    }

    #[test]
    fn a_content_change_is_delivered_even_when_the_timestamp_is_unchanged() {
        // decide_refresh compares bytes, not mtime: a timestamp-preserving
        // replace that revokes a key is still seen. (The byte in KEY2 is 9.)
        let with_both = state_bytes_with(&[4, 9]);
        let only_first = state_bytes_with(&[4]);
        // First load from no prior state.
        let KeyRefresh::Loaded { keys, bytes } = decide_refresh(Ok(with_both.clone()), &None)
        else {
            panic!("first read should load");
        };
        assert_eq!(keys.len(), 2);
        // A different content (same mtime, in reality) is loaded, not skipped.
        assert!(matches!(
            decide_refresh(Ok(only_first.clone()), &Some(bytes.clone())),
            KeyRefresh::Loaded { .. }
        ));
        // Identical bytes are Unchanged (no reparse).
        assert!(matches!(
            decide_refresh(Ok(with_both.clone()), &Some(with_both)),
            KeyRefresh::Unchanged
        ));
        // Now prove delivery revokes a live grant: enroll KEY2, grant under it,
        // then deliver a state that drops KEY2.
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        let (mut control, challenge) = active_control_keys(t0, vec![KEY, KEY2]);
        let (_, ok) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE2),
            t0,
        );
        assert!(codes(&ok).is_empty() && control.authorized(t0));
        let mut last = Some(with_both_key2());
        let mut replies = Vec::new();
        apply_refresh(
            &mut injector,
            &mut control,
            &mut last,
            Ok(state_bytes_with(&[4])),
            &mut replies,
        );
        assert!(
            !control.authorized(t0),
            "KEY2 revoked → its live grant ends"
        );
        assert!(codes(&replies).iter().any(|c| c == "grant_key_missing"));
    }

    /// The `with_both` bytes KEY+KEY2 as the "last loaded" for the delivery test.
    fn with_both_key2() -> Vec<u8> {
        state_bytes_with(&[4, 9])
    }

    #[test]
    fn an_unreadable_state_suspends_then_a_good_read_resumes() {
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        let (mut control, challenge) = active_control_keys(t0, vec![KEY]);
        let (_, ok) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        assert!(codes(&ok).is_empty() && control.authorized(t0));
        let mut last = Some(state_bytes_with(&[4]));
        // A read error (fail closed): the live grant ends, input is refused,
        // and `last` is not advanced so the next retry still runs.
        let mut replies = Vec::new();
        apply_refresh(
            &mut injector,
            &mut control,
            &mut last,
            Err(std::io::Error::other("boom")),
            &mut replies,
        );
        assert!(control.suspended && !control.authorized(t0));
        assert!(codes(&replies).iter().any(|c| c == "grant_key_missing"));
        let (_, refused) = feed(
            &mut injector,
            &mut control,
            input(InputEvent::Key {
                down: true,
                vk: 0x41,
                scan: 0,
                extended: false,
            }),
            t0,
        );
        assert!(codes(&refused).iter().any(|c| c == "grant_required"));
        assert_eq!(
            last,
            Some(state_bytes_with(&[4])),
            "a failed read never advances the seen bytes"
        );
        // A good read resumes authorization; a fresh grant is then accepted.
        apply_refresh(
            &mut injector,
            &mut control,
            &mut last,
            Ok(state_bytes_with(&[4])),
            &mut Vec::new(),
        );
        assert!(!control.suspended, "resumed");
        let t1 = t0 + crate::security::GRANT_REFRESH;
        let mut issued = Vec::new();
        tick(&mut injector, &mut control, t1, &mut issued);
        let challenge2 = issued_challenge(&issued);
        let (_, accepted) = feed(
            &mut injector,
            &mut control,
            grant(&challenge2, 1, &GOOD_SIGNATURE),
            t1,
        );
        assert!(
            codes(&accepted).is_empty() && control.authorized(t1),
            "control works again"
        );
    }

    /// Two control frames that arrive in **one read**: encoded into one buffer,
    /// fed to the real accumulator with a single `extend`, and drained one frame
    /// at a time through [`dispatch_refreshed`] — as `serve_client` does. The
    /// injected hook `commit` replaces the committed state *between* the first
    /// and the second dispatch (a revoke whose command returns mid-batch).
    /// Returns each dispatch's effect and replies.
    fn batch_with_commit_between(
        injector: &mut inject::Injector<Recorder>,
        control: &mut Control,
        last: &mut Option<Vec<u8>>,
        disk: &RefCell<Vec<u8>>,
        frames: [Message; 2],
        commit: Vec<u8>,
        now: Instant,
    ) -> Vec<(Effect, Vec<Message>)> {
        let mut wire = Vec::new();
        for frame in &frames {
            wire.extend(protocol::encode_control(frame));
        }
        let mut acc = protocol::FrameAccumulator::new();
        acc.extend(&wire, now);
        let mut read = || -> std::io::Result<Vec<u8>> { Ok(disk.borrow().clone()) };
        let mut commit = Some(commit);
        let mut out = Vec::new();
        while let Some(decoded) = acc.next_frame(now, FRAME_DEADLINE).unwrap() {
            let Decoded::Control(message) = decoded else {
                panic!("expected a control frame")
            };
            let mut replies = Vec::new();
            let effect = dispatch_refreshed(
                injector,
                control,
                last,
                &mut read,
                message,
                now,
                &fake_verify,
                &mut replies,
            );
            out.push((effect, replies));
            if let Some(bytes) = commit.take() {
                *disk.borrow_mut() = bytes;
            }
        }
        assert_eq!(out.len(), 2, "both frames came from the one read");
        out
    }

    /// Active control holding a live grant signed by KEY, with KEY and KEY2
    /// committed on the in-memory "disk" and already loaded.
    fn granted_by_key(
        t0: Instant,
        sink: Recorder,
    ) -> (
        inject::Injector<Recorder>,
        Control,
        Option<Vec<u8>>,
        RefCell<Vec<u8>>,
    ) {
        let mut injector = inject::Injector::with_sink(sink);
        let (mut control, challenge) = active_control_keys(t0, vec![KEY, KEY2]);
        let disk = RefCell::new(state_bytes_with(&[4, 9]));
        let mut last = None;
        let mut read = || -> std::io::Result<Vec<u8>> { Ok(disk.borrow().clone()) };
        let mut replies = Vec::new();
        dispatch_refreshed(
            &mut injector,
            &mut control,
            &mut last,
            &mut read,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
            &fake_verify,
            &mut replies,
        );
        assert!(
            codes(&replies).is_empty() && control.authorized(t0),
            "{replies:?}"
        );
        assert_eq!(control.granted_key, Some(KEY));
        (injector, control, last, disk)
    }

    #[test]
    fn a_revoke_committed_mid_batch_refuses_the_next_input_in_the_same_read() {
        let t0 = Instant::now();
        let sink = Recorder::default();
        let (mut injector, mut control, mut last, disk) = granted_by_key(t0, sink.clone());
        let press = |vk| {
            input(InputEvent::Key {
                down: true,
                vk,
                scan: 0,
                extended: false,
            })
        };
        // KEY is revoked (KEY2 stays) between the two frames' dispatches.
        let out = batch_with_commit_between(
            &mut injector,
            &mut control,
            &mut last,
            &disk,
            [press(0x41), press(0x42)],
            state_bytes_with(&[9]),
            t0,
        );
        assert!(
            codes(&out[0].1).is_empty(),
            "the first frame ran under the live grant"
        );
        // The second frame: the revoke is seen before it acts → refused.
        assert!(
            codes(&out[1].1)
                .iter()
                .any(|code| code == "grant_key_missing"),
            "{:?}",
            out[1].1
        );
        assert!(
            codes(&out[1].1).iter().any(|code| code == "grant_required"),
            "{:?}",
            out[1].1
        );
        assert!(!control.authorized(t0) && control.granted_key.is_none());
        // Over the whole batch: exactly one press reached the desktop (the
        // first frame's), followed only by its release when the grant ended;
        // the second press never did.
        let sent = sink.0.borrow().clone();
        let presses = sent.iter().filter(|event| !is_key_up(event)).count();
        assert_eq!(
            presses,
            1,
            "only the first frame's press was injected: {}",
            sent.len()
        );
        assert!(!is_key_up(&sent[0]), "the first press came first");
        assert!(
            sent.len() > 1 && sent[1..].iter().all(is_key_up),
            "then only its release"
        );
    }

    #[test]
    fn a_revoke_committed_mid_batch_refuses_the_next_sas_in_the_same_read() {
        let t0 = Instant::now();
        let (mut injector, mut control, mut last, disk) = granted_by_key(t0, Recorder::default());
        let out = batch_with_commit_between(
            &mut injector,
            &mut control,
            &mut last,
            &disk,
            [Message::Sas, Message::Sas],
            state_bytes_with(&[9]),
            t0,
        );
        assert!(
            matches!(out[0].0, Effect::Sas),
            "the first SAS ran under the live grant"
        );
        assert!(
            matches!(out[1].0, Effect::None),
            "the second SAS is refused"
        );
        assert!(
            codes(&out[1].1).iter().any(|code| code == "grant_required"),
            "{:?}",
            out[1].1
        );
    }

    #[test]
    fn a_state_unreadable_mid_batch_refuses_the_next_frame() {
        // The read itself is the check: a failure there (no signal to miss)
        // fails closed for the very next frame.
        let t0 = Instant::now();
        let (mut injector, mut control, mut last, disk) = granted_by_key(t0, Recorder::default());
        let out = batch_with_commit_between(
            &mut injector,
            &mut control,
            &mut last,
            &disk,
            [Message::Sas, Message::Sas],
            b"{".to_vec(),
            t0,
        );
        assert!(matches!(out[0].0, Effect::Sas));
        assert!(matches!(out[1].0, Effect::None) && control.suspended);
    }

    #[test]
    fn a_committed_enroll_is_accepted_on_a_live_connection_without_a_restart() {
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        // Only KEY is enrolled: a grant signed by KEY2 is refused.
        let (mut control, challenge) = active_control_keys(t0, vec![KEY]);
        let (_, refused) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE2),
            t0,
        );
        assert!(!codes(&refused).is_empty() && !control.authorized(t0));
        // Phone B is enrolled: the committed set now includes KEY2 — no reconnect.
        apply_key_set(
            &mut injector,
            &mut control,
            vec![KEY, KEY2],
            &mut Vec::new(),
        );
        // A fresh challenge, then B's grant is accepted.
        let t1 = t0 + crate::security::GRANT_REFRESH;
        let mut issued = Vec::new();
        tick(&mut injector, &mut control, t1, &mut issued);
        let challenge2 = issued_challenge(&issued);
        let (_, accepted) = feed(
            &mut injector,
            &mut control,
            grant(&challenge2, 1, &GOOD_SIGNATURE2),
            t1,
        );
        assert!(
            codes(&accepted).is_empty() && control.authorized(t1),
            "B now controls without a restart"
        );
    }

    #[test]
    fn a_grant_no_enrolled_key_signed_is_refused() {
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        // Only the first key is enrolled; a signature only the second produces.
        let (mut control, challenge) = active_control_keys(t0, vec![KEY]);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE2),
            t0,
        );
        assert_eq!(codes(&replies), ["grant_bad_signature"]);
        assert!(control.granted_key.is_none());
    }

    #[test]
    fn a_failed_injection_is_reported_once_per_blocked_period() {
        let t0 = Instant::now();
        let gate = Gate::default();
        let blocked = gate.blocked.clone();
        *blocked.borrow_mut() = true;
        let mut injector = inject::Injector::with_sink(gate);
        let mut control = Control::new(vec![0x33; 16], vec![KEY]);
        let mut replies = Vec::new();
        injector.pointer_move(1, 1);
        tick(&mut injector, &mut control, t0, &mut replies);
        injector.pointer_move(1, 1);
        tick(&mut injector, &mut control, t0, &mut replies);
        assert_eq!(
            codes(&replies),
            ["input_failed"],
            "one report for the blocked period"
        );
        *blocked.borrow_mut() = false;
        injector.pointer_move(1, 1);
        *blocked.borrow_mut() = true;
        injector.pointer_move(1, 1);
        tick(&mut injector, &mut control, t0, &mut replies);
        assert_eq!(
            codes(&replies),
            ["input_failed", "input_failed"],
            "a new blocked period is reported again"
        );
    }

    fn ctrl_down() -> Message {
        input(InputEvent::Key {
            down: true,
            vk: 0x11,
            scan: 0x1d,
            extended: false,
        })
    }

    #[test]
    fn a_failed_repeat_press_is_still_released_when_the_grant_lapses() {
        let t0 = Instant::now();
        let gate = Gate::default();
        let mut injector = inject::Injector::with_sink(gate.clone());
        let (mut control, challenge) = active_control(t0);
        feed_gate(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        feed_gate(&mut injector, &mut control, ctrl_down(), t0);
        // The auto-repeat inserts nothing, even after re-attaching.
        *gate.blocked.borrow_mut() = true;
        feed_gate(&mut injector, &mut control, ctrl_down(), t0);
        *gate.blocked.borrow_mut() = false;
        gate.inserted.borrow_mut().clear();

        let mut replies = Vec::new();
        tick(
            &mut injector,
            &mut control,
            t0 + crate::security::GRANT_LIFETIME,
            &mut replies,
        );
        assert!(
            codes(&replies).contains(&"grant_expired".to_string()),
            "{replies:?}"
        );
        let released = std::mem::take(&mut *gate.inserted.borrow_mut());
        assert_eq!(released.len(), 1);
        assert!(is_key_up(&released[0]), "the press that landed is released");
    }

    #[test]
    fn a_renewal_just_after_expiry_cannot_hide_the_lapse() {
        let t0 = Instant::now();
        let sink = Recorder::default();
        let mut injector = inject::Injector::with_sink(sink.clone());
        let (mut control, first) = active_control(t0);
        feed(
            &mut injector,
            &mut control,
            grant(&first, 1, &GOOD_SIGNATURE),
            t0,
        );
        feed(&mut injector, &mut control, ctrl_down(), t0);
        // The next challenge, issued on cadence while the grant is live.
        let refresh = t0 + crate::security::GRANT_REFRESH;
        let mut replies = Vec::new();
        tick(&mut injector, &mut control, refresh, &mut replies);
        let second = issued_challenge(&replies);
        sink.0.borrow_mut().clear();

        // Its grant arrives just after the first one expired; no tick between.
        let late = t0 + crate::security::GRANT_LIFETIME;
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&second, 1, &GOOD_SIGNATURE),
            late,
        );
        assert_eq!(
            codes(&replies),
            ["grant_expired"],
            "the lapse is settled before the renewal"
        );
        let sent = std::mem::take(&mut *sink.0.borrow_mut());
        assert_eq!(sent.len(), 1);
        assert!(
            is_key_up(&sent[0]),
            "the key held under the lapsed grant was released"
        );
        assert!(control.authorized(late), "the renewal itself is valid");
    }

    #[test]
    fn a_new_run_releases_and_revokes_before_a_grant_in_the_same_batch() {
        let t0 = Instant::now();
        let sink = Recorder::default();
        let mut injector = inject::Injector::with_sink(sink.clone());
        let (mut control, first) = active_control(t0);
        feed(
            &mut injector,
            &mut control,
            grant(&first, 1, &GOOD_SIGNATURE),
            t0,
        );
        feed(&mut injector, &mut control, ctrl_down(), t0);
        let refresh = t0 + crate::security::GRANT_REFRESH;
        let mut replies = Vec::new();
        tick(&mut injector, &mut control, refresh, &mut replies);
        let open = issued_challenge(&replies);
        sink.0.borrow_mut().clear();

        // One batch: the new run, then a grant for it on the challenge still
        // open; no tick between.
        let (_, run_replies) = feed(
            &mut injector,
            &mut control,
            Message::VideoRun { epoch: 2 },
            refresh,
        );
        let (_, grant_replies) = feed(
            &mut injector,
            &mut control,
            grant(&open, 2, &GOOD_SIGNATURE),
            refresh,
        );
        assert_eq!(codes(&run_replies), ["grant_expired"]);
        assert_eq!(
            codes(&grant_replies),
            ["grant_unknown_challenge"],
            "the old run's challenges are revoked"
        );
        let sent = std::mem::take(&mut *sink.0.borrow_mut());
        assert_eq!(sent.len(), 1);
        assert!(
            is_key_up(&sent[0]),
            "the key held under the old run was released at the run change"
        );
        assert!(!control.authorized(refresh));

        // A challenge issued for the new run grants control again.
        let mut replies = Vec::new();
        tick(&mut injector, &mut control, refresh, &mut replies);
        let fresh = issued_challenge(&replies);
        let (_, replies) = feed(
            &mut injector,
            &mut control,
            grant(&fresh, 2, &GOOD_SIGNATURE),
            refresh,
        );
        assert!(replies.is_empty(), "{replies:?}");
        assert!(control.authorized(refresh));
        drop(injector);
        assert!(
            sink.0.borrow().is_empty(),
            "nothing from the old run was still held"
        );
    }

    #[test]
    fn an_injection_that_finds_the_desktop_gone_suspends_input_at_once() {
        let t0 = Instant::now();
        let gate = Gate::default();
        let mut injector = inject::Injector::with_sink(gate.clone());
        let (mut control, challenge) = active_control(t0);
        feed_gate(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        let left = protocol::PointerButton::Left;
        feed_gate(
            &mut injector,
            &mut control,
            input(InputEvent::PointerButton {
                button: left,
                down: true,
                x: 1,
                y: 1,
            }),
            t0,
        );

        // The input desktop goes away: an insert is blocked and re-attaching fails.
        *gate.blocked.borrow_mut() = true;
        *gate.desktop_gone.borrow_mut() = true;
        let replies = feed_gate(
            &mut injector,
            &mut control,
            input(InputEvent::PointerMove { x: 2, y: 2 }),
            t0,
        );
        assert_eq!(codes(&replies), ["desktop_unavailable"]);
        assert!(
            !control.desktop_available,
            "capture and new input are suspended"
        );
        let sends = *gate.sends.borrow();

        // Later input of the same batch is dropped without reaching SendInput
        // or asking for a grant, and the loss is not also an input failure.
        let replies = feed_gate(
            &mut injector,
            &mut control,
            input(InputEvent::Text { text: "y".into() }),
            t0,
        );
        assert!(replies.is_empty(), "{replies:?}");
        assert_eq!(*gate.sends.borrow(), sends, "nothing was injected");
        let mut replies = Vec::new();
        tick(&mut injector, &mut control, t0, &mut replies);
        assert!(
            replies.is_empty(),
            "reported once, as the lost desktop: {replies:?}"
        );

        // The serve loop's attach path brings the desktop back; input flows again.
        *gate.blocked.borrow_mut() = false;
        *gate.desktop_gone.borrow_mut() = false;
        control.desktop_available = true;
        gate.inserted.borrow_mut().clear();
        feed_gate(
            &mut injector,
            &mut control,
            input(InputEvent::PointerMove { x: 3, y: 3 }),
            t0,
        );
        assert_eq!(gate.inserted.borrow().len(), 1);
        drop(injector);
        assert_eq!(
            gate.inserted.borrow().len(),
            1,
            "the button's release was issued when the outage began"
        );
    }

    #[test]
    fn a_sas_whose_release_finds_the_desktop_gone_suspends_before_the_next_input() {
        let t0 = Instant::now();
        let gate = Gate::default();
        let mut injector = inject::Injector::with_sink(gate.clone());
        let (mut control, challenge) = active_control(t0);
        feed_gate(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        feed_gate(
            &mut injector,
            &mut control,
            input(InputEvent::Key {
                down: true,
                vk: 0xa2,
                scan: 0x1d,
                extended: false,
            }),
            t0,
        );
        assert_eq!(gate.inserted.borrow().len(), 1, "Ctrl went in");

        // One batch, no tick: sas → its release meets a desktop that cannot
        // be re-attached → input.
        *gate.blocked.borrow_mut() = true;
        *gate.desktop_gone.borrow_mut() = true;
        let mut replies = Vec::new();
        let effect = apply_control(
            &mut injector,
            &mut control,
            Message::Sas,
            t0,
            &fake_verify,
            &mut replies,
        );
        assert!(matches!(effect, Effect::Sas));
        let raised = std::cell::Cell::new(false);
        request_sas(
            &mut injector,
            &mut control,
            || Ok(None),
            || raised.set(true),
            &mut replies,
        );
        assert_eq!(codes(&replies), ["desktop_unavailable"]);
        assert!(!control.desktop_available, "suspended on the spot");
        assert!(!raised.get(), "no SAS while the desktop is unavailable");
        let sends = *gate.sends.borrow();
        let mut replies = Vec::new();
        apply_control(
            &mut injector,
            &mut control,
            input(InputEvent::Text { text: "y".into() }),
            t0,
            &fake_verify,
            &mut replies,
        );
        assert_eq!(*gate.sends.borrow(), sends, "no injection was attempted");
        assert!(
            replies.is_empty(),
            "the outage was already reported: {replies:?}"
        );
    }

    #[test]
    fn a_pending_desktop_loss_is_settled_before_the_next_message() {
        let t0 = Instant::now();
        let gate = Gate::default();
        let mut injector = inject::Injector::with_sink(gate.clone());
        let (mut control, challenge) = active_control(t0);
        feed_gate(
            &mut injector,
            &mut control,
            grant(&challenge, 1, &GOOD_SIGNATURE),
            t0,
        );
        feed_gate(
            &mut injector,
            &mut control,
            input(InputEvent::Key {
                down: true,
                vk: 0x41,
                scan: 0x1e,
                extended: false,
            }),
            t0,
        );
        // A release outside message dispatch meets a lost desktop.
        *gate.blocked.borrow_mut() = true;
        *gate.desktop_gone.borrow_mut() = true;
        injector.release_all();
        let sends = *gate.sends.borrow();
        let replies = feed_gate(
            &mut injector,
            &mut control,
            input(InputEvent::PointerMove { x: 1, y: 1 }),
            t0,
        );
        assert_eq!(codes(&replies), ["desktop_unavailable"]);
        assert_eq!(*gate.sends.borrow(), sends, "the move was never attempted");
    }

    #[test]
    fn a_sas_with_the_desktop_attached_releases_and_raises() {
        let t0 = Instant::now();
        let mut injector = inject::Injector::with_sink(Recorder::default());
        let (mut control, _) = active_control(t0);
        let raised = std::cell::Cell::new(false);
        let mut replies = Vec::new();
        request_sas(
            &mut injector,
            &mut control,
            || Ok(None),
            || raised.set(true),
            &mut replies,
        );
        assert!(raised.get());
        assert!(replies.is_empty(), "{replies:?}");
        let raised = std::cell::Cell::new(false);
        request_sas(
            &mut injector,
            &mut control,
            || Ok(Some(0)),
            || raised.set(true),
            &mut replies,
        );
        assert!(!raised.get());
        assert_eq!(codes(&replies), ["sas_disabled_by_policy"]);
    }

    #[test]
    fn the_helper_takes_exactly_one_well_formed_token() {
        let token = "ab".repeat(crate::security::SHUTDOWN_TOKEN_HEX / 2);
        assert_eq!(parse_helper_args(&[token.clone()]), Some(token.as_str()));
        assert_eq!(parse_helper_args(&[]), None);
        assert_eq!(
            parse_helper_args(&[token.clone(), "1234".into()]),
            None,
            "the retired pid argument"
        );
        assert_eq!(
            parse_helper_args(&["AB".repeat(crate::security::SHUTDOWN_TOKEN_HEX / 2)]),
            None
        );
        assert_eq!(parse_helper_args(&["ab".into()]), None);
    }

    #[test]
    fn inactive_gate_admits_only_in_place_releases_of_held_input() {
        let sink = Recorder::default();
        let mut injector = inject::Injector::with_sink(sink.clone());
        let mut control = Control::new(vec![0x33; 16], vec![KEY]);
        let now = Instant::now();
        let left = protocol::PointerButton::Left;

        // Inactive: nothing that moves, presses, scrolls, or types gets through.
        for event in [
            InputEvent::PointerMove { x: 5, y: 5 },
            InputEvent::PointerButton {
                button: left,
                down: true,
                x: 5,
                y: 5,
            },
            InputEvent::PointerWheel {
                x: 5,
                y: 5,
                dx: 0,
                dy: 1,
            },
            InputEvent::Key {
                down: true,
                vk: 0x41,
                scan: 0x1e,
                extended: false,
            },
            InputEvent::Text { text: "x".into() },
        ] {
            let (_, replies) = feed(&mut injector, &mut control, input(event), now);
            assert!(
                replies.is_empty(),
                "an inactive connection is not told about grants"
            );
        }
        // Inactive releases of input this connection never pressed: no-ops.
        feed(
            &mut injector,
            &mut control,
            input(InputEvent::PointerButton {
                button: left,
                down: false,
                x: 9,
                y: 9,
            }),
            now,
        );
        feed(
            &mut injector,
            &mut control,
            input(InputEvent::Key {
                down: false,
                vk: 0x5B,
                scan: 0x5b,
                extended: true,
            }),
            now,
        );
        assert!(
            sink.0.borrow().is_empty(),
            "inactive client injected nothing"
        );

        // A press this connection still holds (as if left down when control
        // lapsed) is released in place: the client's coordinates are ignored
        // and the pointer does not move.
        injector.pointer_button(left, true, 1, 1);
        sink.0.borrow_mut().clear();
        feed(
            &mut injector,
            &mut control,
            input(InputEvent::PointerButton {
                button: left,
                down: false,
                x: 30_000,
                y: -30_000,
            }),
            now,
        );
        let sent = std::mem::take(&mut *sink.0.borrow_mut());
        assert_eq!(sent.len(), 1);
        let mi = unsafe { sent[0].Anonymous.mi };
        assert_eq!(
            mi.dwFlags, MOUSEEVENTF_LEFTUP,
            "release only: no MOVE/ABSOLUTE"
        );
        assert_eq!((mi.dx, mi.dy), (0, 0));

        // A second release of the same button is untracked now: a no-op.
        feed(
            &mut injector,
            &mut control,
            input(InputEvent::PointerButton {
                button: left,
                down: false,
                x: 0,
                y: 0,
            }),
            now,
        );
        drop(injector);
        assert!(sink.0.borrow().is_empty());
    }

    #[test]
    fn out_of_order_or_wrong_version_opening_is_rejected() {
        let st = state();
        let step = Handshake::new().advance(
            &mut Vec::new(),
            &st,
            "Default",
            Message::ClientAuth { mac: "x".into() },
        );
        assert!(matches!(step, HandshakeStep::Fail));
        let step = Handshake::new().advance(
            &mut Vec::new(),
            &st,
            "Default",
            Message::ClientHello {
                protocol: PROTOCOL_VERSION - 1,
                client_nonce: generate_nonce(),
            },
        );
        assert!(matches!(step, HandshakeStep::Fail));
        let step = Handshake::new().advance(
            &mut Vec::new(),
            &st,
            "Default",
            Message::ClientHello {
                protocol: PROTOCOL_VERSION,
                client_nonce: "short".into(),
            },
        );
        assert!(matches!(step, HandshakeStep::Fail));
    }
}
