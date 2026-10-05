//go:build linux

// PID 1 enforces the wall budget even if the execution agent dies. Exiting
// tears down the entire container PID namespace, including orphaned children.
package main

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) != 3 {
		os.Exit(125)
	}
	var command *exec.Cmd
	switch os.Args[1] {
	case "python":
		command = exec.Command("/usr/local/bin/python3", "-B", "-u", os.Args[2])
	case "javascript":
		command = exec.Command("/usr/local/bin/node", "--max-old-space-size=80", os.Args[2])
	default:
		os.Exit(125)
	}
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp", "PYTHONDONTWRITEBYTECODE=1"}
	command.Dir = "/source"
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if command.Start() != nil {
		os.Exit(125)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			os.Exit(0)
		}
		if exit, ok := err.(*exec.ExitError); ok {
			code := exit.ExitCode()
			if code < 0 {
				code = 137
			}
			os.Exit(code)
		}
		os.Exit(125)
	case <-time.After(5 * time.Second):
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		os.Exit(124)
	}
}
