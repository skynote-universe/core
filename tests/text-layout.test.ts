/**
 * @file text-layout.test.ts
 * @description 文本驱动的自动尺寸：事务内派生、撤销一并回退、策略与插槽解析、远端不派生、容错
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { createTextBlockPrimitive } from '../src/layout/text-layout';
import { createSimpleTextBlock } from '../src/types/text';
import type { NodeEntity } from '../src/types/node';
import type { NodeTextStyle } from '../src/types/text';
import type { FontMeasurer } from '../src/protocols/font-measurer.protocol';
import type { NodeTypeDefinition } from '../src/protocols/node-type.protocol';

/** 确定性替身字体测量器：每字符宽 10 (行高由排版按字号 × 1.5 缺省计算) */
function createFakeMeasurer(): FontMeasurer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    measureWidth(text) {
      calls.push(text);
      return text.length * 10;
    }
  };
}

const STICKY: NodeTypeDefinition = {
  type: 'sticky',
  label: '便签',
  defaultData: {},
  sizingPolicy: 'height-driven',
  slots: [{ slot: 'body', sizing: 'auto-height', defaultStyle: { fontSize: 20, padding: 10 } }]
};

const LABEL: NodeTypeDefinition = {
  type: 'label',
  label: '标签',
  defaultData: {},
  sizingPolicy: 'content-driven'
};

function makeNode(id: string, nodeType: string, text: string, width = 100): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType,
    x: 0,
    y: 0,
    width,
    height: 10,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    textBlocks: [createSimpleTextBlock(`${id}_t`, text, { slot: 'body' })]
  };
}

