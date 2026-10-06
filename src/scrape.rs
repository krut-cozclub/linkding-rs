//! Website metadata (title / description / preview image) with an SSRF-safe resolver.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use crate::app::App;

#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub preview_image: Option<String>,
}

fn is_public(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_multicast()
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10
                || o[0] == 0)
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return is_public(&IpAddr::V4(m));
            }
            let s = v.segments();
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // fc00::/7
                || (s[0] & 0xffc0) == 0xfe80) // fe80::/10
        }
    }
}

fn host_allowed(allowed: &[String], host: &str) -> bool {
    allowed.iter().any(|a| {
        a == "*"
            || a.eq_ignore_ascii_case(host)
            || (a.starts_with('.') && host.to_lowercase().ends_with(&a.to_lowercase()))
    })
}

pub struct SafeResolver {
    pub allowed: Vec<String>,
}

impl Resolve for SafeResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let allowed = host_allowed(&self.allowed, &host);
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let safe: Vec<SocketAddr> = if allowed {
                addrs
            } else {
                addrs.into_iter().filter(|a| is_public(&a.ip())).collect()
            };
            if safe.is_empty() {
                return Err("host resolves to a non-public address".into());
            }
            Ok(Box::new(safe.into_iter()) as Addrs)
        })
    }
}

pub fn build_client(allowed: Vec<String>) -> reqwest::Client {
    let check = allowed.clone();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("too many redirects");
        }
        if let Some(h) = attempt.url().host_str() {
            let literal: Result<IpAddr, _> = h.trim_matches(|c| c == '[' || c == ']').parse();
            if let Ok(ip) = literal {
                if !is_public(&ip) && !host_allowed(&check, h) {
                    return attempt.error("redirect to non-public address");
                }
            }
        }
        attempt.follow()
    });
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; linkding-rs)")
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .redirect(policy)
        .dns_resolver(Arc::new(SafeResolver { allowed }))
        .build()
        .expect("http client")
}

pub async fn fetch_meta(app: &App, url: &str, ignore_cache: bool) -> Meta {
    if !ignore_cache {
        if let Ok(c) = app.meta_cache.lock() {
            if let Some((_, m)) = c.iter().find(|(u, _)| u == url) {
                return m.clone();
            }
        }
    }
    let mut meta = Meta { url: url.to_string(), ..Default::default() };
    if let Some(m) = try_fetch(app, url).await {
        meta = m;
        meta.url = url.to_string();
    }
    if let Ok(mut c) = app.meta_cache.lock() {
        c.retain(|(u, _)| u != url);
        c.push_back((url.to_string(), meta.clone()));
        while c.len() > 10 {
            c.pop_front();
        }
    }
    meta
}

async fn try_fetch(app: &App, url: &str) -> Option<Meta> {
    let parsed = url::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    if let Some(h) = parsed.host_str() {
        let literal: Result<IpAddr, _> = h.trim_matches(|c| c == '[' || c == ']').parse();
        if let Ok(ip) = literal {
            if !is_public(&ip) && !host_allowed(&app.cfg.allowed_internal_hosts, h) {
                return None;
            }
        }
    }
    let mut resp = app
        .http
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !ctype.is_empty() && !ctype.contains("html") && !ctype.contains("xml") {
        return None;
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        buf.extend_from_slice(&chunk);
        if buf.len() >= 512 * 1024 {
            break;
        }
        // the head is all we need
        let tail = &buf[buf.len().saturating_sub(chunk.len() + 8)..];
        if find_ci(tail, b"</head>").is_some() {
            break;
        }
    }
    let html = String::from_utf8_lossy(&buf);
    Some(parse_html_meta(&html))
}

fn find_ci(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w.eq_ignore_ascii_case(needle))
}

