package server

import (
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"time"

	"phototagger/internal/locations"
)

var errNameRequired = errors.New("name is required")

// WebFS is the embedded static frontend, set by main via SetWebFS.
var webFS fs.FS

// SetWebFS supplies the embedded web assets (index.html, app.js, ...) built
// with //go:embed in main.go, keeping this package independent of the
// embed directive's location.
func SetWebFS(f embed.FS, sub string) error {
	stripped, err := fs.Sub(f, sub)
	if err != nil {
		return err
	}
	webFS = stripped
	return nil
}

// NewMux builds the HTTP handler for the tagging server.
func NewMux(sess *Session) http.Handler {
	mux := http.NewServeMux()

	mux.Handle("/", http.FileServer(http.FS(webFS)))

	mux.HandleFunc("/api/state", handleState(sess))
	mux.HandleFunc("/api/start", handleStart(sess))
	mux.HandleFunc("/api/photo/current", handleCurrent(sess))
	mux.HandleFunc("/api/photo/preview", handlePreview(sess))
	mux.HandleFunc("/api/photo/apply", handleApply(sess))
	mux.HandleFunc("/api/photo/skip", handleSkip(sess))
	mux.HandleFunc("/api/photo/prev", handlePrev(sess))
	mux.HandleFunc("/api/favourites", handleFavourites(sess))
	mux.HandleFunc("/api/elevation", handleElevation(sess))
	mux.HandleFunc("/api/timezone", handleTimezone(sess))

	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

type stateResponse struct {
	SourceDir      string         `json:"sourceDir"`
	BackupDir      string         `json:"backupDir"`
	PhotoCount     int            `json:"photoCount"`
	ExtCounts      map[string]int `json:"extCounts"`
	SubfolderCount int            `json:"subfolderCount"`
	Skipped        []string       `json:"skipped"`
	Remaining      int            `json:"remaining"`
	Total          int            `json:"total"`
}

func handleState(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		extCounts := map[string]int{}
		for _, p := range sess.ScanResult.Photos {
			extCounts[p.Ext]++
		}
		skipped := make([]string, 0, len(sess.ScanResult.Skipped))
		for _, s := range sess.ScanResult.Skipped {
			skipped = append(skipped, s.RelPath)
		}

		writeJSON(w, http.StatusOK, stateResponse{
			SourceDir:      sess.SourceDir,
			BackupDir:      sess.BackupDir,
			PhotoCount:     len(sess.ScanResult.Photos),
			ExtCounts:      extCounts,
			SubfolderCount: sess.ScanResult.SubfolderCount,
			Skipped:        skipped,
			Remaining:      sess.Remaining(),
			Total:          sess.Total(),
		})
	}
}

func handleStart(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

type fieldsJSON struct {
	DateTime      string   `json:"dateTime,omitempty"`
	Offset        string   `json:"offset,omitempty"`
	Lat           *float64 `json:"lat,omitempty"`
	Lon           *float64 `json:"lon,omitempty"`
	Alt           *float64 `json:"alt,omitempty"`
	FavouriteName string   `json:"favouriteName,omitempty"`
	Keywords      []string `json:"keywords,omitempty"`
	Caption       string   `json:"caption,omitempty"`
}

func existingToJSON(e CurrentPhoto) fieldsJSON {
	f := fieldsJSON{Keywords: e.Existing.Keywords}
	if e.Existing.DateTime != nil {
		f.DateTime = e.Existing.DateTime.Format(dateTimeLayout)
	}
	if e.Existing.OffsetTimeOriginal != nil {
		f.Offset = *e.Existing.OffsetTimeOriginal
	}
	f.Lat = e.Existing.Latitude
	f.Lon = e.Existing.Longitude
	f.Alt = e.Existing.Altitude
	if e.Existing.Caption != nil {
		f.Caption = *e.Existing.Caption
	}
	return f
}

func previousToJSON(p PreviousValues) map[string]fieldsJSON {
	out := map[string]fieldsJSON{}
	if p.Location != nil {
		lat, lon := p.Location.Lat, p.Location.Lon
		out["location"] = fieldsJSON{Lat: &lat, Lon: &lon, Alt: p.Location.Alt, FavouriteName: p.Location.FavouriteName}
	}
	if p.DateTime != nil {
		out["dateTime"] = fieldsJSON{DateTime: p.DateTime.DateTime.Format(dateTimeLayout), Offset: p.DateTime.Offset}
	}
	if p.Keywords != nil {
		out["keywords"] = fieldsJSON{Keywords: *p.Keywords}
	}
	if p.Caption != nil {
		out["caption"] = fieldsJSON{Caption: *p.Caption}
	}
	return out
}

type currentResponse struct {
	Done       bool                  `json:"done"`
	Index      int                   `json:"index"`
	Total      int                   `json:"total"`
	RelPath    string                `json:"relPath,omitempty"`
	Ext        string                `json:"ext,omitempty"`
	IsHeic     bool                  `json:"isHeic,omitempty"`
	Existing   fieldsJSON            `json:"existing"`
	Previous   map[string]fieldsJSON `json:"previous"`
	PreviewURL string                `json:"previewUrl,omitempty"`
}

func handleCurrent(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cur, err := sess.Current()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		if cur.Done {
			writeJSON(w, http.StatusOK, currentResponse{Done: true, Total: cur.Total})
			return
		}
		writeJSON(w, http.StatusOK, currentResponse{
			Index:      cur.Index,
			Total:      cur.Total,
			RelPath:    cur.RelPath,
			Ext:        cur.Ext,
			IsHeic:     cur.IsHeic,
			Existing:   existingToJSON(cur),
			Previous:   previousToJSON(cur.Previous),
			PreviewURL: "/api/photo/preview",
		})
	}
}

func handlePreview(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, contentType, err := sess.Preview()
		if err != nil {
			writeError(w, http.StatusNotFound, err)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Write(data)
	}
}

func handleSkip(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		sess.Skip()
		handleCurrent(sess)(w, r)
	}
}

func handlePrev(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		sess.Prev()
		handleCurrent(sess)(w, r)
	}
}

func handleApply(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req ApplyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		if _, err := sess.Apply(req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		handleCurrent(sess)(w, r)
	}
}

func handleFavourites(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, sess.Favourites())
		case http.MethodPost:
			var fav locations.Favourite
			if err := json.NewDecoder(r.Body).Decode(&fav); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			if fav.Name == "" {
				writeError(w, http.StatusBadRequest, errNameRequired)
				return
			}
			if err := sess.AddFavourite(fav); err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			writeJSON(w, http.StatusOK, sess.Favourites())
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func handleElevation(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Lat float64 `json:"lat"`
			Lon float64 `json:"lon"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		alt, err := sess.LookupElevation(req.Lat, req.Lon)
		if err != nil {
			// Graceful degradation: a failed/offline lookup isn't a hard
			// error, the UI just leaves the field editable/blank.
			writeJSON(w, http.StatusOK, map[string]any{"ok": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "alt": alt})
	}
}

func handleTimezone(sess *Session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Lat      float64 `json:"lat"`
			Lon      float64 `json:"lon"`
			DateTime string  `json:"dateTime"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		dt, err := time.Parse(dateTimeLayout, req.DateTime)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		offset, zone, ok := sess.ResolveTimezone(req.Lat, req.Lon, dt)
		writeJSON(w, http.StatusOK, map[string]any{"ok": ok, "offset": offset, "zone": zone})
	}
}