function createEngine(measurer = createFakeMeasurer()): SkyNoteEngine {
  const engine = new SkyNoteEngine({ fonts: measurer });
  engine.nodeTypes.register(STICKY);
  engine.nodeTypes.register(LABEL);
  return engine;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('文本驱动的自动尺寸', () => {
  it('height-driven：新增节点时按插槽样式与 padding 撑高，宽度不变', () => {
    const engine = createEngine();
    // 可用宽度 100 - 2×10 = 80 → 每行 8 字；20 字折 3 行 × 行高 30 = 90，再加上下 padding 20
    engine.documentStore.addNode(makeNode('s', 'sticky', 'a'.repeat(20)));
    const node = engine.documentStore.getView().content.nodes.s;
    expect(node.width).toBe(100);
    expect(node.height).toBe(110);
  });

  it('单独写入高度 (如缩放控制柄) 同样在同一事务内按内容纠正，不会停在写入值上', () => {
    const engine = createEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('s', 'sticky', 'a'.repeat(20)));
    expect(store.getNode('s')?.height).toBe(110);

    store.updateNode('s', { height: 300 });
    expect(store.getNode('s')?.height).toBe(110);
    store.transformNodes([{ id: 's', frame: { cx: 50, cy: 100, width: 100, height: 200, rotation: 0 } }]);
    expect(store.getNode('s')).toMatchObject({ width: 100, height: 110 });
  });

  it('修改文本在同一事务内派生新高度，撤销一次即同时还原文本与尺寸', () => {
    const engine = createEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('s', 'sticky', 'short'));
    expect(store.getNode('s')?.height).toBe(50);

    store.commit({
      label: '编辑文本',
      patches: [
        {
          op: 'text',
          path: ['content', 'nodes', 's', 'textBlocks', 0, 'runs', 0, 'text'],
          deltas: [{ retain: 5 }, { insert: 'x'.repeat(20) }]
        }
      ]
    });
    // 25 字 → 每行 8 字折 4 行 × 30 + padding 20
    expect(store.getNode('s')?.height).toBe(140);
    expect(store.undoEntries).toHaveLength(2);

    store.undo();
    expect(store.getNode('s')?.textBlocks?.[0].runs[0].text).toBe('short');
    expect(store.getNode('s')?.height).toBe(50);
    // 空间索引随派生尺寸同步更新
    const bounds = engine.spatialIndex.getBounds('s')!;
    expect(bounds.bottom - bounds.top).toBe(50);
  });

  it('调整宽度会重新折行并派生高度', () => {
    const engine = createEngine();
    engine.documentStore.addNode(makeNode('s', 'sticky', 'a'.repeat(20)));
    engine.documentStore.updateNode('s', { width: 220 });
    // 可用宽度 200 → 单行 20 字，高度 30 + 20
    expect(engine.documentStore.getNode('s')?.height).toBe(50);
  });

  it('content-driven：宽高双向随内容，不折行', () => {
    const engine = createEngine();
    engine.documentStore.addNode(makeNode('l', 'label', 'hello world'));
    const node = engine.documentStore.getView().content.nodes.l;
    // 缺省字号 14 × 行高 1.5
    expect(node.width).toBe(110);
    expect(node.height).toBe(21);
  });

  it('只影响几何或样式的修改不触发测量；fixed 类型与未注册类型不派生尺寸', () => {
    const measurer = createFakeMeasurer();
    const engine = createEngine(measurer);
    engine.documentStore.addNode(makeNode('s', 'sticky', 'hello'));
    engine.documentStore.addNode(makeNode('r', 'rect', 'hello'));
    const callsAfterAdd = measurer.calls.length;

    engine.documentStore.moveEntities({ nodeIds: ['s'] }, { x: 50 });
    engine.documentStore.updateNode('s', { style: { fill: '#FFF7AE' } });
    expect(measurer.calls.length).toBe(callsAfterAdd);
    expect(engine.documentStore.getNode('r')?.height).toBe(10);
  });

  it('远端事务不派生尺寸，以发送方结果为准', () => {
    const engine = createEngine();
    engine.documentStore.commit({
      origin: 'remote',
      patches: [{ op: 'set', path: ['content', 'nodes', 's'], value: makeNode('s', 'sticky', 'a'.repeat(20)) }]
    });
    expect(engine.documentStore.getNode('s')?.height).toBe(10);
  });

  it('computeBounds 优先于默认策略，收到按插槽索引的内容盒度量', () => {
    const engine = createEngine();
    const computeBounds = vi.fn((_node: NodeEntity, metrics: Map<string, { width: number; height: number }>) => ({
      width: 300,
      height: metrics.get('body')!.height + 100
    }));
    engine.nodeTypes.register({ ...STICKY, type: 'card', computeBounds });
    engine.documentStore.addNode(makeNode('c', 'card', 'hi'));

    expect(computeBounds).toHaveBeenCalled();
    expect(engine.documentStore.getNode('c')).toMatchObject({ width: 300, height: 130 });
  });

  it('单个节点测量抛错时保持原尺寸，不阻断文本修改', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = new SkyNoteEngine({
      fonts: {
        measureWidth: () => {
          throw new Error('字体尚未就绪');
        }
      }
    });
    engine.nodeTypes.register(STICKY);
    expect(engine.documentStore.addNode(makeNode('s', 'sticky', 'hello'))).not.toBeNull();
    expect(engine.documentStore.getNode('s')?.height).toBe(10);
  });

  it('relayoutText 在测量基准变化后以非撤销系统事务重算尺寸', () => {
    const engine = new SkyNoteEngine();
    engine.nodeTypes.register(STICKY);
    engine.documentStore.addNode(makeNode('s', 'sticky', 'a'.repeat(20)));
    expect(engine.documentStore.getNode('s')?.height).toBe(10);

    engine.documentStore.setFontMeasurer(createFakeMeasurer());
    const undoDepth = engine.documentStore.undoEntries.length;
    engine.documentStore.relayoutText();
    expect(engine.documentStore.getNode('s')?.height).toBe(110);
    expect(engine.documentStore.undoEntries).toHaveLength(undoDepth);
  });

  it('createTextBlockPrimitive 是文本块到图元的唯一映射：保留富文本分段并携带块级样式 (内边距不进入图元)', () => {
    const block = { id: 't1', runs: [{ text: 'Sky' }, { text: 'Note' }] };
    const primitive = createTextBlockPrimitive(
      block,
      { fontSize: 18, color: '$ink', textAlign: 'center' },
      { x: 4, y: 6, width: 120 }
    );
    expect(primitive).toMatchObject({
      kind: 'text',
      id: 't1',
      x: 4,
      y: 6,
      width: 120,
      runs: [{ text: 'Sky' }, { text: 'Note' }],
      style: { fontSize: 18, color: '$ink', textAlign: 'center' }
    });
  });

  it('lineHeight 类型约束：数字为字号倍数，像素须写成带 px 后缀的字符串', () => {
    const styles: NodeTextStyle[] = [{ lineHeight: 1.5 }, { lineHeight: '24px' }];
    // @ts-expect-error 仅支持 px 单位字符串
    const invalid: NodeTextStyle = { lineHeight: '1.5em' };
    expect([...styles, invalid]).toHaveLength(3);
  });
});
