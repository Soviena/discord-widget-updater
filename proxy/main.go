package main

import (
	"crypto/subtle"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"
)

const anilistURL = "https://graphql.anilist.co"

func main() {
	port := flag.String("port", "8080", "port to listen on")
	flag.Parse()

	if err := godotenv.Load(); err != nil {
		log.Println("no .env file found, using environment variables")
	}

	secret := os.Getenv("PROXY_SECRET")
	anilistToken := os.Getenv("ANILIST_TOKEN")

	if secret == "" {
		log.Fatal("PROXY_SECRET env var must be set")
	}
	if anilistToken == "" {
		log.Fatal("ANILIST_TOKEN env var must be set")
	}

	http.HandleFunc("/graphql", handler(secret, anilistToken))

	addr := "127.0.0.1:" + *port
	log.Printf("AniList proxy listening on %s → %s", addr, anilistURL)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func handler(secret, anilistToken string) http.HandlerFunc {
	client := &http.Client{Timeout: 30 * time.Second}
	secretBytes := []byte(secret)
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		incoming := []byte(r.Header.Get("X-Proxy-Secret"))
		if subtle.ConstantTimeCompare(incoming, secretBytes) != 1 {
			log.Printf("unauthorized request from %s", r.RemoteAddr)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, anilistURL, r.Body)
		if err != nil {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+anilistToken)

		resp, err := client.Do(req)
		if err != nil {
			log.Printf("AniList request failed: %v", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		log.Printf("AniList response: %d", resp.StatusCode)
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil {
			log.Printf("error writing response body: %v", err)
		}
	}
}
