// Package elevation looks up ground altitude for a freehand map pin via the
// public Open-Elevation API, so the altitude field can auto-fill without
// asking the user to know it (see the Altitude section of docs/plan.md).
package elevation

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

const defaultBaseURL = "https://api.open-elevation.com/api/v1/lookup"

// Client looks up elevation via the Open-Elevation HTTP API.
type Client struct {
	httpClient *http.Client
	baseURL    string
}

// New returns a Client that calls the public Open-Elevation API.
func New() *Client {
	return &Client{httpClient: http.DefaultClient, baseURL: defaultBaseURL}
}

// NewForTest returns a Client pointed at a custom base URL, for tests.
func NewForTest(httpClient *http.Client, baseURL string) *Client {
	return &Client{httpClient: httpClient, baseURL: baseURL}
}

type lookupResponse struct {
	Results []struct {
		Elevation float64 `json:"elevation"`
	} `json:"results"`
}

// Lookup returns the ground elevation in metres at (lat, lon).
func (c *Client) Lookup(lat, lon float64) (float64, error) {
	q := url.Values{
		"locations": {strconv.FormatFloat(lat, 'f', -1, 64) + "," + strconv.FormatFloat(lon, 'f', -1, 64)},
	}
	reqURL := c.baseURL + "?" + q.Encode()

	resp, err := c.httpClient.Get(reqURL)
	if err != nil {
		return 0, fmt.Errorf("elevation lookup: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("elevation lookup: unexpected status %s", resp.Status)
	}

	var parsed lookupResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return 0, fmt.Errorf("parsing elevation response: %w", err)
	}
	if len(parsed.Results) == 0 {
		return 0, fmt.Errorf("elevation lookup: no results for (%v, %v)", lat, lon)
	}
	return parsed.Results[0].Elevation, nil
}
