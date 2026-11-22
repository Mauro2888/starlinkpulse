//! Schema discovery via gRPC Server Reflection (v1, falling back to v1alpha).
//!
//! The device's descriptors are fetched at runtime and turned into a
//! `prost_reflect::DescriptorPool`; no SpaceX `.proto` file is ever bundled. The encoded
//! `FileDescriptorSet` is cached on disk per firmware version for fast startup.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use prost::Message;
use prost_reflect::{DescriptorPool, Kind, MessageDescriptor};
use prost_types::{FileDescriptorProto, FileDescriptorSet};
use tonic::transport::Channel;

use crate::error::ClientError;

/// Fully-qualified service name exposed by dish and router.
pub const DEVICE_SERVICE: &str = "SpaceX.API.Device.Device";
/// RPC used for every request.
pub const HANDLE_METHOD: &str = "Handle";

/// Descriptor pool plus the `Request`/`Response` messages of `Device/Handle`.
#[derive(Debug, Clone)]
pub struct ReflectionSchema {
    pub pool: DescriptorPool,
    pub request: MessageDescriptor,
    pub response: MessageDescriptor,
    /// Encoded `FileDescriptorSet`, as stored in the cache.
    pub fds_bytes: Vec<u8>,
}

impl ReflectionSchema {
    /// Builds the schema from an encoded `FileDescriptorSet`.
    pub fn from_fds_bytes(bytes: &[u8]) -> Result<Self, ClientError> {
        Self::from_fds_bytes_for(bytes, DEVICE_SERVICE)
    }

    /// Same as [`Self::from_fds_bytes`] with an explicit service name.
    pub fn from_fds_bytes_for(bytes: &[u8], service_name: &str) -> Result<Self, ClientError> {
        let pool = DescriptorPool::decode(bytes).map_err(|e| ClientError::Schema(e.to_string()))?;
        let service = pool
            .get_service_by_name(service_name)
            .ok_or_else(|| ClientError::Schema(format!("{service_name} not in schema")))?;
        let method = service
            .methods()
            .find(|m| m.name() == HANDLE_METHOD)
            .ok_or_else(|| ClientError::Schema("Handle method not in schema".into()))?;
        Ok(Self {
            request: method.input(),
            response: method.output(),
            pool,
            fds_bytes: bytes.to_vec(),
        })
    }

    /// Names of the request types in the `Request` oneof (e.g. `get_status`, `dish_stow`).
    /// Presence here does not mean the device implements the request.
    pub fn request_names(&self) -> Vec<String> {
        self.request
            .oneofs()
            .flat_map(|o| o.fields().collect::<Vec<_>>())
            .filter(|f| matches!(f.kind(), Kind::Message(_)))
            .map(|f| f.name().to_string())
            .collect()
    }

    pub fn has_request(&self, name: &str) -> bool {
        self.request.get_field_by_name(name).is_some()
    }
}

/// On-disk cache of reflection schemas, keyed by device kind and firmware version.
#[derive(Debug, Clone)]
pub struct SchemaCache {
    dir: PathBuf,
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .take(96)
        .collect()
}

impl SchemaCache {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn latest_path(&self, prefix: &str) -> PathBuf {
        self.dir.join(format!("{}-latest.txt", sanitize(prefix)))
    }

    fn schema_path(&self, prefix: &str, version: &str) -> PathBuf {
        self.dir
            .join(format!("{}-{}.fds", sanitize(prefix), sanitize(version)))
    }

    /// Returns `(software_version, fds_bytes)` of the most recently stored schema.
    pub fn load_latest(&self, prefix: &str) -> Option<(String, Vec<u8>)> {
        let version = std::fs::read_to_string(self.latest_path(prefix)).ok()?;
        let version = version.trim().to_string();
        let bytes = std::fs::read(self.schema_path(prefix, &version)).ok()?;
        Some((version, bytes))
    }

