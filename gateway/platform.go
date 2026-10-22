package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Fixed routes (R0a): MCP needs the trailing slash (the bare path 307-redirects before auth);
// never follow redirects and never use the `endpoint` advertised by /mcp/info.
const (
	pathMCP          = "/api/agent-retrieval/v1/mcp/"
	pathCatalog      = "/api/bkn-backend/v1/knowledge-networks"
	pathObservations = "/api/agent-observability/v1/interactions/"
	pathCapabilities = "/api/safe/v1/capabilities"
	maxResponseBytes = 8 << 20
)

// GatewayError is returned to the bridge with a stable code; platform bodies are never passed through.
type GatewayError struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	HTTPStatus   int    `json:"httpStatus,omitempty"`
	PlatformCode string `json:"platformCode,omitempty"`
}

func (e *GatewayError) Error() string { return e.Code + ": " + e.Message }

func gwErr(code, msg string) *GatewayError { return &GatewayError{Code: code, Message: msg} }

// Platform performs every authenticated request. The credential is read from the
// store per request and never leaves this process.
type Platform struct {
	cfg        *Config
	store      CredentialStore
	client     *http.Client
	session    string
	protocol   string
	nextID     int
	toolSchema map[string]map[string]bool
	tools      []json.RawMessage
}

func newPlatform(cfg *Config, store CredentialStore) (*Platform, error) {
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("cannot read CA file: %w", err)
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA file contains no PEM certificates")
		}
	}
	transport := &http.Transport{
		TLSClientConfig:       &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		Proxy:                 http.ProxyFromEnvironment,
		ResponseHeaderTimeout: 60 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   120 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return gwErr("REDIRECT_REFUSED", "the platform answered with a redirect; refusing to follow it with credentials")
		},
	}
	return &Platform{cfg: cfg, store: store, client: client}, nil
}

func (p *Platform) credential() (string, error) {
	secret, err := p.store.Get(p.cfg.Origin)
	if err != nil {
		if errors.Is(err, ErrNoCredential) {
			return "", &GatewayError{Code: "AUTHENTICATION_REQUIRED", Message: err.Error()}
		}
		return "", gwErr("CREDENTIAL_STORE_ERROR", err.Error())
	}
	return strings.TrimSpace(string(secret)), nil
}

func (p *Platform) do(method, path string, query url.Values, body []byte, headers map[string]string) (*http.Response, error) {
	u := p.cfg.Origin + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, u, reader)
	if err != nil {
		return nil, gwErr("INTERNAL", "cannot build request")
	}
	token, err := p.credential()
	if err != nil {
		return nil, err
	}
	if !validCredential(token) {
		return nil, gwErr("AUTHENTICATION_REQUIRED", "the stored credential is malformed; log in again")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("x-business-domain", p.cfg.BusinessDomain)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		var ge *GatewayError
		if errors.As(err, &ge) {
			return nil, ge
		}
		return nil, transportError(err)
	}
	return resp, nil
}

// readCapped reads the whole body, refusing anything above maxResponseBytes.
func readCapped(r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxResponseBytes+1))
	if err != nil {
		return nil, gwErr("PLATFORM_UNAVAILABLE", "reading the platform response failed")
	}
	if len(data) > maxResponseBytes {
		return nil, gwErr("OUTPUT_OVERFLOW", "platform response exceeded the gateway limit")
	}
	return data, nil
}

func statusError(resp *http.Response, body []byte) *GatewayError {
	e := &GatewayError{HTTPStatus: resp.StatusCode}
	var env struct {
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
		Code      string `json:"code"`
		ErrorCode string `json:"error_code"`
	}
	if json.Unmarshal(body, &env) == nil {
		switch {
		case env.Error != nil:
			e.PlatformCode = env.Error.Code
		case env.Code != "":
			e.PlatformCode = env.Code
		case env.ErrorCode != "":
			e.PlatformCode = env.ErrorCode
		}
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		e.Code, e.Message = "AUTHENTICATION_REQUIRED", "OpenBKN rejected the stored credential; log in again"
	case resp.StatusCode == http.StatusForbidden:
		e.Code, e.Message = "FORBIDDEN", "OpenBKN denied this request for the current account or business domain"
	case resp.StatusCode == http.StatusNotFound && e.PlatformCode == "resource_not_disclosed":
		e.Code, e.Message = "NOT_DISCLOSED", "the requested record is not disclosed to this account"
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		e.Code, e.Message = "REDIRECT_REFUSED", "the platform answered with a redirect"
	default:
		e.Code, e.Message = "PLATFORM_ERROR", fmt.Sprintf("OpenBKN answered HTTP %d", resp.StatusCode)
	}
	return e
}

