import { App, FuzzySuggestModal } from 'obsidian';
import type { SyncScope } from '../sync/syncManager';

/**
 * 同步范围选择弹窗。
 * 当主库 + 共享目录挂载同时启用时，命令面板操作（浏览快照、导出、创建快照）
 * 先通过此弹窗让用户选择作用 scope，再执行实际操作。
 */
export class ScopePickerModal extends FuzzySuggestModal<SyncScope> {
  constructor(
    app: App,
    private readonly scopes: SyncScope[],
    private readonly onChoose: (scope: SyncScope) => void,
  ) {
    super(app);
    this.setPlaceholder('选择同步范围…');
  }

  getItems(): SyncScope[] {
    return this.scopes;
  }

  getItemText(scope: SyncScope): string {
    return scope.label;
  }

  onChooseItem(scope: SyncScope): void {
    this.onChoose(scope);
  }
}
