/**
 * @file connector-router-registry.ts
 * @description 连线寻路算法注册表 (ConnectorRouterRegistry)
 *
 * 设计考量 (Why):
 * 1. 策略模式解耦：将各种寻路算法（直线、正交、贝塞尔、思维导图曲线）收敛为统一注册表，
 *    渲染器和连线交互仅需 routerRegistry.get(type).route(input) 即可，无任何硬编码 if/else。
 * 2. 默认开箱即用：内置 'straight'、'orthogonal'、'curved' 三大高频算法，无需外部插件也能即刻运行。
 * 3. 严格纯函数：内置算法为纯函数，无依赖、无副作用。
 */

import type { Point } from '../types/geometry';
import type { ConnectorStyle } from '../types/connector';
import {
  ConnectorRouter,
  type ConnectorRouterDefinition,
  type ConnectorRouterInput,
  type ConnectorRouterResult,
  type FloatingEndpointMode
} from '../protocols/connector-router.protocol';
import { buildRoundedPolylinePath } from '../utils/geometry';
import { routeOrthogonal, routeOrthogonalThrough } from '../routing/orthogonal-route';

/** 起点、手动拐点、终点依次连成的折线 (拐点处按样式倒圆角) */
function routeThroughControlPoints(
  input: ConnectorRouterInput,
  controlPoints: readonly Point[]
): ConnectorRouterResult {
  const points: Point[] = [{ ...input.start.point }, ...controlPoints.map((p) => ({ ...p })), { ...input.end.point }];
  return { points, pathData: buildRoundedPolylinePath(points, input.style.cornerRadius ?? 0) };
}

/** 直线：浮动端取中心连线与轮廓的交点，线看起来从图形中心射出 */
export class StraightRouter extends ConnectorRouter {
  readonly id = 'straight';
  readonly label = '直线';
  readonly floating: FloatingEndpointMode = 'boundary';

  route(input: ConnectorRouterInput): ConnectorRouterResult {
    if (input.controlPoints?.length) return routeThroughControlPoints(input, input.controlPoints);
    const { start, end } = input;
    return {
      points: [{ ...start.point }, { ...end.point }],
      pathData: `M ${start.point.x} ${start.point.y} L ${end.point.x} ${end.point.y}`
    };
  }
}

/** 曲线每段三次曲线的采样数：路由点中第 i 段占 [i×N, (i+1)×N]，编辑手柄据此找到每段的中点 */
export const CURVE_SEGMENT_SAMPLES = 24;

/** 曲线：三次贝塞尔，两端沿出线方向切出，控制柄长度随两端距离伸缩 */
export class CurvedRouter extends ConnectorRouter {
  readonly id = 'curved';
  readonly label = '曲线';
  readonly floating: FloatingEndpointMode = 'side';

  constructor(private readonly curviness = 0.4) {
    super();
  }

  route(input: ConnectorRouterInput): ConnectorRouterResult {
    const { start, end } = input;
    const dx = end.point.x - start.point.x;
    const dy = end.point.y - start.point.y;
    // 自由端没有出线方向：沿两端连线的主轴切出 (起点朝向终点，终点背向起点)
    const along = Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
    const startDir = start.direction ?? along;
    const endDir = end.direction ?? { x: -along.x, y: -along.y };
    const through = input.controlPoints ?? [];
    if (through.length === 0) {
      const offset = Math.max(Math.hypot(dx, dy) * this.curviness, 20);
      return cubicBezierRoute([
        [start.point, offsetPoint(start.point, startDir, offset), offsetPoint(end.point, endDir, offset), end.point]
      ]);
    }
    // 依次经过手动点：每两点之间一段三次曲线；中间点的切线取前后两点连线方向 (Catmull-Rom)，曲线在手动点处平滑相接；
    // 两端沿出线方向切出。控制柄长度与该段长度成正比
    const stops = [start.point, ...through, end.point];
    const tangentAt = (i: number): Point => {
      if (i === 0) return startDir;
      if (i === stops.length - 1) return { x: -endDir.x, y: -endDir.y };
      const tx = stops[i + 1].x - stops[i - 1].x;
      const ty = stops[i + 1].y - stops[i - 1].y;
      const length = Math.hypot(tx, ty) || 1;
      return { x: tx / length, y: ty / length };
    };
    const segments: [Point, Point, Point, Point][] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const handle = Math.hypot(b.x - a.x, b.y - a.y) * this.curviness;
      segments.push([a, offsetPoint(a, tangentAt(i), handle), offsetPoint(b, tangentAt(i + 1), -handle), b]);
    }
    return cubicBezierRoute(segments);
  }
}

