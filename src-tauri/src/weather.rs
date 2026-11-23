//! Optional weather correlation via Open-Meteo (no API key). The user-picked place and its
//! coordinates are never logged; nothing is requested while no place is configured.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use reqwest::Url;
use serde_json::Value;

use crate::ai::http::{BodyError, MAX_BODY_BYTES, client_builder, read_capped};
use crate::error::AppError;
use crate::i18n::Lang;
use crate::models::{WeatherLocation, WeatherPlace, WeatherPoint, WeatherSeries};
use crate::time::now_ms;

const GEOCODING_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const HOUR_MS: i64 = 3_600_000;
const MAX_RANGE_MIN: u32 = 2880;

type CacheKey = (i32, i32);
type Cache = Mutex<HashMap<CacheKey, (Instant, Vec<WeatherPoint>)>>;
static CACHE: LazyLock<Cache> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Rounds to 2 decimals (~1 km).
pub fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn key(lat: f64, lon: f64) -> CacheKey {
    ((lat * 100.0).round() as i32, (lon * 100.0).round() as i32)
}

fn net_err(e: &reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::Client(crate::error::ClientError::Timeout)
    } else {
        AppError::Network("Weather service unreachable".into())
    }
}

async fn fetch_json(url: Url) -> Result<Value, AppError> {
    let client = client_builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|_| AppError::Internal("http client".into()))?;
    let resp = client.get(url).send().await.map_err(|e| net_err(&e))?;
    if !resp.status().is_success() {
        return Err(AppError::Network("Weather service unavailable".into()));
    }
    let body = read_capped(resp, MAX_BODY_BYTES)
        .await
        .map_err(|e| match e {
            BodyError::Timeout => AppError::Client(crate::error::ClientError::Timeout),
            _ => AppError::Network("Weather service unavailable".into()),
        })?;
    serde_json::from_str(&body).map_err(|_| AppError::Network("Unexpected weather response".into()))
}

fn opt_str(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Parses the geocoding response (max 5 places; entries without name/coordinates skipped).
pub fn parse_places(v: &Value) -> Vec<WeatherPlace> {
    v.get("results")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    Some(WeatherPlace {
                        name: opt_str(r, "name")?,
                        admin1: opt_str(r, "admin1"),
                        country: opt_str(r, "country"),
                        latitude: r.get("latitude")?.as_f64()?,
                        longitude: r.get("longitude")?.as_f64()?,
                    })
                })
                .take(5)
                .collect()
        })
        .unwrap_or_default()
}

/// Parses the hourly forecast arrays; missing arrays or nulls become `None`.
pub fn parse_hourly(v: &Value) -> Vec<WeatherPoint> {
    let Some(h) = v.get("hourly") else {
        return Vec::new();
    };
    let Some(times) = h.get("time").and_then(Value::as_array) else {
        return Vec::new();
    };
    let col = |name: &str, i: usize| -> Option<f64> {
        h.get(name)?
            .as_array()?
            .get(i)?
            .as_f64()
            .filter(|x| x.is_finite())
    };
    let mut pts: Vec<WeatherPoint> = times
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let secs = t.as_i64()?;
            Some(WeatherPoint {
                hour_ms: secs.checked_mul(1000)?,
                precipitation_mm: col("precipitation", i),
                snowfall_cm: col("snowfall", i),
                cloud_cover_pct: col("cloud_cover", i),
                wind_kmh: col("wind_speed_10m", i),
            })
        })
        .collect();
    pts.sort_by_key(|p| p.hour_ms);
    pts
}

/// Keeps the hours overlapping `[now - range, now]`.
pub fn filter_range(pts: &[WeatherPoint], now: i64, range_min: u32) -> Vec<WeatherPoint> {
    let from = now - i64::from(range_min) * 60_000;
    pts.iter()
        .filter(|p| p.hour_ms + HOUR_MS > from && p.hour_ms <= now)
        .cloned()
        .collect()
}

fn search_url(base: &str, query: &str, lang: Lang) -> Result<Url, AppError> {
    let mut url = Url::parse(base).map_err(|_| AppError::Internal("weather url".into()))?;
    url.query_pairs_mut()
        .append_pair("name", query)
        .append_pair("count", "5")
        .append_pair("language", lang.code())
        .append_pair("format", "json");
    Ok(url)
}

