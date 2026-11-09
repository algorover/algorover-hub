---
name: algorover-setup
description: Post-install setup for AlgoRover Live. Runs from the plugin's setup action after installation, or when the user explicitly asks to set up AlgoRover Live; prepares the local Runtime, opens the Dashboard and starts interactive strategy onboarding.
---

# AlgoRover Live setup

This is the plugin's post-install setup entry. Treat it as the user's request to launch
the Dashboard and interactive strategy onboarding; do not reply with a feature menu or
ask what the user wants to do.

Use the [`algorover` router skill](../algorover/SKILL.md) for setup.

1. Follow **Confirm the target plugin first**. Use that plugin's tools and check
   `algorover_runtime_status` before choosing a Runtime location.
2. For the production plugin, call `algorover_runtime_target` with `action: "status"`.
   When `placement` is `local` and `local_runtime_installed` is false, ask once whether to
   run on this computer (default) or on the user's own Linux VPS so strategies can keep
   running while the computer is off. In the same question, say that VPS setup needs the
   address, SSH port, username and password. For a VPS, follow **Runtime location**
   (`deploy_to_vps`) and proceed when it returns `required_action: continue`. Use this
   computer if the user chooses it or gives no clear preference.
3. Run **First-use onboarding**, including the Runtime lifecycle, Dashboard link,
   onboarding App and text fallback. Reply in the user's current language (`en`, `ko`,
   `zh-CN` or `zh-TW`). With no language signal, use the conversation's language,
   then the host locale, then English.

If `algorover_runtime_status` or `algorover_runtime_start` reports
`message=node_version_unsupported`, stop setup. Ask the user to install a supported
Node.js LTS release, restart Codex and run setup again.
