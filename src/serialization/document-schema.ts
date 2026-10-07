/**
 * @file document-schema.ts
 * @description 外部文档与剪贴板节点的安全反序列化：白名单校验字段、净化开放字段，返回可直接写入的纯数据
 *
 * 设计考量 (Why):
 * 1. 不可信边界：本地存储 (可能被改坏或来自旧版本)、导入的文件、其他标签页的剪贴板都不能直接写入文档。
 *    实体只保留已知字段并逐一校验类型，未知字段丢弃；任何一处不合法即整体拒绝并给出出错位置，不做半截写入。
 * 2. 开放字段 (style、data、textStyle 等由节点类型自定义的结构) 无法逐键校验：只允许 JSON 兼容的纯数据，
 *    丢弃 __proto__ 等危险键，拒绝函数、非有限数字等无法序列化的值。
 * 3. 零 Base64 红线：任何位置内联 data:/blob: 媒体地址都拒绝。
 * 4. 引用修复而不拒绝：父容器缺失的节点回落到根层级，引用缺失节点的连线保留为悬空连线，尽量保住用户内容；
 *    容器成环等会破坏结构的问题仍由提交守卫拒绝。
 */

import type { CanvasDocument, CanvasMeta } from '../types/canvas';
import type { NodeEntity, NodeLayout, NodeStyle } from '../types/node';
import type { ConnectorEndpoint, ConnectorEntity, ConnectorTextBlock } from '../types/connector';
import type { TextBlock, TextSizingMode } from '../types/text';
import type { Point } from '../types/geometry';
import { DANGEROUS_KEYS } from '../utils/clone';
import { isValidFractionalIndex } from '../utils/fractional-index';
import { splitStyleAlpha } from '../utils/color';
import { sanitizeRichTextRuns } from '../layout/rich-text-edit';
import { findInlineMediaUrl } from '../state/commit-guards';

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** 剪贴板中的节点数据：最顶层节点已换算为根层级的世界位姿 (无 parentId)，后代保持相对父容器的坐标 */
export interface NodeClipboardPayload {
  readonly kind: typeof NODE_CLIPBOARD_KIND;
  readonly version: 1;
  readonly nodes: NodeEntity[];
  readonly connectors: ConnectorEntity[];
}

export const NODE_CLIPBOARD_KIND = 'skynote/nodes';
/** 剪贴板中画布节点数据的格式标识 (与纯文本一同写入系统剪贴板，见 06 设计文档) */
export const NODE_CLIPBOARD_MIME = 'application/x-skynote-nodes';

const SIZING_MODES: ReadonlySet<string> = new Set<TextSizingMode>(['auto-height', 'auto-width', 'fixed']);
/** 开放字段的最大嵌套深度：防御恶意构造的深层结构拖垮递归 */
const MAX_DEPTH = 64;

class SchemaError extends Error {
  constructor(
    readonly path: string,
    reason: string
  ) {
    super(`${path}：${reason}`);
  }
}

type Path = string;

function fail(path: Path, reason: string): never {
  throw new SchemaError(path, reason);
}

function record(value: unknown, path: Path): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, '应为对象');
  return value as Record<string, unknown>;
}

function array(value: unknown, path: Path): unknown[] {
  if (!Array.isArray(value)) fail(path, '应为数组');
  return value;
}

function str(value: unknown, path: Path, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0))
    fail(path, nonEmpty ? '应为非空字符串' : '应为字符串');
  return value;
}

function num(value: unknown, path: Path, min = -Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(path, '应为有效数字');
  return value;
}

function bool(value: unknown, path: Path): boolean {
  if (typeof value !== 'boolean') fail(path, '应为布尔值');
  return value;
}

function point(value: unknown, path: Path): Point {
  const p = record(value, path);
  return { x: num(p.x, `${path}.x`), y: num(p.y, `${path}.y`) };
}

