# Data contract: ablation ladder and hand study (frozen 2026-10-27 by the dispatcher)

The sim side writes these files; the page renders them. Change the shape only through the dispatcher.

## `site/public/data/ablation.json`

Zach (2026-10-27): "change only one thing at a time, so it reads like an ablation study. Start with the worst case, then move it
slower, then make the motors backdrivable, then lower the mass of the arm (grounding the motors), then add a spring on the end.
The object is a toggle at the top that changes all of the data: soft vs rigid. Switch it top level, not on the same chart."

```json
{
  "schema": "impedance-ablation/1",
  "generated_at": "ISO-8601",
  "source": {"lane_commit": "sha", "script": "docs/ablation_study.py"},
  "objects": {
    "rigid": {"label": "Rigid object", "contact_stiffness_n_m": 100000, "contact_damping_n_s_m": 200},
    "soft":  {"label": "Soft object",  "contact_stiffness_n_m": 20000,  "contact_damping_n_s_m": 200}
  },
  "rungs": [
    {"id": "R0", "title": "Worst case", "change": null,
     "what": "UR-style joints (harmonic-drive rotor inertia), heavy links, fast approach, stiff position control"},
    {"id": "R1", "title": "Move slower", "change": "approach 0.2 -> 0.05 m/s over the last 30 mm"},
    {"id": "R2", "title": "Backdrivable motors", "change": "rotor inertia: harmonic-drive -> 10:1 QDD"},
    {"id": "R3", "title": "Lighter arm", "change": "link mass x0.3 (motors grounded)"},
    {"id": "R4", "title": "Spring on the end", "change": "passive level compensator 200 N/m, 4 N preload, 30 mm"},
    {"id": "R5", "title": "Impedance controller", "change": "stiff position control -> host_spring, soft z"}
  ],
  "results": {
    "rigid": [
      {"rung": "R0",
       "touch_peak_n": 0.0, "peak_time_ms": 0.0, "touch_speed_m_s": 0.0, "reflected_mass_kg": 0.0,
       "press_mean_n": 0.0, "press_max_n": 0.0,
       "converged": true, "rate_hz": 16000,
       "trace": {"t_ms": [], "fz_n": []}}
    ],
    "soft": []
  }
}
```

- Each rung changes exactly ONE thing from the rung before; everything else is held, and `rungs[*].what` / `change` says what.
- `touch_peak_n` = the peak within 30 ms of first touch; `press_mean_n` / `press_max_n` = the contact force over the hold (what keeps
  pushing on the belt); `trace` = Fz from 50 ms before touch to the end of the hold, at ≤ 1 kHz, `t_ms` relative to first touch.
- Numbers pass `pick.run_converged` + `pick.perturbation_check`; `converged: false` rows are shown starred, never in a headline.

## `site/public/data/hand.json`

Zach (2026-10-27): "show an example with 2 x 2 dof fingers on the end of the robot arm and the contact from that ... how you would
control the contact: a mix of both the fingers and the arm."

```json
{
  "schema": "impedance-hand/1",
  "generated_at": "ISO-8601",
  "source": {"lane_commit": "sha", "script": "docs/hand_study.py", "hand": "hand-ladder L3_2x2"},
  "objects": {"rigid": {}, "soft": {}},
  "cases": [
    {"id": "H0", "title": "Arm stiff, fingers stiff", "what": "..."},
    {"id": "H1", "title": "Arm stiff, fingers soft", "what": "..."},
    {"id": "H2", "title": "Arm soft z, fingers soft", "what": "..."}
  ],
  "results": {
    "rigid": [
      {"case": "H0", "touch_peak_n": 0.0, "fingertip_peak_n": [0.0, 0.0], "arm_flange_peak_n": 0.0, "press_mean_n": 0.0,
       "converged": true, "rate_hz": 16000,
       "trace": {"t_ms": [], "fz_total_n": [], "fz_fingertips_n": [[], []]}}
    ],
    "soft": []
  },
  "replay": {"model": "models/arm_hand.xml", "runs": {"H0": "data/hand-H0-rigid.json"}}
}
```

Replays (MuJoCo in the browser): `site/public/models/arm_hand.xml` (capsule geometry, no meshes) and per-run qpos tapes
`{"t": [], "qpos": [[...]]}` at ~200 Hz.
