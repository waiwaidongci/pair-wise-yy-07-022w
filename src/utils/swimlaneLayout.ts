import type {
  AnchorPoint,
  AnchorSide,
  Box,
  DiagramConnector,
  DiagramNode,
  Point,
  Swimlane,
} from '../types/diagram';
import { anchorPointForBox } from './diagramGeometry';

/** 折叠后只保留标题条的高度。 */
export const LANE_HEADER_HEIGHT = 34;
export const LANE_GAP = 26;
export const LANE_PADDING = 22;
export const LANE_MIN_BODY = 160;
export const LANE_DEFAULT_WIDTH = 1180;
export const LANE_LEAD = 30;

export const LANE_COLORS = ['#eaf1ff', '#e9f8f0', '#fff4e5', '#f3ecff', '#fdeef1'];

export interface LaneGeometry extends Box {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  bodyHeight: number;
  /** 该泳道之前所有折叠泳道累计收起的高度（供自由图元位移使用）。 */
  collapseShiftBefore: number;
}

export interface NodePlacement {
  /** 画布上的实际显示坐标；折叠泳道中的图元不显示。 */
  x: number;
  y: number;
  visible: boolean;
  laneId: string | null;
}

export interface SwimLayout {
  lanes: LaneGeometry[];
  /** 按规范顺序（数组顺序即泳道先后）给出的几何信息。 */
  laneById: Map<string, LaneGeometry>;
  /** 图元显示位置映射，key 为图元 id。 */
  nodes: Map<string, NodePlacement>;
  /** 全部展开并堆叠后的底部（用于新建泳道、适应画布）。 */
  canonicalBottom: number;
  /** 当前可见内容的包围盒（折叠状态下也准确）。 */
  displayBounds: Box;
  /** 每个泳道收起导致的位移量，key 为泳道 id。 */
  collapseDeltas: Map<string, number>;
}

function effectiveBodyHeight(lane: Swimlane, nodes: DiagramNode[]): number {
  const members = nodes.filter((node) => node.laneId === lane.id);
  let needed = LANE_MIN_BODY;
  if (members.length) {
    needed = Math.max(
      needed,
      ...members.map((node) => {
        const offset = node.y - (lane.y + LANE_HEADER_HEIGHT);
        return offset + node.height + LANE_PADDING;
      }),
    );
  }
  return Math.max(lane.height, needed);
}

/**
 * 计算泳道布局。数据层始终保存“全部展开”时的规范坐标；
 * 折叠仅在显示层把该泳道之后的内容上移，展开后规范坐标原样恢复。
 */
