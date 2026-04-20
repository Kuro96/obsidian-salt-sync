// ── 행급 LCS diff ────────────────────────────────────────────────────────────

export type LineDiffOp =
  | { type: 'equal'; line: string }
  | { type: 'delete'; line: string }
  | { type: 'insert'; line: string };

/**
 * 计算两段文本的行级 diff（LCS 算法）。
 * 返回的序列保证 delete 操作先于同位置的 insert 操作。
 */
export function computeLineDiff(a: string, b: string): LineDiffOp[] {
  const aLines = a === '' ? [] : a.split('\n');
  const bLines = b === '' ? [] : b.split('\n');
  const m = aLines.length;
  const n = bLines.length;

  // lcs[i][j] = length of LCS of aLines[0..i-1] and bLines[0..j-1]
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      lcs[i][j] = aLines[i - 1] === bLines[j - 1]
        ? lcs[i - 1][j - 1] + 1
        : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  // Backtrack to produce ops
  const ops: LineDiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      ops.push({ type: 'equal', line: aLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      ops.push({ type: 'insert', line: bLines[j - 1] });
      j--;
    } else {
      ops.push({ type: 'delete', line: aLines[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}