fn forecast_url(base: &str, lat: f64, lon: f64) -> Result<Url, AppError> {
    let mut url = Url::parse(base).map_err(|_| AppError::Internal("weather url".into()))?;
    url.query_pairs_mut()
        .append_pair("latitude", &format!("{lat:.2}"))
        .append_pair("longitude", &format!("{lon:.2}"))
        .append_pair(
            "hourly",
            "precipitation,snowfall,cloud_cover,wind_speed_10m",
        )
        .append_pair("past_days", "2")
        .append_pair("forecast_days", "1")
        .append_pair("timeformat", "unixtime")
        .append_pair("timezone", "GMT");
    Ok(url)
}

async fn search_at(base: &str, query: &str, lang: Lang) -> Result<Vec<WeatherPlace>, AppError> {
    let q = query.trim();
    if !(2..=100).contains(&q.chars().count()) {
        return Err(AppError::InvalidInput(
            "search text must be 2–100 characters".into(),
        ));
    }
    Ok(parse_places(&fetch_json(search_url(base, q, lang)?).await?))
}

/// Geocoding search in the UI language.
pub async fn search(query: &str, lang: Lang) -> Result<Vec<WeatherPlace>, AppError> {
    search_at(GEOCODING_URL, query, lang).await
}

async fn get_at(
    base: &str,
    cache: &Cache,
    loc: Option<WeatherLocation>,
    range_min: u32,
    now: i64,
) -> Result<WeatherSeries, AppError> {
    if !(1..=MAX_RANGE_MIN).contains(&range_min) {
        return Err(AppError::InvalidInput(
            "rangeMinutes must be between 1 and 2880".into(),
        ));
    }
    let Some(loc) = loc else {
        return Ok(WeatherSeries {
            available: false,
            location_name: None,
            points: Vec::new(),
        });
    };
    let k = key(loc.latitude, loc.longitude);
    let cached = cache
        .lock()
        .ok()
        .and_then(|c| c.get(&k).filter(|(t, _)| t.elapsed() < CACHE_TTL).cloned());
    let all = match cached {
        Some((_, pts)) => pts,
        None => {
            let v = fetch_json(forecast_url(base, loc.latitude, loc.longitude)?).await?;
            let pts = parse_hourly(&v);
            if let Ok(mut c) = cache.lock() {
                c.insert(k, (Instant::now(), pts.clone()));
            }
            pts
        }
    };
    Ok(WeatherSeries {
        available: true,
        location_name: Some(loc.name),
        points: filter_range(&all, now, range_min),
    })
}

