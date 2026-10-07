package main

import "sync"

// Per-process admission bounds both public socket endpoints and pending worker
// handshakes. Per-actor bounds leave room for other authenticated teammates.
var socketAdmission = struct {
	sync.Mutex
	total  int
	actors map[string]int
}{actors: make(map[string]int)}

func reserveSocket(actor string) func() {
	socketAdmission.Lock()
	defer socketAdmission.Unlock()
	if socketAdmission.total >= 1024 || socketAdmission.actors[actor] >= 16 {
		return nil
	}
	socketAdmission.total++
	connections.Inc()
	socketAdmission.actors[actor]++
	return func() {
		socketAdmission.Lock()
		defer socketAdmission.Unlock()
		socketAdmission.total--
		connections.Dec()
		socketAdmission.actors[actor]--
		if socketAdmission.actors[actor] == 0 {
			delete(socketAdmission.actors, actor)
		}
	}
}
