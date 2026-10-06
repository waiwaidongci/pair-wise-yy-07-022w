export type NodeKind = 'rectangle' | 'circle' | 'diamond' | 'table';
export type AnchorSide = 'top' | 'right' | 'bottom' | 'left';
export type ToolMode = 'select' | 'connect';

export interface DiagramNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  locked: boolean;
  groupId: string | null;
  /** 所属泳道；同一图元只归一条泳道，null 表示泳道外的自由图元。 */
  laneId: string | null;
  zIndex: number;
  fields: string[];
}

export interface Swimlane {
  id: string;
  name: string;
  color: string;
  /** 全部展开时的规范左上角与尺寸（折叠不会改写这些值）。 */
  x: number;
  y: number;
  width: number;
  /** 展开时的主体高度（不含标题条）。 */
  height: number;
  collapsed: boolean;
}

export interface DiagramConnector {
  id: string;
  fromId: string;
  toId: string;
  fromAnchor: AnchorSide;
  toAnchor: AnchorSide;
  label: string;
  color: string;
  dashed: boolean;
  locked: boolean;
  zIndex: number;
}

export interface DiagramDocument {
  version: 1;
  title: string;
  nodes: DiagramNode[];
  connectors: DiagramConnector[];
  swimlanes: Swimlane[];
  updatedAt: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnchorPoint extends Point {
  side: AnchorSide;
}

export interface AlignmentGuide {
  orientation: 'vertical' | 'horizontal';
  position: number;
  start: number;
  end: number;
  label: string;
}
