/**
 * @file document-schema.test.ts
 * @description 外部数据的安全反序列化，以及复制、粘贴、整体替换内容的语义命令
 */

import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { createEmptyCanvasDocument } from '../src/state/document-store';
import { NODE_CLIPBOARD_KIND, parseCanvasDocument, parseNodeClipboard } from '../src/serialization/document-schema';
import type { NodeEntity } from '../src/types/node';
import type { ConnectorEntity } from '../src/types/connector';

function makeNode(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...patch
  };
}

function docWith(nodes: NodeEntity[], connectors: ConnectorEntity[] = []) {
  const doc = createEmptyCanvasDocument();
  for (const node of nodes) doc.content.nodes[node.id] = node;
  for (const connector of connectors) doc.content.connectors[connector.id] = connector;
  return doc;
}

describe('文档反序列化', () => {
  it('合法文档原样通过；文档未知字段丢弃、危险键丢弃，节点支持顶层自定义扩展字段', () => {
    const raw = JSON.parse(
      JSON.stringify(
        docWith([
          makeNode('a', {
            style: { fill: '$red' },
            data: { nested: { list: [1, 'x', null] } },
            textBlocks: [{ id: 'body', runs: [{ text: 'hi', fontWeight: 'bold' }] }]
          })
        ])
      )
    );
    raw.unknownDocField = 1;
    raw.content.nodes.a.customProp = 'valid';
    raw.content.nodes.a.data = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');

    const result = parseCanvasDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as unknown as Record<string, unknown>).unknownDocField).toBeUndefined();
    const node = result.value.content.nodes.a as NodeEntity & { customProp?: string };
    expect(node.customProp).toBe('valid');
    expect(node.data).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(node.textBlocks![0].runs).toEqual([{ text: 'hi', fontWeight: 'bold' }]);
  });

  it('导出再导入：文字的颜色、字号、粗细与对齐方式无损还原', () => {
    const node = makeNode('t', {
      nodeType: 'free-text',
      textBlocks: [
        {
          id: 'body',
          style: { fontSize: 24, textAlign: 'right', verticalAlign: 'bottom', lineHeight: 1.6 },
          sizing: 'auto-height',
          explicitWidth: 240,
          runs: [
            { text: '红色', color: '#E11D48', fontSize: 32, fontWeight: 'bold' },
            { text: '斜体', fontStyle: 'italic', textDecoration: 'underline' }
          ]
        }
      ]
    });
    const result = parseCanvasDocument(JSON.parse(JSON.stringify(docWith([node]))));
    expect(result.ok && result.value.content.nodes.t.textBlocks).toEqual(node.textBlocks);
  });

  it('字段类型不对或内联媒体时整体拒绝，并给出出错位置', () => {
    const badNumber = JSON.parse(JSON.stringify(docWith([makeNode('a')])));
    badNumber.content.nodes.a.width = 'wide';
    expect(parseCanvasDocument(badNumber)).toEqual({ ok: false, error: 'content.nodes.a.width：应为有效数字' });

    const inline = docWith([makeNode('a', { data: { src: 'data:image/png;base64,AAAA' } })]);
    expect(parseCanvasDocument(inline).ok).toBe(false);

    const mismatched = JSON.parse(JSON.stringify(docWith([makeNode('a')])));
    mismatched.content.nodes.b = mismatched.content.nodes.a;
    expect(parseCanvasDocument(mismatched).ok).toBe(false);
  });

  it('父容器缺失的节点回落到根层级，而不是拒绝整份文档', () => {
    const result = parseCanvasDocument(docWith([makeNode('child', { parentId: 'missing' })]));
    expect(result.ok && result.value.content.nodes.child.parentId).toBeUndefined();
  });

  it('带透明度的填充色与描边色拆成不透明色值与单独的透明度；主题色引用原样保留', () => {
    const result = parseCanvasDocument(
      docWith([
        makeNode('a', { style: { fill: 'rgba(255, 0, 0, 0.5)' } }),
        makeNode('b', { style: { fill: '#00FF0080', fillOpacity: 0.5 } }),
        makeNode('c', { style: { fill: 'rgb(0 0 255 / 25%)' } }),
        makeNode('d', { style: { fill: '$red', stroke: 'rgba(0, 0, 0, 0.5)' } })
      ])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { nodes } = result.value.content;
    expect(nodes.a.style).toEqual({ fill: '#FF0000', fillOpacity: 0.5 });
    expect(nodes.b.style!.fill).toBe('#00FF00');
    expect(nodes.b.style!.fillOpacity).toBeCloseTo(0.25, 2);
    expect(nodes.c.style).toEqual({ fill: '#0000FF', fillOpacity: 0.25 });
    expect(nodes.d.style).toEqual({ fill: '$red', stroke: '#000000', strokeOpacity: 0.5 });
  });

  it('端点所连节点不存在的连线被丢弃，其余连线保留', () => {
    const connector = (id: string, to: ConnectorEntity['to']): ConnectorEntity => ({
      id,
      type: 'connector',
      connectorType: 'orthogonal',
      from: { nodeId: 'a' },
      to,
      zIndex: 'a0',
      locked: false
    });
    const result = parseCanvasDocument(
      docWith(
        [makeNode('a')],
        [connector('dangling', { nodeId: 'missing' }), connector('free', { position: { x: 300, y: 0 } })]
      )
    );
    expect(result.ok && Object.keys(result.value.content.connectors)).toEqual(['free']);
  });

  it('剪贴板：不是画布节点数据或 JSON 不合法时失败', () => {
    expect(parseNodeClipboard('not json').ok).toBe(false);
    expect(parseNodeClipboard(JSON.stringify({ kind: 'other' })).ok).toBe(false);
    const payload = { kind: NODE_CLIPBOARD_KIND, version: 1, nodes: [makeNode('a')], connectors: [], assets: {} };
    expect(parseNodeClipboard(JSON.stringify(payload))).toMatchObject({ ok: true });
  });
});

