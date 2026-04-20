import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION } from '../src/constants';

describe('shared smoke', () => {
  it('exports SCHEMA_VERSION', () => {
    expect(typeof SCHEMA_VERSION).toBe('number');
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });
});
