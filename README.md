# impedance-controller-website

The landing page for `bam_impedance_controller` (lane `claude/bam-impedance-controller` in `~/bam_ws`): what the controller
is, where its spring and damper live (moteus board vs host), live demos, and the evidence (MuJoCo comparison, oracle study,
the Codex judge loop). Stack reused from `~/pidtuna-website`: VitePress + the official `@mujoco/mujoco` WASM bindings + three.js.

```bash
pnpm --dir /home/bam/impedance-controller-website run dev
```

## GitHub Pages (https://zacharyyamaoka.github.io/impedance-for-picking/)

`.github/workflows/pages.yml` builds with `SITE_BASE=/impedance-for-picking/` (read by `site/.vitepress/config.mts`; local dev and the
default tests stay at `/`) and deploys with `actions/deploy-pages`. Settings → Pages → Source must be "GitHub Actions".

Prove a build works under the prefix before pushing (scripts/serve_base.mjs serves `dist` only under the prefix, like Pages):

```bash
SITE_BASE=/impedance-for-picking/ pnpm --dir /home/bam/impedance-controller-website exec vitepress build site
```

```bash
SITE_BASE=/impedance-for-picking/ PW_PORT=4498 pnpm --dir /home/bam/impedance-controller-website exec playwright test
```

## Data

- `site/data/site.json`: written by `scripts/export_site_data.py`, imported by Landing.vue at build time (not in `public/`: Vite refuses
  JS imports from the public directory).
- `site/public/data/*.json`: read at run time; the shapes are frozen in `docs/data-contract.md`. `factorial.json` and `hand.json` come
  from the sim lane; until a file lands its section says so. Test fixtures: `python3 scripts/make_fixtures.py` (toy numbers, marked).
- `site/public/data-ui/`: Zach's table kit, vendored by `python3 scripts/vendor_data_ui.py`, never edited (a unit test checks the hashes).
