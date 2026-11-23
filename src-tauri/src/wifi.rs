//! Starlink router clients for the live UI (`get_wifi_devices`) and an anonymized summary
//! for the support report.
//!
//! Direction: the router's `rxStats` are bytes it received from the device (= device
//! upload); `txStats` are bytes it sent to the device (= device download).

use crate::dish::WifiClientInfo;
use crate::models::{WifiBand, WifiDevice, WifiQuality};

pub const GOOD_DBM: f64 = -65.0;
pub const FAIR_DBM: f64 = crate::rules::WIFI_WARN_DBM;

pub fn band(iface: Option<&str>) -> WifiBand {
    match iface {
        Some(i) if i.starts_with("ETH") => WifiBand::Ethernet,
        Some(i) if i.starts_with("RF_2") => WifiBand::Ghz2_4,
        Some(i) if i.starts_with("RF_5") => WifiBand::Ghz5,
        Some(i) if i.starts_with("RF_6") => WifiBand::Ghz6,
        _ => WifiBand::Unknown,
    }
}

pub fn quality(signal_dbm: Option<f64>) -> Option<WifiQuality> {
    signal_dbm.map(|s| {
        if s >= GOOD_DBM {
            WifiQuality::Good
        } else if s >= FAIR_DBM {
            WifiQuality::Fair
        } else {
            WifiQuality::Poor
        }
    })
}

fn is_controller(c: &WifiClientInfo) -> bool {
    c.role.as_deref() == Some("CONTROLLER")
}

/// Devices for the live UI (router itself excluded), poor signal first, then by download.
pub fn devices(clients: &[WifiClientInfo]) -> Vec<WifiDevice> {
    let mut out: Vec<WifiDevice> = clients
        .iter()
        .filter(|c| !is_controller(c))
        .map(|c| WifiDevice {
            name: c.name.as_ref().map(|n| n.0.clone()),
            band: band(c.iface.as_deref()),
            role: c.role.clone(),
            signal_dbm: c.signal_strength_dbm,
            snr: c.snr,
            quality: quality(c.signal_strength_dbm),
            link_down_mbps: c.tx_rate_mbps,
            link_up_mbps: c.rx_rate_mbps,
            down_mbps: c.tx_throughput_mbps,
            up_mbps: c.rx_throughput_mbps,
            down_bytes: c.tx_bytes,
            up_bytes: c.rx_bytes,
            connected_s: c.associated_time_s,
        })
        .collect();
    out.sort_by(|a, b| {
        let poor = |d: &WifiDevice| d.quality != Some(WifiQuality::Poor);
        poor(a).cmp(&poor(b)).then_with(|| {
            b.down_mbps
                .unwrap_or(-1.0)
                .total_cmp(&a.down_mbps.unwrap_or(-1.0))
        })
    });
    out
}

/// Anonymized counts (no names): devices per band and per signal quality.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct WifiSummary {
    pub total: u32,
    pub ghz2_4: u32,
    pub ghz5: u32,
    pub ghz6: u32,
    pub ethernet: u32,
    pub other: u32,
    pub good: u32,
    pub fair: u32,
    pub poor: u32,
    pub weakest_dbm: Option<f64>,
}

pub fn summary(clients: &[WifiClientInfo]) -> WifiSummary {
    let mut s = WifiSummary::default();
    for d in devices(clients) {
        s.total += 1;
        match d.band {
            WifiBand::Ghz2_4 => s.ghz2_4 += 1,
            WifiBand::Ghz5 => s.ghz5 += 1,
            WifiBand::Ghz6 => s.ghz6 += 1,
            WifiBand::Ethernet => s.ethernet += 1,
            WifiBand::Unknown => s.other += 1,
        }
        if d.role.as_deref().is_some_and(|r| r != "CLIENT") {
            continue;
        }
        match d.quality {
            Some(WifiQuality::Good) => s.good += 1,
            Some(WifiQuality::Fair) => s.fair += 1,
            Some(WifiQuality::Poor) => s.poor += 1,
            None => {}
        }
    }
    s.weakest_dbm = crate::dish::weakest_signal_dbm(clients);
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dish::DeviceName;

    fn client(name: &str, iface: &str, dbm: Option<f64>, down: Option<f64>) -> WifiClientInfo {
        WifiClientInfo {
            name: Some(DeviceName(name.into())),
            iface: Some(iface.into()),
            role: Some("CLIENT".into()),
            signal_strength_dbm: dbm,
            rx_rate_mbps: Some(100.0),
            tx_rate_mbps: Some(200.0),
            rx_bytes: Some(10),
            tx_bytes: Some(20),
            rx_throughput_mbps: Some(1.0),
            tx_throughput_mbps: down,
            ..Default::default()
        }
    }

    #[test]
    fn summary_excludes_repeaters_from_quality() {
        let mut rep = client("r", "RF_5GHZ", Some(-85.0), None);
        rep.role = Some("REPEATER".into());
        let s = summary(&[rep, client("a", "RF_5GHZ", Some(-70.0), None)]);
        assert_eq!((s.good, s.fair, s.poor), (0, 1, 0));
        assert_eq!(s.weakest_dbm, Some(-70.0));
    }

    #[test]
    fn mapping_quality_and_order() {
        let clients = vec![
            WifiClientInfo {
                iface: Some("ETH".into()),
                role: Some("CONTROLLER".into()),
                ..Default::default()
            },
            client("a", "RF_5GHZ", Some(-50.0), Some(5.0)),
            client("b", "RF_2GHZ", Some(-80.0), Some(1.0)),
            client("c", "ETH", None, Some(50.0)),
            client("d", "RF_5GHZ", Some(-70.0), Some(9.0)),
            client("e", "RF_2GHZ", Some(-90.0), Some(3.0)),
            client("f", "RF_6GHZ", Some(-65.0), None),
        ];
        let d = devices(&clients);
        let names: Vec<_> = d.iter().map(|x| x.name.as_deref().unwrap()).collect();
        assert_eq!(names, ["e", "b", "c", "d", "a", "f"]);
        assert_eq!(d[0].quality, Some(WifiQuality::Poor));
        assert_eq!(d[2].band, WifiBand::Ethernet);
        assert_eq!(d[2].quality, None);
        assert_eq!(d[3].quality, Some(WifiQuality::Fair));
        assert_eq!(d[5].quality, Some(WifiQuality::Good));
        assert_eq!(d[5].band, WifiBand::Ghz6);
        // rx = device upload, tx = device download.
        assert_eq!((d[4].up_bytes, d[4].down_bytes), (Some(10), Some(20)));
        assert_eq!(
            (d[4].link_up_mbps, d[4].link_down_mbps),
            (Some(100.0), Some(200.0))
        );
        let v = serde_json::to_value(&d[0]).unwrap();
        assert_eq!(v["band"], "2.4ghz");
        assert_eq!(v["quality"], "poor");
        assert!(v.get("signalDbm").is_some() && v.get("connectedS").is_some());

        let s = summary(&clients);
        assert_eq!(
            (s.total, s.ghz2_4, s.ghz5, s.ghz6, s.ethernet),
            (6, 2, 2, 1, 1)
        );
        assert_eq!((s.good, s.fair, s.poor), (2, 1, 2));
        assert_eq!(s.weakest_dbm, Some(-90.0));
        assert!(!format!("{s:?}").contains("\"a\""));
    }
}
