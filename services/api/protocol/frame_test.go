package protocol

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestSharedAckFixture(t *testing.T) {
	data, err := os.ReadFile("../../../packages/protocol/fixtures/frame-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Hex     string `json:"durable_ack_hex"`
		Pending string `json:"pending_update_hex"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	frameBytes, err := hex.DecodeString(fixture.Hex)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := Decode(frameBytes, Server)
	if err != nil || frame.Type != 6 || len(frame.Body) != 72 {
		t.Fatalf("bad ACK fixture: %+v %v", frame, err)
	}
	if _, err := Decode(frameBytes, Client); err == nil {
		t.Fatal("accepted server ACK from client")
	}
	if _, err := Decode(append(frameBytes, 0), Server); err == nil {
		t.Fatal("accepted trailing byte")
	}
	pending, err := hex.DecodeString(fixture.Pending)
	if err != nil {
		t.Fatal(err)
	}
	pendingFrame, err := Decode(pending, Server)
	if err != nil || pendingFrame.Type != 9 || len(pendingFrame.Body) != 65 {
		t.Fatalf("bad pending update fixture: %+v %v", pendingFrame, err)
	}
	if _, err := Decode(pending, Client); err == nil {
		t.Fatal("accepted pending update from client")
	}
}
