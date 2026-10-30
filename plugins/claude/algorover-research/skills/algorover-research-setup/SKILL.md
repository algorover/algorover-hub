---
name: algorover-research-setup
description: Post-install setup for AlgoRover Research. Runs from the plugin's setup action after installation, or when the user explicitly asks to set up AlgoRover Research; prepares the local Runtime, opens the Dashboard and starts interactive strategy onboarding.
---

# AlgoRover Research setup

This is the plugin's post-install setup entry. Treat it as the user's request to launch
the Dashboard and interactive strategy onboarding; do not reply with a feature menu or
ask what the user wants to do.

Run the **First-use onboarding** flow of the `algorover-research` router skill
([../algorover-research/SKILL.md](../algorover-research/SKILL.md)) exactly as written
there, including its Runtime lifecycle, Dashboard link, onboarding App and text-fallback
rules. Reply in the user's current language (`en`, `ko`, `zh-CN` or `zh-TW`); with no
language signal, use the conversation's language, then the host locale, and otherwise
English.
