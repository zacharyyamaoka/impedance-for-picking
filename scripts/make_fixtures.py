#!/usr/bin/env python3
"""Write contract-shaped TEST fixtures for the files the sim lane is still computing (docs/data-contract.md):

    python3 /home/bam/impedance-controller-website/scripts/make_fixtures.py

- tests/fixtures/factorial.fixture.json  (schema impedance-factorial/1: 3 builds x 5 controllers x 2 approaches x 2 springs x 2 objects)
- tests/fixtures/hand2.fixture.json      (schema impedance-hand/2: J-cases, contact_models, legacy H-cases)

These are NOT results. Every number is a toy formula (touch peak ~ v * sqrt(k * m), gear torque = a share of J^T F, a Basquin-style
life) chosen only so the page has plausible magnitudes and orderings to render; each file carries "fixture": true and the page shows a
"fixture" badge when it reads one. WHY a generator, not hand-typed JSON: the Playwright specs need 120 internally consistent runs, and a
re-run must give the same bytes (no clock, no randomness).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures"

BUILDS = ["ur5e", "qdd", "qdd_light"]
CONTROLLERS = ["stiff", "torque", "joint", "joint_coupled", "host_spring"]
APPROACHES = ["fast", "slow"]
SPRINGS = ["off", "on"]
OBJECTS = ["rigid", "soft"]
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow", "wrist_1", "wrist_2", "wrist_3"]

LABELS = {
    "ur5e": "UR-style (harmonic drive)", "qdd": "QDD 10:1", "qdd_light": "QDD 10:1, light links",
    "stiff": "Stiff position control", "torque": "TORQUE (host K and D)", "joint": "JOINT (board diagonal)",
    "joint_coupled": "JOINT_COUPLED", "host_spring": "HOST_SPRING (impedance)",
    "fast": "Fast (0.2 m/s)", "slow": "Slow (0.05 m/s)", "off": "No spring", "on": "Spring on the end",
    "rigid": "Rigid object", "soft": "Soft object",
}
SPEED = {"fast": 0.2, "slow": 0.05}
K_CONTACT = {"rigid": 100_000.0, "soft": 20_000.0}
# mass in front of the tool (kg) and the share of the contact torque the gear carries (rotor deceleration through the gear)
MASS = {"ur5e": 10.1, "qdd": 4.2, "qdd_light": 1.6}
GEAR_SHARE = {"ur5e": 0.62, "qdd": 0.18, "qdd_light": 0.21}
LEVER_M = [0.05, 0.42, 0.38, 0.09, 0.09, 0.02]
GRAVITY_NM = {"ur5e": [0, 38, 14, 2.2, 1.0, 0.1], "qdd": [0, 30, 11, 1.8, 0.8, 0.1], "qdd_light": [0, 12, 4.5, 1.2, 0.6, 0.1]}
# press during the hold, N (the controller's spring through the 10 mm surprise)
PRESS = {"stiff": 78.0, "torque": 22.0, "joint": 41.0, "joint_coupled": 26.0, "host_spring": 15.0}
TOUCH_SCALE = {"stiff": 1.0, "torque": 0.84, "joint": 0.95, "joint_coupled": 0.9, "host_spring": 0.92}
GEARBOXES = {
    "ur5e": {"model": "Harmonic drive, size 25 / 14 class (fixture values; cite the vendor catalogue in the real file)",
             "ratings": [(51, 82, 178), (51, 82, 178), (51, 82, 178), (11, 23, 48), (11, 23, 48), (11, 23, 48)], "ratio": 101,
             "life": "Wave generator bearing L10, cubic in torque (fixture)"},
    "qdd": {"model": "10:1 planetary QDD (fixture values)",
            "ratings": [(30, 60, 90), (30, 60, 90), (30, 60, 90), (8, 16, 24), (8, 16, 24), (8, 16, 24)], "ratio": 10,
            "life": "Planet bearing L10 + ring tooth bending S-N, exponent 10/3 (fixture)"},
    "qdd_light": {"model": "10:1 planetary QDD (fixture values)",
                  "ratings": [(30, 60, 90), (30, 60, 90), (30, 60, 90), (8, 16, 24), (8, 16, 24), (8, 16, 24)], "ratio": 10,
                  "life": "Planet bearing L10 + ring tooth bending S-N, exponent 10/3 (fixture)"},
}
T_MS = [t for t in range(-50, 601, 5)]


def r(value: float, digits: int = 3) -> float:
    return float(round(value, digits))


def fz_trace(peak: float, press: float, spring: bool) -> list[float]:
    period = 18.0 if not spring else 60.0
    out = []
    for t in T_MS:
        if t < 0:
            out.append(0.0)
            continue
        ring = peak * math.exp(-t / (period * 0.9)) * abs(math.sin(math.pi * t / period + 0.0001)) if t < 4 * period else 0.0
        settle = press * (1 - math.exp(-t / 40.0))
        out.append(r(max(ring, settle) if t < period / 2 else ring * 0.6 + settle, 2))
    return out


def factorial() -> dict:
    runs = []
    for build in BUILDS:
        for controller in CONTROLLERS:
            for approach in APPROACHES:
                for spring in SPRINGS:
                    for obj in OBJECTS:
                        v = SPEED[approach]
                        mass = 0.05 if spring == "on" else MASS[build]
                        k = K_CONTACT[obj] if spring == "off" else 200.0 * 40  # the spring's own rate in series, toy
                        touch = v * math.sqrt(k * mass) * TOUCH_SCALE[controller] + (4.0 if spring == "on" else 0.0)
                        press = PRESS[controller] * (0.9 if obj == "soft" else 1.0) * (0.45 if spring == "on" else 1.0)
                        force = max(touch, press)
                        contact = [force * lever for lever in LEVER_M]
                        share = GEAR_SHARE[build] * (1.0 if spring == "off" else 0.25)
                        gear = [c * (1 + share * 2.2) * (1.0 if controller == "stiff" else 0.85) + g
                                for c, g in zip(contact, GRAVITY_NM[build])]
                        ratings = GEARBOXES[build]["ratings"]
                        ratio = [g / rp for g, (_, rp, _) in zip(gear, ratings)]
                        life = [min(1e12, 3e6 * (rp / max(g, 1e-6)) ** (10 / 3)) for g, (_, rp, _) in zip(gear, ratings)]
                        safe = min(0.5, v * min(rp / max(g - grav, 1e-6) for g, grav, (_, rp, _) in zip(gear, GRAVITY_NM[build], ratings)))
                        converged = not (controller == "torque" and approach == "fast" and obj == "soft" and build == "ur5e")
                        fz = fz_trace(touch, press, spring == "on")
                        scale = [g / max(force, 1e-6) for g in gear]
                        runs.append({
                            "build": build, "controller": controller, "approach": approach, "spring": spring, "object": obj,
                            "touch_peak_n": r(touch, 2), "press_mean_n": r(press, 2), "touch_speed_m_s": r(v * 0.98, 4),
                            "joint_contact_torque_peak_nm": [r(c, 2) for c in contact],
                            "gear_torque_peak_nm": [r(g, 2) for g in gear],
                            "gear_load_ratio": [r(x, 3) for x in ratio],
                            "gear_life_picks": [r(x, 0) for x in life],
                            "safe_approach_speed_m_s": r(safe, 4),
                            "converged": converged,
                            "flag": None if converged else "fixture: did not hold the three-rate check",
                            "trace": {"t_ms": T_MS, "fz_n": fz,
                                      "gear_torque_nm": [[r(f * s, 2) for f in fz] for s in scale]},
                        })
    return {
        "schema": "impedance-factorial/1",
        "generated_at": "fixture",
        "fixture": True,
        "source": {"lane_commit": "fixture0", "script": "scripts/make_fixtures.py (toy numbers, not a sim)"},
        "factors": {"build": BUILDS, "controller": CONTROLLERS, "approach": APPROACHES, "spring": SPRINGS, "object": OBJECTS},
        "factor_labels": LABELS,
        "joints": JOINTS,
        "gearboxes": {
            build: {"model": spec["model"], "per_joint": [
                {"rated_nm": a, "repeated_peak_nm": b, "momentary_peak_nm": c, "ratio": spec["ratio"], "life_model": spec["life"]}
                for a, b, c in spec["ratings"]]}
            for build, spec in GEARBOXES.items()
        },
        "runs": runs,
    }


def cm(fingertip: float, flange: float) -> dict:
    return {"fingertip_peak_n": fingertip, "arm_flange_peak_n": flange, "converged": True,
            "finger_gear_torque_peak_nm": [r(fingertip * k, 3) for k in (0.031, 0.012, 0.027, 0.010)],
            "arm_gear_torque_peak_nm": [r(flange * k, 2) for k in (0.02, 0.21, 0.18, 0.05, 0.04, 0.01)]}


def hand2() -> dict:
    legacy = json.loads((OUT / "hand.fixture.json").read_text())
    # case ids as the dispatcher froze them (2026-10-27): J0-arm_{stiff,soft}, J1-k<k>-arm_{stiff,soft}, J2-k<k>-arm_{stiff,soft}
    cases = [
        {"id": "J0-arm_stiff", "group": "rigid joints", "arm": "stiff", "finger_joint_k_equiv_n_m": None,
         "title": "Rigid joints, stiff arm", "what": "fixture: finger joints held rigid, the arm on stiff position control"},
        {"id": "J0-arm_soft", "group": "rigid joints", "arm": "host_spring", "finger_joint_k_equiv_n_m": None,
         "title": "Rigid joints, soft arm", "what": "fixture: finger joints held rigid, the arm on host_spring"},
        {"id": "J1-k500-arm_soft", "group": "virtual torsion springs", "arm": "host_spring", "finger_joint_k_equiv_n_m": 500,
         "title": "Virtual springs 500 N/m", "what": "fixture: the finger motors render a torsion spring"},
        {"id": "J1-k2000-arm_soft", "group": "virtual torsion springs", "arm": "host_spring", "finger_joint_k_equiv_n_m": 2000,
         "title": "Virtual springs 2 kN/m", "what": "fixture: stiffer virtual springs"},
        {"id": "J2-k500-arm_soft", "group": "physical series-elastic springs", "arm": "host_spring", "finger_joint_k_equiv_n_m": 500,
         "title": "Series-elastic springs 500 N/m", "what": "fixture: a real spring between motor and joint"},
    ]
    peaks = {"J0-arm_stiff": 118.0, "J0-arm_soft": 96.0, "J1-k500-arm_soft": 41.0, "J1-k2000-arm_soft": 63.0, "J2-k500-arm_soft": 29.0}
    t = list(range(-50, 601, 5))
    results = {}
    for obj, scale in (("rigid", 1.0), ("soft", 0.62)):
        rows = []
        for case in cases:
            peak = peaks[case["id"]] * scale
            fz = fz_trace(peak, 12.0 * scale, not case["id"].startswith("J0"))
            rows.append({
                "case": case["id"], "touch_peak_n": r(peak, 2), "fingertip_peak_n": [r(peak * 0.55, 2), r(peak * 0.45, 2)],
                "arm_flange_peak_n": r(peak * (0.8 if case["id"].startswith("J0") else 0.35), 2), "press_mean_n": r(12.0 * scale, 2),
                "converged": True, "rate_hz": 64000,
                "trace": {"t_ms": t, "fz_total_n": fz, "fz_fingertips_n": [[r(v * 0.55, 2) for v in fz], [r(v * 0.45, 2) for v in fz]]},
                "finger_gear_torque_peak_nm": [r(peak * k, 3) for k in (0.031, 0.012, 0.027, 0.010)],
                "arm_gear_torque_peak_nm": [r(peak * k * (2.4 if case["id"].startswith("J0") else 1.0), 2) for k in (0.02, 0.21, 0.18, 0.05, 0.04, 0.01)],
                "finger_travel_used": [r(x, 3) for x in ((0.05, 0.03, 0.04, 0.02) if case["id"].startswith("J0") else (0.62, 0.41, 0.55, 0.37) if "k500" in case["id"] else (0.31, 0.2, 0.27, 0.18))],
                "grasp_success": True,
            })
        results[obj] = rows
    return {
        "schema": "impedance-hand/2",
        "generated_at": "fixture",
        "fixture": True,
        "source": {"lane_commit": "fixture0", "script": "scripts/make_fixtures.py (toy numbers, not a sim)", "hand": "hand-ladder L3_2x2"},
        "objects": legacy["objects"],
        "metrics": "Gear torque peak = max |tau_gear - pre-touch baseline| over the 60 ms after first touch: the slap's shock, not the gravity load (fixture text).",
        "answer": "Fixture sentence: compliant finger joints take the touch, so the arm joints see less of the shock.",
        "contact_models": {
            "finding": "Fixture sentence: the contact model moves the fingertip peak; Hunt-Crossley is used for the main runs.",
            "chosen": "hunt_crossley",
            "models": [
                {"id": "kv_b200", "label": "Kelvin-Voigt, B 200 (old baseline)", "what": "fixture: linear spring + damper",
                 "results": {"J0-arm_soft": cm(61.0, 77.0), "J1-k500-arm_soft": cm(25.0, 14.0)}},
                {"id": "hunt_crossley", "label": "Hunt-Crossley", "what": "fixture: damping that grows with penetration",
                 "results": {"J0-arm_soft": cm(53.0, 77.0), "J1-k500-arm_soft": cm(23.0, 14.0)}},
            ],
        },
        "cases": cases,
        "results": results,
        "legacy": {"cases": legacy["cases"], "results": legacy["results"]},
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, doc in (("factorial.fixture.json", factorial()), ("hand2.fixture.json", hand2())):
        path = OUT / name
        path.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
