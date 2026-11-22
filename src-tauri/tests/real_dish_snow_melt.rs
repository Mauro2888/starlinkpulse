//! Manual, real-dish validation of the write-request encoding (ADR-006 exception approved
//! for this single case): set snow-melt to the value that is ALREADY configured.
//!
//! Never part of a normal `cargo test` run. To run it, explicitly:
//!
//! ```sh
//! STARLINKPULSE_ALLOW_REAL_WRITE=1 cargo test --test real_dish_snow_melt -- --ignored --nocapture
//! ```
//!
//! Steps: read `dish_get_config` -> write the identical snow-melt mode -> read again ->
//! verify the whole config is unchanged; if the snow-melt mode differs, restore it at once.
//! `PermissionDenied` is a documented outcome on recent firmware (docs/compatibility.md):
//! the test then verifies the config is unchanged and passes.
//! No other write (reboot, stow, other config fields) is ever sent.

use std::time::Duration;

use starlinkpulse_lib::dish::grpc::GrpcClient;
use starlinkpulse_lib::dish::{StarlinkClient, WriteAction};
use starlinkpulse_lib::error::ClientError;

#[tokio::test]
#[ignore = "sends an idempotent dish_set_config to the REAL dish; run manually only"]
async fn snow_melt_idempotent_roundtrip() {
    if std::env::var("STARLINKPULSE_ALLOW_REAL_WRITE").as_deref() != Ok("1") {
        eprintln!("skipped: set STARLINKPULSE_ALLOW_REAL_WRITE=1 to run against the real dish");
        return;
    }
    let addr = std::env::var("STARLINKPULSE_DISH").unwrap_or_else(|_| "192.168.100.1:9200".into());
    let client = GrpcClient::connect(&addr, None, "dish", Duration::from_secs(5))
        .await
        .expect("dish reachable");

    let (cfg_before, before) = client.get_dish_config().await.expect("read config");
    let before = before.expect("snow-melt mode recognized; refusing to write an unknown value");
    println!("before: snowMeltMode={before:?}");

    let denied = match client.write(WriteAction::SetSnowMelt(before)).await {
        Ok(()) => false,
        Err(ClientError::PermissionDenied) => {
            println!("write: PermissionDenied (firmware blocks local writes; documented outcome)");
            true
        }
        Err(e) => panic!("unexpected write error: {e}"),
    };

    tokio::time::sleep(Duration::from_secs(1)).await;
    let (cfg_after, after) = client.get_dish_config().await.expect("re-read config");
    println!("after:  snowMeltMode={after:?}");

    if after != Some(before) {
        eprintln!("snow-melt changed unexpectedly, restoring {before:?}");
        client
            .write(WriteAction::SetSnowMelt(before))
            .await
            .expect("restore");
        panic!("snow-melt mode changed: {before:?} -> {after:?} (restored)");
    }
    assert_eq!(cfg_before, cfg_after, "dish config changed");
    if denied {
        println!("OK: write rejected with PermissionDenied, config unchanged");
    } else {
        println!("OK: request accepted, config unchanged");
    }
}
