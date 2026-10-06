//! Netscape bookmark HTML import / export, byte-compatible with linkding.

use std::collections::{HashMap, HashSet};

use sqlx::Row;

use crate::app::{now_micros, S};
use crate::models::*;
use crate::scrape::{decode_entities, parse_attrs};

const ARCHIVED_TAG: &str = "linkding:bookmarks.archived";
const NOTES_OPEN: &str = "[linkding-notes]";
const NOTES_CLOSE: &str = "[/linkding-notes]";

pub fn html_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#x27;"),
            _ => o.push(c),
        }
    }
    o
}

/// Same output as linkding's exporter, including the odd `\n\r` line separator
/// and the unescaped HREF.
pub fn export(bms: &[Bm]) -> String {
    let mut lines: Vec<String> = vec![
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>".into(),
        "<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">".into(),
        "<TITLE>Bookmarks</TITLE>".into(),
        "<H1>Bookmarks</H1>".into(),
        "<DL><p>".into(),
    ];
    for b in bms {
        let mut tags: Vec<String> = b.tag_names.clone();
        tags.sort();
        let mut tags: Vec<String> = tags.iter().map(|t| html_escape(t)).collect();
        if b.is_archived {
            tags.push(ARCHIVED_TAG.to_string());
        }
        let title = if b.title.is_empty() { &b.url } else { &b.title };
        lines.push(format!(
            "<DT><A HREF=\"{}\" ADD_DATE=\"{}\" LAST_MODIFIED=\"{}\" PRIVATE=\"{}\" TOREAD=\"{}\" TAGS=\"{}\">{}</A>",
            b.url,
            b.date_added.div_euclid(1_000_000),
            b.date_modified.div_euclid(1_000_000),
            if b.shared { 0 } else { 1 },
            if b.unread { 1 } else { 0 },
            tags.join(","),
            html_escape(title)
        ));
        let mut desc = html_escape(&b.description);
        if !b.notes.is_empty() {
            desc.push_str(NOTES_OPEN);
            desc.push_str(&html_escape(&b.notes));
            desc.push_str(NOTES_CLOSE);
        }
        if !desc.is_empty() {
            lines.push(format!("<DD>{desc}"));
        }
    }
    lines.push("</DL><p>".into());
    lines.join("\n\r")
}

#[derive(Debug, Default, Clone)]
pub struct Parsed {
    pub url: String,
    pub title: String,
    pub description: String,
    pub notes: String,
    pub tags: Vec<String>,
    pub add_date: Option<String>,
    pub last_modified: Option<String>,
    pub to_read: bool,
    pub private: bool,
    pub archived: bool,
}

#[derive(Default)]
struct Pending {
    bm: Parsed,
    in_a: bool,
    in_dd: bool,
    dd: String,
    tags_raw: String,
}

fn finalize(p: Option<Pending>, out: &mut Vec<Parsed>) {
    let Some(mut p) = p else { return };
    if p.bm.url.trim().is_empty() {
        return;
    }
    p.bm.title = p.bm.title.trim().to_string();
    let dd = p.dd.trim().to_string();
    if let Some(start) = dd.find(NOTES_OPEN) {
        p.bm.description = dd[..start].trim().to_string();
        let after = &dd[start + NOTES_OPEN.len()..];
        let end = after.find(NOTES_CLOSE).unwrap_or(after.len());
        p.bm.notes = after[..end].trim().to_string();
    } else {
        p.bm.description = dd;
    }
    p.bm.archived = p.tags_raw.contains(ARCHIVED_TAG);
    p.bm.tags = clean_tag_names([p.tags_raw.as_str()])
        .into_iter()
        .filter(|t| t != ARCHIVED_TAG)
        .collect();
    out.push(p.bm);
}

