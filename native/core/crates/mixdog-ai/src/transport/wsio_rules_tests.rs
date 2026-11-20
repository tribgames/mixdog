//! The WebSocket byte layer's rules with frames written out here: which answers to the extension offer are accepted,
//! which frames a client refuses and with what close code, how a compressed message is read and how an outgoing one is
//! written (RFC 6455 5.2-5.5, RFC 7692).

use flate2::Compress;
use flate2::Compression;
use flate2::Decompress;
use flate2::FlushCompress;
use flate2::FlushDecompress;

use super::*;

const TAIL: [u8; 4] = [0, 0, 0xff, 0xff];

fn parse_ext(header: &str) -> Result<Option<Extension>, String> {
    Extension::parse(Some(header))
}

#[test]
fn no_extension_header_is_no_compression_and_a_bare_acceptance_keeps_the_defaults() {
    assert_eq!(Extension::parse(None), Ok(None));
    assert_eq!(parse_ext("permessage-deflate"), Ok(Some(Extension::default())));
    assert_eq!(
        Extension::default(),
        Extension { server_no_context_takeover: false, client_no_context_takeover: false, client_max_window_bits: 15, server_max_window_bits: 15 }
    );
}

#[test]
fn the_accepted_parameters_set_the_windows_and_the_context_takeover_flags() {
    let got = parse_ext("permessage-deflate; server_no_context_takeover; client_no_context_takeover; client_max_window_bits=10; server_max_window_bits=\"9\"")
        .unwrap()
        .unwrap();
    assert_eq!(got, Extension { server_no_context_takeover: true, client_no_context_takeover: true, client_max_window_bits: 10, server_max_window_bits: 9 });
    let first_of_two = parse_ext("permessage-deflate; client_max_window_bits=9, permessage-deflate").unwrap().unwrap();
    assert_eq!(first_of_two.client_max_window_bits, 9, "of several configurations the first is used");
}

#[test]
fn an_answer_that_is_malformed_unrequested_repeated_or_out_of_range_ends_the_handshake_with_the_reason() {
    for (header, reason) in [
        ("permessage-deflate;;", "Invalid Sec-WebSocket-Extensions header"),
        ("bad name", "Invalid Sec-WebSocket-Extensions header"),
        ("x-webkit-deflate-frame", "Server indicated an extension that was not requested"),
        ("permessage-deflate, other", "Server indicated an extension that was not requested"),
        ("permessage-deflate; frobnicate", "Unknown parameter \"frobnicate\""),
        (
            "permessage-deflate; server_no_context_takeover; server_no_context_takeover",
            "Parameter \"server_no_context_takeover\" must have only a single value",
        ),
        ("permessage-deflate; client_max_window_bits=7", "Invalid value for parameter \"client_max_window_bits\": 7"),
        ("permessage-deflate; server_max_window_bits=16", "Invalid value for parameter \"server_max_window_bits\": 16"),
        ("permessage-deflate; client_max_window_bits", "Invalid value for parameter \"client_max_window_bits\": true"),
        ("permessage-deflate; client_no_context_takeover=1", "Invalid value for parameter \"client_no_context_takeover\": 1"),
    ] {
        assert_eq!(parse_ext(header), Err(reason.to_owned()), "{header}");
    }
}

fn read(codec: &mut Codec, bytes: &[u8]) -> (Vec<u8>, Result<(), Fault>, Vec<u8>) {
    let (mut raw, mut out) = (bytes.to_vec(), Vec::new());
    let result = codec.inbound(&mut raw, &mut out);
    (out, result, raw)
}

fn refused(first: u8, rest: &[u8], codec: &mut Codec) -> Fault {
    let mut bytes = vec![first];
    bytes.extend_from_slice(rest);
    read(codec, &bytes).1.expect_err("the frame is refused")
}

#[test]
fn plain_server_frames_pass_through_unchanged_and_in_order_and_a_partial_frame_waits() {
    let mut codec = Codec::plain();
    let frames = [vec![0x81, 2, b'h', b'i'], vec![0x82, 3, 1, 2, 3], vec![0x89, 0], vec![0x88, 2, 0x03, 0xe8]].concat();
    let (out, result, rest) = read(&mut codec, &frames);
    assert!(result.is_ok() && rest.is_empty());
    assert_eq!(out, frames);
    let (out, result, rest) = read(&mut codec, &[0x81, 5, b'a', b'b']);
    assert!(result.is_ok() && out.is_empty(), "nothing is handed on before the frame is whole");
    assert_eq!(rest, [0x81, 5, b'a', b'b'], "and what arrived is kept for the rest");
}

