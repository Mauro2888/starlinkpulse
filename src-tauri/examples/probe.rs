//! Read-only probe of a real dish/router to validate the reflection-based client.
//!
//! Usage: `cargo run --example probe -- [dish_addr] [router_addr] [cache_dir]`
//!
//! Only read-only requests are sent (reflection, get_device_info, get_status, get_history,
//! dish_get_obstruction_map, wifi_get_clients). Write requests are *built* in memory to check
//! that the schema supports them, but never sent. Output contains no identifiers.

use std::time::Duration;

use starlinkpulse_lib::capabilities::{self, CapabilityInputs, Probe};
use starlinkpulse_lib::dish::grpc::{GrpcClient, build_write_request, message_to_json};
use starlinkpulse_lib::dish::reflection::SchemaCache;
use starlinkpulse_lib::dish::{RouterClient, StarlinkClient, WriteAction, weakest_signal_dbm};
use starlinkpulse_lib::models::SnowMeltMode;
use starlinkpulse_lib::storage::Db;
use starlinkpulse_lib::time::now_ms;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let dish = args.next().unwrap_or_else(|| "192.168.100.1:9200".into());
    let router_addr = args.next().unwrap_or_else(|| "192.168.1.1:9000".into());
    let cache_dir = args.next().unwrap_or_else(|| {
        std::env::temp_dir()
            .join("starlinkpulse-probe")
            .display()
            .to_string()
    });
    let cache = SchemaCache::new(&cache_dir);
    let timeout = Duration::from_secs(5);

    let t = std::time::Instant::now();
    let client = match GrpcClient::connect(&dish, Some(&cache), "dish", timeout).await {
        Ok(c) => c,
        Err(e) => {
            println!("dish: not reachable ({e})");
            return;
        }
    };
    println!("dish: connected + schema in {:?}", t.elapsed());
    let names = client.request_names().unwrap_or_default();
    println!("schema: {} request types", names.len());

    // Write requests: build only, never send.
    for action in [
        WriteAction::Reboot,
        WriteAction::Stow,
        WriteAction::Unstow,
        WriteAction::SetSnowMelt(SnowMeltMode::Auto),
    ] {
        match build_write_request(client.schema(), action) {
            Ok(req) => println!(
                "build-only {action:?}: {}",
                message_to_json(&req)
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            ),
            Err(e) => println!("build-only {action:?}: {e}"),
        }
    }

    match client.get_dish_config().await {
        Ok((_, mode)) => println!("dish_config: snowMeltMode={mode:?}"),
        Err(e) => println!("dish_config: {e}"),
    }

    let info = client.get_device_info().await;
    println!(
        "device_info: hw={:?} sw={:?}",
        info.as_ref().ok().and_then(|i| i.hardware_version.clone()),
        info.as_ref().ok().and_then(|i| i.software_version.clone())
    );

    let status = client.get_status().await;
    match &status {
        Ok(s) => {
            let snap = &s.snapshot;
            println!(
                "status: latency={:?} drop={:?} dl={:?} ul={:?} uptime={:?} actuators={:?} \
                 alignment={} snow_melt_cfg={} obstructed={:?} avg_prolonged={:?} \
                 dl_restricted={:?} alerts={:?}",
                snap.pop_ping_latency_ms,
                snap.pop_ping_drop_rate,
                snap.downlink_bps,
                snap.uplink_bps,
                snap.uptime_s,
                s.actuators,
                s.has_alignment_stats,
                s.snow_melt_configurable,
                snap.obstruction.fraction_obstructed,
                snap.obstruction.avg_prolonged_obstruction_interval_s,
                snap.dl_bandwidth_restricted_reason,
                snap.alerts
            );
        }
        Err(e) => println!("status: error {e}"),
    }

    let history = client.get_history().await;
    let mut has_power = None;
    match &history {
        Ok(h) => {
            has_power = Some(h.has_power());
            println!(
                "history: current={} len={} power={} outages={} events={} other_events={}",
                h.current,
                h.buffer_len(),
                h.has_power(),
                h.outages.len(),
                h.events.len(),
                h.other_events.len()
            );
            if std::env::var_os("PROBE_RAW_EVENTS").is_some() {
                for o in &h.outages {
                    println!(
                        "raw outage: start_ms={} dur={} cause={}",
                        o.start_ms, o.duration_ms, o.cause
                    );
                }
                for e in &h.events {
                    println!(
                        "raw event: start_ms={} dur={} cause={} sev={:?}",
                        e.start_ms, e.duration_ms, e.cause, e.severity
                    );
                }
            }
            let mut db = Db::open_in_memory().expect("db");
            let now = now_ms();
            let r = db.ingest_history(h, now).expect("ingest");
            let pts = db.history(60, now).expect("query");
            println!(
                "ingest: new={} minutes={} last={:?}",
                r.new_samples,
                pts.len(),
                pts.last()
                    .map(|p| (p.latency_avg_ms, p.latency_p95_ms, p.power_avg_w))
            );
            for e in db.events(48 * 60, now).expect("events") {
                println!(
                    "event: {}s ago cause={} dur={}ms sev={:?}",
                    (now - e.start_ms) / 1000,
                    e.cause,
                    e.duration_ms,
                    e.severity
                );
            }
        }
        Err(e) => println!("history: error {e}"),
    }

    let map = client.get_obstruction_map().await;
    match &map {
        Ok(m) => println!(
            "obstruction_map: {}x{} with_data={}",
            m.rows,
            m.cols,
            m.snr.iter().flatten().count()
        ),
        Err(e) => println!("obstruction_map: {e}"),
    }

    let router =
        GrpcClient::connect(&router_addr, Some(&cache), "router", Duration::from_secs(3)).await;
    let router_ok = match &router {
        Ok(r) => match r.wifi_clients().await {
            Ok(clients) => {
                println!(
                    "router: {} clients, weakest={:?} dBm",
                    clients.len(),
                    weakest_signal_dbm(&clients)
                );
                true
            }
            Err(e) => {
                println!("router: wifi_get_clients {e}");
                false
            }
        },
        Err(e) => {
            println!("router: not reachable ({e})");
            false
        }
    };

    let caps = capabilities::detect(&CapabilityInputs {
        status: status.ok(),
        request_names: Some(names),
        history_has_power: has_power,
        obstruction_map: Probe::from_result(&map),
        router_available: router_ok,
        is_mock: false,
    });
    println!(
        "capabilities: {}",
        serde_json::to_string(&caps).unwrap_or_default()
    );
}
