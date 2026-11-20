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
            // An error that names a reason without being a received frame (`Kind::Reason`) is still a stream ended with that code.
            if h2.is_reset() || h2.reason().is_some() {
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
    if connecting { TransportFault::Connect { os_code: None } } else { TransportFault::Closed }
}

/// What ended an HTTP/2 connection, for the daemon log: the GOAWAY or RST_STREAM with its code, or the I/O error (its kind and
/// OS number) the connection died of; an error that states none is a peer that ended without GOAWAY.
pub fn describe_h2_end(err: &h2::Error) -> String {
    let code = err.reason().map(u32::from);
    let io = err.get_io();
    // Who sent the frame: the peer, or this side on a protocol error it detected. h2 keeps a received GOAWAY's last stream id
    // to itself; a stream that fails with the peer's GOAWAY is one above it.
    let by = if err.is_remote() {
        " by=peer"
    } else if err.is_library() {
        " by=local"
    } else {
        ""
    };
    let cause = if err.is_go_away() {
        format!("goaway code={}{by}", code.unwrap_or(0))
    } else if err.is_reset() {
        format!("reset code={}{by}", code.unwrap_or(0))
    } else if let Some(code) = code {
        format!("reason code={code}")
    } else if let Some(io) = io {
        format!("io kind={:?} os={:?}", io.kind(), io.raw_os_error())
    } else {
        "ended without goaway".to_owned()
    };
    // Never the error's own text: it carries the peer's GOAWAY debug bytes, which are whatever the peer chose to send.
    cause
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A connection-level error reaches the chain as what it was: an OS reset, a peer that ended without GOAWAY (an EOF
    /// wrapped by `h2`), a stream reset with its code. Each names a Node code through the fault.
    #[test]
    fn a_connection_level_error_keeps_its_identity() {
        #[derive(Debug)]
        struct Wrapped(io::Error);
        impl std::fmt::Display for Wrapped {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "wrapped: {}", self.0)
            }
        }
        impl Error for Wrapped {
            fn source(&self) -> Option<&(dyn Error + 'static)> {
                Some(&self.0)
            }
        }
        let reset = Wrapped(io::Error::from(io::ErrorKind::ConnectionReset));
        assert_eq!(fault_from_chain(&reset, false), TransportFault::Reset);
        let eof = Wrapped(io::Error::from(io::ErrorKind::UnexpectedEof));
        assert_eq!(fault_from_chain(&eof, false), TransportFault::Closed);
        let refused = h2::Error::from(h2::Reason::REFUSED_STREAM);
        assert_eq!(fault_from_chain(&refused, false), TransportFault::H2RstStream { code: 7 });
        assert!(describe_h2_end(&refused).starts_with("reason code=7"));
        assert_eq!(TransportFault::H2GoAway { code: 11 }.errno_name(), Some("ERR_HTTP2_GOAWAY_SESSION"));
        assert_eq!(TransportFault::H2RstStream { code: 7 }.errno_name(), Some("ERR_HTTP2_STREAM_ERROR"));
    }
}

pub fn fault_from_ws_error(err: &tungstenite::Error) -> TransportFault {
    match err {
        tungstenite::Error::Io(io) => fault_from_io(io, false),
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => TransportFault::Closed,
        tungstenite::Error::Tls(_) => TransportFault::Tls,
        tungstenite::Error::Protocol(tungstenite::error::ProtocolError::ResetWithoutClosingHandshake) => TransportFault::Reset,
        _ => TransportFault::Io { os_code: None },
    }
}
