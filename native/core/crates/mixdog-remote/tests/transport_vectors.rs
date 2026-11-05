//! DS-REM-4: the MXT stream core replays the operations the Node product was recorded running
//! (`benchmarks/rust-core/recorders/record-remote-transport.mjs`) and must produce equal results,
//! including the wire bytes (as lengths and SHA-256 of each carrier message).

use std::collections::HashMap;

use mixdog_remote::transport::consts::*;
use mixdog_remote::transport::control::{Control, ack_json, ping_json, pong_json, read_control, repair_json};
use mixdog_remote::transport::frame::{Message, RecordMessage, decode_message, encode_control, encode_record};
use mixdog_remote::transport::path::{PathMonitor, RttEstimate, Stall};
use mixdog_remote::transport::receiver::{AcceptResult, Receiver, initial_rtt_estimate};
use mixdog_remote::transport::sender::{Admission, Sender};
use mixdog_remote::transport::split::{Assembly, AssemblyPool, MessageAssembler, split_payload};
use mixdog_remote::transport::TransportError;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const VECTORS: &str = include_str!("../../../fixtures/remote-transport/vectors.json");

fn make_box(seq: u64, len: usize, kind: &str) -> Vec<u8> {
    let mut out = vec![0u8; len];
    out[..4].copy_from_slice(&[0x4d, 0x58, if kind == "MXE" { 0x45 } else { 0x43 }, 0x01]);
    out[4..12].copy_from_slice(&seq.to_be_bytes());
    for (i, byte) in out.iter_mut().enumerate().skip(12) {
        *byte = ((i as u64 * 7 + seq) % 251) as u8;
    }
    out
}

fn digest(bytes: &[u8]) -> Value {
    json!({"len": bytes.len(), "sha": hex(&Sha256::digest(bytes))})
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn err(error: TransportError) -> Value {
    json!({"error": error.to_string()})
}

fn ok<T: Into<Value>>(result: Result<T, TransportError>) -> Value {
    result.map_or_else(err, Into::into)
}

fn described(message: &Message) -> Value {
    match message {
        Message::Record(RecordMessage::App { sequence, box_bytes }) => json!({"kind": "app", "sequence": sequence, "len": box_bytes.len()}),
        Message::Record(RecordMessage::Chunk { sequence, index, count, total, data }) => {
            json!({"kind": "chunk", "sequence": sequence, "index": index, "count": count, "total": total, "len": data.len()})
        }
        Message::Control { box_bytes } => json!({"kind": "control", "len": box_bytes.len()}),
    }
}

fn forged_chunk(seq: u64, index: u32, count: u32, total: u32, data_len: usize) -> Vec<u8> {
    let mut out = vec![0u8; CHUNK_HEADER_BYTES + data_len];
    out[..5].copy_from_slice(&[0x4d, 0x58, 0x54, 0x01, 2]);
    out[5..13].copy_from_slice(&seq.to_be_bytes());
    out[13..17].copy_from_slice(&index.to_be_bytes());
    out[17..21].copy_from_slice(&count.to_be_bytes());
    out[21..25].copy_from_slice(&total.to_be_bytes());
    out
}

fn record_of(message: Message) -> RecordMessage {
    match message {
        Message::Record(record) => record,
        Message::Control { .. } => panic!("a record was expected"),
    }
}

/// Numbers compare as doubles: the recorder's JSON does not distinguish 100 from 100.0.
fn norm(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(norm).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn u(op: &Value, key: &str) -> u64 {
    op[key].as_u64().unwrap_or_else(|| panic!("{key} in {op}"))
}

fn s<'a>(op: &'a Value, key: &str) -> &'a str {
    op[key].as_str().unwrap_or_else(|| panic!("{key} in {op}"))
}

fn ranges_of(op: &Value) -> Vec<(u64, u64)> {
    op["ranges"].as_array().unwrap().iter().map(|r| (r[0].as_u64().unwrap(), r[1].as_u64().unwrap())).collect()
}

fn stall_name(stall: Option<Stall>) -> Value {
    match stall {
        None => Value::Null,
        Some(Stall::Silent) => json!("silent"),
        Some(Stall::NoProgress) => json!("no-progress"),
    }
}

