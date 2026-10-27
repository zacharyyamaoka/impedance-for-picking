#!/usr/bin/env python3
"""Golden vectors for the browser port of bam_impedance_controller, and the MuJoCo oracle for the 2-link arm's physics.

Runs the REAL Python package (lane ``claude/bam-impedance-controller`` in ~/bam_ws) on random cases and writes JSON fixtures
that ``tests/unit/*.test.ts`` hold the TypeScript to (1e-9 relative for the law, a stated tolerance for the physics).

    LANE=/home/bam/bam_ws/.claude/worktrees/bam-impedance-controller/src/core/mdp/agent/controllers/bam_impedance_controller
    $LANE/.venv/bin/python scripts/export_law_fixtures.py            # everything
    $LANE/.venv/bin/python scripts/export_law_fixtures.py --only law  # law, stability, friction (no MuJoCo)
    $LANE/.venv/bin/python scripts/export_law_fixtures.py --only arm2d

Fixtures (tests/fixtures/):
- ``law_cases.json``: ``impedance_command`` on 50 random 6-D cases per mode (n = 6, some n = 7; clamps active in some), plus
  20 planar cases per mode embedded in the 6-D law (the x and z rows of a 6 x 2 Jacobian) that the TS runs as an m = 2 task;
  the helper functions (``pose_error``, ``operational_space_inertia``, ``cartesian_damping``, ``realized_cartesian_stiffness``).
- ``stability_cases.json``: ``host_wn_ceiling`` over rates x delays x zeta x board damping, ``host_kp_limits``, and the closed
  loop's spectral radius at random points (the eigenvalue routine's own check).
- ``friction_cases.json``: ``contact_aware_friction`` over tick sequences that latch and release.
- ``arm2d_mujoco.json``: the 2-link arm's free swing and pressed contact in MuJoCo (see ``export_arm2d``).

WHY seeded numpy, not hypothesis: the fixture must be byte-stable so a diff in it means the Python changed.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

LANE = Path("/home/bam/bam_ws/.claude/worktrees/bam-impedance-controller/src/core/mdp/agent/controllers/bam_impedance_controller")
sys.path.insert(0, str(LANE / "src"))

from bam_impedance_controller import (  # noqa: E402
    CartesianImpedance,
    DampingDesign,
    FrictionCompensation,
    FrictionLatchState,
    HostLoop,
    ImpedanceConfig,
    ImpedanceMode,
    JointServoLimits,
    KinematicsSample,
    MeasuredState,
    cartesian_damping,
    contact_aware_friction,
    host_kp_limits,
    host_wn_ceiling,
    impedance_command,
    operational_space_inertia,
    pose_error,
    realized_cartesian_stiffness,
)
from bam_impedance_controller.stability import _closed_loop  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
MODES = (ImpedanceMode.TORQUE, ImpedanceMode.JOINT, ImpedanceMode.JOINT_COUPLED, ImpedanceMode.HOST_SPRING)
CASES_PER_MODE = 50
PLANAR_CASES_PER_MODE = 20


def tolist(value):
    if value is None:
        return None
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (tuple, list)):
        return [tolist(item) for item in value]
    if isinstance(value, (np.floating, float)):
        number = float(value)
        return number if math.isfinite(number) else ("inf" if number > 0 else "-inf")
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    return value


def random_rotation(rng: np.random.Generator) -> np.ndarray:
    quaternion = rng.normal(size=4)
    w, x, y, z = quaternion / np.linalg.norm(quaternion)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def axis_angle(axis: np.ndarray, angle: float) -> np.ndarray:
    axis = axis / np.linalg.norm(axis)
    skew = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(angle) * skew + (1 - math.cos(angle)) * skew @ skew


def log_uniform(rng, low, high, size=None):
    return np.exp(rng.uniform(math.log(low), math.log(high), size))


def random_jacobian(rng, rows: int, cols: int) -> np.ndarray:
    while True:
        jacobian = rng.normal(0.0, 0.5, (rows, cols))
        singular = np.linalg.svd(jacobian, compute_uv=False)
        if singular[-1] > 0.05 * singular[0]:  # WHY: a well-conditioned arm away from a singularity (cond < 20)
            return jacobian


def random_mass(rng, count: int) -> np.ndarray:
    factor = rng.normal(0.0, 0.3, (count, count))
    return factor @ factor.T + np.diag(rng.uniform(0.02, 0.3, count))


def random_joints(rng, count: int, tight: bool) -> tuple[JointServoLimits, ...]:
    joints = []
    for index in range(count):
        kp_base = float(log_uniform(rng, 1000.0, 8000.0))
        kd_base = float(log_uniform(rng, 30.0, 300.0))
        scale_max = float(rng.choice([1.5, 2.0, 3.0]))
        kp_max = float(kp_base * (rng.uniform(0.2, 1.5) if tight else rng.uniform(2.0, 20.0)))
        kd_max = None if rng.random() < 0.5 else float(kd_base * (rng.uniform(0.3, 1.5) if tight else rng.uniform(2.0, 10.0)))
        torque_cap = float(rng.uniform(3.0, 30.0) if tight and rng.random() < 0.5 else rng.uniform(50.0, 300.0))
        joints.append(JointServoLimits(name=f"j{index}", kp_base=kp_base, kd_base=kd_base, kp_max=kp_max, torque_cap_nm=torque_cap,
                                       kd_max=kd_max, scale_max=scale_max, coulomb_nm=float(rng.uniform(0.1, 3.0))))
    return tuple(joints)


def joint_json(joint: JointServoLimits) -> dict:
    return {"name": joint.name, "kpBase": joint.kp_base, "kdBase": joint.kd_base, "kpMax": joint.kp_max,
            "torqueCapNm": joint.torque_cap_nm, "kdMax": joint.kd_max, "scaleMax": joint.scale_max, "coulombNm": joint.coulomb_nm}


def command_json(command) -> dict:
    return {
        "position": tolist(command.position), "velocity": tolist(command.velocity), "kpScale": tolist(command.kp_scale),
        "kdScale": tolist(command.kd_scale), "feedforwardTorque": tolist(command.feedforward_torque),
        "renderedJointStiffness": tolist(command.rendered_joint_stiffness), "renderedJointDamping": tolist(command.rendered_joint_damping),
        "stiffnessScale": float(command.stiffness_scale), "clamped": [bool(flag) for flag in command.clamped], "mode": command.mode.value,
    }


def sample_json(sample: KinematicsSample, rows: list[int] | None = None) -> dict:
    jacobian = sample.jacobian if rows is None else sample.jacobian[rows]
    position = sample.position if rows is None else sample.position[[0, 2]]
    out = {"position": tolist(position), "jacobian": tolist(jacobian), "massMatrix": tolist(sample.mass_matrix)}
    if rows is None:
        out["rotation"] = tolist(sample.rotation)
    return out


def random_6d_case(rng, mode: ImpedanceMode, index: int) -> dict:
    # n = 6 (the UR5e), one in ten n = 7 (redundant). WHY no n = 5 here: with Lambda rank-deficient its square root amplifies
    # rounding to sqrt(eps), so the Python's own output carries ~1e-8 noise (the helper cases pin that path separately)
    count = 7 if index % 10 == 7 else 6
    tight = index % 3 == 0  # a third of the cases have board ceilings that bind (host caps and torque caps bind in others)
    jacobian_reference = random_jacobian(rng, 6, count)
    jacobian_measured = jacobian_reference + rng.normal(0.0, 0.03, (6, count))
    mass_reference = random_mass(rng, count)
    mass_measured = mass_reference + np.diag(rng.uniform(0.0, 0.01, count))
    rotation_reference = random_rotation(rng)
    angle = rng.uniform(2.9, 3.14) if index % 17 == 5 else rng.uniform(0.0, 0.6)
    rotation_measured = axis_angle(rng.normal(size=3), angle) @ rotation_reference
    position_reference = rng.normal(0.0, 0.4, 3)
    position_measured = position_reference + rng.normal(0.0, 0.03, 3)
    at_reference = KinematicsSample(position_reference, rotation_reference, jacobian_reference, mass_reference)
    at_measured = KinematicsSample(position_measured, rotation_measured, jacobian_measured, mass_measured)
    stiffness = np.concatenate([log_uniform(rng, 100.0, 6000.0, 3), log_uniform(rng, 5.0, 400.0, 3)])
    if index % 11 == 4:
        stiffness[rng.integers(0, 6)] = 0.0
    ratio = float(rng.uniform(0.3, 1.5)) if index % 4 else tuple(rng.uniform(0.2, 1.6, 6))
    impedance = CartesianImpedance(
        stiffness=tuple(stiffness), damping_ratio=ratio, axes=tuple(map(tuple, random_rotation(rng))) if index % 3 == 1 else None,
        wrench_ff=tuple(rng.normal(0.0, 5.0, 6)) if index % 2 else (0.0,) * 6,
        damping=tuple(log_uniform(rng, 5.0, 200.0, 6)) if index % 7 == 2 else None,
    )
    joints = random_joints(rng, count, tight)
    host_kp_max = None if index % 5 in (0, 2, 4) else tuple(float(value) for value in log_uniform(rng, 200.0, 6000.0, count))
    config = ImpedanceConfig(mode=mode, impedance=impedance, joints=joints, host=HostLoop(0.01, 0.007),
                             damping_design=DampingDesign.UNIT_MASS if index % 4 == 3 else DampingDesign.INERTIA, host_kp_max=host_kp_max)
    reference = type("Reference", (), {})()
    reference.positions = tuple(rng.normal(0.0, 1.0, count))
    reference.velocities = tuple(rng.normal(0.0, 0.5, count))
    reference.effort = None if index % 6 == 1 else tuple(rng.normal(0.0, 3.0, count))
    measured = MeasuredState(np.asarray(reference.positions) + rng.normal(0.0, 0.05, count), np.asarray(reference.velocities) + rng.normal(0.0, 0.2, count))
    command = impedance_command(config, reference, measured, at_reference, at_measured)
    return {
        "name": f"{mode.value}-{index}", "m": 6, "n": count,
        "config": config_json(config),
        "reference": {"positions": list(reference.positions), "velocities": list(reference.velocities),
                      "effort": None if reference.effort is None else list(reference.effort)},
        "measured": {"positions": tolist(measured.positions), "velocities": tolist(measured.velocities)},
        "atReference": sample_json(at_reference), "atMeasured": sample_json(at_measured),
        "expected": command_json(command),
    }


def config_json(config: ImpedanceConfig, impedance: dict | None = None) -> dict:
    return {
        "mode": config.mode.value,
        "impedance": impedance or {
            "stiffness": list(config.impedance.stiffness), "dampingRatio": list(config.impedance.damping_ratio),
            "axes": tolist(config.impedance.axes), "wrenchFf": list(config.impedance.wrench_ff), "damping": tolist(config.impedance.damping),
        },
        "joints": [joint_json(joint) for joint in config.joints],
        "host": {"periodS": config.host.period_s, "delayS": config.host.delay_s},
        "dampingDesign": config.damping_design.value,
        "hostKpMax": tolist(config.host_kp_max),
        "frictionCompensation": config.friction_compensation.value,
    }


def planar_jacobian(q1: float, q2: float, l1: float, l2: float) -> np.ndarray:
    """The tool's (x, z) Jacobian of a planar 2-link arm (angles from +x, toward +z)."""

    s1, c1, s12, c12 = math.sin(q1), math.cos(q1), math.sin(q1 + q2), math.cos(q1 + q2)
    return np.array([[-l1 * s1 - l2 * s12, -l2 * s12], [l1 * c1 + l2 * c12, l2 * c12]])


