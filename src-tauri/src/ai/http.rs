//! HTTP hardening shared by the AI providers: no redirects, capped response bodies, and
//! strict base URLs for local servers (endpoints are built by URL join, never by string
//! concatenation).

use reqwest::Url;

/// Maximum response body read from any AI endpoint.
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Client builder with redirects disabled (a redirect could leak the payload elsewhere).
pub fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
}

/// Why reading a response body failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyError {
    TooLarge,
    Timeout,
    Interrupted,
}

/// Reads at most `max` bytes of the body; larger bodies are rejected without buffering them.
pub async fn read_capped(mut resp: reqwest::Response, max: usize) -> Result<String, BodyError> {
    if resp.content_length().is_some_and(|l| l as usize > max) {
        return Err(BodyError::TooLarge);
    }
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > max {
                    return Err(BodyError::TooLarge);
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) if e.is_timeout() => return Err(BodyError::Timeout),
            Err(_) => return Err(BodyError::Interrupted),
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Validates a local AI base URL: `http(s)://host[:port][/path]` only, no user info, query
/// or fragment. Returns the normalized form without a trailing slash.
pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    let url = Url::parse(s).map_err(|_| "not a valid URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http:// and https:// are allowed".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("a host is required".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("user name or password in the URL is not allowed".into());
    }
    if url.query().is_some() || url.fragment().is_some() || s.contains('?') || s.contains('#') {
        return Err("query strings and fragments are not allowed".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Parses a validated base URL into a join base (path ends with `/`).
pub fn join_base(raw: &str) -> Result<Url, String> {
    let normalized = validate_base_url(raw)?;
    Url::parse(&format!("{normalized}/")).map_err(|_| "not a valid URL".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_rules() {
        assert_eq!(
            validate_base_url(" http://localhost:11434/ ").unwrap(),
            "http://localhost:11434"
        );
        assert_eq!(
            validate_base_url("https://gpu.lan:1234/llm").unwrap(),
            "https://gpu.lan:1234/llm"
        );
        for bad in [
            "",
            "localhost:11434",
            "ftp://host",
            "file:///etc/passwd",
            "http://",
            "http://user:pw@host:11434",
            "http://user@host",
            "http://host:11434/?x=1",
            "http://host:11434/#frag",
            "http://host:11434/api?",
        ] {
            assert!(validate_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn join_keeps_base_path() {
        let b = join_base("https://gpu.lan:1234/llm").unwrap();
        assert_eq!(
            b.join("api/chat").unwrap().as_str(),
            "https://gpu.lan:1234/llm/api/chat"
        );
        let b = join_base("http://localhost:11434").unwrap();
        assert_eq!(
            b.join("api/tags").unwrap().as_str(),
            "http://localhost:11434/api/tags"
        );
        // A model name or path can never escape the configured host.
        assert_eq!(b.join("v1/models").unwrap().host_str(), Some("localhost"));
    }
}