export function computeSwimLayout(
  lanesInput: Swimlane[],
  nodesInput: DiagramNode[],
  overrides?: {
    lanes?: Swimlane[];
    positions?: Record<string, Point>;
    collapsedOverride?: Record<string, boolean>;
    /** 拖拽预览时冻结泳道主体高度为数据值，避免图元移动过程中泳道抖动。 */
    freezeHeights?: boolean;
  },
): SwimLayout {
  const lanes = overrides?.lanes ?? lanesInput;
  const nodeMap = new Map(nodesInput.map((node) => [node.id, node] as const));
  Object.entries(overrides?.positions ?? {}).forEach(([id, point]) => {
    const original = nodeMap.get(id);
    if (original) nodeMap.set(id, { ...original, x: point.x, y: point.y });
  });
  const nodes = [...nodeMap.values()];
  const bodyHeightOf = (lane: Swimlane) =>
    overrides?.freezeHeights ? lane.height : effectiveBodyHeight(lane, nodes);

  const laneById = new Map<string, LaneGeometry>();
  const collapseDeltas = new Map<string, number>();
  const canonicalTop = lanes.length ? Math.min(...lanes.map((lane) => lane.y)) : 0;
  let displayCursor = canonicalTop;
  let collapseShift = 0;
  let maxRight = 0;
  let visibleBottom = canonicalTop;

  lanes.forEach((lane) => {
    const collapsed = overrides?.collapsedOverride?.[lane.id] ?? lane.collapsed;
    const bodyHeight = bodyHeightOf(lane);
    const displayHeight = collapsed ? LANE_HEADER_HEIGHT : LANE_HEADER_HEIGHT + bodyHeight;
    const geometry: LaneGeometry = {
      id: lane.id,
      name: lane.name,
      color: lane.color,
      collapsed,
      x: lane.x,
      y: displayCursor,
      width: lane.width,
      height: displayHeight,
      bodyHeight,
      collapseShiftBefore: collapseShift,
    };
    laneById.set(lane.id, geometry);
    // 折叠后下一个泳道直接接在标题条下方，其累计位移等于被收起的主体高度。
    const delta = collapsed ? bodyHeight : 0;
    collapseDeltas.set(lane.id, delta);
    displayCursor += displayHeight + LANE_GAP;
    collapseShift += delta;
    maxRight = Math.max(maxRight, lane.x + lane.width);
    visibleBottom = Math.max(visibleBottom, geometry.y + geometry.height);
  });

  // 自由图元：位于整个泳道堆叠下方（规范坐标）的自由图元随折叠一起上移，
  // 堆叠上方或之外的保持不动。
  const canonicalBottom = lanes.length
    ? Math.max(
        ...lanes.map(
          (lane) => lane.y + LANE_HEADER_HEIGHT + effectiveBodyHeight(lane, nodes) + LANE_GAP,
        ),
      ) - LANE_GAP
    : 0;

  const placements = new Map<string, NodePlacement>();
  nodes.forEach((node) => {
    if (node.laneId) {
      const lane = lanes.find((item) => item.id === node.laneId);
      const geometry = laneById.get(node.laneId);
      if (lane && geometry) {
        const delta = lane.y - geometry.y;
        placements.set(node.id, {
          x: node.x,
          y: node.y - delta,
          visible: !geometry.collapsed,
          laneId: lane.id,
        });
        if (!geometry.collapsed) {
          maxRight = Math.max(maxRight, node.x + node.width);
          visibleBottom = Math.max(visibleBottom, node.y - delta + node.height);
        }
        return;
      }
    }
    let y = node.y;
    if (lanes.length && node.y >= canonicalBottom) y -= collapseShift;
    placements.set(node.id, { x: node.x, y, visible: true, laneId: null });
    maxRight = Math.max(maxRight, node.x + node.width);
    visibleBottom = Math.max(visibleBottom, y + node.height);
  });

  const allX = nodes.map((node) => node.x).concat(lanes.map((lane) => lane.x));

  return {
    lanes: lanes.map((lane) => laneById.get(lane.id) as LaneGeometry),
    laneById,
    nodes: placements,
    canonicalBottom,
    displayBounds: {
      x: allX.length ? Math.min(...allX) : 0,
      y: lanes.length ? Math.min(...[...laneById.values()].map((lane) => lane.y)) : 0,
      width: maxRight - (allX.length ? Math.min(...allX) : 0),
      height:
        visibleBottom -
        (lanes.length ? Math.min(...[...laneById.values()].map((lane) => lane.y)) : 0),
    },
    collapseDeltas,
  };
}

/**
 * 显示坐标 -> 规范坐标。拖拽结束时用它把落点换算回数据层坐标，
 * 保证折叠/展开后位置还在。
 */
export function displayToCanonical(
  lanes: Swimlane[],
  layout: SwimLayout,
  displayPoint: Point,
  laneId: string | null,
): Point {
  if (laneId) {
    const lane = layout.laneById.get(laneId);
    const original = lanes.find((item) => item.id === laneId);
    if (lane && original) {
      return { x: displayPoint.x, y: displayPoint.y + (original.y - lane.y) };
    }
  }
  // 自由图元：落点若在可见堆叠底部之下，需要补偿累计折叠位移。
  const visibleStackBottom =
    layout.lanes.length > 0
      ? Math.max(...layout.lanes.map((lane) => lane.y + lane.height))
      : -Infinity;
  if (displayPoint.y >= visibleStackBottom) {
    const totalCollapse = [...layout.collapseDeltas.values()].reduce((sum, delta) => sum + delta, 0);
    return { x: displayPoint.x, y: displayPoint.y + totalCollapse };
  }
  return { ...displayPoint };
}

/** 命中测试：显示坐标落在哪个泳道的主体（不含标题条、不含已折叠泳道）。 */
export function laneAtDisplayPoint(layout: SwimLayout, point: Point): string | null {
  for (let index = layout.lanes.length - 1; index >= 0; index -= 1) {
    const lane = layout.lanes[index];
    if (lane.collapsed) continue;
    if (
      point.x >= lane.x &&
      point.x <= lane.x + lane.width &&
      point.y >= lane.y + LANE_HEADER_HEIGHT &&
      point.y <= lane.y + lane.height
    ) {
      return lane.id;
    }
  }
  return null;
}

