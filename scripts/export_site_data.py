#!/usr/bin/env python3
"""Export the landing page's data from bam_impedance_controller's evidence. Every number the page shows comes from here.

    python3 scripts/export_site_data.py            # read the evidence, recompute the ceiling table, re-run the replay picks if stale
    python3 scripts/export_site_data.py --picks    # force the replay picks to re-run (<= 4 sim processes)

Inputs (read only):
- the controller package on its lane: LANE (stability.host_wn_ceiling for the ceiling table; sim.pick.run_case for the replays);
- the evidence: EVIDENCE/results.json, impact/impact_study.json, oracle/{kpis,evidence}.json, oracle/whatifs-*.json, the PNG plots and
  the hero video;
- the Codex judge's verdicts: AUDITS/2026-10-26-impedance-impact-r{1..9}-verdict.md.

Outputs (written into the site, all deterministic for the same inputs - no wall-clock stamps):
- site/data/site.json: the page's facts and tables, each with the file it came from (``sources``). WHY not site/public/: Landing.vue
  imports it at build time, and Vite refuses a JavaScript import from the public directory ("Assets in public directory cannot be
  imported from JavaScript"); out of public/ it is bundled into the page and not served as a separate file;
- site/public/data/picks.json + site/public/models/pick_scene.xml: MuJoCo replays of real sim runs and the scene they run in;
- site/public/media/*: the hero video, its poster and the plots, copied as is.

WHY one exporter and a data file, not numbers typed into the page (the brief, 2026-10-27): the oracle study is still being wrapped
up; re-running this re-reads every input, so the page follows the evidence instead of a copy that goes stale.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

LANE = Path("/home/bam/bam_ws/.claude/worktrees/bam-impedance-controller/src/core/mdp/agent/controllers/bam_impedance_controller")
LANE_PYTHON = LANE / ".venv" / "bin" / "python"
EVIDENCE = Path("/home/bam/bam_ws/reports/media/impedance-modes-2026-10-26")
AUDITS = Path("/home/bam/bam_ws/reports/media/audits")
SITE = Path(__file__).resolve().parent.parent / "site"
DATA_OUT = SITE / "public" / "data"
MEDIA_OUT = SITE / "public" / "media"
SITE_JSON = SITE / "data" / "site.json"
MODEL_OUT = SITE / "public" / "models" / "pick_scene.xml"

# the replays: real sim runs, re-run with frames (the comparison's own cases, read back from results.json)
REPLAY_ROWS = ("stiff", "host_spring", "spring + host_spring")
REPLAY_DELTAS_M = (0.01, 0.02)
REPLAY_FRAME_HZ = 200.0
REPLAY_WINDOW_S = (0.50, 2.00)  # metric time: approach -> touch -> dwell -> push -> lift (the hero video's window)
MAX_WORKERS = 4  # the brief: another agent may be computing

# the interactive ceiling chart's grid (stability.host_wn_ceiling, zeta 1)
CEILING_RATES_HZ = (50.0, 100.0, 250.0, 500.0, 1000.0)
CEILING_DELAYS_MS = tuple(round(0.5 * step, 1) for step in range(0, 31))  # 0 .. 15 ms

MEDIA = {
    "hero-impedance-modes.mp4": EVIDENCE / "hero-impedance-modes.mp4",
    "hero-poster.png": EVIDENCE / "hero-still-1.png",
    "fz-delta+10mm.png": EVIDENCE / "fz-delta+10mm.png",
    "stiffness-ellipses.png": EVIDENCE / "stiffness-ellipses.png",
    "rate-delay-heatmap.png": EVIDENCE / "rate-delay-heatmap.png",
    "approach-speed.png": EVIDENCE / "approach-speed.png",
    "impact-anticipation.png": EVIDENCE / "impact" / "impact-anticipation.png",
    "impact-masses.png": EVIDENCE / "impact" / "impact-masses.png",
}


def ensure_lane_python() -> None:
    """Re-exec under the lane's venv (numpy, mujoco, the package) unless we already have it."""

    try:
        import bam_impedance_controller  # noqa: F401
        import numpy  # noqa: F401
    except ImportError:
        if not LANE_PYTHON.exists():
            raise SystemExit(f"needs the controller lane's venv at {LANE_PYTHON}")
        env = {key: value for key, value in os.environ.items() if key != "VIRTUAL_ENV"}
        os.execve(str(LANE_PYTHON), [str(LANE_PYTHON), *sys.argv], env)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def load(path: Path):
    return json.loads(path.read_text())


