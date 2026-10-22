// bkn-gateway: the signed credential gateway of the OpenBKN WorkBuddy adapter.
// It is the only component that holds the OpenBKN credential and the only one that
// talks to the platform with it (decision §0.9, evidence r1-credential-probe-c2.md).
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

var version = "0.0.0-dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "login":
		err = cmdLogin(os.Args[2:], os.Stdin, os.Stdout)
	case "logout":
		err = cmdLogout()
	case "status":
		err = cmdStatus(os.Stdout)
	case "serve":
		err = cmdServe(os.Stdin, os.Stdout)
	case "version":
		fmt.Println(version)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "bkn-gateway:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  bkn-gateway login --origin <https://...> [--business-domain bd_public] [--ca-file <pem>] [--no-verify]
                    (reads the credential, e.g. an OpenBKN AppKey, from stdin; never pass it as an argument)
  bkn-gateway status
  bkn-gateway logout
  bkn-gateway serve   (line-delimited JSON on stdin/stdout, for the bridge)
  bkn-gateway version`)
}

func cmdLogin(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	origin := fs.String("origin", "", "OpenBKN platform address")
	domain := fs.String("business-domain", "bd_public", "OpenBKN business domain")
	caFile := fs.String("ca-file", "", "extra PEM CA bundle for private deployments")
	noVerify := fs.Bool("no-verify", false, "store without checking the credential against the platform")
	if err := fs.Parse(args); err != nil {
		return err
	}
	normalized, err := normalizeOrigin(*origin)
	if err != nil {
		return err
	}
	secret, err := bufio.NewReader(io.LimitReader(stdin, 16<<10)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return errors.New("no credential on stdin")
	}
	if !validCredential(secret) {
		return errors.New("the credential contains spaces or characters a token cannot have; check what was pasted")
	}
	cfg, _ := loadConfig()
	salt := ""
	if cfg != nil && cfg.Origin == normalized {
		salt = cfg.HostKeySalt
	}
	if salt == "" {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		salt = hex.EncodeToString(b)
	}
	next := &Config{Origin: normalized, BusinessDomain: strings.TrimSpace(*domain), CAFile: *caFile, HostKeySalt: salt}
	store, err := newPlatformStore()
	if err != nil {
		return err
	}
	if err := store.Put(normalized, []byte(secret)); err != nil {
		return err
	}
	secret = ""
	if err := saveConfig(next); err != nil {
		return err
	}
	if *noVerify {
		fmt.Fprintln(stdout, "credential stored (not verified)")
		return nil
	}
	p, err := newPlatform(next, store)
	if err != nil {
		return err
	}
	if _, err := p.CatalogPage(0, 1); err != nil {
		return fmt.Errorf("credential stored, but the platform check failed: %w", err)
	}
	fmt.Fprintln(stdout, "credential stored and verified")
	return nil
}

func cmdLogout() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	store, err := newPlatformStore()
	if err != nil {
		return err
	}
	return store.Delete(cfg.Origin)
}

func statusOf(cfg *Config, store CredentialStore) map[string]any {
	out := map[string]any{"version": version, "configured": cfg != nil}
	if cfg == nil {
		return out
	}
	out["origin"] = cfg.Origin
	out["businessDomain"] = cfg.BusinessDomain
	_, err := store.Get(cfg.Origin)
	out["credential"] = err == nil
	if err != nil && !errors.Is(err, ErrNoCredential) {
		out["credentialError"] = "credential store unavailable"
	}
	return out
}

func cmdStatus(stdout io.Writer) error {
	cfg, _ := loadConfig()
	store, err := newPlatformStore()
	if err != nil {
		return err
	}
	s := statusOf(cfg, store)
	for _, k := range []string{"version", "configured", "origin", "businessDomain", "credential", "credentialError"} {
		if v, ok := s[k]; ok {
			fmt.Fprintf(stdout, "%s: %v\n", k, v)
		}
	}
	return nil
}

func cmdServe(stdin io.Reader, stdout io.Writer) error {
	cfg, err := loadConfig()
	if err != nil {
		return fmt.Errorf("not configured; run login first (%w)", err)
	}
	store, err := newPlatformStore()
	if err != nil {
		return err
	}
	p, err := newPlatform(cfg, store)
	if err != nil {
		return err
	}
	return serve(stdin, stdout, p, func() any { return statusOf(cfg, store) })
}
