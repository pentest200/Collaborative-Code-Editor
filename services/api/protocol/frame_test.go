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
		Pending string `json:"update_committed_hex"`
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
	if err != nil || pendingFrame.Type != 5 || len(pendingFrame.Body) != 73 {
		t.Fatalf("bad committed update fixture: %+v %v", pendingFrame, err)
	}
	if _, err := Decode(pending, Client); err == nil {
		t.Fatal("accepted committed update from client")
	}
}
