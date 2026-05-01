import type { Vault } from 'obsidian';

export async function ensureParentFolders(vault: Vault, vaultPath: string): Promise<void> {
  const parts = vaultPath.split('/').filter(Boolean);
  if (parts.length <= 1) return;

  let current = '';
  for (const part of parts.slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    const existing = vault.getAbstractFileByPath(current);
    if (existing) {
      if ('stat' in existing) {
        throw new Error(`cannot create parent folder ${current}: file exists`);
      }
      continue;
    }
    await vault.createFolder(current);
  }
}
