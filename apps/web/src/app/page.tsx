"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { purgeAccountDrafts } from "@/collaboration/drafts";

type Session = { user: { id: string; display_name: string }; csrf_token: string };
type Project = { id: string; name: string; role: string };

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch("/api/v1/session", { cache: "no-store" });
        if (response.status === 401) {
          const config = await fetch("/api/v1/auth/config", { cache: "no-store" });
          if (!config.ok) throw new Error("Could not check login availability.");
          const availability = (await config.json()) as { github_enabled: boolean };
          if (active) setAuthEnabled(availability.github_enabled);
          return;
        }
        if (!response.ok) throw new Error("Could not check your session.");
        const current = (await response.json()) as Session;
        const projectResponse = await fetch("/api/v1/projects", { cache: "no-store" });
        if (!projectResponse.ok) throw new Error("Could not load your projects.");
        if (active) { setSession(current); setProjects((await projectResponse.json()) as Project[]); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Could not load your workspace."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/projects", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token }, body: JSON.stringify({ name: name.trim() }) });
      if (!response.ok) throw new Error("Could not create the project.");
      const created = (await response.json()) as Project;
      setProjects((current) => [created, ...current]); setName("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the project."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (!session) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/session", { method: "DELETE", headers: { "X-CSRF-Token": session.csrf_token } });
      if (!response.ok) throw new Error("Could not sign out.");
      await purgeAccountDrafts(session.user.id).catch(() => setError("Signed out, but browser draft cleanup failed. Clear site data on a shared device."));
      setSession(null); setProjects([]);
      try {
        const config = await fetch("/api/v1/auth/config", { cache: "no-store" });
        setAuthEnabled(config.ok ? ((await config.json()) as { github_enabled: boolean }).github_enabled : null);
      } catch { setAuthEnabled(null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign out."); }
    finally { setBusy(false); }
  }

  return <main className="page">
    <header className="topbar"><Link href="/" className="brand">Collaborative Code Editor</Link><span>Projects</span></header>
    <section className="hero"><p className="eyebrow">Your workspace</p><h1>Build together.</h1><p className="lede">Sign in with GitHub to organize files and edit code with your team.</p></section>
    {loading ? <p role="status">Checking your session…</p> : session ? <>
      <div className="section-heading"><div><h2>Your projects</h2><p>Signed in as {session.user.display_name}</p></div><button type="button" className="quiet" onClick={signOut} disabled={busy}>Sign out</button></div>
      <form onSubmit={createProject} className="panel"><label htmlFor="project-name">New project</label><div className="form-row"><input id="project-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Project name" required /><button type="submit" disabled={busy || !name.trim()}>Create project</button></div></form>
      {projects.length ? <ul className="project-grid">{projects.map((project) => <li key={project.id}><Link href={`/projects/${project.id}/workspace`} className="project-card"><span className="project-mark">{project.name.slice(0, 1).toUpperCase()}</span><span><strong>{project.name}</strong><small>{project.role}</small></span><span className="arrow" aria-hidden="true">↗</span></Link></li>)}</ul> : <div className="panel">No projects yet. Create one to invite your team.</div>}
    </> : <div className="panel login"><h2>Start with your GitHub account</h2><p>Projects are private to their members.</p>{authEnabled === true ? <a className="button-link" href="/api/v1/auth/github/start">Sign in with GitHub</a> : <p>{authEnabled === false ? "GitHub sign-in is not configured in this environment." : "Login availability could not be checked."}</p>}</div>}
    {error && <p role="alert" className="error">{error}</p>}
    <footer>Collaborative editing, checkpoints and project search are available. Search content updates asynchronously. Private-demo runs require execution to be enabled.</footer>
  </main>;
}
