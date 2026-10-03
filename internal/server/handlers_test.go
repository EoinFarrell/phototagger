package server

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"phototagger/internal/keywords"
	"phototagger/internal/scan"
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

func TestHandleState_ReportsModeCounts(t *testing.T) {
	mux := newTestMux(t)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))

	var resp stateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	// The fixture from newTestSession has 2 photos, both Non-Tagged.
	if resp.Modes.All != 2 || resp.Modes.NonTagged != 2 || resp.Modes.Tagged != 0 {
		t.Errorf("Modes = %+v, want {All:2 NonTagged:2 Tagged:0}", resp.Modes)
	}
}

func TestHandleState_ReportsGeoCounts(t *testing.T) {
	mux := newTestMux(t)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))

	var resp stateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	// The fixture from newTestSession has 2 photos, neither with GPS coordinates.
	if resp.Geo.All != 2 || resp.Geo.MissingGPS != 2 {
		t.Errorf("Geo = %+v, want {All:2 MissingGPS:2}", resp.Geo)
	}
}

func TestHandleStart_BuildsQueueForRequestedGeo(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	backup := filepath.Join(root, "source-backup")
	touch(t, filepath.Join(source, "a.jpg"))
	touch(t, filepath.Join(source, "b.jpg"))

	result, err := scan.Scan(source)
	if err != nil {
		t.Fatal(err)
	}
	kws, err := keywords.Load(filepath.Join(root, "keywords.json"))
	if err != nil {
		t.Fatal(err)
	}
	exif := newFakeExif()
	// a.jpg already has GPS coordinates, b.jpg doesn't -- only b.jpg should
	// match the missing-gps Geo filter below.
	exif.hasGPS[filepath.Join(source, "a.jpg")] = true

	sess, err := NewSession(source, backup, result, exif, fakeTZ{}, fakeGeocoder{}, fakeElevation{}, kws)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	body, _ := json.Marshal(map[string]string{"mode": "all", "geo": "missing-gps"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/start", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}

	// Only b.jpg (no GPS) should be queued; a.jpg has GPS and is excluded.
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/photo/current", nil))
	var resp currentResponse
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Done || resp.Total != 1 {
		t.Errorf("expected a single-photo queue (missing-gps only), got %+v", resp)
	}
}

func TestHandleKeywordLocation_SetAndClear(t *testing.T) {
	sess, _, _ := newTestSession(t)
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	applyBody, _ := json.Marshal(map[string]any{
		"dateTime": "2024-01-01T08:00:00", "keywords": []string{"concert"}, "keywordsTouched": true,
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/photo/apply", bytes.NewReader(applyBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body = %s", rec.Code, rec.Body)
	}

	setBody, _ := json.Marshal(map[string]any{"keyword": "concert", "lat": 40.7128, "lon": -74.006, "alt": 10})
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/keywords/location", bytes.NewReader(setBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("set status = %d, body = %s", rec.Code, rec.Body)
	}
	var kws []keywords.Keyword
	json.Unmarshal(rec.Body.Bytes(), &kws)
	if len(kws) != 1 || kws[0].Location == nil || kws[0].Location.Lat != 40.7128 {
		t.Fatalf("keywords after set = %+v", kws)
	}

	delBody, _ := json.Marshal(map[string]string{"keyword": "concert"})
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/keywords/location", bytes.NewReader(delBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("clear status = %d, body = %s", rec.Code, rec.Body)
	}
	kws = nil
	json.Unmarshal(rec.Body.Bytes(), &kws)
	if len(kws) != 1 || kws[0].Location != nil {
		t.Errorf("keywords after clear = %+v, want Location nil", kws)
	}
}

func TestHandleKeywordLocation_RequiresKeyword(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]any{"keyword": "", "lat": 1, "lon": 2})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/keywords/location", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for empty keyword", rec.Code)
	}
}

// Saving the map pin as a located keyword ("Save pin as located keyword"
// in the tagging form) may name a keyword that doesn't exist yet: POST
// creates it, carrying that Location.
func TestHandleKeywordLocation_SetUnknownKeywordCreatesIt(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]any{"keyword": "  Pachacaid ", "lat": 43.19, "lon": 6.47, "alt": 65})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/keywords/location", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var kws []keywords.Keyword
	json.Unmarshal(rec.Body.Bytes(), &kws)
	want := keywords.Location{Lat: 43.19, Lon: 6.47, Alt: 65}
	if len(kws) != 1 || kws[0].Name != "Pachacaid" || kws[0].Location == nil || *kws[0].Location != want {
		t.Errorf("keywords after set = %+v, want one Pachacaid at %+v", kws, want)
	}
}

func TestHandleKeywordLocation_SetRejectsBlankKeyword(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]any{"keyword": "   ", "lat": 1, "lon": 2})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/keywords/location", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a blank keyword", rec.Code)
	}
}

func TestHandleKeywordLocation_ClearUnknownKeywordErrors(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]string{"keyword": "never-used"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/keywords/location", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 clearing an unknown keyword", rec.Code)
	}
}

