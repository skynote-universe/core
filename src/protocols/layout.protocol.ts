/**
 * @file layout.protocol.ts
 * @description 布局协议 (ADR-130)：插件注册排列规则，内核在同一事务内派生成员位置
 *
 * 设计考量 (Why):
 * 1. 布局是排列规则而不是节点类型：成员可以是任何已注册的节点，树就是文档已有的父子层级，
 *    移动、删除、复制、撤销与协同全部沿用现有机制。
 * 2. 只读视图 + 纯函数：布局拿到的是内核构建的成员树，只返回成员的位姿与树边规格，不能直接改文档，
 *    写入统一由内核在派生阶段生成补丁。
 * 3. 成员的位置与朝向都由布局决定 (arrange 给出，未给朝向即不旋转)，用户不能单独移动或旋转成员。
 * 4. 树边 (成员与父成员之间的线) 是树形布局的固有属性：布局经 edge() 给出默认规格，
 *    由插件经派生连线来源绘制 (见 connector-source.protocol)；内核只定义类型、不调用。
 */

import type { Point } from '../types/geometry';
import type { NodeEntity } from '../types/node';
import type { ConnectorStyle } from '../types/connector';

/** 布局树中的一个成员 (只读视图) */
export interface LayoutMember {
  readonly node: Readonly<NodeEntity>;
  /** 父成员；根为 undefined */
  readonly parent: LayoutMember | undefined;
  /** 子成员，按层叠顺序 (即兄弟顺序) 排列 */
  readonly children: readonly LayoutMember[];
  /** 根为 0 */
  readonly depth: number;
  /** 成员属性 layoutItem (根为空对象)：各键是不可信输入，使用它的插件读取时自行校验 */
  readonly item: Readonly<Record<string, unknown>>;
}

/** 一棵布局树 (只读视图) */
export interface LayoutTree {
  readonly root: LayoutMember;
  /** 根节点 layout.options 经布局 parseOptions 解析后的结果 (未提供解析时为原值或空对象) */
  readonly options: Readonly<Record<string, unknown>>;
  get(nodeId: string): LayoutMember | undefined;
}

/** 成员在根局部坐标中的目标位姿：位置为未旋转外框的左上角；rotation 缺省为 0 (不旋转) */
export interface LayoutPlacement extends Point {
  readonly rotation?: number;
}

/** 树边 (成员通向父成员的线) 的默认规格：供绘制这类线的插件 (如分支线来源) 读取 */
export interface LayoutEdgeSpec {
  /** 路由器 id (线型) */
  readonly router: string;
  /** 父成员一端的连接点 (按宽高归一化)；缺省为浮动端 */
  readonly fromAnchor?: Point;
  /** 子成员一端的连接点 (按宽高归一化)；缺省为浮动端 */
  readonly toAnchor?: Point;
  readonly style?: ConnectorStyle;
}

/** 布局定义契约 */
export interface LayoutDefinition {
  /** 全局唯一标识，即根节点的 layout.type，如 'mindmap' */
  readonly id: string;
  readonly label: string;
  /** 解析根节点的 layout.options (不可信输入)：补默认值、丢弃非法项 */
  parseOptions?(raw: unknown): Record<string, unknown>;
  /**
   * 排版纯函数：返回各成员相对根的目标位姿 (根局部坐标，位置为成员未旋转外框的左上角，朝向缺省为 0)
   * 根自身的位姿归用户；结果中的根与未给出的成员保持原位，朝向为 0
   */
  arrange(tree: LayoutTree): ReadonlyMap<string, LayoutPlacement>;
  /** 树边 (成员通向父成员的线) 的默认规格 (连接点、线型、样式) */
  edge?(member: LayoutMember, tree: LayoutTree): LayoutEdgeSpec;
}

/** 插件可用的布局查询：读取定义 (如分支线来源取默认规格) 并订阅注册表变化 */
export interface LayoutReader {
  get(id: string): LayoutDefinition | undefined;
  onChange(listener: () => void): () => void;
}
