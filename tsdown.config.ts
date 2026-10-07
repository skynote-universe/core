import { defineConfig } from 'tsdown';

// 发布产物：每个子路径入口各出一份 ESM 与类型声明；仓库内开发仍直连 src (发布时由 publishConfig 换成 dist)
export const config = defineConfig({
  entry: {
    index: 'src/index.ts',
    protocols: 'src/protocols/index.ts',
    utils: 'src/utils/index.ts',
    operation: 'src/operation/index.ts',
    state: 'src/state/index.ts',
    registry: 'src/registry/index.ts',
    spatial: 'src/spatial/index.ts',
    input: 'src/input/index.ts',
    plugin: 'src/plugin/index.ts'
  },
  format: 'esm',
  platform: 'neutral',
  // 不随包发布 src，映射文件指不到源码，不生成
  sourcemap: false,
  dts: { sourcemap: false },
  clean: true
});

export default config;