def r(value, digits: int = 3):
    """Round for the page (None and non-finite stay None)."""

    if value is None or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return round(float(value), digits)


class Sources:
    """Every input file the export read, with a short hash, so the page can say where each number came from."""

    def __init__(self) -> None:
        self.files: dict[str, dict] = {}

    def add(self, key: str, path: Path, what: str) -> Path:
        self.files[key] = {"path": str(path), "sha256_12": sha(path), "what": what}
        return path


# ---------------------------------------------------------------------------------------------------------------- the comparison


def held(metrics: dict) -> bool:
    return bool(metrics.get("converged")) and not metrics.get("flag")


def comparison(results: dict) -> dict:
    """The comparison table (results.json's own summary_table and probe_table), the headline ranges and the ringing/latency rows."""

    runs = results["runs"]
    by_key = {}
    for run in runs:
        case = run.get("case") or {}
        if "surface_offset_m" not in case:  # the stiffness probe's runs have their own case shape
            continue
        by_key[(run["group"], run["row"], round(1e3 * case["surface_offset_m"]), case["friction"])] = run

    arm_rows = ("stiff", "torque", "joint", "joint_coupled", "host_spring")
    arm_peaks = [by_key[("delta", row, 10, "ur5e")]["metrics"]["impact_peak_fz_n"] for row in arm_rows
                 if held(by_key[("delta", row, 10, "ur5e")]["metrics"])]
    series = by_key[("delta", "spring + host_spring", 10, "ur5e")]["metrics"]
    spring = by_key[("delta", "spring", 10, "ur5e")]["metrics"]
    probe = {row["controller"]: row for row in results["probe_table"]}
    held_runs = sum(1 for run in runs if run["group"] != "probe" and held(run.get("metrics") or {}))
    comparison_runs = [run for run in runs]
    return {
        "summary_table": results["summary_table"],
        "probe": {name: {"error_mean": r(row["relative_error_mean"], 4), "error_max": r(row["relative_error_max"], 4),
                         "tilt_deg": r(row["soft_axis_angle_deg_mean"], 2), "flagged": row["flagged"]} for name, row in probe.items()},
        "headline": {
            "series_peak_n": r(series["impact_peak_fz_n"], 1),
            "series_dwell_mean_n": r(series["dwell_fz_mean_n"], 1),
            "series_dwell_std_n": r(series["dwell_fz_std_n"], 1),
            "spring_peak_n": r(spring["impact_peak_fz_n"], 1),
            "arm_peak_min_n": r(min(arm_peaks), 1),
            "arm_peak_max_n": r(max(arm_peaks), 1),
            "arm_rows": list(arm_rows),
        },
        "runs_total": len(comparison_runs),
        "runs_diverged": sum(1 for run in runs if (run.get("metrics") or {}).get("diverged")),
        "held_note": "350 of 384 comparison runs held (the README's ledger; 'held' = the three-rate and perturbation checks)",
        "latency": [{key: (r(value, 2) if isinstance(value, float) else value) for key, value in row.items()} for row in results["latency_summary"]],
        "speed": [{"controller": row["controller"], "speed": row["contact_speed_m_s"], "peak_n": r(row["impact_peak_fz_n"], 1),
                   "model_sticking_n": r(row["impact_model_sticking_n"], 1), "mass_sticking_kg": r(row["mass_sticking_kg"], 2)}
                  for row in results["speed_summary"]],
        "ringing": [{"controller": row["controller"], "contact_n_m": row["contact_n_m"], "std_n": r(row["dwell_fz_std_n"], 2),
                     "in_contact": r(row.get("dwell_contact_fraction"), 2)} for row in results["ringing_summary"]],
        "base": {"stiffness": results["base_case"]["stiffness"], "host_rate_hz": results["base_case"]["host_rate_hz"],
                 "host_delay_ms": r(1e3 * results["base_case"]["host_delay_s"], 1),
                 "contact_n_m": results["base_case"]["contact_stiffness_n_m"], "contact_b": results["base_case"]["contact_damping_n_s_m"],
                 "compensator": results["base_case"]["compensator"]},
        "phases": results["phases"],
        "video": {"delta_mm": results["video"]["delta_mm"], "speed": results["video"]["speed"], "seconds": r(results["video"]["seconds"], 1),
                  "peaks_n": {row: r(value, 2) for row, value in results["video"]["fz_peaks_n"].items()}},
        "reflected_mass_kg": r(results["context"]["reflected_mass_kg"], 2),
        "generated_at": results["generated_at"],
    }


