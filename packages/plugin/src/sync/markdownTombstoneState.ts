export type TombstoneReceiptProvenance =
  | 'cache-startup'
  | 'startup-remote'
  | 'startup-maintenance'
  | 'reconnect-maintenance'
  | 'open';

export type TombstoneReceiptOrigin = 'remote' | 'cache' | 'local' | 'self';

export interface TombstoneReceipt {
  provenance: TombstoneReceiptProvenance;
  origin: TombstoneReceiptOrigin;
}

export interface TombstoneChange {
  path: string;
  tombstone: unknown | undefined;
}

export type BaselineClassification =
  | 'unclassified'
  | 'authoritative-delete'
  | 'stale-cleared'
  | 'cancelled'
  | 'failed';

export type ReplayDecisionKind = 'live-delete' | 'authoritative-baseline-delete';

export interface ReplayDecision {
  path: string;
  kind: ReplayDecisionKind;
}

export interface PendingPaths {
  baseline: string[];
  live: string[];
}

export type TombstoneDecision =
  | {
      path: string;
      kind: 'absent';
      replayable: false;
    }
  | {
      path: string;
      kind: 'ignored-local';
      replayable: false;
      receiptEpoch: number;
    }
  | {
      path: string;
      kind: 'startup-baseline';
      status: BaselineClassification;
      replayable: boolean;
      receiptEpoch: number;
    }
  | {
      path: string;
      kind: 'live-delete';
      replayable: true;
      receiptEpoch: number;
    };

type Entry =
  | {
      kind: 'ignored-local';
      receiptEpoch: number;
    }
  | {
      kind: 'startup-baseline';
      status: BaselineClassification;
      receiptEpoch: number;
    }
  | {
      kind: 'live-delete';
      receiptEpoch: number;
    };

export class MarkdownTombstoneState {
  private epoch = 0;
  private readonly entries = new Map<string, Entry>();

  applyTransaction(changes: TombstoneChange[], receipt: TombstoneReceipt): void {
    this.epoch += 1;

    const finalChanges = new Map<string, unknown | undefined>();
    for (const change of changes) {
      finalChanges.set(change.path, change.tombstone);
    }

    for (const [path, tombstone] of finalChanges) {
      if (tombstone === undefined) {
        this.entries.delete(path);
        continue;
      }

      if (receipt.origin === 'local' || receipt.origin === 'self') {
        if (!this.entries.has(path)) {
          this.entries.set(path, { kind: 'ignored-local', receiptEpoch: this.epoch });
        }
        continue;
      }

      if (receipt.provenance === 'cache-startup' || receipt.provenance === 'startup-remote') {
        this.entries.set(path, {
          kind: 'startup-baseline',
          status: 'unclassified',
          receiptEpoch: this.epoch,
        });
        continue;
      }

      this.entries.set(path, { kind: 'live-delete', receiptEpoch: this.epoch });
    }
  }

  classifyBaseline(path: string, status: Exclude<BaselineClassification, 'unclassified'>): void {
    const entry = this.entries.get(path);
    if (!entry || entry.kind !== 'startup-baseline') return;

    this.entries.set(path, { ...entry, status });
  }

  getPendingPaths(): PendingPaths {
    const baseline: string[] = [];
    const live: string[] = [];

    for (const [path, entry] of this.entries) {
      if (entry.kind === 'live-delete') {
        live.push(path);
      } else if (
        entry.kind === 'startup-baseline' &&
        (entry.status === 'unclassified' || entry.status === 'failed')
      ) {
        baseline.push(path);
      }
    }

    return {
      baseline: baseline.sort(),
      live: live.sort(),
    };
  }

  getReplayDecisions(): ReplayDecision[] {
    const decisions: ReplayDecision[] = [];

    for (const [path, entry] of this.entries) {
      if (entry.kind === 'live-delete') {
        decisions.push({ path, kind: 'live-delete' });
      } else if (entry.kind === 'startup-baseline' && entry.status === 'authoritative-delete') {
        decisions.push({ path, kind: 'authoritative-baseline-delete' });
      }
    }

    return decisions.sort((left, right) => left.path.localeCompare(right.path));
  }

  getDecision(path: string): TombstoneDecision {
    const entry = this.entries.get(path);
    if (!entry) return { path, kind: 'absent', replayable: false };

    if (entry.kind === 'ignored-local') {
      return { path, kind: 'ignored-local', replayable: false, receiptEpoch: entry.receiptEpoch };
    }

    if (entry.kind === 'live-delete') {
      return { path, kind: 'live-delete', replayable: true, receiptEpoch: entry.receiptEpoch };
    }

    return {
      path,
      kind: 'startup-baseline',
      status: entry.status,
      replayable: entry.status === 'authoritative-delete',
      receiptEpoch: entry.receiptEpoch,
    };
  }

  getDecisions(): TombstoneDecision[] {
    return Array.from(this.entries.keys())
      .sort()
      .map((path) => this.getDecision(path));
  }
}
