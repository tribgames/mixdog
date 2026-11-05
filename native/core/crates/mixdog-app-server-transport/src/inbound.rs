//! The reader task of a connection: frame bounds, decoding and the close codes of P §3, X17.

use std::sync::Arc;

use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::media::MediaFrameError;
use mixdog_app_protocol::media::MediaFrameHeader;
use mixdog_app_protocol::rpc::InboundText;
use mixdog_app_protocol::rpc::decode_inbound_text;
use tokio::sync::mpsc;

use crate::socket::Incoming;
use crate::socket::SocketRead;
use crate::writer::Closing;
use crate::writer::Shared;

/// What one inbound event does to the connection.
enum Step {
    Continue,
    /// The connection ends with this code.
    Fault(CloseCode),
    /// Nothing more to read.
    Stop,
}

pub(crate) async fn read_loop<R: SocketRead>(
    shared: Arc<Shared>,
    mut socket: R,
    inbound: mpsc::Sender<JsonRpcMessage>,
) {
    loop {
        let incoming = tokio::select! {
            () = shared.abort.cancelled() => break,
            incoming = socket.next() => incoming,
        };
        let Some(incoming) = incoming else { break };
        shared.note_rx();
        match handle(&shared, &inbound, incoming).await {
            Step::Continue => {}
            Step::Fault(code) => {
                shared.begin_close(Closing::Send(code), false);
                break;
            }
            Step::Stop => break,
        }
    }
    // A stream that ends without a close frame is the peer closing too.
    shared.begin_close(Closing::Peer, false);
}

async fn handle(
    shared: &Shared,
    inbound: &mpsc::Sender<JsonRpcMessage>,
    incoming: Incoming,
) -> Step {
    match incoming {
        Incoming::Activity => Step::Continue,
        Incoming::Close => {
            shared.begin_close(Closing::Peer, false);
            Step::Continue
        }
        Incoming::Fault(code) => Step::Fault(code),
        // Frames after a close began are discarded; the peer is only finishing the handshake.
        Incoming::Text(_) | Incoming::Binary(_) if shared.is_closing() => Step::Continue,
        Incoming::Text(text) => match decode_inbound_text(&text, shared.limits.max_inbound) {
            InboundText::Message(message) => {
                tokio::select! {
                    sent = inbound.send(message) => match sent {
                        Ok(()) => Step::Continue,
                        // The server dropped the connection's inbound queue.
                        Err(_) => Step::Fault(CloseCode::Normal),
                    },
                    () = shared.abort.cancelled() => Step::Stop,
                }
            }
            other => match other.close_code() {
                Some(code) => Step::Fault(code),
                None => Step::Continue,
            },
        },
        Incoming::Binary(frame) => {
            let Some(sink) = shared.media() else {
                return Step::Fault(CloseCode::UnsupportedData);
            };
            match MediaFrameHeader::decode(&frame, shared.limits.max_media) {
                Ok(_) => {
                    sink.frame(shared.id(), frame);
                    Step::Continue
                }
                Err(MediaFrameError::PayloadTooLarge) => Step::Fault(CloseCode::FrameTooBig),
                Err(_) => Step::Fault(CloseCode::InvalidFrame),
            }
        }
    }
}
