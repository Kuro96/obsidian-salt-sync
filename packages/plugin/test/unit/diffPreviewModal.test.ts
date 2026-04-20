import { describe, it, expect } from 'vitest';
import { computeLineDiff } from '../../src/ui/lineDiff';

describe('computeLineDiff', () => {
  it('returns empty array for two empty strings', () => {
    expect(computeLineDiff('', '')).toEqual([]);
  });

  it('returns all-equal for identical strings', () => {
    const result = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(result).toEqual([
      { type: 'equal', line: 'a' },
      { type: 'equal', line: 'b' },
      { type: 'equal', line: 'c' },
    ]);
  });

  it('returns all-insert when old is empty', () => {
    const result = computeLineDiff('', 'x\ny');
    expect(result).toEqual([
      { type: 'insert', line: 'x' },
      { type: 'insert', line: 'y' },
    ]);
  });

  it('returns all-delete when new is empty', () => {
    const result = computeLineDiff('x\ny', '');
    expect(result).toEqual([
      { type: 'delete', line: 'x' },
      { type: 'delete', line: 'y' },
    ]);
  });

  it('handles single-line identical strings', () => {
    expect(computeLineDiff('hello', 'hello')).toEqual([
      { type: 'equal', line: 'hello' },
    ]);
  });

  it('handles single-line change', () => {
    expect(computeLineDiff('old', 'new')).toEqual([
      { type: 'delete', line: 'old' },
      { type: 'insert', line: 'new' },
    ]);
  });

  it('handles insertion in the middle', () => {
    const result = computeLineDiff('a\nc', 'a\nb\nc');
    expect(result).toEqual([
      { type: 'equal', line: 'a' },
      { type: 'insert', line: 'b' },
      { type: 'equal', line: 'c' },
    ]);
  });

  it('handles deletion in the middle', () => {
    const result = computeLineDiff('a\nb\nc', 'a\nc');
    expect(result).toEqual([
      { type: 'equal', line: 'a' },
      { type: 'delete', line: 'b' },
      { type: 'equal', line: 'c' },
    ]);
  });

  it('handles replacement (delete + insert)', () => {
    const result = computeLineDiff('a\nb\nc', 'a\nX\nc');
    expect(result).toEqual([
      { type: 'equal', line: 'a' },
      { type: 'delete', line: 'b' },
      { type: 'insert', line: 'X' },
      { type: 'equal', line: 'c' },
    ]);
  });

  it('handles multiple disjoint changes', () => {
    const result = computeLineDiff('1\n2\n3\n4\n5', '1\nX\n3\nY\n5');
    expect(result).toEqual([
      { type: 'equal', line: '1' },
      { type: 'delete', line: '2' },
      { type: 'insert', line: 'X' },
      { type: 'equal', line: '3' },
      { type: 'delete', line: '4' },
      { type: 'insert', line: 'Y' },
      { type: 'equal', line: '5' },
    ]);
  });

  it('handles trailing newline correctly', () => {
    // 'a\n' splits into ['a', ''] — the trailing empty line is part of the diff
    const result = computeLineDiff('a\n', 'a\nb\n');
    // aLines = ['a', ''], bLines = ['a', 'b', '']
    expect(result).toEqual([
      { type: 'equal', line: 'a' },
      { type: 'insert', line: 'b' },
      { type: 'equal', line: '' },
    ]);
  });

  it('produces delete before insert for same position', () => {
    const result = computeLineDiff('old1\nold2', 'new1\nnew2');
    // No common lines → all old deleted, all new inserted
    const types = result.map((op) => op.type);
    // deletes should come before inserts (LCS backtrack guarantees this ordering)
    const firstInsert = types.indexOf('insert');
    const lastDelete = types.lastIndexOf('delete');
    expect(lastDelete).toBeLessThan(firstInsert);
  });

  it('handles completely different long texts', () => {
    const a = Array.from({ length: 10 }, (_, i) => `old-line-${i}`).join('\n');
    const b = Array.from({ length: 10 }, (_, i) => `new-line-${i}`).join('\n');
    const result = computeLineDiff(a, b);
    expect(result.every((op) => op.type !== 'equal')).toBe(true);
    expect(result.filter((op) => op.type === 'delete')).toHaveLength(10);
    expect(result.filter((op) => op.type === 'insert')).toHaveLength(10);
  });

  it('handles identical content with different trailing whitespace as changes', () => {
    const result = computeLineDiff('hello ', 'hello');
    expect(result).toEqual([
      { type: 'delete', line: 'hello ' },
      { type: 'insert', line: 'hello' },
    ]);
  });
});
