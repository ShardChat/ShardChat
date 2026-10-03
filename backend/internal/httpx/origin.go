package httpx

import (
	"net"
	"net/url"
	"strings"
)

// OriginAllowed reports whether a browser Origin may talk to this process.
//
// allowedSpec comes from ALLOWED_ORIGINS (comma-separated, e.g.
// "http://localhost:5173,https://app.example.com"); "*" permits everything.
//
// Empty spec = DEV MODE: only loopback http(s) origins (localhost, 127.0.0.1,
// [::1]) and Origin-less local tooling (curl / wscat) pass. The server logs a
// warning at startup so this mode never ships to production unnoticed.
//
// A configured spec is STRICT (CSWSH hardening): exact origin matches
// only, no implicit loopback auto-accept, and Origin-less requests are
// rejected outright.
func OriginAllowed(origin, allowedSpec string) bool {
	spec := strings.TrimSpace(allowedSpec)
	if spec == "*" {
		return true
	}
	if spec == "" {
		// Dev mode: loopback only.
		if origin == "" {
			return true // local tooling: curl / wscat / integration tests
		}
		got, err := url.Parse(origin)
		if err != nil || got.Scheme == "" || got.Host == "" {
			return false
		}
		return isLoopbackHTTP(got)
	}
	// Strict mode: a browser always sends Origin; anything without one is
	// not a browser we whitelisted.
	if origin == "" {
		return false
	}
	trimmed := strings.TrimSuffix(origin, "/")
	for _, raw := range strings.Split(spec, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if raw == "*" || strings.TrimSuffix(raw, "/") == trimmed {
			return true
		}
	}
	return false
}

func isLoopbackHTTP(u *url.URL) bool {
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
