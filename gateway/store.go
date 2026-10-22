package main

import "errors"

// CredentialStore keeps one secret per platform origin.
//
// darwin:  login keychain item written by this signed binary itself, so only this
//          exact binary can read it silently (R1-C2). Rebuilt or re-signed binaries
//          lose access and the user logs in again (R1-C3).
// windows: DPAPI (user scope) encrypted file. Any process of the same user can
//          decrypt it; Windows offers no per-application isolation here.
type CredentialStore interface {
	Put(origin string, secret []byte) error
	Get(origin string) ([]byte, error)
	Delete(origin string) error
}

// ErrNoCredential means the user has not logged in (or access was lost after an upgrade).
var ErrNoCredential = errors.New("no stored credential for this platform")

const keychainService = "com.openbkn.bkn-workbuddy.gateway"

// memoryStore is used by tests and never by the shipped binary.
type memoryStore struct{ items map[string][]byte }

func newMemoryStore() *memoryStore { return &memoryStore{items: map[string][]byte{}} }

func (m *memoryStore) Put(origin string, secret []byte) error {
	m.items[origin] = append([]byte(nil), secret...)
	return nil
}

func (m *memoryStore) Get(origin string) ([]byte, error) {
	v, ok := m.items[origin]
	if !ok {
		return nil, ErrNoCredential
	}
	return append([]byte(nil), v...), nil
}

func (m *memoryStore) Delete(origin string) error {
	delete(m.items, origin)
	return nil
}
