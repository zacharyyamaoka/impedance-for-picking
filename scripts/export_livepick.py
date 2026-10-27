#!/usr/bin/env python3
"""Export what `<LivePick />` needs to run bam_impedance_controller's conveyor pick LIVE in the browser, and the Python runs it is
held to.

    python3 scripts/export_livepick.py              # models + config + the Python reference runs (<= 3 sim processes)
    python3 scripts/export_livepick.py --no-runs    # models + config only (keeps the existing reference runs)

Inputs (read only): the controller package on its lane (LANE): ``sim/scene.py`` (the TRUE and NOMINAL models, the contact
calibration), ``sim/pick.py`` (PickCase, run_case, the board gains via ``rig_for``), ``sim/reference.py`` (the pick path) and
bam_pid_tunning's arm truths (each joint's armature, dry friction, viscous damping and configured loop).

Outputs:
- site/public/models/pick_live_{true,nominal}[_light][_comp].xml: the scene's MJCF exactly as ``scene._arm_spec`` compiles it
  (capsules, no meshes) BEFORE the post-compile edits ``scene.build_scene`` makes - the browser repeats those edits itself, so the
  compiled constants (``body_invweight0``, hence the contact's ``efc_R``) are the Python's;
- site/public/data/livepick-config.json: per arm build the armature, friction and board gains (``tuning.tuner_limits`` on a zeta
  grid), the joint truths, the contact calibration and the pick plan;
- site/public/data/livepick-reference.json: the trajectory controller's grid for two plans (the browser's own path generator is
  checked against it) and REFERENCE runs - ``pick.run_case`` at the browser's 4 kHz - whose impact peak and dwell mean
  ``tests/unit/livepick.faithful.test.ts`` holds the browser loop to.

WHY a 6-significant-digit XML is fine: MuJoCo's writer rounds inertials to 6 digits; ``xml_roundtrip`` below measures what that
does to the joint-space mass matrix at the pick pose (~1e-7 relative) and records it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, replace
from pathlib import Path

LANE = Path("/home/bam/bam_ws/.claude/worktrees/bam-impedance-controller/src/core/mdp/agent/controllers/bam_impedance_controller")
LANE_PYTHON = LANE / ".venv" / "bin" / "python"
SITE = Path(__file__).resolve().parent.parent / "site" / "public"
MODELS = SITE / "models"
DATA = SITE / "data"
LOOP_HZ = 4000.0  # the browser's physics and board rate: the Python's converged arm-only rate (pick.CONVERGED_LOOP_HZ)
ZETA_GRID = (0.3, 0.5, 0.7, 1.0, 1.4, 2.0)  # the damping ratios the page offers; the board ceilings depend on zeta
HOST_RATES_HZ = (100.0, 250.0, 500.0, 1000.0)
BUILDS = {"ur5e": "UR-style (harmonic drive)", "qdd": "QDD (10:1)", "qdd_light": "Light QDD (links x0.3)"}
OBJECTS = {"rigid": {"label": "Rigid", "contact_stiffness_n_m": 1.0e5, "contact_damping_n_s_m": 200.0},
           "soft": {"label": "Soft", "contact_stiffness_n_m": 2.0e4, "contact_damping_n_s_m": 200.0}}
MAX_WORKERS = 3  # the brief: another agent computes in the same venv
HEADER = ("bam_impedance_controller's conveyor-pick scene for the site's live demo (<LivePick />), written by "
          "scripts/export_livepick.py from sim/scene.py's _arm_spec: the PID tuner's UR5e fixture (kinematics and inertials of MuJoCo "
          "Menagerie's universal_robots_ur5e, BSD-3-Clause, drawn with capsules - see NOTICE.md), the suction tool{comp}{belt}. "
          "Joint armature / friction / damping and the tip's contact solref are set after compiling, as scene.build_scene does.")

# The reference runs (all at the browser's 4 kHz, delta +10 mm: the object 10 mm taller than believed, met during the cruise).
# guard False: the host ceiling off (host_kp_max None) - PickCase has no such knob, so the worker patches pick.host_ceilings.
HIGH_K = (10000.0, 10000.0, 3000.0, 150.0, 150.0, 150.0)
REFERENCE_CONFIGS = [
    {"id": "stiff-rigid", "controller": "stiff", "object": "rigid"},
    {"id": "stiff-soft", "controller": "stiff", "object": "soft"},
    {"id": "host_spring-rigid", "controller": "host_spring", "object": "rigid"},
    {"id": "host_spring-soft", "controller": "host_spring", "object": "soft"},
    {"id": "spring-rigid", "controller": "stiff", "object": "rigid", "compensator": True},
    {"id": "torque-rigid", "controller": "torque", "object": "rigid"},
    {"id": "joint_coupled-qdd-rigid", "controller": "joint_coupled", "object": "rigid", "build": "qdd", "host_rate_hz": 500.0,
     "host_delay_s": 0.002},
    {"id": "host_spring-light-soft-slow-aware", "controller": "host_spring", "object": "soft", "build": "qdd_light", "approach_m_s": 0.05,
     "friction": "contact_aware", "stiffness": (3000.0, 3000.0, 300.0, 150.0, 150.0, 150.0), "damping_ratio": 0.7},
    {"id": "torque-highK-unguarded", "controller": "torque", "object": "rigid", "stiffness": HIGH_K, "guard": False},
    {"id": "host_spring-highK-unguarded", "controller": "host_spring", "object": "rigid", "stiffness": HIGH_K, "guard": False},
]


def ensure_lane_python() -> None:
    """Re-exec under the lane's venv (numpy, mujoco, the package) unless we already have it."""

    try:
        import bam_impedance_controller  # noqa: F401
    except ImportError:
        if not LANE_PYTHON.exists():
            raise SystemExit(f"needs the controller lane's venv at {LANE_PYTHON}")
        env = {key: value for key, value in os.environ.items() if key != "VIRTUAL_ENV"}
        env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
        env.setdefault("MUJOCO_GL", "egl")
        os.execve(str(LANE_PYTHON), [str(LANE_PYTHON), *sys.argv], env)


