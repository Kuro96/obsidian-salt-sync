import type { VaultId } from '@salt-sync/shared';
import type { SyncTokenMode, SyncTokenStore } from './auth/syncTokenStore.js';

/**
 * Phase 5 鉴权：支持 per-vault token 绑定。
 *
 * 配置方式：
 *   SERVER_TOKEN=xxx            全局 token（向后兼容，适合单 vault 场景）
 *   VAULT_TOKENS={"id":"tok"}   JSON 映射，key=vaultId value=token（共享目录场景）
 *
 * validateTokenForVault 优先匹配 VAULT_TOKENS，若无则回退到 SERVER_TOKEN。
 * 确保主 vault token 无法访问其他 vault room。
 */
export class Auth {
  private readonly globalToken: string;
  private readonly vaultTokens: Map<VaultId, string>;
  private readonly syncTokenStore: SyncTokenStore | null;

  constructor(syncTokenStore: SyncTokenStore | null = null) {
    this.syncTokenStore = syncTokenStore;
    this.globalToken = process.env.SERVER_TOKEN ?? 'dev-token';
    if (this.globalToken === 'dev-token') {
      console.warn('[auth] Using default dev-token. Set SERVER_TOKEN env var in production.');
    }

    const raw = process.env.VAULT_TOKENS;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, string>;
        this.vaultTokens = new Map(Object.entries(parsed));
        console.log(`[auth] Loaded per-vault tokens for ${this.vaultTokens.size} vault(s)`);
      } catch {
        console.error('[auth] Failed to parse VAULT_TOKENS env var — ignoring');
        this.vaultTokens = new Map();
      }
    } else {
      this.vaultTokens = new Map();
    }
  }

  /**
   * 宽松鉴权：匹配全局 token 或任意已注册 vault token 即通过。
   * 不携带 vault 上下文，仅用于只需"是已知客户端"即可的场景（已少用）。
   */
  validateToken(token: string): boolean {
    if (this.syncTokenStore?.hasAny()) {
      return this.syncTokenStore.validateRawToken(token).ok;
    }
    if (token === this.globalToken) return true;
    for (const t of this.vaultTokens.values()) {
      if (token === t) return true;
    }
    return false;
  }

  /** 管理员鉴权：必须精确匹配 SERVER_TOKEN（用于 /admin/** 与 blob GC） */
  validateAdminToken(token: string): boolean {
    return token === this.globalToken;
  }

  getSyncTokenMode(): SyncTokenMode {
    return this.syncTokenStore?.getMode() ?? 'env-fallback';
  }

  getConfiguredVaultTokenCount(): number {
    return this.vaultTokens.size;
  }

  isEnvFallbackAvailable(): boolean {
    return this.globalToken.length > 0 || this.vaultTokens.size > 0;
  }

  getDbTokenCount(): number {
    return this.syncTokenStore?.count() ?? 0;
  }

  /**
   * Per-vault token 校验（用于 WebSocket 握手）。
   * 若为该 vault 注册了专属 token 则必须精确匹配；否则回退全局 token。
   */
  validateTokenForVault(token: string, vaultId: VaultId): boolean {
    if (this.syncTokenStore?.hasAny()) {
      return this.syncTokenStore.validateRawToken(token).ok;
    }

    const expected = this.vaultTokens.get(vaultId);
    if (expected !== undefined) return token === expected;
    return token === this.globalToken;
  }

  validateVaultId(vaultId: VaultId): boolean {
    return typeof vaultId === 'string' && vaultId.length > 0 && vaultId.length <= 128;
  }
}
