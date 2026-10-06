use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::config::Config;
use crate::db::Db;
use crate::scrape::Meta;

pub struct App {
    pub db: Db,
    pub cfg: Config,
    pub http: reqwest::Client,
    /// api token -> user id
    pub tokens: RwLock<HashMap<String, i64>>,
    /// session token -> (user id, expiry unix seconds)
    pub sessions: RwLock<HashMap<String, (i64, i64)>>,
    pub meta_cache: Mutex<VecDeque<(String, Meta)>>,
    pub asset_version: String,
}

pub type S = Arc<App>;

pub fn now_micros() -> i64 {
    chrono::Utc::now().timestamp_micros()
}

pub fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("os rng");
    let mut s = String::with_capacity(bytes * 2);
    for b in buf {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub struct ApiError {
    pub status: StatusCode,
    pub body: Value,
    pub www_auth: bool,
}

impl ApiError {
    pub fn detail(status: StatusCode, msg: &str) -> ApiError {
        ApiError { status, body: json!({ "detail": msg }), www_auth: false }
    }
    pub fn unauthorized(msg: &str) -> ApiError {
        ApiError { status: StatusCode::UNAUTHORIZED, body: json!({ "detail": msg }), www_auth: true }
    }
    pub fn not_found() -> ApiError {
        ApiError::detail(StatusCode::NOT_FOUND, "Not found.")
    }
    pub fn field(name: &str, msg: &str) -> ApiError {
        ApiError { status: StatusCode::BAD_REQUEST, body: json!({ name: [msg] }), www_auth: false }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> ApiError {
        eprintln!("database error: {e}");
        ApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error.")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut r = (self.status, json_bytes(&self.body)).into_response();
        r.headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if self.www_auth {
            r.headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Token"));
        }
        r
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

pub fn json_bytes<T: serde::Serialize>(v: &T) -> Vec<u8> {
    serde_json::to_vec(v).unwrap_or_else(|_| b"{}".to_vec())
}

pub fn json_response<T: serde::Serialize>(status: StatusCode, v: &T) -> Response {
    let mut r = (status, json_bytes(v)).into_response();
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}