def embed_rows(planar: np.ndarray) -> np.ndarray:
    """A 2 x n planar (x, z) Jacobian as the 6 x n world Jacobian with only its x and z rows."""

    out = np.zeros((6, planar.shape[1]))
    out[0], out[2] = planar[0], planar[1]
    return out


def random_planar_case(rng, mode: ImpedanceMode, index: int) -> dict:
    """A planar (x, z) task run through the 6-D Python law: every other row of the Jacobian is zero, the rotations identity, so
    the 6-D law reduces exactly to the m = 2 law the TS runs on the x and z rows."""

    tight = index % 3 != 0
    l1, l2 = 0.35, 0.30
    q_reference = np.array([rng.uniform(-0.2, 1.4), rng.uniform(-2.4, -0.3)])
    q_measured = q_reference + rng.normal(0.0, 0.04, 2)
    jacobian_reference, jacobian_measured = planar_jacobian(*q_reference, l1, l2), planar_jacobian(*q_measured, l1, l2)
    mass_reference, mass_measured = random_mass(rng, 2) * 0.3, random_mass(rng, 2) * 0.3

    def tool(q):
        return np.array([l1 * math.cos(q[0]) + l2 * math.cos(q[0] + q[1]), 0.0, l1 * math.sin(q[0]) + l2 * math.sin(q[0] + q[1])])

    at_reference = KinematicsSample(tool(q_reference), np.eye(3), embed_rows(jacobian_reference), mass_reference)
    at_measured = KinematicsSample(tool(q_measured), np.eye(3), embed_rows(jacobian_measured), mass_measured)
    kx, kz = log_uniform(rng, 50.0, 8000.0, 2)
    zeta_x, zeta_z = rng.uniform(0.2, 1.6, 2)
    angle = rng.uniform(-1.0, 1.0) if index % 3 == 1 else 0.0
    c, s = math.cos(angle), math.sin(angle)
    axes_planar = [[c, -s], [s, c]]
    axes_6d = ((c, 0.0, -s), (0.0, 1.0, 0.0), (s, 0.0, c)) if angle else None  # the (x, z) rotation, about -y
    wrench = rng.normal(0.0, 4.0, 2) if index % 2 else np.zeros(2)
    damping = log_uniform(rng, 5.0, 150.0, 2) if index % 7 == 2 else None
    # the other four axes get arbitrary values: they meet zero Jacobian rows, so they cannot change the result
    impedance = CartesianImpedance(
        stiffness=(kx, 777.0, kz, 11.0, 13.0, 17.0), damping_ratio=(zeta_x, 0.5, zeta_z, 0.5, 0.5, 0.5), axes=axes_6d,
        wrench_ff=(wrench[0], 3.0, wrench[1], 0.1, 0.2, 0.3),
        damping=None if damping is None else (damping[0], 9.0, damping[1], 1.0, 1.0, 1.0),
    )
    joints = random_joints(rng, 2, tight)
    host_kp_max = None if index % 5 in (0, 2) else tuple(float(value) for value in log_uniform(rng, 5.0, 800.0, 2))
    config = ImpedanceConfig(mode=mode, impedance=impedance, joints=joints, host=HostLoop(0.004, 0.003),
                             damping_design=DampingDesign.UNIT_MASS if index % 4 == 3 else DampingDesign.INERTIA, host_kp_max=host_kp_max)
    reference = type("Reference", (), {})()
    reference.positions = tuple(q_reference)
    reference.velocities = tuple(rng.normal(0.0, 0.5, 2))
    reference.effort = None if index % 6 == 1 else tuple(rng.normal(0.0, 3.0, 2))
    measured = MeasuredState(q_measured, np.asarray(reference.velocities) + rng.normal(0.0, 0.2, 2))
    command = impedance_command(config, reference, measured, at_reference, at_measured)
    planar_impedance = {"stiffness": [kx, kz], "dampingRatio": [zeta_x, zeta_z], "axes": axes_planar if angle else None,
                        "wrenchFf": wrench.tolist(), "damping": None if damping is None else damping.tolist()}
    return {
        "name": f"planar-{mode.value}-{index}", "m": 2, "n": 2,
        "config": config_json(config, planar_impedance),
        "reference": {"positions": list(reference.positions), "velocities": list(reference.velocities),
                      "effort": None if reference.effort is None else list(reference.effort)},
        "measured": {"positions": tolist(measured.positions), "velocities": tolist(measured.velocities)},
        "atReference": sample_json(at_reference, [0, 2]), "atMeasured": sample_json(at_measured, [0, 2]),
        "expected": command_json(command),
    }


