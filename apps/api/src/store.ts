import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Project } from '@apcc/core';

/**
 * 基于 JSON 文件的项目存储：项目快照、版本历史与当前激活项目。
 * 单进程写入，使用临时文件 + 重命名保证不会写出半截文件。
 */

export interface StoredProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  activityCount: number;
  versions: number;
}

export interface ProjectVersionInfo {
  version: number;
  savedAt: string;
  name: string;
  activityCount: number;
}

interface ProjectVersion extends ProjectVersionInfo {
  project: Project;
}

interface ProjectRecord {
  project: Project;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
  history: ProjectVersion[];
}

interface StoreData {
  activeProjectId: string | null;
  projects: Record<string, ProjectRecord>;
}

const MAX_HISTORY = 10;

function emptyData(): StoreData {
  return { activeProjectId: null, projects: {} };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class ProjectStore {
  private data: StoreData = emptyData();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      if (parsed && typeof parsed === 'object' && parsed.projects) {
        this.data = parsed;
      }
    } catch {
      this.data = emptyData();
    }
  }

  private persist(): void {
    const folder = dirname(this.file);
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(temporary, this.file);
  }

  list(): StoredProjectSummary[] {
    return Object.values(this.data.projects)
      .map((record) => ({
        id: record.project.id,
        name: record.project.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        version: record.currentVersion,
        activityCount: record.project.activities.length,
        versions: record.history.length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Project | null {
    const record = this.data.projects[id];
    return record ? clone(record.project) : null;
  }

  getActive(): Project | null {
    const id = this.data.activeProjectId;
    return id ? this.get(id) : null;
  }

  save(project: Project): StoredProjectSummary {
    const now = new Date().toISOString();
    const existing = this.data.projects[project.id];
    const version = existing ? existing.currentVersion + 1 : 1;
    const snapshot: ProjectVersion = {
      version,
      savedAt: now,
      name: project.name,
      activityCount: project.activities.length,
      project: clone(project),
    };
    const record: ProjectRecord = {
      project: clone(project),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      currentVersion: version,
      history: [snapshot, ...(existing?.history ?? [])].slice(0, MAX_HISTORY),
    };
    this.data.projects[project.id] = record;
    this.data.activeProjectId = project.id;
    this.persist();
    return {
      id: project.id,
      name: project.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version,
      activityCount: project.activities.length,
      versions: record.history.length,
    };
  }

  setActive(id: string): boolean {
    if (!this.data.projects[id]) return false;
    this.data.activeProjectId = id;
    this.persist();
    return true;
  }

  remove(id: string): boolean {
    if (!this.data.projects[id]) return false;
    delete this.data.projects[id];
    if (this.data.activeProjectId === id) this.data.activeProjectId = null;
    this.persist();
    return true;
  }

  versions(id: string): ProjectVersionInfo[] {
    const record = this.data.projects[id];
    if (!record) return [];
    return record.history.map(({ version, savedAt, name, activityCount }) => ({
      version,
      savedAt,
      name,
      activityCount,
    }));
  }

  version(id: string, version: number): Project | null {
    const record = this.data.projects[id];
    const snapshot = record?.history.find((item) => item.version === version);
    return snapshot ? clone(snapshot.project) : null;
  }

  /** 恢复历史版本，并作为新版本写入，保留审计链。 */
  restore(id: string, version: number): Project | null {
    const snapshot = this.version(id, version);
    if (!snapshot) return null;
    this.save(snapshot);
    return snapshot;
  }
}