    /// Stores a schema for `version` and marks it as latest.
    pub fn store(&self, prefix: &str, version: &str, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let path = self.schema_path(prefix, version);
        let tmp = path.with_extension("fds.tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &path)?;
        std::fs::write(self.latest_path(prefix), version)?;
        Ok(())
    }
}

/// Generates a reflection fetcher for one version of the reflection protocol
/// (v1 and v1alpha have identical message shapes but distinct generated types).
macro_rules! reflection_fetcher {
    ($fn_name:ident, $pb:path) => {
        async fn $fn_name(
            channel: Channel,
            symbol: &str,
        ) -> Result<Vec<FileDescriptorProto>, ClientError> {
            use pb::server_reflection_request::MessageRequest;
            use pb::server_reflection_response::MessageResponse;
            use $pb as pb;

            let mut client = pb::server_reflection_client::ServerReflectionClient::new(channel);
            let mut files: HashMap<String, FileDescriptorProto> = HashMap::new();
            let mut requested: HashSet<String> = HashSet::new();
            let mut pending = vec![MessageRequest::FileContainingSymbol(symbol.to_string())];

            // Each round requests the dependencies still missing; bounded to avoid loops.
            for _ in 0..16 {
                if pending.is_empty() {
                    break;
                }
                let reqs: Vec<pb::ServerReflectionRequest> = pending
                    .drain(..)
                    .map(|m| pb::ServerReflectionRequest {
                        host: String::new(),
                        message_request: Some(m),
                    })
                    .collect();
                let mut stream = client
                    .server_reflection_info(tokio_stream::iter(reqs))
                    .await?
                    .into_inner();
                while let Some(resp) = stream.message().await? {
                    match resp.message_response {
                        Some(MessageResponse::FileDescriptorResponse(fd)) => {
                            for raw in fd.file_descriptor_proto {
                                let proto = FileDescriptorProto::decode(raw.as_slice())
                                    .map_err(|e| ClientError::Schema(e.to_string()))?;
                                files.insert(proto.name().to_string(), proto);
                            }
                        }
                        Some(MessageResponse::ErrorResponse(e)) => {
                            tracing::debug!(code = e.error_code, "reflection error response");
                            if e.error_code == tonic::Code::Unimplemented as i32 {
                                return Err(ClientError::Unsupported);
                            }
                        }
                        _ => {}
                    }
                }
                for proto in files.values() {
                    for dep in &proto.dependency {
                        if !files.contains_key(dep) && requested.insert(dep.clone()) {
                            pending.push(MessageRequest::FileByFilename(dep.clone()));
                        }
                    }
                }
            }
            if files.is_empty() {
                return Err(ClientError::Schema(
                    "reflection returned no descriptors".into(),
                ));
            }
            Ok(files.into_values().collect())
        }
    };
}

reflection_fetcher!(fetch_v1, tonic_reflection::pb::v1);
reflection_fetcher!(fetch_v1alpha, tonic_reflection::pb::v1alpha);

/// Downloads the descriptors for `Device/Handle` via server reflection.
pub async fn fetch_schema(
    channel: Channel,
    timeout: Duration,
) -> Result<ReflectionSchema, ClientError> {
    // Reflection may need several round-trips; allow a few timeouts' worth.
    let budget = timeout * 3;
    let v1 = tokio::time::timeout(budget, fetch_v1(channel.clone(), DEVICE_SERVICE))
        .await
        .map_err(|_| ClientError::Timeout)?;
    let files = match v1 {
        Ok(files) => files,
        Err(e) if e.is_connectivity() => return Err(e),
        Err(e) => {
            tracing::info!(error = %e, "reflection v1 failed, trying v1alpha");
            tokio::time::timeout(budget, fetch_v1alpha(channel, DEVICE_SERVICE))
                .await
                .map_err(|_| ClientError::Timeout)??
        }
    };
    let set = FileDescriptorSet { file: files };
    ReflectionSchema::from_fds_bytes(&set.encode_to_vec())
}

#[cfg(test)]
pub(crate) mod test_schema {
    //! A tiny synthetic schema that mimics the *shape* of the device API (it is not the
    //! SpaceX schema) so the dynamic request/response path can be unit-tested offline.

    use prost::Message;
    use prost_types::field_descriptor_proto::{Label, Type};
    use prost_types::{
        DescriptorProto, EnumDescriptorProto, EnumValueDescriptorProto, FieldDescriptorProto,
        FileDescriptorProto, FileDescriptorSet, MethodDescriptorProto, OneofDescriptorProto,
        ServiceDescriptorProto,
    };

    fn field(name: &str, number: i32, ty: Type, type_name: Option<&str>) -> FieldDescriptorProto {
        FieldDescriptorProto {
            name: Some(name.into()),
            number: Some(number),
            label: Some(Label::Optional as i32),
            r#type: Some(ty as i32),
            type_name: type_name.map(Into::into),
            json_name: None,
            ..Default::default()
        }
    }

    fn repeated(name: &str, number: i32, ty: Type) -> FieldDescriptorProto {
        FieldDescriptorProto {
            label: Some(Label::Repeated as i32),
            ..field(name, number, ty, None)
        }
    }

    fn oneof_field(mut f: FieldDescriptorProto) -> FieldDescriptorProto {
        f.oneof_index = Some(0);
        f
    }

    fn msg(name: &str, fields: Vec<FieldDescriptorProto>) -> DescriptorProto {
        DescriptorProto {
            name: Some(name.into()),
            field: fields,
            ..Default::default()
        }
    }

    pub fn schema() -> super::ReflectionSchema {
        super::ReflectionSchema::from_fds_bytes_for(&fds_bytes(), "T.Device.Device").unwrap()
    }

