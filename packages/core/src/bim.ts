import type { Project } from './types';

/**
 * 轻量 BIM 适配层。
 *
 * 这里用确定性的程序化几何表达一栋 6 层框架结构，并生成符合 IFC4 的 STEP 文本，
 * 由前端 web-ifc 解析出真实的构件几何，再把每个构件与进度活动绑定，实现 4D 回放。
 * 当 IFC 解析不可用时，前端可以退化到同一份构件清单的盒体渲染。
 */

export type BimElementType =
  | 'IfcSlab'
  | 'IfcColumn'
  | 'IfcBeam'
  | 'IfcFooting'
  | 'IfcWall'
  | 'IfcWindow'
  | 'IfcDoor'
  | 'IfcRoof'
  | 'IfcBuildingElementProxy';

export interface BimElement {
  /** IFC GlobalId（22 位 IFC base64） */
  guid: string;
  name: string;
  ifcType: BimElementType;
  /** 所属楼层，1..6 */
  level: number;
  /** 关联的进度活动 id */
  activityId: string;
  /** 构件尺寸，单位 m */
  size: { x: number; y: number; z: number };
  /** 构件中心点，单位 m，Z 轴向上 */
  position: { x: number; y: number; z: number };
}

export interface BimLevel {
  level: number;
  label: string;
  elevation: number;
  elementCount: number;
}

export interface BimModel {
  projectId: string;
  units: 'm';
  footprint: { width: number; depth: number };
  floorHeight: number;
  levels: BimLevel[];
  elements: BimElement[];
  byGuid: Record<string, BimElement>;
  /** activityId -> 构件 GlobalId 列表 */
  activityGuids: Record<string, string[]>;
  typeCounts: Record<BimElementType, number>;
  /** 数据来源说明 */
  source: string;
}

export const BIM_LAYOUT = {
  width: 24,
  depth: 16,
  floorHeight: 3.2,
  floors: 6,
  columnSize: 0.6,
  slabThickness: 0.2,
  beamWidth: 0.4,
  beamHeight: 0.7,
  footingSize: 2,
  footingThickness: 0.4,
} as const;

const GUID_PREFIX = '2O2Fr$t4X7Zf8NOew3FL';
const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** 生成 22 位 IFC GlobalId（前缀 20 位 + 序号 2 位）。 */
function makeGuid(sequence: number): string {
  let value = Math.max(0, Math.floor(sequence));
  let suffix = '';
  for (let i = 0; i < 2; i += 1) {
    suffix = GUID_CHARS[value % 64] + suffix;
    value = Math.floor(value / 64);
  }
  return `${GUID_PREFIX}${suffix}`;
}

const GRID_X = [2, 12, 22];
const GRID_Y = [2, 14];

