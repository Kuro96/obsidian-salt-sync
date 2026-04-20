/** 生成 RFC 4122 v4 UUID，兼容 Electron/Node 环境 */
export function randomUUID(): string {
  // crypto.randomUUID() is available in Node 14.17+ and modern browsers
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 读取 Yjs Transaction 的 changed keys 集合。
 *
 * Yjs 的类型定义里 txn.changed 是 Map<AbstractType<YEvent<any>>, Set<string|null>>，
 * 对 Y.Map<T> 实际只会是 string，但 TS 不认账。集中在此处做一次类型收敛，
 * 避免每个调用点都 as any。
 */
export function changedMapKeys(
  txn: import('yjs').Transaction,
  map: unknown,
): string[] {
  const raw = (txn.changed as unknown as Map<unknown, Set<string | null>>).get(map);
  if (!raw) return [];
  const out: string[] = [];
  for (const k of raw) if (k !== null) out.push(k);
  return out;
}

/** 同上，但是只判断某个 map 是否被改动 */
export function mapChanged(txn: import('yjs').Transaction, map: unknown): boolean {
  return (txn.changed as unknown as Map<unknown, unknown>).has(map);
}
