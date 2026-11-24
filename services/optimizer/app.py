"""APCC 优化求解服务（OR-Tools CP-SAT）。

职责边界：
- 只负责求解「资源平衡」与「工期-成本权衡」的整数规划问题；
- 返回开始日索引或压缩天数，不生成日期，也不写项目数据；
- 日期换算、EAC、候选项目构造统一由 @apcc/core 在 API 层完成。
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Dict, List

import ortools
from fastapi import FastAPI
from ortools.sat.python import cp_model
from pydantic import BaseModel, Field

app = FastAPI(title="APCC Optimizer", version="0.1.0")

SCALE = 100  # 资源需求的小数放大倍数


class ResourceDemand(BaseModel):
    resourceId: str
    units: float = 0.0


class Predecessor(BaseModel):
    activityId: str
    type: str = "FS"
    lag: int = 0


class ActivityIn(BaseModel):
    id: str
    duration: int = 0
    resources: List[ResourceDemand] = Field(default_factory=list)
    predecessors: List[Predecessor] = Field(default_factory=list)
    earliestStart: int = 0
    rate: float = 0.0
    maxCut: int = 0


class LevelingRequest(BaseModel):
    activities: List[ActivityIn] = Field(default_factory=list)
    capacities: Dict[str, float] = Field(default_factory=dict)
    maxShiftDays: int = 30
    horizon: int = 400
    timeLimitSeconds: float = 4.0


class CrashRequest(BaseModel):
    activities: List[ActivityIn] = Field(default_factory=list)
    capacities: Dict[str, float] = Field(default_factory=dict)
    targetDays: int = 5
    costCap: float = 0.0
    horizon: int = 400
    timeLimitSeconds: float = 4.0


def _status_name(status: int) -> str:
    return {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.MODEL_INVALID: "MODEL_INVALID",
        cp_model.UNKNOWN: "UNKNOWN",
    }.get(status, "UNKNOWN")


def _add_precedence(model: cp_model.CpModel, acts, starts, ends) -> None:
    for act in acts:
        for pred in act.predecessors:
            if pred.activityId not in ends:
                continue
            pred_end = ends[pred.activityId]
            pred_start = starts[pred.activityId]
            start = starts[act.id]
            end = ends[act.id]
            if pred.type == "SS":
                model.Add(start >= pred_start + pred.lag)
            elif pred.type == "FF":
                model.Add(end >= pred_end + pred.lag)
            elif pred.type == "SF":
                model.Add(end >= pred_start + pred.lag)
            else:  # FS
                model.Add(start >= pred_end + pred.lag)


def _solve(
    activities: List[ActivityIn],
    capacities: Dict[str, float],
    horizon: int,
    time_limit: float,
    crash: bool,
    max_shift_days: int = 30,
    cost_cap: float = 0.0,
):
    model = cp_model.CpModel()
    starts: Dict[str, cp_model.IntVar] = {}
    ends: Dict[str, cp_model.IntVar] = {}
    cuts: Dict[str, cp_model.IntVar] = {}
    intervals = defaultdict(list)
    demands = defaultdict(list)
    cost_terms = []

    bound = max(1, horizon)

    for act in activities:
        duration = max(0, int(round(act.duration)))
        start = model.NewIntVar(0, bound, f"start_{act.id}")
        starts[act.id] = start

        if crash:
            max_cut = min(max(0, int(act.maxCut)), max(0, duration - 1))
            cut = model.NewIntVar(0, max_cut, f"cut_{act.id}")
            cuts[act.id] = cut
            effective = model.NewIntVar(0, duration, f"dur_{act.id}")
            model.Add(effective == duration - cut)
            if int(round(act.rate)) > 0 and max_cut > 0:
                cost_terms.append(cut * int(round(act.rate)))
        else:
            model.Add(start <= max(0, int(act.earliestStart)) + max(0, max_shift_days))
            effective = duration

        end = model.NewIntVar(0, bound, f"end_{act.id}")
        model.Add(end == start + effective)
        ends[act.id] = end

        if duration > 0:
            interval = model.NewIntervalVar(start, effective, end, f"interval_{act.id}")
            for demand in act.resources:
                capacity = capacities.get(demand.resourceId)
                if capacity is None or capacity <= 0 or demand.units <= 0:
                    continue
                intervals[demand.resourceId].append(interval)
                demands[demand.resourceId].append(int(round(demand.units * SCALE)))

    _add_precedence(model, activities, starts, ends)

    for resource_id, items in intervals.items():
        capacity = int(round(capacities[resource_id] * SCALE))
        model.AddCumulative(items, demands[resource_id], capacity)

    makespan = model.NewIntVar(0, bound, "makespan")
    if ends:
        model.AddMaxEquality(makespan, list(ends.values()))
    else:
        model.Add(makespan == 0)

    cost_expr = sum(cost_terms) if cost_terms else None
    if crash and cost_expr is not None and cost_cap > 0:
        model.Add(cost_expr <= int(round(cost_cap)))

    # 第一阶段：最小化工期
    model.Minimize(makespan)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.5, time_limit)
    solver.parameters.num_search_workers = 4
    solver.parameters.random_seed = 1
    status = solver.Solve(model)
    status_name = _status_name(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"status": status_name, "solveSeconds": solver.WallTime()}

    best_makespan = int(round(solver.Value(makespan)))
    model.Add(makespan <= best_makespan)

    # 第二阶段：在最优工期下最小化追加成本或开始日之和
    if crash and cost_expr is not None:
        model.Minimize(cost_expr)
    elif starts:
        model.Minimize(sum(starts.values()))
    solver2 = cp_model.CpSolver()
    solver2.parameters.max_time_in_seconds = max(0.5, time_limit)
    solver2.parameters.num_search_workers = 4
    solver2.parameters.random_seed = 1
    status2 = solver2.Solve(model)
    if status2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        final = solver2
    else:
        final = solver

    result = {
        "status": status_name,
        "solveSeconds": round(final.WallTime(), 3),
        "makespan": best_makespan,
        "starts": {act.id: int(round(final.Value(starts[act.id]))) for act in activities},
    }
    if crash:
        result["cuts"] = {
            act.id: int(round(final.Value(cuts[act.id])))
            for act in activities
            if act.id in cuts
        }
        result["addedCost"] = (
            int(round(final.Value(cost_expr))) if cost_expr is not None else 0
        )
    return result


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "apcc-optimizer",
        "ortools": ortools.__version__,
        "solver": "CP-SAT",
    }


@app.post("/v1/leveling")
def leveling(request: LevelingRequest) -> dict:
    started = time.time()
    result = _solve(
        request.activities,
        request.capacities,
        request.horizon,
        request.timeLimitSeconds,
        crash=False,
        max_shift_days=request.maxShiftDays,
    )
    result["solver"] = "ortools"
    result["kind"] = "leveling"
    result["elapsedSeconds"] = round(time.time() - started, 3)
    return result


@app.post("/v1/crash")
def crash(request: CrashRequest) -> dict:
    started = time.time()
    result = _solve(
        request.activities,
        request.capacities,
        request.horizon,
        request.timeLimitSeconds,
        crash=True,
        cost_cap=request.costCap,
    )
    result["solver"] = "ortools"
    result["kind"] = "crash"
    result["elapsedSeconds"] = round(time.time() - started, 3)
    return result
