import { describe, expect, it } from 'vitest';
import {
  MarkdownTombstoneState,
  type TombstoneReceipt,
} from '../../src/sync/markdownTombstoneState';

const tombstone = (deletedAt: number): unknown => ({ deletedAt });

const receipt = (overrides: Partial<TombstoneReceipt>): TombstoneReceipt => ({
  provenance: 'startup-remote',
  origin: 'remote',
  ...overrides,
});

describe('MarkdownTombstoneState', () => {
  it('records cache and startup remote tombstones as non-replayable startup baseline candidates', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'cached.md', tombstone: tombstone(10) },
    ], receipt({ provenance: 'cache-startup', origin: 'cache' }));
    state.applyTransaction([
      { path: 'remote.md', tombstone: tombstone(11) },
    ], receipt({ provenance: 'startup-remote' }));

    expect(state.getPendingPaths()).toEqual({
      baseline: ['cached.md', 'remote.md'],
      live: [],
    });
    expect(state.getReplayDecisions()).toEqual([]);
    expect(state.getDecision('cached.md')).toMatchObject({
      kind: 'startup-baseline',
      status: 'unclassified',
      replayable: false,
    });
    expect(state.getDecision('remote.md')).toMatchObject({
      kind: 'startup-baseline',
      status: 'unclassified',
      replayable: false,
    });
  });

  it('records maintenance, reconnect, and open remote tombstones as replayable live delete candidates', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'startup-maintenance.md', tombstone: tombstone(10) },
    ], receipt({ provenance: 'startup-maintenance' }));
    state.applyTransaction([
      { path: 'reconnect-maintenance.md', tombstone: tombstone(11) },
    ], receipt({ provenance: 'reconnect-maintenance' }));
    state.applyTransaction([
      { path: 'open.md', tombstone: tombstone(12) },
    ], receipt({ provenance: 'open' }));

    expect(state.getPendingPaths()).toEqual({
      baseline: [],
      live: ['open.md', 'reconnect-maintenance.md', 'startup-maintenance.md'],
    });
    expect(state.getReplayDecisions()).toEqual([
      { path: 'open.md', kind: 'live-delete' },
      { path: 'reconnect-maintenance.md', kind: 'live-delete' },
      { path: 'startup-maintenance.md', kind: 'live-delete' },
    ]);
  });

  it('does not treat local or self-origin tombstones as remote replay candidates', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'local.md', tombstone: tombstone(10) },
    ], receipt({ provenance: 'open', origin: 'local' }));
    state.applyTransaction([
      { path: 'self.md', tombstone: tombstone(11) },
    ], receipt({ provenance: 'open', origin: 'self' }));

    expect(state.getPendingPaths()).toEqual({ baseline: [], live: [] });
    expect(state.getReplayDecisions()).toEqual([]);
    expect(state.getDecision('local.md')).toMatchObject({
      kind: 'ignored-local',
      replayable: false,
    });
    expect(state.getDecision('self.md')).toMatchObject({
      kind: 'ignored-local',
      replayable: false,
    });
  });

  it('ignores local or self-origin tombstones without replacing existing remote candidates', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'baseline.md', tombstone: tombstone(10) },
    ], receipt({ provenance: 'startup-remote' }));
    state.classifyBaseline('baseline.md', 'authoritative-delete');
    state.applyTransaction([
      { path: 'live.md', tombstone: tombstone(11) },
    ], receipt({ provenance: 'startup-maintenance' }));

    state.applyTransaction([
      { path: 'baseline.md', tombstone: tombstone(12) },
    ], receipt({ provenance: 'open', origin: 'local' }));
    state.applyTransaction([
      { path: 'live.md', tombstone: tombstone(13) },
    ], receipt({ provenance: 'open', origin: 'self' }));

    expect(state.getPendingPaths()).toEqual({ baseline: [], live: ['live.md'] });
    expect(state.getReplayDecisions()).toEqual([
      { path: 'baseline.md', kind: 'authoritative-baseline-delete' },
      { path: 'live.md', kind: 'live-delete' },
    ]);
    expect(state.getDecision('baseline.md')).toMatchObject({
      kind: 'startup-baseline',
      status: 'authoritative-delete',
      replayable: true,
    });
    expect(state.getDecision('live.md')).toMatchObject({
      kind: 'live-delete',
      replayable: true,
    });
  });

  it('does not replay baseline tombstones classified as stale-cleared or cancelled', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'stale.md', tombstone: tombstone(10) },
      { path: 'cancelled.md', tombstone: tombstone(11) },
    ], receipt({ provenance: 'startup-remote' }));
    state.classifyBaseline('stale.md', 'stale-cleared');
    state.classifyBaseline('cancelled.md', 'cancelled');

    expect(state.getReplayDecisions()).toEqual([]);
    expect(state.getPendingPaths()).toEqual({ baseline: [], live: [] });
  });

  it('replays baseline tombstones classified as authoritative deletes', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'authoritative.md', tombstone: tombstone(10) },
    ], receipt({ provenance: 'startup-remote' }));
    state.classifyBaseline('authoritative.md', 'authoritative-delete');

    expect(state.getReplayDecisions()).toEqual([
      { path: 'authoritative.md', kind: 'authoritative-baseline-delete' },
    ]);
    expect(state.getDecision('authoritative.md')).toMatchObject({
      kind: 'startup-baseline',
      status: 'authoritative-delete',
      replayable: true,
    });
  });

  it('does not replay unclassified or failed baseline tombstones', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'unclassified.md', tombstone: tombstone(10) },
      { path: 'failed.md', tombstone: tombstone(11) },
    ], receipt({ provenance: 'startup-remote' }));
    state.classifyBaseline('failed.md', 'failed');

    expect(state.getReplayDecisions()).toEqual([]);
    expect(state.getPendingPaths()).toEqual({
      baseline: ['failed.md', 'unclassified.md'],
      live: [],
    });
  });

  it('cancels pending baseline and live deletes when a tombstone is removed', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'baseline.md', tombstone: tombstone(10) },
    ], receipt({ provenance: 'startup-remote' }));
    state.applyTransaction([
      { path: 'live.md', tombstone: tombstone(11) },
    ], receipt({ provenance: 'startup-maintenance' }));

    state.applyTransaction([
      { path: 'baseline.md', tombstone: undefined },
      { path: 'live.md', tombstone: undefined },
    ], receipt({ provenance: 'startup-maintenance' }));

    expect(state.getPendingPaths()).toEqual({ baseline: [], live: [] });
    expect(state.getReplayDecisions()).toEqual([]);
    expect(state.getDecision('baseline.md')).toMatchObject({ kind: 'absent' });
    expect(state.getDecision('live.md')).toMatchObject({ kind: 'absent' });
  });

  it('clears existing remote replay candidates when a local transaction removes the tombstone', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'restored.md', tombstone: tombstone(10) },
    ], receipt({ provenance: 'startup-maintenance' }));
    expect(state.getReplayDecisions()).toEqual([
      { path: 'restored.md', kind: 'live-delete' },
    ]);

    state.applyTransaction([
      { path: 'restored.md', tombstone: undefined },
    ], receipt({ provenance: 'open', origin: 'local' }));

    expect(state.getPendingPaths()).toEqual({ baseline: [], live: [] });
    expect(state.getReplayDecisions()).toEqual([]);
    expect(state.getDecision('restored.md')).toMatchObject({ kind: 'absent' });
  });

  it('treats removal followed by re-add as a fresh candidate regardless of deletedAt ordering', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'note.md', tombstone: tombstone(100) },
    ], receipt({ provenance: 'startup-maintenance' }));
    state.applyTransaction([
      { path: 'note.md', tombstone: undefined },
    ], receipt({ provenance: 'startup-maintenance' }));
    state.applyTransaction([
      { path: 'note.md', tombstone: tombstone(1) },
    ], receipt({ provenance: 'startup-maintenance' }));

    expect(state.getReplayDecisions()).toEqual([
      { path: 'note.md', kind: 'live-delete' },
    ]);
    expect(state.getDecision('note.md')).toMatchObject({
      kind: 'live-delete',
      replayable: true,
    });
  });

  it('lets a live candidate win over a same-path baseline candidate by receipt epoch and provenance', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'note.md', tombstone: tombstone(100) },
    ], receipt({ provenance: 'startup-remote' }));
    state.applyTransaction([
      { path: 'note.md', tombstone: tombstone(1) },
    ], receipt({ provenance: 'startup-maintenance' }));

    expect(state.getPendingPaths()).toEqual({ baseline: [], live: ['note.md'] });
    expect(state.getReplayDecisions()).toEqual([
      { path: 'note.md', kind: 'live-delete' },
    ]);
  });

  it('uses same-transaction final-state semantics and classifies present final state by receipt provenance', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'gone.md', tombstone: tombstone(9) },
      { path: 'gone.md', tombstone: undefined },
      { path: 'baseline.md', tombstone: undefined },
      { path: 'baseline.md', tombstone: tombstone(10) },
    ], receipt({ provenance: 'startup-remote' }));
    state.applyTransaction([
      { path: 'live.md', tombstone: undefined },
      { path: 'live.md', tombstone: tombstone(11) },
    ], receipt({ provenance: 'startup-maintenance' }));

    expect(state.getDecision('gone.md')).toMatchObject({ kind: 'absent' });
    expect(state.getDecision('baseline.md')).toMatchObject({
      kind: 'startup-baseline',
      status: 'unclassified',
      replayable: false,
    });
    expect(state.getDecision('live.md')).toMatchObject({
      kind: 'live-delete',
      replayable: true,
    });
  });

  it('returns deterministic decisions and pending paths', () => {
    const state = new MarkdownTombstoneState();

    state.applyTransaction([
      { path: 'z.md', tombstone: tombstone(1) },
      { path: 'a.md', tombstone: tombstone(2) },
    ], receipt({ provenance: 'startup-maintenance' }));
    state.applyTransaction([
      { path: 'm.md', tombstone: tombstone(3) },
    ], receipt({ provenance: 'startup-remote' }));

    expect(state.getPendingPaths()).toEqual({ baseline: ['m.md'], live: ['a.md', 'z.md'] });
    expect(state.getDecisions().map((decision) => decision.path)).toEqual(['a.md', 'm.md', 'z.md']);
    expect(state.getReplayDecisions()).toEqual([
      { path: 'a.md', kind: 'live-delete' },
      { path: 'z.md', kind: 'live-delete' },
    ]);
  });
});
