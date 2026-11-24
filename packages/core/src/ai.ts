import { computeSchedule } from './cpm';
import { computeEvm } from './evm';
import { crashProject, levelResources } from './optimizer';
import { computeResources } from './resources';
import type { Project } from './types';

/**
 * AI 网关的领域层协议。
 *
 * 设计约束：模型只能提出「白名单操作」（赶工 / 资源平衡）或说明性内容，
 * 所有影响量都由确定性求解器重新计算，模型输出不直接写入基准数据。
 */

export type AiIntent = 'crash' | 'leveling' | 'explain' | 'weekly-report' | 'unknown';
export type AiProviderKind = 'local' | 'llm';

export type AiOperation =
  | { kind: 'crash'; targetDays: number; costCapRatio: number; maxCutRatio: number }
  | { kind: 'leveling'; maxShiftDays: number };

export interface AiProposalImpact {
  durationDeltaDays: number | null;
  costDelta: number | null;
  note: string;
}

export interface AiProposal {
  id: string;
  intent: AiIntent;
  title: string;
  summary: string;
  bullets: string[];
  provider: AiProviderKind;
  createdAt: string;
  requiresApproval: boolean;
  operation: AiOperation | null;
  impact: AiProposalImpact;
}

export interface ParsedIntent {
  intent: AiIntent;
  targetDays?: number;
  maxShiftDays?: number;
}

let proposalSeq = 0;

