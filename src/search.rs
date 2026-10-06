//! linkding search syntax: terms, "phrases", #tags, !unread / !untagged,
//! `and` / `or` / `not` and parentheses.

use crate::db::P;

#[derive(Debug, Clone)]
pub enum Node {
    Term(String),
    Tag(String),
    Unread,
    Untagged,
    All,
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Term(String, bool), // text, quoted
    Tag(String),
    Kw(String),
    LParen,
    RParen,
}

fn tokenize(q: &str) -> Vec<Tok> {
    let c: Vec<char> = q.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    let is_break = |ch: char| ch.is_whitespace() || matches!(ch, '(' | ')' | '"' | '\'' | '#' | '!');
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
        } else if ch == '(' {
            out.push(Tok::LParen);
            i += 1;
        } else if ch == ')' {
            out.push(Tok::RParen);
            i += 1;
        } else if ch == '"' || ch == '\'' {
            let quote = ch;
            i += 1;
            let mut s = String::new();
            while i < c.len() && c[i] != quote {
                if c[i] == '\\' && i + 1 < c.len() {
                    i += 1;
                    s.push(match c[i] {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        o => o,
                    });
                } else {
                    s.push(c[i]);
                }
                i += 1;
            }
            i += 1; // closing quote (lenient when missing)
            out.push(Tok::Term(s, true));
        } else if ch == '#' {
            i += 1;
            let mut s = String::new();
            while i < c.len() && !(c[i].is_whitespace() || matches!(c[i], '(' | ')' | '"' | '\'')) {
                s.push(c[i]);
                i += 1;
            }
            if !s.is_empty() {
                out.push(Tok::Tag(s));
            }
        } else if ch == '!' {
            i += 1;
            let mut s = String::new();
            while i < c.len() && !is_break(c[i]) {
                s.push(c[i]);
                i += 1;
            }
            if !s.is_empty() {
                out.push(Tok::Kw(s));
            }
        } else {
            let mut s = String::new();
            while i < c.len() && !is_break(c[i]) {
                s.push(c[i]);
                i += 1;
            }
            out.push(Tok::Term(s, false));
        }
    }
    out
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
}

