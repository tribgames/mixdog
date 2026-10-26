//! The session helper (`mixdog-secure-desktop helper <shutdown-token>`).
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
//! Security posture enforced here: frames stream and new input is injected only
//! while the app has sent `control { active: true }` (while inactive, only an
//! in-place release of a button/key this connection still holds); a connection
//! can never release input it did not press; the handshake rejects a
//! wrong protocol version or a bad secret before anything else happens; the
//! pipe's DACL (built from the installing user's SID) is applied at creation;
//! and before the handshake, the connecting client is verified to be the
//! installing user running in the console session this helper serves. Held
//! pointer/keyboard input is tracked and released on every transition so a
//! press can never be stranded on the (possibly secure) desktop. No message is
//! logged with the secret, and no frame pixels are ever logged.

use std::time::{Duration, Instant};

use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;

use crate::ipc::{Accept, SendError, ServerPipe};
use crate::protocol::{self, Decoded, FrameHeader, InputEvent, Message, PROTOCOL_VERSION};
use crate::security::{
    client_auth_tag, decode_nonce, generate_nonce, is_shutdown_token, secret_matches, server_auth_tag,
    InstallState,
};
use crate::shutdown::HelperEnd;
use crate::winutil::{client_user_sid, now_ms};
use crate::{capture, desktop, inject, ipc, log, paths};

/// Target capture cadence while active. The WebRTC effort drives real pacing;
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
const FRAME_DEADLINE: Duration = Duration::from_secs(10);

/// How long the service waits for this helper to acknowledge a stop and exit
/// before force-killing it. It is the frame deadline, reused rather than a new
/// number: no step of the helper's loop blocks on its peer for longer — accept
/// and every sleep also wake on the stop event, and writes are overlapped and
/// polled — so a helper that has not acknowledged within it is wedged.
pub const SHUTDOWN_DEADLINE: Duration = FRAME_DEADLINE;

/// Per-iteration read size. Matches the pipe's buffer so a full buffer drains
/// in one read.
const READ_CHUNK: usize = 1 << 16;