#[test]
fn a_masked_server_frame_reserved_bits_and_unknown_opcodes_are_refused_with_1002() {
    let masked = refused(0x81, &[0x82, 1, 2, 3, 4, 5, 6], &mut Codec::plain());
    assert_eq!((masked.code, masked.ws_code, masked.text.as_str()), (1002, "WS_ERR_UNEXPECTED_MASK", "Invalid WebSocket frame: MASK must be clear"));
    let rsv1 = refused(0xc1, &[0], &mut Codec::plain());
    assert_eq!(
        (rsv1.code, rsv1.ws_code, rsv1.text.as_str()),
        (1002, "WS_ERR_UNEXPECTED_RSV_1", "Invalid WebSocket frame: RSV1 must be clear"),
        "no compression was negotiated"
    );
    let rsv2 = refused(0xa1, &[0], &mut Codec::new(Extension::default()));
    assert_eq!((rsv2.code, rsv2.ws_code), (1002, "WS_ERR_UNEXPECTED_RSV_2_3"));
    let opcode = refused(0x83, &[0], &mut Codec::plain());
    assert_eq!((opcode.code, opcode.ws_code, opcode.text.as_str()), (1002, "WS_ERR_INVALID_OPCODE", "Invalid WebSocket frame: invalid opcode 3"));
}

#[test]
fn a_continuation_without_a_message_and_a_new_message_inside_one_are_refused() {
    let orphan = refused(0x80, &[0], &mut Codec::plain());
    assert_eq!((orphan.code, orphan.text.as_str()), (1002, "Invalid WebSocket frame: invalid opcode 0"));
    let mut codec = Codec::plain();
    assert!(read(&mut codec, &[0x01, 1, b'a']).1.is_ok(), "a fragmented message begins");
    let inside = refused(0x81, &[1, b'b'], &mut codec);
    assert_eq!(inside.text, "Invalid WebSocket frame: invalid opcode 1");
    let mut codec = Codec::new(Extension::default());
    let _ = read(&mut codec, &[0x01, 1, b'a']);
    assert_eq!(refused(0xc0, &[0], &mut codec).ws_code, "WS_ERR_UNEXPECTED_RSV_1", "only a message's first frame carries RSV1");
}

#[test]
fn a_control_frame_must_be_final_short_and_a_close_cannot_carry_one_byte() {
    let split_ping = refused(0x09, &[0], &mut Codec::plain());
    assert_eq!((split_ping.code, split_ping.ws_code, split_ping.text.as_str()), (1002, "WS_ERR_EXPECTED_FIN", "Invalid WebSocket frame: FIN must be set"));
    let long_ping = refused(0x89, &[126, 0, 126], &mut Codec::plain());
    assert_eq!((long_ping.ws_code, long_ping.text.as_str()), ("WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH", "Invalid WebSocket frame: invalid payload length 126"));
    let lone = refused(0x88, &[1, 0x03], &mut Codec::plain());
    assert_eq!(lone.text, "Invalid WebSocket frame: invalid payload length 1");
    assert!(read(&mut Codec::plain(), &[0x89, 125].iter().copied().chain(std::iter::repeat_n(0, 125)).collect::<Vec<u8>>()).1.is_ok(), "125 bytes is the most");
}

#[test]
fn a_text_message_must_be_utf8_when_it_is_complete_wherever_its_fragments_are_cut() {
    let bad = refused(0x81, &[2, 0xc3, 0x28], &mut Codec::plain());
    assert_eq!((bad.code, bad.ws_code, bad.text.as_str()), (1007, "WS_ERR_INVALID_UTF8", "Invalid WebSocket frame: invalid UTF-8 sequence"));
    let mut codec = Codec::plain();
    let euro = "€".as_bytes();
    let frames = [vec![0x01, 1, euro[0]], vec![0x80, 2, euro[1], euro[2]]].concat();
    let (out, result, _) = read(&mut codec, &frames);
    assert!(result.is_ok(), "a character split between fragments is whole at the end");
    assert_eq!(out, frames);
    let (_, unfinished, _) = read(&mut Codec::plain(), &[0x01, 1, euro[0], 0x80, 0]);
    assert_eq!(unfinished.expect_err("ends inside a character").code, 1007);
    assert!(read(&mut Codec::plain(), &[0x82, 2, 0xc3, 0x28]).1.is_ok(), "binary is not checked");
}

