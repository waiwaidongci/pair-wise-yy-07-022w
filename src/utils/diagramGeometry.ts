import type {
  AlignmentGuide,
  AnchorPoint,
  AnchorSide,
  Box,
  DiagramConnector,
  DiagramNode,
  Point,
} from '../types/diagram';
import type { SwimLayout } from './swimlaneLayout';

export const DEFAULT_NODE_SIZE: Record<DiagramNode['kind'], { width: number; height: number }> = {
  rectangle: { width: 160, height: 72 },
  circle: { width: 110, height: 110 },
  diamond: { width: 140, height: 110 },
  table: { width: 210, height: 152 },
};

export function boxCenter(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function anchorPointForBox(box: Box, side: AnchorSide): AnchorPoint {
  const center = boxCenter(box);
  if (side === 'top') return { x: center.x, y: box.y, side };
  if (side === 'right') return { x: box.x + box.width, y: center.y, side };
  if (side === 'bottom') return { x: center.x, y: box.y + box.height, side };
  return { x: box.x, y: center.y, side };
}

export function nodeCenter(node: DiagramNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

export function displayBoxes(nodes: DiagramNode[], layout: SwimLayout): Map<string, Box> {
  const boxes = new Map<string, Box>();
  nodes.forEach((node) => {
    const placement = layout.nodes.get(node.id);
    boxes.set(node.id, {
      x: node.x,
      y: placement?.y ?? node.y,
      width: node.width,
      height: node.height,
    });
  });
  return boxes;
}

export function chooseAnchors(from: Box, to: Box) {
  const deltaX = boxCenter(to).x - boxCenter(from).x;
  const deltaY = boxCenter(to).y - boxCenter(from).y;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return {
      from: deltaX >= 0 ? 'right' : 'left',
      to: deltaX >= 0 ? 'left' : 'right',
    } satisfies { from: AnchorSide; to: AnchorSide };
  }
  return {
    from: deltaY >= 0 ? 'bottom' : 'top',
    to: deltaY >= 0 ? 'top' : 'bottom',
  };
}

/**
 * 经典正交路由（同泳道 / 自由图元场景）。保留供外部（如缩略图）使用；
 * 画布统一走 swimlaneLayout 中的泳道感知路由。
 */
export function routeConnector(
  connector: DiagramConnector,
  nodes: DiagramNode[],
): number[] {
  const from = nodes.find((node) => node.id === connector.fromId);
  const to = nodes.find((node) => node.id === connector.toId);
  if (!from || !to) return [];
  const start = anchorPointForBox(from, connector.fromAnchor);
  const end = anchorPointForBox(to, connector.toAnchor);
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
  const obstacles = nodes.filter((node) => node.id !== from.id && node.id !== to.id);
  const collides = path.some((point, index) => {
    if (index === path.length - 1) return false;
    const next = path[index + 1];
    return obstacles.some((node) => segmentIntersectsBox(point, next, node, 12));
  });
  if (!collides) return flattenPoints([start, ...path, end]);

  const bounds = mergedBounds([from, to]);
  const routeY = bounds.y - 48;
  const detour = [
    start,
    startLead,
    { x: startLead.x, y: routeY },
    { x: endLead.x, y: routeY },
    endLead,
    end,
  ];
  return flattenPoints(dedupePoints(detour));
}

function directionForAnchor(side: AnchorSide): Point {
  if (side === 'top') return { x: 0, y: -1 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'bottom') return { x: 0, y: 1 };
  return { x: -1, y: 0 };
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
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  return { x: minX, y: minY };
}

function flattenPoints(points: Point[]): number[] {
  return points.flatMap((point) => [point.x, point.y]);
}

function dedupePoints(points: Point[]): Point[] {
  return points.filter(
    (point, index) =>
      index === 0 ||
      point.x !== points[index - 1].x ||
      point.y !== points[index - 1].y,
  );
}

export function calculateAlignmentGuides(
  activeBoxes: Box[],
  otherBoxes: Box[],
  threshold: number,
): AlignmentGuide[] {
  const guides: AlignmentGuide[] = [];
  if (!activeBoxes.length || activeBoxes.length > 1) return guides;
  const active = activeBoxes[0];
  const activePoints = {
    x: [active.x, active.x + active.width / 2, active.x + active.width],
    y: [active.y, active.y + active.height / 2, active.y + active.height],
  };
  otherBoxes.forEach((other) => {
    const otherX = [other.x, other.x + other.width / 2, other.x + other.width];
    const otherY = [other.y, other.y + other.height / 2, other.y + other.height];
    otherX.forEach((position) => {
      activePoints.x.forEach((activePosition) => {
        if (Math.abs(position - activePosition) <= threshold) {
          guides.push({
            orientation: 'vertical',
            position,
            start: Math.min(active.y, other.y) - 20,
            end: Math.max(active.y + active.height, other.y + other.height) + 20,
            label: `${Math.round(Math.abs(active.y - other.y))} px`,
          });
        }
      });
    });
    otherY.forEach((position) => {
      activePoints.y.forEach((activePosition) => {
        if (Math.abs(position - activePosition) <= threshold) {
          guides.push({
            orientation: 'horizontal',
            position,
            start: Math.min(active.x, other.x) - 20,
            end: Math.max(active.x + active.width, other.x + other.width) + 20,
            label: `${Math.round(Math.abs(active.x - other.x))} px`,
          });
        }
      });
    });
  });
  return guides.slice(0, 8);
}
