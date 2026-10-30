# AlgoRover

Official self-hosted plugin marketplace for AlgoRover.

This branch is `dev`. Marketplace ID: `algorover`.

## Codex

```bash
codex plugin marketplace add algorover/algorover-hub --ref dev
codex plugin add algorover@algorover
codex plugin add algorover-research@algorover
```

## Claude Code

```bash
claude plugin marketplace add algorover/algorover-hub@dev
claude plugin install algorover@algorover
claude plugin install algorover-research@algorover
```

## Cursor

Cursor reads `.cursor-plugin/marketplace.json`. Install only these copies:

- `plugins/cursor/algorover`
- `plugins/cursor/algorover-research`

Copy each directory into Cursor's local plugin directory, then reload the window. macOS and Linux: `~/.cursor/plugins/local/<plugin name>`. Windows: `%USERPROFILE%\.cursor\plugins\local\<plugin name>`. Do not install `plugins/codex` or `plugins/claude` into Cursor; their MCP files use another host root. On Teams or Enterprise, import this repository from Dashboard, then Plugins and MCPs. That import reads `.cursor-plugin/marketplace.json`.

Install the listed products. Node.js must be available to the host. Reload plugins or start a new session after installation. Plugin installation does not mean Runtime is running: ask to start AlgoRover, then open its Dashboard. Runtime platform support is defined by each product's public channel. Live login is Dashboard-only; Research needs no account. After updating an installed plugin, verify its delivery.json contains the channel Runtime ID for your platform. A runtime_identity_incompatible result requires updating the plugin and reloading its session; Runtime repair cannot change plugin bindings.

Branches share one marketplace identity; configure only one branch at a time. Do not enable another marketplace's copy of the same product alongside this one.

## Release ownership

Generated from audited production plugin ZIPs through the source repository's `./build.sh marketplace-sync` command. `release.json` records input hashes and generated plugin hashes. Runtime downloads remain on each product's public channel. No credentials, Python, Runtime or user state are stored here.
