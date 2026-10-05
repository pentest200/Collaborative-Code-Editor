"use client";

import { useEffect, useState } from "react";

type Result = { project_id: string; file_id: string; document_id: string; generation: string; path: string; indexed_sequence: string | null; current_sequence: string; stale: boolean; filename_match: boolean; snippet: string | null };

export default function ProjectSearch({ base, treeVersion, onOpen }: { base: string; treeVersion: string; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<{ results: Result[]; loading: boolean; error: string; truncated: boolean; searched: boolean }>({ results: [], loading: false, error: "", truncated: false, searched: false });
  // biome-ignore lint/correctness/useExhaustiveDependencies: metadata changes and explicit refresh must rerun the same query.
  useEffect(() => {
    if (!submitted) return;
    const controller = new AbortController();
    void (async () => {
      setView({ results: [], loading: true, error: "", truncated: false, searched: true });
      try {
        const response = await fetch(`${base}/search?q=${encodeURIComponent(submitted)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 404 || response.status === 401 ? "Project access has changed." : response.status === 400 ? "Use 1–128 UTF-8 bytes without control characters." : "Search is unavailable. Try again.");
        const body = await response.json() as { results: Result[]; truncated: boolean };
        if (!controller.signal.aborted) setView({ ...body, loading: false, error: "", searched: true });
      } catch (cause) {
        if (!controller.signal.aborted) setView({ results: [], loading: false, error: cause instanceof Error ? cause.message : "Search failed.", truncated: false, searched: true });
      }
    })();
    return () => controller.abort();
  }, [base, treeVersion, submitted, refresh]);
  return <section className="project-search" aria-label="Project search">
    <h3>Search project</h3>
    <p>Content results may lag committed edits. Open a result to see its current file.</p>
    <form onSubmit={event => { event.preventDefault(); setSubmitted(query.trim()); setRefresh(value => value + 1); }}>
      <label htmlFor="project-search-query">Filename or content</label>
      <input id="project-search-query" type="search" value={query} onChange={event => setQuery(event.target.value)} required maxLength={128} />
      <button type="submit" disabled={view.loading || !query.trim()}>Search</button>
      {submitted && <button type="button" disabled={view.loading} onClick={() => setRefresh(value => value + 1)}>Refresh results</button>}
    </form>
    <div role="status">{view.loading ? "Searching…" : view.error || (view.searched && !view.results.length ? "No matching files or indexed content." : "")}</div>
    <ul aria-label="Search results">{view.results.map(result => <li key={result.file_id}>
      <button type="button" onClick={() => onOpen(result.file_id)} aria-label={`Open search result ${result.path}`}>{result.path}</button>
      <small>{result.indexed_sequence === null ? "Content awaiting indexing" : `Indexed version ${result.indexed_sequence}${result.stale ? ` · behind committed version ${result.current_sequence}` : " · current at search"}`}</small>
      {result.snippet !== null && <pre>{result.snippet}</pre>}
    </li>)}</ul>
    {view.truncated && <p>First 50 matches shown. Narrow your query.</p>}
  </section>;
}