# ---------------------------------------------------------------------------------------------------------------- the impact study


def impact(study: dict, results: dict) -> dict:
    """Arm builds, contact-material sensitivity, the drop fixture and the implemented loop's boundary."""

    builds = []
    for row in study["builds"]["rows"]:
        build, controller, contact, speed, _anticipate, friction = row["label"]
        metrics = row["metrics"]
        builds.append({"build": build, "controller": controller, "contact_n_m": contact, "speed": speed, "friction": friction,
                       "peak_30ms_n": r(metrics.get("peak_first_30ms_n"), 1), "peak_100ms_n": r(metrics.get("impact_peak_fz_n"), 1),
                       "after_touch_ms": r(metrics.get("peak_after_touch_ms"), 1), "held": held(metrics)})
    sensitivity = {}
    for row in study["sensitivity"]["rows"]:
        controller, damping, stiffness, noslip = row["label"][:4]
        if noslip and stiffness == 1.0e5 and controller in ("stiff", "spring"):
            sensitivity.setdefault(str(int(damping)), {})[controller] = r(row["metrics"]["impact_peak_fz_n"], 1)
    for values in sensitivity.values():
        values["ratio"] = r(values["stiff"] / values["spring"], 2)
    drop = {}
    for row in study["single_joint"]:
        drop[row["label"]] = {"peak_n": r(row["peak_n"], 2), "rate_hz": row["rate_hz"], "converged": row["converged"]}
    # the judge's drop fixture (a legged robot's foot): its parameters live in impact_study.py's SINGLE, its masses in the JSON
    import ast

    source = (LANE / "docs" / "impact_study.py").read_text()
    single = ast.literal_eval(re.search(r"^SINGLE = (\{.*\})$", source, flags=re.M).group(1))
    first = study["single_joint"][0]
    drop_fixture = {"trunk_kg": single["trunk_kg"], "link_m": single["link_m"], "foot_kg": single["tip_kg"], "rotor_kg_m2": single["rotor_kg_m2"],
                    "speed_m_s": single["speed_m_s"], "ground_n_m": single["stiffness_n_m"], "free_contact_mass_kg": r(first["free_contact_mass_kg"], 4),
                    "passive_free_mass_n": r(first["passive_free_mass_n"], 1), "passive_trunk_mass_n": r(first["passive_trunk_mass_n"], 1)}
    boundary = {mode: {"ideal_wn": r(study["boundary"][mode]["arm"]["ideal_wn"], 1), "measured_wn": r(study["boundary"][mode]["arm"]["measured_wn"], 1),
                       "ratio": r(study["boundary"][mode]["arm"]["ratio"], 3)} for mode in ("torque", "host_spring")}
    return {"builds": builds, "contact_b_sensitivity": sensitivity, "drop": drop, "drop_fixture": drop_fixture, "boundary": boundary}


