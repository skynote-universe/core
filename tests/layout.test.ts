/**
 * @file layout.test.ts
 * @description ADR-130 布局协议：成员判定、同一事务派生排版、注册表晚到与卸载、导入校验
 *              (派生连线来源见 connector-source.test.ts，导图分支线见 plugins-basic)
 */

import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { createEmptyCanvasDocument } from '../src/state/document-store';
import { parseCanvasDocument } from '../src/serialization/document-schema';
import { normalizePatchPath } from '../src/operation/patch-path';
import type { NodeEntity } from '../src/types/node';
import type { Point } from '../src/types/geometry';
import type { LayoutDefinition, LayoutMember } from '../src/protocols/layout.protocol';
import type { SkyNotePlugin } from '../src/protocols/plugin.protocol';

function makeNode(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...patch
  };
}

/** 大纲式排版：深度决定缩进，按先序遍历逐行向下，行高取成员自身高度 + 间距 */
const outline: LayoutDefinition = {
  id: 'test:outline',
  label: '大纲',
  arrange(tree) {
    const positions = new Map<string, Point>();
    let y = 0;
    const visit = (member: LayoutMember): void => {
      if (member.depth > 0) positions.set(member.node.id, { x: member.depth * 40, y });
      y += member.node.height + 10;
      member.children.forEach(visit);
    };
    visit(tree.root);
    return positions;
  },
  branch: () => ({
    router: 'orthogonal',
    fromAnchor: { x: 0, y: 1 },
    toAnchor: { x: 0, y: 0.5 },
    style: { stroke: 'gray' }
  })
};

function layoutPlugin(definition: LayoutDefinition): SkyNotePlugin {
  return {
    id: `layout/${definition.id}`,
    name: definition.label,
    version: '1.0.0',
    install: (ctx) => ctx.registerLayout(definition)
  };
}

/** 根 root 下：a (含子 a1)、b；member 字段可覆盖 */
function seedTree(engine: SkyNoteEngine): void {
  const store = engine.documentStore;
  store.batch(() => {
    store.addNode(makeNode('root', { x: 500, y: 300, layout: { type: 'test:outline' } }));
    store.addNode(makeNode('a', { parentId: 'root', zIndex: 'a0', layoutItem: {} }));
    store.addNode(makeNode('a1', { parentId: 'a', zIndex: 'a0', layoutItem: {} }));
    store.addNode(makeNode('b', { parentId: 'root', zIndex: 'a1', layoutItem: {} }));
  });
}

const position = (engine: SkyNoteEngine, id: string) => {
  const node = engine.documentStore.getNode(id)!;
  return { x: node.x, y: node.y };
};

describe('布局排版 (同一事务派生)', () => {
  it('成员位置在新建它们的同一事务内排好 (相对父节点)，一步撤销整体回退', () => {
    const engine = new SkyNoteEngine().use(layoutPlugin(outline));
    seedTree(engine);
    // 根局部坐标：a (40, 50)、a1 (80, 100)、b (40, 150)；a1 相对 a
    expect(position(engine, 'a')).toEqual({ x: 40, y: 50 });
    expect(position(engine, 'a1')).toEqual({ x: 40, y: 50 });
    expect(position(engine, 'b')).toEqual({ x: 40, y: 150 });
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode('a')).toBeUndefined();
  });

  it('成员尺寸变化、删除与改挂都重新排版；直接写成员位置会被排回；移动根不产生成员补丁', () => {
    const engine = new SkyNoteEngine().use(layoutPlugin(outline));
    seedTree(engine);
    const store = engine.documentStore;

    store.updateNode('a1', { height: 90 });
    expect(position(engine, 'b')).toEqual({ x: 40, y: 200 });
    store.undo();
    expect(position(engine, 'b')).toEqual({ x: 40, y: 150 });

    store.removeEntities({ nodeIds: ['a1'] });
    expect(position(engine, 'b')).toEqual({ x: 40, y: 100 });
    store.undo();

    // 改挂：b 移到 a 下 (排在 a1 之后)
    store.updateNode('b', { parentId: 'a', zIndex: 'a1' });
    expect(position(engine, 'b')).toEqual({ x: 40, y: 100 });

    store.updateNode('a1', { x: 999 });
    expect(position(engine, 'a1')).toEqual({ x: 40, y: 50 });

    const record = store.moveEntities({ nodeIds: ['root'] }, { x: 10, y: 0 })!;
    expect(record.patches.map((p) => normalizePatchPath(p.path).join('.'))).toEqual(['content.nodes.root.x']);
  });

  it('不带 layoutItem 的子节点是宿主的普通内容，不参与排版；嵌套的布局根在外层树里是叶子', () => {
    const engine = new SkyNoteEngine().use(layoutPlugin(outline));
    seedTree(engine);
    const store = engine.documentStore;
    store.addNode(makeNode('note', { parentId: 'a', x: 7, y: 7, zIndex: 'a5' }));
    expect(position(engine, 'note')).toEqual({ x: 7, y: 7 });
    expect(position(engine, 'b')).toEqual({ x: 40, y: 150 });

    store.batch(() => {
      store.updateNode('b', { layout: { type: 'test:outline' } });
      store.addNode(makeNode('b1', { parentId: 'b', zIndex: 'a0', layoutItem: {} }));
    });
    // b1 归内层树 (相对 b 排版)，不改变外层树的行
    expect(position(engine, 'b1')).toEqual({ x: 40, y: 50 });
    expect(position(engine, 'b')).toEqual({ x: 40, y: 150 });
  });
});