function nextProposalId(intent: AiIntent): string {
  proposalSeq += 1;
  return `ai-${intent}-${Date.now().toString(36)}-${proposalSeq}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function extractDays(text: string): number | undefined {
  const match = text.match(/(\d+)\s*(?:个)?\s*(?:工作)?(?:天|日)/);
  return match ? Number(match[1]) : undefined;
}

/** 从中文请求中解析受支持的意图；无法识别时返回 unknown。 */
export function parseAiIntent(message: string): ParsedIntent {
  const text = message.trim();
  const days = extractDays(text);

  if (/资源|平衡|错峰|超配|峰值|班组冲突/.test(text)) {
    return { intent: 'leveling', maxShiftDays: clamp(days ?? 30, 1, 60) };
  }
  if (/压缩|赶工|提前|缩短|追回|抢工/.test(text)) {
    return { intent: 'crash', targetDays: clamp(days ?? 5, 1, 60) };
  }
  if (/周报|汇报|总结|日报|状态报告/.test(text)) {
    return { intent: 'weekly-report' };
  }
  if (/SPI|CPI|EVM|挣值|偏差|解释|为什么|分析/i.test(text)) {
    return { intent: 'explain' };
  }
  return { intent: 'unknown' };
}

/** 说明性提案：解释当前指标。 */
function explainProposal(project: Project): AiProposal {
  const schedule = computeSchedule(project);
  const evm = computeEvm(project, schedule).snapshot;
  const resources = computeResources(project, schedule);
  const overloaded = resources.loads.filter(
    (load) => load.overloaded && load.type !== 'material',
  );

  const bullets: string[] = [
    `进度绩效 SPI ${evm.spi.toFixed(2)}，${evm.spi >= 1 ? '领先或符合计划' : '低于计划'}。`,
    `成本绩效 CPI ${evm.cpi.toFixed(2)}，${evm.cpi >= 1 ? '成本受控' : '已发生超支'}。`,
    `关键路径 ${schedule.criticalPath.length} 项活动，预测完工 ${schedule.projectFinish}。`,
  ];
  if (overloaded.length > 0) {
    bullets.push(
      `超配资源：${overloaded.map((load) => load.name).join('、')}（共 ${overloaded.length} 项）。`,
    );
  }

  return {
    id: nextProposalId('explain'),
    intent: 'explain',
    title: '指标解释：SPI / CPI 现状',
    summary: `截止 ${project.dataDate}，完成 ${(evm.percentComplete * 100).toFixed(1)}%，计划应完成 ${(evm.plannedPercent * 100).toFixed(1)}%。`,
    bullets,
    provider: 'local',
    createdAt: new Date().toISOString(),
    requiresApproval: false,
    operation: null,
    impact: {
      durationDeltaDays: null,
      costDelta: null,
      note: '说明性内容，不修改项目数据。',
    },
  };
}

/** 说明性提案：生成周度状态报告要点。 */
function weeklyReportProposal(project: Project): AiProposal {
  const schedule = computeSchedule(project);
  const evm = computeEvm(project, schedule).snapshot;
  const resources = computeResources(project, schedule);
  const overloaded = resources.loads.filter(
    (load) => load.overloaded && load.type !== 'material',
  );
  const highRisks = project.risks.filter((risk) => risk.severity === 'high');
  const inProgress = project.activities.filter(
    (activity) => activity.status === 'inProgress',
  );

  const bullets = [
    `数据日期 ${project.dataDate}：完成率 ${(evm.percentComplete * 100).toFixed(1)}%，SPI ${evm.spi.toFixed(2)} / CPI ${evm.cpi.toFixed(2)}。`,
    `在建活动 ${inProgress.length} 项，预测完工 ${schedule.projectFinish}（${schedule.projectDurationDays} 个工作日）。`,
    `EAC ${Math.round(evm.eac).toLocaleString('zh-CN')} ${project.currency}，VAC ${Math.round(evm.vac).toLocaleString('zh-CN')} ${project.currency}。`,
    overloaded.length > 0
      ? `资源超配 ${overloaded.length} 项：${overloaded.map((load) => load.name).join('、')}。`
      : '资源投入处于容量范围内。',
    highRisks.length > 0
      ? `高风险 ${highRisks.length} 项：${highRisks.map((risk) => risk.title).join('；')}。`
      : '无未关闭的高风险。',
  ];

  return {
    id: nextProposalId('weekly-report'),
    intent: 'weekly-report',
    title: '周度状态报告要点',
    summary: '基于当前进度、成本与资源数据自动汇总，可直接用于周例会汇报。',
    bullets,
    provider: 'local',
    createdAt: new Date().toISOString(),
    requiresApproval: false,
    operation: null,
    impact: {
      durationDeltaDays: null,
      costDelta: null,
      note: '说明性内容，不修改项目数据。',
    },
  };
}

function unknownProposal(): AiProposal {
  return {
    id: nextProposalId('unknown'),
    intent: 'unknown',
    title: '暂未识别的请求',
    summary: '当前本地规则引擎支持：工期压缩、资源平衡、指标解释、周报要点。',
    bullets: [
      '试试：「把关键路径压缩 5 天」',
      '试试：「做一次资源平衡，限制顺延 20 天」',
      '试试：「解释一下 SPI 为什么偏低」',
      '未配置大模型时使用本地规则引擎，结果可复现、不联网。',
    ],
    provider: 'local',
    createdAt: new Date().toISOString(),
    requiresApproval: false,
    operation: null,
    impact: {
      durationDeltaDays: null,
      costDelta: null,
      note: '说明性内容，不修改项目数据。',
    },
  };
}

/** 依据白名单操作构造提案，影响量由确定性求解器计算。 */
export function buildProposalFromOperation(
  project: Project,
  operation: AiOperation,
  meta: { provider?: AiProviderKind; title?: string; summary?: string } = {},
): AiProposal {
  if (operation.kind === 'crash') {
    const targetDays = clamp(operation.targetDays, 1, 60);
    const option = crashProject(project, targetDays, {
      id: 'ai-crash',
      name: `AI 提案 · 压缩 ${targetDays} 天`,
      costCapRatio: operation.costCapRatio,
      maxCutRatio: operation.maxCutRatio,
    });
    const bullets = option.moves.slice(0, 6).map(
      (move) =>
        `${move.code} ${move.name}：压缩 ${move.cutDays} 天，追加 ${move.addedCost.toLocaleString('zh-CN')} ${project.currency}`,
    );
    if (bullets.length === 0) bullets.push('当前关键路径上没有可压缩活动。');
    bullets.push(option.riskNote);

    return {
      id: nextProposalId('crash'),
      intent: 'crash',
      title: meta.title ?? `工期压缩 ${targetDays} 天`,
      summary:
        meta.summary ??
        `实际压缩 ${option.achievedDays} 天，工期变为 ${option.durationDays} 个工作日，追加成本 ${option.addedCost.toLocaleString('zh-CN')} ${project.currency}。`,
      bullets,
      provider: meta.provider ?? 'local',
      createdAt: new Date().toISOString(),
      requiresApproval: option.achievedDays > 0,
      operation: {
        kind: 'crash',
        targetDays,
        costCapRatio: operation.costCapRatio,
        maxCutRatio: operation.maxCutRatio,
      },
      impact: {
        durationDeltaDays: -option.achievedDays,
        costDelta: option.addedCost,
        note: option.riskNote,
      },
    };
  }

  const maxShiftDays = clamp(operation.maxShiftDays, 1, 60);
  const result = levelResources(project, { maxShiftDays });
  const bullets = result.moves
    .slice(0, 6)
    .map(
      (move) =>
        `${move.code} ${move.name}：顺延 ${move.shiftDays} 天（原总浮时 ${move.totalFloat} 天）`,
    );
  if (bullets.length === 0) bullets.push('无需顺延即可满足容量，或当前容量不足需增配。');
  bullets.push(...result.notes);

  return {
    id: nextProposalId('leveling'),
    intent: 'leveling',
    title: meta.title ?? `资源平衡（最大顺延 ${maxShiftDays} 天）`,
    summary:
      meta.summary ??
      `超配资源 ${result.baseline.overloadedResources} → ${result.leveled.overloadedResources} 项，工期增加 ${result.delayDays} 个工作日。`,
    bullets,
    provider: meta.provider ?? 'local',
    createdAt: new Date().toISOString(),
    requiresApproval: result.moves.length > 0,
    operation: { kind: 'leveling', maxShiftDays },
    impact: {
      durationDeltaDays: result.delayDays,
      costDelta: null,
      note: result.notes[result.notes.length - 1] ?? '',
    },
  };
}

/** 本地规则引擎：无需外部模型即可完成意图识别与提案生成。 */
export function buildLocalProposals(message: string, project: Project): AiProposal[] {
  const parsed = parseAiIntent(message);
  switch (parsed.intent) {
    case 'crash':
      return [
        buildProposalFromOperation(project, {
          kind: 'crash',
          targetDays: parsed.targetDays ?? 5,
          costCapRatio: 0.03,
          maxCutRatio: 0.4,
        }),
      ];
    case 'leveling':
      return [
        buildProposalFromOperation(project, {
          kind: 'leveling',
          maxShiftDays: parsed.maxShiftDays ?? 30,
        }),
      ];
    case 'weekly-report':
      return [weeklyReportProposal(project)];
    case 'explain':
      return [explainProposal(project)];
    default:
      return [unknownProposal()];
  }
}

/** 本地回退时的指标问答文本。 */
export function describeMetrics(project: Project): string {
  const schedule = computeSchedule(project);
  const evm = computeEvm(project, schedule).snapshot;
  return `SPI ${evm.spi.toFixed(2)} / CPI ${evm.cpi.toFixed(2)}，完成率 ${(evm.percentComplete * 100).toFixed(1)}%，预测完工 ${schedule.projectFinish}。`;
}

/**
 * 执行提案的白名单操作，返回候选项目（不修改入参）。
 * 说明性提案没有操作，调用会抛错。
 */
export function applyAiProposal(project: Project, proposal: AiProposal): Project {
  if (!proposal.operation) {
    throw new Error('该提案为说明性内容，无需写入项目。');
  }
  if (proposal.operation.kind === 'crash') {
    return crashProject(project, proposal.operation.targetDays, {
      costCapRatio: proposal.operation.costCapRatio,
      maxCutRatio: proposal.operation.maxCutRatio,
    }).project;
  }
  return levelResources(project, {
    maxShiftDays: proposal.operation.maxShiftDays,
  }).project;
}

export interface LlmProposalInput {
  intent?: unknown;
  title?: unknown;
  summary?: unknown;
  operation?: unknown;
}

/**
 * 校验大模型返回的提案：只接受白名单意图与数值范围，标题/摘要截断，
 * 任何越权字段都会被丢弃。无法识别时返回 null。
 */
export function sanitizeLlmProposal(
  input: LlmProposalInput,
  project: Project,
): AiProposal | null {
  const intent = input.intent;
  const title =
    typeof input.title === 'string' ? input.title.slice(0, 120) : undefined;
  const summary =
    typeof input.summary === 'string' ? input.summary.slice(0, 400) : undefined;

  if (intent === 'explain') {
    const base = explainProposal(project);
    return {
      ...base,
      provider: 'llm',
      title: title ?? base.title,
      summary: summary ?? base.summary,
    };
  }
  if (intent === 'weekly-report') {
    const base = weeklyReportProposal(project);
    return {
      ...base,
      provider: 'llm',
      title: title ?? base.title,
      summary: summary ?? base.summary,
    };
  }

  const operation = input.operation as
    | { kind?: unknown; targetDays?: unknown; maxShiftDays?: unknown; costCapRatio?: unknown; maxCutRatio?: unknown }
    | undefined;
  if (!operation || typeof operation !== 'object') return null;

  if (operation.kind === 'crash') {
    return buildProposalFromOperation(
      project,
      {
        kind: 'crash',
        targetDays: clamp(Number(operation.targetDays ?? 5), 1, 60),
        costCapRatio: Math.min(0.1, Math.max(0.005, Number(operation.costCapRatio ?? 0.03))),
        maxCutRatio: Math.min(0.6, Math.max(0.1, Number(operation.maxCutRatio ?? 0.4))),
      },
      { provider: 'llm', title, summary },
    );
  }
  if (operation.kind === 'leveling') {
    return buildProposalFromOperation(
      project,
      {
        kind: 'leveling',
        maxShiftDays: clamp(Number(operation.maxShiftDays ?? 30), 1, 60),
      },
      { provider: 'llm', title, summary },
    );
  }
  return null;
}
