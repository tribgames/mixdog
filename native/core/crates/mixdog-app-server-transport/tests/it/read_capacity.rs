//! What a connection keeps of its inbound read buffer after a frame far longer than the rest, measured on this test
//! process's live heap (each test runs in a process of its own under nextest).
#![allow(unsafe_code, reason = "the counting allocator wraps the system allocator")]

use std::alloc::GlobalAlloc;
use std::alloc::Layout;
use std::alloc::System;
use std::sync::atomic::AtomicIsize;
use std::sync::atomic::Ordering;

use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::Transport;
use mixdog_app_server_transport::websocket::BearerAuth;
use mixdog_app_server_transport::websocket::ListenerOrigin;
use mixdog_app_server_transport::websocket::WebSocketListener;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::common::install_rt;

const TOKEN: &str = "discovery-token";
const MIB: usize = 1024 * 1024;

/// The bytes held in live blocks of at least a mebibyte: a grown read buffer is one, and little else in the process is.
static LARGE_LIVE: AtomicIsize = AtomicIsize::new(0);

fn note(size: usize, by: isize) {
    if size >= MIB {
        LARGE_LIVE.fetch_add(size as isize * by, Ordering::Relaxed);
    }
}

struct Counting;

// SAFETY: every request goes to `System` with the caller's layout and its answer is returned unchanged; the counter only observes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note(layout.size(), 1);
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract, which `System` shares.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        note(layout.size(), 1);
        // SAFETY: the caller upholds `GlobalAlloc::alloc_zeroed`'s contract, which `System` shares.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note(layout.size(), -1);
        note(new_size, 1);
        // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract, which `System` shares.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        note(layout.size(), -1);
        // SAFETY: the caller upholds `GlobalAlloc::dealloc`'s contract, which `System` shares.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// A client's text frame as the wire carries it, written straight to the socket so the client keeps no buffer of it. A
/// zero mask key leaves the payload as it is.
fn masked_text(text: &str) -> Vec<u8> {
    let mut frame = vec![0x81];
    match u16::try_from(text.len()) {
        Ok(len @ 0..=125) => frame.push(0x80 | u8::try_from(len).expect("under 126")),
        Ok(len) => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&len.to_be_bytes());
        }
        Err(_) => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(text.len() as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(&[0; 4]);
    frame.extend_from_slice(text.as_bytes());
    frame
}

/// A frame of megabytes among small ones (an attachment sent inline) grows the reader's buffer to its size for that frame
/// only: once the small frames after it are read, no block of its size is left.
#[tokio::test]
async fn the_read_buffer_grown_for_a_long_frame_is_given_back_after_it() {
    install_rt();
    let limits = Limits { max_inbound_frame_bytes: 8 * MIB as u64, ..Limits::default() };
    let hub = ConnectionHub::new(limits).unwrap();
    let mut listener = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), hub, BearerAuth::new(TOKEN), ListenerOrigin::Loopback).await.unwrap();
    let addr = listener.local_addr();
    let mut request = format!("ws://{addr}/rpc").into_client_request().unwrap();
    request.headers_mut().insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    let (mut client, _) = tokio_tungstenite::client_async(request, TcpStream::connect(addr).await.unwrap()).await.unwrap();
    let mut server = listener.accept().await.expect("listener open");
    let socket = client.get_mut();
    let small = |id: u32| format!(r#"{{"id":{id},"method":"x","params":["small"]}}"#);
    socket.write_all(&masked_text(&small(1))).await.unwrap();
    assert!(matches!(server.inbound.recv().await, Some(JsonRpcMessage::Request(_))));
    let before = LARGE_LIVE.load(Ordering::Relaxed);
    let long = masked_text(&format!(r#"{{"id":2,"method":"x","params":["{}"]}}"#, "a".repeat(3 * MIB)));
    socket.write_all(&long).await.unwrap();
    drop(long);
    assert!(matches!(server.inbound.recv().await, Some(JsonRpcMessage::Request(_))));
    for id in 3..11 {
        socket.write_all(&masked_text(&small(id))).await.unwrap();
        assert!(matches!(server.inbound.recv().await, Some(JsonRpcMessage::Request(_))));
    }
    let kept = LARGE_LIVE.load(Ordering::Relaxed) - before;
    assert!(kept < MIB as isize, "{kept} bytes of large blocks are still held after the long frame");
}