def helper_cases(rng) -> dict:
    pose = []
    for index in range(30):
        rotation_d = random_rotation(rng)
        angle = [0.0, 1e-9, 1e-5, 0.3, 1.5, 3.0, 3.14159, math.pi][index % 8]
        rotation = axis_angle(rng.normal(size=3), angle).T @ rotation_d
        position_d, position = rng.normal(size=3), rng.normal(size=3)
        pose.append({"positionD": position_d.tolist(), "rotationD": rotation_d.tolist(), "position": position.tolist(),
                     "rotation": rotation.tolist(), "expected": pose_error(position_d, rotation_d, position, rotation).tolist()})
    inertia, damping, realized = [], [], []
    for index in range(30):
        count = [6, 6, 5, 7][index % 4]
        sample = KinematicsSample(rng.normal(size=3), np.eye(3), random_jacobian(rng, 6, count), random_mass(rng, count))
        inertia.append({"sample": sample_json(sample), "expected": operational_space_inertia(sample).tolist()})
        impedance = CartesianImpedance(stiffness=tuple(np.concatenate([log_uniform(rng, 100, 5000, 3), log_uniform(rng, 5, 300, 3)])),
                                       damping_ratio=tuple(rng.uniform(0.3, 1.5, 6)),
                                       axes=tuple(map(tuple, random_rotation(rng))) if index % 2 else None)
        # WHY no INERTIA design when n < 6: Lambda is then rank-deficient and D takes its square root, so the Python's own output
        # carries sqrt(eps) ~ 1e-8 rounding noise there (measured 3.8e-8); the pseudo-inverse itself is pinned above
        for design in (DampingDesign.INERTIA, DampingDesign.UNIT_MASS) if count >= 6 else (DampingDesign.UNIT_MASS,):
            damping.append({"impedance": {"stiffness": list(impedance.stiffness), "dampingRatio": list(impedance.damping_ratio),
                                          "axes": tolist(impedance.axes), "wrenchFf": [0.0] * 6, "damping": None},
                            "sample": sample_json(sample), "design": design.value,
                            "expected": cartesian_damping(impedance, sample, design).tolist()})
        joint_matrix = random_mass(rng, count) * 300.0 if index % 3 else np.diag(log_uniform(rng, 10, 500, count))
        if count >= 6:  # WHY: with n < 6 the 6x6 compliance is singular and numpy's inv returns rounding noise, not a stiffness
            realized.append({"jointStiffness": joint_matrix.tolist(), "jacobian": sample.jacobian.tolist(),
                             "expected": realized_cartesian_stiffness(joint_matrix, sample.jacobian).tolist()})
    return {"poseError": pose, "operationalSpaceInertia": inertia, "cartesianDamping": damping, "realizedCartesianStiffness": realized}