# ---------------------------------------------------------------------------------------------------------------- the oracle study


def oracle(kpis: dict, evidence: dict, whatifs: dict[str, dict]) -> dict:
    cells = []
    for name in evidence["cell_order"]:
        cell = evidence["cells"].get(name)
        if not cell:
            continue
        spec = cell["cell"]
        columns = {}
        for column, value in cell["columns"].items():
            columns[column] = {"cost": r(value["cost"], 3), "admissible": value["admissible"], "converged": value["converged"]}
        ideal = evidence.get("ideal", {}).get(name) or {}
        oracle_cost = (cell.get("oracle") or {}).get("cost")
        cells.append({
            "cell": name, "controller": spec["controller"], "compensator": spec["compensator"], "friction": spec["friction"],
            "build": spec["arm_build"], "columns": columns, "oracle": r(oracle_cost, 3), "ideal": r(ideal.get("cost"), 3),
            "regret": r(cell.get("regret"), 4), "seed_loss": r(cell.get("seed_loss"), 4), "impl_loss": r(ideal.get("implementation_loss"), 4),
        })
    k = kpis["kpis"]
    summary = {
        "I1": {"met": k["I1"]["met"], "measured": k["I1"]["measured"], "worst_static": r(k["I1"]["worst_static"], 1),
               "corrected_static": r(kpis["corrected"]["I1"]["worst_static"], 3), "corrected_dynamic": r(kpis["corrected"]["I1"]["worst_dynamic"], 3),
               "corrected_held": kpis["corrected"]["I1"]["converged_rows"], "corrected_rows": kpis["corrected"]["I1"]["gated_rows"]},
        "I2": {"met": k["I2"]["met"], "misses": [cell for cell, ok in k["I2"]["per_cell"].items() if not ok]},
        "I3": {"met": k["I3"]["met"], "s1q_seed_loss": r(k["I3"]["per_cell"]["S1q"]["seed_loss"], 3)},
        "I4": {"met": k["I4"]["met"], "worst_regret": r(k["I4"]["worst_regret"], 4),
               "regrets": {cell: r(v["regret"], 4) for cell, v in k["I4"]["per_cell"].items()}, "no_oracle": k["I4"]["no_admissible_oracle"]},
        "I5": {"met": k["I5"]["met"], "share": r(k["I5"]["admissible_share"], 3), "points": k["I5"]["points"], "worst_regret": r(k["I5"]["worst_regret"], 2)},
        "I6": {"met": k["I6"]["met"], "per_cell": {cell: r(v["implementation_loss"], 3) for cell, v in k["I6"]["per_cell"].items()}},
        "I7": {"met": k["I7"]["met"], "diverged": k["I7"]["diverged"], "pick_runs": k["I7"]["pick_runs"]},
    }
    readiness = {"met": kpis["readiness"]["met"], "parts": kpis["readiness"]["parts"], "cells": kpis["readiness"]["cells"],
                 "corrected_met": kpis["readiness_corrected"]["met"], "corrected_parts": kpis["readiness_corrected"]["parts"]}
    what = {}
    for key, document in whatifs.items():
        rows = document.get("rows")
        what[key] = {
            "cell": document.get("cell"), "law": document.get("law"), "status": "ok" if rows else "re-running (no rows in the file yet)",
            "rows": [{"pick": row["pick"], "whatif": row["whatif"], "cost": r(row["cost"], 3), "admissible": row["admissible"],
                      "rejections": row["rejections"], "gate_tapes": row["gate_tapes"], "converged": row["converged"]} for row in rows or []],
            "pose": {"study_zy": r(document["pose"]["study_centre"]["zy_over_zz"], 3), "best_zy": r(document["pose"]["best"]["zy_over_zz"], 3),
                     "best_centre": document["pose"]["best"]["centre"]} if document.get("pose") else None,
        }
    compute = evidence.get("compute", {})
    return {"cells": cells, "kpis": summary, "readiness": readiness, "whatifs": what,
            "compute": {"pick_runs": compute.get("pick_runs"), "wall_h": r((compute.get("wall_s") or 0) / 3600, 2), "diverged": compute.get("diverged"),
                        "workers": evidence.get("workers"), "code_commit": evidence.get("code_commit"), "finished_at": evidence.get("finished_at")},
            "budget": evidence["cells"]["S1q"]["budget"], "ceilings": evidence.get("ceilings")}