def rounded(values, digits: int = 9):
    """Nested lists of floats rounded to ``digits`` significant digits (JSON size; the browser recomputes the physics)."""

    if isinstance(values, (list, tuple)):
        return [rounded(value, digits) for value in values]
    if hasattr(values, "tolist"):
        return rounded(values.tolist(), digits)
    if isinstance(values, float):
        return float(f"{values:.{digits}g}") if math.isfinite(values) else None
    return values


def lane_source() -> dict:
    """The lane commit plus a hash of the sim sources actually imported (the lane's working tree may be ahead of its commit)."""

    head = subprocess.run(["git", "-C", str(LANE), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(LANE), "status", "--porcelain", "--", "src"], capture_output=True, text=True).stdout.split("\n")
    digest = hashlib.sha256()
    for name in ("scene.py", "loop.py", "pick.py", "reference.py", "tuning.py"):
        digest.update((LANE / "src" / "bam_impedance_controller" / "sim" / name).read_bytes())
    for name in ("law.py", "friction.py", "stability.py", "types.py"):
        digest.update((LANE / "src" / "bam_impedance_controller" / name).read_bytes())
    return {"package": "bam_impedance_controller", "lane": str(LANE), "commit": head, "dirty_src": sorted(line[3:] for line in dirty if line),
            "sources_sha256": digest.hexdigest()[:16]}


# ---------------------------------------------------------------------------------------------------------------- the models


def model_xml(*, true: bool, light: bool, compensator: bool) -> str:
    from bam_impedance_controller.sim.scene import Compensator, SceneConfig, _arm_spec

    config = SceneConfig(loop_hz=LOOP_HZ, arm_build="qdd_light" if light else "ur5e", compensator=Compensator() if compensator else None,
                         with_belt=true)
    spec = _arm_spec(config, true=true)
    spec.modelname = "pick_live_" + ("true" if true else "nominal") + ("_light" if light else "") + ("_comp" if compensator else "")
    spec.compile()
    xml = spec.to_xml()
    # the fixture's own comment is replaced by ours (the writer copies the first comment through)
    start = xml.find("<!--")
    if start >= 0:
        xml = xml[:start].rstrip(" ") + xml[xml.find("-->", start) + 4:].lstrip("\n")
    header = HEADER.format(comp=" with the passive level compensator's slide" if compensator else "",
                           belt=", the 3 m belt (slide joint along x, velocity-driven)" if true else " (the NOMINAL model: no belt, no friction)")
    head_end = xml.find(">") + 1
    return xml[:head_end] + f"\n  <!-- {header} -->" + xml[head_end:]


def model_files() -> dict[str, str]:
    files = {}
    for light in (False, True):
        suffix = "_light" if light else ""
        files[f"pick_live_nominal{suffix}.xml"] = model_xml(true=False, light=light, compensator=False)
        for compensator in (False, True):
            files[f"pick_live_true{suffix}{'_comp' if compensator else ''}.xml"] = model_xml(true=True, light=light, compensator=compensator)
    return files


