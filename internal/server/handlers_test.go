package server

import (
	"bytes"
	"embed"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

//go:embed testdata/web
var testWebFS embed.FS

func newTestMux(t *testing.T) http.Handler {
	t.Helper()
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	sess, _, _ := newTestSession(t)
	return NewMux(sess)
}

func TestHandleState(t *testing.T) {
	mux := newTestMux(t)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var resp stateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.PhotoCount != 2 {
		t.Errorf("PhotoCount = %d, want 2", resp.PhotoCount)
	}
}

func TestHandleCurrentAndSkip(t *testing.T) {
	mux := newTestMux(t)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/photo/current", nil))
	var first currentResponse
	json.Unmarshal(rec.Body.Bytes(), &first)
	if first.Done {
		t.Fatal("expected a current photo")
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/photo/skip", nil))
	var second currentResponse
	json.Unmarshal(rec.Body.Bytes(), &second)
	if second.RelPath == first.RelPath {
		t.Errorf("Skip did not advance: still on %q", second.RelPath)
	}
}

func TestHandleApply_EndToEnd(t *testing.T) {
	sess, source, _ := newTestSession(t)
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	body, _ := json.Marshal(map[string]any{
		"dateTime": "2024-07-14T14:30:22",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/photo/apply", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}

	if _, err := os.Stat(filepath.Join(source, "20240714-143022.jpg")); err != nil {
		t.Errorf("expected applied file: %v", err)
	}

	var resp currentResponse
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Done {
		t.Fatal("expected one photo remaining")
	}
}

func TestHandleApply_BadRequestOnMissingDateTime(t *testing.T) {
	mux := newTestMux(t)

	req := httptest.NewRequest(http.MethodPost, "/api/photo/apply", bytes.NewReader([]byte(`{}`)))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandleFavourites_GetAndPost(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]any{"name": "Home", "lat": 1, "lon": 2, "alt": 3})
	req := httptest.NewRequest(http.MethodPost, "/api/favourites", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body = %s", rec.Code, rec.Body)
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/favourites", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d", rec.Code)
	}
	var favs []map[string]any
	json.Unmarshal(rec.Body.Bytes(), &favs)
	if len(favs) != 1 || favs[0]["name"] != "Home" {
		t.Errorf("favourites = %v", favs)
	}
}

func TestHandleElevation_GracefulFailure(t *testing.T) {
	sess, _, _ := newTestSession(t)
	sess.elevation = fakeElevation{err: errNameRequired} // any error
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	body, _ := json.Marshal(map[string]any{"lat": 1, "lon": 2})
	req := httptest.NewRequest(http.MethodPost, "/api/elevation", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 even on lookup failure (graceful degradation), got %d", rec.Code)
	}
	var resp map[string]any
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["ok"] != false {
		t.Errorf("resp = %v, want ok=false", resp)
	}
}

func TestHandleTimezone(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]any{"lat": 53.35, "lon": -6.26, "dateTime": "2024-07-14T14:30:22"})
	req := httptest.NewRequest(http.MethodPost, "/api/timezone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var resp map[string]any
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["ok"] != true || resp["offset"] != "+01:00" {
		t.Errorf("resp = %v", resp)
	}
}
