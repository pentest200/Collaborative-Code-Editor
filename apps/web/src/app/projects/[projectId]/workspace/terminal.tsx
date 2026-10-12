"use client";

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

export default function WorkspaceTerminal({ projectID, visible = true }: { projectID: string; visible?: boolean }) {
 const host = useRef<HTMLDivElement>(null); const [status, setStatus] = useState("Connecting");
 const shown = useRef(visible);
 useEffect(() => { shown.current = visible; }, [visible]);
 useEffect(() => {
  let disposed = false; let cleanup = () => {};
  void (async () => {
   const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
   if (disposed || !host.current) return;
   const terminal = new Terminal({ cursorBlink: true, screenReaderMode: true, fontSize: 13, fontFamily: "'Cascadia Code', Consolas, monospace", scrollback: 2000, theme: { background: "#1f1f1f", foreground: "#cccccc", cursor: "#ffffff" } });
   const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current);
   const resize = () => { if (host.current && host.current.clientWidth > 0 && host.current.clientHeight > 0) fit.fit(); };
   resize();
   const url = new URL(`/ws/workspaces/${projectID}/terminal`, location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
   const socket = new WebSocket(url); socket.binaryType = "arraybuffer";
   socket.onopen = () => { setStatus("Connected · your shell session"); if (shown.current) terminal.focus(); };
   socket.onmessage = event => { if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data)); else terminal.write(String(event.data)); };
   socket.onclose = () => { setStatus("Disconnected"); terminal.writeln("\r\n[Session closed. Open a new terminal to reconnect.]"); };
   socket.onerror = () => setStatus("Connection failed. Start the workspace and wait for tasks.");
   const input = terminal.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(data); });
   const observer = new ResizeObserver(resize); observer.observe(host.current);
   cleanup = () => { observer.disconnect(); input.dispose(); socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close(); terminal.dispose(); };
  })().catch(() => { if (!disposed) setStatus("Could not open terminal."); });
  return () => { disposed = true; cleanup(); };
 }, [projectID]);
 return <section className="interactive-terminal" aria-label="Interactive terminal"><div className="workspace-terminal" ref={host} /><p className="terminal-status" role="status">{status}</p></section>;
}
