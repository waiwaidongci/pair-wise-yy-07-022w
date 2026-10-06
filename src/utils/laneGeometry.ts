import type { DiagramNode, Point, Swimlane } from '../types/diagram';

export const COLLAPSED_LANE_HEIGHT = 34;
export const DEFAULT_LANE_HEIGHT = 230;
export const MIN_LANE_HEIGHT = 120;
export const LANE_HEADER_HEIGHT = 30;

export interface LanePalette {
  fill: string;
  header: string;
  stroke: string;
  text: string;
}

export const LANE_COLORS: LanePalette[] = [
  { fill: '#f4f8ff', header: '#dfeafc', stroke: '#c4d8f2', text: '#2b5a9e' },
  { fill: '#f5faf4', header: '#e0f0dd', stroke: '#c2e0bc', text: '#2f7a3d' },
  { fill: '#fdf8ee', header: '#f9e9c8', stroke: '#eed3a0', text: '#9a6b1f' },
  { fill: '#faf5fc', header: '#f0e2f6', stroke: '#dcc2e8', text: '#7a3f8f' },
  { fill: '#f3f9fc', header: '#dceff8', stroke: '#b8dcec', text: '#2b6a8f' },
  { fill: '#fcf5f5', header: '#f8e0e0', stroke: '#ecc4c4', text: '#a03f3f' },
];

