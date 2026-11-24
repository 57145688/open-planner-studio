import { XMLParser } from 'fast-xml-parser';
import { computeSchedule } from '../cpm';
import type {
  Activity,
  Project,
  RelationType,
  Resource,
  ResourceAssignment,
  ResourceType,
  ScheduleResult,
  WbsNode,
} from '../types';

/**
 * MS Project XML (MSPDI) 读写。
 *
 * 约定：
 * - 1 个工期日 = 8 小时，DurationFormat = 7（天），LinkLag 以 0.1 分钟为单位（1 天 = 4800）。
 * - 资源 MaxUnits 直接承载每日产能（人数 / 台数），Assignment Units 直接承载每日投入量。
 * - 功能范围是本系统的领域模型子集：WBS、任务、逻辑关系、资源与分配、完成百分比、成本。
 */

const HOURS_PER_DAY = 8;
const TENTHS_PER_DAY = HOURS_PER_DAY * 60 * 10;

const RELATION_TO_MSP: Record<RelationType, number> = { FF: 0, FS: 1, SF: 2, SS: 3 };
const MSP_TO_RELATION: RelationType[] = ['FF', 'FS', 'SF', 'SS'];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

function isoDate(iso: string): string {
  const head = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : '';
}

function dateAt(iso: string, offset = 'T08:00:00'): string {
  const day = isoDate(iso);
  return day ? `${day}${offset}` : '';
}

/** 天 -> PT{h}H{m}M0S */
function toMspDuration(days: number): string {
  const minutes = Math.round(Math.max(0, days) * HOURS_PER_DAY * 60);
  const hours = Math.floor(minutes / 60);
  return `PT${hours}H${minutes % 60}M0S`;
}

/** PT32H0M0S / P1D -> 天 */
function parseMspDuration(text: string): number {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    text.trim(),
  );
  if (!match) return 0;
  const days = asNumber(match[1]);
  const hours = asNumber(match[2]);
  const minutes = asNumber(match[3]);
  const seconds = asNumber(match[4]);
  return days + hours / HOURS_PER_DAY + minutes / (HOURS_PER_DAY * 60) + seconds / (HOURS_PER_DAY * 3600);
}

function deriveStatus(percent: number): Activity['status'] {
  if (percent >= 1) return 'done';
  return percent > 0 ? 'inProgress' : 'planned';
}

function wbsDepth(node: WbsNode, byId: Map<string, WbsNode>): number {
  let depth = 1;
  let cursor = node.parentId ? byId.get(node.parentId) : undefined;
  const seen = new Set<string>([node.id]);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    depth += 1;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return depth;
}

export interface MspdiExportOptions {
  /** 复用已算好的排程，避免重复计算 */
  schedule?: ScheduleResult;
}

