//! Real dish/router client: tonic generic client + `DynamicMessage` codec.
//!
//! Requests are built by field name on the reflected `Request` message (e.g. `get_status`);
//! responses are decoded dynamically and converted to proto3 JSON for the name-based parsers
//! in [`super::json`].

use std::time::Duration;

use async_trait::async_trait;
use prost::Message;
use prost_reflect::{DynamicMessage, Kind, MessageDescriptor, SerializeOptions, Value as PValue};
use serde_json::Value;
use tonic::Status;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::codegen::http::uri::PathAndQuery;
use tonic::transport::{Channel, Endpoint};

use super::json::{self, response_body, strip_pii_except};
use super::reflection::{
    DEVICE_SERVICE, HANDLE_METHOD, ReflectionSchema, SchemaCache, fetch_schema,
};
use super::{
    DeviceInfo, DishHistory, DishStatus, RouterClient, StarlinkClient, WifiClientInfo, WriteAction,
};
use crate::error::ClientError;
use crate::models::{ObstructionMap, RouterStatus, SnowMeltMode};
use crate::time::now_ms;

/// Default per-request timeout (ADR-002).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/// tonic codec that encodes any `DynamicMessage` and decodes into a given descriptor.
#[derive(Debug, Clone)]
pub struct DynamicCodec {
    response: MessageDescriptor,
}

impl DynamicCodec {
    pub fn new(response: MessageDescriptor) -> Self {
        Self { response }
    }
}

#[derive(Debug)]
pub struct DynamicEncoder;

#[derive(Debug)]
pub struct DynamicDecoder {
    desc: MessageDescriptor,
}

impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        item.encode(dst)
            .map_err(|e| Status::internal(format!("encode: {e}")))
    }
}

impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        DynamicMessage::decode(self.desc.clone(), src)
            .map(Some)
            .map_err(|e| Status::internal(format!("decode: {e}")))
    }
}

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder
    }

    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder {
            desc: self.response.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Request construction / response conversion
// ---------------------------------------------------------------------------

/// Message descriptor of the body for the `Request` oneof field `field_name`.
fn request_body_desc(
    schema: &ReflectionSchema,
    field_name: &str,
) -> Result<MessageDescriptor, ClientError> {
    let field = schema
        .request
        .get_field_by_name(field_name)
        .ok_or(ClientError::Unsupported)?;
    match field.kind() {
        Kind::Message(m) => Ok(m),
        _ => Err(ClientError::Schema(format!(
            "`{field_name}` is not a message"
        ))),
    }
}

/// Builds a `Request` with the oneof field `field_name` set to `body` (empty if `None`).
pub fn build_request(
    schema: &ReflectionSchema,
    field_name: &str,
    body: Option<DynamicMessage>,
) -> Result<DynamicMessage, ClientError> {
    let field = schema
        .request
        .get_field_by_name(field_name)
        .ok_or(ClientError::Unsupported)?;
    let body = match body {
        Some(b) => b,
        None => DynamicMessage::new(request_body_desc(schema, field_name)?),
    };
    let mut req = DynamicMessage::new(schema.request.clone());
    req.try_set_field(&field, PValue::Message(body))
        .map_err(|e| ClientError::Schema(e.to_string()))?;
    Ok(req)
}

fn snow_melt_name(mode: SnowMeltMode) -> &'static str {
    match mode {
        SnowMeltMode::Auto => "AUTO",
        SnowMeltMode::AlwaysOn => "ALWAYS_ON",
        SnowMeltMode::AlwaysOff => "ALWAYS_OFF",
    }
}