def xml_roundtrip(xml: str, build: str) -> dict:
    """The exported (6-digit) nominal XML against the Python's own nominal model: the joint-space mass matrix at the pick pose."""

    import mujoco
    import numpy as np
    from bam_impedance_controller.sim.pick import HOME_SEED, nominal_robot
    from bam_impedance_controller.sim.scene import ARM_BUILDS

    scene, kinematics = nominal_robot(build)
    reloaded = mujoco.MjModel.from_xml_string(xml)
    armature = ARM_BUILDS[build][0]
    for index, dof in enumerate(scene.nominal_dof_index):
        reloaded.dof_armature[dof] = scene.nominal.dof_armature[dof] if armature is None else armature
    data = mujoco.MjData(reloaded)
    data.qpos[scene.nominal_qpos_index] = np.asarray(HOME_SEED)
    mujoco.mj_forward(reloaded, data)
    mass = np.zeros((reloaded.nv, reloaded.nv))
    mujoco.mj_fullM(reloaded, data, mass)
    reference = kinematics.sample(np.asarray(HOME_SEED)).mass_matrix
    return {"max_relative_mass_error": float(np.max(np.abs(mass - reference)) / np.max(np.abs(reference)))}


# ---------------------------------------------------------------------------------------------------------------- the config


def build_config() -> dict:
    import numpy as np
    from bam_pid_tunning.plants.arm_truths import HOME_RAD, JOINTS, TORQUE_LIMIT_NM, ur5e_arm
    from bam_pid_tunning.plants.mujoco_arm import FRICTION_SOLREF, NOSLIP_ITERATIONS
    from bam_impedance_controller.sim import pick
    from bam_impedance_controller.sim.reference import COULOMB_BAND_RAD_S, FINE_DT, IK_DAMPING, IK_ITERATIONS, IK_STRIDE, IK_TOLERANCE, PickPlan
    from bam_impedance_controller.sim.scene import (ARM_BUILDS, BELT_HALF_SIZE, BELT_KV, BELT_MASS_KG, LINK_BODIES, Compensator, SceneConfig,
                                                   build_scene, tool_down_rotation)

    arm, truths, _ = ur5e_arm()
    base = SceneConfig(loop_hz=LOOP_HZ)
    config: dict = {
        "schema": "impedance-livepick/1",
        "source": lane_source(),
        "loop_hz": LOOP_HZ,
        "joints": list(JOINTS),
        "home_rad": list(HOME_RAD),
        "home_seed": list(pick.HOME_SEED),
        "torque_cap_nm": list(TORQUE_LIMIT_NM),
        "sites": {"tcp": "tcp", "tip_body": "tip", "tip_geom": "tip_contact", "belt_body": "belt", "belt_geom": "belt_surface",
                  "belt_joint": "belt_x", "compensator_joint": "compensator"},
        "truths": [{"name": name, **asdict(truths[name]), "rotor_inertia_kg_m2": servo.rotor_inertia_kg_m2} for name, servo in zip(JOINTS, arm.joints)],
        "friction_solref": list(FRICTION_SOLREF),
        "noslip_iterations": NOSLIP_ITERATIONS,
        "belt": {"surface_z": base.belt_surface_z, "y": base.belt_y, "half_size": list(BELT_HALF_SIZE), "mass_kg": BELT_MASS_KG, "kv": BELT_KV,
                 "speed_m_s": base.belt_speed_m_s},
        "tool": {"length_m": base.tool_length_m, "tip_radius_m": base.tip_radius_m, "tool_mass_kg": base.tool_mass_kg, "tip_mass_kg": base.tip_mass_kg},
        "compensator": asdict(Compensator()),
        "contact_impedance": base.contact_impedance,
        "friction_mu": base.friction,
        "objects": OBJECTS,
        "surface_offset_m": 0.01,
        "default_stiffness": list(pick.DEFAULT_STIFFNESS),
        "zeta_grid": list(ZETA_GRID),
        "host_rates_hz": list(HOST_RATES_HZ),
        "host_margin": 2.0,
        "metrics": {"impact_window_s": pick.IMPACT_WINDOW_S, "lost_contact_s": pick.LOST_CONTACT_S},
        "diverged": {"speed_rad_s": 20.0, "tool_error_m": 0.30},
        "plan": {**asdict(PickPlan()), "phases": PickPlan().phases()},
        "path": {"fine_dt": FINE_DT, "ik_tolerance": IK_TOLERANCE, "ik_damping": IK_DAMPING, "ik_iterations": IK_ITERATIONS, "ik_stride": IK_STRIDE,
                 "coulomb_band_rad_s": COULOMB_BAND_RAD_S, "rotation": tool_down_rotation(np.array([0.0, 1.0, 0.0])).tolist()},
        "builds": {},
    }
    for build, label in BUILDS.items():
        armature, link_scale = ARM_BUILDS[build]
        light = link_scale != 1.0
        entry = {
            "label": label,
            "link_scale": link_scale,
            "link_bodies": list(LINK_BODIES),
            "models": {"true": f"models/pick_live_true{'_light' if light else ''}.xml",
                       "true_comp": f"models/pick_live_true{'_light' if light else ''}_comp.xml",
                       "nominal": f"models/pick_live_nominal{'_light' if light else ''}.xml"},
            # every joint's armature in the TRUE and NOMINAL models (scene.build_scene: the truths / the datasheet rotor unless the build sets it)
            "armature_true": [truths[name].armature_kg_m2 if armature is None else armature for name in JOINTS],
            "armature_nominal": [(servo.rotor_inertia_kg_m2 or 0.0) if armature is None else armature for servo in arm.joints],
            "coulomb_nm": [truths[name].coulomb_nm for name in JOINTS],
            "viscous_nm_s_rad": [truths[name].viscous_nm_s_rad for name in JOINTS],
            "limits": {},
            "calibration": {},
        }
        # the board's gains and ceilings: tuning.tuner_limits through pick.rig_for, per zeta (kp_max / kd_max follow the goal's zeta)
        for zeta in ZETA_GRID:
            rig = pick.rig_for(pick.PickCase(arm_build=build, damping_ratio=zeta, loop_hz=LOOP_HZ))
            entry["limits"][f"{zeta:g}"] = [{"name": joint.name, "kpBase": joint.kp_base, "kdBase": joint.kd_base, "kpMax": joint.kp_max,
                                              "kdMax": joint.kd_max, "scaleMax": joint.scale_max, "torqueCapNm": joint.torque_cap_nm}
                                             for joint in rig.limits.joints]
            if zeta == 1.0:
                entry["q_pick"] = rig.q_pick.tolist()
                entry["host_kp_max_100hz_7ms"] = {mode: (None if caps is None else list(caps)) for mode, caps in (
                    (name, pick.host_ceilings(rig.kinematics, rig.q_pick, pick.IMPEDANCE_MODES[name], period_s=0.01, delay_s=0.007))
                    for name in ("torque", "host_spring"))}
        # the contact calibration (scene.calibrate_contact): efc_R and the impedance at the probe, per compensator choice
        for compensator in (False, True):
            scene = build_scene(SceneConfig(loop_hz=LOOP_HZ, arm_build=build, compensator=Compensator() if compensator else None))
            calibration = dict(scene.contact_calibration)
            dmax = float(scene.true.geom_solimp[scene.tip_geom, 1])
            entry["calibration"]["comp" if compensator else "bare"] = {
                "efc_R": calibration["efc_R"], "impedance": calibration["impedance"], "dmax": dmax, "virtual_mass_kg": calibration["virtual_mass_kg"],
                "solref": {name: [-obj["contact_stiffness_n_m"] * calibration["efc_R"] / calibration["impedance"] * dmax * dmax,
                                  -obj["contact_damping_n_s_m"] * calibration["efc_R"] * dmax] for name, obj in OBJECTS.items()},
            }
        config["builds"][build] = entry
    return config


