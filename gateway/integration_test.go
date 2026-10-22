//go:build integration

package main

// Live check against a real OpenBKN deployment. The credential is taken from the
// environment of this test process only (kept in a memory store), so running it
// never writes a credential to disk or to the keychain:
//
//	BKN_IT_ORIGIN=https://openbkn-ee.example.test BKN_IT_CA_FILE=<pem> BKN_IT_KN=supply_ontology_hand \
//	BKN_IT_TOKEN="$(openbkn auth token)" go test -tags integration -run Live -v ./...

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestLiveGatewayAgainstPlatform(t *testing.T) {
	origin, token, kn := os.Getenv("BKN_IT_ORIGIN"), os.Getenv("BKN_IT_TOKEN"), os.Getenv("BKN_IT_KN")
	if origin == "" || token == "" || kn == "" {
		t.Skip("BKN_IT_ORIGIN, BKN_IT_TOKEN and BKN_IT_KN are required")
	}
	store := newMemoryStore()
	_ = store.Put(origin, []byte(token))
	cfg := &Config{Origin: origin, BusinessDomain: "bd_public", CAFile: os.Getenv("BKN_IT_CA_FILE"), HostKeySalt: "it-salt"}
	p, err := newPlatform(cfg, store)
	if err != nil {
		t.Fatal(err)
	}

	page, err := p.CatalogPage(0, 100)
	if err != nil {
		var ge *GatewayError
		if errors.As(err, &ge) {
			t.Fatalf("catalog: %s (http %d, platform code %q, credential length %d)", ge.Code, ge.HTTPStatus, ge.PlatformCode, len(token))
		}
		t.Fatalf("catalog: %v", err)
	}
	if !strings.Contains(string(page), `"`+kn+`"`) {
		t.Fatalf("catalog does not list %s", kn)
	}

	tools, err := p.Tools()
	if err != nil {
		t.Fatalf("tools: %v", err)
	}
	if len(tools) != len(readV1Tools)+len(lifecycleTools) {
		t.Fatalf("expected %d allowlisted tools, got %d", len(readV1Tools)+len(lifecycleTools), len(tools))
	}

	managed := ManagedContext{KnowledgeNetworkID: kn, HostTaskKey: "it-task-" + strings.ReplaceAll(t.Name(), "/", "-")}
	start, err := p.CallTool("bkn_start_interaction", map[string]any{"conversation_mode": "new", "question": "R1 gateway integration check", "agent_name": AgentName}, managed)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	ids := firstJSON(t, start)
	interactionID, conversationID := ids["interaction_id"], ids["conversation_id"]
	if interactionID == nil || conversationID == nil {
		t.Fatalf("start returned no ids: %s", start)
	}
	ctx := map[string]any{"conversation_id": conversationID, "interaction_id": interactionID}
	finish := func(outcome, answer string) {
		args := map[string]any{"interaction_id": interactionID, "outcome": outcome}
		if answer != "" {
			args["answer"] = answer
		} else {
			args["reason"] = "integration test aborted"
		}
		if _, err := p.CallTool("bkn_finish_interaction", args, managed); err != nil {
			t.Errorf("finish: %v", err)
		}
	}

	res, err := p.CallTool("query_object_instance", map[string]any{
		"kn_id": kn, "ot_id": kn + "_salesorder", "limit": 1, "response_format": "json", "bkn_context": ctx,
		"condition": map[string]any{"field": "product_code", "operation": "==", "value": "382-000005", "value_from": "const"},
	}, managed)
	if err != nil {
		finish("failed", "")
		t.Fatalf("query: %v", err)
	}
	if strings.Contains(string(res), `"isError":true`) {
		finish("failed", "")
		t.Fatalf("query returned a tool error: %s", res)
	}
	if _, err := p.CallTool("run_sql", map[string]any{"sql": "select 1", "bkn_context": ctx}, managed); codeOf(err) != "POLICY_REFUSED" {
		t.Errorf("run_sql must be refused locally, got %v", err)
	}
	finish("completed", "R1 gateway integration check completed.")

	ops, err := p.Observation("operations", interactionID.(string))
	if err != nil {
		t.Fatalf("operations: %v", err)
	}
	if !strings.Contains(string(ops), "query_object_instance") {
		t.Fatalf("operations do not list the query: %s", ops)
	}
	if _, err := p.Observation("business-graph", interactionID.(string)); err != nil {
		t.Fatalf("business-graph: %v", err)
	}
	t.Logf("interaction %s closed; operations and business graph readable", interactionID)
}

func firstJSON(t *testing.T, result json.RawMessage) map[string]any {
	t.Helper()
	var r struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(result, &r); err != nil {
		t.Fatalf("bad MCP result: %s", result)
	}
	for _, c := range r.Content {
		var m map[string]any
		if c.Type == "text" && json.Unmarshal([]byte(c.Text), &m) == nil {
			return m
		}
	}
	t.Fatalf("no JSON content in %s", result)
	return nil
}
