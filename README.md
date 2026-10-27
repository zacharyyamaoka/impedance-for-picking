# impedance-controller-website

The landing page for `bam_impedance_controller` (lane `claude/bam-impedance-controller` in `~/bam_ws`): what the controller
is, where its spring and damper live (moteus board vs host), live demos, and the evidence (MuJoCo comparison, oracle study,
the Codex judge loop). Stack reused from `~/pidtuna-website`: VitePress + the official `@mujoco/mujoco` WASM bindings + three.js.

```bash
pnpm --dir /home/bam/impedance-controller-website run dev
```
