---
layout: page
title: Live pick
---

<script setup>
import LivePick from './.vitepress/theme/components/LivePick.vue'
</script>

<div class="live-page">

# Live pick

bam_impedance_controller's conveyor pick running in your browser: MuJoCo steps the arm, the belt and the tool while you switch controllers and tune the spring.

<LivePick />

</div>

<style>
.live-page { max-width: 1400px; margin: 0 auto; padding: 24px 16px 48px; }
.live-page h1 { margin: 0 0 6px; font-size: 28px; }
.live-page > p { margin: 0 0 18px; color: var(--pt-text-2, var(--vp-c-text-2)); }
</style>
