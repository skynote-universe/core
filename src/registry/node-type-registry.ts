/**
 * @file node-type-registry.ts
 * @description 节点类型注册表 (NodeTypeRegistry)
 *
 * 设计考量 (Why):
 * 1. 节点与渲染器解耦：渲染器通过 nodeType.compose(node) 获取声明式图元，
 *    通过此注册表实现动态即插即用，杜绝在内核或渲染器内硬编码 nodeType 判断。
 * 2. 安全与防重：禁止空类型注册，提供类型安全的检索与遍历。
 */

import type { NodeTypeDefinition } from '../protocols/node-type.protocol';
import type { NodeEntity, NodeStyle } from '../types/node';

/** 节点类型注册表变更回调：参数为发生变化的节点类型标识 */
export type NodeTypeChangeListener = (type: string) => void;

interface ValidationCacheEntry {
  readonly definition: NodeTypeDefinition<unknown, NodeStyle>;
  readonly dataVersion: number;
  readonly error: string | null;
}

/** 节点类型的只读查询 (插件据此读取其他节点类型声明的缩放行为、轮廓、结构校验等) */
export type NodeTypeReader = Pick<
  NodeTypeRegistry,
  'get' | 'getValid' | 'has' | 'getAll' | 'validateNode' | 'isValidNode' | 'onChange'
>;

export class NodeTypeRegistry {
  /** 各节点类型的 TData / TStyle 互不相同，存储时擦除泛型，取出时由调用方按类型标识还原 */
  private readonly definitions = new Map<string, NodeTypeDefinition<unknown, NodeStyle>>();
  private readonly listeners = new Set<NodeTypeChangeListener>();
  private readonly validationCache = new Map<string, ValidationCacheEntry>();

  /**
   * 注册节点类型定义
   */
  register<TData = Record<string, unknown>, TStyle extends NodeStyle = NodeStyle>(
    definition: NodeTypeDefinition<TData, TStyle>
  ): void {
    if (!definition || !definition.type) {
      throw new Error('[NodeTypeRegistry] 注册失败：节点类型定义缺少有效 type 字段');
    }

    if (this.definitions.has(definition.type)) {
      console.warn(`[SkyNote:NodeTypeRegistry] 节点类型 "${definition.type}" 已存在，将被新定义覆盖`);
    }

    this.definitions.set(definition.type, definition as unknown as NodeTypeDefinition<unknown, NodeStyle>);
    this.validationCache.clear();
    this.notify(definition.type);
  }

  /**
   * 注销指定节点类型
   */
  unregister(type: string): boolean {
    const deleted = this.definitions.delete(type);
    if (deleted) {
      this.validationCache.clear();
      this.notify(type);
    }
    return deleted;
  }

  /**
   * 订阅节点类型注册与注销 (插件晚于文档加载安装或卸载时，引擎与渲染器据此刷新空间索引、路由与视图)
   */
  onChange(listener: NodeTypeChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 获取指定节点类型定义
   */
  get<TData = Record<string, unknown>, TStyle extends NodeStyle = NodeStyle>(
    type: string
  ): NodeTypeDefinition<TData, TStyle> | undefined {
    return this.definitions.get(type) as unknown as NodeTypeDefinition<TData, TStyle> | undefined;
  }

  /**
   * 校验节点特有结构是否合法：未注册类型或未声明 validate 时返回 null；
   * 校验失败或抛出异常时返回错误描述字符串。提供 dataVersion 时按 (nodeId, dataVersion, definition) 缓存。
   */
  validateNode(node: Readonly<NodeEntity>, dataVersion?: number): string | null {
    const definition = this.definitions.get(node.nodeType);
    if (!definition?.validate) return null;
    if (dataVersion !== undefined) {
      const cached = this.validationCache.get(node.id);
      if (cached && cached.definition === definition && cached.dataVersion === dataVersion) {
        return cached.error;
      }
    }
    let error: string | null = null;
    try {
      const result = definition.validate(node);
      if (typeof result === 'string' && result.length > 0) error = result;
    } catch (err) {
      error = err instanceof Error ? err.message : '节点特有结构校验异常';
    }
    if (dataVersion !== undefined) {
      this.validationCache.set(node.id, { definition, dataVersion, error });
    }
    return error;
  }

  /**
   * 判断节点特有结构是否通过校验
   */
  isValidNode(node: Readonly<NodeEntity>, dataVersion?: number): boolean {
    return this.validateNode(node, dataVersion) === null;
  }

  /**
   * 获取节点对应的有效类型定义：若节点未通过该类型的 validate 校验，返回 undefined，
   * 使调用方自动回退至通用矩形外框语义 (防崩溃兜底)。
   */
  getValid<TData = Record<string, unknown>, TStyle extends NodeStyle = NodeStyle>(
    node: Readonly<NodeEntity>,
    dataVersion?: number
  ): NodeTypeDefinition<TData, TStyle> | undefined {
    const definition = this.get<TData, TStyle>(node.nodeType);
    if (!definition) return undefined;
    if (definition.validate && this.validateNode(node, dataVersion) !== null) return undefined;
    return definition;
  }

  /** 剔除已删除节点的校验缓存 */
  evictValidationCache(nodeId: string): void {
    this.validationCache.delete(nodeId);
  }

  /** 清空全部节点的校验缓存 */
  clearValidationCache(): void {
    this.validationCache.clear();
  }

  /**
   * 判断节点类型是否已注册
   */
  has(type: string): boolean {
    return this.definitions.has(type);
  }

  /**
   * 获取全部已注册节点类型列表
   */
  getAll(): readonly NodeTypeDefinition[] {
    return Array.from(this.definitions.values()) as unknown as NodeTypeDefinition[];
  }

  /**
   * 清空注册表
   */
  clear(): void {
    this.listeners.clear();
    this.validationCache.clear();
    this.definitions.clear();
  }

  private notify(type: string): void {
    for (const listener of this.listeners) {
      try {
        listener(type);
      } catch (err) {
        console.error('[SkyNote:NodeTypeRegistry] 变更监听回调异常:', err);
      }
    }
  }
}
