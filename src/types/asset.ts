/**
 * @file asset.ts
 * @description 外部多媒体资产规范
 *
 * 设计考量 (Why):
 * 零 Base64 红线：文档树内严禁内嵌图片等 Base64 数据，统一通过轻量 assetId 引用。
 * 防止撤销重做深拷贝与网络协同发生内存暴涨。
 */

/** 外部多媒体资产元数据 */
export interface CanvasAssetMeta {
  id: string;
  /** 适配器引用；不一定是网络 URL，且不得是 data:/blob: 临时地址 */
  src: string;
  name?: string;
  mimeType: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  sha256?: string;
}