def export_law() -> None:
    rng = np.random.default_rng(20261027)
    cases = [random_6d_case(rng, mode, index) for mode in MODES for index in range(CASES_PER_MODE)]
    planar = [random_planar_case(rng, mode, index) for mode in MODES for index in range(PLANAR_CASES_PER_MODE)]
    clamped = sum(any(case["expected"]["clamped"]) or case["expected"]["stiffnessScale"] < 1.0 for case in cases)
    write("law_cases.json", {"source": source(), "cases": cases, "planar": planar, "helpers": helper_cases(rng)})
    print(f"law: {len(cases)} 6-D cases ({clamped} with a clamp or s < 1), {len(planar)} planar cases")

    ceilings = []
    for rate in (100.0, 250.0, 500.0, 1000.0):
        for delay_ms in (0.0, 0.5, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0):
            for zeta in (1.0, 0.7, 0.3):
                for board in (False, True):
                    period, delay = 1.0 / rate, delay_ms / 1000.0
                    ceilings.append({"periodS": period, "delayS": delay, "dampingRatio": zeta, "boardDamping": board,
                                     "expected": tolist(host_wn_ceiling(period, delay, zeta, board))})
    limits = []
    for rate, delay_ms, board in ((100.0, 7.0, False), (100.0, 7.0, True), (500.0, 2.0, False), (1000.0, 1.0, True)):
        inertias = [float(value) for value in log_uniform(rng, 0.01, 2.0, 6)]
        limits.append({"inertias": inertias, "periodS": 1.0 / rate, "delayS": delay_ms / 1000.0, "dampingRatio": 1.0, "boardDamping": board,
                       "expected": list(host_kp_limits(inertias, 1.0 / rate, delay_ms / 1000.0, 1.0, board))})
    radii = []
    for _ in range(60):
        period = 1.0 / float(rng.choice([100.0, 250.0, 500.0, 1000.0]))
        delay = float(rng.uniform(0.0, 0.010))
        wn, zeta, board = float(log_uniform(rng, 1.0, 600.0)), float(rng.uniform(0.0, 1.5)), bool(rng.random() < 0.5)
        matrix = _closed_loop(wn, zeta, period, delay, board)
        radii.append({"wn": wn, "dampingRatio": zeta, "periodS": period, "delayS": delay, "boardDamping": board,
                      "matrix": matrix.tolist(), "expected": float(np.max(np.abs(np.linalg.eigvals(matrix))))})
    write("stability_cases.json", {"source": source(), "ceilings": ceilings, "limits": limits, "spectralRadius": radii})
    print(f"stability: {len(ceilings)} ceilings, {len(limits)} limit sets, {len(radii)} spectral radii")

    write("friction_cases.json", {"source": source(), "sequences": friction_sequences(rng)})


