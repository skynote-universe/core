/**
 * @file rotation.test.ts
 * @description 旋转约定：绕节点中心旋转，x/y/width/height 描述未旋转的框
 */

import type { RotatableBox } from '../src/types/geometry';
import { describe, it, expect } from 'vitest';
import { applyMatrix, computeNodeLocalMatrix, computeNodeWorldBounds } from '../src/utils/geometry';
import { resolveConnectorEndpoint } from '../src/routing/connector-route';
import { SkyNoteEngine } from '../src/engine';
import type { NodeEntity } from '../src/types/node';

const box = { x: 100, y: 100, width: 200, height: 100 };

/** 根层级节点的世界矩阵即其局部矩阵 */
const computeNodeBounds = (node: RotatableBox) => computeNodeWorldBounds(node, computeNodeLocalMatrix(node));

describe('绕中心旋转的几何', () => {
  it('旋转 90° 后外接矩形绕中心 (200, 150) 转置', () => {
    const bounds = computeNodeBounds({ ...box, rotation: 90 });
    expect(bounds.left).toBeCloseTo(150);
    expect(bounds.top).toBeCloseTo(50);
    expect(bounds.right - bounds.left).toBeCloseTo(100);
    expect(bounds.bottom - bounds.top).toBeCloseTo(200);
  });

  it('旋转 45° 的外接矩形覆盖四角，未旋转时与原框一致', () => {
    const bounds = computeNodeBounds({ ...box, rotation: 45 });
    const half = (200 + 100) / Math.SQRT2 / 2;
    expect(bounds.left).toBeCloseTo(200 - half);
    expect(bounds.right).toBeCloseTo(200 + half);
    expect(computeNodeBounds(box)).toEqual({ left: 100, top: 100, right: 300, bottom: 200 });
  });

  it('点选精判：外接矩形的空角不算命中，旋转后的框内算命中', () => {
    const rotated = { ...box, rotation: 45 };
    const bounds = computeNodeBounds(rotated);
    const matrix = computeNodeLocalMatrix(rotated);
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode({
      id: 'n',
      type: 'node',
      nodeType: 'rect',
      ...rotated,
      zIndex: 'a0',
      locked: false
    });
    expect(engine.hitTestNode({ x: bounds.left + 2, y: bounds.top + 2 })).toBeUndefined();
    expect(engine.hitTestNode({ x: 200, y: 150 })?.id).toBe('n');
    expect(engine.hitTestNode(applyMatrix(matrix, 190, 50))?.id).toBe('n');
    engine.destroy();
  });

  it('连线锚点随节点绕中心旋转，中心锚点不受影响', () => {
    const node = {
      id: 'n',
      type: 'node',
      nodeType: 'rect',
      ...box,
      rotation: 90,
      zIndex: 'a0',
      locked: false,
      anchors: [{ id: 'right', x: 1, y: 0.5 }]
    } as NodeEntity;

    const resolved = { node, worldMatrix: computeNodeLocalMatrix(node) };
    const right = resolveConnectorEndpoint({ nodeId: 'n', anchorId: 'right' }, resolved)!;
    expect(right.x).toBeCloseTo(200);
    expect(right.y).toBeCloseTo(250);
    const center = resolveConnectorEndpoint({ nodeId: 'n' }, resolved)!;
    expect(center.x).toBeCloseTo(200);
    expect(center.y).toBeCloseTo(150);
  });

  it('引擎空间索引使用旋转后的外接矩形，旋转属于几何变更', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode({
      id: 'n',
      type: 'node',
      nodeType: 'rect',
      ...box,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    });
    engine.documentStore.updateNode('n', { rotation: 90 });
    const bounds = engine.spatialIndex.getBounds('n')!;
    expect(bounds.top).toBeCloseTo(50);
    expect(bounds.bottom - bounds.top).toBeCloseTo(200);
  });
});