/** 显示几何下的图元包围盒，供锚点、连线与导出使用。 */
export function displayBox(node: DiagramNode, layout: SwimLayout): Box {
  const placement = layout.nodes.get(node.id);
  return {
    x: node.x,
    y: placement?.y ?? node.y,
    width: node.width,
    height: node.height,
  };
}

function directionForAnchor(side: AnchorSide): Point {
  if (side === 'top') return { x: 0, y: -1 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'bottom') return { x: 0, y: 1 };
  return { x: -1, y: 0 };
}

function boxOf(node: DiagramNode, layout: SwimLayout): Box {
  const placement = layout.nodes.get(node.id);
  return { x: node.x, y: placement?.y ?? node.y, width: node.width, height: node.height };
}

function leadPoint(box: Box, side: AnchorSide, distance = LANE_LEAD): Point {
  const anchor = anchorPointForBox(box, side);
  const direction = directionForAnchor(side);
  return { x: anchor.x + direction.x * distance, y: anchor.y + direction.y * distance };
}

function dedupe(points: Point[]): Point[] {
  return points.filter(
    (point, index) =>
      index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y,
  );
}

function flatten(points: Point[]): number[] {
  return points.flatMap((point) => [point.x, point.y]);
}

function facingDown(anchor: AnchorSide): boolean {
  return anchor === 'right' || anchor === 'top';
}

function facingUp(anchor: AnchorSide): boolean {
  return anchor === 'left' || anchor === 'bottom';
}

/** 水平通道是否穿过任意中间泳道的主体（需要外侧绕行）。 */
function corridorBlocked(
  x: number,
  yTop: number,
  yBottom: number,
  between: LaneGeometry[],
  margin: number,
): boolean {
  return between.some(
    (lane) =>
      x >= lane.x - margin &&
      x <= lane.x + lane.width + margin &&
      yBottom >= lane.y + LANE_HEADER_HEIGHT - margin &&
      yTop <= lane.y + lane.height + margin,
  );
}

function verticalSideTowards(other: Point, box: Box): 'left' | 'right' {
  return other.x >= box.x + box.width / 2 ? 'right' : 'left';
}

export interface RoutedConnector {
  points: number[];
  hidden: boolean;
  /** 影响路径的状态指纹；布局未变时可直接复用旧路径。 */
  signature: string;
}

/**
 * 泳道感知的连线路由：
 * - 端点任一被折叠隐藏 → 整条连线隐藏（随泳道一起收起）
 * - 同泳道 / 双自由图元 → 原有正交路由
 * - 跨泳道 → 水平段贴泳道边界走线；通道被中间泳道挡住时绕到泳道外侧
 */
