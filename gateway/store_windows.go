//go:build windows && !devstore

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// DPAPI, user scope. Same-user processes can decrypt; this protects against other
// users and offline copies only. Documented as a Windows limitation (R1 §0.9).
var (
	crypt32                = syscall.NewLazyDLL("crypt32.dll")
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCryptProtectData   = crypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
	procLocalFree          = kernel32.NewProc("LocalFree")
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

const cryptprotectUIForbidden = 0x1

func newBlob(d []byte) *dataBlob {
	if len(d) == 0 {
		return &dataBlob{}
	}
	return &dataBlob{cbData: uint32(len(d)), pbData: &d[0]}
}

func (b *dataBlob) bytes() []byte {
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	return out
}

var entropy = []byte("com.openbkn.bkn-workbuddy.gateway")

func dpapi(proc *syscall.LazyProc, in []byte) ([]byte, error) {
	var out dataBlob
	r, _, err := proc.Call(uintptr(unsafe.Pointer(newBlob(in))), 0, uintptr(unsafe.Pointer(newBlob(entropy))), 0, 0, cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.bytes(), nil
}

type dpapiStore struct{ dir string }

func newPlatformStore() (CredentialStore, error) {
	base, err := configDir()
	if err != nil {
		return nil, err
	}
	return dpapiStore{dir: filepath.Join(base, "credentials")}, nil
}

func (s dpapiStore) path(origin string) string {
	sum := sha256.Sum256([]byte(origin))
	return filepath.Join(s.dir, hex.EncodeToString(sum[:8])+".bin")
}

func (s dpapiStore) Put(origin string, secret []byte) error {
	if len(secret) == 0 {
		return fmt.Errorf("empty credential")
	}
	enc, err := dpapi(procCryptProtectData, secret)
	if err != nil {
		return fmt.Errorf("DPAPI encrypt failed: %w", err)
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	tmp := s.path(origin) + ".tmp"
	if err := os.WriteFile(tmp, enc, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path(origin))
}

func (s dpapiStore) Get(origin string) ([]byte, error) {
	enc, err := os.ReadFile(s.path(origin))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoCredential
	}
	if err != nil {
		return nil, err
	}
	plain, err := dpapi(procCryptUnprotectData, enc)
	if err != nil {
		return nil, fmt.Errorf("DPAPI decrypt failed: %w", err)
	}
	return plain, nil
}

func (s dpapiStore) Delete(origin string) error {
	err := os.Remove(s.path(origin))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
