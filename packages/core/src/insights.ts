import type {
  EvmSnapshot,
  Insight,
  Project,
  ResourceResult,
  ScheduleResult,
} from './types';

function formatMoney(value: number): string {
  return `${Math.round(value).toLocaleString('zh-CN')}`;
}

export function buildInsights(
  project: Project,
  schedule: ScheduleResult,
  evm: EvmSnapshot,
  resources: ResourceResult,
): Insight[] {
  const insights: Insight[] = [];

  if (evm.spi < 0.95) {
    insights.push({
      id: 'ins-spi',
      level: 'critical',
      title: `进度绩效 SPI ${evm.spi.toFixed(2)}，低于计划`,
      detail: `截止 ${project.dataDate}，已完成工作的预算价值低于计划值 ${formatMoney(
        Math.abs(evm.sv),
      )} ${project.currency}。`,
      action: '建议对关键路径做 3 种赶工情景比较，再提交审批。',
    });
  }

  if (evm.cpi < 0.95) {
    insights.push({
      id: 'ins-cpi',
      level: 'warning',
      title: `成本绩效 CPI ${evm.cpi.toFixed(2)}，已发生超支`,
      detail: `实际成本高于挣值 ${formatMoney(
        Math.abs(evm.cv),
      )} ${project.currency}，按当前趋势预测完工成本 ${formatMoney(
        evm.eac,
      )} ${project.currency}。`,
      action: '复核低效加班与材料损耗，避免用压缩后续工序掩盖成本问题。',
    });
  }

  const delayed = schedule.activities
    .filter((a) => a.critical && a.totalFloat < 0)
    .slice(0, 3);
  if (delayed.length > 0) {
    insights.push({
      id: 'ins-float',
      level: 'critical',
      title: '存在负浮时关键活动',
      detail: `${delayed
        .map((a) => `${a.code} ${a.name}`)
        .join('；')} 已影响承诺完工日期。`,
      action: '优先处理负浮时链，重新计算基准并保留旧基准审计记录。',
    });
  }

  const overload = resources.loads.filter(
    (r) => r.overloaded && r.type !== 'material',
  );
  if (overload.length > 0) {
    insights.push({
      id: 'ins-res',
      level: 'warning',
      title: `${overload.length} 项资源超配`,
      detail: overload
        .slice(0, 3)
        .map((r) => `${r.name} 峰值 ${r.peak}${r.unit}/日（容量 ${r.capacityPerDay}）`)
        .join('；'),
      action: '使用资源平衡预览（dry run）比较错峰与增配方案的工期影响。',
    });
  }

  const highRisks = project.risks.filter((r) => r.severity === 'high');
  if (highRisks.length > 0) {
    insights.push({
      id: 'ins-risk',
      level: 'warning',
      title: `${highRisks.length} 项高风险需要现场确认`,
      detail: highRisks.map((r) => r.title).join('；'),
      action: '由施工负责人确认工作面约束后，再决定是否写入正式计划。',
    });
  }

  if (insights.length === 0) {
    insights.push({
      id: 'ins-ok',
      level: 'info',
      title: '当前指标处于正常区间',
      detail: `SPI ${evm.spi.toFixed(2)} / CPI ${evm.cpi.toFixed(2)}，未发现显著偏差。`,
      action: '保持周度进度更新与月度 EVM 复算节奏。',
    });
  }

  return insights;
}
