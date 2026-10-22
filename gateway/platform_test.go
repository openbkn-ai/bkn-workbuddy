package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const testToken = "bak_test_credential"

// fakePlatform imitates the OpenBKN routes the gateway uses, as observed in R0a.
type fakePlatform struct {
	mu           sync.Mutex
	calls        []map[string]any
	hostKeys     []string
	lastAuth     string
	lastDomain   string
	lastQuery    string
	capabilities string
	sessionHits  int
	expireOnce   bool
}

func (f *fakePlatform) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/bkn-backend/v1/knowledge-networks", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.lastAuth, f.lastDomain, f.lastQuery = r.Header.Get("Authorization"), r.Header.Get("x-business-domain"), r.URL.RawQuery
		f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error_code":"Public.Unauthorized"}`)
			return
		}
		io.WriteString(w, `{"entries":[{"id":"supply","name":"供应链"}],"total_count":1}`)
	})
	mux.HandleFunc("/api/agent-observability/v1/interactions/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "int_missing") {
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, `{"error":{"code":"resource_not_disclosed"}}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/business-graph") {
			io.WriteString(w, strings.Repeat(" ", maxResponseBytes+10))
			return
		}
		io.WriteString(w, `{"entries":[],"total":0}`)
	})
	mux.HandleFunc("/api/safe/v1/capabilities", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		body := f.capabilities
		f.mu.Unlock()
		if body == "" {
			body = `{"edition":"enterprise","licensed":true,"capabilities":["perm_object_level"],"limits":{"seats":5}}`
		}
		io.WriteString(w, body)
	})
	mux.HandleFunc("/api/agent-retrieval/v1/mcp", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/api/agent-retrieval/v1/mcp/", http.StatusTemporaryRedirect)
	})
	mux.HandleFunc("/api/agent-retrieval/v1/mcp/", func(w http.ResponseWriter, r *http.Request) {
		var msg map[string]any
		_ = json.NewDecoder(r.Body).Decode(&msg)
		method, _ := msg["method"].(string)
		id := msg["id"]
		reply := func(result any) {
			w.Header().Set("content-type", "text/event-stream")
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
			io.WriteString(w, "event: message\ndata: "+string(b)+"\n\n")
		}
		switch method {
		case "initialize":
			f.mu.Lock()
			f.sessionHits++
			f.mu.Unlock()
			w.Header().Set("mcp-session-id", "sess-1")
			w.Header().Set("content-type", "application/json")
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"protocolVersion": "2025-06-18"}})
			w.Write(b)
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			reply(map[string]any{"tools": []any{
				map[string]any{"name": "query_object_instance", "inputSchema": map[string]any{"properties": map[string]any{"kn_id": map[string]any{}, "ot_id": map[string]any{}, "limit": map[string]any{}, "bkn_context": map[string]any{}}}},
				map[string]any{"name": "bkn_start_interaction", "inputSchema": map[string]any{"properties": map[string]any{"conversation_mode": map[string]any{}, "question": map[string]any{}, "agent_name": map[string]any{}, "conversation_id": map[string]any{}}}},
				map[string]any{"name": "run_sql", "inputSchema": map[string]any{"properties": map[string]any{"sql": map[string]any{}, "bkn_context": map[string]any{}}}},
			}})
		case "tools/call":
			f.mu.Lock()
			if f.expireOnce {
				f.expireOnce = false
				f.mu.Unlock()
				w.WriteHeader(http.StatusNotFound)
				return
			}
			params, _ := msg["params"].(map[string]any)
			f.calls = append(f.calls, params)
			f.hostKeys = append(f.hostKeys, r.Header.Get("X-OpenBKN-Host-Conversation-Key"))
			f.mu.Unlock()
			reply(map[string]any{"content": []any{map[string]any{"type": "text", "text": `{"ok":true}`}}})
		}
	})
	return mux
}

func newTestPlatform(t *testing.T) (*Platform, *fakePlatform, *memoryStore) {
	t.Helper()
	fake := &fakePlatform{}
	srv := httptest.NewTLSServer(fake.handler())
	t.Cleanup(srv.Close)
	store := newMemoryStore()
	_ = store.Put(srv.URL, []byte(testToken+"\n"))
	cfg := &Config{Origin: srv.URL, BusinessDomain: "bd_public", HostKeySalt: "salt"}
	p, err := newPlatform(cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	p.client.Transport = srv.Client().Transport // trust the test server's certificate
	return p, fake, store
}

func codeOf(err error) string {
	var ge *GatewayError
	if errors.As(err, &ge) {
		return ge.Code
	}
	var pe *PolicyError
	if errors.As(err, &pe) {
		return "POLICY_REFUSED"
	}
	return "other"
}

func TestCatalogSendsCredentialDomainAndPaging(t *testing.T) {
	p, fake, _ := newTestPlatform(t)
	body, err := p.CatalogPage(100, 50)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(`"total_count":1`)) {
		t.Fatalf("unexpected body %s", body)
	}
	if fake.lastAuth != "Bearer "+testToken || fake.lastDomain != "bd_public" || fake.lastQuery != "limit=50&offset=100" {
		t.Fatalf("auth=%q domain=%q query=%q", fake.lastAuth, fake.lastDomain, fake.lastQuery)
	}
	if _, err := p.CatalogPage(0, 1001); codeOf(err) != "POLICY_REFUSED" {
		t.Fatalf("limit > 1000 must be refused, got %v", err)
	}
}

func TestMissingOrRejectedCredential(t *testing.T) {
	p, _, store := newTestPlatform(t)
	_ = store.Put(p.cfg.Origin, []byte("wrong"))
	if _, err := p.CatalogPage(0, 1); codeOf(err) != "AUTHENTICATION_REQUIRED" {
		t.Fatalf("401 must map to AUTHENTICATION_REQUIRED, got %v", err)
	}
	_ = store.Delete(p.cfg.Origin)
	if _, err := p.CatalogPage(0, 1); codeOf(err) != "AUTHENTICATION_REQUIRED" {
		t.Fatalf("missing credential must map to AUTHENTICATION_REQUIRED, got %v", err)
	}
}

func TestObservationRoutesAndLimits(t *testing.T) {
	p, _, _ := newTestPlatform(t)
	if _, err := p.Observation("operations", "int_abc123"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Observation("operations", "int_missing"); codeOf(err) != "NOT_DISCLOSED" {
		t.Fatalf("404 resource_not_disclosed must map to NOT_DISCLOSED, got %v", err)
	}
	if _, err := p.Observation("business-graph", "int_abc123"); codeOf(err) != "OUTPUT_OVERFLOW" {
		t.Fatalf("oversized body must be refused, got %v", err)
	}
	if _, err := p.Observation("operations", "../../secrets"); codeOf(err) != "POLICY_REFUSED" {
		t.Fatalf("path injection must be refused, got %v", err)
	}
	if _, err := p.Observation("receipts", "int_abc123"); codeOf(err) != "POLICY_REFUSED" {
		t.Fatalf("unknown observation must be refused, got %v", err)
	}
}

func TestCapabilitiesAreReducedToWhatTheBridgeNeeds(t *testing.T) {
	p, fake, _ := newTestPlatform(t)
	for body, want := range map[string]PlatformCapabilities{
		"": {Edition: "enterprise", BusinessProvenance: true},
		`{"edition":"enterprise","licensed":false,"capabilities":[]}`: {Edition: "enterprise"},
		`{"edition":"community","licensed":false,"capabilities":[]}`:  {Edition: "community"},
		`{"edition":"industry","licensed":true}`:                      {Edition: "industry", BusinessProvenance: true},
	} {
		fake.mu.Lock()
		fake.capabilities = body
		fake.mu.Unlock()
		got, err := p.Capabilities()
		if err != nil {
			t.Fatal(err)
		}
		if *got != want {
			t.Fatalf("%s: got %+v, want %+v", body, *got, want)
		}
	}
}

func TestRedirectIsNeverFollowed(t *testing.T) {
	p, _, _ := newTestPlatform(t)
	_, err := p.getJSON("/api/agent-retrieval/v1/mcp", nil)
	if codeOf(err) != "REDIRECT_REFUSED" {
		t.Fatalf("redirect must be refused, got %v", err)
	}
}

func TestToolsAreFilteredToTheAllowlist(t *testing.T) {
	p, _, _ := newTestPlatform(t)
	tools, err := p.Tools()
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, raw := range tools {
		var t struct{ Name string }
		_ = json.Unmarshal(raw, &t)
		names = append(names, t.Name)
	}
	if strings.Join(names, ",") != "query_object_instance,bkn_start_interaction" {
		t.Fatalf("unexpected tools %v", names)
	}
}

func TestCallToolEnforcesPolicyAndHashesHostKey(t *testing.T) {
	p, fake, _ := newTestPlatform(t)
	managed := ManagedContext{KnowledgeNetworkID: "supply", HostTaskKey: "a8731a7e-ad81-4dad-bb80-a4ae7986c236"} // gitleaks:allow fake task key
	ok := map[string]any{"kn_id": "supply", "ot_id": "so", "bkn_context": map[string]any{"conversation_id": "conv_1", "interaction_id": "int_1"}}
	if _, err := p.CallTool("query_object_instance", ok, managed); err != nil {
		t.Fatal(err)
	}
	if len(fake.hostKeys) != 1 || !strings.HasPrefix(fake.hostKeys[0], "wb-") || strings.Contains(fake.hostKeys[0], managed.HostTaskKey) {
		t.Fatalf("host key must be salted and hashed, got %v", fake.hostKeys)
	}
	cases := map[string]struct {
		tool string
		args map[string]any
	}{
		"not allowlisted":      {"run_sql", map[string]any{"sql": "select 1"}},
		"other knowledge net":  {"query_object_instance", map[string]any{"kn_id": "other", "ot_id": "so", "bkn_context": ok["bkn_context"]}},
		"undeclared argument":  {"query_object_instance", map[string]any{"kn_id": "supply", "ot_id": "so", "url": "http://x", "bkn_context": ok["bkn_context"]}},
		"missing context":      {"query_object_instance", map[string]any{"kn_id": "supply", "ot_id": "so"}},
		"wrong agent name":     {"bkn_start_interaction", map[string]any{"conversation_mode": "new", "question": "q", "agent_name": "someone-else"}},
		"extra lifecycle args": {"bkn_start_interaction", map[string]any{"conversation_mode": "new", "question": "q", "agent_name": AgentName, "kn_id": "x"}},
	}
	for name, c := range cases {
		if _, err := p.CallTool(c.tool, c.args, managed); codeOf(err) != "POLICY_REFUSED" {
			t.Errorf("%s: expected POLICY_REFUSED, got %v", name, err)
		}
	}
	if len(fake.calls) != 1 {
		t.Fatalf("refused calls must not reach the platform; platform saw %d calls", len(fake.calls))
	}
	if _, err := p.CallTool("query_object_instance", ok, ManagedContext{KnowledgeNetworkID: "supply", HostTaskKey: "bad key with spaces"}); codeOf(err) != "POLICY_REFUSED" {
		t.Fatalf("malformed host key must be refused, got %v", err)
	}
}

func TestDisallowedToolIsRefusedBeforeAnyNetworkCall(t *testing.T) {
	p, fake, _ := newTestPlatform(t)
	_, err := p.CallTool("run_sql", map[string]any{"sql": "select 1"}, ManagedContext{KnowledgeNetworkID: "supply"})
	if codeOf(err) != "POLICY_REFUSED" {
		t.Fatalf("expected POLICY_REFUSED, got %v", err)
	}
	if fake.sessionHits != 0 {
		t.Fatalf("a refused tool must not open an MCP session; platform saw %d initialize calls", fake.sessionHits)
	}
}

func TestExpiredMCPSessionIsRenewedOnce(t *testing.T) {
	p, fake, _ := newTestPlatform(t)
	if _, err := p.Tools(); err != nil {
		t.Fatal(err)
	}
	fake.expireOnce = true
	args := map[string]any{"kn_id": "supply", "ot_id": "so", "bkn_context": map[string]any{"conversation_id": "conv_1", "interaction_id": "int_1"}}
	if _, err := p.CallTool("query_object_instance", args, ManagedContext{KnowledgeNetworkID: "supply"}); err != nil {
		t.Fatal(err)
	}
	if fake.sessionHits != 2 || len(fake.calls) != 1 {
		t.Fatalf("expected re-initialize and one delivered call, got sessions=%d calls=%d", fake.sessionHits, len(fake.calls))
	}
}

func TestNormalizeOrigin(t *testing.T) {
	good := map[string]string{"https://openbkn-ee.example.test/x?y": "https://openbkn-ee.example.test", "http://127.0.0.1:9000": "http://127.0.0.1:9000"}
	for in, want := range good {
		if got, err := normalizeOrigin(in); err != nil || got != want {
			t.Errorf("%s: got %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"http://openbkn-ee.example.test", "https://u:p@h.example", "ftp://h", "not a url"} {
		if _, err := normalizeOrigin(bad); err == nil {
			t.Errorf("%s must be rejected", bad)
		}
	}
}

func TestValidCredential(t *testing.T) {
	for s, want := range map[string]bool{
		testToken: true, "bak_AbC-123._~": true, "": false, "two words": false, "tab\there": false, "中文": false, "x\x7f": false,
	} {
		if got := validCredential(s); got != want {
			t.Errorf("validCredential(%q) = %v, want %v", s, got, want)
		}
	}
}

func TestMalformedStoredCredentialIsAnAuthenticationProblem(t *testing.T) {
	p, _, store := newTestPlatform(t)
	_ = store.Put(p.cfg.Origin, []byte("pasted with spaces"))
	if _, err := p.CatalogPage(0, 1); codeOf(err) != "AUTHENTICATION_REQUIRED" {
		t.Fatalf("got %v", err)
	}
}

func TestUntrustedCertificateIsReportedAsSuch(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	t.Cleanup(srv.Close)
	store := newMemoryStore()
	_ = store.Put(srv.URL, []byte(testToken))
	p, err := newPlatform(&Config{Origin: srv.URL, BusinessDomain: "bd_public", HostKeySalt: "s"}, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.CatalogPage(0, 1); codeOf(err) != "CERTIFICATE_ERROR" {
		t.Fatalf("got %v", err)
	}
}