/** 开放字段：只允许 JSON 兼容的纯数据，丢弃危险键 */
function plain(value: unknown, path: Path, depth = 0): unknown {
  if (depth > MAX_DEPTH) fail(path, '嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return num(value, path);
  if (Array.isArray(value)) return value.map((item, i) => plain(item, `${path}[${i}]`, depth + 1));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      result[key] = plain((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
    }
    return result;
  }
  fail(path, '包含无法保存的数据');
}

function plainObject<T>(value: unknown, path: Path): T {
  record(value, path);
  return plain(value, path) as T;
}

/** 可选字段：存在时才校验并写入 */
function optional<T>(
  source: Record<string, unknown>,
  key: string,
  path: Path,
  parse: (value: unknown, path: Path) => T
) {
  return Object.hasOwn(source, key) && source[key] !== undefined ? { [key]: parse(source[key], `${path}.${key}`) } : {};
}

function textBlock(value: unknown, path: Path): TextBlock {
  const b = record(value, path);
  const runs = sanitizeRichTextRuns(b.runs);
  if (!runs) fail(`${path}.runs`, '文字分段格式不正确');
  return {
    id: str(b.id, `${path}.id`, true),
    runs,
    ...optional(b, 'slot', path, (v, p) => str(v, p)),
    ...optional(b, 'style', path, plainObject),
    ...optional(b, 'sizing', path, (v, p) =>
      SIZING_MODES.has(v as string) ? (v as TextSizingMode) : fail(p, '尺寸模式不正确')
    ),
    ...optional(b, 'explicitWidth', path, (v, p) => num(v, p, 0)),
    ...optional(b, 'explicitHeight', path, (v, p) => num(v, p, 0))
  };
}

function connectorTextBlock(value: unknown, path: Path): ConnectorTextBlock {
  const b = record(value, path);
  return {
    ...textBlock(value, path),
    position: num(b.position, `${path}.position`),
    ...optional(b, 'offsetX', path, (v, p) => num(v, p)),
    ...optional(b, 'offsetY', path, (v, p) => num(v, p))
  };
}

function zIndex(value: unknown, path: Path): string {
  if (!isValidFractionalIndex(value)) fail(path, '层级索引不正确');
  return value;
}

/** 节点样式：带透明度的填充色与描边色拆成不透明色值与单独的透明度 */
function nodeStyle(value: unknown, path: Path): NodeStyle {
  return splitStyleAlpha(plainObject<NodeStyle>(value, path));
}

/** 布局根声明 (ADR-130)：options 归布局在读取时解析，这里只保证是纯数据 */
function nodeLayout(value: unknown, path: Path): NodeLayout {
  const l = record(value, path);
  return { type: str(l.type, `${path}.type`, true), ...optional(l, 'options', path, plainObject) };
}

/** 校验单个节点实体 (只保留已知字段) */
export function sanitizeNodeEntity(value: unknown, path: Path): NodeEntity {
  const n = record(value, path);
  if (n.type !== 'node') fail(`${path}.type`, '应为 node');
  const list = <T>(key: string, parse: (v: unknown, p: Path) => T) =>
    optional(n, key, path, (v, p) => array(v, p).map((item, i) => parse(item, `${p}[${i}]`)));
  return {
    id: str(n.id, `${path}.id`, true),
    type: 'node',
    nodeType: str(n.nodeType, `${path}.nodeType`, true),
    x: num(n.x, `${path}.x`),
    y: num(n.y, `${path}.y`),
    width: num(n.width, `${path}.width`, 0),
    height: num(n.height, `${path}.height`, 0),
    rotation: num(n.rotation, `${path}.rotation`),
    zIndex: zIndex(n.zIndex, `${path}.zIndex`),
    locked: bool(n.locked, `${path}.locked`),
    ...optional(n, 'parentId', path, (v, p) => str(v, p, true)),
    ...optional(n, 'aspectLocked', path, bool),
    ...list('textBlocks', textBlock),
    ...optional(n, 'style', path, nodeStyle),
    ...optional(n, 'textStyle', path, plainObject),
    ...optional(n, 'data', path, plainObject),
    ...optional(n, 'layout', path, nodeLayout),
    // 成员属性的各键归使用它的插件，读取时由插件校验 (ADR-130)
    ...optional(n, 'layoutItem', path, plainObject)
  };
}

function endpoint(value: unknown, path: Path): ConnectorEndpoint {
  const e = record(value, path);
  // 端点只能是三种状态之一 (浮动、固定、自由)，混合状态会让路由无法判断以谁为准
  if (e.nodeId !== undefined) {
    return {
      nodeId: str(e.nodeId, `${path}.nodeId`, true),
      ...optional(e, 'anchor', path, point)
    };
  }
  return { position: point(e.position, `${path}.position`) };
}

/** 校验单条连线实体 (只保留已知字段) */
export function sanitizeConnectorEntity(value: unknown, path: Path): ConnectorEntity {
  const c = record(value, path);
  if (c.type !== 'connector') fail(`${path}.type`, '应为 connector');
  return {
    id: str(c.id, `${path}.id`, true),
    type: 'connector',
    connectorType: str(c.connectorType, `${path}.connectorType`, true),
    from: endpoint(c.from, `${path}.from`),
    to: endpoint(c.to, `${path}.to`),
    zIndex: zIndex(c.zIndex, `${path}.zIndex`),
    locked: bool(c.locked, `${path}.locked`),
    ...optional(c, 'style', path, plainObject),
    ...optional(c, 'textBlocks', path, (v, p) => array(v, p).map((item, i) => connectorTextBlock(item, `${p}[${i}]`))),
    ...optional(c, 'data', path, plainObject),
    ...optional(c, 'controlPoints', path, (v, p) => array(v, p).map((item, i) => point(item, `${p}[${i}]`)))
  };
}

/** 以 id 为键的实体表：键必须与实体 id 一致 */
function entityTable<T extends { id: string }>(
  value: unknown,
  path: Path,
  parse: (v: unknown, p: Path) => T
): Record<string, T> {
  const table: Record<string, T> = {};
  for (const [key, item] of Object.entries(record(value, path))) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const entity = parse(item, `${path}.${key}`);
    if (entity.id !== key) fail(`${path}.${key}.id`, '与所在键不一致');
    table[key] = entity;
  }
  return table;
}

