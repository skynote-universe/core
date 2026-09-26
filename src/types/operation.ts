/**
 * @file operation.ts
 * @description SkyNote 原子操作 (Patch)、事务提交管道与历史快照规范
 * 
 * 设计考量 (Why):
 * 1. 状态流转红线：严禁在外部就地对实体对象进行属性赋值（如 node.x = 100），所有改动必须通过 commitOperation() 提交。
 * 2. 协同 Undo 隔离：引入 origin 字段 ('local' | 'remote')，协同网络同步来的远端 Patch 不会污染本地 Undo 历史栈。
 * 3. 严格可逆性：每条原子 Patch 必须具备对偶的 inversePatch，保证撤销/重做可以在微秒级精准回滚。
 */

/** 操作发起来源分类 */
export type CanvasOperationSource = 'user' | 'system' | 'plugin' | 'collab';

/** 操作发起地域/归属（用于撤销栈隔离） */
export type CanvasOperationOrigin = 'local' | 'remote';

/**
 * 现代画布原子补丁操作动词 (对标 RFC 6902 + RFC 7396 + 集合切片)
 * 剔除死动词 'move'，由 'splice' 统一处理集合调序与增删
 */
export type CanvasPatchOp = 'replace' | 'merge' | 'splice' | 'add' | 'remove' | 'test';

/**
 * 补丁寻址路径规范
 * - 点号分割字符串: 如 "viewport.zoom", "style.fill" (贴合 JS 本能)
 * - 结构化分段数组: 如 ["content", "nodes", nodeId, "x"] (零 split 开销，支持特殊字符)
 */
export type CanvasPatchPath = string | readonly (string | number)[];

/** 1. 属性替换补丁 (最常用: 移动、改尺寸、改颜色) */
export interface ReplacePatch<TValue = unknown> {
  readonly op: 'replace';
  readonly path: CanvasPatchPath;
  /** 替换后的新值 (必填，编译期防呆) */
  readonly value: TValue;
  /** 逆向回滚的旧值 (用于瞬时反向撤销) */
  readonly oldValue?: TValue;
}

/** 2. 字典增量浅合并补丁 (高频样式、业务数据微调，防协同冲刷) */
export interface MergePatch<TValue extends object = Record<string, unknown>> {
  readonly op: 'merge';
  readonly path: CanvasPatchPath;
  /** 增量合并的字典对象 (必填) */
  readonly value: TValue;
  /** 逆向回滚的旧值字典 */
  readonly oldValue?: Partial<TValue>;
}

/** 3. 数组/列表切片补丁 (图层调序、富文本段落增删) */
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

/** 4. 属性/实体新增补丁 */
export interface AddPatch<TValue = unknown> {
  readonly op: 'add';
  readonly path: CanvasPatchPath;
  /** 新增的值 (必填) */
  readonly value: TValue;
}

/** 5. 属性/实体删除补丁 */
export interface RemovePatch<TValue = unknown> {
  readonly op: 'remove';
  readonly path: CanvasPatchPath;
  /** 逆向回滚时的删除前旧值 */
  readonly oldValue?: TValue;
}

/** 6. 先决条件断言补丁 (协同冲突校验与乐观锁) */
export interface TestPatch<TValue = unknown> {
  readonly op: 'test';
  readonly path: CanvasPatchPath;
  /** 期望当前路径匹配的值 */
  readonly value: TValue;
}

/**
 * 细粒度原子数据补丁 (CanvasPatch)
 * 智能可辨识联合类型 (Discriminated Union)：享受 IDE 精准代码补全与模式匹配自动类型收窄
 */
export type CanvasPatch =
  | ReplacePatch
  | MergePatch
  | SplicePatch
  | AddPatch
  | RemovePatch
  | TestPatch;

/**
 * 事务操作记录 (CanvasOperationRecord)
 * 原子事务成功提交后生成的不可变凭据 (扁平无套娃，单一事实源)
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
 * 极简扁平入参，开发者调用零心理负担
 */
export interface CommitOperationOptions<TPayload = unknown> {
  /** 变更语义说明 (如 "移动便签", "修改填充色") */
  label?: string;

  /** 正向原子变更补丁集 */
  patches: CanvasPatch[];
  /** 反向回滚补丁集 (选填，若未提供则由内核根据当前状态自动推导生成) */
  inversePatches?: CanvasPatch[];

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
 * 具有相同 groupId 的连续操作在进入历史栈时会被自动合并折叠为单一步骤
 */
export interface CanvasHistoryEntry {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
  readonly groupId?: string;
  /** 经过对偶抵消、压缩合并后的最终原子补丁 */
  readonly patches: CanvasPatch[];
  readonly inversePatches: CanvasPatch[];
}
