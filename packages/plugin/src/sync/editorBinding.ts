import { Compartment, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { MarkdownView } from 'obsidian';
import { yCollab, ySyncFacet } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { getHostEditorView } from './hostCm6';
import { applyDiffToYText } from './diff';

export interface EditorBindingHost {
  readonly awareness: Awareness;
  readonly readOnly: boolean;
  readonly deviceName: string;
  isPathForThisEngine(vaultPath: string): boolean;
  toDocPath(vaultPath: string): string;
  getOrCreateYText(docPath: string): Y.Text;
  acceptLocalEditorContent?(docPath: string): void;
}

export interface EditorBinding {
  view: MarkdownView;
  path: string;
  cm: EditorView;
  cmId: string;
  deviceName: string;
  undoManager: Y.UndoManager;
}

export interface BindingHealthStatus {
  bound: boolean;
  healthy: boolean;
  settling: boolean;
  issues: string[];
}

export interface EditorBindingDebugState {
  knownCmViews: number;
  ambiguousCandidates: number;
  bindings: Array<{
    leafId: string;
    path: string;
    cmId: string;
    deviceName: string;
  }>;
}

export interface BindingDebugInfo {
  leafId: string;
  path: string;
  cmId: string;
}

export class EditorBindingManager {
  readonly compartment = new Compartment();

  private bindings = new Map<string, EditorBinding>();
  private knownCmViews = new Set<EditorView>();
  private cmIds = new WeakMap<EditorView, string>();
  private cmToLeafId = new WeakMap<EditorView, string>();
  private cmCounter = 0;
  private ambiguousCandidates = 0;
  /** Pending binds waiting for a CM view to become available. */
  private pendingBinds = new Map<string, { view: MarkdownView; deviceName: string; createdAt: number }>();
  private static readonly PENDING_BIND_TIMEOUT_MS = 5_000;

  constructor(private readonly host?: EditorBindingHost) {}

  getBaseExtension(): Extension {
    const registerKnownCmView = this.registerKnownCmView.bind(this);
    const handleLiveEditorUpdate = this.handleLiveEditorUpdate.bind(this);
    const unregisterKnownCmView = this.unregisterKnownCmView.bind(this);

    return [
      this.compartment.of([]),
      ViewPlugin.fromClass(
        class {
          constructor(readonly view: EditorView) {
            registerKnownCmView(view);
          }

          update(update: ViewUpdate): void {
            handleLiveEditorUpdate(update);
          }

          destroy(): void {
            unregisterKnownCmView(this.view);
          }
        },
      ),
    ];
  }

  bind(view: MarkdownView, deviceName: string): void {
    this.pruneStaleBindings();

    const leafId = this.getLeafId(view);

    if (!this.host) return;

    const file = view.file;
    if (!file || !file.path.endsWith('.md') || !this.host.isPathForThisEngine(file.path) || this.host.readOnly) {
      this.unbindByLeafId(leafId);
      return;
    }

    const cm = this.getCmView(view);
    if (!cm) {
      // Queue for deferred binding — CM view may not be mounted yet
      if (!this.pendingBinds.has(leafId)) {
        console.info(
          `[SaltSync:Binding] bind deferred: getCmView returned null, queued for retry`,
          { leafId, path: file.path, knownCmViews: this.knownCmViews.size, ambiguousCandidates: this.ambiguousCandidates },
        );
        this.pendingBinds.set(leafId, { view, deviceName, createdAt: Date.now() });
      }
      return;
    }
    // If we had a pending entry for this leaf, it's been resolved
    this.pendingBinds.delete(leafId);

    const cmId = this.getCmId(cm);
    const existing = this.bindings.get(leafId);
    if (existing && existing.path === file.path && existing.cm === cm) {
      return;
    }

    if (existing) {
      this.unbindByLeafId(leafId);
    }

    const target = this.resolveBindingTarget(view);
    if (!target) {
      console.warn(
        `[SaltSync:Binding] bind failed: resolveBindingTarget returned null`,
        { leafId, path: file.path },
      );
      return;
    }

    this.cmToLeafId.set(cm, leafId);
    this.applyBinding({
      view,
      cm,
      leafId,
      path: file.path,
      cmId,
      deviceName,
      ytext: target,
    });
    console.info(`[SaltSync:Binding] bound`, { leafId, path: file.path, cmId });
  }

  repair(view: MarkdownView, deviceName: string, _reason: string): boolean {
    const health = this.getBindingHealth(view);
    if (!health.bound) {
      this.bind(view, deviceName);
      return this.getBindingHealth(view).healthy;
    }
    if (health.healthy) return true;
    this.rebind(view, deviceName, 'repair');
    return this.getBindingHealth(view).bound;
  }

  heal(view: MarkdownView, deviceName: string, _reason: string): boolean {
    if (!this.host || this.host.readOnly) return false;
    const file = view.file;
    if (!file || !file.path.endsWith('.md') || !this.host.isPathForThisEngine(file.path)) return false;

    const ytext = this.resolveBindingTarget(view);
    if (!ytext) return false;
    const currentContent = view.editor.getValue();
    const crdtContent = ytext.toString();
    if (crdtContent !== currentContent) {
      applyDiffToYText(ytext, crdtContent, currentContent, 'editor-health-heal');
    }

    return this.repair(view, deviceName, 'heal');
  }

  rebind(view: MarkdownView, deviceName: string, _reason: string): void {
    this.unbind(view);
    this.bind(view, deviceName);
  }

  unbind(view: MarkdownView): void {
    this.unbindByLeafId(this.getLeafId(view));
  }

  unbindByPath(path: string): void {
    this.pruneStaleBindings();
    for (const [leafId, binding] of this.bindings.entries()) {
      if (binding.path === path) {
        this.unbindByLeafId(leafId);
      }
    }
  }

  unbindAll(): void {
    for (const leafId of [...this.bindings.keys()]) {
      this.unbindByLeafId(leafId);
    }
    this.pendingBinds.clear();
  }

  getCmView(view: MarkdownView): EditorView | null {
    const direct = getHostEditorView(view);
    if (isEditorViewLike(direct)) {
      this.ambiguousCandidates = 0;
      return direct as EditorView;
    }

    const candidates = [...this.knownCmViews];
    if (candidates.length === 1) {
      this.ambiguousCandidates = 0;
      return candidates[0];
    }

    // Disambiguate split-pane: match candidate to leafId via cmToLeafId
    if (candidates.length > 1) {
      const leafId = this.getLeafId(view);
      const matched = candidates.find((cm) => this.cmToLeafId.get(cm) === leafId);
      if (matched) {
        this.ambiguousCandidates = 0;
        return matched;
      }
    }

    this.ambiguousCandidates = candidates.length > 1 ? candidates.length : 0;

    if (candidates.length === 0) {
      console.warn(`[SaltSync:Binding] getCmView: no EditorView available`, {
        path: view.file?.path ?? 'unknown',
        hasEditor: !!view.editor,
        directProbeResult: direct === null ? 'null' : 'non-EditorView-like',
      });
    } else {
      console.warn(`[SaltSync:Binding] getCmView: ambiguous — ${candidates.length} candidates, leafId lookup failed`, {
        path: view.file?.path ?? 'unknown',
      });
    }

    return null;
  }

  getBindingHealth(view: MarkdownView): BindingHealthStatus {
    this.pruneStaleBindings();

    const leafId = this.getLeafId(view);
    const binding = this.bindings.get(leafId);
    if (!binding) {
      return {
        bound: false,
        healthy: false,
        settling: false,
        issues: ['not-bound'],
      };
    }

    const liveCm = this.getCmView(view);
    const issues: string[] = [];
    if (!liveCm) issues.push('missing-editor-view');
    if (!liveCm && this.ambiguousCandidates > 1) issues.push('ambiguous-editor-view');
    if (liveCm && liveCm !== binding.cm) issues.push('cm-mismatch');
    if (view.file?.path !== binding.path) issues.push('path-mismatch');
    const syncFacet = getSyncFacet(binding.cm);
    if (syncFacet === false) issues.push('missing-y-sync-facet');

    return {
      bound: true,
      healthy: issues.length === 0,
      settling: false,
      issues,
    };
  }

  debugState(): EditorBindingDebugState {
    this.pruneStaleBindings();

    return {
      knownCmViews: this.knownCmViews.size,
      ambiguousCandidates: this.ambiguousCandidates,
      bindings: [...this.bindings.entries()].map(([leafId, binding]) => ({
        leafId,
        path: binding.path,
        cmId: binding.cmId,
        deviceName: binding.deviceName,
      })),
    };
  }

  bindAllOpenEditors(views: MarkdownView[], deviceName: string): void {
    for (const view of views) {
      this.bind(view, deviceName);
    }
  }

  validateAllOpenBindings(views: MarkdownView[], deviceName: string): void {
    for (const view of views) {
      const health = this.getBindingHealth(view);
      if (!health.bound) {
        this.bind(view, deviceName);
        const leafId = this.getLeafId(view);
        if (this.bindings.has(leafId)) continue;
        if (this.pendingBinds.has(leafId)) {
          console.info(`[SaltSync:Binding] validate: binding still settling`, {
            path: view.file?.path ?? 'unknown',
          });
          continue;
        }
        console.warn(`[SaltSync:Binding] validate: not bound, bind attempt did not attach`, {
          path: view.file?.path ?? 'unknown',
        });
      } else if (!health.healthy) {
        // ySyncFacet loss or CM instance replacement means the CM state was
        // rebuilt — heal (which patches Y.Text) won't help, we need a full
        // rebind to re-dispatch the compartment extension.
        const needsRebind = health.issues.some(
          (i) => i === 'missing-y-sync-facet' || i === 'cm-mismatch',
        );
        if (needsRebind) {
          console.warn(`[SaltSync:Binding] validate: structural issue, attempting rebind`, {
            path: view.file?.path ?? 'unknown',
            issues: health.issues,
          });
          this.rebind(view, deviceName, health.issues.join(','));
        } else {
          console.warn(`[SaltSync:Binding] validate: unhealthy, attempting heal`, {
            path: view.file?.path ?? 'unknown',
            issues: health.issues,
          });
          this.heal(view, deviceName, health.issues.join(','));
        }
      }
    }
  }

  updatePathsAfterRename(renames: Map<string, string>): void {
    for (const binding of this.bindings.values()) {
      const renamed = renames.get(binding.path);
      if (renamed) {
        binding.path = renamed;
      }
    }
  }

  isBound(path: string): boolean {
    for (const binding of this.bindings.values()) {
      if (binding.path === path) return true;
    }
    return false;
  }

  /** Check if a path has a healthy yCollab binding (bound + no issues). */
  isHealthyBinding(path: string): boolean {
    for (const [, binding] of this.bindings.entries()) {
      if (binding.path !== path) continue;
      const liveCm = this.knownCmViews.has(binding.cm) ? binding.cm : null;
      if (!liveCm) return false;
      const syncFacet = getSyncFacet(binding.cm);
      if (syncFacet === false) return false;
      return true;
    }
    return false;
  }

  getBindingDebugInfo(path: string): BindingDebugInfo | null {
    for (const [leafId, binding] of this.bindings.entries()) {
      if (binding.path === path) {
        return { leafId, path: binding.path, cmId: binding.cmId };
      }
    }
    return null;
  }

  private registerKnownCmView(view: EditorView): void {
    const isNew = !this.knownCmViews.has(view);
    this.knownCmViews.add(view);
    this.getCmId(view);
    if (isNew) {
      this.drainPendingBinds();
    }
  }

  private unregisterKnownCmView(view: EditorView): void {
    this.knownCmViews.delete(view);
    this.cmToLeafId.delete(view);
    for (const [leafId, binding] of this.bindings.entries()) {
      if (binding.cm === view) this.unbindByLeafId(leafId);
    }
    this.pruneStaleBindings();
  }

  private handleLiveEditorUpdate(update: ViewUpdate): void {
    this.registerKnownCmView(update.view);
  }

  private getCmId(view: EditorView): string {
    const existing = this.cmIds.get(view);
    if (existing) return existing;
    this.cmCounter += 1;
    const next = `cm-${this.cmCounter}`;
    this.cmIds.set(view, next);
    return next;
  }

  private getLeafId(view: MarkdownView): string {
    const leafId = (view as MarkdownView & { leaf?: { id?: string } }).leaf?.id;
    return leafId ?? view.file?.path ?? 'unknown-leaf';
  }

  private resolveBindingTarget(view: MarkdownView): Y.Text | null {
    if (!this.host) return null;
    const file = view.file;
    if (!file) return null;
    const ytext = this.host.getOrCreateYText(this.host.toDocPath(file.path));
    const editorContent = view.editor.getValue();
    if (ytext.length === 0 && editorContent.length > 0) {
      applyDiffToYText(ytext, '', editorContent, 'local-init');
      this.host.acceptLocalEditorContent?.(this.host.toDocPath(file.path));
    }
    return ytext;
  }

  private applyBinding(options: {
    view: MarkdownView;
    cm: EditorView;
    leafId: string;
    path: string;
    cmId: string;
    deviceName: string;
    ytext: Y.Text;
  }): void {
    if (!this.host) return;

    const undoManager = new Y.UndoManager(options.ytext);
    const extension = yCollab(options.ytext, this.host.awareness, { undoManager });
    options.cm.dispatch({ effects: this.compartment.reconfigure(extension) });
    this.bindings.set(options.leafId, {
      view: options.view,
      path: options.path,
      cm: options.cm,
      cmId: options.cmId,
      deviceName: options.deviceName,
      undoManager,
    });
  }

  private unbindByLeafId(leafId: string): void {
    const binding = this.bindings.get(leafId);
    if (!binding) return;
    console.info(`[SaltSync:Binding] unbound`, { leafId, path: binding.path, cmId: binding.cmId });
    binding.undoManager.destroy();
    try {
      binding.cm.dispatch({ effects: this.compartment.reconfigure([]) });
    } catch {
      // View may already be destroyed
    }
    this.cmToLeafId.delete(binding.cm);
    this.bindings.delete(leafId);
  }

  private drainPendingBinds(): void {
    const now = Date.now();
    for (const [leafId, pending] of [...this.pendingBinds.entries()]) {
      if (now - pending.createdAt > EditorBindingManager.PENDING_BIND_TIMEOUT_MS) {
        console.warn(`[SaltSync:Binding] pending bind expired`, {
          leafId, path: pending.view.file?.path ?? 'unknown',
          age: now - pending.createdAt,
        });
        this.pendingBinds.delete(leafId);
        continue;
      }
      // Attempt to bind — bind() will remove from pendingBinds on success
      // or re-queue if still no CM view available
      this.pendingBinds.delete(leafId);
      this.bind(pending.view, pending.deviceName);
    }
  }

  private pruneStaleBindings(): void {
    for (const [leafId, binding] of this.bindings.entries()) {
      if (!binding.view.file) {
        this.bindings.delete(leafId);
        continue;
      }

      if (binding.view.file.path !== binding.path) {
        this.bindings.delete(leafId);
        continue;
      }

      if (this.knownCmViews.size > 0 && !this.knownCmViews.has(binding.cm)) {
        this.bindings.delete(leafId);
      }
    }
  }
}

function isEditorViewLike(value: unknown): value is EditorView {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { state?: unknown; dispatch?: unknown };
  return typeof candidate.dispatch === 'function' && 'state' in candidate;
}

function getSyncFacet(view: EditorView): unknown | false | null {
  const state = view.state as { facet?: (facet: unknown) => unknown } | undefined;
  if (typeof state?.facet !== 'function') return null;
  try {
    return state.facet(ySyncFacet) ?? false;
  } catch {
    return false;
  }
}
