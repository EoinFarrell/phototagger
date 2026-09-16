package elevation

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLookup_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[{"latitude":53.35,"longitude":-6.26,"elevation":12.5}]}`))
	}))
	defer srv.Close()

	c := NewForTest(srv.Client(), srv.URL)
	alt, err := c.Lookup(53.35, -6.26)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if alt != 12.5 {
		t.Errorf("alt = %v, want 12.5", alt)
	}
}

func TestLookup_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := NewForTest(srv.Client(), srv.URL)
	if _, err := c.Lookup(0, 0); err == nil {
		t.Fatal("expected error on server failure")
	}
}

func TestLookup_EmptyResults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()

	c := NewForTest(srv.Client(), srv.URL)
	if _, err := c.Lookup(0, 0); err == nil {
		t.Fatal("expected error on empty results")
	}
}
