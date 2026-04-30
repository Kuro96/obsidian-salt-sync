import { describe, expect, it } from 'vitest';
import { isPathIgnoredBySync } from '../src/pathSafety';

describe('pathSafety', () => {
  it('ignores Syncthing temporary files without ignoring arbitrary tmp files', () => {
    expect(isPathIgnoredBySync('~syncthing~note.md.tmp')).toBe(true);
    expect(isPathIgnoredBySync('folder/~syncthing~image.png.tmp')).toBe(true);
    expect(isPathIgnoredBySync('folder/draft.tmp')).toBe(false);
    expect(isPathIgnoredBySync('folder/syncthing-note.tmp')).toBe(false);
  });
});