func (p *Platform) getJSON(path string, query url.Values) (json.RawMessage, error) {
	resp, err := p.do(http.MethodGet, path, query, nil, map[string]string{"accept": "application/json"})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := readCapped(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, statusError(resp, body)
	}
	if !json.Valid(body) {
		return nil, gwErr("INVALID_RESPONSE", "platform returned invalid JSON")
	}
	return body, nil
}

// CatalogPage reads one page of the caller's visible knowledge networks.
func (p *Platform) CatalogPage(offset, limit int) (json.RawMessage, error) {
	if offset < 0 || limit < 1 || limit > 1000 {
		return nil, refuse("offset must be >= 0 and limit 1..1000")
	}
	return p.getJSON(pathCatalog, url.Values{"offset": {strconv.Itoa(offset)}, "limit": {strconv.Itoa(limit)}})
}

// Observation reads operations or business-graph for one interaction.
func (p *Platform) Observation(kind, interactionID string) (json.RawMessage, error) {
	if kind != "operations" && kind != "business-graph" {
		return nil, refuse("unknown observation %q", kind)
	}
	if !interactionIDPattern.MatchString(interactionID) {
		return nil, refuse("interaction id is malformed")
	}
	return p.getJSON(pathObservations+interactionID+"/"+kind, nil)
}

// PlatformCapabilities is the part of the platform entitlement the bridge needs:
// whether Studio offers the business provenance page (Enterprise). The raw
// response is not passed on.
type PlatformCapabilities struct {
	Edition            string `json:"edition,omitempty"`
	BusinessProvenance bool   `json:"businessProvenance"`
}

// Capabilities reads the entitlement snapshot that Studio's edition guard uses.
// The endpoint never lists business provenance (bkn-trace implements it outside
// bkn-safe's assembly table), so this applies Studio's own rule for that page
// (bkn-studio capabilitySatisfied, reportedByEndpoint=false): an Enterprise or
// higher edition with a valid license.
func (p *Platform) Capabilities() (*PlatformCapabilities, error) {
	body, err := p.getJSON(pathCapabilities, nil)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Edition  any `json:"edition"`
		Licensed any `json:"licensed"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, gwErr("INVALID_RESPONSE", "platform capabilities are not an object")
	}
	out := &PlatformCapabilities{}
	if edition, ok := raw.Edition.(string); ok && len(edition) <= 32 {
		out.Edition = edition
	}
	licensed, _ := raw.Licensed.(bool)
	out.BusinessProvenance = licensed && (out.Edition == "enterprise" || out.Edition == "industry")
	return out, nil
}

// ---- MCP (Streamable HTTP) ----

type rpcReply struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (p *Platform) rpc(method string, params any, headers map[string]string, notify bool) (*rpcReply, error) {
	msg := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		msg["params"] = params
	}
	var id int
	if !notify {
		p.nextID++
		id = p.nextID
		msg["id"] = id
	}
	body, _ := json.Marshal(msg)
	h := map[string]string{"content-type": "application/json", "accept": "application/json, text/event-stream"}
	if p.session != "" {
		h["mcp-session-id"] = p.session
	}
	if p.protocol != "" {
		h["mcp-protocol-version"] = p.protocol
	}
	for k, v := range headers {
		h[k] = v
	}
	resp, err := p.do(http.MethodPost, pathMCP, nil, body, h)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("mcp-session-id"); sid != "" {
		p.session = sid
	}
	if resp.StatusCode >= 300 {
		b, _ := readCapped(resp.Body)
		return nil, statusError(resp, b)
	}
	if notify {
		io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponseBytes))
		return nil, nil
	}
	return readReply(resp, id)
}

// readReply accepts plain JSON or an SSE stream, returning as soon as the reply
// with our id arrives (the stream may stay open afterwards, R0a §1).
func readReply(resp *http.Response, id int) (*rpcReply, error) {
	want := strconv.Itoa(id)
	match := func(data []byte) (*rpcReply, bool) {
		var r rpcReply
		if json.Unmarshal(data, &r) == nil && string(r.ID) == want {
			return &r, true
		}
		return nil, false
	}
	if !strings.Contains(resp.Header.Get("content-type"), "text/event-stream") {
		body, err := readCapped(resp.Body)
		if err != nil {
			return nil, err
		}
		if r, ok := match(body); ok {
			return r, nil
		}
		return nil, gwErr("INVALID_RESPONSE", "MCP reply missing")
	}
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, maxResponseBytes))
	scanner.Buffer(make([]byte, 64<<10), maxResponseBytes)
	var data bytes.Buffer
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "data:"):
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		case line == "":
			if data.Len() > 0 {
				if r, ok := match(data.Bytes()); ok {
					return r, nil
				}
				data.Reset()
			}
		}
	}
	if data.Len() > 0 {
		if r, ok := match(data.Bytes()); ok {
			return r, nil
		}
	}
	return nil, gwErr("INVALID_RESPONSE", "MCP stream ended without a reply")
}

func (p *Platform) ensureSession() error {
	if p.session != "" && p.toolSchema != nil {
		return nil
	}
	r, err := p.rpc("initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "bkn-workbuddy-gateway", "version": version},
	}, nil, false)
	if err != nil {
		return err
	}
	if r.Error != nil {
		return gwErr("MCP_ERROR", "initialize failed: "+r.Error.Message)
	}
	var init struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(r.Result, &init)
	p.protocol = init.ProtocolVersion
	if _, err := p.rpc("notifications/initialized", nil, nil, true); err != nil {
		return err
	}
	return p.loadTools()
}

func (p *Platform) loadTools() error {
	r, err := p.rpc("tools/list", map[string]any{}, nil, false)
	if err != nil {
		return err
	}
	if r.Error != nil {
		return gwErr("MCP_ERROR", "tools/list failed: "+r.Error.Message)
	}
	var list struct {
		Tools []json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(r.Result, &list); err != nil {
		return gwErr("INVALID_RESPONSE", "tools/list result is invalid")
	}
	schema := map[string]map[string]bool{}
	var kept []json.RawMessage
	for _, raw := range list.Tools {
		var t struct {
			Name        string `json:"name"`
			InputSchema struct {
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"inputSchema"`
		}
		if json.Unmarshal(raw, &t) != nil || !(readV1Tools[t.Name] || lifecycleTools[t.Name]) {
			continue
		}
		props := map[string]bool{}
		for k := range t.InputSchema.Properties {
			props[k] = true
		}
		schema[t.Name] = props
		kept = append(kept, raw)
	}
	p.toolSchema, p.tools = schema, kept
	return nil
}

