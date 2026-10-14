/**
 * @file renderer.protocol.ts
 * @description 渲染适配器契约：让编辑器与具体渲染引擎 (Leafer、WebGPU、小程序画布等) 解耦
 *
 * 设计考量 (Why):
 * 1. 渲染器与字体测量器成对提供：排版在内核完成，测量与绘制必须用同一字体与同一画布 (ADR-105/122)，由同一个适配器给出，
 *    使用方无法配出「用 A 引擎测量、用 B 引擎绘制」的错位组合。
 * 2. 视口、选区和主题仍归会话；可选图片加载能力只暴露瞬态结果与重试，不进入文档或事务历史。
 * 3. 容器类型由适配器决定 (浏览器为 HTMLElement，小程序为画布节点)，内核不感知 DOM。
 */

import type { FontMeasurer } from './font-measurer.protocol';
import type { SkyNoteEngine } from '../engine';

export type ImageLoadFailure = 'missing-asset' | 'unavailable' | 'load-failed' | 'decode-failed';

export type ImageLoadState =
  { readonly status: 'loading' | 'ready' } | { readonly status: 'failed'; readonly reason: ImageLoadFailure };

/** 仅覆盖渲染器当前持有的图片视图；未渲染或不支持此能力时没有状态。 */
export interface ImageLoadingController {
  getState(nodeId: string): ImageLoadState | undefined;
  /** 只重试失败视图，返回实际开始重试的节点；重复点击不抢占已在加载的请求。 */
  retry(nodeIds: readonly string[]): readonly string[];
  /** 通知已经发生的状态变化；返回注销函数。 */
  subscribe(listener: () => void): () => void;
}

/** 已挂载的渲染器实例 */
export interface CanvasRenderer {
  readonly images?: ImageLoadingController;
  /** 解除与容器和引擎的全部关联并释放图元 */
  destroy(): void;
}

/** 渲染适配器：把某个渲染引擎接入编辑器 */
export interface RenderAdapter<TContainer = unknown> {
  /** 与该适配器绘制文字一致的字体测量器 (创建引擎时注入) */
  readonly fonts: FontMeasurer;
  /** 把引擎挂到宿主容器并开始渲染 */
  mount(engine: SkyNoteEngine, container: TContainer): CanvasRenderer;
}