/// Builds the request for a write action. Returns `Unsupported` when the schema lacks any
/// required field. Never sent to a real dish during development (ADR-006).
pub fn build_write_request(
    schema: &ReflectionSchema,
    action: WriteAction,
) -> Result<DynamicMessage, ClientError> {
    match action {
        WriteAction::Reboot => build_request(schema, "reboot", None),
        WriteAction::Stow | WriteAction::Unstow => {
            let md = request_body_desc(schema, "dish_stow")?;
            let mut body = DynamicMessage::new(md.clone());
            if action == WriteAction::Unstow {
                let f = md
                    .get_field_by_name("unstow")
                    .ok_or(ClientError::Unsupported)?;
                body.set_field(&f, PValue::Bool(true));
            }
            build_request(schema, "dish_stow", Some(body))
        }
        WriteAction::SetSnowMelt(mode) => {
            let md = request_body_desc(schema, "dish_set_config")?;
            let cfg_field = md
                .get_field_by_name("dish_config")
                .or_else(|| {
                    md.fields()
                        .find(|f| matches!(f.kind(), Kind::Message(m) if m.name() == "DishConfig"))
                })
                .ok_or(ClientError::Unsupported)?;
            let Kind::Message(cfg_md) = cfg_field.kind() else {
                return Err(ClientError::Unsupported);
            };
            let mode_field = cfg_md
                .get_field_by_name("snow_melt_mode")
                .ok_or(ClientError::Unsupported)?;
            // Without the `apply_*` flag the dish would overwrite every other config field
            // with defaults, so refuse to build the request at all.
            let apply_field = cfg_md
                .get_field_by_name("apply_snow_melt_mode")
                .ok_or(ClientError::Unsupported)?;
            let Kind::Enum(enum_desc) = mode_field.kind() else {
                return Err(ClientError::Unsupported);
            };
            let wanted = snow_melt_name(mode);
            let suffix = format!("_{wanted}");
            let value = enum_desc
                .values()
                .find(|v| v.name() == wanted || v.name().ends_with(&suffix))
                .ok_or(ClientError::Unsupported)?;
            let mut cfg = DynamicMessage::new(cfg_md.clone());
            cfg.set_field(&mode_field, PValue::EnumNumber(value.number()));
            cfg.set_field(&apply_field, PValue::Bool(true));
            let mut body = DynamicMessage::new(md.clone());
            body.set_field(&cfg_field, PValue::Message(cfg));
            build_request(schema, "dish_set_config", Some(body))
        }
    }
}

/// Converts a decoded response to proto3 JSON (including default-valued scalars, so a
/// field present in the schema but zero shows up as `0`), then strips PII.
pub fn message_to_json(msg: &DynamicMessage) -> Result<Value, ClientError> {
    message_to_json_keeping(msg, &[])
}

fn message_to_json_keeping(msg: &DynamicMessage, keep: &[&str]) -> Result<Value, ClientError> {
    let opts = SerializeOptions::new().skip_default_fields(false);
    let mut v = msg
        .serialize_with_options(serde_json::value::Serializer, &opts)
        .map_err(|e| ClientError::Decode(e.to_string()))?;
    strip_pii_except(&mut v, keep);
    Ok(v)
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// gRPC client for the dish (or the router) using a reflected schema.
#[derive(Debug, Clone)]
pub struct GrpcClient {
    channel: Channel,
    schema: ReflectionSchema,
    timeout: Duration,
}

async fn connect_channel(address: &str, timeout: Duration) -> Result<Channel, ClientError> {
    let uri = if address.starts_with("http://") {
        address.to_string()
    } else {
        format!("http://{address}")
    };
    let endpoint = Endpoint::from_shared(uri)
        .map_err(|_| ClientError::Unreachable("invalid address".into()))?
        .connect_timeout(timeout)
        .timeout(timeout)
        .tcp_nodelay(true);
    match tokio::time::timeout(timeout, endpoint.connect()).await {
        Err(_) => Err(ClientError::Timeout),
        Ok(Err(_)) => Err(ClientError::Unreachable("connection failed".into())),
        Ok(Ok(ch)) => Ok(ch),
    }
}

impl GrpcClient {
    /// Connects to `address` (`host:port`) and loads the schema, from the on-disk cache when
    /// the firmware version matches, otherwise via server reflection.
    pub async fn connect(
        address: &str,
        cache: Option<&SchemaCache>,
        cache_prefix: &str,
        timeout: Duration,
    ) -> Result<Self, ClientError> {
        let channel = connect_channel(address, timeout).await?;

        if let Some((cached_version, bytes)) = cache.and_then(|c| c.load_latest(cache_prefix))
            && let Ok(schema) = ReflectionSchema::from_fds_bytes(&bytes)
        {
            let client = Self {
                channel: channel.clone(),
                schema,
                timeout,
            };
            match client.get_device_info().await {
                Ok(info) if info.software_version.as_deref() == Some(cached_version.as_str()) => {
                    tracing::info!(prefix = cache_prefix, "using cached schema");
                    return Ok(client);
                }
                Ok(_) => {
                    tracing::info!(prefix = cache_prefix, "firmware changed, refreshing schema")
                }
                Err(e) if e.is_connectivity() => return Err(e),
                Err(e) => {
                    tracing::info!(prefix = cache_prefix, error = %e, "cached schema unusable")
                }
            }
        }

        let schema = fetch_schema(channel.clone(), timeout).await?;
        tracing::info!(
            prefix = cache_prefix,
            requests = schema.request_names().len(),
            "schema loaded via reflection"
        );
        let client = Self {
            channel,
            schema,
            timeout,
        };
        if let Some(cache) = cache {
            match client.get_device_info().await {
                Ok(DeviceInfo {
                    software_version: Some(version),
                    ..
                }) => {
                    if let Err(e) = cache.store(cache_prefix, &version, &client.schema.fds_bytes) {
                        tracing::warn!(error = %e, "could not cache schema");
                    }
                }
                Ok(_) => tracing::debug!("no software version, schema not cached"),
                Err(e) => tracing::debug!(error = %e, "device info unavailable, schema not cached"),
            }
        }
        Ok(client)
    }

    pub fn schema(&self) -> &ReflectionSchema {
        &self.schema
    }

    async fn call(&self, request: DynamicMessage) -> Result<Value, ClientError> {
        self.call_keeping(request, &[]).await
    }

    async fn call_keeping(
        &self,
        request: DynamicMessage,
        keep: &[&str],
    ) -> Result<Value, ClientError> {
        let codec = DynamicCodec::new(self.schema.response.clone());
        let path = PathAndQuery::try_from(format!("/{DEVICE_SERVICE}/{HANDLE_METHOD}"))
            .map_err(|e| ClientError::Schema(e.to_string()))?;
        let mut grpc = tonic::client::Grpc::new(self.channel.clone());
        let fut = async move {
            grpc.ready()
                .await
                .map_err(|_| ClientError::Unreachable("channel not ready".into()))?;
            let resp = grpc
                .unary(tonic::Request::new(request), path, codec)
                .await?;
            Ok::<_, ClientError>(resp.into_inner())
        };
        let msg = tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| ClientError::Timeout)??;
        message_to_json_keeping(&msg, keep)
    }

    /// Reads `dish_get_config` (read-only). Returns the PII-stripped `dishConfig` JSON and
    /// the parsed snow-melt mode.
    pub async fn get_dish_config(&self) -> Result<(Value, Option<SnowMeltMode>), ClientError> {
        let top = self.handle("dish_get_config").await?;
        let body = response_body(&top, "dishGetConfig")?;
        let cfg = body.get("dishConfig").cloned().unwrap_or(Value::Null);
        Ok((cfg, json::parse_snow_melt_mode(body)))
    }

    /// Sends a read-only request by name and returns the JSON response.
    pub async fn handle(&self, request_field: &str) -> Result<Value, ClientError> {
        self.call(build_request(&self.schema, request_field, None)?)
            .await
    }
}

