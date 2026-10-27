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

## `site/public/data/factorial.json` (frozen 2026-10-27 by the dispatcher)

Zach (2026-10-27): "I want to see the worst case with just the impedance controller ... add more runs so I can see all of those
combinations, then filter it or create different views ... what does it look like in the worst case with QDD motors and the
impedance controller." And: "what we really care about for durability are the peak impact forces on the JOINTS ... shocks
through the gears ... model the impact on each joint ... specify the motion speed so we never surpass the safe gear loading ...
an estimated lifetime of the gearbox using a model for wear and safety limits."

```json
{
  "schema": "impedance-factorial/1",
  "generated_at": "ISO-8601",
  "source": {"lane_commit": "sha", "script": "docs/factorial_study.py"},
  "factors": {
    "build":      ["ur5e", "qdd", "qdd_light"],
    "controller": ["stiff", "torque", "joint", "joint_coupled", "host_spring"],
    "approach":   ["fast", "slow"],
    "spring":     ["off", "on"],
    "object":     ["rigid", "soft"]
  },
  "factor_labels": {"ur5e": "UR-style (harmonic drive)", "qdd": "QDD 10:1", "...": "..."},
  "joints": ["shoulder_pan", "shoulder_lift", "elbow", "wrist_1", "wrist_2", "wrist_3"],
  "gearboxes": {
    "ur5e": {"model": "name + source", "per_joint": [{"rated_nm": 0, "repeated_peak_nm": 0, "momentary_peak_nm": 0,
             "ratio": 0, "life_model": "S-N / L10 description + source"}]},
    "qdd": {}, "qdd_light": {}
  },
  "runs": [
    {"build": "ur5e", "controller": "stiff", "approach": "fast", "spring": "off", "object": "rigid",
     "touch_peak_n": 0, "press_mean_n": 0, "touch_speed_m_s": 0,
     "joint_contact_torque_peak_nm": [0, 0, 0, 0, 0, 0],
     "gear_torque_peak_nm": [0, 0, 0, 0, 0, 0],
     "gear_load_ratio": [0, 0, 0, 0, 0, 0],
     "gear_life_picks": [0, 0, 0, 0, 0, 0],
     "safe_approach_speed_m_s": 0,
     "converged": true, "flag": null,
     "trace": {"t_ms": [], "fz_n": [], "gear_torque_nm": [[], [], [], [], [], []]}}
  ]
}
```

- `joint_contact_torque_peak_nm` = peak |Jᵀ F_contact| per joint over the touch and the hold.
- `gear_torque_peak_nm` = the torque the GEAR transmits, motor side vs link side: the rotor's reflected inertia must be decelerated
  through the gear at impact, so a high-ratio gearbox sees a shock a QDD doesn't. Give the formula and its sign convention in the script.
- `gear_load_ratio` = gear_torque_peak / the gearbox's repeated-peak rating (> 1 = over the limit).
- `gear_life_picks` = estimated picks to failure from a cited fatigue model over that pick's torque history, gear and bearing,
  whichever is shorter; the model, exponents and ratings are in `gearboxes` with their sources.
- `safe_approach_speed_m_s` = the fastest approach that keeps every joint's gear torque under its repeated-peak rating, for that
  combination.
- Every run passes `run_converged` + `perturbation_check`; otherwise `converged: false` and `flag` says why.
- 3 × 5 × 2 × 2 × 2 = 120 runs.

## `hand.json` v2 additions (frozen 2026-10-27 by the dispatcher; schema "impedance-hand/2")

Rigid fingers with compliant joints (Zach: "not soft fingers, rigid fingers with compliant joints, like the human hand").

```json
{
  "schema": "impedance-hand/2",
  "contact_models": {
    "finding": "plain sentence: what the contact model changes and which one is used for the main runs, and why",
    "chosen": "hunt_crossley",
    "models": [
      {"id": "kv_b200", "label": "Kelvin-Voigt, B 200 (old baseline)", "what": "...",
       "results": {"J0": {"fingertip_peak_n": 0, "arm_flange_peak_n": 0}, "J1": {}, "J2": {}}}
    ]
  },
  "cases": [
    {"id": "J0", "group": "rigid joints", "arm": "stiff | host_spring", "finger_joint_k_equiv_n_m": null, "title": "...", "what": "..."},
    {"id": "J1-k500-arm_soft", "group": "virtual torsion springs", "arm": "host_spring", "finger_joint_k_equiv_n_m": 500, "title": "...", "what": "..."},
    {"id": "J2-k500-arm_soft", "group": "physical series-elastic springs", "arm": "host_spring", "finger_joint_k_equiv_n_m": 500, "title": "...", "what": "..."}
  ],
  "results": {"rigid": [{"case": "J1-k500-arm_soft", "...": "the H-row fields, plus:",
    "finger_gear_torque_peak_nm": [0, 0, 0, 0], "arm_gear_torque_peak_nm": [0, 0, 0, 0, 0, 0],
    "finger_travel_used": [0, 0, 0, 0], "grasp_success": true}], "soft": []},
  "legacy": {"cases": [], "results": {}},
  "answer": "plain sentence: do compliant finger joints act as the crumple zone, and how much shock they keep off the arm joints"
}
```

- `cases[*].id` starts with "J"; `group` is one of "rigid joints" / "virtual torsion springs" / "physical series-elastic springs".
- `finger_travel_used` = the fraction of each finger joint's range used (≥ 1 = hit the stop).
- The old H-cases move under `legacy`. `replay.runs_by_object` stays as the first study had it.
