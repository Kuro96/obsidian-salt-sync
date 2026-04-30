import ignore from 'ignore';
import type { Vault, TFile } from 'obsidian';
import { normalizeVaultPath } from './pathSafety';

type IgnoreInstance = ReturnType<typeof ignore>;

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function toRelativePath(path: string, baseDir: string): string | null {
  const normalized = normalizeVaultPath(path);
  if (!baseDir) return normalized;
  if (normalized === baseDir) return '';
  const prefix = `${baseDir}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null;
}

export class UserIgnoreMatcher {
  private constructor(
    private readonly ignoreFilePath: string,
    private readonly baseDir: string,
    private readonly rules: IgnoreInstance | null,
  ) {}

  static disabled(): UserIgnoreMatcher {
    return new UserIgnoreMatcher('', '', null);
  }

  static async load(vault: Vault, ignoreFilePath: string | undefined): Promise<UserIgnoreMatcher> {
    const normalizedPath = normalizeVaultPath(ignoreFilePath ?? '');
    if (!normalizedPath) return UserIgnoreMatcher.disabled();

    const file = vault.getAbstractFileByPath(normalizedPath) as TFile | null;
    if (!file || !('stat' in file)) {
      console.warn(`[VaultSync] ignore file not found: ${normalizedPath}`);
      return UserIgnoreMatcher.disabled();
    }

    try {
      const contents = await vault.read(file);
      return new UserIgnoreMatcher(
        normalizedPath,
        dirname(normalizedPath),
        ignore().add(contents),
      );
    } catch (error) {
      console.warn(`[VaultSync] failed to load ignore file: ${normalizedPath}`, error);
      return UserIgnoreMatcher.disabled();
    }
  }

  matchesVaultPath(vaultPath: string): boolean {
    if (!this.rules) return false;
    const relative = toRelativePath(vaultPath, this.baseDir);
    if (!relative) return false;
    return this.rules.ignores(relative);
  }

  get configuredPath(): string {
    return this.ignoreFilePath;
  }
}
