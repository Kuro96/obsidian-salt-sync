import { loadDeviceId, saveDeviceId } from './indexedDbStore';
import { randomUUID } from '../util';

/**
 * 解析当前设备的稳定 ID，不依赖 data.json（不会被 Syncthing 等工具跨设备同步）。
 *
 * 策略（按优先级）：
 * 1. Desktop（Electron/Node.js）：从 os + crypto 确定性派生，同一台机器永远得到相同 ID，
 *    无需任何存储。
 * 2. Mobile / 其他：从 IndexedDB 读取（设备本地，不被同步）；
 *    若 IndexedDB 为空，则优先复用旧版 data.json 里的 legacyId（迁移用），
 *    否则生成新 UUID 并写入 IndexedDB。
 *
 * @param legacyId 旧版本存在 data.json 中的 deviceId，用于 Mobile 的一次性迁移。
 */
export async function resolveDeviceId(legacyId?: string): Promise<string> {
  // 1. Desktop: 从 OS 信息确定性派生，同一台机器始终相同
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as { hostname(): string; platform(): string; arch(): string };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('crypto') as { createHash(a: string): { update(s: string): { digest(e: string): string } } };
    const seed = `salt-sync-device::${os.hostname()}::${os.platform()}::${os.arch()}`;
    const hex = createHash('sha256').update(seed).digest('hex');
    // 格式化为 UUID 形状，便于辨认
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  } catch {
    // Mobile 或沙盒环境：Node.js built-ins 不可用，走下面的 IndexedDB 路径
  }

  // 2. IndexedDB（Mobile）
  const stored = await loadDeviceId();
  if (stored) return stored;

  // 3. 首次运行或迁移：复用旧 ID（保留 deviceNames 映射）或生成新 UUID
  const id = legacyId ?? randomUUID();
  await saveDeviceId(id);
  return id;
}
