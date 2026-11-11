# @skynote/core

> The platform-neutral kernel of [SkyNote](https://github.com/skynote-universe), an open-source infinite-canvas whiteboard engine: a plain-data document model, transactional edits with undo/redo and patch streams, a plugin protocol, spatial indexing, connector routing, rich-text layout and theming. No DOM and no renderer dependency, so it runs in browsers, workers and Node. MIT licensed.

SkyNote 无限画布白板引擎的平台中立内核。不依赖 DOM 与任何渲染库，可运行在浏览器、Worker 与 Node 中。

大多数应用直接使用 [@skynote/editor](https://docs.skynote.top/api/editor) 即可；自研编辑器外壳、编写插件或在服务端处理文档时才需要直接依赖内核。

[快速开始](https://docs.skynote.top/guide/getting-started) · [API 参考](https://docs.skynote.top/api/core) · [演练场](https://playground.skynote.top/)

## 特性

- **纯数据文档**：节点、连线与画框容器组成可直接 JSON 序列化的文档，层级用分数索引，适合协同。
- **事务与撤销**：所有修改经事务提交为补丁，自动生成撤销记录，连续调整可合并为一步；补丁流可直接用于增量保存与协同同步。
- **插件协议**：节点类型、连线路由器、箭头、光标、键盘作用域 (焦点栈)、指针钩子与剪贴板处理都经插件上下文注册，卸载时自动释放；插件之间互不感知。
- **声明式图元**：节点用 `compose()` 返回与渲染器无关的图元 (矩形、多边形、路径、文字等)，渲染后端可替换。
- **空间检索与拾取**：视口裁剪、旋转精判、容器裁剪与层叠顺序。
- **连线**：直线、正交折线、曲线路由，端点吸附节点锚点；路由器可替换。
- **富文本排版**：排版在内核完成，测量与绘制共用同一份结果。
- **主题**：语义色由少量种子色推导，亮色 / 暗色切换即重绘。
- **安全的外部数据**：导入、粘贴与协同数据经白名单 Schema 校验，拒绝原型链污染与内联 Base64 媒体。

## 安装

首个公开版本为 `0.1.0-beta.1`。通过 npm 的 `beta` 标签安装。

```bash
npm install @skynote/core@beta
```

## 快速上手

要运行以下示例，请同时安装基础插件，用于注册形状节点。

```bash
npm install @skynote/core@beta @skynote/plugins-basic@beta
```

```ts
import { SkyNoteEngine, parseCanvasDocument } from '@skynote/core';
import { BasicNodesPlugin } from '@skynote/plugins-basic';

const engine = new SkyNoteEngine().use(new BasicNodesPlugin());
const store = engine.documentStore;

// 每次提交 (含撤销重做) 的正向补丁：可追加到本地日志，或发给协同服务
store.subscribe((_view, record) => console.log(record.label, record.patches.length));

const id = store.createNode({ nodeType: 'shape', x: 0, y: 0, options: { geometry: 'ellipse' } })!;
store.updateNodes([id], { style: { fill: '$blue' } }, { label: '改色', merge: true });
store.undo();

const text = JSON.stringify(store.getView());
// 读回 JSON 时，先校验文档结构再使用
const parsed = parseCanvasDocument(JSON.parse(text));
if (!parsed.ok) console.error(parsed.error);
```

## 编写插件

插件只通过上下文与内核交互。下面注册一个自定义节点类型：

```ts
import type { NodeTypeDefinition, SkyNotePlugin } from '@skynote/core';

// 让 insertNodeAt 等接口认识新节点类型 (无创建参数)
declare module '@skynote/core' {
  interface NodeCreateOptionsMap {
    'demo:badge': Record<string, never>;
  }
}

const badge: NodeTypeDefinition = {
  type: 'demo:badge',
  label: '徽章',
  defaultData: {},
  // 新建时的默认尺寸与内容
  createContent: () => ({ width: 120, height: 40 }),
  // 返回与渲染器无关的图元；颜色取主题，切换主题自动重绘
  compose: (node, { theme }) => [
    {
      kind: 'rect',
      x: 0,
      y: 0,
      width: node.width,
      height: node.height,
      radius: 8,
      fill: theme.nodeFill,
      stroke: theme.nodeStroke,
      strokeWidth: 1
    }
  ]
};

export const badgePlugin: SkyNotePlugin = {
  id: 'demo/badge',
  name: 'Badge',
  version: '0.1.0',
  install(ctx) {
    ctx.registerNodeType(badge);
  }
};
```

装入编辑器：`new SkyNoteEditor({ renderer, plugins: [badgePlugin] })`，之后即可 `editor.insertNodeAtViewportCenter({ nodeType: 'demo:badge' })`。

插件上下文 (`CanvasPluginContext`) 还提供：

| 能力 | 用途 |
| --- | --- |
| `document` | 查询与语义命令 (新建、移动、删除、改挂、层级、批处理)，全部经事务提交 |
| `entities`、`spatial`、`hitTest*` | 世界矩阵与父子关系、空间检索、拾取 |
| `session` | 视口、选区与主题 (本地状态，不进文档与撤销栈) |
| `host` | 宿主能力：覆盖层、光标、指针捕获 |
| `registerConnectorRouter`、`registerArrowMarker`、`registerCursor` | 新增或覆盖连线路由、箭头与光标 |
| `registerInputScope` | 注册键盘作用域 (焦点栈，优先级高者先处理) |
| `registerPointerHooks` | 指针与滚轮钩子；认领指针后低优先级的拖拽与框选自动让路 |
| `registerClipboardHandler` | 剪贴板处理者 |

约定：插件不直接修改实体对象，一律经 `document` 提交；不在 `window` 上监听键盘；不在图元里写死颜色。

## 子路径入口

除根入口外，也可按需从 `@skynote/core/protocols`、`/utils`、`/operation`、`/state`、`/registry`、`/spatial`、`/input`、`/plugin` 导入。

## 相关包

| 包 | 说明 |
| --- | --- |
| **@skynote/core** | 平台中立内核 (本包) |
| [@skynote/renderer-leafer](https://docs.skynote.top/api/renderer-leafer) | 基于 LeaferJS 的渲染器 |
| [@skynote/plugins-basic](https://docs.skynote.top/api/plugins-basic) | 基础节点与交互插件 |
| [@skynote/editor](https://docs.skynote.top/api/editor) | 开箱即用的编辑器 |
| [SkyNote Web](https://canvas.skynote.top/) | 官方示例应用 (Vue 3) |

## 许可证

[MIT](./LICENSE)
