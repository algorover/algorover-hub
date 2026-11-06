---
name: algorover-setup
description: Post-install setup for AlgoRover Live. Runs from the plugin's setup action after installation, or when the user explicitly asks to set up AlgoRover Live; prepares the local Runtime, opens the Dashboard and starts interactive strategy onboarding.
---

# AlgoRover Live setup

This is the plugin's post-install setup entry. Treat it as the user's request to launch
the Dashboard and interactive strategy onboarding; do not reply with a feature menu or
ask what the user wants to do.

Setup targets the plugin that owns this skill. Start with the router skill's **Confirm the target
plugin first** step and use only that plugin's tools; a `ready` from another plugin or environment does
not count.

Run the **First-use onboarding** flow of the `algorover` router skill
([../algorover/SKILL.md](../algorover/SKILL.md)) exactly as written there, including its
Runtime lifecycle, Dashboard link, onboarding App and text-fallback rules. Reply in the
user's current language (`en`, `ko`, `zh-CN` or `zh-TW`); with no language signal, use the
conversation's language, then the host locale, and otherwise English.

If `algorover_runtime_status` or `algorover_runtime_start` reports
`message=node_version_unsupported`, stop here: the machine's Node.js is older than the
plugin needs. Ask the user to install the current Node.js LTS (22 or newer) from
nodejs.org, restart Codex and run this setup again.
