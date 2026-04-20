import { App, Modal, Notice } from 'obsidian';
import { computeLineDiff } from './lineDiff';
import type { LineDiffOp } from './lineDiff';

// Re-export for convenience
export { computeLineDiff } from './lineDiff';
export type { LineDiffOp } from './lineDiff';

// ── DiffPreviewModal ──────────────────────────────────────────────────────────

const CONTEXT_LINES = 3;

/**
 * 恢复历史版本前展示 diff 的确认弹窗（仅 Markdown 文件）。
 *
 * 显示行级 unified diff：
 *   - 删除行：红色背景，`-` 前缀
 *   - 新增行：绿色背景，`+` 前缀
 *   - 上下文行：灰色，只展示变更前后各 CONTEXT_LINES 行
 *
 * 内容相同时直接显示提示，不展示空 diff。
 */
export class DiffPreviewModal extends Modal {
  constructor(
    app: App,
    private readonly currentContent: string,
    private readonly historicalContent: string,
    private readonly fileName: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `历史版本对比：${this.fileName}` });

    const ops = computeLineDiff(this.currentContent, this.historicalContent);
    const hasChanges = ops.some((op) => op.type !== 'equal');

    if (!hasChanges) {
      contentEl.createEl('p', {
        text: '此版本与当前内容完全相同，无需恢复。',
        cls: 'salt-sync-muted',
      });
      const btnRow = contentEl.createEl('div', { cls: 'salt-sync-btn-row' });
      btnRow.createEl('button', { text: '关闭' }).addEventListener('click', () => this.close());
      return;
    }

    // Build visibility mask: show lines near changes
    const visible = this.buildVisibilityMask(ops);

    const pre = contentEl.createEl('pre', { cls: 'salt-sync-diff' });

    let i = 0;
    while (i < ops.length) {
      if (!visible[i]) {
        // Count consecutive hidden lines
        let hidden = 0;
        while (i < ops.length && !visible[i]) { hidden++; i++; }
        pre.createEl('div', {
          text: `… ${hidden} 行未更改 …`,
          cls: 'salt-sync-diff-hidden',
        });
        continue;
      }

      const op = ops[i];
      const line = contentEl.createEl('div', { cls: `salt-sync-diff-line salt-sync-diff-${op.type}` });
      const prefix = op.type === 'delete' ? '-' : op.type === 'insert' ? '+' : ' ';
      line.createEl('span', { text: `${prefix} `, cls: 'salt-sync-diff-prefix' });
      line.createEl('span', { text: op.line });
      pre.appendChild(line);
      i++;
    }

    // Legend
    const legend = contentEl.createEl('p', { cls: 'salt-sync-diff-legend salt-sync-muted' });
    legend.createEl('span', { text: '- 删除　', cls: 'salt-sync-diff-delete' });
    legend.createEl('span', { text: '+ 新增', cls: 'salt-sync-diff-insert' });

    // Action buttons
    const btnRow = contentEl.createEl('div', { cls: 'salt-sync-btn-row' });

    const cancelBtn = btnRow.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = btnRow.createEl('button', { text: '确认恢复', cls: 'mod-cta' });
    confirmBtn.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /**
   * 构建每行的可见性掩码：变更行 ± CONTEXT_LINES 范围内的 equal 行也展示。
   */
  private buildVisibilityMask(ops: LineDiffOp[]): boolean[] {
    const visible = new Array<boolean>(ops.length).fill(false);

    // Mark changed lines
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].type !== 'equal') visible[i] = true;
    }

    // Expand context
    for (let i = 0; i < ops.length; i++) {
      if (!visible[i]) continue;
      for (let d = 1; d <= CONTEXT_LINES; d++) {
        if (i - d >= 0) visible[i - d] = true;
        if (i + d < ops.length) visible[i + d] = true;
      }
    }

    return visible;
  }
}
