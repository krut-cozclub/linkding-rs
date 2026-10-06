# syntax=docker/dockerfile:1
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev gcc
WORKDIR /src

# 1) compile dependencies only (cached until Cargo.toml / Cargo.lock change)
COPY Cargo.toml Cargo.lock ./
RUN mkdir src static && echo 'fn main() {}' > src/main.rs \
 && cargo build --release \
 && rm -rf src static

# 2) compile the app
COPY src ./src
COPY static ./static
RUN touch src/main.rs && cargo build --release

# 3) tiny runtime image: one static binary + CA certificates
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /src/target/release/linkding-rs /linkding-rs
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    DATABASE_URL=sqlite:///data/db.sqlite3
EXPOSE 9090
ENTRYPOINT ["/linkding-rs"]
