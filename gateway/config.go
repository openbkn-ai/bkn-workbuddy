package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Config holds non-secret settings only. The credential lives in the platform
// credential store (see store_*.go), never in this file.
type Config struct {
	Origin         string `json:"origin"`
	BusinessDomain string `json:"businessDomain"`
	// CAFile optionally adds a PEM bundle to the system roots (private CA deployments).
	CAFile string `json:"caFile,omitempty"`
	// HostKeySalt makes the host conversation key sent to OpenBKN unguessable (R0a §4).
	HostKeySalt string `json:"hostKeySalt"`
}

// configDir is the adapter's per-user data root, shared with the Node bridge
// (packages/bridge/src/paths.ts): ~/.bkn-workbuddy on every platform. WorkBuddy
// runs the gateway inside its sandbox, which on Windows hides everything under
// %LOCALAPPDATA% while dot-directories in the user's home stay visible (host
// acceptance run2, 2026-10-20).
func configDir() (string, error) {
	if dir := os.Getenv("BKN_GATEWAY_CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".bkn-workbuddy"), nil
}

func configPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gateway.json"), nil
}

func loadConfig() (*Config, error) {
	path, err := configPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("gateway config is not valid JSON: %w", err)
	}
	origin, err := normalizeOrigin(cfg.Origin)
	if err != nil {
		return nil, err
	}
	cfg.Origin = origin
	if strings.TrimSpace(cfg.BusinessDomain) == "" {
		return nil, errors.New("gateway config has no business domain")
	}
	return &cfg, nil
}

func saveConfig(cfg *Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// normalizeOrigin accepts https, or http on loopback only, and strips everything but the origin.
func normalizeOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", errors.New("platform address is not a valid URL")
	}
	if u.User != nil {
		return "", errors.New("platform address must not contain credentials")
	}
	host := u.Hostname()
	loopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return "", errors.New("platform address must use https (http is allowed only on loopback)")
	}
	return u.Scheme + "://" + u.Host, nil
}
