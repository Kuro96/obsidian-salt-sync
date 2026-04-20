import { describe, expect, it } from 'vitest';
import { evaluateExternalEditPolicy } from '../../src/sync/externalEditPolicy';

describe('evaluateExternalEditPolicy', () => {
  it('allows always policy', () => {
    expect(evaluateExternalEditPolicy('always', true)).toEqual({
      allowed: true,
      deferred: false,
      reason: 'allowed',
    });
  });

  it('defers closed-only policy for open files', () => {
    expect(evaluateExternalEditPolicy('closed-only', true)).toEqual({
      allowed: false,
      deferred: true,
      reason: 'policy-closed-only-open-file',
    });
  });

  it('blocks never policy', () => {
    expect(evaluateExternalEditPolicy('never', false)).toEqual({
      allowed: false,
      deferred: false,
      reason: 'policy-never',
    });
  });
});
