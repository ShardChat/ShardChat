# SHARD — single-image build: client bundle compiled, Go relay compiled,
# one minimal runtime serving both on :8080.

# ---------- Stage 1: frontend (Vite build) ----------
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: backend (Go relay) ----------
FROM golang:1.26-alpine AS backend
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /shard-server ./cmd/server

# ---------- Stage 3: runtime ----------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 shard
COPY --from=backend /shard-server /usr/local/bin/shard-server
COPY --from=frontend /app/frontend/dist /app/frontend/dist
USER shard
# SHARD_ADDR is only a local/Docker default: on Render the injected PORT wins,
# so the relay binds wherever the platform's edge expects it.
ENV SHARD_ADDR=:8080 \
    SHARD_STATIC=/app/frontend/dist
# PaaS providers read the port from PORT; keep both in sync for clarity.
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
ENTRYPOINT ["shard-server"]
