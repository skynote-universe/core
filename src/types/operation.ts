/**
 * @file operation.ts
 * @description SkyNote 正交原子操作 (Patch)、事务提交管道与历史快照规范
 * 
 * 设计考量 (Why):
 * 1. 状态流转红线：严禁在外部就地对实体对象进行属性赋值（如 node.x = 100），所有改动必须通过 commitOperation() 提交。
 * 2. 现代正交原子四元组：彻底消灭 RFC 6902 中 add/replace 的二义性，收敛为 'set' | 'unset' | 'splice' | 'text'。
 *    - set:    属性赋值/更新 (存在则替换，不存在则新增；支持 merge: true 字典增量浅合并)
 *    - unset:  属性/字段移除
 *    - splice: 有序列表切片 (增删插，针对 Array)
 *    - text:   文本差量 (Delta 级操作，防止多人协同打字冲刷)
 * 3. 协同 Undo 隔离：引入 origin 字段 ('local' | 'remote')，协同网络同步来的远端 Patch 绝不污染本地 Undo 历史栈。
 * 4. 严格对偶可逆性：每条原子 Patch 均具备精准的 inversePatch，实现微秒级瞬时回滚，杜绝深拷贝内存雪崩。
 */

/** 操作发起来源分类 */
export type CanvasOperationSource = 'user' | 'system' | 'plugin' | 'collab';

/** 操作发起地域/归属（用于撤销栈隔离） */
export type CanvasOperationOrigin = 'local' | 'remote';

/**
 * 现代无限画布正交原子操作集
 */
export type CanvasPatchOp = 'set' | 'unset' | 'splice' | 'text';

/**
 * 补丁寻址路径规范
 * - 点号分割字符串: 如 "viewport.zoom", "style.fill" (贴合 JS 本能)
 * - 结构化分段数组: 如 ["content", "nodes", nodeId, "x"] (零 split 开销，支持特殊字符)
 */
export type CanvasPatchPath = string | readonly (string | number)[];

/**
 * 1. 属性赋值与更新补丁 (最常用: 移动、改尺寸、改颜色、字典合并)
 * 替代旧版 replace, add 以及 merge
 */
export interface SetPatch<TValue = unknown> {
  readonly op: 'set';
  readonly path: CanvasPatchPath;
  /** 写入的新值 */
  readonly value: TValue;
  /**
   * 是否采用字典增量浅合并 (默认 false 为直接覆盖赋值)
   * 当 value 为普通键值对象且 merge 为 true 时，相当于 Object.assign 增量合并
   */
  readonly merge?: boolean;
  /** 逆向回滚的旧值 (用于瞬时反向撤销，由内核自动推导或显式传入) */
  readonly oldValue?: TValue;
}

/**
 * 2. 属性/键名移除补丁
 * 对应 delete target[key]
 */
export interface UnsetPatch<TValue = unknown> {
  readonly op: 'unset';
  readonly path: CanvasPatchPath;
  /** 逆向回滚时的删除前旧值 */
  readonly oldValue?: TValue;
}

/**
 * 3. 数组/列表切片补丁 (图层调序、节点列表增删)
 */
export interface SplicePatch<TItem = unknown> {
  readonly op: 'splice';
  readonly path: CanvasPatchPath;
  /** 起始切片下标 (必填) */
  readonly index: number;
  /** 删除的项数量 (必填) */
  readonly deleteCount: number;
  /** 插入的新项列表 */
  readonly items?: readonly TItem[];
  /** 逆向回滚时被删除的原项列表 */
  readonly deletedItems?: readonly TItem[];
}

/** 文本差量原子操作 (Delta Op) */
export type TextDeltaOp =
  | { readonly retain: number }
  | { readonly insert: string; readonly attributes?: Record<string, unknown> }
  | { readonly delete: number };

/**
 * 4. 文本局部差量补丁 (富文本与长文本局部协同切片)
 * 字符级防冲突，解决多人协同打字冲刷
 */
export interface TextPatch {
  readonly op: 'text';
  readonly path: CanvasPatchPath;
  /** 正向 Delta 序列 */
  readonly deltas: readonly TextDeltaOp[];
  /** 反向回滚 Delta 序列 (由应用器推导生成) */
  readonly inverseDeltas?: readonly TextDeltaOp[];
}

/**
 * 细粒度原子数据补丁 (CanvasPatch)
 * 智能可辨识联合类型 (Discriminated Union)
 */
export type CanvasPatch = SetPatch | UnsetPatch | SplicePatch | TextPatch;

/** 事务前置先决条件守卫 (用于协同冲突检测与乐观锁) */
export interface OperationGuard {
  readonly path: CanvasPatchPath;
  readonly expected: unknown;
}

/**
 * 事务操作记录 (CanvasOperationRecord)
 * 原子事务成功提交后生成的不可变凭据
 */
export interface CanvasOperationRecord<TPayload = unknown> {
  readonly id: string;
  /** 变更语义说明 (如 "移动节点", "修改文字") */
  readonly label: string;
  readonly timestamp: number;
  /** 操作来源地域 (用于撤销栈隔离) */
  readonly origin: CanvasOperationOrigin;
  /** 操作发起来源类型 */
  readonly source: CanvasOperationSource;
  /** 是否已记录到撤销栈 */
  readonly undoable: boolean;
  /** 连续操作折叠分组 ID */
  readonly groupId?: string;

  /** 正向原子补丁集 */
  readonly patches: CanvasPatch[];
  /** 反向回滚补丁集 (对偶操作，用于瞬时 Undo) */
  readonly inversePatches: CanvasPatch[];

  /** 自定义扩展载荷 */
  readonly payload?: TPayload;
}

/**
 * commitOperation() 事务提交入参选项
 */
export interface CommitOperationOptions<TPayload = unknown> {
  /** 变更语义说明 (如 "移动便签", "修改填充色") */
  label?: string;

  /** 正向原子变更补丁集 */
  patches: CanvasPatch[];
  /** 反向回滚补丁集 (选填，若未提供则由内核根据当前状态自动推导生成) */
  inversePatches?: CanvasPatch[];

  /** 事务前置先决条件断言 (可选，断言失败则整批回滚) */
  guard?: OperationGuard;

  /** 是否记录到撤销栈 (默认 true；连续拖拽中设为 false，松手提交最终态) */
  undoable?: boolean;
  /** 连续操作折叠分组 ID (高频拖拽共用同一个 groupId，松手后折叠为 1 步撤销) */
  groupId?: string;
  /** 操作来源 (默认 'local'，协同网络接收的设为 'remote'，杜绝污染本地撤销栈) */
  origin?: CanvasOperationOrigin;
  /** 操作触发源类型 (默认 'user') */
  source?: CanvasOperationSource;

  /** 扩展载荷 (供业务插件自定义附加上下文) */
  payload?: TPayload;
}

/**
 * 历史撤销栈条目 (CanvasHistoryEntry)
 */
export interface CanvasHistoryEntry {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
  readonly groupId?: string;
  readonly patches: CanvasPatch[];
  readonly inversePatches: CanvasPatch[];
}