export function routeLaneConnector(
  connector: DiagramConnector,
  nodesInput: DiagramNode[],
  lanesInput: Swimlane[],
  overrides?: {
    lanes?: Swimlane[];
    positions?: Record<string, Point>;
    freezeHeights?: boolean;
  },
): RoutedConnector {
  const nodeMap = new Map(nodesInput.map((node) => [node.id, node] as const));
  Object.entries(overrides?.positions ?? {}).forEach(([id, point]) => {
    const original = nodeMap.get(id);
    if (original) nodeMap.set(id, { ...original, x: point.x, y: point.y });
  });
  const from = nodeMap.get(connector.fromId);
  const to = nodeMap.get(connector.toId);
  if (!from || !to) return { points: [], hidden: true, signature: connector.id };

  const layout = computeSwimLayout(lanesInput, nodesInput, {
    positions: overrides?.positions,
    freezeHeights: overrides?.freezeHeights,
  });
  const fromPlacement = layout.nodes.get(from.id);
  const toPlacement = layout.nodes.get(to.id);
  if (!fromPlacement?.visible || !toPlacement?.visible) {
    return { points: [], hidden: true, signature: signatureFor(connector, from, to, layout, 'hidden') };
  }

  const fromBox = boxOf(from, layout);
  const toBox = boxOf(to, layout);
  const fromLaneId = from.laneId && layout.laneById.has(from.laneId) ? from.laneId : null;
  const toLaneId = to.laneId && layout.laneById.has(to.laneId) ? to.laneId : null;
  const signature = signatureFor(connector, from, to, layout);

  // 同泳道、或两端都在泳道外：沿用经典路由。
  if (fromLaneId === toLaneId) {
    return { points: classicRoute(connector, fromBox, toBox, [...nodeMap.values()], layout), hidden: false, signature };
  }

  // 单端在泳道：判断是否需要贴边界。
  if (!fromLaneId || !toLaneId) {
    const laneNode = fromLaneId ? from : to;
    const laneId = (fromLaneId ?? toLaneId) as string;
    const lane = layout.laneById.get(laneId) as LaneGeometry;
    const otherBox = fromLaneId ? toBox : fromBox;
    const insideVertically =
      otherBox.y + otherBox.height / 2 >= lane.y + LANE_HEADER_HEIGHT &&
      otherBox.y + otherBox.height / 2 <= lane.y + lane.height;
    if (insideVertically) {
      return { points: classicRoute(connector, fromBox, toBox, [...nodeMap.values()], layout), hidden: false, signature };
    }
    const laneSide = laneNode === from
      ? boundaryRouteFromLane(connector, fromBox, toBox, lane)
      : boundaryRouteToLane(connector, fromBox, toBox, lane);
    return { points: laneSide, hidden: false, signature };
  }

  // 跨泳道
  const ordered = [...layout.lanes].sort((a, b) => a.y - b.y);
  const fromLane = layout.laneById.get(fromLaneId) as LaneGeometry;
  const toLane = layout.laneById.get(toLaneId) as LaneGeometry;
  const fromAbove = fromLane.y < toLane.y;
  const topLane = fromAbove ? fromLane : toLane;
  const bottomLane = fromAbove ? toLane : fromLane;
  const between = ordered.filter((lane) => lane.y > topLane.y && lane.y < bottomLane.y && !lane.collapsed);

  // 竖直锚点（上/下）：水平折线段放到两泳道之间的间隙里（贴边界）。
  if (connector.fromAnchor === 'top' || connector.fromAnchor === 'bottom' ||
      connector.toAnchor === 'top' || connector.toAnchor === 'bottom') {
    const gapY = (() => {
      if (fromAbove) return fromLane.y + fromLane.height + LANE_GAP / 2;
      return toLane.y + toLane.height + LANE_GAP / 2;
    })();
    const start = anchorPointForBox(fromBox, connector.fromAnchor);
    const end = anchorPointForBox(toBox, connector.toAnchor);
    const startLead = leadPoint(fromBox, connector.fromAnchor);
    const endLead = leadPoint(toBox, connector.toAnchor);
    const points = dedupe([
      start,
      startLead,
      { x: startLead.x, y: gapY },
      { x: endLead.x, y: gapY },
      endLead,
      end,
    ]);
    return { points: flatten(points), hidden: false, signature };
  }

  const boundaryY = fromAbove
    ? fromLane.y + fromLane.height + LANE_GAP / 2
    : toLane.y + toLane.height + LANE_GAP / 2;
  const corridorX = (fromBox.x + fromBox.width / 2 + toBox.x + toBox.width / 2) / 2;
  const blocked = corridorBlocked(
    corridorX,
    Math.min(fromBox.y, toBox.y) - 40,
    Math.max(fromBox.y + fromBox.height, toBox.y + toBox.height) + 40,
    between,
    14,
  );

  if (!blocked) {
    const points = buildBoundaryPath(connector, fromBox, toBox, fromLane, toLane, boundaryY, null);
    return { points, hidden: false, signature };
  }

  // 绕行到所有泳道外侧
  const detourRight =
    Math.max(...[fromLane, toLane, ...between].map((lane) => lane.x + lane.width)) + LANE_LEAD * 2;
  const detourLeft =
    Math.min(...[fromLane, toLane, ...between].map((lane) => lane.x)) - LANE_LEAD * 2;
  const useRight =
    Math.abs(detourRight - corridorX) <= Math.abs(corridorX - detourLeft);
  const detourX = useRight ? detourRight : detourLeft;
  const points = buildBoundaryPath(connector, fromBox, toBox, fromLane, toLane, boundaryY, detourX);
  return { points, hidden: false, signature };
}

