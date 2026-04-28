/**
 * Minimal Obsidian API mock for vitest.
 *
 * Surface used by salt-sync:
 *   Vault: getFileByPath / getAbstractFileByPath / read / readBinary
 *          / modify / modifyBinary / create / createBinary / delete
 *          / getMarkdownFiles / on / off (event emitter)
 *   TFile: stat presence (used as "is TFile" discriminator)
 *   Workspace: on / getActiveViewOfType (returns null in tests)
 *   App: vault, workspace
 *   Plugin: app, registerEvent (collects refs for cleanup)
 *   MarkdownView: class so `instanceof` works in vaultSync
 *   requestUrl: wraps node fetch, returning {status, json, arrayBuffer, text}
 */

export class TFile {
  constructor(
    public path: string,
    public stat: { size: number; mtime: number; ctime: number },
  ) {}
}

export class TFolder {
  constructor(public path: string) {}
}

export type TAbstractFile = TFile | TFolder;

type Handler = (...args: unknown[]) => void;

export class MockVault {
  files = new Map<string, TFile>();
  folders = new Map<string, TFolder>();
  contents = new Map<string, string | Uint8Array>();
  private handlers = new Map<string, Set<Handler>>();

  getFileByPath(path: string): TFile | null {
    return this.files.get(path) ?? null;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(path) ?? this.folders.get(path) ?? null;
  }

  /** Returns all .md files. Used by VaultSyncEngine.reconcile(). */
  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].filter((f) => f.path.endsWith('.md'));
  }

  getFiles(): TFile[] {
    return [...this.files.values()];
  }

  async read(file: TFile): Promise<string> {
    const c = this.contents.get(file.path);
    if (typeof c !== 'string') throw new Error(`not a text file: ${file.path}`);
    return c;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const c = this.contents.get(file.path);
    if (!(c instanceof Uint8Array)) throw new Error(`not a binary file: ${file.path}`);
    return c.slice().buffer;
  }

  async modify(file: TFile, content: string): Promise<void> {
    this.contents.set(file.path, content);
    file.stat = { size: content.length, mtime: Date.now(), ctime: file.stat.ctime };
    this.emit('modify', file);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    const bytes = new Uint8Array(data);
    this.contents.set(file.path, bytes);
    file.stat = { size: bytes.byteLength, mtime: Date.now(), ctime: file.stat.ctime };
    this.emit('modify', file);
  }

  async create(path: string, content: string): Promise<TFile> {
    const now = Date.now();
    const file = new TFile(path, { size: content.length, mtime: now, ctime: now });
    this.files.set(path, file);
    this.contents.set(path, content);
    this.emit('create', file);
    return file;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const bytes = new Uint8Array(data);
    const now = Date.now();
    const file = new TFile(path, { size: bytes.byteLength, mtime: now, ctime: now });
    this.files.set(path, file);
    this.contents.set(path, bytes);
    this.emit('create', file);
    return file;
  }

  async delete(file: TAbstractFile): Promise<void> {
    if (file instanceof TFile) {
      this.files.delete(file.path);
      this.contents.delete(file.path);
    } else {
      this.folders.delete(file.path);
    }
    this.emit('delete', file);
  }

  async rename(file: TFile, newPath: string): Promise<TFile> {
    const content = this.contents.get(file.path);
    const oldPath = file.path;
    this.files.delete(oldPath);
    this.contents.delete(oldPath);
    file.path = newPath;
    file.stat = { ...file.stat, mtime: Date.now() };
    this.files.set(newPath, file);
    if (content !== undefined) {
      this.contents.set(newPath, content);
    }
    this.emit('rename', file, oldPath);
    return file;
  }

  on(event: string, handler: Handler): { event: string; handler: Handler } {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return { event, handler };
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((h) => h(...args));
  }

  /** Direct seeding helper for tests (bypasses events). */
  seedText(path: string, content: string): TFile {
    const now = Date.now();
    const file = new TFile(path, { size: content.length, mtime: now, ctime: now });
    this.files.set(path, file);
    this.contents.set(path, content);
    return file;
  }

  seedBinary(path: string, bytes: Uint8Array): TFile {
    const now = Date.now();
    const file = new TFile(path, { size: bytes.byteLength, mtime: now, ctime: now });
    this.files.set(path, file);
    this.contents.set(path, bytes);
    return file;
  }

  seedFolder(path: string): TFolder {
    const folder = new TFolder(path);
    this.folders.set(path, folder);
    return folder;
  }
}

// Typed as the Vault import salt-sync uses
export type Vault = MockVault;

// Placeholder exports used in type positions only (kept to match obsidian.d.ts)
export interface Editor {
  getValue(): string;
  setValue(v: string): void;
  getCursor(): unknown;
  setCursor(_: unknown): void;
}

/** Class form so `instanceof MarkdownView` works (vaultSync uses getActiveViewOfType). */
export class MarkdownView {
  file: TFile | null = null;
  editor: Editor = {
    getValue: () => '',
    setValue: () => {},
    getCursor: () => null,
    setCursor: () => {},
  };
}

export class MockWorkspace {
  private handlers = new Map<string, Set<Handler>>();
  leaves: Array<{ view: MarkdownView }> = [];

  on(event: string, handler: Handler): { event: string; handler: Handler } {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return { event, handler };
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((h) => h(...args));
  }

  /** No active leaf in tests; engine should treat this as "no editor binding". */
  getActiveViewOfType<T>(_klass: unknown): T | null {
    return null;
  }

  getLeavesOfType(_viewType: string): Array<{ view: MarkdownView }> {
    return this.leaves;
  }

  /** Tests run with layout already ready; invoke callback on next tick. */
  onLayoutReady(cb: () => void): void {
    queueMicrotask(cb);
  }
}

export class MockApp {
  constructor(
    public vault: MockVault = new MockVault(),
    public workspace: MockWorkspace = new MockWorkspace(),
  ) {}
}

export interface EventRef {
  event: string;
  handler: Handler;
}

/**
 * Minimal Plugin shape used by VaultSyncEngine.
 * registerEvent: collect refs so the test harness can clean up.
 * registerEditorExtension: collect extensions (yCollab compartment lives here).
 */
export class MockPlugin {
  registeredEvents: EventRef[] = [];
  registeredEditorExtensions: unknown[] = [];

  constructor(public app: MockApp = new MockApp()) {}

  registerEvent(ref: EventRef): EventRef {
    this.registeredEvents.push(ref);
    return ref;
  }

  registerEditorExtension(ext: unknown): void {
    this.registeredEditorExtensions.push(ext);
  }
}

export type Plugin = MockPlugin;
export type App = MockApp;

export interface PluginSettingTab {}
export interface WorkspaceLeaf {}

export const Notice = class {
  constructor(_message: string) {}
};

// ── requestUrl: wraps node fetch ─────────────────────────────────────────────

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array;
}

export interface RequestUrlResponse {
  status: number;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}

export async function requestUrl(opts: RequestUrlParam): Promise<RequestUrlResponse> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: opts.headers,
  };
  if (opts.body !== undefined) {
    init.body = opts.body as BodyInit;
  }
  const resp = await fetch(opts.url, init);
  const arrayBuffer = await resp.arrayBuffer();
  const text = new TextDecoder('utf-8').decode(arrayBuffer);

  let json: unknown = null;
  try {
    json = text.length ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });

  return { status: resp.status, text, json, arrayBuffer, headers };
}