#[async_trait]
impl StarlinkClient for GrpcClient {
    fn is_mock(&self) -> bool {
        false
    }

    fn request_names(&self) -> Option<Vec<String>> {
        Some(self.schema.request_names())
    }

    async fn get_status(&self) -> Result<DishStatus, ClientError> {
        let top = self.handle("get_status").await?;
        Ok(json::parse_status(
            response_body(&top, "dishGetStatus")?,
            now_ms(),
        ))
    }

    async fn get_history(&self) -> Result<DishHistory, ClientError> {
        let top = self.handle("get_history").await?;
        Ok(json::parse_history(
            response_body(&top, "dishGetHistory")?,
            now_ms(),
        ))
    }

    async fn get_device_info(&self) -> Result<DeviceInfo, ClientError> {
        let top = self.handle("get_device_info").await?;
        Ok(json::parse_device_info(response_body(
            &top,
            "getDeviceInfo",
        )?))
    }

    async fn get_obstruction_map(&self) -> Result<ObstructionMap, ClientError> {
        let top = self.handle("dish_get_obstruction_map").await?;
        json::parse_obstruction_map(response_body(&top, "dishGetObstructionMap")?)
    }

    async fn get_snow_melt_mode(&self) -> Result<Option<SnowMeltMode>, ClientError> {
        Ok(self.get_dish_config().await?.1)
    }

    async fn write(&self, action: WriteAction) -> Result<(), ClientError> {
        let request = build_write_request(&self.schema, action)?;
        tracing::info!(?action, "sending write request");
        self.call(request).await.map(|_| ())
    }
}

#[async_trait]
impl RouterClient for GrpcClient {
    async fn wifi_clients(&self) -> Result<Vec<WifiClientInfo>, ClientError> {
        // Keep only the client name (display-only, see `DeviceName`); all other PII is removed.
        let req = build_request(&self.schema, "wifi_get_clients", None)?;
        let top = self.call_keeping(req, &["name"]).await?;
        Ok(json::parse_wifi_clients(response_body(
            &top,
            "wifiGetClients",
        )?))
    }

