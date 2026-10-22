package main

import (
	"fmt"
	"regexp"
)

// The gateway is the security boundary: anything it allows, a local process that
// runs the gateway binary directly can also do (R1-C2 W3). Keep this list in sync
// with packages/core/src/tool-contract.ts (read-v1, decision D1).
var readV1Tools = map[string]bool{
	"get_kn_detail":               true,
	"search_schema":               true,
	"get_object_types":            true,
	"get_relation_types":          true,
	"query_object_instance":       true,
	"query_instance_subgraph":     true,
	"query_metric":                true,
	"get_logic_properties_values": true,
}

var lifecycleTools = map[string]bool{
	"bkn_start_interaction":  true,
	"bkn_finish_interaction": true,
}

// AgentName is the stable lifecycle identity this adapter writes to OpenBKN Trace.
const AgentName = "bkn-agent-workbuddy"

var (
	interactionIDPattern = regexp.MustCompile(`^int_[A-Za-z0-9]{1,128}$`)
	hostKeyPattern       = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
)

// PolicyError is a refusal by the gateway itself; nothing was sent to the platform.
type PolicyError struct{ Msg string }

func (e *PolicyError) Error() string { return e.Msg }

func refuse(format string, args ...any) error { return &PolicyError{Msg: fmt.Sprintf(format, args...)} }

// checkToolCall validates one MCP tools/call before it leaves the machine.
// schemaProps holds the top-level property names the platform declared for the tool
// (from tools/list); an unknown key is refused rather than forwarded.
func checkToolCall(name string, args map[string]any, schemaProps map[string]bool, managed ManagedContext) error {
	switch {
	case readV1Tools[name]:
		for key := range args {
			if !schemaProps[key] {
				return refuse("argument %q is not declared by the platform for %s", key, name)
			}
		}
		if knID, _ := args["kn_id"].(string); knID == "" || knID != managed.KnowledgeNetworkID {
			return refuse("kn_id must equal the bound knowledge network")
		}
		if name == "get_logic_properties_values" {
			if _, present := args["llm_model"]; present {
				return refuse("llm_model is not allowed")
			}
		}
		ctx, ok := args["bkn_context"].(map[string]any)
		if !ok {
			return refuse("bkn_context is required")
		}
		if id, _ := ctx["interaction_id"].(string); !interactionIDPattern.MatchString(id) {
			return refuse("bkn_context.interaction_id is malformed")
		}
		return nil
	case name == "bkn_start_interaction":
		for key := range args {
			if key != "conversation_mode" && key != "conversation_id" && key != "question" && key != "agent_name" {
				return refuse("argument %q is not allowed for %s", key, name)
			}
		}
		if args["agent_name"] != AgentName {
			return refuse("agent_name must be %q", AgentName)
		}
		return nil
	case name == "bkn_finish_interaction":
		for key := range args {
			if key != "interaction_id" && key != "outcome" && key != "answer" && key != "reason" {
				return refuse("argument %q is not allowed for %s", key, name)
			}
		}
		if id, _ := args["interaction_id"].(string); !interactionIDPattern.MatchString(id) {
			return refuse("interaction_id is malformed")
		}
		return nil
	default:
		return refuse("tool %q is not allowed by this adapter", name)
	}
}

// ManagedContext is what the bridge claims about the current call. The gateway
// cannot verify WorkBuddy task identity; it only enforces shape and the bound KN.
type ManagedContext struct {
	KnowledgeNetworkID string `json:"knowledgeNetworkId"`
	HostTaskKey        string `json:"hostTaskKey"`
}
