#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
//! A staged upload round-trips through the production inbound frame limit: every `transfer/writeChunk` request the sender builds at
//! the advertised chunk size is admitted by the server's own frame decoder (`maxInboundFrameBytes` of `Limits::default()`, what
//! the daemon serves), and the bytes that come out of those frames are the file.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_app_protocol::InboundText;
use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::decode_inbound_text;
use mixdog_app_protocol::limits::Limits;
use mixdog_workspace::transfer::Transfers;
use serde_json::json;

#[test]
fn the_advertised_upload_window_holds_whole_chunks_of_the_advertised_size() {
    let limits = Limits::default();
    let encoded_chunk = limits.max_blob_put_chunk_bytes.div_ceil(3) * 4;
    assert_eq!(limits.max_upload_in_flight_bytes / encoded_chunk, 12, "twelve full chunks may be unanswered at the default limits");
    limits.check().expect("the default limits are valid");
    let too_small = Limits { max_upload_in_flight_bytes: encoded_chunk - 1, ..limits };
    assert!(too_small.check().is_err(), "a window below one full encoded chunk is refused at startup");
}

#[test]
fn a_file_larger_than_one_frame_uploads_in_frames_the_inbound_limit_admits() {
    let limits = Limits::default();
    // The sender sizes its chunks by what the core advertises at `initialize`.
    let chunk = limits.max_blob_put_chunk_bytes as usize;
    // Three full chunks and a short one: well past the 262144-byte frame a single 2 MiB chunk blew through.
    let file: Vec<u8> = (0..chunk * 3 + 1234).map(|i| (i * 31 % 251) as u8).collect();
    let dir = tempfile::tempdir().unwrap();
    let transfers = Transfers::default();
    let id = transfers.begin_staged("owner", dir.path(), "big.bin", file.len() as u64).unwrap();

    let mut sent = 0usize;
    let mut largest = 0usize;
    while sent < file.len() {
        let end = (sent + chunk).min(file.len());
        let request = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "transfer/writeChunk",
            "params": { "transferId": id, "offset": sent, "bytesB64": STANDARD.encode(&file[sent..end]) },
        })
        .to_string();
        largest = largest.max(request.len());
        let InboundText::Message(JsonRpcMessage::Request(decoded)) = decode_inbound_text(&request, limits.max_inbound_frame_bytes as usize) else {
            panic!("a frame of {} bytes was refused at offset {sent} (limit {})", request.len(), limits.max_inbound_frame_bytes);
        };
        let params = decoded.params.unwrap();
        let received = transfers.write_chunk("owner", &id, params["offset"].as_u64(), params["bytesB64"].as_str().unwrap()).unwrap();
        sent = end;
        assert_eq!(received as usize, sent);
    }
    assert!(largest > chunk, "the frames carried the chunks");
    let (size, path) = transfers.commit("owner", &id).unwrap();
    assert_eq!(size as usize, file.len());
    assert_eq!(std::fs::read(path).unwrap(), file);
}