fn is_op(t: &Tok, op: &str) -> bool {
    matches!(t, Tok::Term(s, false) if s.eq_ignore_ascii_case(op))
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    fn or_expr(&mut self) -> Result<Node, ()> {
        let mut items = vec![self.and_expr()?];
        while self.peek().map(|t| is_op(t, "or")).unwrap_or(false) {
            self.pos += 1;
            items.push(self.and_expr()?);
        }
        Ok(if items.len() == 1 { items.pop().unwrap() } else { Node::Or(items) })
    }

    fn and_expr(&mut self) -> Result<Node, ()> {
        let mut items = vec![self.not_expr()?];
        loop {
            match self.peek() {
                Some(t) if is_op(t, "and") => {
                    self.pos += 1;
                    items.push(self.not_expr()?);
                }
                Some(t) if is_op(t, "or") => break,
                Some(Tok::RParen) | None => break,
                Some(_) => items.push(self.not_expr()?),
            }
        }
        Ok(if items.len() == 1 { items.pop().unwrap() } else { Node::And(items) })
    }

    fn not_expr(&mut self) -> Result<Node, ()> {
        if self.peek().map(|t| is_op(t, "not")).unwrap_or(false) {
            self.pos += 1;
            return Ok(Node::Not(Box::new(self.not_expr()?)));
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<Node, ()> {
        let t = self.peek().cloned().ok_or(())?;
        self.pos += 1;
        match t {
            Tok::Term(s, _) => Ok(Node::Term(s)),
            Tok::Tag(s) => Ok(Node::Tag(s)),
            Tok::Kw(k) => Ok(match k.to_lowercase().as_str() {
                "unread" => Node::Unread,
                "untagged" => Node::Untagged,
                _ => Node::All,
            }),
            Tok::LParen => {
                let n = self.or_expr()?;
                if self.peek() == Some(&Tok::RParen) {
                    self.pos += 1;
                    Ok(n)
                } else {
                    Err(())
                }
            }
            Tok::RParen => Err(()),
        }
    }
}

/// `Ok(None)` for an empty query, `Err` for a syntax error (which yields no results).
pub fn parse(q: &str) -> Result<Option<Node>, ()> {
    let toks = tokenize(q);
    if toks.is_empty() {
        return Ok(None);
    }
    let mut p = Parser { toks, pos: 0 };
    let n = p.or_expr()?;
    if p.pos != p.toks.len() {
        return Err(());
    }
    Ok(Some(n))
}

fn like_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('%');
    for ch in s.chars() {
        if matches!(ch, '!' | '%' | '_') {
            o.push('!');
        }
        o.push(ch);
    }
    o.push('%');
    o
}

// Uncorrelated, so the database evaluates it once rather than per bookmark row.
// Tags are per-owner and only ever linked to that owner's bookmarks, so no owner check is needed here.
pub const TAG_EXISTS: &str =
    "b.id IN (SELECT bt.bookmark_id FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE t.name_lower = ?)";

pub fn to_sql(n: &Node, lax: bool, sql: &mut String, params: &mut Vec<P>) {
    match n {
        Node::All => sql.push_str("1 = 1"),
        Node::Unread => sql.push_str("b.unread = 1"),
        Node::Untagged => sql.push_str("b.id NOT IN (SELECT bookmark_id FROM bookmark_tags)"),
        Node::Tag(t) => {
            sql.push_str(TAG_EXISTS);
            params.push(P::S(t.to_lowercase()));
        }
        Node::Term(t) => {
            let like = like_escape(&t.to_lowercase());
            sql.push_str("(b.search_text LIKE ? ESCAPE '!'");
            params.push(P::S(like));
            if lax {
                sql.push_str(" OR ");
                sql.push_str(TAG_EXISTS);
                params.push(P::S(t.to_lowercase()));
            }
            sql.push(')');
        }
        Node::Not(inner) => {
            sql.push_str("NOT (");
            to_sql(inner, lax, sql, params);
            sql.push(')');
        }
        Node::And(items) | Node::Or(items) => {
            let sep = if matches!(n, Node::And(_)) { " AND " } else { " OR " };
            sql.push('(');
            for (i, it) in items.iter().enumerate() {
                if i > 0 {
                    sql.push_str(sep);
                }
                to_sql(it, lax, sql, params);
            }
            sql.push(')');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sql(q: &str) -> Option<String> {
        let n = parse(q).ok()??;
        let mut s = String::new();
        to_sql(&n, false, &mut s, &mut Vec::new());
        Some(s)
    }

    #[test]
    fn empty_matches_everything() {
        assert!(parse("   ").unwrap().is_none());
    }

    #[test]
    fn implicit_and_and_or_precedence() {
        let s = sql("a b or c").unwrap();
        assert!(s.starts_with("((("), "{s}");
        assert!(s.contains(" OR "));
    }

    #[test]
    fn unbalanced_parens_error() {
        assert!(parse("(a or b").is_err());
        assert!(parse("a)").is_err());
        assert!(parse("a or").is_err());
    }

    #[test]
    fn quoted_operators_are_terms() {
        assert!(matches!(parse("\"or\"").unwrap().unwrap(), Node::Term(_)));
    }

    #[test]
    fn tags_and_keywords() {
        assert!(matches!(parse("#rust").unwrap().unwrap(), Node::Tag(t) if t == "rust"));
        assert!(matches!(parse("!unread").unwrap().unwrap(), Node::Unread));
        assert!(matches!(parse("!whatever").unwrap().unwrap(), Node::All));
        assert!(matches!(parse("not #x").unwrap().unwrap(), Node::Not(_)));
    }
}
