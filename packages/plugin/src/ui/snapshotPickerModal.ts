import { App, FuzzySuggestModal } from 'obsidian';
import type { SnapshotMeta } from '@salt-sync/shared';

/**
 * 快照选择弹窗。
 * 传入预加载的快照列表和选中回调，通过 FuzzySuggestModal 模糊搜索选择。
 */
export class SnapshotPickerModal extends FuzzySuggestModal<SnapshotMeta> {
  constructor(
    app: App,
    private readonly snapshots: SnapshotMeta[],
    private readonly onChoose: (meta: SnapshotMeta) => void,
  ) {
    super(app);
    this.setPlaceholder('选择快照版本…');
  }

  getItems(): SnapshotMeta[] {
    return this.snapshots;
  }

  getItemText(item: SnapshotMeta): string {
    const date = item.createdAt.replace('T', ' ').slice(0, 16);
    return `${date}  ·  ${item.markdownFileCount} 篇文档, ${item.blobFileCount} 个附件`;
  }

  onChooseItem(item: SnapshotMeta): void {
    this.onChoose(item);
  }
}
