"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { MonacoBinding } from "y-monaco";
import { DocumentProvider, type ConnectionState } from "@/collaboration/provider";

export type PreviewFile = { id: string; document_id: string | null; name: string; language: string | null };
type Editor = Monaco.editor.IStandaloneCodeEditor;

export default function MonacoPreview({ projectId, file, canEdit, onCursor, onState }: { projectId: string; file: PreviewFile | null; canEdit: boolean; onCursor: (line: number, column: number) => void; onState: (state: ConnectionState) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const monaco = useRef<typeof Monaco | null>(null);
  const bindingConstructor = useRef<typeof MonacoBinding | null>(null);
  const provider = useRef<DocumentProvider | null>(null);
  const binding = useRef<MonacoBinding | null>(null);
  const model = useRef<Monaco.editor.ITextModel | null>(null);
  const selected = useRef(file);
  const writable = useRef(canEdit);
  const stateCallback = useRef(onState);
  const cursorCallback = useRef(onCursor);
  const connectedID = useRef("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => { stateCallback.current = onState; cursorCallback.current = onCursor; writable.current = canEdit; editor.current?.updateOptions({ readOnly: !canEdit || !provider.current?.isSynced }); }, [onState, onCursor, canEdit]);

  const selectModel = useCallback(() => {
    const instance = editor.current; const library = monaco.current; const item = selected.current;
    const Binding = bindingConstructor.current;
    if (!instance || !library || !Binding) return;
    if (item?.document_id === connectedID.current) {
      if (item && model.current) library.editor.setModelLanguage(model.current, item.language ?? "plaintext");
      return;
    }
    binding.current?.destroy(); binding.current = null;
    provider.current?.close(); provider.current = null;
    model.current?.dispose(); model.current = null;
    connectedID.current = ""; instance.setModel(null);
    if (!item?.document_id) return;
    const uri = library.Uri.parse(`cce://project/${projectId}/${item.id}/${item.document_id}`);
    const nextModel = library.editor.createModel("", item.language ?? "plaintext", uri);
    model.current = nextModel;
    const nextProvider = new DocumentProvider(item.document_id, (state) => {
      if (provider.current !== nextProvider) return;
      instance.updateOptions({ readOnly: !writable.current || !nextProvider.isSynced || !["Synced", "Saving", "Saved"].includes(state) });
      stateCallback.current(state);
    });
    provider.current = nextProvider;
    binding.current = new Binding(nextProvider.doc.getText("content"), nextModel, new Set([instance]));
    instance.setModel(nextModel); instance.updateOptions({ readOnly: true });
    connectedID.current = item.document_id; stateCallback.current("Connecting");
  }, [projectId]);

  useEffect(() => { selected.current = file; if (ready) selectModel(); }, [file, ready, selectModel]);

  useEffect(() => {
    let cancelled = false; let subscription: Monaco.IDisposable | undefined;
    (async () => {
      try {
        const environment = self as typeof self & { MonacoEnvironment?: { getWorker: (_module: string, label: string) => Worker } };
        environment.MonacoEnvironment = { getWorker: (_module, label) => {
          if (label === "json") return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
          if (label === "css" || label === "scss" || label === "less") return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" });
          if (label === "html" || label === "handlebars" || label === "razor") return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" });
          if (label === "typescript" || label === "javascript") return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
          return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
        } };
        const library = await import("monaco-editor/esm/vs/editor/editor.api");
        const { MonacoBinding: Binding } = await import("y-monaco");
        await Promise.all([
          import("monaco-editor/esm/vs/language/typescript/monaco.contribution"), import("monaco-editor/esm/vs/language/json/monaco.contribution"),
          import("monaco-editor/esm/vs/language/css/monaco.contribution"), import("monaco-editor/esm/vs/language/html/monaco.contribution"),
          import("monaco-editor/esm/vs/basic-languages/python/python.contribution"), import("monaco-editor/esm/vs/basic-languages/go/go.contribution"),
          import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution"), import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution")
        ]);
        if (cancelled || !host.current) return;
        monaco.current = library;
        bindingConstructor.current = Binding;
        library.editor.defineTheme("cce-dark", { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": "#111720", "editor.foreground": "#e1e8f2", "editorLineNumber.foreground": "#65778d", "editorCursor.foreground": "#9bc2ff" } });
        editor.current = library.editor.create(host.current, { theme: "cce-dark", readOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 14, lineHeight: 23, fontFamily: "Consolas, 'SFMono-Regular', monospace", ariaLabel: "Collaborative code editor" });
        subscription = editor.current.onDidChangeCursorPosition((event) => cursorCallback.current(event.position.lineNumber, event.position.column));
        selectModel(); setReady(true);
      } catch { if (!cancelled) setError("The code editor could not load."); }
    })();
    return () => {
      cancelled = true; subscription?.dispose(); binding.current?.destroy(); provider.current?.close(); model.current?.dispose(); editor.current?.dispose();
      binding.current = null; bindingConstructor.current = null; provider.current = null; model.current = null; editor.current = null; monaco.current = null; connectedID.current = "";
    };
  }, [selectModel]);

  return <div className="monaco-shell">
    {!ready && !error && <p role="status" className="editor-loading">Loading code editor…</p>}
    {error && <p role="alert" className="editor-loading">{error}</p>}
    <div ref={host} className="monaco-host" aria-hidden={!file} />
  </div>;
}
