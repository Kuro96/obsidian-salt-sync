import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyDiffToYText } from '../../src/sync/diff';

describe('sync diff helpers', () => {
  it('applies replacement diffs to ytext without position drift', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('doc');
    ytext.insert(0, 'abc');

    applyDiffToYText(ytext, 'abc', 'axc', 'test');

    expect(ytext.toString()).toBe('axc');
  });
});