# ---------------------------------------------------------------------------------------------------------------- the references


def path_golden() -> list[dict]:
    """The trajectory controller's grid (q, qd, tau_ff) for the default plan at 100 Hz and a slow-zone plan at 1 kHz (every 10th
    sample kept: ``stride``)."""

    import numpy as np
    from bam_impedance_controller.sim import pick
    from bam_impedance_controller.sim.reference import PickPlan

    out = []
    for build, approach, rate, coulomb in (("ur5e", None, 100.0, True), ("qdd_light", 0.05, 1000.0, False)):
        plan = PickPlan(contact_speed_m_s=approach)
        scene = pick._scene(pick._scene_config(pick.PickCase(arm_build=build, loop_hz=LOOP_HZ), compensator=False))
        friction = tuple(float(value) for value in scene.coulomb_nm()) if coulomb else (0.0,) * 6
        path = pick._path(plan, 1.0 / rate, friction, build)
        trajectory = path.trajectory
        stride = max(1, int(round(rate / 100.0)))
        out.append({"build": build, "approach_m_s": approach, "host_rate_hz": rate, "coulomb_feedforward": coulomb, "rows": len(trajectory.t),
                    "stride": stride, "q": rounded(np.asarray(trajectory.q)[::stride], 12), "qd": rounded(np.asarray(trajectory.qd)[::stride], 12),
                    "tau_ff": rounded(np.asarray(trajectory.tau_ff)[::stride], 12)})
    return out


