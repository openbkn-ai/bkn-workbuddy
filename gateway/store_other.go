//go:build !darwin && !windows && !devstore

package main

import "errors"

func newPlatformStore() (CredentialStore, error) {
	return nil, errors.New("credential storage is supported on macOS and Windows only")
}
