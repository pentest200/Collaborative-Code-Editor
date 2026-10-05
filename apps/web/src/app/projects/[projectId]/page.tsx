"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type Session = { user: { id: string; display_name: string }; csrf_token: string };
type Project = { id: string; name: string; role: "owner" | "editor" | "viewer" };
type Member = { user_id: string; display_name: string; role: "owner" | "editor" | "viewer" };
type Invite = { token: string; expires_at: string };

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}`;
  const [session, setSession] = useState<Session | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const sessionResponse = await fetch("/api/v1/session", { cache: "no-store" });
        if (!sessionResponse.ok) throw new Error("Sign in to view this project.");
        const [details, memberResponse] = await Promise.all([fetch(base, { cache: "no-store" }), fetch(`${base}/members`, { cache: "no-store" })]);
        if (details.status === 404) throw new Error("Project not found or access has changed.");
        if (!details.ok || !memberResponse.ok) throw new Error("Could not load this project.");
        if (active) { setSession((await sessionResponse.json()) as Session); setProject((await details.json()) as Project); setMembers((await memberResponse.json()) as Member[]); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Could not load this project."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [base]);

  async function mutate(path: string, method: string, body?: object) {
    if (!session) throw new Error("Sign in to continue.");
    const response = await fetch(path, { method, headers: { "X-CSRF-Token": session.csrf_token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(response.status === 403 ? "Owner permission required." : "The project action failed.");
    return response;
  }

  async function createInvite() {
    setBusy(true); setError("");
    try {
      const response = await mutate(`${base}/invites`, "POST", { role: inviteRole, expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), max_uses: 1 });
      setInvite((await response.json()) as Invite);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create invitation."); }
    finally { setBusy(false); }
  }

  async function updateMember(member: Member, method: "PATCH" | "DELETE", role?: "editor" | "viewer") {
    setBusy(true); setError("");
    try {
      await mutate(`${base}/members/${member.user_id}`, method, role ? { role } : undefined);
      setMembers((current) => method === "DELETE" ? current.filter((item) => item.user_id !== member.user_id) : current.map((item) => item.user_id === member.user_id && role ? { ...item, role } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update member."); }
    finally { setBusy(false); }
  }

  return <main className="page"><header className="topbar"><Link href="/" className="brand">Collaborative Code Editor</Link><span>Project access</span></header><nav className="crumb"><Link href="/">Projects</Link><span>/</span><span>{project?.name ?? "Project"}</span></nav>
    {loading ? <p role="status">Loading project…</p> : project ? <>
      <section className="hero"><p className="eyebrow">{project.role} access</p><h1>{project.name}</h1><p className="lede">Invite teammates, manage access, and organize project files.</p><Link className="button-link" href={`/projects/${projectId}/workspace`}>Open workspace</Link></section>
      <section className="panel"><div className="section-heading"><h2>Team members</h2><span>{members.length} people</span></div><ul className="member-list">{members.map((member) => <li key={member.user_id}><span className="avatar">{member.display_name.slice(0, 1).toUpperCase()}</span><span className="member-name">{member.display_name}<small>{member.role}</small></span>{project.role === "owner" && member.role !== "owner" && <span className="member-actions"><select aria-label={`Role for ${member.display_name}`} value={member.role} disabled={busy} onChange={(event) => updateMember(member, "PATCH", event.target.value as "editor" | "viewer")}><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button type="button" className="quiet" disabled={busy} onClick={() => updateMember(member, "DELETE")}>Remove</button></span>}</li>)}</ul></section>
      {project.role === "owner" && <section className="panel"><h2>Invite someone</h2><p>Create a one-use link valid for seven days. Share it privately.</p><div className="form-row"><select aria-label="Invitation role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "editor" | "viewer")}><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button type="button" disabled={busy} onClick={createInvite}>Create invite link</button></div>{invite && <div className="invite-result"><label htmlFor="invite-link">One-use invite link</label><input id="invite-link" readOnly value={typeof window === "undefined" ? "" : `${window.location.origin}/invite/${invite.token}`} onFocus={(event) => event.target.select()} /><small>Shown only now. Expires {new Date(invite.expires_at).toLocaleDateString()}.</small></div>}</section>}
    </> : !error && <p>Project unavailable.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <footer>Collaborative editing and checkpoints are available in the workspace. Private-demo runs require execution to be enabled.</footer>
  </main>;
}