#[derive(Default)]
struct World {
    senders: HashMap<String, Sender>,
    receivers: HashMap<String, Receiver>,
    monitors: HashMap<String, PathMonitor>,
    assemblers: HashMap<String, MessageAssembler>,
    pools: HashMap<String, AssemblyPool>,
    splits: HashMap<String, Vec<String>>,
}

impl World {
    fn control(&self, op: &Value, text: String) -> Result<Control, TransportError> {
        let value: Value = serde_json::from_str(&text).unwrap();
        Ok(read_control(&value, u(op, "cseq"), false)?.expect("fresh control"))
    }

    fn run(&mut self, op: &Value) -> Value {
        let n = op["n"].as_str().unwrap_or_default().to_owned();
        let charges = [0usize, 10, 70000, 2000000].map(record_charge);
        let fits = [None, None, Some(1000.0), Some(65466.0), Some(70000.0), Some(f64::INFINITY)].map(carrier_fits);
        match s(op, "op") {
            "consts" => json!({
                "maxMessage": MAX_MESSAGE_BYTES, "chunk": CHUNK_BYTES, "chunkHeader": CHUNK_HEADER_BYTES,
                "maxRecord": MAX_RECORD_BYTES, "inFlight": MAX_RECORDS_IN_FLIGHT, "headReserve": HEAD_RESERVE_BYTES,
                "futureBudget": FUTURE_BUDGET_BYTES, "receiveBudget": RECEIVE_BUDGET_BYTES,
                "bulk": BULK_OUTSTANDING_BYTES, "mediaRecord": MEDIA_RECORD_MAX_BYTES,
                "mediaChunkChars": MEDIA_CHUNK_MAX_CHARS, "controlPlaintext": MAX_CONTROL_PLAINTEXT_BYTES,
                "ackRanges": MAX_ACK_RANGES, "fragment": FRAGMENT_BYTES, "maxFragments": MAX_FRAGMENTS,
                "assemblyPool": ASSEMBLY_POOL_BYTES,
                "charge": charges,
                "fits": fits,
            }),
            "encode_record" => ok(encode_record(&make_box(u(op, "seq"), u(op, "len") as usize, "MXE"))
                .map(|messages| Value::Array(messages.iter().map(|m| digest(m)).collect()))),
            "decode_record" => {
                let messages = encode_record(&make_box(u(op, "seq"), u(op, "len") as usize, "MXE")).unwrap();
                ok(decode_message(&messages[u(op, "index") as usize]).map(|m| described(&m)))
            }
            "decode_raw" => ok(decode_message(&unhex(s(op, "hex"))).map(|m| described(&m))),
            "decode_forged" => {
                let message = forged_chunk(u(op, "seq"), u(op, "index") as u32, u(op, "count") as u32, u(op, "total") as u32, u(op, "dataLen") as usize);
                ok(decode_message(&message).map(|m| described(&m)))
            }
            "encode_control" => ok(encode_control(&make_box(1, u(op, "len") as usize, "MXC")).map(|m| digest(&m))),
            "encode_control_app_box" => ok(encode_control(&make_box(1, 100, "MXE")).map(|m| digest(&m))),
            "read_control" => {
                let value: Value = op["value"].clone();
                match read_control(&value, u(op, "cseq"), false) {
                    Err(error) => err(error),
                    Ok(None) => Value::Null,
                    Ok(Some(Control::Ack(a))) => json!({"t": "ack", "through": a.message().through, "ranges": a.message().ranges.iter().map(|(x, y)| json!([x, y])).collect::<Vec<_>>()}),
                    Ok(Some(Control::Repair(r))) => json!({"t": "repair", "sequences": r.message().sequences}),
                    Ok(Some(Control::Ping(p))) => {
                        json!({"t": if p.message().pong { "pong" } else { "ping" }, "id": p.message().id, "sent": p.message().sent})
                    }
                    Ok(Some(Control::Signal(_))) => panic!("no signals recorded"),
                }
            }
            "read_control_stale" => {
                assert!(read_control(&json!({"v": 1, "t": "ack", "through": 1}), 1, true).unwrap().is_none());
                Value::Null
            }
            "control_json" => json!([
                ack_json(7, &[]), ack_json(7, &[(9, 10), (12, 12)]), repair_json(&[3, 4]), ping_json(5, None), ping_json(5, Some(9)), pong_json(5)
            ]),

            "new_receiver" => {
                self.receivers.insert(n, Receiver::new());
                Value::Null
            }
            "r_accept" => {
                let messages = encode_record(&make_box(u(op, "seq"), u(op, "len") as usize, "MXE")).unwrap();
                let record = record_of(decode_message(&messages[u(op, "index") as usize]).unwrap());
                accept_name(self.receivers.get_mut(&n).unwrap().accept(&record, u(op, "now")))
            }
            "r_accept_forged" => {
                let (count, total, data_len) = (u(op, "count") as u32, u(op, "total") as u32, u(op, "dataLen") as usize);
                let mut message = forged_chunk(u(op, "seq"), u(op, "index") as u32, count, total, data_len);
                let fill = op["fill"].as_u64().unwrap_or(0xaa) as u8;
                message[CHUNK_HEADER_BYTES..].fill(fill);
                if let Some(header) = op["headerSeq"].as_u64() {
                    message[CHUNK_HEADER_BYTES..CHUNK_HEADER_BYTES + 4].copy_from_slice(&[0x4d, 0x58, 0x45, 0x01]);
                    message[CHUNK_HEADER_BYTES + 4..CHUNK_HEADER_BYTES + 12].copy_from_slice(&header.to_be_bytes());
                }
                match decode_message(&message) {
                    Ok(decoded) => accept_name(self.receivers.get_mut(&n).unwrap().accept(&record_of(decoded), u(op, "now"))),
                    Err(error) => err(error),
                }
            }
            "r_next" => match self.receivers[&n].next() {
                None => Value::Null,
                Some((sequence, bytes)) => {
                    let mut value = digest(bytes);
                    value["sequence"] = json!(sequence);
                    value
                }
            },
            "r_commit" => ok(self.receivers.get_mut(&n).unwrap().commit(u(op, "seq"), u(op, "now")).map(|()| Value::Null)),
            "r_discard" => {
                self.receivers.get_mut(&n).unwrap().discard(u(op, "seq"));
                Value::Null
            }
            "r_stats" => {
                let t = self.receivers[&n].stats();
                json!({"deliveredThrough": t.delivered_through, "bufferedRecords": t.buffered_records, "bufferedBytes": t.buffered_bytes,
                    "headBytes": t.head_bytes, "futureBytes": t.future_bytes, "duplicates": t.duplicates, "discarded": t.discarded, "evicted": t.evicted})
            }
            "r_ack_due" => match self.receivers[&n].ack_due(u(op, "now")) {
                None => Value::Null,
                Some(due) => json!({"through": due.through, "ranges": due.ranges.iter().map(|(x, y)| json!([x, y])).collect::<Vec<_>>()}),
            },
            "r_ack_sent" => {
                self.receivers.get_mut(&n).unwrap().ack_sent(u(op, "through"));
                Value::Null
            }
            "r_repair_due" => {
                let receiver = self.receivers.get_mut(&n).unwrap();
                let now = u(op, "now");
                let due = match op["rtt"].as_str() {
                    Some(name) => receiver.repair_due(now, &self.monitors[name] as &dyn RttEstimate),
                    None => receiver.repair_due(now, &initial_rtt_estimate()),
                };
                json!(due)
            }
            "r_probe" => {
                self.receivers.get_mut(&n).unwrap().probe(u(op, "sent"), u(op, "now"));
                Value::Null
            }
            "r_sweep" => {
                let receiver = self.receivers.get_mut(&n).unwrap();
                let now = u(op, "now");
                json!(match op["idle"].as_f64() {
                    Some(idle) => receiver.sweep(now, idle),
                    None => receiver.sweep_default(now),
                })
            }
            "r_carrier_changed" => {
                self.receivers.get_mut(&n).unwrap().carrier_changed(u(op, "now"));
                Value::Null
            }

            "new_sender" => {
                self.senders.insert(n, Sender::new());
                Value::Null
            }
            "s_push" => {
                let stream = op["stream"].as_str();
                let admission = Admission { stream, buffered_amount: 0 };
                ok(self.senders.get_mut(&n).unwrap().push(make_box(u(op, "seq"), u(op, "len") as usize, "MXE"), &admission))
            }
            "s_due" => {
                let budget = op["budget"].as_f64().unwrap_or(f64::INFINITY);
                json!(self.senders[&n].due(u(op, "now"), budget).iter().map(|d| d.sequence).collect::<Vec<_>>())
            }
            "s_mark_sent" => {
                self.senders.get_mut(&n).unwrap().mark_sent(u(op, "seq"), s(op, "carrier"), u(op, "now"));
                Value::Null
            }
            "s_ack" | "d_ack" => {
                let text = ack_json(u(op, "through"), &ranges_of(op));
                match self.control(op, text) {
                    Ok(Control::Ack(ack)) => ok(self.senders.get_mut(&n).unwrap().acknowledge(&ack, u(op, "now")).map(|released| released as u64)),
                    Ok(_) => panic!("an ack"),
                    Err(error) => err(error),
                }
            }
            "s_repair" => {
                let sequences: Vec<u64> = op["sequences"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
                match self.control(op, repair_json(&sequences)) {
                    Ok(Control::Repair(repair)) => json!(self.senders.get_mut(&n).unwrap().repair(&repair)),
                    Ok(_) => panic!("a repair"),
                    Err(error) => err(error),
                }
            }
            "s_carrier_failed" => json!(self.senders.get_mut(&n).unwrap().carrier_failed(s(op, "carrier"), u(op, "now"), op["hold"].as_f64().unwrap())),
            "s_stats" => {
                let t = self.senders[&n].stats();
                json!({"nextSequence": t.next_sequence, "ackedThrough": t.acked_through, "retainedRecords": t.retained_records,
                    "outstandingBytes": t.outstanding_bytes, "bulkBytes": t.bulk_bytes, "retransmits": t.retransmits})
            }
            "s_can_admit" => json!(self.senders[&n].can_admit(&Admission { stream: op["stream"].as_str(), buffered_amount: u(op, "buffered") as usize })),
            "s_probe_due" => json!(self.senders.get_mut(&n).unwrap().probe_due(u(op, "now"), op["pto"].as_f64().unwrap())),
            "s_probe_through" => json!(self.senders[&n].probe_through(s(op, "carrier"), u(op, "buffered") as usize)),
            "s_expired" => json!(self.senders[&n].expired(u(op, "now"))),

            "new_monitor" => {
                self.monitors.insert(n, PathMonitor::new(u(op, "now")));
                Value::Null
            }
            "m_values" => {
                let m = &self.monitors[&n];
                json!({"pto": m.pto_ms(), "lossDelay": m.loss_delay_ms(), "idle": m.idle_timeout_ms(), "smoothed": m.smoothed_rtt_ms()})
            }
            "m_rtt_sample" => self.monitor_call(&n, op, |m, a| m.rtt_sample(a[0] as f64)),
            "m_inbound" => self.monitor_call(&n, op, |m, a| m.inbound(a[0])),
            "m_ack_advanced" => self.monitor_call(&n, op, |m, a| m.ack_advanced(a[0])),
            "m_buffered" => self.monitor_call(&n, op, |m, a| m.buffered(a[0] as usize, a[1])),
            "m_reset" => self.monitor_call(&n, op, |m, a| m.reset(a[0])),
            "m_outstanding" => self.monitor_call(&n, op, |m, a| m.outstanding(a[0] as usize, a[1])),
            "m_stalled" => {
                let args = args_of(op);
                stall_name(self.monitors.get_mut(&n).unwrap().stalled(args[0], args[1] as usize))
            }

            "split" => {
                let (len, id) = (u(op, "len") as usize, u(op, "id"));
                let text = format!("{{\"k\":\"{}\"}}", "a".repeat(len - 8));
                match split_payload(&text, id) {
                    Ok(payloads) => {
                        let value = Value::Array(payloads.iter().map(|p| digest(p.as_bytes())).collect());
                        self.splits.insert(s(op, "name").to_owned(), payloads);
                        value
                    }
                    Err(error) => err(error),
                }
            }
            "split_limit" => {
                split_payload("{\"k\":\"aa\"}", 1).unwrap();
                json!(MAX_APPLICATION_MESSAGE_BYTES)
            }
            "new_pool" => {
                self.pools.insert(s(op, "p").to_owned(), AssemblyPool::new(u(op, "capacity") as usize));
                Value::Null
            }
            "a_new" => {
                let pool = op["pool"].as_str().map_or_else(|| AssemblyPool::new(ASSEMBLY_POOL_BYTES), |name| self.pools[name].clone());
                self.assemblers.insert(n, MessageAssembler::new(pool));
                Value::Null
            }
            "a_accept" => {
                let payload = self.splits[s(op, "split")][u(op, "index") as usize].clone();
                assembly(self.assemblers.get_mut(&n).unwrap().accept(payload.as_bytes(), u(op, "now")))
            }
            "a_all" => {
                let payloads = self.splits[s(op, "split")].clone();
                let assembler = self.assemblers.get_mut(&n).unwrap();
                let mut last = None;
                for (i, payload) in payloads.iter().enumerate() {
                    last = Some(assembler.accept(payload.as_bytes(), u(op, "now") + i as u64));
                }
                assembly(last.unwrap())
            }
            "a_state" => {
                let a = &self.assemblers[&n];
                let mut all = serde_json::Map::new();
                all.insert("pending".into(), json!(a.pending_bytes()));
                all.insert("reserved".into(), json!(a.reserved_bytes()));
                all.insert("stalled".into(), json!(a.stalled(10 + 60000)));
                all.insert("idle".into(), json!(a.stalled(12 + 59999)));
                // Only the keys this recorded step reports.
                let wanted: Vec<&String> = op["result"].as_object().unwrap().keys().collect();
                Value::Object(all.into_iter().filter(|(k, _)| wanted.contains(&k)).collect())
            }
            "a_close" => {
                self.assemblers.get_mut(&n).unwrap().close();
                Value::Null
            }
            "pool_used" => json!(self.pools[s(op, "p")].used_bytes()),
            other => panic!("unknown operation {other}"),
        }
    }

    fn monitor_call(&mut self, name: &str, op: &Value, call: impl FnOnce(&mut PathMonitor, &[u64])) -> Value {
        call(self.monitors.get_mut(name).unwrap(), &args_of(op));
        Value::Null
    }
}

fn args_of(op: &Value) -> Vec<u64> {
    op["args"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as u64).collect()
}

fn accept_name(result: AcceptResult) -> Value {
    json!(match result {
        AcceptResult::Buffered => "buffered",
        AcceptResult::Duplicate => "duplicate",
        AcceptResult::OutOfWindow => "out-of-window",
        AcceptResult::OverMemory => "over-memory",
        AcceptResult::Mismatch => "mismatch",
    })
}

fn assembly(result: Result<Assembly, TransportError>) -> Value {
    match result {
        Err(error) => err(error),
        Ok(Assembly::Partial) => json!({"state": "partial"}),
        Ok(Assembly::Wait) => json!({"state": "wait"}),
        Ok(Assembly::Complete(bytes)) => {
            let mut value = digest(&bytes);
            value["state"] = json!("complete");
            value
        }
    }
}

#[test]
fn the_stream_core_reproduces_every_recorded_operation() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    let ops = vectors["ops"].as_array().unwrap();
    assert!(ops.len() > 700, "{} operations", ops.len());
    let mut world = World::default();
    let mut failures = Vec::new();
    for (index, op) in ops.iter().enumerate() {
        let got = world.run(op);
        if norm(&got) != norm(&op["result"]) {
            failures.push(format!("#{index} {}: expected {} got {}", op["op"], op["result"], got));
        }
    }
    assert!(failures.is_empty(), "{} of {} operations differ:\n{}", failures.len(), ops.len(), failures.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
}