/// Weather for the configured place; no network call when none is configured.
pub async fn get(loc: Option<WeatherLocation>, range_min: u32) -> Result<WeatherSeries, AppError> {
    get_at(FORECAST_URL, &CACHE, loc, range_min, now_ms()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::local::tests::server;
    use serde_json::json;

    fn pt(h: i64) -> WeatherPoint {
        WeatherPoint {
            hour_ms: h * HOUR_MS,
            precipitation_mm: None,
            snowfall_cm: None,
            cloud_cover_pct: None,
            wind_kmh: None,
        }
    }

    #[test]
    fn parses_places_defensively() {
        let v = json!({"results":[
            {"name":"Rome","admin1":"Lazio","country":"Italy","latitude":41.9,"longitude":12.5},
            {"name":"NoCoords"},
            {"name":" ","latitude":1.0,"longitude":1.0},
            {"name":"Bare","latitude":1.0,"longitude":2.0}
        ]});
        let p = parse_places(&v);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].admin1.as_deref(), Some("Lazio"));
        assert_eq!(p[1].country, None);
        assert!(parse_places(&json!({})).is_empty());
    }

    #[test]
    fn parses_hourly_with_nulls_and_missing_arrays() {
        let v = json!({"hourly":{
            "time":[7200, 3600, 10800],
            "precipitation":[0.5, null, 1.0],
            "wind_speed_10m":[10.0]
        }});
        let p = parse_hourly(&v);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].hour_ms, 3_600_000);
        assert_eq!(p[0].precipitation_mm, None);
        assert_eq!(p[1].precipitation_mm, Some(0.5));
        assert_eq!(p[0].wind_kmh, None);
        assert_eq!(p[1].wind_kmh, Some(10.0));
        assert_eq!(p[2].snowfall_cm, None);
        assert!(parse_hourly(&json!({"hourly":{}})).is_empty());
        assert!(parse_hourly(&json!(null)).is_empty());
    }

    #[test]
    fn range_filter_overlaps_hours() {
        let pts: Vec<_> = (0..10).map(pt).collect();
        // now = 5h30, range 1h => window 4h30..5h30: hours 4 (ends 5h) and 5.
        let now = 5 * HOUR_MS + 1_800_000;
        let r = filter_range(&pts, now, 60);
        assert_eq!(
            r.iter().map(|p| p.hour_ms / HOUR_MS).collect::<Vec<_>>(),
            vec![4, 5]
        );
        // Future hours are dropped, hour ending exactly at `from` is dropped.
        let r = filter_range(&pts, 5 * HOUR_MS, 60);
        assert_eq!(
            r.iter().map(|p| p.hour_ms / HOUR_MS).collect::<Vec<_>>(),
            vec![4, 5]
        );
    }

    #[test]
    fn rounding_and_urls() {
        assert_eq!(round2(41.90278), 41.9);
        assert_eq!(round2(-12.495), -12.5);
        let u = search_url("https://x.test/v1/search", "San José", Lang::It).unwrap();
        assert!(u.as_str().contains("language=it") && u.as_str().contains("count=5"));
        let f = forecast_url("https://x.test/f", 41.9, 12.5).unwrap();
        assert!(f.as_str().contains("latitude=41.90"));
        assert!(f.as_str().contains("timezone=GMT"));
    }

    #[tokio::test]
    async fn search_validates_and_queries() {
        assert_eq!(
            search("a", Lang::En).await.unwrap_err().kind(),
            "invalid_input"
        );
        assert_eq!(
            search(&"x".repeat(101), Lang::En).await.unwrap_err().kind(),
            "invalid_input"
        );
        let body = json!({"results":[{"name":"Oslo","latitude":59.9,"longitude":10.7}]});
        let (base, seen) = server(vec![(200, body.to_string())]).await;
        let r = search_at(&format!("{base}/v1/search"), " Oslo ", Lang::En)
            .await
            .unwrap();
        assert_eq!(r.len(), 1);
        let req = seen.lock().unwrap()[0].clone();
        assert!(req.starts_with("GET /v1/search?name=Oslo&count=5&language=en&format=json"));

        // Redirects are not followed.
        let (base, seen) = server(vec![(302, String::new()), (200, "{}".into())]).await;
        let e = search_at(&format!("{base}/s"), "Oslo", Lang::En)
            .await
            .unwrap_err();
        assert_eq!(e.kind(), "offline");
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn get_without_location_makes_no_call() {
        let cache = Mutex::new(HashMap::new());
        // Unroutable base: a network attempt would fail.
        let s = get_at("http://127.0.0.1:1/f", &cache, None, 60, 0)
            .await
            .unwrap();
        assert!(!s.available && s.points.is_empty() && s.location_name.is_none());
        let loc = WeatherLocation {
            name: "x".into(),
            latitude: 1.0,
            longitude: 1.0,
        };
        for bad in [0, 2881] {
            let e = get_at("http://127.0.0.1:1/f", &cache, Some(loc.clone()), bad, 0)
                .await
                .unwrap_err();
            assert_eq!(e.kind(), "invalid_input");
        }
    }

    #[tokio::test]
    async fn get_fetches_filters_and_caches() {
        let now = 10 * HOUR_MS + 600_000;
        let times: Vec<i64> = (0..12).map(|h| h * 3600).collect();
        let body = json!({"hourly":{"time":times,"precipitation":vec![0.2; 12]}});
        // Only one response queued: a second network call would fail.
        let (base, seen) = server(vec![(200, body.to_string())]).await;
        let cache = Mutex::new(HashMap::new());
        let loc = WeatherLocation {
            name: "Home".into(),
            latitude: 45.0,
            longitude: 9.0,
        };
        let s = get_at(&base, &cache, Some(loc.clone()), 120, now)
            .await
            .unwrap();
        assert!(s.available);
        assert_eq!(s.location_name.as_deref(), Some("Home"));
        assert_eq!(s.points.len(), 3); // hours 8, 9, 10
        assert_eq!(s.points[2].precipitation_mm, Some(0.2));
        let s2 = get_at(&base, &cache, Some(loc), 1440, now).await.unwrap();
        assert_eq!(s2.points.len(), 11);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn network_errors_map_to_offline() {
        let port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let cache = Mutex::new(HashMap::new());
        let loc = WeatherLocation {
            name: "x".into(),
            latitude: 2.0,
            longitude: 2.0,
        };
        let e = get_at(
            &format!("http://127.0.0.1:{port}/f"),
            &cache,
            Some(loc),
            60,
            0,
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind(), "offline");
    }
}
