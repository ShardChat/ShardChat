# shard-media — standalone SFU media node.
#
# Multistage: compile a static Go binary, then ship it in a minimal Alpine
# image that carries CA certs and runs as non-root. The final image holds
# no source and no toolchain — the SFU is in-memory by design, so the image
# stays disposable.
FROM golang:1.26-alpine AS build

WORKDIR /src

# Cache dependencies between builds: copy the module manifests first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# netgo + static: the binary resolves via Go's own resolver, so the runtime
# image needs only Alpine's CA bundle.
RUN CGO_ENABLED=0 GOOS=linux go build -tags netgo -ldflags '-s -w' -o /out/shard-media ./cmd/server

FROM alpine:3.20

RUN apk add --no-cache ca-certificates && \
    adduser -D -H -s /sbin/nologin -u 65534 media

COPY --from=build /out/shard-media /usr/local/bin/shard-media

USER media
# 8080 = HTTP signaling (/healthz, /ws). If SHARD_TCP_PORT is set for the
# ICE-TCP media path, publish that port too (docker -p / Render TCP port).
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/shard-media"]
