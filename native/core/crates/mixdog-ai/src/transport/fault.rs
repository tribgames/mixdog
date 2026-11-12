//! Socket-level failures as [`TransportFault`]s. The mapping reads error
//! kinds and typed error chains only, never message text.

use std::error::Error;
use std::io;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use tokio_tungstenite::tungstenite;

use super::link::Surface;

/// `connecting` is true while the TCP connection is being established: any
/// OS failure then is a connect failure (including the OS SYN retry
/// timeout), while after connect the same `ETIMEDOUT` is the socket's own
/// keepalive or retransmission failure.
pub fn fault_from_io(err: &io::Error, connecting: bool) -> TransportFault {
    use io::ErrorKind as K;
    let os_code = err.raw_os_error();
    match err.kind() {
        K::ConnectionReset | K::ConnectionAborted if !connecting => TransportFault::Reset,
        K::UnexpectedEof if !connecting => TransportFault::Closed,
        _ if connecting => TransportFault::Connect { os_code },
        _ => TransportFault::Io { os_code },
    }
}

/// Walks the source chain for the first typed transport fact: an HTTP/2
/// GOAWAY or RST_STREAM, then an I/O error. No evidence means the
/// connection ended without a stated cause.
pub fn fault_from_chain(err: &(dyn Error + 'static), connecting: bool) -> TransportFault {
    let mut cursor: Option<&(dyn Error + 'static)> = Some(err);
    while let Some(current) = cursor {
        if let Some(h2) = current.downcast_ref::<h2::Error>() {
            let code = h2.reason().map_or(0, u32::from);
            if h2.is_go_away() {
                return TransportFault::H2GoAway { code };
            }
            if h2.is_reset() {
                return TransportFault::H2RstStream { code };
            }
            if let Some(io) = h2.get_io() {
                return fault_from_io(io, connecting);
            }
        }
        if let Some(io) = current.downcast_ref::<io::Error>() {
            return fault_from_io(io, connecting);
        }
        cursor = current.source();
    }
    if connecting {
        TransportFault::Connect { os_code: None }
    } else {
        TransportFault::Closed
    }
}

/// A failed `reqwest` exchange. A connect error means no request byte
/// reached the socket; an error while reading the body is after the status;
/// anything else is after the write and before a status.
pub fn fault_from_reqwest(err: &reqwest::Error) -> (TransportFault, DeliveryState) {
    if err.is_connect() {
        (fault_from_chain(err, true), DeliveryState::NotSent)
    } else if err.is_body() || err.is_decode() {
        (fault_from_chain(err, false), DeliveryState::Accepted)
    } else {
        (fault_from_chain(err, false), DeliveryState::Ambiguous)
    }
}

/// [`fault_from_reqwest`] as a classified error (kind `Transient`). The message is the call site's
/// text ([`Surface`]); the fault stays typed for logic.
pub fn provider_error_from_reqwest(err: &reqwest::Error, surface: Surface) -> ProviderError {
    let (fault, delivery) = fault_from_reqwest(err);
    let message = surface.text(|| format!("{fault:?}"));
    let mut error = ProviderError::transport(fault, delivery);
    error.message = message;
    error
}

pub fn fault_from_ws_error(err: &tungstenite::Error) -> TransportFault {
    match err {
        tungstenite::Error::Io(io) => fault_from_io(io, false),
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            TransportFault::Closed
        }
        tungstenite::Error::Tls(_) => TransportFault::Tls,
        tungstenite::Error::Protocol(
            tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
        ) => TransportFault::Reset,
        _ => TransportFault::Io { os_code: None },
    }
}