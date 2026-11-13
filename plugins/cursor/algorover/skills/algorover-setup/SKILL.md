---
name: algorover-setup
description: Post-install setup for AlgoRover Live. Runs from the plugin's setup action after installation, or when the user explicitly asks to set up AlgoRover Live; asks once whether to run on this computer or the user's own VPS, prepares the Runtime, opens the Dashboard and starts interactive strategy onboarding.
---

# AlgoRover Live setup

This is the plugin's post-install setup entry. Treat it as the user's request to launch
the Dashboard and interactive strategy onboarding; do not reply with a feature menu or
ask what the user wants to do.

Use the [`algorover` router skill](../algorover/SKILL.md) for setup.

1. Follow **Confirm the target plugin first**. Use that plugin's tools and check
   `algorover_runtime_status`.
2. Run **First-use onboarding**, starting with its **Runtime location first** question
   (this computer or the user's own Linux VPS) on a first installation, then the Runtime
   lifecycle, Dashboard link, onboarding App and text fallback. That location question
   is the only one setup asks before onboarding. Reply in the user's current language (`en`, `ko`,
   `zh-CN` or `zh-TW`). With no language signal, use the conversation's language,
   then the host locale, then English.

If `algorover_runtime_status` or `algorover_runtime_start` reports
`message=node_version_unsupported`, stop setup. Ask the user to install a supported
Node.js LTS release, restart Codex and run setup again.