describe('复制分支到剪贴板', () => {
  it('带子成员的分支带上原树的布局声明成为独立的树，叶子去掉成员标记；复制根不受影响', () => {
    const engine = new SkyNoteEngine().use(layoutPlugin(outline));
    const store = engine.documentStore;
    seedTree(engine);
    store.updateNode('root', { layout: { type: 'test:outline', options: { gap: 3 } } });

    const nodes = store.copyEntities({ nodeIds: ['a', 'b'] })!.nodes;
    const byId = (id: string) => nodes.find((node) => node.id === id)!;
    expect(byId('a').layout).toEqual({ type: 'test:outline', options: { gap: 3 } });
    expect(byId('a').layoutItem).toBeUndefined();
    expect(byId('a1').layoutItem).toEqual({});
    expect(byId('b').layout).toBeUndefined();
    expect(byId('b').layoutItem).toBeUndefined();

    const root = store.copyEntities({ nodeIds: ['root'] })!.nodes.find((node) => node.id === 'root')!;
    expect(root.layout).toEqual({ type: 'test:outline', options: { gap: 3 } });
  });
});

describe('注册表与降级', () => {
  function docWithTree() {
    const doc = createEmptyCanvasDocument();
    for (const node of [
      makeNode('root', { layout: { type: 'test:outline' } }),
      makeNode('a', { parentId: 'root', x: 3, y: 3, layoutItem: {} })
    ]) {
      doc.content.nodes[node.id] = node;
    }
    return doc;
  }

  it('未注册的布局不排版，成员停在已保存的位置；布局晚到时重新排版 (不进撤销栈)，卸载后不再排版', () => {
    const engine = new SkyNoteEngine({ initialDoc: docWithTree() });
    expect(position(engine, 'a')).toEqual({ x: 3, y: 3 });

    engine.use(layoutPlugin(outline));
    expect(position(engine, 'a')).toEqual({ x: 40, y: 50 });
    expect(engine.documentStore.canUndo).toBe(false);

    engine.plugins.remove(`layout/${outline.id}`);
    engine.documentStore.updateNode('a', { height: 80 });
    engine.documentStore.updateNode('a', { x: 9 });
    expect(position(engine, 'a')).toEqual({ x: 9, y: 50 });
  });

  it('导入校验：layout.type 须为非空字符串，options 与 layoutItem 只保留纯数据 (各键由使用它的插件读取时校验)', () => {
    const doc = docWithTree() as unknown as Record<string, unknown>;
    const nodes = (doc.content as { nodes: Record<string, Record<string, unknown>> }).nodes;
    nodes.a.layoutItem = JSON.parse('{"side":"left","__proto__":{"x":1},"branch":{"router":"curved"}}');
    const parsed = parseCanvasDocument(doc);
    expect(parsed).toMatchObject({
      ok: true,
      value: { content: { nodes: { a: { layoutItem: { side: 'left', branch: { router: 'curved' } } } } } }
    });
    const layoutItem = parsed.ok ? parsed.value.content.nodes.a.layoutItem : undefined;
    expect(Object.getPrototypeOf(layoutItem)).toBe(Object.prototype);
    nodes.a.layoutItem = { fn: () => 1 };
    expect(parseCanvasDocument(doc).ok).toBe(false);
    nodes.a.layoutItem = {};
    nodes.root.layout = { type: '' };
    expect(parseCanvasDocument(doc).ok).toBe(false);
  });
});
