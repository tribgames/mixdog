//! The desktop half of the browser interop run (`tests/interop/driver.mjs`). Not a unit test:
//! the driver starts it with `--ignored`, speaks JSON lines on stdin/stdout (signalling stands in
//! for the E2EE relay) and drives a real Chromium/WebKit `RTCPeerConnection` as the phone.
//! Stdout lines starting with `@@ ` are driver messages.

use std::io::BufRead;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use bytes::Bytes;
use mixdog_core_api::domain::media::EncodingParams;
use mixdog_core_api::domain::media::FrameSourceKind;
use mixdog_core_api::domain::media::PixelFormat;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

use super::carrier::CarrierChannel;
use super::carrier::CarrierConnection;
use super::carrier::CarrierEvent;
use super::carrier::CarrierItem;
use super::config::Candidate;
use super::config::PeerConfig;
use super::capture::SharedSource;
use super::liveview::LiveViewConnection;
use super::liveview::LiveViewEvent;
use super::liveview::SKIP_FIRST_KEYFRAME;
use super::sources::frame_feed;

fn emit(value: Value) {
    println!("@@ {value}");
}

fn candidate_json(candidate: Option<Candidate>) -> Value {
    match candidate {
        Some(c) => json!({
            "candidate": c.candidate,
            "sdpMid": c.sdp_mid,
            "sdpMLineIndex": c.sdp_mline_index,
            "usernameFragment": c.username_fragment,
        }),
        None => Value::Null,
    }
}

fn candidate_from(value: &Value) -> Option<Candidate> {
    let candidate = value.get("candidate")?.as_str()?.to_owned();
    if candidate.is_empty() {
        return None;
    }
    Some(Candidate {
        candidate,
        sdp_mid: value.get("sdpMid").and_then(Value::as_str).map(str::to_owned),
        sdp_mline_index: value.get("sdpMLineIndex").and_then(Value::as_u64).map(|n| n as u16),
        username_fragment: value.get("usernameFragment").and_then(Value::as_str).map(str::to_owned),
    })
}

fn stdin_lines() -> mpsc::UnboundedReceiver<Value> {
    let (tx, rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                let _ = tx.send(value);
            }
        }
    });
    rx
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "driven by tests/interop/driver.mjs"]
async fn interop_server() {
    let tokens = mixdog_rt::testing::tokens();
    let mode = std::env::var("INTEROP_MODE").unwrap_or_default();
    let mut commands = stdin_lines();
    if mode == "carrier" {
        carrier(&mut commands).await;
    } else {
        liveview(&mut commands, tokens.media_thread).await;
    }
}

async fn carrier(commands: &mut mpsc::UnboundedReceiver<Value>) {
    let (carrier, mut events) = CarrierConnection::spawn(PeerConfig::new(vec![]));
    carrier.offer(false);
    loop {
        tokio::select! {
            Some(event) = events.recv() => match event {
                CarrierEvent::Offer { sdp } => emit(json!({"t": "offer", "sdp": sdp})),
                CarrierEvent::Candidate { candidate, .. } => emit(json!({"t": "candidate", "c": candidate_json(candidate)})),
                CarrierEvent::Connected { remote_certificate } => emit(json!({"t": "connected", "cert": remote_certificate.is_some()})),
                CarrierEvent::Open { path, .. } => {
                    emit(json!({"t": "open", "path": format!("{path:?}")}));
                    carrier.send(vec![
                        CarrierItem { channel: CarrierChannel::App, data: Bytes::from_static(b"d1") },
                        CarrierItem { channel: CarrierChannel::Control, data: Bytes::from_static(b"dc1") },
                        CarrierItem { channel: CarrierChannel::App, data: Bytes::from_static(b"d2") },
                    ]);
                }
                CarrierEvent::Message { channel, data } => emit(json!({
                    "t": "message",
                    "channel": format!("{channel:?}"),
                    "data": String::from_utf8_lossy(&data),
                })),
                CarrierEvent::Failed(fault) => emit(json!({"t": "failed", "fault": fault.to_string()})),
                _ => {}
            },
            Some(command) = commands.recv() => match command["t"].as_str() {
                Some("answer") => carrier.answer(command["sdp"].as_str().unwrap_or_default().to_owned()),
                Some("candidate") => carrier.candidate(candidate_from(&command["c"])),
                Some("quit") => return,
                _ => {}
            },
        }
    }
}