describe('复制、粘贴与替换内容', () => {
  it('复制旋转容器中的节点：剪贴板里换算为根层级世界位姿；粘贴换新 id、按偏移放到根层级，外观不变', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { x: 100, y: 100, width: 200, height: 200, rotation: 90 }));
    store.addNode(makeNode('card', { x: 10, y: 10, width: 40, height: 20, parentId: 'frame' }));
    store.addNode(makeNode('leaf', { x: 5, y: 5, width: 10, height: 10, parentId: 'card' }));
    const before = engine.getNodeWorldBounds('card')!;

    const payload = store.copyEntities({ nodeIds: ['card'] })!;
    expect(payload.nodes.map((n) => n.id)).toEqual(['card', 'leaf']);
    expect(payload.nodes[0].parentId).toBeUndefined();
    expect(payload.nodes[0].rotation).toBeCloseTo(90);

    // 经过一次序列化 (剪贴板) 再粘贴
    const parsed = parseNodeClipboard(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [pastedId] = store.pasteEntities(parsed.value, { x: 30, y: 0 }).nodeIds;
    expect(pastedId).not.toBe('card');
    expect(store.getNode(pastedId)!.parentId).toBeUndefined();
    const after = engine.getNodeWorldBounds(pastedId)!;
    expect(after.left).toBeCloseTo(before.left + 30);
    expect(after.top).toBeCloseTo(before.top);
    expect([...engine.entityStore.getChildIds(pastedId)]).toHaveLength(1);

    store.undo();
    expect(store.getNode(pastedId)).toBeUndefined();
  });

  it('粘贴到指定容器：最顶层节点换算为容器局部位姿，世界外观不变', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { x: 100, y: 100, width: 200, height: 200, rotation: 90 }));
    store.addNode(makeNode('card', { x: 400, y: 50, width: 40, height: 20 }));
    const before = engine.getNodeWorldBounds('card')!;

    const payload = store.copyEntities({ nodeIds: ['card'] })!;
    const [pastedId] = store.pasteEntities(payload, { x: 0, y: 0 }, { parentId: 'frame' }).nodeIds;
    expect(store.getNode(pastedId)!.parentId).toBe('frame');
    expect(store.getNode(pastedId)!.rotation).toBeCloseTo(-90);
    expect(engine.getNodeWorldBounds(pastedId)).toMatchObject({
      left: expect.closeTo(before.left),
      top: expect.closeTo(before.top),
      right: expect.closeTo(before.right)
    });
  });

  it('replaceContent 整体替换内容，默认可撤销', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('old'));
    store.replaceContent(docWith([makeNode('new')]).content);
    expect(store.getNode('old')).toBeUndefined();
    expect(store.getNode('new')).toBeDefined();
    expect(engine.hitTestNode({ x: 10, y: 10 })?.id).toBe('new');

    store.undo();
    expect(store.getNode('old')).toBeDefined();
    expect(store.getNode('new')).toBeUndefined();
  });

  it('开放字段中的 undefined 属性被自动忽略 (与 JSON 序列化规范一致)，不阻断反序列化', () => {
    const raw = docWith([
      makeNode('a', {
        style: { fill: '$blue', fillOpacity: undefined },
        data: { active: true, extra: undefined }
      })
    ]);
    const result = parseCanvasDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.value.content.nodes.a;
    expect(node.style).toEqual({ fill: '$blue' });
    expect(node.data).toEqual({ active: true });
  });

  it('顶层自定义扩展字段经安全纯数据清洗后完整保留，且丢弃危险原型键', () => {
    const raw = docWith([makeNode('a')]);
    const rawNode = raw.content.nodes.a as unknown as Record<string, unknown>;
    rawNode.geometry = 'diamond';
    rawNode.bizStatus = 'in_progress';
    rawNode.extraScore = 98;
    rawNode.__proto__ = { attack: true };

    const result = parseCanvasDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.value.content.nodes.a as unknown as Record<string, unknown>;
    expect(node.geometry).toBe('diamond');
    expect(node.bizStatus).toBe('in_progress');
    expect(node.extraScore).toBe(98);
    expect(({} as Record<string, unknown>).attack).toBeUndefined();
  });
});