pub fn parse(html: &str) -> Vec<Parsed> {
    let mut out = Vec::new();
    let mut cur: Option<Pending> = None;
    let mut i = 0;
    let b = html.as_bytes();
    let mut text_start = 0;

    macro_rules! flush_text {
        ($end:expr) => {
            if $end > text_start {
                if let Some(p) = cur.as_mut() {
                    let t = decode_entities(&html[text_start..$end]);
                    if p.in_a {
                        p.bm.title.push_str(&t);
                    } else if p.in_dd {
                        p.dd.push_str(&t);
                    }
                }
            }
        };
    }

    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        // comments
        if html[i..].starts_with("<!--") {
            flush_text!(i);
            let end = html[i..].find("-->").map(|e| i + e + 3).unwrap_or(b.len());
            i = end;
            text_start = i;
            continue;
        }
        let next = b.get(i + 1).copied().unwrap_or(0);
        if !(next.is_ascii_alphabetic() || next == b'/' || next == b'!') {
            i += 1;
            continue;
        }
        let end = match html[i..].find('>') {
            Some(e) => i + e,
            None => break,
        };
        flush_text!(i);
        let inner = &html[i + 1..end];
        i = end + 1;
        text_start = i;
        if inner.starts_with('!') {
            continue;
        }
        let closing = inner.starts_with('/');
        let body = inner.trim_start_matches('/');
        let name_end = body
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(body.len());
        let name = body[..name_end].to_ascii_lowercase();
        let rest = &body[name_end..];
        if closing {
            match name.as_str() {
                "a" => {
                    if let Some(p) = cur.as_mut() {
                        p.in_a = false;
                    }
                }
                "dl" => finalize(cur.take(), &mut out),
                _ => {}
            }
            continue;
        }
        match name.as_str() {
            "a" => {
                finalize(cur.take(), &mut out);
                let mut p = Pending { in_a: true, ..Default::default() };
                p.bm.private = true;
                for (k, v) in parse_attrs(rest) {
                    let v = decode_entities(&v);
                    match k.as_str() {
                        "href" => p.bm.url = v,
                        "add_date" => p.bm.add_date = Some(v),
                        "last_modified" => p.bm.last_modified = Some(v),
                        "tags" => p.tags_raw = v,
                        "toread" => p.bm.to_read = v == "1",
                        "private" => p.bm.private = v != "0",
                        _ => {}
                    }
                }
                cur = Some(p);
            }
            "dd" => {
                if let Some(p) = cur.as_mut() {
                    p.in_dd = true;
                }
            }
            "dt" | "dl" | "h3" => finalize(cur.take(), &mut out),
            _ => {}
        }
    }
    flush_text!(b.len());
    finalize(cur.take(), &mut out);
    out
}

/// seconds, then milliseconds, then microseconds -> unix microseconds.
fn parse_timestamp(s: &str) -> Option<i64> {
    let n: i64 = s.trim().parse().ok()?;
    const MAX: i64 = 253_402_300_799;
    if (0..=MAX).contains(&n) {
        Some(n * 1_000_000)
    } else if (0..=MAX).contains(&(n / 1000)) && n > 0 {
        Some((n / 1000) * 1_000_000)
    } else if (0..=MAX).contains(&(n / 1_000_000)) && n > 0 {
        Some((n / 1_000_000) * 1_000_000)
    } else {
        None
    }
}

pub struct ImportResult {
    pub imported: usize,
    pub failed: usize,
}

