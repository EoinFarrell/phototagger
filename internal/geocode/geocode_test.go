package geocode

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReverseGeocode_City(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("zoom"); got != "10" {
			t.Errorf("zoom = %q, want 10", got)
		}
		w.Write([]byte(`{"address":{"city":"Dublin","county":"Dublin"}}`))
	}))
	defer srv.Close()

	c := NewForTest(srv.Client(), srv.URL)
	name, err := c.ReverseGeocode(53.35, -6.26)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "Dublin" {
		t.Errorf("name = %q, want Dublin", name)
	}
}

func TestReverseGeocode_TownFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"address":{"town":"Bray","county":"Wicklow"}}`))
	}))
	defer srv.Close()

	c := NewForTest(srv.Client(), srv.URL)
	name, err := c.ReverseGeocode(53.2, -6.1)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "Bray" {
		t.Errorf("name = %q, want Bray", name)
	}
}

func TestReverseGeocode_FallsBackToCounty(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		zoom := r.URL.Query().Get("zoom")
		if zoom == "10" {
			w.Write([]byte(`{"address":{}}`))
			return
		}
		w.Write([]byte(`{"address":{"county":"Wicklow"}}`))
	}))
	defer srv.Close()

	c := NewForTest(srv.Client(), srv.URL)
	name, err := c.ReverseGeocode(53.0, -6.3)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "Wicklow" {
		t.Errorf("name = %q, want Wicklow", name)
	}
	if calls != 2 {
		t.Errorf("expected 2 requests (city then county), got %d", calls)
	}
}

func TestReverseGeocode_NothingFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"address":{}}`))
	}))
	defer srv.Close()

	c := NewForTest(srv.Client(), srv.URL)
	name, err := c.ReverseGeocode(0, 0)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "" {
		t.Errorf("name = %q, want empty", name)
	}
}

func TestReverseGeocode_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := NewForTest(srv.Client(), srv.URL)
	if _, err := c.ReverseGeocode(0, 0); err == nil {
		t.Fatal("expected error on server failure")
	}
}

func TestReverseGeocode_SetsUserAgent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ua := r.Header.Get("User-Agent"); ua == "" || ua == "Go-http-client/1.1" {
			t.Errorf("User-Agent = %q, want a descriptive identifier (Nominatim usage policy)", ua)
		}
		w.Write([]byte(`{"address":{"city":"Dublin"}}`))
	}))
	defer srv.Close()

	c := NewForTest(srv.Client(), srv.URL)
	if _, err := c.ReverseGeocode(53.35, -6.26); err != nil {
		t.Fatalf("err = %v", err)
	}
}
