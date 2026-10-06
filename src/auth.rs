use argon2::password_hash::phc::PasswordHash;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::extract::{FromRequestParts, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{request::Parts, Method, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use serde_json::{json, Value};
use sqlx::Row;

use crate::app::*;
use crate::db::P;

pub const SESSION_COOKIE: &str = "ld_sessionid";

pub fn default_settings() -> Value {
    json!({
        "theme": "auto",
        "bookmark_date_display": "relative",
        "bookmark_link_target": "_blank",
        "web_archive_integration": "disabled",
        "tag_search": "strict",
        "enable_favicons": false,
        "display_url": false,
        "permanent_notes": false,
        "search_preferences": {},
        "items_per_page": 30
    })
}

pub fn hash_password(pw: &str) -> String {
    Argon2::default()
        .hash_password(pw.as_bytes())
        .map(|h| h.to_string())
        .unwrap_or_default()
}

pub fn verify_password(pw: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default().verify_password(pw.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

pub async fn create_user(app: &S, name: &str, pass: Option<&str>, superuser: bool) -> Result<i64, sqlx::Error> {
    let hash = match pass {
        Some(p) => {
            let p = p.to_string();
            tokio::task::spawn_blocking(move || hash_password(&p)).await.unwrap_or_default()
        }
        None => String::new(),
    };
    app.db
        .insert(
            &app.db.pool,
            "INSERT INTO users (username, password_hash, is_superuser, enable_sharing, enable_public_sharing, settings, created) VALUES (?, ?, ?, 0, 0, ?, ?)",
            &[name.into(), hash.into(), superuser.into(), default_settings().to_string().into(), now_secs().into()],
        )
        .await
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        if let Some((k, v)) = part.trim().split_once('=') {
            if k == name {
                return Some(v);
            }
        }
    }
    None
}

/// Resolves the user from `Authorization: Token|Bearer <key>` or the session cookie.
/// `Ok(None)` means no credentials were supplied at all.
pub async fn authenticate(app: &S, headers: &HeaderMap, method: &Method) -> ApiResult<Option<i64>> {
    if let Some(h) = headers.get(header::AUTHORIZATION) {
        let h = h.to_str().unwrap_or("");
        let mut parts = h.split(' ');
        let scheme = parts.next().unwrap_or("");
        if scheme.eq_ignore_ascii_case("token") || scheme.eq_ignore_ascii_case("bearer") {
            let key = match parts.next() {
                None | Some("") => {
                    return Err(ApiError::unauthorized("Invalid token header. No credentials provided."))
                }
                Some(k) => k,
            };
            if parts.next().is_some() {
                return Err(ApiError::unauthorized("Invalid token header. Token string should not contain spaces."));
            }
            if let Some(uid) = app.tokens.read().ok().and_then(|m| m.get(key).copied()) {
                return Ok(Some(uid));
            }
            let row = app
                .db
                .fetch_opt(&app.db.pool, "SELECT user_id FROM api_tokens WHERE token = ?", &[key.into()])
                .await?;
            return match row {
                Some(r) => {
                    let uid: i64 = r.try_get(0)?;
                    if let Ok(mut m) = app.tokens.write() {
                        if m.len() > 10_000 {
                            m.clear();
                        }
                        m.insert(key.to_string(), uid);
                    }
                    Ok(Some(uid))
                }
                None => Err(ApiError::unauthorized("Invalid token.")),
            };
        }
    }
    if let Some(tok) = cookie_value(headers, SESSION_COOKIE) {
        let cached = app.sessions.read().ok().and_then(|m| m.get(tok).copied());
        let found = match cached {
            Some(v) => Some(v),
            None => {
                let row = app
                    .db
                    .fetch_opt(&app.db.pool, "SELECT user_id, expires FROM sessions WHERE token = ?", &[tok.into()])
                    .await?;
                match row {
                    Some(r) => {
                        let v = (r.try_get::<i64, _>(0)?, r.try_get::<i64, _>(1)?);
                        if let Ok(mut m) = app.sessions.write() {
                            m.insert(tok.to_string(), v);
                        }
                        Some(v)
                    }
                    None => None,
                }
            }
        };
        if let Some((uid, exp)) = found {
            if exp > now_secs() {
                // Cookie auth needs a custom header on state-changing requests (CSRF defence).
                if !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
                    && !headers.contains_key("x-requested-with")
                {
                    return Err(ApiError::detail(StatusCode::FORBIDDEN, "CSRF check failed."));
                }
                return Ok(Some(uid));
            }
        }
    }
    Ok(None)
}

pub struct Auth(pub i64);

impl FromRequestParts<S> for Auth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Auth, ApiError> {
        match authenticate(state, &parts.headers, &parts.method).await? {
            Some(uid) => Ok(Auth(uid)),
            None => Err(ApiError::unauthorized("Authentication credentials were not provided.")),
        }
    }
}

pub struct MaybeAuth(pub Option<i64>);

impl FromRequestParts<S> for MaybeAuth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<MaybeAuth, ApiError> {
        Ok(MaybeAuth(authenticate(state, &parts.headers, &parts.method).await?))
    }
}

fn secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

pub async fn login(State(app): State<S>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let username = body.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let password = body.get("password").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let fail = || {
        ApiError::detail(StatusCode::UNAUTHORIZED, "Please enter a correct username and password.").into_response()
    };
    let row = match app
        .db
        .fetch_opt(&app.db.pool, "SELECT id, password_hash FROM users WHERE username = ?", &[username.as_str().into()])
        .await
    {
        Ok(r) => r,
        Err(e) => return ApiError::from(e).into_response(),
    };
    let (uid, hash) = match row {
        Some(r) => (r.try_get::<i64, _>(0).unwrap_or(0), r.try_get::<String, _>(1).unwrap_or_default()),
        None => return fail(),
    };
    let ok = tokio::task::spawn_blocking(move || !hash.is_empty() && verify_password(&password, &hash))
        .await
        .unwrap_or(false);
    if !ok {
        return fail();
    }
    let token = random_hex(32);
    let expires = now_secs() + app.cfg.session_age;
    if let Err(e) = app
        .db
        .execute(
            &app.db.pool,
            "INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)",
            &[token.as_str().into(), uid.into(), expires.into()],
        )
        .await
    {
        return ApiError::from(e).into_response();
    }
    let _ = app.db.execute(&app.db.pool, "DELETE FROM sessions WHERE expires < ?", &[now_secs().into()]).await;
    if let Ok(mut m) = app.sessions.write() {
        m.insert(token.clone(), (uid, expires));
    }
    let cookie = format!(
        "{SESSION_COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}{}",
        app.cfg.session_age,
        if secure(&headers) { "; Secure" } else { "" }
    );
    let mut r = json_response(StatusCode::OK, &json!({ "ok": true }));
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        r.headers_mut().insert(header::SET_COOKIE, v);
    }
    r
}

