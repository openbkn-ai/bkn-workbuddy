//go:build devstore

package main

import (
	"errors"
	"os"
	"sync"
)

// Development-only store, compiled with `-tags devstore` and never shipped: the
// credential comes from BKN_GATEWAY_DEV_TOKEN and lives only in process memory,
// so end-to-end tests can use a real platform without writing the token anywhere.
// `login` and `logout` are refused to keep it that way.
type devStore struct {
	once  sync.Once
	token []byte
}

var devStoreInstance = &devStore{}

func newPlatformStore() (CredentialStore, error) { return devStoreInstance, nil }

func (d *devStore) load() {
	d.once.Do(func() {
		d.token = []byte(os.Getenv("BKN_GATEWAY_DEV_TOKEN"))
		_ = os.Unsetenv("BKN_GATEWAY_DEV_TOKEN")
	})
}

func (d *devStore) Put(string, []byte) error {
	return errors.New("devstore build: credentials come from BKN_GATEWAY_DEV_TOKEN only")
}

func (d *devStore) Get(string) ([]byte, error) {
	d.load()
	if len(d.token) == 0 {
		return nil, ErrNoCredential
	}
	return append([]byte(nil), d.token...), nil
}

func (d *devStore) Delete(string) error {
	return errors.New("devstore build: nothing is stored")
}