    pub fn fds_bytes() -> Vec<u8> {
        let p = ".T.Device.";
        let t = |n: &str| format!("{p}{n}");
        let request = DescriptorProto {
            oneof_decl: vec![OneofDescriptorProto {
                name: Some("request".into()),
                options: None,
            }],
            ..msg(
                "Request",
                vec![
                    field("id", 1, Type::Uint64, None),
                    oneof_field(field(
                        "reboot",
                        1001,
                        Type::Message,
                        Some(&t("RebootRequest")),
                    )),
                    oneof_field(field(
                        "get_status",
                        1004,
                        Type::Message,
                        Some(&t("GetStatusRequest")),
                    )),
                    oneof_field(field(
                        "dish_stow",
                        2002,
                        Type::Message,
                        Some(&t("DishStowRequest")),
                    )),
                    oneof_field(field(
                        "dish_set_config",
                        2010,
                        Type::Message,
                        Some(&t("DishSetConfigRequest")),
                    )),
                ],
            )
        };
        let response = DescriptorProto {
            oneof_decl: vec![OneofDescriptorProto {
                name: Some("response".into()),
                options: None,
            }],
            ..msg(
                "Response",
                vec![
                    field("api_version", 3, Type::Uint64, None),
                    oneof_field(field(
                        "dish_get_status",
                        2004,
                        Type::Message,
                        Some(&t("DishGetStatusResponse")),
                    )),
                ],
            )
        };
        let snow_enum = EnumDescriptorProto {
            name: Some("SnowMeltMode".into()),
            value: ["AUTO", "ALWAYS_ON", "ALWAYS_OFF"]
                .iter()
                .enumerate()
                .map(|(i, n)| EnumValueDescriptorProto {
                    name: Some((*n).into()),
                    number: Some(i as i32),
                    options: None,
                })
                .collect(),
            ..Default::default()
        };
        let dish_config = DescriptorProto {
            enum_type: vec![snow_enum],
            ..msg(
                "DishConfig",
                vec![
                    field(
                        "snow_melt_mode",
                        1,
                        Type::Enum,
                        Some(&t("DishConfig.SnowMeltMode")),
                    ),
                    field("apply_snow_melt_mode", 1001, Type::Bool, None),
                ],
            )
        };
        let obstruction = msg(
            "DishObstructionStats",
            vec![
                field("fraction_obstructed", 1, Type::Float, None),
                field("avg_prolonged_obstruction_interval_s", 2, Type::Float, None),
                field("currently_obstructed", 3, Type::Bool, None),
            ],
        );
        let status = msg(
            "DishGetStatusResponse",
            vec![
                field("pop_ping_latency_ms", 1, Type::Float, None),
                field("pop_ping_drop_rate", 2, Type::Float, None),
                field(
                    "obstruction_stats",
                    3,
                    Type::Message,
                    Some(&t("DishObstructionStats")),
                ),
                field("uptime_s", 4, Type::Uint64, None),
                repeated("samples", 5, Type::Float),
            ],
        );
        let file = FileDescriptorProto {
            name: Some("t/device.proto".into()),
            package: Some("T.Device".into()),
            syntax: Some("proto3".into()),
            message_type: vec![
                request,
                response,
                msg("RebootRequest", vec![]),
                msg("GetStatusRequest", vec![]),
                msg(
                    "DishStowRequest",
                    vec![field("unstow", 1, Type::Bool, None)],
                ),
                msg(
                    "DishSetConfigRequest",
                    vec![field(
                        "dish_config",
                        1,
                        Type::Message,
                        Some(&t("DishConfig")),
                    )],
                ),
                dish_config,
                obstruction,
                status,
            ],
            service: vec![ServiceDescriptorProto {
                name: Some("Device".into()),
                method: vec![MethodDescriptorProto {
                    name: Some("Handle".into()),
                    input_type: Some(t("Request")),
                    output_type: Some(t("Response")),
                    ..Default::default()
                }],
                options: None,
            }],
            ..Default::default()
        };
        FileDescriptorSet { file: vec![file] }.encode_to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic() -> ReflectionSchema {
        test_schema::schema()
    }

    #[test]
    fn request_names_from_oneof() {
        let s = synthetic();
        let names = s.request_names();
        assert!(names.contains(&"get_status".to_string()));
        assert!(names.contains(&"dish_stow".to_string()));
        assert!(!names.contains(&"id".to_string()));
        assert!(s.has_request("reboot"));
        assert!(!s.has_request("speed_test"));
    }

    #[test]
    fn from_fds_requires_device_service() {
        // The synthetic schema is not under SpaceX.API.Device, so this must fail cleanly.
        assert!(ReflectionSchema::from_fds_bytes(&test_schema::fds_bytes()).is_err());
        assert!(ReflectionSchema::from_fds_bytes(b"garbage").is_err());
    }

    #[test]
    fn cache_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "starlinkpulse-schema-test-{}-{}",
            std::process::id(),
            crate::time::now_ms()
        ));
        let cache = SchemaCache::new(&dir);
        assert!(cache.load_latest("dish").is_none());
        cache.store("dish", "2026.10/../x", b"abc").unwrap();
        let (v, bytes) = cache.load_latest("dish").unwrap();
        assert_eq!(v, "2026.10/../x");
        assert_eq!(bytes, b"abc");
        // Version is sanitized into the file name: nothing escapes the cache dir.
        for entry in std::fs::read_dir(&dir).unwrap() {
            assert!(entry.unwrap().path().starts_with(&dir));
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