// Tools returns only the allowlisted tools with the platform's own schemas.
func (p *Platform) Tools() ([]json.RawMessage, error) {
	if err := p.ensureSession(); err != nil {
		return nil, err
	}
	return p.tools, nil
}

// CallTool forwards one allowlisted MCP call. The result is the MCP `result`
// object verbatim (tool errors arrive as isError results, R0a §3).
func (p *Platform) CallTool(name string, args map[string]any, managed ManagedContext) (json.RawMessage, error) {
	// Refuse tools outside the allowlist before any network traffic.
	if !readV1Tools[name] && !lifecycleTools[name] {
		return nil, refuse("tool %q is not allowed by this adapter", name)
	}
	if err := p.ensureSession(); err != nil {
		return nil, err
	}
	props, known := p.toolSchema[name]
	if !known && !lifecycleTools[name] {
		return nil, refuse("tool %q is not available on this platform or not allowed", name)
	}
	if err := checkToolCall(name, args, props, managed); err != nil {
		return nil, err
	}
	headers := map[string]string{}
	if managed.HostTaskKey != "" {
		if !hostKeyPattern.MatchString(managed.HostTaskKey) {
			return nil, refuse("host task key is malformed")
		}
		sum := sha256.Sum256([]byte(p.cfg.HostKeySalt + ":" + managed.HostTaskKey))
		headers["X-OpenBKN-Host-Conversation-Key"] = "wb-" + hex.EncodeToString(sum[:16])
	}
	call := func() (*rpcReply, error) {
		return p.rpc("tools/call", map[string]any{"name": name, "arguments": args}, headers, false)
	}
	r, err := call()
	var ge *GatewayError
	if errors.As(err, &ge) && ge.HTTPStatus == http.StatusNotFound {
		// MCP session expired on the platform: start a new one once.
		p.session, p.toolSchema = "", nil
		if err := p.ensureSession(); err != nil {
			return nil, err
		}
		r, err = call()
	}
	if err != nil {
		return nil, err
	}
	if r.Error != nil {
		return nil, gwErr("MCP_ERROR", r.Error.Message)
	}
	return r.Result, nil
}

// validCredential accepts printable ASCII without spaces, the shape of OpenBKN
// access tokens and AppKeys. A mis-paste fails at login instead of surfacing
// later as a misleading network error (host acceptance, Windows, 2026-10-20).
func validCredential(s string) bool {
	if s == "" || len(s) > 8192 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// transportError separates certificate problems and timeouts from an unreachable platform.
func transportError(err error) *GatewayError {
	var unknownCA x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	if errors.As(err, &unknownCA) || errors.As(err, &hostname) || errors.As(err, &invalid) {
		return gwErr("CERTIFICATE_ERROR", "the platform certificate is not trusted; check the CA file and platform address")
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return gwErr("PLATFORM_UNAVAILABLE", "the platform did not respond in time")
	}
	return gwErr("PLATFORM_UNAVAILABLE", "OpenBKN platform is unreachable")
}
