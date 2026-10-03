// Package turn fetches short-lived ICE credentials from Metered, or
// returns a STUN-only fallback when the API is not configured.
package turn

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const defaultTTL = "86400" // 24h, as requested by the Metered query contract.

// fallbackSTUN is the neutral default when no TURN broker is configured: no
// third-party TURN with shared credentials and no Google STUN, so ICE stays
// peer-to-peer unless the operator opts in via METERED_*.
const fallbackSTUN = "stun:stun.cloudflare.com:3478"

// stunNoticeOnce keeps the fallback notice to one line per process.
var stunNoticeOnce sync.Once

// defaultICEServers is used when METERED_API_KEY / METERED_DOMAIN are unset
// (local development) or when the Metered request fails. Override the STUN
// endpoint with SHARD_STUN_URL (comma-separated URLs allowed).
func defaultICEServers() []map[string]any {
	stunNoticeOnce.Do(func() {
		log.Printf("[turn] METERED_* not configured — STUN-only ICE fallback (%s); calls rely on direct P2P reachability", stunURL())
	})
	return []map[string]any{{"urls": stunURL()}}
}

func stunURL() string {
	if v := strings.TrimSpace(os.Getenv("SHARD_STUN_URL")); v != "" {
		return v
	}
	return fallbackSTUN
}

type iceEnvelope struct {
	IceServers json.RawMessage `json:"iceServers"`
}

// CredentialsJSON returns `{"iceServers":[...]}` for the WebRTC stack.
func CredentialsJSON() ([]byte, int) {
	key := strings.TrimSpace(os.Getenv("METERED_API_KEY"))
	domain := strings.TrimSpace(os.Getenv("METERED_DOMAIN"))
	domain = strings.TrimPrefix(domain, "https://")
	domain = strings.TrimPrefix(domain, "http://")
	domain = strings.TrimSuffix(domain, "/")

	if key == "" || domain == "" {
		return wrapDefaults(), http.StatusOK
	}

	raw, err := fetchMetered(domain, key)
	if err != nil {
		return wrapDefaults(), http.StatusOK
	}
	servers, err := normalizeICE(raw)
	if err != nil || len(servers) == 0 {
		return wrapDefaults(), http.StatusOK
	}
	out, err := json.Marshal(iceEnvelope{IceServers: servers})
	if err != nil {
		return wrapDefaults(), http.StatusOK
	}
	return out, http.StatusOK
}

func wrapDefaults() []byte {
	raw, _ := json.Marshal(defaultICEServers())
	out, _ := json.Marshal(iceEnvelope{IceServers: raw})
	return out
}

func fetchMetered(domain, apiKey string) ([]byte, error) {
	u := url.URL{
		Scheme: "https",
		Host:   domain,
		Path:   "/api/v1/turn/credentials",
	}
	q := u.Query()
	q.Set("apiKey", apiKey)
	q.Set("ttl", defaultTTL)
	u.RawQuery = q.Encode()

	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("metered status %d", res.StatusCode)
	}
	return body, nil
}

func normalizeICE(raw []byte) (json.RawMessage, error) {
	trim := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trim, "[") {
		var arr []json.RawMessage
		if err := json.Unmarshal(raw, &arr); err != nil {
			return nil, err
		}
		return json.RawMessage(trim), nil
	}
	var env struct {
		IceServers json.RawMessage `json:"iceServers"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	if len(env.IceServers) == 0 {
		return nil, fmt.Errorf("empty iceServers")
	}
	return env.IceServers, nil
}
