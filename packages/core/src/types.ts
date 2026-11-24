import type { BimModel } from './bim';
import type { CostBreakdown } from './cost';
import type { RealitySummary } from './reality';

export type ActivityStatus = 'planned' | 'inProgress' | 'done';
export type RelationType = 'FS' | 'SS' | 'FF' | 'SF';
export type ResourceType = 'labor' | 'equipment' | 'material';
export type RiskSeverity = 'low' | 'medium' | 'high';

export interface WbsNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
}

export interface Relation {
  /** predecessor activity id */
  activityId: string;
  type: RelationType;
  lagDays: number;
}

export interface ResourceAssignment {
  resourceId: string;
  unitsPerDay: number;
}

export interface Resource {
  id: string;
  name: string;
  type: ResourceType;
  unit: string;
  capacityPerDay: number;
  unitCost: number;
}

export interface BoqItem {
  id: string;
  code: string;
  description: string;
  unit: string;
  quantity: number;
  unitRate: number;
  wbsId: string;
}

export interface Activity {
  id: string;
  code: string;
  name: string;
  wbsId: string;
  durationDays: number;
  predecessors: Relation[];
  resources: ResourceAssignment[];
  budgetCost: number;
  /** 0..1 */
  percentComplete: number;
  actualCost: number;
  status: ActivityStatus;
  ifcGuids: string[];
  isMilestone: boolean;
  /** 资源平衡写入的最早开始约束（工作日偏移，0 表示项目开始日）。 */
  notEarlierThan?: number;
  /** 赶工单价（元/工作日），缺省时按活动预算与工期推算。 */
  crashCostPerDay?: number;
}

export interface Risk {
  id: string;
  title: string;
  severity: RiskSeverity;
  probability: number;
  impactDays: number;
  impactCost: number;
  activityId: string | null;
  mitigation: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  currency: string;
  startDate: string;
  dataDate: string;
  baselineVersion: string;
  /** 0 = Sunday ... 6 = Saturday; working weekdays */
  workweek: number[];
  activities: Activity[];
  resources: Resource[];
  boq: BoqItem[];
  wbs: WbsNode[];
  risks: Risk[];
}

export interface ScheduledActivity {
  id: string;
  code: string;
  name: string;
  wbsId: string;
  startIndex: number;
  finishIndex: number;
  startDate: string;
  finishDate: string;
  durationDays: number;
  totalFloat: number;
  freeFloat: number;
  critical: boolean;
  nearCritical: boolean;
  percentComplete: number;
  budgetCost: number;
}

export interface ScheduleResult {
  activities: ScheduledActivity[];
  byId: Record<string, ScheduledActivity>;
  /** ISO date for every working-day index */
  workingDays: string[];
  projectStart: string;
  projectFinish: string;
  projectDurationDays: number;
  criticalPath: string[];
  warnings: string[];
}

export interface EvmSnapshot {
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  sv: number;
  cv: number;
  spi: number;
  cpi: number;
  eac: number;
  etc: number;
  vac: number;
  percentComplete: number;
  plannedPercent: number;
}

export interface SeriesPoint {
  index: number;
  date: string;
  pv: number;
  ev: number;
  ac: number;
}

export interface ResourceLoad {
  resourceId: string;
  name: string;
  type: ResourceType;
  unit: string;
  capacityPerDay: number;
  peak: number;
  average: number;
  utilizationPeak: number;
  daily: number[];
  overloaded: boolean;
}

export interface ResourceResult {
  loads: ResourceLoad[];
  laborDaily: number[];
  equipmentDaily: number[];
  laborPeak: number;
  equipmentPeak: number;
}

export interface FloorStatus {
  level: number;
  label: string;
  percent: number;
  status: 'done' | 'active' | 'planned';
}

export interface Insight {
  id: string;
  level: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  action: string;
}

export interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  durationFactor: number;
  costFactor: number;
  resourceFactor: number;
  applyTo: 'critical' | 'all';
}

export interface ScenarioResult {
  id: string;
  name: string;
  description: string;
  durationDays: number;
  finishDate: string;
  bac: number;
  eac: number;
  peakLabor: number;
  peakEquipment: number;
  durationDelta: number;
  costDelta: number;
  riskNote: string;
}

export interface DashboardPayload {
  generatedAt: string;
  project: {
    id: string;
    name: string;
    description: string;
    currency: string;
    startDate: string;
    dataDate: string;
    baselineVersion: string;
    /** 0 = Sunday ... 6 = Saturday; working weekdays */
    workweek: number[];
  };
  schedule: ScheduleResult;
  evm: EvmSnapshot;
  series: SeriesPoint[];
  resources: ResourceResult;
  risks: Risk[];
  floors: FloorStatus[];
  insights: Insight[];
  scenarios: ScenarioResult[];
  wbs: WbsNode[];
  activities: Activity[];
  bim: BimModel;
  cost: CostBreakdown;
  reality: RealitySummary;
}