def friction_sequences(rng) -> list[dict]:
    """Tick sequences through the latch: an inward approach the tool keeps up with, then lags (contact), then the lift."""

    sequences = []
    for index in range(16):
        count = 6
        joints = random_joints(rng, count, False)
        config = ImpedanceConfig(mode=MODES[index % 4], impedance=CartesianImpedance((3000, 3000, 500, 150, 150, 150)), joints=joints,
                                 host=HostLoop(0.01, 0.007), friction_compensation=FrictionCompensation.CONTACT_AWARE)
        jacobian = random_jacobian(rng, 6, count)
        position = rng.normal(0.0, 0.4, 3)
        state = FrictionLatchState()
        ticks = []
        speed = float(rng.uniform(0.03, 0.3))
        for tick in range(14):
            phase = "approach" if tick < 6 else ("contact" if tick < 10 else "lift")
            reference_twist = rng.normal(0.0, 0.01, 6)
            reference_twist[2] = -speed if phase != "lift" else speed + 0.02  # inward is -z
            measured_twist = reference_twist * (1.0 if phase == "approach" else (0.3 if phase == "contact" else 1.0)) + rng.normal(0.0, 0.002, 6)
            qd_reference = np.linalg.solve(jacobian, reference_twist)
            qd_measured = np.linalg.solve(jacobian, measured_twist)
            measured_position = position + np.array([0.0, 0.0, 0.002 if phase == "contact" else -0.002 if phase == "lift" else 0.0])
            reference = type("Reference", (), {})()
            reference.positions, reference.velocities, reference.effort = tuple(rng.normal(size=count)), tuple(qd_reference), None
            measured = MeasuredState(np.asarray(reference.positions), qd_measured)
            at_reference = KinematicsSample(position, np.eye(3), jacobian)
            at_measured = KinematicsSample(measured_position, np.eye(3), jacobian)
            torque, state = contact_aware_friction(config, reference, measured, at_reference, at_measured, state)
            ticks.append({"reference": {"positions": list(reference.positions), "velocities": qd_reference.tolist()},
                          "measured": {"positions": tolist(measured.positions), "velocities": qd_measured.tolist()},
                          "atReferencePosition": position.tolist(), "atMeasuredPosition": measured_position.tolist(),
                          "expectedTorque": torque.tolist(), "expectedLatched": bool(state.latched),
                          "expectedSpeeds": list(state.inward_speeds)})
            position = position + reference_twist[:3] * config.host.period_s
        sequences.append({"joints": [joint_json(joint) for joint in joints], "host": {"periodS": 0.01, "delayS": 0.007},
                          "jacobian": jacobian.tolist(), "ticks": ticks})
    latched = sum(any(tick["expectedLatched"] for tick in sequence["ticks"]) for sequence in sequences)
    released = sum(any(a["expectedLatched"] and not b["expectedLatched"] for a, b in zip(sequence["ticks"], sequence["ticks"][1:])) for sequence in sequences)
    print(f"friction: {len(sequences)} sequences, {latched} latch, {released} release")
    return sequences