pub fn parse_html_meta(html: &str) -> Meta {
    let lower = html.to_ascii_lowercase();
    let mut meta = Meta::default();
    // <title>
    if let Some(s) = lower.find("<title") {
        if let Some(gt) = lower[s..].find('>') {
            let start = s + gt + 1;
            if let Some(e) = lower[start..].find("</title") {
                let t = decode_entities(html[start..start + e].trim());
                let t: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
                if !t.is_empty() {
                    meta.title = Some(t);
                }
            }
        }
    }
    // <meta ...>
    let mut pos = 0;
    while let Some(i) = lower[pos..].find("<meta") {
        let start = pos + i;
        let end = match lower[start..].find('>') {
            Some(e) => start + e,
            None => break,
        };
        let attrs = parse_attrs(&html[start + 5..end]);
        pos = end + 1;
        let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let key = get("name").or_else(|| get("property")).unwrap_or_default().to_lowercase();
        let content = match get("content") {
            Some(c) => decode_entities(c.trim()),
            None => continue,
        };
        if content.is_empty() {
            continue;
        }
        match key.as_str() {
            "description" => meta.description = Some(content),
            "og:description" if meta.description.is_none() => meta.description = Some(content),
            "og:image" => meta.preview_image = Some(content),
            "og:title" if meta.title.is_none() => meta.title = Some(content),
            _ => {}
        }
    }
    meta
}

/// Minimal attribute parser (`name="v"`, `name='v'`, `name=v`).
pub fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let c: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < c.len() {
        while i < c.len() && (c[i].is_whitespace() || c[i] == '/') {
            i += 1;
        }
        let mut name = String::new();
        while i < c.len() && !c[i].is_whitespace() && c[i] != '=' && c[i] != '/' {
            name.push(c[i].to_ascii_lowercase());
            i += 1;
        }
        if name.is_empty() {
            i += 1;
            continue;
        }
        while i < c.len() && c[i].is_whitespace() {
            i += 1;
        }
        let mut val = String::new();
        if i < c.len() && c[i] == '=' {
            i += 1;
            while i < c.len() && c[i].is_whitespace() {
                i += 1;
            }
            if i < c.len() && (c[i] == '"' || c[i] == '\'') {
                let q = c[i];
                i += 1;
                while i < c.len() && c[i] != q {
                    val.push(c[i]);
                    i += 1;
                }
                i += 1;
            } else {
                while i < c.len() && !c[i].is_whitespace() {
                    val.push(c[i]);
                    i += 1;
                }
            }
        }
        out.push((name, val));
    }
    out
}

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        if let Some(semi) = rest.find(';').filter(|p| *p <= 10) {
            let ent = &rest[1..semi];
            let rep: Option<String> = match ent {
                "amp" => Some("&".into()),
                "lt" => Some("<".into()),
                "gt" => Some(">".into()),
                "quot" => Some("\"".into()),
                "apos" => Some("'".into()),
                "nbsp" => Some("\u{a0}".into()),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
                    .map(|c| c.to_string()),
                _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32).map(|c| c.to_string()),
                _ => None,
            };
            if let Some(r) = rep {
                out.push_str(&r);
                rest = &rest[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_title_and_description() {
        let m = parse_html_meta(
            "<html><head><TITLE> A &amp; B </TITLE><meta name=\"description\" content=\"Hello &quot;x&quot;\"><meta property='og:image' content='http://i/x.png'></head>",
        );
        assert_eq!(m.title.as_deref(), Some("A & B"));
        assert_eq!(m.description.as_deref(), Some("Hello \"x\""));
        assert_eq!(m.preview_image.as_deref(), Some("http://i/x.png"));
    }

    #[test]
    fn private_addresses_are_blocked() {
        assert!(!is_public(&"127.0.0.1".parse().unwrap()));
        assert!(!is_public(&"10.1.2.3".parse().unwrap()));
        assert!(!is_public(&"169.254.169.254".parse().unwrap()));
        assert!(!is_public(&"::1".parse().unwrap()));
        assert!(is_public(&"93.184.216.34".parse().unwrap()));
    }
}