func TestHandleKeywordRename_ChangesText(t *testing.T) {
	sess, _, _ := newTestSession(t)
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	applyBody, _ := json.Marshal(map[string]any{
		"dateTime": "2024-01-01T08:00:00", "keywords": []string{"beach"}, "keywordsTouched": true,
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/photo/apply", bytes.NewReader(applyBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body = %s", rec.Code, rec.Body)
	}

	renameBody, _ := json.Marshal(map[string]string{"oldKeyword": "beach", "newKeyword": "seaside"})
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/keywords/rename", bytes.NewReader(renameBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("rename status = %d, body = %s", rec.Code, rec.Body)
	}
	var kws []keywords.Keyword
	json.Unmarshal(rec.Body.Bytes(), &kws)
	if len(kws) != 1 || kws[0].Name != "seaside" {
		t.Errorf("keywords after rename = %+v, want [seaside]", kws)
	}
}

func TestHandleKeywordRename_RequiresOldKeyword(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]string{"oldKeyword": "", "newKeyword": "seaside"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/keywords/rename", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for an empty oldKeyword", rec.Code)
	}
}

func TestHandleKeywordRename_RejectsCollision(t *testing.T) {
	sess, _, _ := newTestSession(t)
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	applyBody, _ := json.Marshal(map[string]any{
		"dateTime": "2024-01-01T08:00:00", "keywords": []string{"beach", "family"}, "keywordsTouched": true,
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/photo/apply", bytes.NewReader(applyBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body = %s", rec.Code, rec.Body)
	}

	renameBody, _ := json.Marshal(map[string]string{"oldKeyword": "beach", "newKeyword": "family"})
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/keywords/rename", bytes.NewReader(renameBody)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a destination-name collision", rec.Code)
	}
}

func TestHandleStart_BuildsQueueForRequestedMode(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]string{"mode": "tagged", "geo": "all"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/start", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}

	// Both fixture photos are Non-Tagged, so Tagged mode's queue is empty.
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/photo/current", nil))
	var resp currentResponse
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if !resp.Done {
		t.Errorf("expected Done immediately after starting an empty mode, got %+v", resp)
	}
}

func TestHandleStart_RejectsInvalidMode(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]string{"mode": "bogus", "geo": "all"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/start", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandleStart_RejectsInvalidGeo(t *testing.T) {
	mux := newTestMux(t)

	body, _ := json.Marshal(map[string]string{"mode": "all", "geo": "bogus"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/start", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
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

// The located keyword the pin was snapped to names the renamed file, and
// comes back on the next photo's "previous" location so Location's
// same-as-previous can restore it.
func TestHandleApply_LocatedKeywordNamesFileAndCarriesToPrevious(t *testing.T) {
	sess, source, _ := newTestSession(t)
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	body, _ := json.Marshal(map[string]any{
		"dateTime": "2024-07-14T14:30:22", "lat": 43.19, "lon": 6.47, "alt": 65,
		"locationTouched": true, "locatedKeyword": "Pachacaid",
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/photo/apply", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}

	if _, err := os.Stat(filepath.Join(source, "20240714-143022_pachacaid.jpg")); err != nil {
		t.Errorf("expected applied file named after the located keyword: %v", err)
	}

	var resp struct {
		Previous map[string]map[string]any `json:"previous"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if got := resp.Previous["location"]["locatedKeyword"]; got != "Pachacaid" {
		t.Errorf("previous.location.locatedKeyword = %v, want Pachacaid (previous = %v)", got, resp.Previous)
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

func TestHandleKeywords_ReflectsAppliedKeywords(t *testing.T) {
	sess, _, _ := newTestSession(t)
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/keywords", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d", rec.Code)
	}
	var kws []keywords.Keyword
	json.Unmarshal(rec.Body.Bytes(), &kws)
	if len(kws) != 0 {
		t.Fatalf("keywords = %v, want none before any Apply", kws)
	}

	body, _ := json.Marshal(map[string]any{
		"dateTime": "2024-01-01T08:00:00", "keywords": []string{"beach", "family"}, "keywordsTouched": true,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/photo/apply", bytes.NewReader(body))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body = %s", rec.Code, rec.Body)
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/keywords", nil))
	json.Unmarshal(rec.Body.Bytes(), &kws)
	if len(kws) != 2 || kws[0].Name != "beach" || kws[1].Name != "family" {
		t.Errorf("keywords = %+v, want [beach family]", kws)
	}
}

func TestHandleKeywords_DeleteRemovesFromKnownList(t *testing.T) {
	sess, _, _ := newTestSession(t)
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	applyBody, _ := json.Marshal(map[string]any{
		"dateTime": "2024-01-01T08:00:00", "keywords": []string{"beach", "family"}, "keywordsTouched": true,
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/photo/apply", bytes.NewReader(applyBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body = %s", rec.Code, rec.Body)
	}

	delBody, _ := json.Marshal(map[string]string{"keyword": "beach"})
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/keywords", bytes.NewReader(delBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d, body = %s", rec.Code, rec.Body)
	}

	var kws []keywords.Keyword
	json.Unmarshal(rec.Body.Bytes(), &kws)
	if len(kws) != 1 || kws[0].Name != "family" {
		t.Errorf("keywords after delete = %+v, want [family]", kws)
	}
}

func TestHandleKeywords_DeleteRequiresKeyword(t *testing.T) {
	sess, _, _ := newTestSession(t)
	if err := SetWebFS(testWebFS, "testdata/web"); err != nil {
		t.Fatal(err)
	}
	mux := NewMux(sess)

	body, _ := json.Marshal(map[string]string{"keyword": ""})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/keywords", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for empty keyword", rec.Code)
	}
}

func TestHandleElevation_GracefulFailure(t *testing.T) {
	sess, _, _ := newTestSession(t)
	sess.elevation = fakeElevation{err: errors.New("lookup failed")}
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