# ---------------------------------------------------------------------------------------------------------------- arm2d
# The demo arm, mirrored from site/.vitepress/theme/lib/arm2d/model.ts DEFAULT_ARM (a test asserts they are equal).
ARM = {
    "l1": 0.35, "l2": 0.30,
    "m1": 1.2, "lc1": 0.16, "i1": 0.012,
    "m2": 0.5, "lc2": 0.13, "i2": 0.004,
    "toolMass": 0.25, "toolInertia": 4e-5,
    "armature": [1.83e-3, 1.83e-3],
    "viscous": [0.03, 0.03],
    "torqueCap": [20.0, 10.0],
    "coulombFraction": 0.23,
    "gravity": 9.81,
    "contactK": 100000.0, "contactB": 200.0,
}
MUJOCO_DT = 1e-5
SAMPLE_EVERY_S = 1e-3


def arm_mjcf(coulomb: tuple[float, float]) -> str:
    a = ARM
    joint = 'type="hinge" axis="0 -1 0" armature="{arm}" damping="{damp}" frictionloss="{fric}" solreffriction="0.0001 1" solimpfriction="0.99 0.999 0.0001"'
    j1 = joint.format(arm=a["armature"][0], damp=a["viscous"][0], fric=coulomb[0])
    j2 = joint.format(arm=a["armature"][1], damp=a["viscous"][1], fric=coulomb[1])
    return f"""<mujoco model="arm2d">
  <option timestep="{MUJOCO_DT}" gravity="0 0 -{a['gravity']}" integrator="Euler"/>
  <worldbody>
    <body name="link1">
      <joint name="shoulder" {j1}/>
      <inertial pos="{a['lc1']} 0 0" mass="{a['m1']}" diaginertia="{a['i1']} {a['i1']} {a['i1']}"/>
      <body name="link2" pos="{a['l1']} 0 0">
        <joint name="elbow" {j2}/>
        <inertial pos="{a['lc2']} 0 0" mass="{a['m2']}" diaginertia="{a['i2']} {a['i2']} {a['i2']}"/>
        <body name="tool" pos="{a['l2']} 0 0">
          <inertial pos="0 0 0" mass="{a['toolMass']}" diaginertia="{a['toolInertia']} {a['toolInertia']} {a['toolInertia']}"/>
          <site name="tip"/>
        </body>
      </body>
    </body>
  </worldbody>
</mujoco>"""


