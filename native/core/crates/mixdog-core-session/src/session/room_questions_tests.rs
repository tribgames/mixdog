//! A room member's handed-off questions as its room reads them (`member_handoff_questions`), and
//! the republish of the room when they move (`SessionDeps.room_members`, Node `noteMemberRows`).

use std::sync::Arc;

use mixdog_app_protocol::v2::thread::ThreadApprovals;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::room_member_session_id;
use mixdog_core_ports::ports::threads::Section;
use mixdog_store::schema::record::Header;
use serde_json::json;

use super::SessionDirectory;
use super::testing::Rig;
use super::testing::lock;
use super::tests::eventually_on;

/// A room member's requests show on its room's log (P §8.3): its surface is the log, so a client
/// on the log receives the member's server requests and its response decides them in the member's
/// thread. Any other thread keeps its own surface.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_room_members_requests_surface_on_its_room_log() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let mut header = Header::new();
    header.insert("createdAt".into(), json!(1));
    header.insert("updatedAt".into(), json!(1));
    let member = ThreadId::from(room_member_session_id("room01", "gh").expect("member id"));
    directory.create_with_id(member.clone(), header.clone(), json!({})).await.expect("member");
    let handle = directory.handle(&member).expect("loaded");
    assert_eq!(handle.lineage().surface.as_str(), "sess_room_room01");
    assert!(handle.lineage().chain.is_empty());
    let plain = ThreadId::from("sess_plain".to_owned());
    directory.create_with_id(plain.clone(), header, json!({})).await.expect("plain");
    assert_eq!(directory.handle(&plain).expect("loaded").lineage().surface, plain);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_members_questions_are_read_and_their_moves_republish_its_room() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let member = ThreadId::from(room_member_session_id("room01", "gh").expect("member id"));
    let mut header = Header::new();
    header.insert("createdAt".into(), json!(1));
    header.insert("updatedAt".into(), json!(1));
    directory.create_with_id(member.clone(), header, json!({})).await.expect("member");
    let handle = directory.handle(&member).expect("loaded");
    assert!(directory.member_handoff_questions(&member).is_empty());

    let asked = vec![json!({ "id": "q1", "kind": "question" })];
    handle.set_section(Section::Approvals(ThreadApprovals { handoff_questions: Some(asked.clone()), ..ThreadApprovals::default() })).await.expect("published");
    eventually_on(&[&handle.cell.stepped, &rig.room_members.changed], || (directory.member_handoff_questions(&member) == asked).then_some(())).await;
    eventually_on(&[&rig.room_members.changed], || (lock(&rig.room_members.moved).as_slice() == ["room01"]).then_some(())).await;

    // The same list again moves nothing; an emptied one does.
    handle.set_section(Section::Approvals(ThreadApprovals { handoff_questions: Some(asked), ..ThreadApprovals::default() })).await.expect("published");
    handle.set_section(Section::Approvals(ThreadApprovals { handoff_questions: Some(Vec::new()), ..ThreadApprovals::default() })).await.expect("published");
    eventually_on(&[&rig.room_members.changed], || (lock(&rig.room_members.moved).len() == 2).then_some(())).await;
    assert!(directory.member_handoff_questions(&member).is_empty());
    assert_eq!(*lock(&rig.room_members.moved), ["room01", "room01"]);
}
