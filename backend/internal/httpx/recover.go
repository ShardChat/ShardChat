// Go terminates the whole process on any unrecovered panic in any goroutine,
// so one bug in a handler would take the relay down for every session. This
// middleware confines a panic to the request that caused it.
package httpx

import (
	"log"
	"net/http"
)

// Recover wraps a handler so an unexpected panic becomes a 500 instead of a
// process-wide crash. The log line carries the route and the panic value only —
// never request bodies, headers or peer addresses.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rc := recover(); rc != nil {
				if rc == http.ErrAbortHandler {
					panic(rc) // the stdlib's own signal: let it through
				}
				log.Printf("[http] recovered method=%s path=%s panic=%v", r.Method, r.URL.Path, rc)
				// The response may already be partially written; a second
				// WriteHeader is a no-op then, which is the best we can do.
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"error":"internal error"}`))
			}
		}()
		next.ServeHTTP(w, r)
	})
}
