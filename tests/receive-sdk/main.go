// Calls the same public clients used by ntfy and Chanify command-line tools.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/chanify/chanify/sender"
	"heckel.io/ntfy/v2/client"
)

func main() {
	base := os.Getenv("ANSER_SDK_TEST_ORIGIN")
	key := os.Getenv("ANSER_SDK_TEST_KEY")
	u, err := url.Parse(base)
	if err != nil || u.Hostname() != "127.0.0.1" || u.Scheme != "http" || key == "" {
		log.Fatal("a loopback fixture and its ephemeral key are required")
	}
	http.DefaultClient.Timeout = 5 * time.Second
	ntfy := client.New(client.NewConfig())
	notification, err := ntfy.Publish(base+"/v1/receive/ntfy/sdk-checks", "ntfy SDK",
		client.WithTitle("SDK fixture"), client.WithBearerAuth(key))
	if err != nil || notification.ID == "" || notification.Event != "message" || notification.Message != "ntfy SDK" {
		log.Fatalf("ntfy SDK did not confirm publication: %v", err)
	}
	chanify, err := sender.New(base+"/v1/receive/chanify", "anser-interop", nil)
	if err != nil {
		log.Fatal(err)
	}
	result, err := chanify.Send(context.Background(), strings.NewReader("Chanify SDK"), "text/plain", key)
	if err != nil || result.RequestID == "" {
		log.Fatalf("Chanify SDK did not confirm publication: %v", err)
	}
	fmt.Println("ntfy and Chanify accepted their native receipts")
}
