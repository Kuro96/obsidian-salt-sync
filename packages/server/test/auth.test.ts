import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Auth } from '../src/auth';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe('Auth', () => {
  describe('validateTokenForVault', () => {
    it('falls back to SERVER_TOKEN when vault has no per-vault entry', () => {
      withEnv({ SERVER_TOKEN: 's', VAULT_TOKENS: undefined }, () => {
        const a = new Auth();
        expect(a.validateTokenForVault('s', 'v1')).toBe(true);
        expect(a.validateTokenForVault('x', 'v1')).toBe(false);
      });
    });

    it('requires exact per-vault token when registered, ignores SERVER_TOKEN', () => {
      withEnv(
        { SERVER_TOKEN: 's', VAULT_TOKENS: JSON.stringify({ v1: 't1', v2: 't2' }) },
        () => {
          const a = new Auth();
          expect(a.validateTokenForVault('t1', 'v1')).toBe(true);
          expect(a.validateTokenForVault('s', 'v1')).toBe(false); // SERVER_TOKEN must not access v1
          expect(a.validateTokenForVault('t2', 'v1')).toBe(false); // cross-vault token rejected
          expect(a.validateTokenForVault('t2', 'v2')).toBe(true);
        },
      );
    });

    it('falls back for unregistered vault ids', () => {
      withEnv(
        { SERVER_TOKEN: 's', VAULT_TOKENS: JSON.stringify({ v1: 't1' }) },
        () => {
          const a = new Auth();
          expect(a.validateTokenForVault('s', 'vOther')).toBe(true);
          expect(a.validateTokenForVault('t1', 'vOther')).toBe(false);
        },
      );
    });
  });

  describe('validateAdminToken', () => {
    it('matches only SERVER_TOKEN, never per-vault tokens', () => {
      withEnv(
        { SERVER_TOKEN: 'admin', VAULT_TOKENS: JSON.stringify({ v1: 't1' }) },
        () => {
          const a = new Auth();
          expect(a.validateAdminToken('admin')).toBe(true);
          expect(a.validateAdminToken('t1')).toBe(false);
          expect(a.validateAdminToken('nope')).toBe(false);
        },
      );
    });
  });

  describe('validateVaultId', () => {
    it('accepts non-empty short strings', () => {
      withEnv({ SERVER_TOKEN: 's' }, () => {
        const a = new Auth();
        expect(a.validateVaultId('v1')).toBe(true);
        expect(a.validateVaultId('')).toBe(false);
        expect(a.validateVaultId('x'.repeat(129))).toBe(false);
      });
    });
  });

  describe('VAULT_TOKENS parse errors', () => {
    it('ignores malformed JSON, falls back to global only', () => {
      withEnv({ SERVER_TOKEN: 's', VAULT_TOKENS: 'not-json' }, () => {
        const a = new Auth();
        expect(a.validateTokenForVault('s', 'v1')).toBe(true);
      });
    });
  });
});
