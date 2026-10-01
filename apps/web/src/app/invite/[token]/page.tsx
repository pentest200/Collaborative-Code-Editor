"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const [csrf, setCsrf] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState("");
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/session", { cache: "no-store" }).then(async (response) => {
      if (response.ok) { const session = await response.json() as { user: { display_name: string }; csrf_token: string }; if (active) { setCsrf(session.csrf_token); setName(session.user.display_name); } }
      else if (response.status === 401) { const config = await fetch("/api/v1/auth/config", { cache: "no-store" }); if (!config.ok) throw new Error("Could not check login availability."); if (active) setAuthEnabled(((await config.json()) as { github_enabled: boolean }).github_enabled); }
      else throw new Error("Could not check your session.");
    }).catch(() => { if (active) setError("Could not check your session."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function accept() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/invites/${encodeURIComponent(token)}/accept`, { method: "POST", headers: { "X-CSRF-Token": csrf } });
      if (!response.ok) throw new Error(response.status === 409 ? "This link has expired, was used, or you are already a member." : "Could not accept this invitation.");
      const accepted = await response.json() as { project_id: string };
      setProjectId(accepted.project_id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not accept this invitation."); }
    finally { setBusy(false); }
  }

  return <main className="page"><header className="topbar"><Link href="/" className="brand">Collaborative Code Editor</Link><span>Invitation</span></header><section className="hero"><p className="eyebrow">Project invitation</p><h1>Join a workspace.</h1><p className="lede">Accepting this link adds your GitHub account to a private project.</p></section><div className="panel login">{loading ? <p role="status">Checking your session…</p> : projectId ? <><h2>You’re in.</h2><Link className="button-link" href={`/projects/${projectId}`}>Open project</Link></> : csrf ? <><h2>Signed in as {name}</h2><button type="button" onClick={accept} disabled={busy}>{busy ? "Joining…" : "Accept invitation"}</button></> : <><h2>Sign in first</h2>{authEnabled === true ? <><p>After signing in, reopen this invitation link to accept it.</p><a className="button-link" href="/api/v1/auth/github/start">Sign in with GitHub</a></> : <p>{authEnabled === false ? "GitHub sign-in is not configured in this environment." : "Login availability could not be checked."}</p>}</>}</div>{error && <p role="alert" className="error">{error}</p>}</main>;
}
