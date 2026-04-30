import { describe, expect, it } from 'vitest';
import { isPathIgnoredBySync } from '../src/pathSafety';

describe('pathSafety', () => {
  it('ignores Obsidian internal, trash, and default new note names', () => {
    expect(isPathIgnoredBySync('.obsidian/app.json')).toBe(true);
    expect(isPathIgnoredBySync('.trash/deleted.md')).toBe(true);
    expect(isPathIgnoredBySync('Untitled.md')).toBe(true);
    expect(isPathIgnoredBySync('Untitled 1.md')).toBe(true);
    expect(isPathIgnoredBySync('未命名.md')).toBe(true);
    expect(isPathIgnoredBySync('未命名 1.md')).toBe(true);
  });

  it('ignores Syncthing temporary files without ignoring arbitrary tmp files', () => {
    expect(isPathIgnoredBySync('~syncthing~note.md.tmp')).toBe(true);
    expect(isPathIgnoredBySync('folder/~syncthing~image.png.tmp')).toBe(true);
    expect(isPathIgnoredBySync('folder/draft.tmp')).toBe(false);
    expect(isPathIgnoredBySync('folder/syncthing-note.tmp')).toBe(false);
    expect(isPathIgnoredBySync('folder/Untitled draft.md')).toBe(false);
  });
});
