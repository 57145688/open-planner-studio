import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyAiProposal,
  buildLocalProposals,
  parseAiIntent,
  sampleProject,
  sanitizeLlmProposal,
} from '../src/index';

test('解析中文请求中的意图与天数', () => {
  assert.deepEqual(parseAiIntent('把关键路径压缩 7 天'), {
    intent: 'crash',
    targetDays: 7,
  });
  assert.deepEqual(parseAiIntent('做一次资源平衡，限制顺延 20 天'), {
    intent: 'leveling',
    maxShiftDays: 20,
  });
  assert.equal(parseAiIntent('解释一下 SPI 为什么偏低').intent, 'explain');
  assert.equal(parseAiIntent('生成本周周报').intent, 'weekly-report');
  assert.equal(parseAiIntent('今天天气如何').intent, 'unknown');
});

test('本地引擎生成赶工提案并计算影响量', () => {
  const project = sampleProject();
  const [proposal] = buildLocalProposals('把工期压缩 6 天', project);
  assert.equal(proposal.intent, 'crash');
  assert.equal(proposal.provider, 'local');
  assert.equal(proposal.operation?.kind, 'crash');
  assert.ok(proposal.impact.durationDeltaDays !== null);
  assert.ok((proposal.impact.durationDeltaDays ?? 0) <= 0);
  assert.ok((proposal.impact.costDelta ?? 0) > 0);
  assert.equal(proposal.requiresApproval, true);
});

test('本地引擎生成资源平衡提案', () => {
  const project = sampleProject();
  const [proposal] = buildLocalProposals('做一次资源平衡', project);
  assert.equal(proposal.intent, 'leveling');
  assert.equal(proposal.operation?.kind, 'leveling');
  assert.ok(proposal.bullets.length > 0);
  assert.equal(proposal.requiresApproval, true);
});

test('应用提案返回新的候选项目且不修改原项目', () => {
  const project = sampleProject();
  const before = structuredClone(project);
  const [proposal] = buildLocalProposals('压缩 4 天', project);
  const candidate = applyAiProposal(project, proposal);
  assert.notEqual(candidate, project);
  assert.deepEqual(project, before);
  assert.ok(
    candidate.activities.some(
      (activity, index) => activity.durationDays !== project.activities[index].durationDays,
    ),
  );
});

test('说明性提案不可写入项目', () => {
  const [proposal] = buildLocalProposals('解释 SPI', sampleProject());
  assert.equal(proposal.operation, null);
  assert.throws(() => applyAiProposal(sampleProject(), proposal), /说明性内容/);
});

test('周报提案包含关键指标', () => {
  const [proposal] = buildLocalProposals('生成周报', sampleProject());
  assert.equal(proposal.intent, 'weekly-report');
  const text = proposal.bullets.join('\n');
  assert.match(text, /SPI/);
  assert.match(text, /EAC/);
  assert.match(text, /预测完工/);
});

test('大模型提案仅接受白名单操作并裁剪数值', () => {
  const project = sampleProject();

  const rejected = sanitizeLlmProposal(
    { intent: 'crash', operation: { kind: 'delete-all' } },
    project,
  );
  assert.equal(rejected, null);

  const accepted = sanitizeLlmProposal(
    {
      intent: 'crash',
      title: '模型建议赶工',
      operation: { kind: 'crash', targetDays: 999, costCapRatio: 99, maxCutRatio: -1 },
    },
    project,
  );
  assert.ok(accepted);
  assert.equal(accepted.provider, 'llm');
  assert.equal(accepted.operation?.kind, 'crash');
  if (accepted.operation?.kind === 'crash') {
    assert.equal(accepted.operation.targetDays, 60);
    assert.ok(accepted.operation.costCapRatio <= 0.1);
    assert.ok(accepted.operation.maxCutRatio >= 0.1);
  }

  const leveling = sanitizeLlmProposal(
    { intent: 'leveling', operation: { kind: 'leveling', maxShiftDays: 500 } },
    project,
  );
  assert.ok(leveling);
  if (leveling.operation?.kind === 'leveling') {
    assert.equal(leveling.operation.maxShiftDays, 60);
  }
});
