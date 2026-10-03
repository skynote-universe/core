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
import type { NodeStyle } from '../types/node';

/** 节点类型的只读查询 (插件据此读取其他节点类型声明的缩放行为、轮廓等) */
export type NodeTypeReader = Pick<NodeTypeRegistry, 'get' | 'has' | 'getAll'>;

export class NodeTypeRegistry {
  /** 各节点类型的 TData / TStyle 互不相同，存储时擦除泛型，取出时由调用方按类型标识还原 */
  private readonly definitions = new Map<string, NodeTypeDefinition<unknown, NodeStyle>>();

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
  }

  /**
   * 注销指定节点类型
   */
  unregister(type: string): boolean {
    return this.definitions.delete(type);
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
    this.definitions.clear();
  }
}
