/**
 * @file clipboard-dispatcher.ts
 * @description 画布剪贴板分发：宿主把复制、剪切、粘贴交给内核，按优先级交给注册的处理者
 *
 * 设计考量 (Why):
 * 1. 平台中立：系统剪贴板只能在宿主的复制 / 粘贴事件里同步读写，内核只接收与返回「格式 → 文本」的纯数据，
 *    由宿主负责写入与读取 (浏览器为 ClipboardEvent.clipboardData)。
 * 2. 与指针、键盘一致的优先级链：高优先级的处理者 (如以后的表格单元格选区) 先处理，返回结果即停止，
 *    低优先级的通用处理 (复制选中节点) 自动让路。
 * 3. 画布内文字编辑走自己的隐藏输入框，宿主不会把那时的复制粘贴交到这里。
 */

/** 剪贴板数据：格式 (MIME，如 text/plain) → 文本内容 */
export type ClipboardData = Readonly<Record<string, string>>;

export interface ClipboardWriteEvent {
  readonly operation: 'copy' | 'cut';
  readonly status: 'completed' | 'partial';
  readonly data: ClipboardData;
}

export interface ClipboardHandler {
  /** 复制当前选中的内容；没有可复制的内容时返回 null，交给下一个处理者 */
  copy?(): ClipboardData | null;
  /** 剪切：复制后删除；没有可剪切的内容时返回 null */
  cut?(): ClipboardData | null;
  /** 粘贴；处理了返回 true */
  paste?(data: ClipboardData, files?: readonly unknown[]): boolean;
}

interface ClipboardEntry {
  readonly handler: ClipboardHandler;
  readonly priority: number;
}

export class ClipboardDispatcher {
  private entries: ClipboardEntry[] = [];
  private readonly writeListeners = new Set<(event: ClipboardWriteEvent) => void>();

  onWrite(listener: (event: ClipboardWriteEvent) => void): () => void {
    this.writeListeners.add(listener);
    return () => this.writeListeners.delete(listener);
  }

  /** 宿主写入后通知；部分格式失败仍可能留下媒体载荷，观察者不能改变剪切结果。 */
  notifyWrite(operation: 'copy' | 'cut', data: ClipboardData, status: 'completed' | 'partial' = 'completed'): void {
    const event = Object.freeze({ operation, status, data: Object.freeze({ ...data }) });
    for (const listener of this.writeListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[SkyNote:Clipboard] 剪贴板写入观察失败:', error);
      }
    }
  }

  /**
   * 注册处理者
   * @param priority 数值越大越先处理 (默认 0)
   * @returns 注销函数
   */
  register(handler: ClipboardHandler, priority = 0): () => void {
    const entry = { handler, priority };
    this.entries = [...this.entries, entry].sort((a, b) => b.priority - a.priority);
    return () => {
      this.entries = this.entries.filter((item) => item !== entry);
    };
  }

  /** @returns 要写入系统剪贴板的数据；没有处理者响应时为 null (宿主保留默认行为) */
  copy(): ClipboardData | null {
    for (const { handler } of this.entries) {
      const data = handler.copy?.();
      if (data) return data;
    }
    return null;
  }

  cut(): ClipboardData | null {
    for (const { handler } of this.entries) {
      const data = handler.cut?.();
      if (data) return data;
    }
    return null;
  }

  /** @returns 是否有处理者处理了粘贴 */
  paste(data: ClipboardData, files?: readonly unknown[]): boolean {
    return this.entries.some(({ handler }) => handler.paste?.(data, files) === true);
  }

  clear(): void {
    this.entries = [];
    this.writeListeners.clear();
  }
}