async fn liveview(commands: &mut mpsc::UnboundedReceiver<Value>, media: mixdog_rt::MediaThread) {
    let (mut sink, source) = frame_feed(FrameSourceKind::Screen { display: 0 });
    let shared = SharedSource::start(Box::new(source));
    // Screen-like busy content: flat 16-pixel blocks, a quarter of them recoloured each frame.
    let producer = tokio::spawn(async move {
        let (w, h, block) = (640usize, 360usize, 16usize);
        let mut state = 0x9e37_79b9_u32;
        let mut data = vec![0u8; w * h * 4];
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state
        };
        loop {
            for by in 0..h.div_ceil(block) {
                for bx in 0..w.div_ceil(block) {
                    let r = next();
                    if r & 3 != 0 {
                        continue;
                    }
                    let color = [(r >> 8) as u8, (r >> 16) as u8, (r >> 24) as u8, 0];
                    for y in by * block..((by + 1) * block).min(h) {
                        for x in bx * block..((bx + 1) * block).min(w) {
                            data[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&color);
                        }
                    }
                }
            }
            if sink.push(PixelFormat::Bgrx, w as u32, h as u32, (w * 4) as u32, Bytes::copy_from_slice(&data)).is_err() {
                break;
            }
            mixdog_rt::time::sleep(Duration::from_millis(33)).await;
        }
    });    if std::env::var("INTEROP_SKIP_KEY").is_ok() {
        SKIP_FIRST_KEYFRAME.store(true, Ordering::Relaxed);
    }
    // Every phone ("v") has its own connection and encoder over the one shared capture.
    let mut viewers: HashMap<String, Arc<LiveViewConnection>> = HashMap::new();
    let (tagged_tx, mut tagged_rx) = mpsc::unbounded_channel::<(String, LiveViewEvent)>();
    loop {
        tokio::select! {
            Some((v, event)) = tagged_rx.recv() => match event {
                LiveViewEvent::Offer { sdp } => emit(json!({"t": "offer", "v": v, "sdp": sdp})),
                LiveViewEvent::Candidate { candidate } => emit(json!({"t": "candidate", "v": v, "c": candidate_json(candidate)})),
                LiveViewEvent::Connected { .. } => emit(json!({"t": "connected", "v": v})),
                LiveViewEvent::ChannelOpen => emit(json!({"t": "channel-open", "v": v})),
                LiveViewEvent::Channel { text, .. } => {
                    // The owner's job in production: a phone's commands become that phone's settings.
                    if let Ok(message) = serde_json::from_str::<Value>(&text)
                        && let Some(encoding) = message.get("encoding")
                        && let Some(live) = viewers.get(&v)
                    {
                        let result = live.set_encoding(EncodingParams {
                            max_bitrate_bps: encoding["maxBitrate"].as_u64().map(|n| n as u32),
                            max_framerate: encoding["maxFramerate"].as_u64().map(|n| n as u32),
                            maintain_resolution: true,
                        });
                        emit(json!({"t": "encoding", "v": v, "ok": result.is_ok()}));
                    }
                }
                LiveViewEvent::Failed(fault) => emit(json!({"t": "failed", "v": v, "fault": fault.to_string()})),
            },
            Some(command) = commands.recv() => {
                let v = command["v"].as_str().unwrap_or_default().to_owned();
                match command["t"].as_str() {
                    Some("start") => {
                        let codecs = command["codecs"].as_array().into_iter().flatten().filter_map(|c| c.as_str().map(str::to_owned)).collect();
                        let (connection, mut rx) = LiveViewConnection::spawn(PeerConfig::new(vec![]), codecs, Arc::clone(&shared), media).unwrap();
                        viewers.insert(v.clone(), Arc::new(connection));
                        let tx = tagged_tx.clone();
                        tokio::spawn(async move {
                            while let Some(event) = rx.recv().await {
                                if tx.send((v.clone(), event)).is_err() {
                                    break;
                                }
                            }
                        });
                    }
                    Some("answer") => if let Some(live) = viewers.get(&v) { live.answer(command["sdp"].as_str().unwrap_or_default().to_owned()) },
                    Some("candidate") => if let Some(live) = viewers.get(&v) { live.candidate(candidate_from(&command["c"])) },
                    Some("stats") => if let Some(live) = viewers.get(&v) {
                        let s = live.track_stats();
                        emit(json!({"t": "stats", "v": v, "keyframes": s.keyframes, "encoded": s.frames_encoded, "bitrate": s.bitrate_bps}));
                    },
                    Some("quit") => break,
                    _ => {}
                }
            },
        }
    }
    producer.abort();
    shared.stop();
}