# ---------------------------------------------------------------------------------------------------------------- the judge


def judge(sources: Sources) -> dict:
    """The Codex impact judge's nine rounds: each verdict file's verdict and headline, the findings each round raised (the controller's
    docs/Log.md headings: "the Codex impact judge, round N: FIX (F1-F4)"), and round 9's reproduced numbers."""

    log = sources.add("log", LANE / "docs" / "Log.md", "the controller's design log (what each judge round changed)").read_text()
    raised = {int(number): findings for number, findings in re.findall(r"the Codex impact judge, round (\d+): \w+ \(([^)]*)\)", log)}
    rounds = []
    for number in range(1, 10):
        path = AUDITS / f"2026-10-26-impedance-impact-r{number}-verdict.md"
        if not path.exists():
            continue
        sources.add(f"verdict_r{number}", path, f"Codex impact judge, round {number} verdict")
        text = path.read_text()
        verdict = re.findall(r"Verdict:\s*\**\s*([A-Z]+)", text)
        headline = re.search(r"\*\*(.+?)\*\*", text)
        rounds.append({"round": number, "verdict": verdict[-1] if verdict else None, "headline": headline.group(1) if headline else None,
                       "raised": raised.get(number, "none")})
    r9 = (AUDITS / "2026-10-26-impedance-impact-r9-verdict.md").read_text()
    checks = re.search(r"\*\*(\d+) successful fresh-process checks\*\*", r9)
    drop = re.search(r"drop equations give \*\*([\d.]+) N soft versus ([\d.]+) N stiff\*\*", r9)
    f31 = re.search(r"B = 200 N·s/m \| ([\d.]+) N \| ([\d.]+) N \| ([\d.]+) N", r9)
    host = re.search(r"Host PD is stable at \*\*(\d+)\*\*, unstable at \*\*(\d+) rad/s\*\*; HOST_SPRING is stable at \*\*(\d+)\*\*, unstable at \*\*(\d+) rad/s\*\*", r9)
    return {
        "rounds": rounds,
        "r9": {
            "checks": int(checks.group(1)) if checks else None,
            "drop_equations_soft_n": float(drop.group(1)) if drop else None, "drop_equations_stiff_n": float(drop.group(2)) if drop else None,
            "f31_b200": [float(value) for value in f31.groups()] if f31 else None,
            "host_pd_stable_unstable": [int(host.group(1)), int(host.group(2))] if host else None,
            "host_spring_stable_unstable": [int(host.group(3)), int(host.group(4))] if host else None,
        },
    }


# ---------------------------------------------------------------------------------------------------------------- the ceiling table