/** 父容器缺失的节点回落到根层级 (而不是丢弃整份内容) */
function detachOrphans(nodes: Record<string, NodeEntity>): void {
  for (const node of Object.values(nodes)) {
    if (node.parentId !== undefined && !Object.hasOwn(nodes, node.parentId)) delete node.parentId;
  }
}

/** 端点所连节点不存在的连线：既画不出也选不中，留着只会成为删不掉的数据，直接丢弃 */
function dropDanglingConnectors(connectors: Record<string, ConnectorEntity>, nodes: Record<string, NodeEntity>): void {
  for (const [id, connector] of Object.entries(connectors)) {
    const dangling = [connector.from, connector.to].some(
      (end) => end.nodeId !== undefined && !Object.hasOwn(nodes, end.nodeId)
    );
    if (dangling) delete connectors[id];
  }
}

function rejectInlineMedia(value: unknown): void {
  const inlineMedia = findInlineMediaUrl(value);
  if (inlineMedia) fail(inlineMedia, '内联了 data:/blob: 媒体地址，媒体必须通过资产引用');
}

function run<T>(parse: () => T): ParseResult<T> {
  try {
    return { ok: true, value: parse() };
  } catch (err) {
    if (err instanceof SchemaError) return { ok: false, error: err.message };
    throw err;
  }
}

/** 解析外部画布文档 (本地存储、导入的文件) */
export function parseCanvasDocument(value: unknown): ParseResult<CanvasDocument> {
  return run(() => {
    const d = record(value, '文档');
    const m = record(d.meta, 'meta');
    const meta: CanvasMeta = {
      version: num(m.version, 'meta.version'),
      createdAt: num(m.createdAt, 'meta.createdAt'),
      updatedAt: num(m.updatedAt, 'meta.updatedAt'),
      ...optional(m, 'tags', 'meta', (v, p) => array(v, p).map((tag, i) => str(tag, `${p}[${i}]`))),
      ...optional(m, 'title', 'meta', (v, p) => str(v, p))
    };
    const content = record(d.content, 'content');
    const nodes = entityTable(content.nodes, 'content.nodes', sanitizeNodeEntity);
    detachOrphans(nodes);
    const connectors = entityTable(content.connectors, 'content.connectors', sanitizeConnectorEntity);
    dropDanglingConnectors(connectors, nodes);
    const doc: CanvasDocument = {
      id: str(d.id, 'id', true),
      name: str(d.name, 'name'),
      meta,
      content: { nodes, connectors },
      ...optional(d, 'assets', '文档', plainObject),
      ...optional(d, 'resources', '文档', plainObject)
    };
    rejectInlineMedia(doc);
    return doc;
  });
}

/** 解析剪贴板中的画布节点数据 (JSON 文本)；不是画布节点数据时返回失败 */
export function parseNodeClipboard(json: string): ParseResult<NodeClipboardPayload> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: '剪贴板内容不是有效的 JSON' };
  }
  return run(() => {
    const p = record(data, '剪贴板');
    if (p.kind !== NODE_CLIPBOARD_KIND || p.version !== 1) fail('剪贴板', '不是画布数据');
    const nodes = array(p.nodes, 'nodes').map((item, i) => sanitizeNodeEntity(item, `nodes[${i}]`));
    const connectors = array(p.connectors, 'connectors').map((item, i) =>
      sanitizeConnectorEntity(item, `connectors[${i}]`)
    );
    if (nodes.length === 0 && connectors.length === 0) fail('剪贴板', '没有可粘贴的内容');
    const payload: NodeClipboardPayload = { kind: NODE_CLIPBOARD_KIND, version: 1, nodes, connectors };
    rejectInlineMedia(payload);
    return payload;
  });
}
