/**
 * @file connector-router-registry.ts
 * @description 连线寻路算法注册表 (ConnectorRouterRegistry)
 * 
 * 设计考量 (Why):
 * 1. 策略模式解耦：将各种寻路算法（直线、正交、贝塞尔、思维导图曲线）收敛为统一注册表，
 *    渲染器和连线交互仅需 routerRegistry.get(type).route(input) 即可，无任何硬编码 if/else。
 * 2. 默认开箱即用：内置 'straight'、'orthogonal'、'curved' 三大高频算法，无需外部插件也能即刻运行。
 * 3. 严格纯函数：内置算法保持绝对数学纯净，0 依赖，0 状态副作用。
 */

import {
  ConnectorRouter,
  type ConnectorRouterDefinition,
  type ConnectorRouterInput,
  type ConnectorRouterResult,
  type ConnectorDirection
} from '../protocols/connector-router.protocol';
import type { Point } from '../types/canvas';
import { buildRoundedPolylinePath } from '../utils/geometry';

/** 直线路由算法类 */
export class StraightRouter extends ConnectorRouter {
  readonly id = 'straight';
  readonly label = '直线';

  route(input: ConnectorRouterInput): ConnectorRouterResult {
    const { startPoint, endPoint, controlPoints, style } = input;
    const cornerRadius = style?.cornerRadius ?? 0;

    if (controlPoints && controlPoints.length > 0) {
      const points: Point[] = [{ ...startPoint }, ...controlPoints.map((p) => ({ ...p })), { ...endPoint }];
      const pathData = cornerRadius > 0 ? buildRoundedPolylinePath(points, cornerRadius) : undefined;
      return {
        points,
        pathData
      };
    }

    const points: Point[] = [{ ...startPoint }, { ...endPoint }];
    return {
      points,
      pathData: `M ${startPoint.x} ${startPoint.y} L ${endPoint.x} ${endPoint.y}`
    };
  }
}

/** 经典平滑贝塞尔曲线路由算法类 */
export class CurvedRouter extends ConnectorRouter {
  readonly id = 'curved';
  readonly label = '平滑曲线';

  constructor(private readonly defaultCurviness = 0.4) {
    super();
  }

  route(input: ConnectorRouterInput): ConnectorRouterResult {
    const { startPoint, endPoint, startDirection, endDirection } = input;
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // 控制点延伸距离，正比于两点距离但设置下限
    const offset = Math.max(dist * this.defaultCurviness, 20);

    const getDirectionOffset = (dir: ConnectorDirection | undefined, defaultDir: 'x' | 'y'): { ox: number; oy: number } => {
      if (dir === 'top') return { ox: 0, oy: -offset };
      if (dir === 'bottom') return { ox: 0, oy: offset };
      if (dir === 'left') return { ox: -offset, oy: 0 };
      if (dir === 'right') return { ox: offset, oy: 0 };
      // 无朝向时根据端点主轴方向默认沿 X 轴延伸
      return defaultDir === 'x' ? { ox: offset * Math.sign(dx || 1), oy: 0 } : { ox: 0, oy: offset * Math.sign(dy || 1) };
    };

    const startOff = getDirectionOffset(startDirection, Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y');
    const endOff = getDirectionOffset(endDirection, Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y');

    const cp1: Point = { x: startPoint.x + startOff.ox, y: startPoint.y + startOff.oy };
    const cp2: Point = { x: endPoint.x + (endDirection ? endOff.ox : -endOff.ox), y: endPoint.y + (endDirection ? endOff.oy : -endOff.oy) };

    const pathData = `M ${startPoint.x} ${startPoint.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${endPoint.x} ${endPoint.y}`;

    return {
      points: [{ ...startPoint }, cp1, cp2, { ...endPoint }],
      pathData
    };
  }
}

/** 经典曼哈顿正交折线路由算法类 */
export class OrthogonalRouter extends ConnectorRouter {
  readonly id = 'orthogonal';
  readonly label = '正交折线';

  constructor(private readonly defaultRadius = 0) {
    super();
  }

  route(input: ConnectorRouterInput): ConnectorRouterResult {
    const { startPoint, endPoint, startDirection, endDirection, controlPoints, style } = input;
    const cornerRadius = style?.cornerRadius ?? this.defaultRadius;

    if (controlPoints && controlPoints.length > 0) {
      const points: Point[] = [{ ...startPoint }, ...controlPoints.map((p) => ({ ...p })), { ...endPoint }];
      return {
        points,
        pathData: buildRoundedPolylinePath(points, cornerRadius)
      };
    }

    const points: Point[] = [{ ...startPoint }];

    // 若无指定朝向，默认使用两段或三段 Z 型折线
    if (!startDirection && !endDirection) {
      const midX = (startPoint.x + endPoint.x) / 2;
      points.push({ x: midX, y: startPoint.y });
      points.push({ x: midX, y: endPoint.y });
    } else {
      // 具备朝向特征时的折线计算
      const startHorizontal = startDirection === 'left' || startDirection === 'right';
      const endHorizontal = endDirection === 'left' || endDirection === 'right';

      if (startHorizontal && endHorizontal) {
        const midX = (startPoint.x + endPoint.x) / 2;
        points.push({ x: midX, y: startPoint.y });
        points.push({ x: midX, y: endPoint.y });
      } else if (!startHorizontal && !endHorizontal) {
        const midY = (startPoint.y + endPoint.y) / 2;
        points.push({ x: startPoint.x, y: midY });
        points.push({ x: endPoint.x, y: midY });
      } else if (startHorizontal) {
        points.push({ x: endPoint.x, y: startPoint.y });
      } else {
        points.push({ x: startPoint.x, y: endPoint.y });
      }
    }

    points.push({ ...endPoint });
    const pathData = buildRoundedPolylinePath(points, cornerRadius);

    return {
      points,
      pathData
    };
  }
}

export class ConnectorRouterRegistry {
  private readonly definitions = new Map<string, ConnectorRouterDefinition>();
  private readonly defaultRouter = new StraightRouter();

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
  }

  /**
   * 注销指定寻路算法
   */
  unregister(id: string): boolean {
    return this.definitions.delete(id);
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
    this.definitions.clear();
    this.register(this.defaultRouter);
    this.register(new CurvedRouter());
    this.register(new OrthogonalRouter());
  }
}