function offsetPoint(p: Point, dir: Point, distance: number): Point {
  return { x: p.x + dir.x * distance, y: p.y + dir.y * distance };
}

/** 三次曲线段 → 路径指令与采样点 (拾取、包围盒与箭头朝向按真实曲线计算)；插件自定义的曲线路由器同样可用 */
export function cubicBezierRoute(segments: readonly (readonly [Point, Point, Point, Point])[]): ConnectorRouterResult {
  const [p0] = segments[0];
  const points: Point[] = [{ x: p0.x, y: p0.y }];
  let pathData = `M ${p0.x} ${p0.y}`;
  for (const [a, b, c, d] of segments) {
    pathData += ` C ${b.x} ${b.y}, ${c.x} ${c.y}, ${d.x} ${d.y}`;
    for (let i = 1; i <= CURVE_SEGMENT_SAMPLES; i++) {
      const t = i / CURVE_SEGMENT_SAMPLES;
      const k0 = (1 - t) ** 3;
      const k1 = 3 * (1 - t) ** 2 * t;
      const k2 = 3 * (1 - t) * t * t;
      const k3 = t ** 3;
      points.push({ x: k0 * a.x + k1 * b.x + k2 * c.x + k3 * d.x, y: k0 * a.y + k1 * b.y + k2 * c.y + k3 * d.y });
    }
  }
  return { points, pathData };
}

/** 正交折线 (默认线型)：垂直离开边框、绕开两端节点，拐点默认圆角 */
export class OrthogonalRouter extends ConnectorRouter {
  readonly id = 'orthogonal';
  readonly label = '折线';
  readonly floating: FloatingEndpointMode = 'side';
  readonly defaultStyle: ConnectorStyle = { cornerRadius: 8, padding: 20 };

  route(input: ConnectorRouterInput): ConnectorRouterResult {
    const points = input.controlPoints?.length
      ? routeOrthogonalThrough(input.start, input.end, input.controlPoints)
      : routeOrthogonal(input.start, input.end, input.style.padding ?? 20);
    return { points, pathData: buildRoundedPolylinePath(points, input.style.cornerRadius ?? 0) };
  }
}

/** 路由器注册表变更回调：参数为发生变化的路由器 id */
export type ConnectorRouterChangeListener = (routerId: string) => void;

export class ConnectorRouterRegistry {
  private readonly definitions = new Map<string, ConnectorRouterDefinition>();
  private readonly defaultRouter = new StraightRouter();
  private readonly listeners = new Set<ConnectorRouterChangeListener>();

  constructor() {
    // 默认装载三大内置寻路算法实例
    this.register(this.defaultRouter);
    this.register(new CurvedRouter());
    this.register(new OrthogonalRouter());
  }

  /**
   * 注册寻路算法定义
   */
  register(definition: ConnectorRouterDefinition): void {
    if (!definition || !definition.id) {
      throw new Error('[ConnectorRouterRegistry] 注册失败：路由定义缺少有效 id 标识');
    }
    this.definitions.set(definition.id, definition);
    this.notify(definition.id);
  }

  /**
   * 注销指定寻路算法
   */
  unregister(id: string): boolean {
    const deleted = this.definitions.delete(id);
    if (deleted) this.notify(id);
    return deleted;
  }

  /**
   * 订阅路由器增删 (插件晚于文档加载注册路由器时，引擎据此重算该类型连线的路由)
   */
  onChange(listener: ConnectorRouterChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 获取指定寻路算法定义，若未找到则默认回退到直线路由
   */
  get(id?: string): ConnectorRouterDefinition {
    if (id && this.definitions.has(id)) {
      return this.definitions.get(id)!;
    }
    return this.defaultRouter;
  }

  /**
   * 判断寻路算法是否已注册
   */
  has(id: string): boolean {
    return this.definitions.has(id);
  }

  /**
   * 获取全部已注册寻路算法
   */
  getAll(): readonly ConnectorRouterDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * 清空并重新恢复默认路由算法
   */
  clear(): void {
    this.listeners.clear();
    this.definitions.clear();
    this.register(this.defaultRouter);
    this.register(new CurvedRouter());
    this.register(new OrthogonalRouter());
  }

  private notify(routerId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(routerId);
      } catch (err) {
        console.error('[SkyNote:ConnectorRouterRegistry] 变更监听回调异常:', err);
      }
    }
  }
}