    async fn router_status(&self) -> Result<RouterStatus, ClientError> {
        // WAN addresses are PII; kept only here, reduced to a bool by the parser.
        let req = build_request(&self.schema, "get_status", None)?;
        let top = self.call_keeping(req, &["ipv6WanAddresses"]).await?;
        // Optional: older firmware may lack `wifi_guest_info`. Inside a readable body,
        // `isOnline` false is omitted (proto3); no readable body = unknown.
        let online = self.handle("wifi_guest_info").await.ok().and_then(|g| {
            response_body(&g, "wifiGuestInfo")
                .ok()
                .map(|b| b.get("isOnline").and_then(Value::as_bool).unwrap_or(false))
        });
        Ok(json::parse_router_status(
            response_body(&top, "wifiGetStatus")?,
            online,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dish::reflection::test_schema;

    fn to_json(msg: &DynamicMessage) -> Value {
        message_to_json(msg).unwrap()
    }

    #[test]
    fn builds_read_request_by_name() {
        let schema = test_schema::schema();
        let req = build_request(&schema, "get_status", None).unwrap();
        assert_eq!(to_json(&req)["getStatus"], serde_json::json!({}));
        assert_eq!(
            build_request(&schema, "speed_test", None).unwrap_err(),
            ClientError::Unsupported
        );
    }

    #[test]
    fn builds_write_requests() {
        let schema = test_schema::schema();
        let reboot = build_write_request(&schema, WriteAction::Reboot).unwrap();
        assert!(to_json(&reboot).get("reboot").is_some());

        let stow = to_json(&build_write_request(&schema, WriteAction::Stow).unwrap());
        assert_eq!(stow["dishStow"]["unstow"], false);
        let unstow = to_json(&build_write_request(&schema, WriteAction::Unstow).unwrap());
        assert_eq!(unstow["dishStow"]["unstow"], true);

        let snow = to_json(
            &build_write_request(&schema, WriteAction::SetSnowMelt(SnowMeltMode::AlwaysOn))
                .unwrap(),
        );
        assert_eq!(
            snow["dishSetConfig"]["dishConfig"]["snowMeltMode"],
            "ALWAYS_ON"
        );
        assert_eq!(
            snow["dishSetConfig"]["dishConfig"]["applySnowMeltMode"],
            true
        );

        // Wire round-trip of the request.
        let bytes = reboot.encode_to_vec();
        let back = DynamicMessage::decode(schema.request.clone(), bytes.as_slice()).unwrap();
        assert_eq!(back, reboot);
    }

    #[test]
    fn dynamic_decode_with_missing_fields_and_nan() {
        let schema = test_schema::schema();
        let status_md = schema
            .pool
            .get_message_by_name("T.Device.DishGetStatusResponse")
            .unwrap();
        let obs_md = schema
            .pool
            .get_message_by_name("T.Device.DishObstructionStats")
            .unwrap();

        let mut obs = DynamicMessage::new(obs_md);
        obs.set_field_by_name("fraction_obstructed", PValue::F32(0.25));
        obs.set_field_by_name(
            "avg_prolonged_obstruction_interval_s",
            PValue::F32(f32::NAN),
        );
        let mut status = DynamicMessage::new(status_md);
        status.set_field_by_name("pop_ping_latency_ms", PValue::F32(31.5));
        status.set_field_by_name("obstruction_stats", PValue::Message(obs));
        status.set_field_by_name("uptime_s", PValue::U64(u64::MAX));
        let mut resp = DynamicMessage::new(schema.response.clone());
        resp.set_field_by_name("dish_get_status", PValue::Message(status));

        // Binary encode -> dynamic decode, as tonic would do.
        let bytes = resp.encode_to_vec();
        let decoded = DynamicMessage::decode(schema.response.clone(), bytes.as_slice()).unwrap();
        let top = message_to_json(&decoded).unwrap();
        let body = response_body(&top, "dishGetStatus").unwrap();

        // uint64 is a string in proto3 JSON; default-valued fields are present.
        assert_eq!(body["uptimeS"], "18446744073709551615");
        assert_eq!(body["popPingDropRate"], 0.0);
        assert_eq!(
            body["obstructionStats"]["avgProlongedObstructionIntervalS"],
            "NaN"
        );

        let parsed = json::parse_status(body, 0);
        assert_eq!(parsed.snapshot.pop_ping_latency_ms, Some(31.5));
        assert_eq!(parsed.snapshot.pop_ping_drop_rate, Some(0.0));
        assert_eq!(parsed.snapshot.obstruction.fraction_obstructed, Some(0.25));
        assert_eq!(
            parsed
                .snapshot
                .obstruction
                .avg_prolonged_obstruction_interval_s,
            None
        );
        assert_eq!(
            parsed.snapshot.obstruction.currently_obstructed,
            Some(false)
        );
        // Not in this schema at all -> None.
        assert_eq!(parsed.snapshot.signal_quality, None);
        assert_eq!(parsed.snapshot.downlink_bps, None);
    }

    #[test]
    fn unknown_fields_from_newer_firmware_are_ignored() {
        let schema = test_schema::schema();
        // Field 9999 (varint) is unknown to the schema.
        let mut bytes = DynamicMessage::new(schema.response.clone()).encode_to_vec();
        bytes.extend_from_slice(&[0xF8, 0xF0, 0x04, 0x01]);
        let decoded = DynamicMessage::decode(schema.response.clone(), bytes.as_slice()).unwrap();
        assert!(message_to_json(&decoded).is_ok());
    }
}
