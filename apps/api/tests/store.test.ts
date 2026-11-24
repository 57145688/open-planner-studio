import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sampleProject } from '@apcc/core';
import { ProjectStore } from '../src/store';

function withStore(run: (store: ProjectStore, file: string) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'apcc-store-'));
  const file = join(folder, 'projects.json');
  try {
    run(new ProjectStore(file), file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('保存项目后出现在列表并成为当前项目', () => {
  withStore((store) => {
    assert.deepEqual(store.list(), []);
    assert.equal(store.getActive(), null);

    const project = sampleProject();
    const summary = store.save(project);
    assert.equal(summary.version, 1);
    assert.equal(summary.activityCount, project.activities.length);
    assert.equal(store.list().length, 1);
    assert.equal(store.getActive()?.id, project.id);
    assert.equal(store.get(project.id)?.activities.length, project.activities.length);
  });
});

test('重复保存产生新版本并保留历史快照', () => {
  withStore((store) => {
    const project = sampleProject();
    store.save(project);
    const updated = { ...project, name: '更新后的项目' };
    const summary = store.save(updated);
    assert.equal(summary.version, 2);
    assert.equal(store.get(project.id)?.name, '更新后的项目');

    const versions = store.versions(project.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, 2);
    assert.equal(versions[1].version, 1);
    assert.equal(store.version(project.id, 1)?.name, project.name);
  });
});

test('恢复历史版本会生成新版本', () => {
  withStore((store) => {
    const project = sampleProject();
    store.save(project);
    store.save({ ...project, name: '第二版' });
    const restored = store.restore(project.id, 1);
    assert.equal(restored?.name, project.name);
    assert.equal(store.get(project.id)?.name, project.name);
    assert.equal(store.versions(project.id)[0].version, 3);
  });
});

test('数据写入磁盘后重新加载仍可读取', () => {
  withStore((_store, file) => {
    const project = sampleProject();
    new ProjectStore(file).save(project);
    const reloaded = new ProjectStore(file);
    assert.equal(reloaded.getActive()?.id, project.id);
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.get(project.id)?.activities.length, project.activities.length);
  });
});

test('返回的项目是副本，外部修改不影响存储', () => {
  withStore((store) => {
    const project = sampleProject();
    store.save(project);
    const copy = store.get(project.id);
    assert.ok(copy);
    copy.name = '被外部修改';
    assert.equal(store.get(project.id)?.name, project.name);
  });
});

test('删除项目会清理当前激活项', () => {
  withStore((store) => {
    const project = sampleProject();
    store.save(project);
    assert.equal(store.remove(project.id), true);
    assert.equal(store.get(project.id), null);
    assert.equal(store.getActive(), null);
    assert.equal(store.remove(project.id), false);
  });
});

test('历史版本最多保留 10 条', () => {
  withStore((store) => {
    const project = sampleProject();
    for (let index = 0; index < 12; index += 1) {
      store.save({ ...project, name: `版本 ${index + 1}` });
    }
    assert.equal(store.list()[0].version, 12);
    assert.equal(store.versions(project.id).length, 10);
  });
});