export function laneColor(index: number): LanePalette {
  return LANE_COLORS[((index % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
}

export function makeLane(name: string, index: number): Swimlane {
  return {
    id: `lane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    height: DEFAULT_LANE_HEIGHT,
    collapsed: false,
    color: laneColor(index).header,
  };
}

export interface LaneRect {
  lane: Swimlane;
  index: number;
  y: number;
  visualHeight: number;
  bottom: number;
  collapsed: boolean;
}

/** 按顺序把泳道从上到下堆叠，返回每条泳道的几何矩形。 */
export function laneRects(lanes: Swimlane[]): LaneRect[] {
  let y = 0;
  return lanes.map((lane, index) => {
    const visualHeight = lane.collapsed ? COLLAPSED_LANE_HEIGHT : lane.height;
    const rect: LaneRect = {
      lane,
      index,
      y,
      visualHeight,
      bottom: y + visualHeight,
      collapsed: lane.collapsed,
    };
    y += visualHeight;
    return rect;
  });
}

export function laneById(lanes: Swimlane[], id: string | null | undefined): LaneRect | null {
  if (!id) return null;
  return laneRects(lanes).find((rect) => rect.lane.id === id) ?? null;
}

/** 找到 worldY 所在的泳道；最后一条泳道向下无限延伸。 */
export function laneAtY(lanes: Swimlane[], worldY: number): LaneRect | null {
  const rects = laneRects(lanes);
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    if (worldY >= rect.y && (i === rects.length - 1 || worldY < rect.bottom)) return rect;
  }
  return null;
}

export function isNodeInCollapsedLane(node: DiagramNode, lanes: Swimlane[]): boolean {
  const rect = laneById(lanes, node.swimlaneId);
  return !!rect && rect.collapsed;
}

interface LaneItem {
  key: string;
  nodeIds: string[];
  top: number;
  bottom: number;
}

function buildLaneItems(nodes: DiagramNode[]): LaneItem[] {
  const groups = new Map<string, DiagramNode[]>();
  const ungrouped: DiagramNode[] = [];
  nodes.forEach((node) => {
    if (node.groupId) {
      const list = groups.get(node.groupId) ?? [];
      list.push(node);
      groups.set(node.groupId, list);
    } else {
      ungrouped.push(node);
    }
  });
  const items: LaneItem[] = [];
  groups.forEach((groupNodes, groupId) => {
    items.push({
      key: groupId,
      nodeIds: groupNodes.map((node) => node.id),
      top: Math.min(...groupNodes.map((node) => node.y)),
      bottom: Math.max(...groupNodes.map((node) => node.y + node.height)),
    });
  });
  ungrouped.forEach((node) => {
    items.push({
      key: node.id,
      nodeIds: [node.id],
      top: node.y,
      bottom: node.y + node.height,
    });
  });
  return items.sort((left, right) => left.top - right.top);
}

/**
 * 旧数据兼容：把没有泳道信息的图元按纵向间距聚类成泳道，
 * 原来分过组（groupId）的图元一定归到同一条泳道。
 */
export function deriveLanes(nodes: DiagramNode[]): {
  lanes: Swimlane[];
  assignments: Map<string, string>;
} {
  const assignments = new Map<string, string>();
  if (!nodes.length) {
    return {
      lanes: [makeLane('产品需求', 0), makeLane('研发实现', 1)],
      assignments,
    };
  }
  const items = buildLaneItems(nodes);
  const gapThreshold = 86;
  const clusters: LaneItem[][] = [];
  let current: LaneItem[] = [];
  let clusterBottom = -Infinity;
  items.forEach((item) => {
    if (current.length && item.top - clusterBottom > gapThreshold) {
      clusters.push(current);
      current = [];
    }
    current.push(item);
    clusterBottom = Math.max(clusterBottom, item.bottom);
  });
  if (current.length) clusters.push(current);

  const lanes: Swimlane[] = [];
  const bounds: Array<{ top: number; bottom: number }> = [];
  clusters.forEach((cluster, index) => {
    const lane = makeLane(`泳道 ${index + 1}`, index);
    lanes.push(lane);
    let top = Infinity;
    let bottom = -Infinity;
    cluster.forEach((item) => {
      item.nodeIds.forEach((id) => assignments.set(id, lane.id));
      top = Math.min(top, item.top);
      bottom = Math.max(bottom, item.bottom);
    });
    bounds.push({ top, bottom });
  });

  let y = 0;
  lanes.forEach((lane, index) => {
    const next = bounds[index + 1];
    const boundary = next ? (bounds[index].bottom + next.top) / 2 : bounds[index].bottom + 80;
    lane.height = Math.max(MIN_LANE_HEIGHT, Math.round(boundary - y));
    y += lane.height;
  });
  return { lanes, assignments };
}

/** 泳道在世界坐标里的横向覆盖范围（随内容伸缩）。 */
export function laneSpan(nodes: DiagramNode[]): { x0: number; x1: number } {
  let x0 = -900;
  let x1 = 3800;
  nodes.forEach((node) => {
    x0 = Math.min(x0, node.x - 260);
    x1 = Math.max(x1, node.x + node.width + 260);
  });
  return { x0, x1 };
}

/** 正交线段是否与轴对齐矩形相交。 */
export function segmentIntersectsRect(
  start: Point,
  end: Point,
  rect: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  const horizontal = Math.abs(start.y - end.y) < 0.5;
  const vertical = Math.abs(start.x - end.x) < 0.5;
  if (horizontal) {
    if (start.y < rect.y0 || start.y > rect.y1) return false;
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    return maxX >= rect.x0 && minX <= rect.x1;
  }
  if (vertical) {
    if (start.x < rect.x0 || start.x > rect.x1) return false;
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    return maxY >= rect.y0 && minY <= rect.y1;
  }
  // 斜线段（理论上不会出现）：用端点粗判。
  const inside = (point: Point) =>
    point.x >= rect.x0 && point.x <= rect.x1 && point.y >= rect.y0 && point.y <= rect.y1;
  return inside(start) || inside(end);
}

/** 折线路径是否穿过某条泳道带（用于折叠时隐藏跨带连线）。 */
export function pathCrossesLane(points: number[], rect: LaneRect, span: { x0: number; x1: number }): boolean {
  const band = { x0: span.x0, y0: rect.y, x1: span.x1, y1: rect.bottom };
  for (let i = 0; i < points.length - 2; i += 2) {
    if (segmentIntersectsRect({ x: points[i], y: points[i + 1] }, { x: points[i + 2], y: points[i + 3] }, band)) {
      return true;
    }
  }
  return false;
}