def ceilings() -> dict:
    """stability.host_wn_ceiling over host rate x delay, both splits (zeta 1). The page interpolates nothing: it draws these points."""

    from bam_impedance_controller.stability import host_wn_ceiling

    table = {}
    for rate in CEILING_RATES_HZ:
        period = 1.0 / rate
        table[str(int(rate))] = {
            "host_pd": [r(host_wn_ceiling(period, delay / 1e3, 1.0, board_damping=False), 2) for delay in CEILING_DELAYS_MS],
            "host_spring": [r(host_wn_ceiling(period, delay / 1e3, 1.0, board_damping=True), 2) for delay in CEILING_DELAYS_MS],
        }
    at = {"host_pd": host_wn_ceiling(0.01, 0.007, 1.0, False), "host_spring": host_wn_ceiling(0.01, 0.007, 1.0, True)}
    return {"delays_ms": list(CEILING_DELAYS_MS), "rates_hz": [int(rate) for rate in CEILING_RATES_HZ], "zeta": 1.0, "table": table,
            "rack": {"rate_hz": 100, "delay_ms": 7, "host_pd": r(at["host_pd"], 1), "host_spring": r(at["host_spring"], 1),
                     "wn_ratio": r(at["host_spring"] / at["host_pd"], 2), "k_ratio": r((at["host_spring"] / at["host_pd"]) ** 2, 1)},
            "function": "bam_impedance_controller.stability.host_wn_ceiling(period_s, delay_s, damping_ratio=1, board_damping)"}


# ---------------------------------------------------------------------------------------------------------------- the replays


def _case_from_dict(raw: dict):
    from dataclasses import fields

    from bam_impedance_controller.sim.pick import PickCase
    from bam_impedance_controller.sim.reference import PickPlan
    from bam_impedance_controller.sim.scene import Compensator

    known = {field.name for field in fields(PickCase)}
    values = {key: value for key, value in raw.items() if key in known}
    values["compensator"] = Compensator(**raw["compensator"])
    plan_fields = {field.name for field in fields(PickPlan)}
    values["plan"] = PickPlan(**{key: (tuple(value) if isinstance(value, list) else value) for key, value in raw["plan"].items() if key in plan_fields})
    values["stiffness"] = tuple(values["stiffness"])
    if isinstance(values.get("damping_ratio"), list):
        values["damping_ratio"] = tuple(values["damping_ratio"])
    return PickCase(**values)


def _replay_job(job: tuple) -> dict:
    """In a worker: one comparison case at its held physics rate, with frames. Returns the window's joint paths, force and tip height."""

    row, raw_case, loop_hz, recorded_peak = job
    from dataclasses import replace

    import mujoco
    import numpy as np

    from bam_impedance_controller.sim.pick import rig_for, run_case
    from bam_impedance_controller.sim.reference import cartesian_reference

    case = replace(_case_from_dict(raw_case), loop_hz=loop_hz, frame_hz=REPLAY_FRAME_HZ)
    result = run_case(case, traces=True, diagnostics=False)
    scene = rig_for(case).scene
    model = scene.true
    names = [mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, joint) for joint in range(model.njnt)]
    addresses = [int(model.jnt_qposadr[joint]) for joint in range(model.njnt)]
    lo, hi = REPLAY_WINDOW_S
    frames = [(t, qpos) for t, qpos, _ in result["frames"] if lo - 1e-9 <= t <= hi + 1e-9]
    times = np.array([t for t, _ in frames])
    qpos = {name: [round(float(q[address]), 6) for _, q in frames] for name, address in zip(names, addresses)}
    trace = result["traces"]
    # the force at the frame rate, each sample the MAX of its bin, so a 2-4 ms touch peak survives the down-sampling
    t_trace, fz = np.asarray(trace["t"]), np.asarray(trace["fz"])
    half = 0.5 / REPLAY_FRAME_HZ
    fz_bins = [float(np.max(fz[(t_trace >= t - half) & (t_trace < t + half)], initial=0.0)) for t in times]
    tcp_z = np.interp(times, t_trace, np.asarray(trace["tcp"])[:, 2])
    reference = cartesian_reference(case.plan, scene.config.belt_surface_z, np.maximum(times, 0.0))[0]
    surface = scene.config.belt_surface_z + case.surface_offset_m
    metrics = result["metrics"]
    return {
        "row": row, "delta_mm": round(1e3 * case.surface_offset_m), "loop_hz": loop_hz,
        "t0": round(float(times[0]), 6), "dt": round(1.0 / REPLAY_FRAME_HZ, 6), "n": len(times),
        "qpos": qpos,
        "fz": [round(value, 2) for value in fz_bins],
        "tip_mm": [round(1e3 * (value - surface), 2) for value in tcp_z],  # the tcp's height over the TRUE surface
        "ref_mm": [round(1e3 * (value - surface), 2) for value in reference[:, 2]],  # the reference's, over the same surface
        "peak_n": round(float(metrics["impact_peak_fz_n"]), 2), "recorded_peak_n": round(float(recorded_peak), 2),
        "dwell_mean_n": round(float(metrics["dwell_fz_mean_n"]), 2), "dwell_std_n": round(float(metrics["dwell_fz_std_n"]), 2),
        "bounces": int(metrics["dwell_bounces"]),
    }