pub async fn logout(State(app): State<S>, headers: HeaderMap) -> Response {
    if let Some(tok) = cookie_value(&headers, SESSION_COOKIE) {
        if let Ok(mut m) = app.sessions.write() {
            m.remove(tok);
        }
        let _ = app.db.execute(&app.db.pool, "DELETE FROM sessions WHERE token = ?", &[P::S(tok.to_string())]).await;
    }
    let mut r = Redirect::to("/login/").into_response();
    r.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("ld_sessionid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"),
    );
    r
}

pub async fn ensure_superuser(app: &S) -> Result<(), sqlx::Error> {
    let count: i64 = app
        .db
        .fetch_opt(&app.db.pool, "SELECT COUNT(*) FROM users", &[])
        .await?
        .map(|r| r.try_get(0).unwrap_or(0))
        .unwrap_or(0);
    if let Some(name) = &app.cfg.su_name {
        let exists = app
            .db
            .fetch_opt(&app.db.pool, "SELECT id FROM users WHERE username = ?", &[name.as_str().into()])
            .await?
            .is_some();
        if !exists {
            create_user(app, name, app.cfg.su_pass.as_deref(), true).await?;
            eprintln!("created superuser '{name}'");
        }
    } else if count == 0 {
        eprintln!("WARNING: no users exist. Set LD_SUPERUSER_NAME and LD_SUPERUSER_PASSWORD and restart.");
    }
    Ok(())
}
