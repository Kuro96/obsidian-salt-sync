import { describe, expect, it } from 'vitest';
import { MarkdownView } from '../mocks/obsidian';
import {
  attemptHostCompartmentReconfigure,
  getHostEditorView,
  probeHostCm6Runtime,
  resolveHostCm6Access,
} from '../../src/sync/hostCm6';

class FakeEffect {}
class FakeCompartment {
  reconfigure(_extension: unknown) {
    return new FakeEffect();
  }
}
class FakeEditorState {}
class FakeEditorView {}

describe('host CM6 runtime probe', () => {
  it('returns null when the markdown view has no cm editor view', () => {
    const view = new MarkdownView();

    expect(getHostEditorView(view)).toBeNull();
    expect(probeHostCm6Runtime(view)).toMatchObject({
      hasMarkdownView: true,
      hasEditor: true,
      hasEditorView: false,
      canAttemptHostCompartment: false,
    });
  });

  it('extracts host runtime constructor hints from the live cm view', () => {
    const view = new MarkdownView();
    const compartments = new Map([[new FakeCompartment(), 'ext']]);
    const cm = {
      constructor: FakeEditorView,
      state: {
        constructor: FakeEditorState,
        config: { compartments },
      },
      dispatch: () => {},
      dom: { tagName: 'DIV' },
    };

    (view.editor as unknown as { cm: unknown }).cm = cm;

    expect(getHostEditorView(view)).toBe(cm);
    expect(probeHostCm6Runtime(view)).toEqual({
      hasMarkdownView: true,
      hasEditor: true,
      hasEditorView: true,
      editorViewConstructorName: 'FakeEditorView',
      editorStateConstructorName: 'FakeEditorState',
      hasDispatch: true,
      domTagName: 'DIV',
      compartmentConstructorName: 'FakeCompartment',
      canAttemptHostCompartment: true,
    });
  });

  it('resolves a reusable host CM6 access adapter from the live editor view', () => {
    const view = new MarkdownView();
    const compartments = new Map([[new FakeCompartment(), 'ext']]);
    const cm = {
      constructor: FakeEditorView,
      state: {
        constructor: FakeEditorState,
        config: { compartments },
      },
      dispatch: () => {},
      dom: { tagName: 'DIV' },
    };

    (view.editor as unknown as { cm: unknown }).cm = cm;

    expect(resolveHostCm6Access(view)).toMatchObject({
      ok: true,
      reason: 'ok',
      view: cm,
      canDispatch: true,
    });
    expect(resolveHostCm6Access(view).compartmentConstructor?.name).toBe('FakeCompartment');
  });

  it('returns a structured adapter failure when dispatch is missing', () => {
    const view = new MarkdownView();
    const compartments = new Map([[new FakeCompartment(), 'ext']]);
    (view.editor as unknown as { cm: unknown }).cm = {
      constructor: FakeEditorView,
      state: {
        constructor: FakeEditorState,
        config: { compartments },
      },
      dom: { tagName: 'DIV' },
    };

    expect(resolveHostCm6Access(view)).toEqual({
      ok: false,
      reason: 'missing-dispatch',
      view: expect.any(Object),
      compartmentConstructor: null,
      canDispatch: false,
    });
  });

  it('attempts a host compartment reconfigure through the live dispatch path', () => {
    const view = new MarkdownView();
    const compartments = new Map([[new FakeCompartment(), 'ext']]);
    const dispatched: unknown[] = [];
    const cm = {
      constructor: FakeEditorView,
      state: {
        constructor: FakeEditorState,
        config: { compartments },
      },
      dispatch: (payload: unknown) => {
        dispatched.push(payload);
      },
      dom: { tagName: 'DIV' },
    };

    (view.editor as unknown as { cm: unknown }).cm = cm;

    expect(attemptHostCompartmentReconfigure(view)).toEqual({
      ok: true,
      reason: 'ok',
      dispatched: true,
      effectType: 'FakeEffect',
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({ effects: expect.any(FakeEffect) });
  });

  it('returns a structured failure when no compartment constructor is available', () => {
    const view = new MarkdownView();
    (view.editor as unknown as { cm: unknown }).cm = {
      constructor: FakeEditorView,
      state: { constructor: FakeEditorState, config: {} },
      dispatch: () => {},
      dom: { tagName: 'DIV' },
    };

    expect(attemptHostCompartmentReconfigure(view)).toEqual({
      ok: false,
      reason: 'missing-compartment-constructor',
      dispatched: false,
      effectType: null,
    });
  });
});
