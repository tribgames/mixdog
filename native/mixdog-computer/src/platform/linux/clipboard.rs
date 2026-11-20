//! Writing the X11 clipboard: the text stays available only while its owner answers conversion requests, so a thread owns
//! the selection and serves it until another client takes ownership. The thread holds no permission: each of its submissions
//! (taking the selection, writing a requestor's property, notifying it) is admitted by the executor's port when it acts, so
//! after Off it serves nothing more, whether or not the caller is still waiting. Its readiness wait only bounds how long the
//! caller waits for the answer; it plays no part in the admission.

use super::x11::{Atoms, connect};
use crate::port::linux::{Selection, selection};
use std::sync::mpsc;
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, SELECTION_NOTIFY_EVENT, SelectionNotifyEvent, WindowClass};

pub fn own(text: String) -> Result<(), String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("mixdog clipboard".into())
        .spawn(move || {
            let setup = (|| -> Result<_, String> {
                let (conn, root) = connect()?;
                let atoms = Atoms::intern(&conn)?;
                // This process's own window: no other application sees it until it owns the selection.
                let window = conn.generate_id().map_err(|error| error.to_string())?;
                conn.create_window(0, window, root, -1, -1, 1, 1, 0, WindowClass::INPUT_ONLY, 0, &Default::default()).map_err(|error| error.to_string())?;
                selection(&conn, Selection::Own { window, selection: atoms.CLIPBOARD })?;
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
                // The wait for the next request holds nothing.
                let Ok(event) = conn.wait_for_event() else {
                    return;
                };
                match event {
                    Event::SelectionClear(clear) if clear.owner == window => return,
                    Event::SelectionRequest(request) => {
                        let mut property = request.property;
                        if property == x11rb::NONE {
                            property = request.target;
                        }
                        let served = if request.target == atoms.TARGETS {
                            let targets = [atoms.TARGETS, atoms.UTF8_STRING, AtomEnum::STRING.into(), atoms.TEXT];
                            selection(&conn, Selection::Atoms { requestor: request.requestor, property, atoms: &targets })
                        } else if [atoms.UTF8_STRING, u32::from(AtomEnum::STRING), atoms.TEXT].contains(&request.target) {
                            selection(&conn, Selection::Text { requestor: request.requestor, property, target: request.target, bytes: &bytes })
                        } else {
                            Err(String::new())
                        };
                        // Refused after Off: the owner stops serving.
                        if served.as_ref().is_err_and(|error| error == crate::port::REVOKED) {
                            return;
                        }
                        let notify = SelectionNotifyEvent {
                            response_type: SELECTION_NOTIFY_EVENT,
                            sequence: 0,
                            time: request.time,
                            requestor: request.requestor,
                            selection: request.selection,
                            target: request.target,
                            property: if served.is_ok() { property } else { x11rb::NONE },
                        };
                        if selection(&conn, Selection::Notify(notify)).is_err_and(|error| error == crate::port::REVOKED) {
                            return;
                        }
                    }
                    _ => {}
                }
            }
        })
        .map_err(|error| error.to_string())?;
    ready_rx.recv_timeout(Duration::from_secs(2)).map_err(|_| "clipboard_unavailable: clipboard owner did not start".to_string())?
}
