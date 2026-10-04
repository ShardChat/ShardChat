// Package httpx holds shared HTTP middleware: security headers, CORS.
package httpx

import "net/http"

// themeBootstrapHash is the CSP hash of the theme bootstrap script inlined in
// frontend/index.html, in the quoted form CSP requires for a hash source (an
// unquoted `sha256-...` is not a valid source expression and the browser drops
// it from the source list with a console error).
//
// That script has to run before first paint, otherwise the page paints in the
// markup default and then repaints in the stored theme, so it cannot be moved
// into the bundle without reintroducing the flash it exists to prevent. Hashing
// it lets 'self' stay closed to inline code generally while still running this
// one script.
//
// Recompute with `node frontend/scripts/csp-hash.mjs` after `npm run build` and
// whenever that script is edited; Vite leaves it byte-identical, so the hash
// from the source and from dist/index.html always agree.
const themeBootstrapHash = "'sha256-YSUvDojLKX1PienrOUtYl2p21IFMKheukICQXtEmr+U='"

// SecurityHeaders pins the hardening headers onto every response: no framing,
// no sniffing, no referrer leakage, HSTS, and a CSP that allows only
// same-origin scripts/connects, the single hashed theme bootstrap, the
// ws:/wss: relay and inline styles (Tailwind injects a <style> tag in dev).
//
// connect-src carries NO third-party host: WebRTC signaling rides the
// session's own blind relay, so a peer id, an SDP or a local IP never reaches
// anyone but the other participant.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' "+themeBootstrapHash+"; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob:; "+
				"media-src 'self' blob: mediastream:; "+
				"connect-src 'self' ws: wss:; "+
				"font-src 'self'; object-src 'none'; base-uri 'none'; "+
				"form-action 'none'; frame-ancestors 'none'")
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		h.Set("Permissions-Policy", "camera=(self), display-capture=(self), geolocation=(), microphone=(self)")
		next.ServeHTTP(w, r)
	})
}