export function buildBimModel(project: Project): BimModel {
  const { width, depth, floorHeight, floors, columnSize, slabThickness, beamWidth, beamHeight } =
    BIM_LAYOUT;
  const footingSize = BIM_LAYOUT.footingSize;
  const footingThickness = BIM_LAYOUT.footingThickness;

  const elements: BimElement[] = [];
  let sequence = 1;

  function push(element: Omit<BimElement, 'guid'>): void {
    elements.push({ ...element, guid: makeGuid(sequence) });
    sequence += 1;
  }

  // 基础承台：与“基础混凝土浇筑”绑定
  GRID_X.forEach((x, xi) => {
    GRID_Y.forEach((y, yi) => {
      push({
        name: `基础承台 J-${xi + 1}${yi + 1}`,
        ifcType: 'IfcFooting',
        level: 1,
        activityId: 'A06',
        size: { x: footingSize, y: footingSize, z: footingThickness },
        position: { x, y, z: -footingThickness / 2 },
      });
    });
  });

  for (let level = 1; level <= floors; level += 1) {
    const base = (level - 1) * floorHeight;
    const top = level * floorHeight;

    // 框架柱：与“钢筋与模板”活动绑定
    GRID_X.forEach((x, xi) => {
      GRID_Y.forEach((y, yi) => {
        push({
          name: `${level}F 框架柱 KZ-${xi + 1}${yi + 1}`,
          ifcType: 'IfcColumn',
          level,
          activityId: `F${level}-R`,
          size: { x: columnSize, y: columnSize, z: floorHeight },
          position: { x, y, z: base + floorHeight / 2 },
        });
      });
    });

    // 主梁：1F 为地梁，2F 起为楼面梁
    GRID_Y.forEach((y, yi) => {
      push({
        name: `${level}F 主梁 KL-${yi + 1}`,
        ifcType: 'IfcBeam',
        level,
        activityId: `F${level}-R`,
        size: { x: width, y: beamWidth, z: beamHeight },
        position: {
          x: width / 2,
          y,
          z: top - slabThickness - beamHeight / 2,
        },
      });
    });

    // 楼板：与“楼板混凝土浇筑”绑定
    push({
      name: `${level}F 楼板 LB`,
      ifcType: 'IfcSlab',
      level,
      activityId: `F${level}-C`,
      size: { x: width, y: depth, z: slabThickness },
      position: { x: width / 2, y: depth / 2, z: top - slabThickness / 2 },
    });

    // 外墙（砌体工程）
    const wallHeight = floorHeight - 0.4;
    const wallZ = base + wallHeight / 2;
    push({
      name: `${level}F 南外墙 Q-1`,
      ifcType: 'IfcWall',
      level,
      activityId: 'A20',
      size: { x: width, y: 0.2, z: wallHeight },
      position: { x: width / 2, y: 0.1, z: wallZ },
    });
    push({
      name: `${level}F 北外墙 Q-2`,
      ifcType: 'IfcWall',
      level,
      activityId: 'A20',
      size: { x: width, y: 0.2, z: wallHeight },
      position: { x: width / 2, y: depth - 0.1, z: wallZ },
    });
    push({
      name: `${level}F 西外墙 Q-3`,
      ifcType: 'IfcWall',
      level,
      activityId: 'A20',
      size: { x: 0.2, y: depth, z: wallHeight },
      position: { x: 0.1, y: depth / 2, z: wallZ },
    });
    push({
      name: `${level}F 东外墙 Q-4`,
      ifcType: 'IfcWall',
      level,
      activityId: 'A20',
      size: { x: 0.2, y: depth, z: wallHeight },
      position: { x: width - 0.1, y: depth / 2, z: wallZ },
    });

    // 门窗（门窗安装）
    [6, 18].forEach((wx, index) => {
      push({
        name: `${level}F 南窗 C-${index + 1}`,
        ifcType: 'IfcWindow',
        level,
        activityId: 'A25',
        size: { x: 2.2, y: 0.3, z: 1.5 },
        position: { x: wx, y: 0.1, z: base + 1.7 },
      });
      push({
        name: `${level}F 北窗 C-${index + 3}`,
        ifcType: 'IfcWindow',
        level,
        activityId: 'A25',
        size: { x: 2.2, y: 0.3, z: 1.5 },
        position: { x: wx, y: depth - 0.1, z: base + 1.7 },
      });
    });
    push({
      name: `${level}F 入口门 M-1`,
      ifcType: 'IfcDoor',
      level,
      activityId: 'A25',
      size: { x: 1.4, y: 0.3, z: 2.2 },
      position: { x: width / 2, y: 0.1, z: base + 1.1 },
    });

    // 机电：给排水管线（预留预埋）与通风管道（暖通安装）
    [4.5, 10.5].forEach((my, index) => {
      push({
        name: `${level}F 给排水管线 P-${index + 1}`,
        ifcType: 'IfcBuildingElementProxy',
        level,
        activityId: 'A22',
        size: { x: width - 2, y: 0.22, z: 0.22 },
        position: { x: width / 2, y: my, z: top - 0.55 },
      });
    });
    push({
      name: `${level}F 通风管道 D-1`,
      ifcType: 'IfcBuildingElementProxy',
      level,
      activityId: 'A23',
      size: { x: width - 2, y: 0.5, z: 0.4 },
      position: { x: width / 2, y: 7.5, z: top - 0.95 },
    });
  }

  // 机电立管贯通全部楼层
  const riserHeight = floors * floorHeight - 0.4;
  push({
    name: '机电竖井立管 P-0',
    ifcType: 'IfcBuildingElementProxy',
    level: 1,
    activityId: 'A22',
    size: { x: 0.3, y: 0.3, z: riserHeight },
    position: { x: width - 0.6, y: depth - 0.6, z: riserHeight / 2 },
  });

  // 屋面构造层与女儿墙
  const roofZ = floors * floorHeight;
  push({
    name: '屋面构造层 WM',
    ifcType: 'IfcRoof',
    level: floors,
    activityId: 'A21',
    size: { x: width + 0.6, y: depth + 0.6, z: 0.3 },
    position: { x: width / 2, y: depth / 2, z: roofZ + 0.15 },
  });
  const parapetZ = roofZ + 0.55;
  push({
    name: '屋面女儿墙-南',
    ifcType: 'IfcWall',
    level: floors,
    activityId: 'A21',
    size: { x: width + 0.6, y: 0.2, z: 0.5 },
    position: { x: width / 2, y: -0.2, z: parapetZ },
  });
  push({
    name: '屋面女儿墙-北',
    ifcType: 'IfcWall',
    level: floors,
    activityId: 'A21',
    size: { x: width + 0.6, y: 0.2, z: 0.5 },
    position: { x: width / 2, y: depth + 0.2, z: parapetZ },
  });
  push({
    name: '屋面女儿墙-西',
    ifcType: 'IfcWall',
    level: floors,
    activityId: 'A21',
    size: { x: 0.2, y: depth + 0.6, z: 0.5 },
    position: { x: -0.2, y: depth / 2, z: parapetZ },
  });
  push({
    name: '屋面女儿墙-东',
    ifcType: 'IfcWall',
    level: floors,
    activityId: 'A21',
    size: { x: 0.2, y: depth + 0.6, z: 0.5 },
    position: { x: width + 0.2, y: depth / 2, z: parapetZ },
  });

  const byId = new Map(project.activities.map((activity) => [activity.id, activity]));
  const byCode = new Map(project.activities.map((activity) => [activity.code, activity]));

  /** 先按活动 id 绑定；导入项目 id 变化时回退到 WBS 编码。 */
  const codeById: Record<string, string> = {
    A06: '2.3',
    A20: '4.1',
    A21: '4.2',
    A22: '5.1',
    A23: '5.2',
    A25: '6.2',
  };
  const resolveActivity = (seedKey: string): string => {
    const direct = byId.get(seedKey);
    if (direct) return direct.id;
    const match = /^F(\d+)-([RC])$/.exec(seedKey);
    const code = codeById[seedKey]
      ?? (match ? `3.${match[1]}.${match[2] === 'R' ? '1' : '2'}` : '');
    const fallback = code ? byCode.get(code) : undefined;
    return fallback ? fallback.id : '';
  };

  for (const element of elements) {
    element.activityId = resolveActivity(element.activityId);
  }

  const byGuid: Record<string, BimElement> = {};
  const activityGuids: Record<string, string[]> = {};
  const typeCounts: Record<BimElementType, number> = {
    IfcSlab: 0,
    IfcColumn: 0,
    IfcBeam: 0,
    IfcFooting: 0,
    IfcWall: 0,
    IfcWindow: 0,
    IfcDoor: 0,
    IfcRoof: 0,
    IfcBuildingElementProxy: 0,
  };

  const levels: BimLevel[] = [];
  for (let level = 1; level <= floors; level += 1) {
    levels.push({
      level,
      label: `${level}F`,
      elevation: (level - 1) * floorHeight,
      elementCount: elements.filter((element) => element.level === level).length,
    });
  }

  for (const element of elements) {
    byGuid[element.guid] = element;
    typeCounts[element.ifcType] += 1;
    if (element.activityId) {
      (activityGuids[element.activityId] ??= []).push(element.guid);
    }
  }

  return {
    projectId: project.id,
    units: 'm',
    footprint: { width, depth },
    floorHeight,
    levels,
    elements,
    byGuid,
    activityGuids,
    typeCounts,
    source: '程序化 IFC4 演示模型（6 层框架 + 砌体、门窗、屋面、机电，构件与活动 1:N 绑定）',
  };
}

