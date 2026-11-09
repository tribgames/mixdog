//! The manual lease clock's control connection (debug builds only): the deadlines a client must meet. A client that never sends, leaves a
//! line unfinished or does not read its answers is told what was awaited (when it can still be told) and the connection is closed, so a
//! stalled client holds neither a thread nor a socket for long.

use std::io::BufRead;
use std::io::BufReader;
use std::io::ErrorKind;
use std::io::Write;
use std::net::TcpStream;
use std::time::Duration;
use std::time::Instant;

/// How long a connection may send nothing at all between commands (the replay waits for shells between its steps).
pub(super) const IDLE_DEADLINE: Duration = Duration::from_secs(600);
/// How long a command may take to arrive once its first byte has.
pub(super) const LINE_DEADLINE: Duration = Duration::from_secs(10);
/// How long an answer may take to be accepted by the client.
pub(super) const WRITE_DEADLINE: Duration = Duration::from_secs(10);

/// What ended a connection, as the line sent to the client (if it can still be read) and the text for the core's log.
pub(super) enum Ended {
    Closed,
    Refused(String),
}

/// The next command line: waits up to `idle` for its first byte, then up to `line` for the rest. `Err` names what was awaited.
pub(super) fn read_command(reader: &mut BufReader<TcpStream>, idle: Duration, line: Duration) -> Result<String, Ended> {
    reader.get_ref().set_read_timeout(Some(idle)).map_err(|e| Ended::Refused(format!("the lease clock connection cannot be read: {e}")))?;
    match reader.fill_buf() {
        Ok([]) => return Err(Ended::Closed),
        Ok(_) => {}
        Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
            return Err(Ended::Refused(format!("no `advance <ms>` command arrived within {} s", idle.as_secs_f64())));
        }
        Err(_) => return Err(Ended::Closed),
    }
    let started = Instant::now();
    let mut bytes = Vec::new();
    while bytes.last() != Some(&b'\n') {
        let left = line.checked_sub(started.elapsed()).filter(|left| !left.is_zero());
        let Some(left) = left else {
            return Err(Ended::Refused(format!("the `advance <ms>` command was not finished with a newline within {} s", line.as_secs_f64())));
        };
        reader.get_ref().set_read_timeout(Some(left)).map_err(|e| Ended::Refused(format!("the lease clock connection cannot be read: {e}")))?;
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) => return Err(Ended::Closed),
            Ok(_) => {}
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return Err(Ended::Closed),
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Sends `text` within `deadline`; `Err` says what was awaited.
pub(super) fn answer(stream: &mut TcpStream, text: &str, deadline: Duration) -> Result<(), String> {
    stream.set_write_timeout(Some(deadline)).map_err(|e| format!("the lease clock connection cannot be written: {e}"))?;
    stream.write_all(text.as_bytes()).map_err(|e| match e.kind() {
        ErrorKind::WouldBlock | ErrorKind::TimedOut => format!("the client did not read the lease clock's answer {text:?} within {} s", deadline.as_secs_f64()),
        _ => format!("the lease clock connection closed before its answer {text:?} was sent: {e}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const SHORT: Duration = Duration::from_millis(300);

    fn pair() -> (TcpStream, BufReader<TcpStream>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (served, _) = listener.accept().unwrap();
        (client, BufReader::new(served))
    }

    fn refused(ended: Result<String, Ended>) -> String {
        match ended {
            Err(Ended::Refused(message)) => message,
            Ok(line) => panic!("a command was read: {line:?}"),
            Err(Ended::Closed) => panic!("the connection was closed without a message"),
        }
    }

    #[test]
    fn a_whole_line_is_read() {
        let (mut client, mut reader) = pair();
        client.write_all(b"advance 5\n").unwrap();
        assert_eq!(read_command(&mut reader, SHORT, SHORT).ok().as_deref(), Some("advance 5\n"));
    }

    #[test]
    fn a_connection_that_sends_nothing_is_refused_naming_the_command() {
        let (_client, mut reader) = pair();
        let message = refused(read_command(&mut reader, SHORT, SHORT));
        assert!(message.contains("no `advance <ms>` command arrived within 0.3 s"), "{message}");
    }

    #[test]
    fn a_line_left_unfinished_is_refused_naming_the_newline() {
        let (mut client, mut reader) = pair();
        client.write_all(b"advance 1").unwrap();
        let message = refused(read_command(&mut reader, SHORT, SHORT));
        assert!(message.contains("was not finished with a newline within 0.3 s"), "{message}");
    }

    #[test]
    fn a_client_that_does_not_read_its_answers_is_refused_naming_the_answer() {
        let (_client, reader) = pair();
        let mut served = reader.into_inner();
        // The answers fill the socket's buffers; the first one that cannot be sent in time names itself.
        let message = loop {
            if let Err(message) = answer(&mut served, &"lapsed 1\n".repeat(4096), SHORT) {
                break message;
            }
        };
        assert!(message.contains("did not read the lease clock's answer") && message.contains("within 0.3 s"), "{message}");
    }
}