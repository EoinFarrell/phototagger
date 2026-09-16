// Package geocode reverse-geocodes a freehand map pin into a place name via
// Nominatim, for the tagged filename's location slug (see the Renaming
// section of docs/plan.md).
package geocode

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

const (
	defaultBaseURL = "https://nominatim.openstreetmap.org"
	userAgent      = "phototagger/1.0 (local single-user EXIF tagging tool)"

	// Nominatim zoom levels: 10 selects city/town granularity, 6 county.
	cityZoom   = "10"
	countyZoom = "6"
)

// Client reverse-geocodes coordinates via the Nominatim HTTP API.
type Client struct {
	httpClient *http.Client
	baseURL    string
}

// New returns a Client that calls the public Nominatim API.
func New() *Client {
	return &Client{httpClient: http.DefaultClient, baseURL: defaultBaseURL}
}

// NewForTest returns a Client pointed at a custom base URL (e.g. an
// httptest server), for tests.
func NewForTest(httpClient *http.Client, baseURL string) *Client {
	return &Client{httpClient: httpClient, baseURL: baseURL}
}

type nominatimResponse struct {
	Address struct {
		City    string `json:"city"`
		Town    string `json:"town"`
		Village string `json:"village"`
		County  string `json:"county"`
	} `json:"address"`
}

func (r nominatimResponse) cityLevelName() string {
	switch {
	case r.Address.City != "":
		return r.Address.City
	case r.Address.Town != "":
		return r.Address.Town
	case r.Address.Village != "":
		return r.Address.Village
	default:
		return ""
	}
}

// ReverseGeocode returns a place name for (lat, lon) at city/town
// granularity, falling back to county if city-level data isn't available.
// An empty string with a nil error means the lookup succeeded but no usable
// place name was found; callers should omit the location slug in that case
// rather than treating it as a hard failure.
func (c *Client) ReverseGeocode(lat, lon float64) (string, error) {
	cityResp, err := c.fetch(lat, lon, cityZoom)
	if err != nil {
		return "", err
	}
	if name := cityResp.cityLevelName(); name != "" {
		return name, nil
	}
	if cityResp.Address.County != "" {
		return cityResp.Address.County, nil
	}

	countyResp, err := c.fetch(lat, lon, countyZoom)
	if err != nil {
		return "", err
	}
	return countyResp.Address.County, nil
}

func (c *Client) fetch(lat, lon float64, zoom string) (nominatimResponse, error) {
	q := url.Values{
		"format":         {"jsonv2"},
		"lat":            {strconv.FormatFloat(lat, 'f', -1, 64)},
		"lon":            {strconv.FormatFloat(lon, 'f', -1, 64)},
		"zoom":           {zoom},
		"addressdetails": {"1"},
	}
	reqURL := c.baseURL + "/reverse?" + q.Encode()

	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		return nominatimResponse{}, err
	}
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nominatimResponse{}, fmt.Errorf("reverse geocoding: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nominatimResponse{}, fmt.Errorf("reverse geocoding: unexpected status %s", resp.Status)
	}

	var parsed nominatimResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nominatimResponse{}, fmt.Errorf("parsing reverse geocode response: %w", err)
	}
	return parsed, nil
}
