//go:build darwin && !devstore

package main

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <stdlib.h>
#include <string.h>

// SecKeychainSetUserInteractionAllowed is deprecated but is the switch that keeps the
// file-based login keychain from prompting; R1-C2 verified this behaviour on macOS 26.
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

static CFStringRef bkn_cfstr(const char *s) {
	return CFStringCreateWithCString(kCFAllocatorDefault, s, kCFStringEncodingUTF8);
}

static CFMutableDictionaryRef bkn_query(const char *service, const char *account) {
	CFMutableDictionaryRef q = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFStringRef svc = bkn_cfstr(service);
	CFStringRef acct = bkn_cfstr(account);
	CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
	CFDictionarySetValue(q, kSecAttrService, svc);
	CFDictionarySetValue(q, kSecAttrAccount, acct);
	CFRelease(svc);
	CFRelease(acct);
	return q;
}

static OSStatus bkn_put(const char *service, const char *account, const void *data, int len) {
	CFMutableDictionaryRef q = bkn_query(service, account);
	SecItemDelete(q);
	CFDataRef value = CFDataCreate(kCFAllocatorDefault, data, len);
	CFDictionarySetValue(q, kSecValueData, value);
	OSStatus st = SecItemAdd(q, NULL);
	CFRelease(value);
	CFRelease(q);
	return st;
}

// Reads without ever showing a keychain prompt: a prompt would mean another binary
// is asking, and the gateway must not train users to approve those.
static OSStatus bkn_get(const char *service, const char *account, void **out, int *outLen) {
	SecKeychainSetUserInteractionAllowed(false);
	CFMutableDictionaryRef q = bkn_query(service, account);
	CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
	CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
	CFTypeRef result = NULL;
	OSStatus st = SecItemCopyMatching(q, &result);
	CFRelease(q);
	SecKeychainSetUserInteractionAllowed(true);
	if (st != errSecSuccess) return st;
	CFDataRef d = (CFDataRef)result;
	*outLen = (int)CFDataGetLength(d);
	*out = malloc(*outLen);
	memcpy(*out, CFDataGetBytePtr(d), *outLen);
	CFRelease(result);
	return st;
}

static OSStatus bkn_delete(const char *service, const char *account) {
	CFMutableDictionaryRef q = bkn_query(service, account);
	OSStatus st = SecItemDelete(q);
	CFRelease(q);
	return st;
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

type keychainStore struct{}

func newPlatformStore() (CredentialStore, error) { return keychainStore{}, nil }

func (keychainStore) Put(origin string, secret []byte) error {
	svc, acct := C.CString(keychainService), C.CString(origin)
	defer C.free(unsafe.Pointer(svc))
	defer C.free(unsafe.Pointer(acct))
	if len(secret) == 0 {
		return fmt.Errorf("empty credential")
	}
	st := C.bkn_put(svc, acct, unsafe.Pointer(&secret[0]), C.int(len(secret)))
	if st != C.errSecSuccess {
		return fmt.Errorf("keychain write failed (status %d)", int(st))
	}
	return nil
}

func (keychainStore) Get(origin string) ([]byte, error) {
	svc, acct := C.CString(keychainService), C.CString(origin)
	defer C.free(unsafe.Pointer(svc))
	defer C.free(unsafe.Pointer(acct))
	var out unsafe.Pointer
	var n C.int
	st := C.bkn_get(svc, acct, &out, &n)
	switch st {
	case C.errSecSuccess:
		defer C.free(out)
		return C.GoBytes(out, n), nil
	case C.errSecItemNotFound:
		return nil, ErrNoCredential
	case C.errSecAuthFailed, C.errSecInteractionNotAllowed:
		// Typical after an upgrade: a new binary cannot read the old item (R1-C3).
		return nil, fmt.Errorf("%w: this gateway build cannot read the stored credential; log in again", ErrNoCredential)
	default:
		return nil, fmt.Errorf("keychain read failed (status %d)", int(st))
	}
}

func (keychainStore) Delete(origin string) error {
	svc, acct := C.CString(keychainService), C.CString(origin)
	defer C.free(unsafe.Pointer(svc))
	defer C.free(unsafe.Pointer(acct))
	st := C.bkn_delete(svc, acct)
	if st != C.errSecSuccess && st != C.errSecItemNotFound {
		return fmt.Errorf("keychain delete failed (status %d)", int(st))
	}
	return nil
}
