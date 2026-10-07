import { sample } from "./measurements";
import * as Y from "yjs";
import type * as Monaco from "monaco-editor";
import type { MonacoBinding } from "y-monaco";
import type { DocumentProvider } from "./provider";

export function bindEditor(library: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor, model: Monaco.editor.ITextModel, provider: DocumentProvider, Binding: typeof MonacoBinding, collaborators: (names: { id: number; name: string }[]) => void) {
  const text = provider.doc.getText("content");
  // y-monaco 0.1.6 transacts with `this` as origin. Remote/cache origins
  // and every other binding are deliberately outside this UndoManager.
  const binding = new Binding(text, model, new Set([editor]));
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([binding]) });
  const undoAction = editor.addAction({ id: "undo", label: "Undo local edit", keybindings: [library.KeyMod.CtrlCmd | library.KeyCode.KeyZ], precondition: "!editorReadonly", run: () => { if (provider.canType) undo.undo(); } });
  const redoAction = editor.addAction({ id: "redo", label: "Redo local edit", keybindings: [library.KeyMod.CtrlCmd | library.KeyMod.Shift | library.KeyCode.KeyZ, library.KeyMod.CtrlCmd | library.KeyCode.KeyY], precondition: "!editorReadonly", run: () => { if (provider.canType) undo.redo(); } });
  let decorations: string[] = [];
  const style = document.createElement("style"); document.head.append(style);
  const render = () => {
    const next: Monaco.editor.IModelDeltaDecoration[] = []; const rules: string[] = []; const names: { id: number; name: string }[] = [];
    for (const [id, state] of provider.awareness.getStates()) {
      if (id === provider.doc.clientID || !state.user) continue;
      const user = state.user as { name: string; color: string };
      if (!/^#[0-9a-f]{6}$/i.test(user.color)) continue;
      names.push({ id, name: user.name });
      if (!state.selection) continue;
      const anchor = Y.createAbsolutePositionFromRelativePosition(state.selection.anchor, provider.doc);
      const head = Y.createAbsolutePositionFromRelativePosition(state.selection.head, provider.doc);
      if (!anchor || !head || anchor.type !== text || head.type !== text) continue;
      const start = model.getPositionAt(Math.min(anchor.index,head.index)); const end = model.getPositionAt(Math.max(anchor.index,head.index));
      const cursor = model.getPositionAt(head.index);
      next.push({ range: new library.Range(start.lineNumber,start.column,end.lineNumber,end.column), options: { className: `cce-selection-${id}` } });
      next.push({ range: new library.Range(cursor.lineNumber,cursor.column,cursor.lineNumber,cursor.column), options: { beforeContentClassName: `cce-cursor-${id}`, hoverMessage: { value: user.name.replace(/[\\`*_{}[\]()#+.!<>]/g,"\\$&") } } });
      rules.push(`.cce-selection-${id}{background:${user.color}33}.cce-cursor-${id}{border-left:2px solid ${user.color};height:100%;}`);
    }
    decorations = editor.deltaDecorations(decorations,next); style.textContent = rules.join("\n"); collaborators(names);
  };
  const publish = () => {
    const selection = editor.getSelection(); if (!selection || editor.getModel() !== model) return;
    provider.awareness.setLocalState({ selection: {
      anchor: Y.createRelativePositionFromTypeIndex(text,model.getOffsetAt(selection.getSelectionStart())),
      head: Y.createRelativePositionFromTypeIndex(text,model.getOffsetAt(selection.getPosition()))
    } });
  };
  let keyAt: number | undefined; let disposed=false;
 const key = editor.onKeyDown(event => { if (event.browserEvent.key.length===1 || ["Backspace","Delete","Enter"].includes(event.browserEvent.key)) keyAt = performance.now(); });
 const content = model.onDidChangeContent(() => { if (keyAt === undefined) return; const at=keyAt; keyAt=undefined; requestAnimationFrame(() => requestAnimationFrame(() => { if (!disposed) sample("local_render_ms",performance.now()-at); })); });
 const cursor = editor.onDidChangeCursorSelection(publish);
  provider.awareness.on("change",render); text.observe(render);
  publish();
  return () => {
    disposed=true; key.dispose(); content.dispose(); cursor.dispose(); undoAction.dispose(); redoAction.dispose(); undo.destroy();
    provider.awareness.off("change",render); text.unobserve(render); editor.deltaDecorations(decorations,[]); style.remove(); collaborators([]); binding.destroy();
  };
}