/** 导出为 MS Project XML（MSPDI），可被 MS Project / OpenProject / ProjectLibre 打开。 */
export function exportMspdi(project: Project, options: MspdiExportOptions = {}): string {
  const schedule = options.schedule ?? computeSchedule(project);
  const wbsById = new Map(project.wbs.map((node) => [node.id, node]));
  const orderedWbs = project.wbs.map((node) => ({ node, depth: wbsDepth(node, wbsById) }));
  orderedWbs.sort((a, b) => a.depth - b.depth || a.node.code.localeCompare(b.node.code));

  const taskUid = new Map<string, number>();
  let nextUid = 1;
  for (const { node } of orderedWbs) taskUid.set(`WBS:${node.id}`, nextUid++);
  for (const activity of project.activities) taskUid.set(activity.id, nextUid++);
  const resourceUid = new Map<string, number>();
  for (const resource of project.resources) resourceUid.set(resource.id, nextUid++);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push('<Project xmlns="http://schemas.microsoft.com/project">');
  lines.push(`  <Name>${escapeXml(project.name)}</Name>`);
  lines.push(`  <Title>${escapeXml(project.name)}</Title>`);
  lines.push('  <Company>APCC</Company>');
  lines.push('  <ScheduleFromStart>1</ScheduleFromStart>');
  lines.push(`  <StartDate>${dateAt(project.startDate)}</StartDate>`);
  lines.push(`  <FinishDate>${dateAt(schedule.projectFinish, 'T17:00:00')}</FinishDate>`);
  lines.push('  <CalendarUID>1</CalendarUID>');
  lines.push('  <MinutesPerDay>480</MinutesPerDay>');
  lines.push('  <MinutesPerWeek>2400</MinutesPerWeek>');
  lines.push('  <DaysPerMonth>20</DaysPerMonth>');
  lines.push('  <DefaultTaskType>0</DefaultTaskType>');
  lines.push('  <DurationFormat>7</DurationFormat>');
  lines.push('  <WorkFormat>2</WorkFormat>');
  lines.push('  <WeekStartDay>1</WeekStartDay>');
  lines.push(`  <CurrencyCode>${escapeXml(project.currency)}</CurrencyCode>`);
  lines.push(`  <StatusDate>${dateAt(project.dataDate)}</StatusDate>`);

  // 日历：按项目 workweek 生成周一为首的工作日
  lines.push('  <Calendars>');
  lines.push('    <Calendar>');
  lines.push('      <UID>1</UID>');
  lines.push('      <Name>标准工作日历</Name>');
  lines.push('      <IsBaseCalendar>1</IsBaseCalendar>');
  lines.push('      <BaseCalendarUID>-1</BaseCalendarUID>');
  lines.push('      <WeekDays>');
  for (let dayType = 1; dayType <= 7; dayType += 1) {
    const working = project.workweek.includes(dayType - 1);
    lines.push('        <WeekDay>');
    lines.push(`          <DayType>${dayType}</DayType>`);
    lines.push(`          <DayWorking>${working ? 1 : 0}</DayWorking>`);
    if (working) {
      lines.push('          <WorkingTimes>');
      lines.push('            <WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>');
      lines.push('            <WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime>');
      lines.push('          </WorkingTimes>');
    }
    lines.push('        </WeekDay>');
  }
  lines.push('      </WeekDays>');
  lines.push('    </Calendar>');
  lines.push('  </Calendars>');

  lines.push('  <Tasks>');
  // 汇总任务（WBS）
  for (const { node, depth } of orderedWbs) {
    const children = project.activities.filter((activity) => activity.wbsId === node.id);
    const schedules = children
      .map((activity) => schedule.byId[activity.id])
      .filter((item) => item !== undefined);
    const start = schedules.reduce(
      (min, item) => (min === '' || item.startDate < min ? item.startDate : min),
      '',
    );
    const finish = schedules.reduce(
      (max, item) => (max === '' || item.finishDate > max ? item.finishDate : max),
      '',
    );
    const totalCost = children.reduce((sum, activity) => sum + activity.budgetCost, 0);
    const earned = children.reduce((sum, activity) => sum + activity.budgetCost * activity.percentComplete, 0);
    const percent = totalCost > 0 ? Math.round((earned / totalCost) * 100) : 0;
    const uid = taskUid.get(`WBS:${node.id}`)!;

    lines.push('    <Task>');
    lines.push(`      <UID>${uid}</UID>`);
    lines.push(`      <ID>${uid}</ID>`);
    lines.push(`      <Name>${escapeXml(node.name)}</Name>`);
    lines.push('      <Type>1</Type>');
    lines.push('      <IsNull>0</IsNull>');
    lines.push(`      <WBS>${escapeXml(node.code)}</WBS>`);
    lines.push(`      <OutlineNumber>${escapeXml(node.code)}</OutlineNumber>`);
    lines.push(`      <OutlineLevel>${depth}</OutlineLevel>`);
    if (start) lines.push(`      <Start>${dateAt(start)}</Start>`);
    if (finish) lines.push(`      <Finish>${dateAt(finish, 'T17:00:00')}</Finish>`);
    lines.push('      <Duration>PT0H0M0S</Duration>');
    lines.push('      <DurationFormat>7</DurationFormat>');
    lines.push('      <Milestone>0</Milestone>');
    lines.push('      <Summary>1</Summary>');
    lines.push(`      <PercentComplete>${percent}</PercentComplete>`);
    lines.push(`      <Cost>${Math.round(totalCost)}</Cost>`);
    lines.push('    </Task>');
  }

  // 作业任务
  for (const activity of project.activities) {
    const scheduled = schedule.byId[activity.id];
    const uid = taskUid.get(activity.id)!;
    const wbsNode = wbsById.get(activity.wbsId);
    const outlineLevel = wbsNode ? wbsDepth(wbsNode, wbsById) + 1 : 1;
    const percent = Math.round(Math.max(0, Math.min(1, activity.percentComplete)) * 100);

    lines.push('    <Task>');
    lines.push(`      <UID>${uid}</UID>`);
    lines.push(`      <ID>${uid}</ID>`);
    lines.push(`      <Name>${escapeXml(activity.name)}</Name>`);
    lines.push('      <Type>0</Type>');
    lines.push('      <IsNull>0</IsNull>');
    lines.push(`      <WBS>${escapeXml(activity.code)}</WBS>`);
    lines.push(`      <OutlineNumber>${escapeXml(activity.code)}</OutlineNumber>`);
    lines.push(`      <OutlineLevel>${outlineLevel}</OutlineLevel>`);
    if (scheduled) {
      lines.push(`      <Start>${dateAt(scheduled.startDate)}</Start>`);
      lines.push(`      <Finish>${dateAt(scheduled.finishDate, 'T17:00:00')}</Finish>`);
    }
    lines.push(`      <Duration>${toMspDuration(activity.durationDays)}</Duration>`);
    lines.push('      <DurationFormat>7</DurationFormat>');
    lines.push(`      <Milestone>${activity.isMilestone ? 1 : 0}</Milestone>`);
    lines.push('      <Summary>0</Summary>');
    lines.push(`      <PercentComplete>${percent}</PercentComplete>`);
    lines.push(`      <Cost>${Math.round(activity.budgetCost)}</Cost>`);
    lines.push(`      <ActualCost>${Math.round(activity.actualCost)}</ActualCost>`);
    for (const rel of activity.predecessors) {
      const predecessorUid = taskUid.get(rel.activityId);
      if (predecessorUid === undefined) continue;
      lines.push('      <PredecessorLink>');
      lines.push(`        <PredecessorUID>${predecessorUid}</PredecessorUID>`);
      lines.push(`        <Type>${RELATION_TO_MSP[rel.type]}</Type>`);
      lines.push(`        <LinkLag>${Math.round(rel.lagDays * TENTHS_PER_DAY)}</LinkLag>`);
      lines.push('        <LagFormat>7</LagFormat>');
      lines.push('      </PredecessorLink>');
    }
    lines.push('    </Task>');
  }
  lines.push('  </Tasks>');

  lines.push('  <Resources>');
  for (const resource of project.resources) {
    lines.push('    <Resource>');
    lines.push(`      <UID>${resourceUid.get(resource.id)}</UID>`);
    lines.push(`      <ID>${resourceUid.get(resource.id)}</ID>`);
    lines.push(`      <Name>${escapeXml(resource.name)}</Name>`);
    lines.push(`      <Type>${resource.type === 'material' ? 0 : 1}</Type>`);
    lines.push(`      <Group>${resource.type}</Group>`);
    if (resource.type === 'material') {
      lines.push(`      <MaterialLabel>${escapeXml(resource.unit)}</MaterialLabel>`);
    }
    lines.push(`      <MaxUnits>${resource.capacityPerDay}</MaxUnits>`);
    lines.push(`      <StandardRate>${resource.unitCost}</StandardRate>`);
    lines.push('      <StandardRateFormat>3</StandardRateFormat>');
    lines.push('    </Resource>');
  }
  lines.push('  </Resources>');

  lines.push('  <Assignments>');
  let assignmentUid = 1;
  for (const activity of project.activities) {
    for (const assignment of activity.resources) {
      const resUid = resourceUid.get(assignment.resourceId);
      const taskUidValue = taskUid.get(activity.id);
      if (resUid === undefined || taskUidValue === undefined) continue;
      lines.push('    <Assignment>');
      lines.push(`      <UID>${assignmentUid}</UID>`);
      lines.push(`      <TaskUID>${taskUidValue}</TaskUID>`);
      lines.push(`      <ResourceUID>${resUid}</ResourceUID>`);
      lines.push(`      <Units>${assignment.unitsPerDay}</Units>`);
      lines.push('    </Assignment>');
      assignmentUid += 1;
    }
  }
  lines.push('  </Assignments>');

  lines.push('</Project>');
  return lines.join('\n');
}