def scene_xml() -> str:
    """The pick scene the replays run in, for the browser: the sim's TRUE model (the PID tuner's capsule UR5e fixture, the suction tool,
    the compensator joint, the belt) plus a vertical slide on the belt so one file serves every delta. No meshes."""

    import mujoco

    from bam_impedance_controller.sim.scene import Compensator, SceneConfig, _arm_spec

    spec = _arm_spec(SceneConfig(compensator=Compensator()), true=True)
    spec.body("belt").add_joint(name="belt_z", type=mujoco.mjtJoint.mjJNT_SLIDE, axis=[0.0, 0.0, 1.0])
    spec.compile()
    xml = spec.to_xml()
    xml = re.sub(r"\s*<asset>.*?</asset>", "", xml, flags=re.S)  # the skybox: the page draws its own background
    xml = re.sub(r"<mujoco model=\"[^\"]*\">\s*<!--.*?-->", "<mujoco model=\"pick_scene\">\n  <!-- "
                 "bam_impedance_controller's conveyor-pick scene (sim/scene.py, the TRUE model) for the site's replays: the PID tuner's UR5e "
                 "fixture (kinematics and inertials of MuJoCo Menagerie's universal_robots_ur5e, BSD-3-Clause, drawn with capsules - see "
                 "NOTICE.md), the suction tool with its level-compensator slide, and the belt (belt_x along the belt, belt_z = the true "
                 "surface's offset delta). Written by scripts/export_site_data.py. -->", xml, count=1, flags=re.S)
    return xml


def replays(results: dict, workers: int, cache: Path) -> dict:
    jobs = []
    for run in results["runs"]:
        case = run.get("case") or {}
        if run["group"] == "delta" and run["row"] in REPLAY_ROWS and case["friction"] == "ur5e" and any(
                abs(case["surface_offset_m"] - delta) < 1e-9 for delta in REPLAY_DELTAS_M):
            jobs.append((run["row"], case, float(run["metrics"]["loop_hz"]), run["metrics"]["impact_peak_fz_n"]))
    jobs.sort(key=lambda job: (job[1]["surface_offset_m"], REPLAY_ROWS.index(job[0])))
    key = hashlib.sha256(json.dumps([[job[0], job[1], job[2]] for job in jobs], sort_keys=True).encode()).hexdigest()[:16]
    if cache.exists():
        previous = load(cache)
        if previous.get("key") == key:
            print(f"  replays: unchanged ({key}), kept {cache.name}")
            return previous
    from concurrent.futures import ProcessPoolExecutor
    from multiprocessing import get_context

    print(f"  replays: {len(jobs)} runs on {workers} workers (the held physics rates: {sorted({job[2] for job in jobs})} Hz)")
    with ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn")) as pool:
        tapes = list(pool.map(_replay_job, jobs))
    for tape in tapes:
        drift = abs(tape["peak_n"] - tape["recorded_peak_n"]) / max(tape["recorded_peak_n"], 0.5)
        tape["matches_recorded"] = drift <= 0.005
        print(f"    {tape['row']:>22} delta +{tape['delta_mm']} mm @ {tape['loop_hz'] / 1e3:g} kHz: peak {tape['peak_n']} N "
              f"(results.json {tape['recorded_peak_n']} N, {'same' if tape['matches_recorded'] else 'DIFFERENT'})")
    return {"key": key, "frame_hz": REPLAY_FRAME_HZ, "window_s": list(REPLAY_WINDOW_S), "phases": results["phases"],
            "rows": list(REPLAY_ROWS), "deltas_mm": [round(1e3 * delta) for delta in REPLAY_DELTAS_M],
            "arm_joints": ["shoulder_pan_joint", "shoulder_lift_joint", "elbow_joint", "wrist_1_joint", "wrist_2_joint", "wrist_3_joint"],
            "model": "/models/pick_scene.xml", "tapes": tapes}