pub async fn import(app: &S, owner: i64, items: Vec<Parsed>, map_private: bool) -> Result<ImportResult, sqlx::Error> {
    let db = &app.db;
    let mut res = ImportResult { imported: 0, failed: 0 };
    let mut seen: HashSet<String> = HashSet::new();
    let mut tag_cache: HashMap<String, i64> = HashMap::new();
    let ins_tag = db.insert_ignore("INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)");

    for chunk in items.chunks(200) {
        let mut tx = db.pool.begin().await?;
        for it in chunk {
            let url = it.url.trim().to_string();
            if (!app.cfg.disable_url_validation && !valid_url(&url))
                || url.chars().count() > 2048
                || it.title.chars().count() > 512
            {
                res.failed += 1;
                continue;
            }
            let norm = normalize_url(&url);
            if !seen.insert(norm.clone()) {
                res.failed += 1;
                continue;
            }
            let added = match &it.add_date {
                Some(s) => match parse_timestamp(s) {
                    Some(v) => v,
                    None => {
                        res.failed += 1;
                        continue;
                    }
                },
                None => now_micros(),
            };
            let modified = match &it.last_modified {
                Some(s) => match parse_timestamp(s) {
                    Some(v) => v,
                    None => {
                        res.failed += 1;
                        continue;
                    }
                },
                None => added,
            };
            let hash = fnv1a(&norm);
            let shared = map_private && !it.private;

            let existing = db
                .fetch_opt(
                    &mut *tx,
                    "SELECT id FROM bookmarks WHERE owner_id = ? AND url_hash = ? AND url_normalized = ?",
                    &[owner.into(), hash.into(), norm.clone().into()],
                )
                .await?;
            let bid = match existing {
                Some(r) => {
                    let id: i64 = r.try_get(0)?;
                    let mut sets = vec![
                        "url = ?", "url_normalized = ?", "url_hash = ?", "date_added = ?", "date_modified = ?", "unread = ?",
                    ];
                    let mut p: Vec<crate::db::P> = vec![
                        url.clone().into(),
                        norm.clone().into(),
                        hash.into(),
                        added.into(),
                        modified.into(),
                        it.to_read.into(),
                    ];
                    if shared {
                        sets.push("shared = 1");
                    }
                    if it.archived {
                        sets.push("is_archived = 1");
                    }
                    if !it.title.is_empty() {
                        sets.push("title = ?");
                        p.push(it.title.clone().into());
                    }
                    if !it.description.is_empty() {
                        sets.push("description = ?");
                        p.push(it.description.clone().into());
                    }
                    if !it.notes.is_empty() {
                        sets.push("notes = ?");
                        p.push(it.notes.clone().into());
                    }
                    p.push(id.into());
                    let sql = format!("UPDATE bookmarks SET {} WHERE id = ?", sets.join(", "));
                    db.execute(&mut *tx, &sql, &p).await?;
                    refresh_search_text(db, &mut tx, id).await?;
                    id
                }
                None => {
                    db.insert(
                        &mut *tx,
                        "INSERT INTO bookmarks (owner_id, url, url_normalized, url_hash, search_text, title, description, notes, is_archived, unread, shared, date_added, date_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        &[
                            owner.into(),
                            url.clone().into(),
                            norm.clone().into(),
                            hash.into(),
                            search_text(&it.title, &it.description, &it.notes, &url).into(),
                            it.title.clone().into(),
                            it.description.clone().into(),
                            it.notes.clone().into(),
                            it.archived.into(),
                            it.to_read.into(),
                            shared.into(),
                            added.into(),
                            modified.into(),
                        ],
                    )
                    .await?
                }
            };
            let missing: Vec<String> = it
                .tags
                .iter()
                .filter(|t| !tag_cache.contains_key(&t.to_lowercase()))
                .cloned()
                .collect();
            if !missing.is_empty() {
                let ids = ensure_tags(db, &mut tx, owner, &missing).await?;
                for (n, id) in missing.iter().zip(ids) {
                    tag_cache.insert(n.to_lowercase(), id);
                }
            }
            for t in &it.tags {
                if let Some(tid) = tag_cache.get(&t.to_lowercase()) {
                    db.execute(&mut *tx, &ins_tag, &[bid.into(), (*tid).into()]).await?;
                }
            }
            res.imported += 1;
        }
        tx.commit().await?;
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Bm {
        Bm {
            id: 7,
            url: "https://example.com/7".into(),
            title: "Title <7>".into(),
            description: "Example description".into(),
            notes: "Example notes".into(),
            is_archived: true,
            unread: false,
            shared: false,
            tag_names: vec![],
            date_added: 7_000_000,
            date_modified: 77_000_000,
        }
    }

    #[test]
    fn export_matches_linkding_format() {
        let out = export(&[sample()]);
        assert!(out.starts_with("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n\r<META"));
        assert!(out.ends_with("\n\r</DL><p>"));
        assert!(out.contains(
            "<DT><A HREF=\"https://example.com/7\" ADD_DATE=\"7\" LAST_MODIFIED=\"77\" PRIVATE=\"1\" TOREAD=\"0\" TAGS=\"linkding:bookmarks.archived\">Title &lt;7&gt;</A>"
        ));
        assert!(out.contains("\n\r<DD>Example description[linkding-notes]Example notes[/linkding-notes]\n\r"));
    }

    #[test]
    fn round_trip() {
        let mut b = sample();
        b.tag_names = vec!["Rust".into(), "web".into()];
        b.shared = true;
        b.unread = true;
        let parsed = parse(&export(&[b]));
        assert_eq!(parsed.len(), 1);
        let p = &parsed[0];
        assert_eq!(p.url, "https://example.com/7");
        assert_eq!(p.title, "Title <7>");
        assert_eq!(p.description, "Example description");
        assert_eq!(p.notes, "Example notes");
        assert_eq!(p.tags, vec!["Rust".to_string(), "web".to_string()]);
        assert!(p.archived && p.to_read && !p.private);
        assert_eq!(p.add_date.as_deref(), Some("7"));
    }

    #[test]
    fn parses_browser_export_with_folders() {
        let html = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 ADD_DATE="1">Folder</H3>
  <DL><p>
    <DT><A HREF="https://a.example/" ADD_DATE="1600000000000" TAGS="x y,z" ICON="data:...">A &amp; B</A>
    <DD>desc here
    <DT><A HREF="https://b.example/">B</A>
  </DL><p>
</DL><p>"#;
        let p = parse(html);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].title, "A & B");
        assert_eq!(p[0].description, "desc here");
        assert_eq!(p[0].tags, vec!["x-y".to_string(), "z".to_string()]);
        assert!(p[0].private && !p[0].to_read);
        assert_eq!(parse_timestamp("1600000000000"), Some(1_600_000_000_000_000));
        assert_eq!(p[1].description, "");
    }
}
