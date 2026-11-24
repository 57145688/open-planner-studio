import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBimModel, exportIfc, sampleProject } from '../src/index';

test('4D 模型构件数量、类型统计与 GUID 唯一性', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  assert.equal(model.elements.length, 138);
  assert.deepEqual(model.typeCounts, {
    IfcSlab: 6,
    IfcColumn: 36,
    IfcBeam: 12,
    IfcFooting: 6,
    IfcWall: 28,
    IfcWindow: 24,
    IfcDoor: 6,
    IfcRoof: 1,
    IfcBuildingElementProxy: 19,
  });
  assert.equal(model.levels.length, 6);

  const guids = new Set(model.elements.map((element) => element.guid));
  assert.equal(guids.size, model.elements.length);
  for (const element of model.elements) {
    assert.equal(element.guid.length, 22);
    assert.ok(model.byGuid[element.guid], `byGuid 缺少 ${element.guid}`);
  }
});

test('所有构件均绑定到项目中存在的活动', () => {
  const project = sampleProject();
  const model = buildBimModel(project);
  const activityIds = new Set(project.activities.map((activity) => activity.id));
  for (const element of model.elements) {
    assert.ok(activityIds.has(element.activityId), `${element.name} 绑定了不存在的活动`);
  }
});

test('导出的 IFC4 文本包含项目结构与全部构件', () => {
  const model = buildBimModel(sampleProject());
  const text = exportIfc(model);
  assert.match(text, /ISO-10303-21/);
  assert.match(text, /IFCPROJECT\(/);
  assert.ok(text.trimEnd().endsWith('END-ISO-10303-21;'));
  for (const element of model.elements) {
    assert.ok(text.includes(element.guid), `IFC 文本缺少构件 ${element.name}`);
  }
});
