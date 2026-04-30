import { describe, expect, it } from 'vitest';
import { UserIgnoreMatcher } from '../../src/sync/userIgnore';
import { MockVault } from '../mocks/obsidian';

describe('UserIgnoreMatcher', () => {
  it('does nothing when no ignore file path is configured', async () => {
    const vault = new MockVault();
    const matcher = await UserIgnoreMatcher.load(vault as never, '');

    expect(matcher.matchesVaultPath('notes/draft.md')).toBe(false);
  });

  it('loads gitignore-style rules from a vault-relative file', async () => {
    const vault = new MockVault();
    vault.seedText('.salt-sync-ignore', ['*.tmp', 'secret/*', '!secret/keep.md'].join('\n'));

    const matcher = await UserIgnoreMatcher.load(vault as never, '.salt-sync-ignore');

    expect(matcher.matchesVaultPath('draft.tmp')).toBe(true);
    expect(matcher.matchesVaultPath('notes/draft.tmp')).toBe(true);
    expect(matcher.matchesVaultPath('secret/token.md')).toBe(true);
    expect(matcher.matchesVaultPath('secret/keep.md')).toBe(false);
    expect(matcher.matchesVaultPath('notes/regular.md')).toBe(false);
  });

  it('applies rules relative to the configured ignore file directory', async () => {
    const vault = new MockVault();
    vault.seedText('Shared/.salt-sync-ignore', ['*.tmp', '/root-only.md'].join('\n'));

    const matcher = await UserIgnoreMatcher.load(vault as never, 'Shared/.salt-sync-ignore');

    expect(matcher.matchesVaultPath('Shared/cache.tmp')).toBe(true);
    expect(matcher.matchesVaultPath('Shared/nested/cache.tmp')).toBe(true);
    expect(matcher.matchesVaultPath('Shared/root-only.md')).toBe(true);
    expect(matcher.matchesVaultPath('Shared/nested/root-only.md')).toBe(false);
    expect(matcher.matchesVaultPath('cache.tmp')).toBe(false);
  });
});
