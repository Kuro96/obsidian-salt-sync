import type { MarkdownView } from 'obsidian';

type ConstructorLike = {
  name?: string;
  new (...args: unknown[]): unknown;
};

interface HostEditorStateLike {
  constructor?: ConstructorLike;
  config?: {
    compartments?: Iterable<unknown> | Map<unknown, unknown>;
  };
}

interface HostCompartmentLike {
  reconfigure(extension: unknown): unknown;
}

export interface HostEditorViewLike {
  constructor?: ConstructorLike;
  state?: HostEditorStateLike;
  dispatch?: (...args: unknown[]) => unknown;
  dom?: { tagName?: string } | null;
}

export interface HostCm6ProbeResult {
  hasMarkdownView: boolean;
  hasEditor: boolean;
  hasEditorView: boolean;
  editorViewConstructorName: string | null;
  editorStateConstructorName: string | null;
  hasDispatch: boolean;
  domTagName: string | null;
  compartmentConstructorName: string | null;
  canAttemptHostCompartment: boolean;
}

export interface HostCm6ReconfigureAttemptResult {
  ok: boolean;
  reason: string;
  dispatched: boolean;
  effectType: string | null;
}

export interface HostCm6AccessResult {
  ok: boolean;
  reason: string;
  view: HostEditorViewLike | null;
  compartmentConstructor: ConstructorLike | null;
  canDispatch: boolean;
}

export function getHostEditorView(view: MarkdownView | null): HostEditorViewLike | null {
  const candidate = (view?.editor as unknown as { cm?: HostEditorViewLike | null } | undefined)?.cm;
  return candidate ?? null;
}

export function resolveHostCm6Access(view: MarkdownView | null): HostCm6AccessResult {
  const cm = getHostEditorView(view);
  if (!cm) {
    return {
      ok: false,
      reason: 'missing-editor-view',
      view: null,
      compartmentConstructor: null,
      canDispatch: false,
    };
  }

  const canDispatch = typeof cm.dispatch === 'function';
  if (!canDispatch) {
    return {
      ok: false,
      reason: 'missing-dispatch',
      view: cm,
      compartmentConstructor: null,
      canDispatch: false,
    };
  }

  const compartmentConstructor = getCompartmentConstructorFromState(cm.state);
  if (!compartmentConstructor) {
    return {
      ok: false,
      reason: 'missing-compartment-constructor',
      view: cm,
      compartmentConstructor: null,
      canDispatch: true,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    view: cm,
    compartmentConstructor,
    canDispatch: true,
  };
}

export function probeHostCm6Runtime(view: MarkdownView | null): HostCm6ProbeResult {
  const editor = view?.editor ?? null;
  const access = resolveHostCm6Access(view);
  const cm = access.view;
  const compartmentCtor = access.compartmentConstructor;

  return {
    hasMarkdownView: !!view,
    hasEditor: !!editor,
    hasEditorView: !!cm,
    editorViewConstructorName: getConstructorName(cm),
    editorStateConstructorName: getConstructorName(cm?.state ?? null),
    hasDispatch: access.canDispatch,
    domTagName: typeof cm?.dom?.tagName === 'string' ? cm.dom.tagName : null,
    compartmentConstructorName: getConstructorName(compartmentCtor ? { constructor: compartmentCtor } : null),
    canAttemptHostCompartment: access.ok,
  };
}

function getCompartmentConstructorFromState(state: HostEditorStateLike | undefined): ConstructorLike | null {
  const compartments = state?.config?.compartments;
  if (!compartments) return null;

  for (const entry of compartments as Iterable<unknown>) {
    const key = Array.isArray(entry) ? entry[0] : entry;
    const ctor = (key as { constructor?: ConstructorLike } | null | undefined)?.constructor;
    if (typeof ctor === 'function') {
      return ctor;
    }
  }

  return null;
}

export function attemptHostCompartmentReconfigure(view: MarkdownView | null): HostCm6ReconfigureAttemptResult {
  const access = resolveHostCm6Access(view);
  if (!access.ok || !access.view || !access.compartmentConstructor) {
    return {
      ok: false,
      reason: access.reason,
      dispatched: false,
      effectType: null,
    };
  }

  try {
    const compartment = new access.compartmentConstructor() as HostCompartmentLike;
    if (typeof compartment.reconfigure !== 'function') {
      return {
        ok: false,
        reason: 'missing-reconfigure-method',
        dispatched: false,
        effectType: null,
      };
    }

    const effect = compartment.reconfigure([]);
    access.view.dispatch?.({ effects: effect });
    return {
      ok: true,
      reason: 'ok',
      dispatched: true,
      effectType: getConstructorName(effect as { constructor?: ConstructorLike } | null),
    };
  } catch (error) {
    return {
      ok: false,
      reason: formatErrorReason(error),
      dispatched: false,
      effectType: null,
    };
  }
}

function getConstructorName(value: { constructor?: ConstructorLike } | null | undefined): string | null {
  return value?.constructor?.name ?? null;
}

function formatErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown-error';
}