/// Entry point for `helper <shutdown-token>`. Returns an exit code.
///
/// The token names the service's stop/ack event pair. Every return after the
/// channel is open acknowledges — by then no injector is alive, so everything
/// the helper held has been released (see `Injector`'s `Drop`).
pub fn run(args: &[String]) -> i32 {
    let shutdown = match args.first().filter(|token| is_shutdown_token(token)) {
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
    let code = serve(&shutdown);
    shutdown.acknowledge();
    log::event("helper", &format!("exiting ({code}); all held input released"));
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
        match server.accept(shutdown.stop_handle()) {
            Ok(Accept::Connected) => {}
            Ok(Accept::Stopped) => {
                log::event("helper", "stop requested while idle");
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
            log::event("helper", "stop requested");
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
                &protocol::encode_control(&Message::error("desktop_attach_failed", error.to_string())),
            );
            linger(server, shutdown);
            return;
        }
    };

    let launch_session = session_id();
    let mut acc = protocol::FrameAccumulator::new();
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut handshake = Handshake::new();
    let mut active = false;
    let mut seq: u64 = 0;
    let connected_at = Instant::now();
    let mut next_capture = Instant::now();
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
                    if !handshake.is_done() {
                        if matches!(
                            handshake.advance(server, state, &attached_name, message),
                            HandshakeStep::Fail
                        ) {
                            // A rejection may have queued an error frame.
                            farewell = !server.is_idle();
                            break 'serve;
                        }
                    } else if !apply_control(&mut injector, &mut active, message) {
                        break 'serve;
                    }
                }
            }
        }

        // Move queued output along. Never blocks; a client that stopped reading
        // fails here once a frame outlives FRAME_DEADLINE.
        match server.pump() {
            Ok(()) => {}
            Err(SendError::TimedOut) => {
                log::event("helper", "write deadline exceeded (client stopped reading); dropping client");
                break 'serve;
            }
            Err(SendError::Closed(reason)) => {
                log::event("helper", &format!("write failed ({reason}); dropping client"));
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

        if handshake.is_done() {
            // Follow the input desktop across UAC / lock transitions, releasing
            // any held input first so nothing is stranded on the old desktop.
            if let Some(input_name) = desktop::input_desktop_name() {
                if input_name != attached_name {
                    injector.release_all();
                    match desktop::attach_to_input_desktop() {
                        Ok((owned, name)) => {
                            _attached = owned;
                            attached_name = name;
                            let changed = Message::DesktopChanged {
                                desktop: attached_name.clone(),
                                session: session_id(),
                            };
                            let _ = protocol::write_all(server, &protocol::encode_control(&changed));
                            log::event("helper", &format!("desktop changed to {attached_name}"));
                        }
                        Err(error) => {
                            log::event("helper", &format!("re-attach failed: {error}"));
                        }
                    }
                }
            }

            // Capture only when the previous output's writes completed: a slow
            // reader gets fewer frames instead of a growing backlog.
            if active && server.is_idle() && Instant::now() >= next_capture {
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
                        let _ = protocol::write_all(server, &protocol::encode_video(&header, &frame.pixels));
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

        // Sleep, but wake at once on a stop request.
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
    /// Mutually authenticated; `server-hello` sent.
    Done,
}

impl Handshake {
    fn new() -> Self {
        Handshake::AwaitingHello
    }

    fn is_done(&self) -> bool {
        matches!(self, Handshake::Done)
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
                let Message::ClientHello { protocol: version, client_nonce } = message else {
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
                *self = Handshake::AwaitingAuth { client_nonce, server_nonce };
                HandshakeStep::Continue
            }
            Handshake::AwaitingAuth { client_nonce, server_nonce } => {
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
                let hello = Message::ServerHello {
                    protocol: PROTOCOL_VERSION,
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    session: session_id(),
                    desktop: desktop.to_string(),
                };
                if protocol::write_all(io, &protocol::encode_control(&hello)).is_err() {
                    return HandshakeStep::Fail;
                }
                *self = Handshake::Done;
                log::event("helper", "client authenticated");
                HandshakeStep::Done
            }
            Handshake::Done => HandshakeStep::Done,
        }
    }
}

/// While remote control is inactive, the only input applied is a **release of a
/// button or key this connection pressed and still holds** — performed in
/// place: no pointer movement, and the event's coordinates are ignored. Any
/// other event, and a release of anything this connection does not hold, is
/// dropped. (A release can only end this connection's own press, so it cannot
/// move, click, or type on the — possibly secure — desktop.)
fn release_while_inactive<S: inject::InputSink>(injector: &mut inject::Injector<S>, event: InputEvent) {
    match event {
        InputEvent::PointerButton { button, down: false, .. } => {
            injector.release_button(button);
        }
        InputEvent::Key { down: false, vk, scan, extended } => {
            injector.release_key(vk, scan, extended);
        }
        _ => {}
    }
}

/// Apply one post-handshake control message. Returns false only on a fatal
/// condition that should end the connection. Deactivating releases held input.
fn apply_control<S: inject::InputSink>(
    injector: &mut inject::Injector<S>,
    active: &mut bool,
    message: Message,
) -> bool {
    match message {
        Message::Control { active: on } => {
            if *active && !on {
                injector.release_all();
            }
            *active = on;
            log::event(
                "helper",
                if on { "remote control active" } else { "remote control idle" },
            );
            true
        }
        Message::Input { event } => {
            if *active {
                inject_event(injector, event);
            } else {
                release_while_inactive(injector, event);
            }
            true
        }
        // A second hello, or a server-only message echoed back, is ignored.
        _ => true,
    }
}

fn inject_event<S: inject::InputSink>(injector: &mut inject::Injector<S>, event: InputEvent) {
    match event {
        InputEvent::PointerMove { x, y } => injector.pointer_move(x, y),
        InputEvent::PointerButton { button, down, x, y } => {
            injector.pointer_button(button, down, x, y)
        }
        InputEvent::PointerWheel { x, y, dx, dy } => injector.pointer_wheel(x, y, dx, dy),
        InputEvent::Key { down, vk, scan, extended } => injector.key(down, vk, scan, extended),
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
            Message::ClientHello { protocol: PROTOCOL_VERSION, client_nonce: client_nonce.into() },
        );
        assert!(matches!(step, HandshakeStep::Continue));
        match replies(&wire).pop() {
            Some(Message::ServerAuth { server_nonce, mac, .. }) => (server_nonce, mac),
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
        assert!(secret_matches(&server_auth_tag(&st.secret, &client_nonce, &server_nonce), &server_mac));
        let mut wire = Vec::new();
        let step = hs.advance(
            &mut wire,
            &st,
            "Default",
            Message::ClientAuth { mac: client_auth_tag(&st.secret, &server_nonce, &client_nonce) },
        );
        assert!(matches!(step, HandshakeStep::Done));
        assert!(hs.is_done());
        assert!(matches!(replies(&wire).pop(), Some(Message::ServerHello { .. })));
        // Nothing the helper wrote contains the secret.
        let all = format!("{server_nonce_b64}{server_mac}{}", String::from_utf8_lossy(&wire));
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
            Message::ClientAuth { mac: client_auth_tag(&guess, &server_nonce, &client_nonce) },
        );
        assert!(matches!(step, HandshakeStep::Fail));
        assert!(!hs.is_done());
        assert!(!replies(&wire).iter().any(|m| matches!(m, Message::ServerHello { .. })));
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
        let step = second.advance(&mut wire, &st, "Default", Message::ClientAuth { mac: recorded });
        assert!(matches!(step, HandshakeStep::Fail));

        // Reflecting the server's own MAC back as the client's proof also fails.
        let mut third = Handshake::new();
        let (_, server_mac) = open(&mut third, &st, &client_nonce_b64);
        let step = third.advance(&mut Vec::new(), &st, "Default", Message::ClientAuth { mac: server_mac });
        assert!(matches!(step, HandshakeStep::Fail));
    }

    use std::cell::RefCell;
    use std::rc::Rc;
    use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, MOUSEEVENTF_LEFTUP};

    /// Records synthesized input instead of calling `SendInput`.
    #[derive(Clone, Default)]
    struct Recorder(Rc<RefCell<Vec<INPUT>>>);

    impl inject::InputSink for Recorder {
        fn send(&mut self, inputs: &[INPUT]) {
            self.0.borrow_mut().extend_from_slice(inputs);
        }
    }

    fn input(event: InputEvent) -> Message {
        Message::Input { event }
    }

    #[test]
    fn inactive_gate_admits_only_in_place_releases_of_held_input() {
        let sink = Recorder::default();
        let mut injector = inject::Injector::with_sink(sink.clone());
        let mut active = false;
        let left = protocol::PointerButton::Left;

        // Inactive: nothing that moves, presses, scrolls, or types gets through.
        for event in [
            InputEvent::PointerMove { x: 5, y: 5 },
            InputEvent::PointerButton { button: left, down: true, x: 5, y: 5 },
            InputEvent::PointerWheel { x: 5, y: 5, dx: 0, dy: 1 },
            InputEvent::Key { down: true, vk: 0x41, scan: 0x1e, extended: false },
            InputEvent::Text { text: "x".into() },
        ] {
            assert!(apply_control(&mut injector, &mut active, input(event)));
        }
        // Inactive releases of input this connection never pressed: no-ops.
        apply_control(&mut injector, &mut active, input(InputEvent::PointerButton { button: left, down: false, x: 9, y: 9 }));
        apply_control(&mut injector, &mut active, input(InputEvent::Key { down: false, vk: 0x5B, scan: 0x5b, extended: true }));
        assert!(sink.0.borrow().is_empty(), "inactive client injected nothing");

        // A press this connection still holds (as if left down when control
        // lapsed) is released in place: the client's coordinates are ignored
        // and the pointer does not move.
        injector.pointer_button(left, true, 1, 1);
        sink.0.borrow_mut().clear();
        apply_control(
            &mut injector,
            &mut active,
            input(InputEvent::PointerButton { button: left, down: false, x: 30_000, y: -30_000 }),
        );
        let sent = std::mem::take(&mut *sink.0.borrow_mut());
        assert_eq!(sent.len(), 1);
        let mi = unsafe { sent[0].Anonymous.mi };
        assert_eq!(mi.dwFlags, MOUSEEVENTF_LEFTUP, "release only: no MOVE/ABSOLUTE");
        assert_eq!((mi.dx, mi.dy), (0, 0));

        // A second release of the same button is untracked now: a no-op.
        apply_control(&mut injector, &mut active, input(InputEvent::PointerButton { button: left, down: false, x: 0, y: 0 }));
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
            Message::ClientHello { protocol: PROTOCOL_VERSION - 1, client_nonce: generate_nonce() },
        );
        assert!(matches!(step, HandshakeStep::Fail));
        let step = Handshake::new().advance(
            &mut Vec::new(),
            &st,
            "Default",
            Message::ClientHello { protocol: PROTOCOL_VERSION, client_nonce: "short".into() },
        );
        assert!(matches!(step, HandshakeStep::Fail));
    }
}