const GUID_IFC_PREFIX = '3Q3Gs$u5Y8Ag9OPfx4GM';

function ifcGuid(sequence: number): string {
  let value = Math.max(0, Math.floor(sequence));
  let suffix = '';
  for (let i = 0; i < 2; i += 1) {
    suffix = GUID_CHARS[value % 64] + suffix;
    value = Math.floor(value / 64);
  }
  return `${GUID_IFC_PREFIX}${suffix}`;
}

function real(value: number): string {
  const rounded = Number(value.toFixed(4));
  if (Number.isInteger(rounded)) return `${rounded}.`;
  return String(rounded);
}

/**
 * 把构件清单写成 IFC4 STEP 文本。
 *
 * 构件几何为 IfcExtrudedAreaSolid + IfcRectangleProfileDef，空间结构为
 * Project → Site → Building → BuildingStorey，并通过 APCC_4D 属性集写入活动编号。
 */
export function exportIfc(model: BimModel): string {
  const body: string[] = [];
  let entityId = 0;
  let guidSeq = 100;

  const add = (text: string): number => {
    entityId += 1;
    body.push(`#${entityId}=${text};`);
    return entityId;
  };
  const guid = (): string => {
    guidSeq += 1;
    return ifcGuid(guidSeq);
  };
  const ref = (id: number): string => `#${id}`;
  const refs = (ids: number[]): string => `(${ids.map(ref).join(',')})`;

  const person = add(`IFCPERSON($,'APCC',$,$,$,$,$,$)`);
  const org = add(`IFCORGANIZATION($,'APCC Studio',$,$,$)`);
  const personOrg = add(`IFCPERSONANDORGANIZATION(${ref(person)},${ref(org)},$)`);
  const app = add(`IFCAPPLICATION(${ref(org)},'0.2.0','APCC Studio','APCC')`);
  const owner = add(`IFCOWNERHISTORY(${ref(personOrg)},${ref(app)},$,.ADDED.,$,$,$,0)`);

  const point0 = add(`IFCCARTESIANPOINT((0.,0.,0.))`);
  const dirX = add(`IFCDIRECTION((1.,0.,0.))`);
  const dirY = add(`IFCDIRECTION((0.,1.,0.))`);
  const dirZ = add(`IFCDIRECTION((0.,0.,1.))`);
  const axis0 = add(`IFCAXIS2PLACEMENT3D(${ref(point0)},${ref(dirZ)},${ref(dirX)})`);
  const context = add(
    `IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${ref(axis0)},${ref(dirY)})`,
  );
  const subContext = add(
    `IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ref(
      context,
    )},$,.MODEL_VIEW.,$)`,
  );

  const unitLength = add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`);
  const unitArea = add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
  const unitVolume = add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
  const units = add(`IFCUNITASSIGNMENT(${refs([unitLength, unitArea, unitVolume])})`);

  const projectId = add(
    `IFCPROJECT('${guid()}',${ref(owner)},'APCC Sample Tower',$,$,$,$,(${ref(
      context,
    )}),${ref(units)})`,
  );

  const sitePlacement = add(`IFCLOCALPLACEMENT($,${ref(axis0)})`);
  const siteId = add(
    `IFCSITE('${guid()}',${ref(owner)},'Site',$,$,${ref(
      sitePlacement,
    )},$,$,.ELEMENT.,(0,0,0),(0,0,0),0.,$,$)`,
  );
  const buildingPlacement = add(`IFCLOCALPLACEMENT(${ref(sitePlacement)},${ref(axis0)})`);
  const buildingId = add(
    `IFCBUILDING('${guid()}',${ref(owner)},'Building A',$,$,${ref(
      buildingPlacement,
    )},$,$,.ELEMENT.,$,$,$)`,
  );

  const point2d = add(`IFCCARTESIANPOINT((0.,0.))`);
  const axis2d = add(`IFCAXIS2PLACEMENT2D(${ref(point2d)},${ref(dirX)})`);

  const profileCache = new Map<string, number>();
  const profileFor = (x: number, y: number): number => {
    const key = `${x}x${y}`;
    const cached = profileCache.get(key);
    if (cached) return cached;
    const profile = add(
      `IFCRECTANGLEPROFILEDEF(.AREA.,$,${ref(axis2d)},${real(x)},${real(y)})`,
    );
    profileCache.set(key, profile);
    return profile;
  };

  const storeyPlacements = new Map<number, number>();
  const storeyIds: number[] = [];
  for (const level of model.levels) {
    const point = add(`IFCCARTESIANPOINT((0.,0.,${real(level.elevation)}))`);
    const axis = add(`IFCAXIS2PLACEMENT3D(${ref(point)},${ref(dirZ)},${ref(dirX)})`);
    const placement = add(`IFCLOCALPLACEMENT(${ref(buildingPlacement)},${ref(axis)})`);
    storeyPlacements.set(level.level, placement);
    const storey = add(
      `IFCBUILDINGSTOREY('${guid()}',${ref(owner)},'${level.label}',$,$,${ref(
        placement,
      )},$,$,.ELEMENT.,${real(level.elevation)})`,
    );
    storeyIds.push(storey);
  }

  const containedByStorey = new Map<number, number[]>();
  const expressedElements: { element: BimElement; id: number }[] = [];

  for (const element of model.elements) {
    const storeyPlacement = storeyPlacements.get(element.level) ?? storeyPlacements.get(1);
    if (!storeyPlacement) continue;
    const elevation = model.levels.find((level) => level.level === element.level)?.elevation ?? 0;
    const localZ = element.position.z - element.size.z / 2 - elevation;
    const point = add(
      `IFCCARTESIANPOINT((${real(element.position.x)},${real(element.position.y)},${real(
        localZ,
      )}))`,
    );
    const axis = add(`IFCAXIS2PLACEMENT3D(${ref(point)},${ref(dirZ)},${ref(dirX)})`);
    const placement = add(`IFCLOCALPLACEMENT(${ref(storeyPlacement)},${ref(axis)})`);

    const profile = profileFor(element.size.x, element.size.y);
    const solid = add(
      `IFCEXTRUDEDAREASOLID(${ref(profile)},${ref(axis0)},${ref(dirZ)},${real(
        element.size.z,
      )})`,
    );
    const shape = add(
      `IFCSHAPEREPRESENTATION(${ref(subContext)},'Body','SweptSolid',(${ref(solid)}))`,
    );
    const shapeRep = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${ref(shape)}))`);
    const name = element.name.replace(/'/g, '');
    const tag = `E${element.guid.slice(-2)}`;
    let id: number;
    switch (element.ifcType) {
      case 'IfcColumn':
        id = add(
          `IFCCOLUMN('${element.guid}',${ref(owner)},'${name}',$,$,${ref(
            placement,
          )},${ref(shapeRep)},'${tag}',.COLUMN.)`,
        );
        break;
      case 'IfcBeam':
        id = add(
          `IFCBEAM('${element.guid}',${ref(owner)},'${name}',$,$,${ref(
            placement,
          )},${ref(shapeRep)},'${tag}',.BEAM.)`,
        );
        break;
      case 'IfcFooting':
        id = add(
          `IFCFOOTING('${element.guid}',${ref(owner)},'${name}',$,$,${ref(
            placement,
          )},${ref(shapeRep)},'${tag}',.PAD_FOOTING.)`,
        );
        break;
      case 'IfcWall':
        id = add(
          `IFCWALL('${element.guid}',${ref(owner)},'${name}',$,$,${ref(
            placement,
          )},${ref(shapeRep)},'${tag}',.SOLIDWALL.)`,
        );
        break;
      case 'IfcWindow':
        id = add(
          `IFCWINDOW('${element.guid}',${ref(owner)},'${name}',$,$,${ref(
            placement,
          )},${ref(shapeRep)},'${tag}',${real(element.size.z)},${real(
            element.size.x,
          )},.WINDOW.)`,
        );
        break;
      case 'IfcDoor':
        id = add(
          `IFCDOOR('${element.guid}',${ref(owner)},'${name}',$,$,${ref(
            placement,
          )},${ref(shapeRep)},'${tag}',${real(element.size.z)},${real(
            element.size.x,
          )},.DOOR.)`,
        );
        break;
      case 'IfcRoof':
        id = add(
          `IFCROOF('${element.guid}',${ref(owner)},'${name}',$,$,${ref(
            placement,
          )},${ref(shapeRep)},'${tag}',.FLAT_ROOF.)`,
        );
        break;
      case 'IfcBuildingElementProxy':
        id = add(
          `IFCBUILDINGELEMENTPROXY('${element.guid}',${ref(owner)},'${name}',$,$,${ref(
            placement,
          )},${ref(shapeRep)},'${tag}',.NOTDEFINED.)`,
        );
        break;
      default:
        id = add(
          `IFCSLAB('${element.guid}',${ref(owner)},'${name}',$,$,${ref(
            placement,
          )},${ref(shapeRep)},'${tag}',.FLOOR.)`,
        );
        break;
    }
    expressedElements.push({ element, id });
    const bucket = containedByStorey.get(element.level) ?? [];
    bucket.push(id);
    containedByStorey.set(element.level, bucket);
  }

  model.levels.forEach((level, index) => {
    const storey = storeyIds[index];
    const ids = containedByStorey.get(level.level) ?? [];
    add(
      `IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',${ref(
        owner,
      )},'${level.label} Elements',$,${refs(ids)},${ref(storey)})`,
    );
  });

  add(`IFCRELAGGREGATES('${guid()}',${ref(owner)},$,$,${ref(projectId)},(${ref(siteId)}))`);
  add(`IFCRELAGGREGATES('${guid()}',${ref(owner)},$,$,${ref(siteId)},(${ref(buildingId)}))`);
  add(
    `IFCRELAGGREGATES('${guid()}',${ref(owner)},$,$,${ref(buildingId)},${refs(storeyIds)})`,
  );

  const byActivity = new Map<string, number[]>();
  for (const { element, id } of expressedElements) {
    if (!element.activityId) continue;
    const bucket = byActivity.get(element.activityId) ?? [];
    bucket.push(id);
    byActivity.set(element.activityId, bucket);
  }
  for (const [activityId, ids] of byActivity) {
    const property = add(
      `IFCPROPERTYSINGLEVALUE('ActivityId',$,IFCLABEL('${activityId}'),$)`,
    );
    const count = add(
      `IFCPROPERTYSINGLEVALUE('ElementCount',$,IFCLABEL('${ids.length}'),$)`,
    );
    const pset = add(
      `IFCPROPERTYSET('${guid()}',${ref(owner)},'APCC_4D',$,(${ref(property)},${ref(count)}))`,
    );
    add(
      `IFCRELDEFINESBYPROPERTIES('${guid()}',${ref(owner)},$,$,${refs(ids)},${ref(pset)})`,
    );
  }

  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    `FILE_NAME('${model.projectId}.ifc','2026-01-01T00:00:00',('APCC'),('APCC'),'APCC Studio','APCC','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
