import { App, Modal, Notice } from 'obsidian';
import type { SnapshotMeta } from '@salt-sync/shared';
import type { SyncScope } from '../sync/syncManager';

/**
 * 快照详情弹窗。
 * 展示快照元信息、文件列表（从 manifest 加载），并提供下载 ZIP / 恢复两个操作。
 * 接受 SyncScope 而非 SyncManager，以支持主库和共享目录挂载两种 scope。
 */
export class SnapshotDetailModal extends Modal {
  private confirmRestore = false;

  constructor(
    app: App,
    private readonly meta: SnapshotMeta,
    private readonly syncScope: SyncScope,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const date = this.meta.createdAt.replace('T', ' ').slice(0, 19).replace('T', ' ');
    contentEl.createEl('h2', { text: `快照  ${date}` });

    const info = contentEl.createEl('p');
    info.createEl('span', { text: `文档: ${this.meta.markdownFileCount}  ·  附件: ${this.meta.blobFileCount}` });

    // File list (from manifest)
    const listSection = contentEl.createEl('div');
    listSection.createEl('p', { text: '正在加载文件清单…', cls: 'salt-sync-muted' });

    this.syncScope.getSnapshotManifest(this.meta.snapshotId)
      .then((manifest) => {
        listSection.empty();
        if (manifest.files.length === 0) {
          listSection.createEl('p', { text: '（快照为空）', cls: 'salt-sync-muted' });
          return;
        }
        const ul = listSection.createEl('ul', { cls: 'salt-sync-file-list' });
        for (const f of manifest.files) {
          const label = f.type === 'blob' ? `📎 ${f.path}` : `📄 ${f.path}`;
          ul.createEl('li', { text: label });
        }
      })
      .catch(() => {
        listSection.empty();
        listSection.createEl('p', { text: '加载文件清单失败', cls: 'salt-sync-muted' });
      });

    // Action buttons
    const btnRow = contentEl.createEl('div', { cls: 'salt-sync-btn-row' });

    const downloadBtn = btnRow.createEl('button', { text: '下载 ZIP' });
    downloadBtn.addEventListener('click', () => this.handleDownloadZip(downloadBtn));

    const restoreBtn = btnRow.createEl('button', { text: '恢复到此版本' });
    restoreBtn.addEventListener('click', () => this.handleRestore(restoreBtn));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async handleDownloadZip(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = '下载中…';
    try {
      const zipData = await this.syncScope.downloadSnapshotZip(this.meta.snapshotId);
      const date = this.meta.createdAt.slice(0, 10);
      const filename = `vault-${this.meta.snapshotId.slice(0, 8)}-${date}.zip`;
      await this.app.vault.adapter.writeBinary(filename, zipData);
      new Notice(`ZIP 已保存：${filename}`);
      this.close();
    } catch (err) {
      console.error('[SnapshotDetailModal] download zip error:', err);
      new Notice('ZIP 下载失败，请查看控制台日志');
      btn.disabled = false;
      btn.textContent = '下载 ZIP';
    }
  }

  private async handleRestore(btn: HTMLButtonElement): Promise<void> {
    if (!this.confirmRestore) {
      this.confirmRestore = true;
      btn.textContent = '确认恢复（不可撤销）';
      btn.addClass('mod-warning');
      return;
    }

    btn.disabled = true;
    btn.textContent = '恢复中…';
    try {
      await this.syncScope.restoreSnapshot(this.meta.snapshotId);
      new Notice(`已恢复到快照 ${this.meta.snapshotId.slice(0, 8)}`);
      this.close();
    } catch (err) {
      console.error('[SnapshotDetailModal] restore error:', err);
      new Notice('恢复失败，请查看控制台日志');
      btn.disabled = false;
      btn.textContent = '恢复到此版本';
      this.confirmRestore = false;
      btn.removeClass('mod-warning');
    }
  }
}
