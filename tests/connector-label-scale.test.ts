/** 连线标注的缩放必须保持排版约束，不能只检查字号字段。 */
import { describe, expect, it } from 'vitest';
import {
  displayedConnectorLabel,
  layoutConnectorLabels,
  scaleConnectorTextBlocks
} from '../src/layout/connector-label';
import type { ConnectorTextBlock } from '../src/types/connector';

const fonts = { measureWidth: (text: string, font: { size: number }) => text.length * font.size * 0.6 };
const points = [
  { x: 0, y: 0 },
  { x: 1000, y: 0 }
];

describe('连线标注排版约束缩放', () => {
  it.each([20, 60])('%i 字标注缩放前后保持行数，往返恢复默认宽度继承', (length) => {
    const blocks: ConnectorTextBlock[] = [
      { id: 'label', slot: 'label', position: 0.5, runs: [{ text: '标'.repeat(length) }] }
    ];
    const before = layoutConnectorLabels(blocks, points, fonts)[0];
    const scaled = scaleConnectorTextBlocks(blocks, 2);
    const after = layoutConnectorLabels(scaled, points, fonts)[0];
    expect(after.bounds.bottom - after.bounds.top - 8).toBeCloseTo((before.bounds.bottom - before.bounds.top - 8) * 2);
    expect(after.bounds.right - after.bounds.left - 8).toBeCloseTo((before.bounds.right - before.bounds.left - 8) * 2);
    expect(after.primitive.width).toBe(length === 20 ? undefined : 480);
    expect(scaled[0].explicitWidth).toBe(480);
    const restored = scaleConnectorTextBlocks(blocks, 1);
    expect(restored).toEqual(blocks);
    expect(Object.hasOwn(restored[0], 'explicitWidth')).toBe(false);
  });

  it('显式宽度用于图元、编辑测量与底色范围', () => {
    const blocks: ConnectorTextBlock[] = [
      { id: 'label', position: 0.5, explicitWidth: 84, runs: [{ text: '标'.repeat(20) }] }
    ];
    const before = layoutConnectorLabels(blocks, points, fonts)[0];
    const after = layoutConnectorLabels(scaleConnectorTextBlocks(blocks, 2), points, fonts)[0];
    expect(before.primitive.width).toBe(84);
    expect(after.primitive.width).toBe(168);
    expect(displayedConnectorLabel(after, null, fonts)).toEqual(after);
    expect(after.bounds.bottom - after.bounds.top - 8).toBeCloseTo((before.bounds.bottom - before.bounds.top - 8) * 2);
  });
});
