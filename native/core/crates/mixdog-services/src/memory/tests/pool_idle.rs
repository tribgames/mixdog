//! A pool gives back the connections nobody used: their backends end, and the next query opens a connection again.

use std::time::{Duration, Instant};

use crate::memory::pg::db::Schema;
use crate::memory::tests::support::TestPg;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn connections_nobody_used_are_closed_with_their_backends_and_the_next_query_opens_one() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    let held = futures::future::join_all((0..3).map(|_| db.client())).await;
    assert!(held.iter().all(Result::is_ok));
    drop(held);
    assert_eq!(db.open_connections(), 3);
    let warm = Instant::now();
    db.query("SELECT 1", &[]).await.expect("a query on a held connection");
    let warm = warm.elapsed();
    // Queries one after another use one connection: the other two are left alone and reach the limit.
    std::thread::sleep(Duration::from_millis(300));
    for _ in 0..4 {
        db.query("SELECT 1", &[]).await.expect("a repeated query");
    }
    assert_eq!(db.close_idle(Duration::from_millis(250)), 2, "the connections a repeated query did not take are idle");
    assert_eq!(db.open_connections(), 1);
    drop(futures::future::join_all((0..3).map(|_| db.client())).await);
    assert_eq!(db.open_connections(), 3);

    assert_eq!(db.close_idle(Duration::from_secs(3600)), 0, "a connection used within the limit stays");
    assert_eq!(db.close_idle(Duration::ZERO), 3);
    assert_eq!(db.open_connections(), 0);

    let cold = Instant::now();
    db.query("SELECT 1", &[]).await.expect("the next query opens a connection");
    let cold = cold.elapsed();
    println!("first query after idle: {cold:?} (on a held connection: {warm:?})");
    assert_eq!(db.open_connections(), 1);
    // The closed connections' backends exit by themselves: only this pool's one connection is left in the database.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let backends: i64 = db.query("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()", &[]).await.expect("activity")[0].get(0);
        if backends == 1 {
            break;
        }
        assert!(Instant::now() < deadline, "{backends} backends are still connected to the database");
        tokio::task::yield_now().await;
    }
}
