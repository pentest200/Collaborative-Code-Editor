"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";

export type PreviewFile = { id: string; document_id: string | null; name: string; language: string | null };

type Editor = Monaco.editor.IStandaloneCodeEditor;
type Model = Monaco.editor.ITextModel;

export default function MonacoPreview({ projectId, file, onCursor }: { projectId: string; file: PreviewFile | null; onCursor: (line: number, column: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const monaco = useRef<typeof Monaco | null>(null);
  const models = useRef(new Map<string, Model>());
  const current = useRef(file);
  const cursor = useRef(onCursor);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => { cursor.current = onCursor; }, [onCursor]);
  const selectModel = useCallback(() => {
    const instance = editor.current;
    const library = monaco.current;
    const selected = current.current;
    if (!instance || !library) return;
    if (!selected?.document_id) { instance.setModel(null); return; }
    const uri = library.Uri.parse(`cce://project/${projectId}/${selected.id}/${selected.document_id}`);
    let model = models.current.get(uri.toString());
    if (!model) {
      model = library.editor.createModel("", selected.language ?? "plaintext", uri);
      models.current.set(uri.toString(), model);
    } else {
      library.editor.setModelLanguage(model, selected.language ?? "plaintext");
      models.current.delete(uri.toString());
      models.current.set(uri.toString(), model);
    }
    instance.setModel(model);
    while (models.current.size > 3) {
      const oldest = models.current.keys().next().value;
      if (!oldest) break;
      models.current.get(oldest)?.dispose();
      models.current.delete(oldest);
    }
  }, [projectId]);

  useEffect(() => { current.current = file; if (ready) selectModel(); }, [file, ready, selectModel]);

  useEffect(() => {
    let cancelled = false;
    let subscription: Monaco.IDisposable | undefined;
    (async () => {
      try {
        const environment = self as typeof self & { MonacoEnvironment?: { getWorker: (_module: string, label: string) => Worker } };
        environment.MonacoEnvironment = {
          getWorker: (_module, label) => {
            if (label === "json") return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
            if (label === "css" || label === "scss" || label === "less") return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" });
            if (label === "html" || label === "handlebars" || label === "razor") return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" });
            if (label === "typescript" || label === "javascript") return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
            return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
          }
        };
        const library = await import("monaco-editor/esm/vs/editor/editor.api");
        await Promise.all([
          import("monaco-editor/esm/vs/language/typescript/monaco.contribution"),
          import("monaco-editor/esm/vs/language/json/monaco.contribution"),
          import("monaco-editor/esm/vs/language/css/monaco.contribution"),
          import("monaco-editor/esm/vs/language/html/monaco.contribution"),
          import("monaco-editor/esm/vs/basic-languages/python/python.contribution"),
          import("monaco-editor/esm/vs/basic-languages/go/go.contribution"),
          import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution"),
          import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution")
        ]);
        if (cancelled || !host.current) return;
        monaco.current = library;
        library.editor.defineTheme("cce-dark", { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": "#111720", "editor.foreground": "#e1e8f2", "editorLineNumber.foreground": "#65778d", "editorCursor.foreground": "#9bc2ff" } });
        editor.current = library.editor.create(host.current, { theme: "cce-dark", readOnly: true, domReadOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 14, lineHeight: 23, fontFamily: "Consolas, 'SFMono-Regular', monospace", ariaLabel: "File preview, editing unavailable" });
        subscription = editor.current.onDidChangeCursorPosition((event) => cursor.current(event.position.lineNumber, event.position.column));
        selectModel();
        setReady(true);
      } catch {
        if (!cancelled) setError("The code preview could not load.");
      }
    })();
    return () => {
      cancelled = true;
      subscription?.dispose();
      editor.current?.dispose();
      editor.current = null;
      for (const model of models.current.values()) model.dispose();
      models.current.clear();
      monaco.current = null;
    };
  }, [selectModel]);

  return <div className="monaco-shell">
    {!ready && !error && <p role="status" className="editor-loading">Loading code preview…</p>}
    {error && <p role="alert" className="editor-loading">{error}</p>}
    <div ref={host} className="monaco-host" aria-hidden={!file} />
  </div>;
}
