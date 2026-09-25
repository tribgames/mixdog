//! Writing the X11 clipboard: the text stays available only while its owner
//! answers conversion requests, so a thread owns the selection and serves
//! it until another client takes ownership.

use super::x11::{connect, Atoms};
use std::sync::mpsc;
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, PropMode, SelectionNotifyEvent, WindowClass, SELECTION_NOTIFY_EVENT};
use x11rb::protocol::Event;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::CURRENT_TIME;

pub fn own(text: String) -> Result<(), String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("mixdog clipboard".into())
        .spawn(move || {
            let setup = (|| -> Result<_, String> {
                let (conn, root) = connect()?;
                let atoms = Atoms::intern(&conn)?;
                let window = conn.generate_id().map_err(|error| error.to_string())?;
                conn.create_window(0, window, root, -1, -1, 1, 1, 0, WindowClass::INPUT_ONLY, 0, &Default::default()).map_err(|error| error.to_string())?;
                conn.set_selection_owner(window, atoms.CLIPBOARD, CURRENT_TIME).map_err(|error| error.to_string())?;
                let owner = conn.get_selection_owner(atoms.CLIPBOARD).map_err(|error| error.to_string())?.reply().map_err(|error| error.to_string())?.owner;
                if owner != window {
                    return Err("clipboard_unavailable: another client kept the clipboard".into());
                }
                Ok((conn, atoms, window))
            })();
            let (conn, atoms, window) = match setup {
                Ok(parts) => {
                    let _ = ready_tx.send(Ok(()));
                    parts
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let bytes = text.into_bytes();
            loop {
                let Ok(event) = conn.wait_for_event() else { return };
                match event {
                    Event::SelectionClear(clear) if clear.owner == window => return,
                    Event::SelectionRequest(request) => {
                        let mut property = request.property;
                        if property == x11rb::NONE {
                            property = request.target;
                        }
                        let served = if request.target == atoms.TARGETS {
                            let targets = [atoms.TARGETS, atoms.UTF8_STRING, AtomEnum::STRING.into(), atoms.TEXT];
                            conn.change_property32(PropMode::REPLACE, request.requestor, property, AtomEnum::ATOM, &targets).is_ok()
                        } else if [atoms.UTF8_STRING, u32::from(AtomEnum::STRING), atoms.TEXT].contains(&request.target) {
                            conn.change_property8(PropMode::REPLACE, request.requestor, property, request.target, &bytes).is_ok()
                        } else {
                            false
                        };
                        let notify = SelectionNotifyEvent {
                            response_type: SELECTION_NOTIFY_EVENT,
                            sequence: 0,
                            time: request.time,
                            requestor: request.requestor,
                            selection: request.selection,
                            target: request.target,
                            property: if served { property } else { x11rb::NONE },
                        };
                        let _ = conn.send_event(false, request.requestor, x11rb::protocol::xproto::EventMask::NO_EVENT, notify);
                        let _ = conn.flush();
                    }
                    _ => {}
                }
            }
        })
        .map_err(|error| error.to_string())?;
    ready_rx.recv_timeout(Duration::from_secs(2)).map_err(|_| "clipboard_unavailable: clipboard owner did not start".to_string())?
}