/** 从泳道内图元出发到泳道外图元，先贴所在泳道边界。 */
function boundaryRouteFromLane(
  connector: DiagramConnector,
  fromBox: Box,
  toBox: Box,
  lane: LaneGeometry,
): number[] {
  const start = anchorPointForBox(fromBox, connector.fromAnchor);
  const startLead = leadPoint(fromBox, connector.fromAnchor);
  const end = anchorPointForBox(toBox, connector.toAnchor);
  const endLead = leadPoint(toBox, connector.toAnchor, LANE_LEAD);
  const boundaryY = toBox.y + toBox.height / 2 < lane.y
    ? lane.y + LANE_GAP / 2
    : lane.y + lane.height + LANE_GAP / 2;
  const points = [start, startLead];
  if (connector.fromAnchor === 'top' || connector.fromAnchor === 'bottom') {
    points.push({ x: startLead.x, y: boundaryY }, { x: endLead.x, y: boundaryY }, endLead, end);
  } else {
    const farSide = verticalSideTowards(end, fromBox);
    const outsideX = farSide === 'right'
      ? Math.max(lane.x + lane.width, fromBox.x + fromBox.width) + LANE_LEAD
      : Math.min(lane.x, fromBox.x) - LANE_LEAD;
    points.push(
      { x: outsideX, y: startLead.y },
      { x: outsideX, y: endLead.y },
      endLead,
      end,
    );
  }
  return flatten(dedupe(points));
}

function boundaryRouteToLane(
  connector: DiagramConnector,
  fromBox: Box,
  toBox: Box,
  lane: LaneGeometry,
): number[] {
  const start = anchorPointForBox(fromBox, connector.fromAnchor);
  const startLead = leadPoint(fromBox, connector.fromAnchor);
  const end = anchorPointForBox(toBox, connector.toAnchor);
  const endLead = leadPoint(toBox, connector.toAnchor);
  const boundaryY = start.y < lane.y
    ? lane.y + LANE_GAP / 2
    : lane.y + lane.height + LANE_GAP / 2;
  const points = [start, startLead];
  if (connector.toAnchor === 'top' || connector.toAnchor === 'bottom') {
    points.push({ x: startLead.x, y: boundaryY }, { x: endLead.x, y: boundaryY }, endLead, end);
  } else {
    const farSide = verticalSideTowards(start, toBox);
    const outsideX = farSide === 'right'
      ? Math.max(lane.x + lane.width, toBox.x + toBox.width) + LANE_LEAD
      : Math.min(lane.x, toBox.x) - LANE_LEAD;
    points.push(
      { x: outsideX, y: startLead.y },
      { x: outsideX, y: endLead.y },
      endLead,
      end,
    );
  }
  return flatten(dedupe(points));
}

/**
 * 跨泳道正交路径。detourX 为 null 时沿两泳道间隙的边界走线，
 * 否则水平段绕到泳道外侧。
 */
function buildBoundaryPath(
  connector: DiagramConnector,
  fromBox: Box,
  toBox: Box,
  fromLane: LaneGeometry,
  toLane: LaneGeometry,
  boundaryY: number,
  detourX: number | null,
): number[] {
  const start = anchorPointForBox(fromBox, connector.fromAnchor);
  const end = anchorPointForBox(toBox, connector.toAnchor);
  const startLead = leadPoint(fromBox, connector.fromAnchor);
  const endLead = leadPoint(toBox, connector.toAnchor);
  const fromAbove = fromLane.y < toLane.y;
  const points: Point[] = [start];

  if (connector.fromAnchor === 'top' || connector.fromAnchor === 'bottom') {
    points.push(startLead, { x: startLead.x, y: boundaryY });
  } else {
    const away = fromAbove ? facingUp(connector.fromAnchor) : facingDown(connector.fromAnchor);
    points.push(startLead);
    if (detourX !== null) {
      points.push({ x: detourX, y: startLead.y });
    } else if (away) {
      // 锚点朝远离对方泳道的方向：先绕过自身节点，再贴到边界。
      const side = verticalSideTowards(end, fromBox);
      const clearX = side === 'right'
        ? fromBox.x + fromBox.width + LANE_LEAD
        : fromBox.x - LANE_LEAD;
      points.push({ x: clearX, y: startLead.y }, { x: clearX, y: boundaryY });
    } else {
      points.push({ x: startLead.x, y: boundaryY });
    }
  }

  if (detourX !== null) points.push({ x: detourX, y: boundaryY });
  points.push({ x: endLead.x, y: boundaryY });

  if (connector.toAnchor === 'top' || connector.toAnchor === 'bottom') {
    points.push(endLead, end);
  } else {
    const away = fromAbove ? facingDown(connector.toAnchor) : facingUp(connector.toAnchor);
    if (detourX === null && away) {
      const side = verticalSideTowards(start, toBox);
      const clearX = side === 'right'
        ? toBox.x + toBox.width + LANE_LEAD
        : toBox.x - LANE_LEAD;
      // endLead 在 boundaryY 水平段之后，先到 clearX 再进锚点。
      points.splice(points.length - 1, 0, { x: clearX, y: boundaryY }, { x: clearX, y: endLead.y });
    }
    points.push(endLead, end);
  }

  return flatten(dedupe(points));
}