export interface MspdiImportResult {
  project: Project;
  warnings: string[];
}

interface RawPredecessorLink {
  PredecessorUID?: number | string;
  Type?: number | string;
  LinkLag?: number | string;
}

interface RawTask {
  UID?: number | string;
  ID?: number | string;
  Name?: string;
  WBS?: string;
  OutlineNumber?: string;
  OutlineLevel?: number | string;
  Summary?: number | string;
  Milestone?: number | string;
  Duration?: string;
  Start?: string;
  Finish?: string;
  PercentComplete?: number | string;
  Cost?: number | string;
  ActualCost?: number | string;
  PredecessorLink?: RawPredecessorLink | RawPredecessorLink[];
}

interface RawResource {
  UID?: number | string;
  ID?: number | string;
  Name?: string;
  Type?: number | string;
  MaxUnits?: number | string;
  StandardRate?: number | string;
  MaterialLabel?: string;
  Group?: string;
  IsNull?: number | string;
}

interface RawAssignment {
  TaskUID?: number | string;
  ResourceUID?: number | string;
  Units?: number | string;
}

/** 解析 MS Project XML，得到本系统领域模型。 */
export function importMspdi(xml: string): MspdiImportResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ['Task', 'Resource', 'Assignment', 'PredecessorLink', 'WeekDay'].includes(name),
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const projectNode = (parsed.Project ?? parsed['ns0:Project'] ?? parsed.project) as
    | Record<string, unknown>
    | undefined;
  if (!projectNode) {
    throw new Error('不是有效的 MS Project XML：缺少 Project 根节点。');
  }

  const warnings: string[] = [];
  const tasks = asArray((projectNode.Tasks as Record<string, unknown> | undefined)?.Task as RawTask);
  if (tasks.length === 0) {
    throw new Error('MS Project XML 中未找到任何 Task。');
  }

  const name = asText(projectNode.Name) || asText(projectNode.Title) || '导入项目';
  const statusDateRaw = asText(projectNode.StatusDate);

  // 1) 汇总任务 -> WBS
  const summaryTasks = tasks.filter((task) => asNumber(task.Summary) === 1);
  const wbs: WbsNode[] = [];
  const stack: { level: number; node: WbsNode }[] = [];
  for (const task of summaryTasks) {
    const level = Math.max(1, Math.round(asNumber(task.OutlineLevel, 1)));
    const code = asText(task.OutlineNumber) || asText(task.WBS) || `${level}`;
    const node: WbsNode = {
      id: `W${asNumber(task.UID, wbs.length + 1)}`,
      code,
      name: asText(task.Name) || code,
      parentId: null,
    };
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    node.parentId = stack.length > 0 ? stack[stack.length - 1].node.id : null;
    stack.push({ level, node });
    wbs.push(node);
  }
  if (wbs.length === 0) {
    wbs.push({ id: 'W1', code: '1', name, parentId: null });
  }
  const rootWbs = wbs[0];

  function wbsForOutline(outline: string): string {
    let best: WbsNode | undefined;
    for (const node of wbs) {
      if (outline === node.code || outline.startsWith(`${node.code}.`)) {
        if (!best || node.code.length > best.code.length) best = node;
      }
    }
    return best?.id ?? rootWbs.id;
  }

  // 2) 资源
  const rawResources = asArray(
    (projectNode.Resources as Record<string, unknown> | undefined)?.Resource as RawResource,
  );
  const resources: Resource[] = [];
  const resourceByUid = new Map<number, Resource>();
  for (const raw of rawResources) {
    const uid = asNumber(raw.UID);
    if (asNumber(raw.IsNull) === 1) continue;
    const name = asText(raw.Name);
    if (!name) continue;
    const typeCode = asNumber(raw.Type, 1);
    const group = asText(raw.Group);
    const type: ResourceType =
      typeCode === 0 ? 'material' : group === 'equipment' ? 'equipment' : 'labor';
    const capacity = Math.max(asNumber(raw.MaxUnits, 1), 1);
    const resource: Resource = {
      id: `R${uid}`,
      name,
      type,
      unit:
        type === 'material'
          ? asText(raw.MaterialLabel) || '单位'
          : type === 'equipment'
            ? '台'
            : '人',
      capacityPerDay: capacity,
      unitCost: asNumber(raw.StandardRate),
    };
    resources.push(resource);
    resourceByUid.set(uid, resource);
  }

  // 3) 分配
  const rawAssignments = asArray(
    (projectNode.Assignments as Record<string, unknown> | undefined)?.Assignment as RawAssignment,
  );
  const assignmentsByTask = new Map<number, ResourceAssignment[]>();
  for (const raw of rawAssignments) {
    const taskUid = asNumber(raw.TaskUID);
    const resUid = asNumber(raw.ResourceUID);
    const resource = resourceByUid.get(resUid);
    if (!resource) continue;
    const units = Math.max(asNumber(raw.Units, 1), 0);
    const list = assignmentsByTask.get(taskUid) ?? [];
    list.push({ resourceId: resource.id, unitsPerDay: units });
    assignmentsByTask.set(taskUid, list);
  }

  // 4) 作业任务
  const uidToActivityId = new Map<number, string>();
  const activities: Activity[] = [];
  let startFallback = '';

  for (const task of tasks) {
    if (asNumber(task.Summary) === 1) continue;
    const uid = asNumber(task.UID, activities.length + 1);
    const outline = asText(task.OutlineNumber) || asText(task.WBS) || String(uid);
    const isMilestone = asNumber(task.Milestone) === 1;
    const parsedDuration = parseMspDuration(asText(task.Duration));
    let durationDays = isMilestone ? 0 : Math.max(1, Math.round(parsedDuration));
    if (!isMilestone && parsedDuration > 0 && parsedDuration < 0.5) {
      warnings.push(`任务「${asText(task.Name, outline)}」工期不足半天，按 1 天处理。`);
      durationDays = 1;
    }
    const percentComplete = Math.max(0, Math.min(1, asNumber(task.PercentComplete) / 100));
    const budgetCost = asNumber(task.Cost);
    const actualCost = task.ActualCost !== undefined ? asNumber(task.ActualCost) : Math.round(budgetCost * percentComplete);
    const start = isoDate(asText(task.Start)) || isoDate(asText(task.Finish));
    if (start && (startFallback === '' || start < startFallback)) startFallback = start;

    const id = `T${uid}`;
    uidToActivityId.set(uid, id);
    activities.push({
      id,
      code: outline,
      name: asText(task.Name) || `任务 ${uid}`,
      wbsId: wbsForOutline(outline),
      durationDays,
      predecessors: [],
      resources: assignmentsByTask.get(uid) ?? [],
      budgetCost,
      percentComplete,
      actualCost,
      status: deriveStatus(percentComplete),
      ifcGuids: [],
      isMilestone,
    });
  }

  if (activities.length === 0) {
    throw new Error('MS Project XML 中没有可导入的作业任务。');
  }

  // 5) 逻辑关系（依赖 UID -> 活动）
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));
  for (const task of tasks) {
    if (asNumber(task.Summary) === 1) continue;
    const uid = asNumber(task.UID);
    const activity = activityById.get(uidToActivityId.get(uid) ?? '');
    if (!activity) continue;
    for (const link of asArray(task.PredecessorLink)) {
      const predecessorUid = asNumber(link.PredecessorUID);
      const predecessorId = uidToActivityId.get(predecessorUid);
      if (!predecessorId) {
        warnings.push(`任务「${activity.name}」的前置任务 UID ${predecessorUid} 不存在，已忽略。`);
        continue;
      }
      const type = MSP_TO_RELATION[Math.round(asNumber(link.Type, 1))] ?? 'FS';
      const lagDays = Math.round(asNumber(link.LinkLag) / TENTHS_PER_DAY);
      activity.predecessors.push({ activityId: predecessorId, type, lagDays });
    }
  }

  // 6) 工作日历
  const calendarNode = asArray(
    (projectNode.Calendars as Record<string, unknown> | undefined)?.Calendar,
  )[0] as Record<string, unknown> | undefined;
  const weekDays = asArray(
    (calendarNode?.WeekDays as Record<string, unknown> | undefined)?.WeekDay,
  ) as { DayType?: number | string; DayWorking?: number | string }[];
  let workweek = [1, 2, 3, 4, 5];
  if (weekDays.length === 7) {
    const derived = weekDays
      .filter((day) => asNumber(day.DayWorking) === 1)
      .map((day) => Math.round(asNumber(day.DayType)) - 1)
      .filter((day) => day >= 0 && day <= 6);
    if (derived.length > 0) workweek = derived;
  }

  const startDate = isoDate(asText(projectNode.StartDate)) || startFallback;
  if (!startDate) {
    throw new Error('MS Project XML 缺少开始日期，无法排程。');
  }
  const dataDate = isoDate(statusDateRaw) || startDate;

  return {
    project: {
      id: 'PRJ-IMPORTED',
      name,
      description: `由 MS Project XML 导入，共 ${activities.length} 项作业任务、${resources.length} 项资源。`,
      currency: asText(projectNode.CurrencyCode) || 'CNY',
      startDate,
      dataDate,
      baselineVersion: 'IMPORTED',
      workweek,
      activities,
      resources,
      boq: [],
      wbs,
      risks: [],
    },
    warnings,
  };
}