#[test]
fn a_declared_length_past_the_limit_is_refused_with_1009_before_its_payload_arrives() {
    let over = refused(0x82, &[127, 0, 0, 0, 0, 0x01, 0, 0, 0x01], &mut Codec::plain());
    assert_eq!((over.code, over.ws_code, over.text.as_str()), (1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", "Max payload size exceeded"));
    let exact = read(&mut Codec::plain(), &[0x82, 127, 0, 0, 0, 0, 0x01, 0, 0, 0]);
    assert!(exact.1.is_ok() && exact.0.is_empty(), "exactly 16 MiB is allowed (and still arriving)");
    let huge = refused(0x82, &[127, 0, 0x20, 0, 0, 0, 0, 0, 0], &mut Codec::plain());
    assert_eq!((huge.code, huge.ws_code), (1009, "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"), "longer than 2^53 - 1 is not a length");
    assert_eq!(MAX_PAYLOAD, 16 << 20);
}

fn server_deflate(encoder: &mut Compress, plain: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(plain.len() + 64);
    encoder.compress_vec(plain, &mut out, FlushCompress::Sync).unwrap();
    out.truncate(out.len() - TAIL.len());
    out
}

fn compressed_frame(first: u8, payload: &[u8]) -> Vec<u8> {
    assert!(payload.len() < 126);
    [vec![first, payload.len() as u8], payload.to_vec()].concat()
}

#[test]
fn a_compressed_message_is_handed_on_as_one_plain_frame_with_rsv1_cleared() {
    let mut encoder = Compress::new_with_window_bits(Compression::default(), false, 15);
    let mut codec = Codec::new(Extension::default());
    let packed = server_deflate(&mut encoder, b"hello hello hello hello");
    let (out, result, _) = read(&mut codec, &compressed_frame(0xc1, &packed));
    assert!(result.is_ok());
    assert_eq!(out, [vec![0x81, 23], b"hello hello hello hello".to_vec()].concat());
    let binary = server_deflate(&mut encoder, &[1, 2, 3, 4]);
    let (out, _, _) = read(&mut codec, &compressed_frame(0xc2, &binary));
    assert_eq!(out, [0x82, 4, 1, 2, 3, 4], "the opcode is kept");
}

#[test]
fn a_compressed_message_in_fragments_is_inflated_as_one_and_the_context_carries_over_unless_told_not_to() {
    let mut encoder = Compress::new_with_window_bits(Compression::default(), false, 15);
    let first = server_deflate(&mut encoder, b"abcabcabcabcabcabc");
    let second = server_deflate(&mut encoder, b"abcabcabcabcabcabc");
    assert!(second.len() < first.len(), "the second message refers to the first's window");
    let mut codec = Codec::new(Extension::default());
    assert!(read(&mut codec, &compressed_frame(0xc1, &first)).1.is_ok());
    let (out, result, _) = read(&mut codec, &compressed_frame(0xc1, &second));
    assert!(result.is_ok());
    assert_eq!(&out[2..], b"abcabcabcabcabcabc");
    let mut encoder = Compress::new_with_window_bits(Compression::default(), false, 15);
    let whole = server_deflate(&mut encoder, b"fragmented message fragmented message");
    let (head, tail) = whole.split_at(whole.len() / 2);
    let mut codec = Codec::new(Extension::default());
    let frames = [compressed_frame(0x41, head), compressed_frame(0x80, tail)].concat();
    let (out, result, _) = read(&mut codec, &frames);
    assert!(result.is_ok());
    assert_eq!(out, [vec![0x81, 37], b"fragmented message fragmented message".to_vec()].concat());
}

#[test]
fn with_server_no_context_takeover_every_message_is_inflated_afresh() {
    let extension = Extension { server_no_context_takeover: true, ..Extension::default() };
    let mut codec = Codec::new(extension);
    for _ in 0..2 {
        let mut encoder = Compress::new_with_window_bits(Compression::default(), false, 15);
        let packed = server_deflate(&mut encoder, b"same text same text");
        let (out, result, _) = read(&mut codec, &compressed_frame(0xc1, &packed));
        assert!(result.is_ok());
        assert_eq!(&out[2..], b"same text same text");
    }
}

#[test]
fn corrupt_deflate_data_and_a_compressed_text_that_is_not_utf8_are_refused_with_1007() {
    let corrupt = refused(0xc1, &[5, 0xff, 0xff, 0xff, 0xff, 0xff], &mut Codec::new(Extension::default()));
    assert_eq!((corrupt.code, corrupt.ws_code), (1007, "Z_DATA_ERROR"));
    let mut encoder = Compress::new_with_window_bits(Compression::default(), false, 15);
    let packed = server_deflate(&mut encoder, &[0xc3, 0x28]);
    let bad_text = refused(0xc1, &[&[packed.len() as u8][..], &packed[..]].concat(), &mut Codec::new(Extension::default()));
    assert_eq!((bad_text.code, bad_text.ws_code), (1007, "WS_ERR_INVALID_UTF8"));
}

fn client_frame(first: u8, payload: &[u8]) -> Vec<u8> {
    let key = [1u8, 2, 3, 4];
    let mut out = vec![first, 0x80 | payload.len() as u8];
    assert!(payload.len() < 126);
    out.extend_from_slice(&key);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
    out
}

fn big_client_frame(first: u8, payload: &[u8]) -> Vec<u8> {
    let key = [9u8, 8, 7, 6];
    let mut out = vec![first, 0x80 | 126];
    out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    out.extend_from_slice(&key);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
    out
}

fn unpack(frame: &[u8]) -> (u8, Vec<u8>) {
    let (header, key) = if frame[1] & 0x7f == 126 { (8, &frame[4..8]) } else { (6, &frame[2..6]) };
    let payload: Vec<u8> = frame[header..].iter().enumerate().map(|(i, b)| b ^ key[i % 4]).collect();
    (frame[0], payload)
}

fn inflated(packed: &[u8]) -> Vec<u8> {
    let mut decoder = Decompress::new(false);
    let mut out = Vec::with_capacity(8192);
    decoder.decompress_vec(&[packed, &TAIL].concat(), &mut out, FlushDecompress::Sync).unwrap();
    out
}

#[test]
fn an_outgoing_text_message_is_deflated_with_rsv1_and_inflates_back_to_what_was_sent() {
    let plain = vec![b'a'; 2000];
    let (mut raw, mut out) = (big_client_frame(0x81, &plain), Vec::new());
    Codec::new(Extension::default()).outbound(&mut raw, &mut out).unwrap();
    assert!(raw.is_empty());
    let (first, packed) = unpack(&out);
    assert_eq!(first, 0xc1, "FIN, RSV1 and the text opcode");
    assert!(packed.len() < 100, "{} bytes for 2000 repeated ones", packed.len());
    assert_eq!(inflated(&packed), plain);
}

#[test]
fn an_empty_outgoing_message_is_the_one_byte_the_extension_names() {
    let (mut raw, mut out) = (client_frame(0x81, b""), Vec::new());
    Codec::new(Extension::default()).outbound(&mut raw, &mut out).unwrap();
    let (first, packed) = unpack(&out);
    assert_eq!((first, packed), (0xc1, vec![0]));
}

#[test]
fn control_fragmented_and_uncompressed_negotiations_leave_outgoing_frames_as_written() {
    let close = client_frame(0x88, &[0x03, 0xe8]);
    let (mut raw, mut out) = (close.clone(), Vec::new());
    Codec::new(Extension::default()).outbound(&mut raw, &mut out).unwrap();
    assert_eq!(out, close, "a control frame is never compressed");
    let part = client_frame(0x01, b"part of a message");
    let (mut raw, mut out) = (part.clone(), Vec::new());
    Codec::new(Extension::default()).outbound(&mut raw, &mut out).unwrap();
    assert_eq!(out, part, "only a single-frame message is");
    let text = client_frame(0x81, &[b'z'; 100]);
    let (mut raw, mut out) = (text.clone(), Vec::new());
    Codec::plain().outbound(&mut raw, &mut out).unwrap();
    assert_eq!(out, text, "without the extension the bytes pass");
}

#[test]
fn when_the_clients_context_does_not_carry_over_a_short_message_is_sent_plain_and_a_long_one_is_deflated() {
    let extension = Extension { client_no_context_takeover: true, ..Extension::default() };
    let short = client_frame(0x81, &[b'q'; 100]);
    let (mut raw, mut out) = (short.clone(), Vec::new());
    Codec::new(extension).outbound(&mut raw, &mut out).unwrap();
    assert_eq!(out, short, "under 1024 bytes there is no gain worth the cost");
    let long = vec![b'q'; 1500];
    let (mut raw, mut out) = (big_client_frame(0x81, &long), Vec::new());
    Codec::new(extension).outbound(&mut raw, &mut out).unwrap();
    let (first, packed) = unpack(&out);
    assert_eq!(first, 0xc1);
    assert_eq!(inflated(&packed), long);
}
