//! `mixdog-secure-desktop probe` — a small client for manual testing, run as
//! the installing user. It connects to the helper's pipe exactly as the app
//! would, performs the hello handshake with the on-disk secret, activates the
//! remote-control session, and prints the frames and desktop-change events that
//! arrive. Optional flags inject input so a tester can confirm pointer/keyboard
//! reach the current (including secure) desktop.
//!
//! Usage:
//!   mixdog-secure-desktop probe [--frames N] [--no-active]
//!                               [--move X Y] [--click X Y]
//!                               [--text STRING] [--key VK]

use crate::client::{authenticate, Hello};
use crate::protocol::{self, Decoded, InputEvent, Message, PointerButton};
use crate::security::InstallState;
use crate::{ipc, paths};

fn parse_i32(value: Option<&String>) -> Option<i32> {
    value.and_then(|v| v.parse().ok())
}

pub fn run(args: &[String]) -> i32 {
    let mut frames = 10u32;
    let mut activate = true;
    let mut pending: Vec<InputEvent> = Vec::new();

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--frames" => {
                frames = parse_i32(args.get(index + 1)).unwrap_or(10) as u32;
                index += 2;
            }
            "--no-active" => {
                activate = false;
                index += 1;
            }
            "--move" => {
                if let (Some(x), Some(y)) = (
                    parse_i32(args.get(index + 1)),
                    parse_i32(args.get(index + 2)),
                ) {
                    pending.push(InputEvent::PointerMove { x, y });
                }
                index += 3;
            }
            "--click" => {
                if let (Some(x), Some(y)) = (
                    parse_i32(args.get(index + 1)),
                    parse_i32(args.get(index + 2)),
                ) {
                    pending.push(InputEvent::PointerButton {
                        button: PointerButton::Left,
                        down: true,
                        x,
                        y,
                    });
                    pending.push(InputEvent::PointerButton {
                        button: PointerButton::Left,
                        down: false,
                        x,
                        y,
                    });
                }
                index += 3;
            }
            "--text" => {
                if let Some(text) = args.get(index + 1) {
                    pending.push(InputEvent::Text { text: text.clone() });
                }
                index += 2;
            }
            "--key" => {
                if let Some(vk) = parse_i32(args.get(index + 1)) {
                    let vk = vk as u16;
                    pending.push(InputEvent::Key {
                        down: true,
                        vk,
                        scan: 0,
                        extended: false,
                    });
                    pending.push(InputEvent::Key {
                        down: false,
                        vk,
                        scan: 0,
                        extended: false,
                    });
                }
                index += 2;
            }
            other => {
                eprintln!("probe: ignoring unknown argument {other}");
                index += 1;
            }
        }
    }

    let state = match std::fs::read_to_string(paths::state_file())
        .ok()
        .and_then(|text| InstallState::from_json(&text).ok())
    {
        Some(state) => state,
        None => {
            eprintln!(
                "probe: not installed (no readable state at {})",
                paths::state_file().display()
            );
            return 2;
        }
    };

    let pipe = match ipc::connect(&state.pipe_name) {
        Ok(pipe) => pipe,
        Err(error) => {
            eprintln!("probe: cannot connect to {}: {error}", state.pipe_name);
            return 2;
        }
    };
    let mut io = ipc::PipeIo(pipe.get());

    match authenticate(&mut io, &state) {
        Ok(Hello {
            protocol,
            version,
            session,
            desktop,
            locked,
        }) => {
            println!(
                "server-hello protocol={protocol} version={version} session={session} desktop={desktop} locked={locked:?}"
            );
        }
        Err(error) => {
            eprintln!("probe: {error}");
            return 1;
        }
    }

    if activate {
        let _ = protocol::write_all(
            &mut io,
            &protocol::encode_control(&Message::Control { active: true }),
        );
    }
    for event in pending {
        println!("sending input {event:?}");
        let _ = protocol::write_all(
            &mut io,
            &protocol::encode_control(&Message::Input { event }),
        );
    }

    let mut seen = 0u32;
    while seen < frames {
        match protocol::read_frame(&mut io) {
            Ok(Decoded::Video(header, pixels)) => {
                seen += 1;
                println!(
                    "frame seq={} {}x{} stride={} desktop={} ts={} bytes={} dirty={}",
                    header.seq,
                    header.width,
                    header.height,
                    header.stride,
                    header.desktop,
                    header.timestamp_ms,
                    pixels.len(),
                    header.dirty.len()
                );
            }
            Ok(Decoded::Control(Message::DesktopChanged {
                desktop,
                session,
                locked,
            })) => {
                println!("desktop-changed desktop={desktop} session={session} locked={locked:?}");
            }
            Ok(Decoded::Control(Message::Error { code, message })) => {
                println!("error code={code} message={message}");
            }
            Ok(other) => println!("other {other:?}"),
            Err(error) => {
                eprintln!("probe: read ended: {error}");
                break;
            }
        }
    }

    let _ = protocol::write_all(
        &mut io,
        &protocol::encode_control(&Message::Control { active: false }),
    );
    println!("probe: done ({seen} frames)");
    0
}