# ---------------------------------------------------------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--picks", action="store_true", help="re-run the replay picks even if picks.json matches the cases")
    parser.add_argument("--no-picks", action="store_true", help="skip the replay picks (keep the existing picks.json)")
    parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    args = parser.parse_args(argv)
    workers = max(1, min(args.workers, MAX_WORKERS))
    ensure_lane_python()

    sources = Sources()
    results = load(sources.add("results", EVIDENCE / "results.json", "the MuJoCo comparison (bam-impedance compare): 384 runs, tables, probe"))
    study = load(sources.add("impact", EVIDENCE / "impact" / "impact_study.json", "the impact study: builds, contact sensitivity, drop fixture, boundary"))
    kpis = load(sources.add("kpis", EVIDENCE / "oracle" / "kpis.json", "the oracle study's KPIs and readiness"))
    evidence = load(sources.add("oracle", EVIDENCE / "oracle" / "evidence.json", "the oracle study's per-cell costs"))
    whatifs = {}
    for path in sorted((EVIDENCE / "oracle").glob("whatifs-*.json")):
        whatifs[path.stem.removeprefix("whatifs-")] = load(sources.add(path.stem, path, "an oracle what-if (diagnostics outside the study's definitions)"))
    sources.add("impact_study_py", LANE / "docs" / "impact_study.py", "the impact study's script (the drop fixture's parameters)")
    sources.add("readme", LANE / "README.md", "the controller's README (the verified wording the page quotes)")
    sources.add("review_page", EVIDENCE / "index.html", "the review page (the verified wording the page quotes)")
    try:
        commit = subprocess.run(["git", "-C", str(LANE), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        commit = None

    print("export_site_data: reading the evidence")
    document = {
        "schema": "impedance-site/1",
        "lane": {"branch": "claude/bam-impedance-controller", "commit": commit, "package": str(LANE)},
        "comparison": comparison(results),
        "impact": impact(study, results),
        "oracle": oracle(kpis, evidence, whatifs),
        "judge": judge(sources),
        "ceilings": ceilings(),
    }
    document["sources"] = sources.files
    DATA_OUT.mkdir(parents=True, exist_ok=True)
    SITE_JSON.parent.mkdir(parents=True, exist_ok=True)
    SITE_JSON.write_text(json.dumps(document, indent=1, sort_keys=False) + "\n")
    print(f"  wrote {SITE_JSON}")

    MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
    MODEL_OUT.write_text(scene_xml())
    print(f"  wrote {MODEL_OUT}")
    if not args.no_picks:
        cache = DATA_OUT / "picks.json"
        if args.picks and cache.exists():
            cache.unlink()
        picks = replays(results, workers, cache)
        cache.write_text(json.dumps(picks, separators=(",", ":")) + "\n")
        print(f"  wrote {cache} ({cache.stat().st_size / 1e3:.0f} kB)")

    MEDIA_OUT.mkdir(parents=True, exist_ok=True)
    for name, source in MEDIA.items():
        target = MEDIA_OUT / name
        if not target.exists() or sha(target) != sha(source):
            shutil.copyfile(source, target)
    print(f"  media: {len(MEDIA)} files in {MEDIA_OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