def run_mujoco(case: dict) -> dict:
    """One case in MuJoCo at 100 kHz: the joint torque law and the belt's Kelvin-Voigt force are recomputed every step and applied
    through qfrc_applied (the force at the tip site via its Jacobian) - the SAME definitions the TS applies at its 8 kHz."""

    import mujoco

    coulomb = tuple(case["coulomb"])
    model = mujoco.MjModel.from_xml_string(arm_mjcf(coulomb))
    data = mujoco.MjData(model)
    data.qpos[:] = case["q0"]
    data.qvel[:] = case["v0"]
    site = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE, "tip")
    jacp = np.zeros((3, model.nv))
    pd = case.get("pd")
    surface = case.get("surfaceZ")
    steps = int(round(case["durationS"] / MUJOCO_DT))
    every = int(round(SAMPLE_EVERY_S / MUJOCO_DT))
    out = {"t": [], "q": [], "v": [], "tip": [], "contactForce": []}
    force_z = 0.0
    for step in range(steps + 1):
        mujoco.mj_step1(model, data)
        mujoco.mj_jacSite(model, data, jacp, None, site)
        tip = data.site_xpos[site].copy()
        tip_velocity = jacp @ data.qvel
        force_z = 0.0
        if surface is not None:
            penetration = surface - tip[2]
            if penetration > 0.0:
                force_z = max(0.0, ARM["contactK"] * penetration - ARM["contactB"] * tip_velocity[2])
        torque = np.zeros(2)
        if pd is not None:
            torque = np.array(pd["kp"]) * (np.array(pd["target"]) - data.qpos) - np.array(pd["kd"]) * data.qvel + np.array(pd["ff"])
            torque = np.clip(torque, -np.array(ARM["torqueCap"]), np.array(ARM["torqueCap"]))
        if step % every == 0:
            out["t"].append(step * MUJOCO_DT)
            out["q"].append(data.qpos.tolist())
            out["v"].append(data.qvel.tolist())
            out["tip"].append([float(tip[0]), float(tip[2])])
            out["contactForce"].append(force_z)
        if step == steps:
            break
        data.qfrc_applied[:] = torque + jacp.T @ np.array([0.0, 0.0, force_z])
        mujoco.mj_step2(model, data)
    return out


