/**
 * @file index.ts
 * @description @skynote/core 纯内存内核、标准协议与纯函数工具集
 * 
 * 遵守 AGENTS.md 四大红线：
 * 1. 平台中立：全文 0 DOM / 0 Canvas / 0 Leafer 原生依赖；
 * 2. 状态流转：所有变更收敛至 commitOperation() 事务；
 * 3. 极简依赖：零 Lodash 等大型外部库引入。
 */

export * from './types';
export * from './protocols';
export * from './utils';
export * from './operation';
export * from './state';
export * from './registry';
export * from './spatial';
export * from './input';
export * from './plugin';
export * from './routing/connector-route';
export * from './layout/text-layout';
export * from './layout/layer-order';
export * from './engine';


