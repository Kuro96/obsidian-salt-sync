import { describe, expect, it } from 'vitest';
import { EditorBindingManager } from '../../src/sync/editorBinding';
import { MarkdownView, TFile } from '../mocks/obsidian';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

function makeHost() {
  const ydoc = new Y.Doc();
  return {
    ydoc,
    awareness: new Awareness(ydoc),
    readOnly: false,
    deviceName: 'device-a',
    isPathForThisEngine: () => true,
    toDocPath: (path: string) => path,
    getOrCreateYText: (path: string) => ydoc.getText(path),
  };
}

function makeView(path = 'note.md') {
  const view = new MarkdownView() as MarkdownView & { leaf?: { id?: string } };
  view.file = new TFile(path, { size: 0, mtime: Date.now(), ctime: Date.now() });
  view.leaf = { id: `leaf:${path}` };
  return view;
}

function makeCmView() {
  const dispatched: unknown[] = [];
  return {
    state: {
      doc: 'hello',
      facet: () => ({ ok: true }),
    },
    dispatch: (payload: unknown) => {
      dispatched.push(payload);
    },
    dispatched,
  };
}

describe('EditorBindingManager', () => {
  it('returns a base extension that includes the tracking compartment', () => {
    const manager = new EditorBindingManager();
    const extension = manager.getBaseExtension();

    expect(Array.isArray(extension)).toBe(true);
    expect(extension).toHaveLength(2);
  });

  it('binds and unbinds a markdown view using the resolved host cm view', () => {
    const manager = new EditorBindingManager(makeHost());
    const view = makeView();
    const cm = makeCmView();
    (view.editor as unknown as { cm: unknown }).cm = cm;

    manager.bind(view, 'device-a');

    expect(manager.debugState()).toEqual({
      knownCmViews: 0,
      ambiguousCandidates: 0,
      bindings: [
        {
          leafId: 'leaf:note.md',
          path: 'note.md',
          cmId: 'cm-1',
          deviceName: 'device-a',
        },
      ],
    });
    expect(manager.getBindingHealth(view)).toEqual({
      bound: true,
      healthy: true,
      settling: false,
      issues: [],
    });

    manager.unbind(view);
    expect(manager.debugState().bindings).toHaveLength(0);
  });

  it('dispatches a compartment reconfigure when binding through y-collab', () => {
    const ydoc = new Y.Doc();
    const manager = new EditorBindingManager({
      awareness: new Awareness(ydoc),
      readOnly: false,
      deviceName: 'device-a',
      isPathForThisEngine: () => true,
      toDocPath: (path) => path,
      getOrCreateYText: () => ydoc.getText('doc'),
    });
    const view = makeView();
    const cm = makeCmView();
    (view.editor as unknown as { cm: unknown; getValue: () => string }).cm = cm;
    view.editor.getValue = () => '';

    manager.bind(view, 'device-a');

    expect(cm.dispatched).toHaveLength(1);
  });

  it('tracks live editor views through the base extension plugin lifecycle', () => {
    const manager = new EditorBindingManager();
    const cm = makeCmView();

    (manager as unknown as { registerKnownCmView: (view: unknown) => void }).registerKnownCmView(cm);

    expect(manager.debugState().knownCmViews).toBe(1);

    (manager as unknown as { unregisterKnownCmView: (view: unknown) => void }).unregisterKnownCmView(cm);
    expect(manager.debugState().knownCmViews).toBe(0);
  });

  it('drops stale bindings when the tracked cm view disappears', () => {
    const manager = new EditorBindingManager(makeHost());
    const view = makeView();
    const cm = makeCmView();
    (view.editor as unknown as { cm: unknown }).cm = cm;

    (manager as unknown as { registerKnownCmView: (view: unknown) => void }).registerKnownCmView(cm);
    manager.bind(view, 'device-a');
    expect(manager.debugState().bindings).toHaveLength(1);

    (manager as unknown as { unregisterKnownCmView: (view: unknown) => void }).unregisterKnownCmView(cm);
    expect(manager.debugState().bindings).toHaveLength(0);
  });

  it('surfaces ambiguity when multiple known cm views exist and no direct host cm is available', () => {
    const manager = new EditorBindingManager();
    const view = makeView();
    const cmA = makeCmView();
    const cmB = makeCmView();

    (manager as unknown as { registerKnownCmView: (view: unknown) => void }).registerKnownCmView(cmA);
    (manager as unknown as { registerKnownCmView: (view: unknown) => void }).registerKnownCmView(cmB);

    expect(manager.getCmView(view)).toBeNull();
    expect(manager.debugState().ambiguousCandidates).toBe(2);
  });

  it('disambiguates split-pane by matching cmToLeafId', () => {
    const host = makeHost();
    const manager = new EditorBindingManager(host);
    const viewA = makeView('a.md');
    const viewB = makeView('b.md');
    const cmA = makeCmView();
    const cmB = makeCmView();

    // Set up direct host cm for initial binding so cmToLeafId gets populated
    (viewA.editor as unknown as { cm: unknown }).cm = cmA;
    (viewB.editor as unknown as { cm: unknown }).cm = cmB;
    manager.bind(viewA, 'device-a');
    manager.bind(viewB, 'device-a');

    // Now simulate the ambiguous case: clear the direct cm reference,
    // register both CM views as known, and rely on cmToLeafId for resolution
    (viewA.editor as unknown as { cm: unknown }).cm = null;
    (manager as unknown as { registerKnownCmView: (view: unknown) => void }).registerKnownCmView(cmA);
    (manager as unknown as { registerKnownCmView: (view: unknown) => void }).registerKnownCmView(cmB);

    // getCmView should resolve via cmToLeafId even with 2 candidates
    expect(manager.getCmView(viewA)).toBe(cmA);
  });

  it('defers binding when getCmView returns null and completes when CM appears', () => {
    const host = makeHost();
    const manager = new EditorBindingManager(host);
    const view = makeView('deferred.md');
    // No cm set — getCmView will return null

    manager.bind(view, 'device-a');
    // Should NOT be bound yet
    expect(manager.isBound('deferred.md')).toBe(false);

    // Now a CM view appears (simulating async mount)
    const cm = makeCmView();
    (view.editor as unknown as { cm: unknown }).cm = cm;
    // registerKnownCmView triggers drainPendingBinds
    (manager as unknown as { registerKnownCmView: (view: unknown) => void }).registerKnownCmView(cm);

    // Should now be bound
    expect(manager.isBound('deferred.md')).toBe(true);
  });

  it('rebinds a leaf when the active markdown view switches files', () => {
    const host = makeHost();
    const manager = new EditorBindingManager(host);
    const viewA = makeView('a.md');
    const viewB = makeView('b.md');
    viewB.leaf = viewA.leaf;
    const cmA = makeCmView();
    const cmB = makeCmView();
    (viewA.editor as unknown as { cm: unknown }).cm = cmA;
    (viewB.editor as unknown as { cm: unknown }).cm = cmB;

    manager.bind(viewA, 'device-a');
    manager.rebind(viewB, 'device-a', 'leaf-switch');

    expect(manager.debugState().bindings).toEqual([
      {
        leafId: 'leaf:a.md',
        path: 'b.md',
        cmId: 'cm-2',
        deviceName: 'device-a',
      },
    ]);
  });

  it('heals by applying current editor content into ytext before repair', () => {
    const host = makeHost();
    const manager = new EditorBindingManager(host);
    const view = makeView('heal.md');
    const cm = makeCmView();
    (view.editor as unknown as { cm: unknown }).cm = cm;
    view.editor.getValue = () => 'local content';

    const ytext = host.getOrCreateYText('heal.md');
    ytext.insert(0, 'remote content');

    expect(manager.heal(view, 'device-a', 'test-heal')).toBe(true);
    expect(ytext.toString()).toBe('local content');
  });

  it('binds and validates all open editors in one pass', () => {
    const host = makeHost();
    const manager = new EditorBindingManager(host);
    const viewA = makeView('a.md');
    const viewB = makeView('b.md');
    (viewA.editor as unknown as { cm: unknown }).cm = makeCmView();
    (viewB.editor as unknown as { cm: unknown }).cm = makeCmView();

    manager.bindAllOpenEditors([viewA, viewB], 'device-a');
    manager.validateAllOpenBindings([viewA, viewB], 'device-a');

    expect(manager.debugState().bindings).toHaveLength(2);
  });

  it('updates tracked paths after rename bookkeeping', () => {
    const host = makeHost();
    const manager = new EditorBindingManager(host);
    const view = makeView('old.md');
    (view.editor as unknown as { cm: unknown }).cm = makeCmView();

    manager.bind(view, 'device-a');
    manager.updatePathsAfterRename(new Map([['old.md', 'new.md']]));

    expect(manager.getBindingDebugInfo('new.md')).toEqual({
      leafId: 'leaf:old.md',
      path: 'new.md',
      cmId: 'cm-1',
    });
  });

  it('isHealthyBinding returns true for a healthy bound path', () => {
    const manager = new EditorBindingManager(makeHost());
    const view = makeView('note.md');
    const cm = makeCmView();
    (view.editor as unknown as { cm: unknown }).cm = cm;

    // Register the CM view as known (simulates the base extension lifecycle)
    (manager as unknown as { registerKnownCmView: (view: unknown) => void }).registerKnownCmView(cm);
    manager.bind(view, 'device-a');

    expect(manager.isHealthyBinding('note.md')).toBe(true);
    expect(manager.isHealthyBinding('other.md')).toBe(false);
  });

  it('isHealthyBinding returns false when cm view is no longer tracked', () => {
    const manager = new EditorBindingManager(makeHost());
    const view = makeView('note.md');
    const cm = makeCmView();
    (view.editor as unknown as { cm: unknown }).cm = cm;

    (manager as unknown as { registerKnownCmView: (view: unknown) => void }).registerKnownCmView(cm);
    manager.bind(view, 'device-a');
    // Simulate CM view destruction
    (manager as unknown as { unregisterKnownCmView: (view: unknown) => void }).unregisterKnownCmView(cm);

    expect(manager.isHealthyBinding('note.md')).toBe(false);
  });

  it('validateAllOpenBindings uses rebind for cm-mismatch instead of heal', () => {
    const host = makeHost();
    const manager = new EditorBindingManager(host);
    const view = makeView('note.md');
    const cmOld = makeCmView();
    const cmNew = makeCmView();

    (view.editor as unknown as { cm: unknown }).cm = cmOld;
    manager.bind(view, 'device-a');
    expect(manager.isBound('note.md')).toBe(true);

    // Simulate CM instance replacement: view now points to new CM
    (view.editor as unknown as { cm: unknown }).cm = cmNew;

    // validateAllOpenBindings should detect cm-mismatch and rebind
    manager.validateAllOpenBindings([view], 'device-a');

    const info = manager.getBindingDebugInfo('note.md');
    expect(info).not.toBeNull();
    // The cmId should have changed to reflect the new CM instance
    expect(info!.cmId).toBe('cm-2');
  });
});