def export_arm2d() -> None:
    import mujoco

    caps = ARM["torqueCap"]
    jmc = [ARM["coulombFraction"] * cap for cap in caps]
    cases = [
        # free swing from rest under gravity, viscous + armature, no Coulomb: the rigid-body dynamics alone
        {"name": "free_swing", "q0": [0.6, -1.1], "v0": [0.0, 0.0], "coulomb": [0.0, 0.0], "durationS": 1.0},
        # the same with the JMC-like dry friction: swings, then sticks
        {"name": "free_swing_coulomb", "q0": [1.2, -0.4], "v0": [0.0, 0.0], "coulomb": jmc, "durationS": 1.0},
        # a joint PD pulls the tip from 2 cm above the belt to a target 3 cm into it: the touch, the bounce, the steady press
        {"name": "pressed_contact", "q0": [0.0, 0.0], "v0": [0.0, 0.0], "coulomb": [0.0, 0.0], "durationS": 0.6, "surfaceZ": -0.30,
         "pd": {"kp": [300.0, 120.0], "kd": [6.0, 2.0], "target": [0.0, 0.0], "ff": [0.0, 0.0]}},
        {"name": "pressed_contact_coulomb", "q0": [0.0, 0.0], "v0": [0.0, 0.0], "coulomb": jmc, "durationS": 0.6, "surfaceZ": -0.30,
         "pd": {"kp": [300.0, 120.0], "kd": [6.0, 2.0], "target": [0.0, 0.0], "ff": [0.0, 0.0]}},
    ]
    for case in cases:
        if "pd" in case:
            # start 2 cm above the belt at (0.42, -0.28), target 3 cm into it at (0.42, -0.33); elbow up
            case["q0"] = list(planar_ik(0.42, -0.28))
            case["pd"]["target"] = list(planar_ik(0.42, -0.33))
            case["pd"]["ff"] = list(planar_gravity(case["pd"]["target"]))
        case["mujoco"] = run_mujoco(case)
    write("arm2d_mujoco.json", {"source": source(), "mujocoVersion": mujoco.__version__, "mujocoDtS": MUJOCO_DT, "arm": ARM,
                                "mjcf": arm_mjcf((0.0, 0.0)), "cases": cases})
    print(f"arm2d: {len(cases)} MuJoCo cases at {1 / MUJOCO_DT:.0f} Hz (mujoco {mujoco.__version__})")


def planar_ik(x: float, z: float) -> tuple[float, float]:
    l1, l2 = ARM["l1"], ARM["l2"]
    cosine = (x * x + z * z - l1 * l1 - l2 * l2) / (2 * l1 * l2)
    q2 = -math.acos(max(-1.0, min(1.0, cosine)))  # elbow up (q2 <= 0)
    q1 = math.atan2(z, x) - math.atan2(l2 * math.sin(q2), l1 + l2 * math.cos(q2))
    return q1, q2


def planar_gravity(q) -> tuple[float, float]:
    a = ARM
    m2 = a["m2"] + a["toolMass"]
    lc2 = (a["m2"] * a["lc2"] + a["toolMass"] * a["l2"]) / m2
    g = a["gravity"]
    c1, c12 = math.cos(q[0]), math.cos(q[0] + q[1])
    return ((a["m1"] * a["lc1"] + m2 * a["l1"]) * g * c1 + m2 * lc2 * g * c12, m2 * lc2 * g * c12)


def source() -> dict:
    import subprocess

    head = subprocess.run(["git", "-C", str(LANE), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    return {"package": "bam_impedance_controller", "lane": str(LANE), "commit": head, "numpy": np.__version__}


def write(name: str, payload: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", choices=["law", "arm2d"], default=None)
    args = parser.parse_args()
    if args.only in (None, "law"):
        export_law()
    if args.only in (None, "arm2d"):
        export_arm2d()


if __name__ == "__main__":
    main()
