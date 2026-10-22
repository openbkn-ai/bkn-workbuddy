package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

type stubAPI struct{ lastTool string }

func (s *stubAPI) CatalogPage(offset, limit int) (json.RawMessage, error) {
	return json.RawMessage(`{"entries":[],"total_count":0}`), nil
}
func (s *stubAPI) Capabilities() (*PlatformCapabilities, error) {
	return &PlatformCapabilities{Edition: "enterprise", BusinessProvenance: true}, nil
}

func (s *stubAPI) Observation(kind, id string) (json.RawMessage, error) {
	return nil, refuse("no")
}
func (s *stubAPI) Tools() ([]json.RawMessage, error) { return []json.RawMessage{json.RawMessage(`{"name":"x"}`)}, nil }
func (s *stubAPI) CallTool(name string, args map[string]any, m ManagedContext) (json.RawMessage, error) {
	s.lastTool = name
	return json.RawMessage(`{"content":[]}`), nil
}

func TestServeLineProtocol(t *testing.T) {
	in := strings.Join([]string{
		`{"id":1,"op":"status"}`,
		`{"id":2,"op":"catalog.page","params":{"offset":0,"limit":10}}`,
		`{"id":3,"op":"obs.operations","params":{"interactionId":"int_1"}}`,
		`{"id":"x","op":"mcp.call","params":{"tool":"query_object_instance","arguments":{},"managed":{"knowledgeNetworkId":"k"}}}`,
		`not json`,
		`{"id":5,"op":"nope"}`,
	}, "\n") + "\n"
	var out bytes.Buffer
	api := &stubAPI{}
	if err := serve(strings.NewReader(in), &out, api, func() any { return map[string]any{"credential": true} }); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 6 {
		t.Fatalf("expected 6 responses, got %d: %s", len(lines), out.String())
	}
	var r []map[string]any
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("bad response line %q", l)
		}
		r = append(r, m)
	}
	want := []bool{true, true, false, true, false, false}
	for i, w := range want {
		if r[i]["ok"] != w {
			t.Errorf("response %d ok=%v, want %v: %s", i, r[i]["ok"], w, lines[i])
		}
	}
	if code := r[2]["error"].(map[string]any)["code"]; code != "POLICY_REFUSED" {
		t.Errorf("policy refusal code = %v", code)
	}
	if r[3]["id"] != "x" || api.lastTool != "query_object_instance" {
		t.Errorf("string ids must round-trip and calls must dispatch")
	}
	if strings.Contains(out.String(), "bak_") {
		t.Errorf("responses must never contain credentials")
	}
}
