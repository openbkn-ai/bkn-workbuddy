package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
)

// Line protocol between the Node bridge and the gateway, one JSON object per line.
//
//	request:  {"id": 7, "op": "mcp.call", "params": {...}}
//	response: {"id": 7, "ok": true, "result": ...}
//	          {"id": 7, "ok": false, "error": {"code": "...", "message": "..."}}
type request struct {
	ID     json.RawMessage `json:"id"`
	Op     string          `json:"op"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID     json.RawMessage `json:"id"`
	OK     bool            `json:"ok"`
	Result any             `json:"result,omitempty"`
	Error  *GatewayError   `json:"error,omitempty"`
}

type platformAPI interface {
	CatalogPage(offset, limit int) (json.RawMessage, error)
	Observation(kind, interactionID string) (json.RawMessage, error)
	Capabilities() (*PlatformCapabilities, error)
	Tools() ([]json.RawMessage, error)
	CallTool(name string, args map[string]any, managed ManagedContext) (json.RawMessage, error)
}

func serve(in io.Reader, out io.Writer, api platformAPI, status func() any) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	enc := json.NewEncoder(out)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			_ = enc.Encode(response{ID: json.RawMessage("null"), Error: gwErr("BAD_REQUEST", "request is not valid JSON")})
			continue
		}
		result, err := dispatch(api, status, req)
		resp := response{ID: req.ID, OK: err == nil, Result: result}
		if err != nil {
			resp.Result = nil
			resp.Error = toGatewayError(err)
		}
		if err := enc.Encode(resp); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func dispatch(api platformAPI, status func() any, req request) (any, error) {
	switch req.Op {
	case "status":
		return status(), nil
	case "catalog.page":
		var p struct{ Offset, Limit int }
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, gwErr("BAD_REQUEST", "catalog.page needs offset and limit")
		}
		return api.CatalogPage(p.Offset, p.Limit)
	case "obs.operations", "obs.businessGraph":
		var p struct {
			InteractionID string `json:"interactionId"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, gwErr("BAD_REQUEST", "interactionId is required")
		}
		kind := "operations"
		if req.Op == "obs.businessGraph" {
			kind = "business-graph"
		}
		return api.Observation(kind, p.InteractionID)
	case "platform.capabilities":
		return api.Capabilities()
	case "mcp.tools":
		return api.Tools()
	case "mcp.call":
		var p struct {
			Tool      string         `json:"tool"`
			Arguments map[string]any `json:"arguments"`
			Managed   ManagedContext `json:"managed"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Tool == "" {
			return nil, gwErr("BAD_REQUEST", "mcp.call needs tool, arguments and managed context")
		}
		if p.Arguments == nil {
			p.Arguments = map[string]any{}
		}
		return api.CallTool(p.Tool, p.Arguments, p.Managed)
	default:
		return nil, gwErr("BAD_REQUEST", "unknown op")
	}
}

func toGatewayError(err error) *GatewayError {
	var ge *GatewayError
	if errors.As(err, &ge) {
		return ge
	}
	var pe *PolicyError
	if errors.As(err, &pe) {
		return &GatewayError{Code: "POLICY_REFUSED", Message: pe.Msg}
	}
	return &GatewayError{Code: "INTERNAL", Message: "gateway error"}
}