def case_for(entry: dict):
    from bam_impedance_controller.sim import pick
    from bam_impedance_controller.sim.reference import PickPlan

    obj = OBJECTS[entry["object"]]
    return pick.PickCase(
        controller="spring" if entry.get("compensator") and entry["controller"] == "stiff" else entry["controller"],
        with_compensator=bool(entry.get("compensator")) and entry["controller"] != "stiff",
        surface_offset_m=0.01, loop_hz=LOOP_HZ, arm_build=entry.get("build", "ur5e"),
        host_rate_hz=entry.get("host_rate_hz", 100.0), host_delay_s=entry.get("host_delay_s", 0.007),
        stiffness=tuple(entry.get("stiffness", pick.DEFAULT_STIFFNESS)), damping_ratio=entry.get("damping_ratio", 1.0),
        contact_stiffness_n_m=obj["contact_stiffness_n_m"], contact_damping_n_s_m=obj["contact_damping_n_s_m"],
        friction_compensation=entry.get("friction", "reference"), plan=PickPlan(contact_speed_m_s=entry.get("approach_m_s")),
        label=entry["id"])


METRIC_KEYS = ("impact_peak_fz_n", "dwell_fz_mean_n", "dwell_fz_max_n", "first_touch_s", "peak_after_touch_ms", "touch_speed_m_s", "max_fz_n",
               "bounces", "dwell_bounces", "dwell_contact_fraction", "saturation", "diverged", "reason", "stiffness_scale_min", "free_jitter_mm",
               "max_xy_error_mm", "y_deflection_mm", "z_final_mm", "max_compression_mm", "virtual_mass_kg")


def run_reference(entry: dict) -> dict:
    """One reference pick in a worker process (``guard`` False patches pick.host_ceilings to None: no host ceiling)."""

    import numpy as np
    from bam_impedance_controller.sim import pick

    if entry.get("guard") is False:
        pick.host_ceilings = lambda *args, **kwargs: None
    case = case_for(entry)
    result = pick.run_case(case, traces=True, diagnostics=False)
    metrics = result["metrics"]
    traces = result["traces"]
    keep = traces["t"] <= case.plan.duration_s() + 1e-9
    return {**{key: value for key, value in entry.items()}, "stiffness": list(case.stiffness), "case": {key: value for key, value in asdict(case).items()
                                                                                                       if key not in ("plan", "compensator")},
            "approach_m_s": case.plan.contact_speed_m_s, "loop_hz": LOOP_HZ,
            "metrics": {key: rounded(metrics.get(key)) for key in METRIC_KEYS},
            "host_kp_max": result.get("host_kp_max"),
            # 1 kHz: each 1 ms bin's MAX (trace_arrays), so the impact peak survives
            "trace": {"t0": round(float(traces["t"][0]), 6), "dt": round(float(traces["t"][1] - traces["t"][0]), 9),
                      "fz": [round(float(value), 2) for value in traces["fz"][keep]]}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--no-runs", action="store_true", help="skip the Python reference runs (keep the existing file's)")
    args = parser.parse_args()
    ensure_lane_python()
    MODELS.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)

    files = model_files()
    for name, xml in files.items():
        (MODELS / name).write_text(xml)
    config = build_config()
    config["xml_roundtrip"] = {build: xml_roundtrip(files[f"pick_live_nominal{'_light' if build == 'qdd_light' else ''}.xml"], build) for build in BUILDS}
    (DATA / "livepick-config.json").write_text(json.dumps(config, indent=1) + "\n")
    print(f"wrote {len(files)} models and livepick-config.json ({config['source']['commit']}, sources {config['source']['sources_sha256']})")

    reference_file = DATA / "livepick-reference.json"
    if args.no_runs and reference_file.exists():
        return
    with ProcessPoolExecutor(max_workers=MAX_WORKERS) as pool:
        runs = list(pool.map(run_reference, REFERENCE_CONFIGS))
    reference = {"schema": "impedance-livepick-reference/1", "source": config["source"], "loop_hz": LOOP_HZ, "surface_offset_m": 0.01,
                 "paths": path_golden(), "runs": runs}
    reference_file.write_text(json.dumps(reference, separators=(",", ":")) + "\n")
    for run in runs:
        metrics = run["metrics"]
        print(f"  {run['id']:36s} impact {metrics['impact_peak_fz_n']:8.2f} N  dwell {metrics['dwell_fz_mean_n'] or 0:7.2f} N  "
              f"sat {metrics['saturation']:.3f}  jitter {metrics['free_jitter_mm']}  {metrics['reason']}")


if __name__ == "__main__":
    main()