function classicRoute(
  connector: DiagramConnector,
  fromBox: Box,
  toBox: Box,
  allNodes: DiagramNode[],
  layout: SwimLayout,
): number[] {
  const start = anchorPointForBox(fromBox, connector.fromAnchor);
  const end = anchorPointForBox(toBox, connector.toAnchor);
  const startDirection = directionForAnchor(connector.fromAnchor);
  const endDirection = directionForAnchor(connector.toAnchor);
  const startLead = {
    x: start.x + startDirection.x * 26,
    y: start.y + startDirection.y * 26,
  };
  const endLead = {
    x: end.x + endDirection.x * 26,
    y: end.y + endDirection.y * 26,
  };
  const path = orthogonalPath(startLead, endLead);
  const obstacles = allNodes.filter(
    (node) => node.id !== connector.fromId && node.id !== connector.toId,
  );
  const collides = path.some((point, index) => {
    if (index === path.length - 1) return false;
    const next = path[index + 1];
    return obstacles.some((node) => segmentIntersectsBox(point, next, boxOf(node, layout), 12));
  });
  if (!collides) return flatten(dedupe([start, ...path, end]));

  const bounds = mergedBounds([fromBox, toBox]);
  const routeY = bounds.y - 48;
  const detour = [
    start,
    startLead,
    { x: startLead.x, y: routeY },
    { x: endLead.x, y: routeY },
    endLead,
    end,
  ];
  return flatten(dedupe(detour));
}

function orthogonalPath(start: Point, end: Point): Point[] {
  if (Math.abs(start.x - end.x) < 2 || Math.abs(start.y - end.y) < 2) {
    return [start, end];
  }
  const horizontalFirst = Math.abs(end.x - start.x) > Math.abs(end.y - start.y);
  return horizontalFirst
    ? [start, { x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }, end]
    : [start, { x: start.x, y: (start.y + end.y) / 2 }, { x: end.x, y: (start.y + end.y) / 2 }, end];
}

function segmentIntersectsBox(start: Point, end: Point, box: Box, padding: number) {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  return (
    maxX >= box.x - padding &&
    minX <= box.x + box.width + padding &&
    maxY >= box.y - padding &&
    minY <= box.y + box.height + padding
  );
}

function mergedBounds(boxes: Box[]) {
  return {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
  };
}

function signatureFor(
  connector: DiagramConnector,
  from: DiagramNode,
  to: DiagramNode,
  layout: SwimLayout,
  extra = '',
): string {
  const place = (node: DiagramNode) => {
    const placement = layout.nodes.get(node.id);
    return [
      Math.round(placement?.y ?? node.y),
      node.x,
      node.width,
      node.height,
      placement?.visible ? 1 : 0,
      node.laneId ?? '-',
    ].join(',');
  };
  const laneSig = layout.lanes
    .map((lane) => `${lane.id}:${Math.round(lane.y)}:${lane.height}:${lane.collapsed ? 1 : 0}:${lane.width}`)
    .join('|');
  return [
    connector.id,
    connector.fromAnchor,
    connector.toAnchor,
    place(from),
    place(to),
    laneSig,
    extra,
  ].join('#');
}

export function anchorInLayout(
  node: DiagramNode,
  side: AnchorSide,
  layout: SwimLayout,
): AnchorPoint {
  const box = boxOf(node, layout);
  return anchorPointForBox(box, side);
}

/**
 * 连线的几何指纹：只依赖两端图元显示几何与全部泳道几何。
 * 画布据此跳过路径未变连线的重新走线，只让受影响的连线重算。
 */
export function connectorSignatureInLayout(
  connector: DiagramConnector,
  nodes: DiagramNode[],
  layout: SwimLayout,
): string {
  const from = nodes.find((node) => node.id === connector.fromId);
  const to = nodes.find((node) => node.id === connector.toId);
  if (!from || !to) return `${connector.id}#missing`;
  return signatureFor(connector, from, to, layout);
}
export function connectorSignature(
  connector: DiagramConnector,
  nodes: DiagramNode[],
  lanes: Swimlane[],
): string {
  return connectorSignatureInLayout(connector, nodes, computeSwimLayout(lanes, nodes));
}
