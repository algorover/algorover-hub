---
name: algorover-research
description: Route anonymous public strategy discovery and reproducible historical backtests through the local AlgoRover Research Runtime. It has no accounts, credentials, demo, live trading, or order execution.
---

# AlgoRover Research router

The Node Ready Bridge always exposes `algorover_runtime_status`,
`algorover_runtime_start`, `algorover_runtime_update` and `algorover_runtime_repair`, even
before Runtime exists. The bridge automatically prepares the release-bound Runtime before first business use; never treat an older compatible Runtime as ready. When Runtime is ready, use the six Host meta tools:

1. `algorover_connection_list`
2. `algorover_tool_search`
3. `algorover_tool_get`
4. `algorover_tool_execute`
5. `algorover_result_present`
6. `algorover_view_present` (in-chat cards, below)

Search for an operation, fetch its exact current descriptor, then execute with the returned
`schema_revision`. Do not invent dynamic tools, copy operation schemas into this plugin or
infer missing benchmark facts. Preserve exact strategy version, package digest,
configuration-schema digest, dataset provenance and Runtime identity in reproducible
results.

Route one user outcome at a time. Use `algorover_connection_list` for current anonymous
catalog availability. Search unknown capabilities once in concise English, batch Get for
the exact contracts, and batch Execute only for independent calls. A returned identifier or
digest starts a later dependency round. Present only an execute-minted `result_ref`.

The normal research route is catalog search/recommend, exact inspect/version list, install,
configuration resolve, backtest start, durable job status and result get. Runtime workflow
hints are navigation, not execution authority. Never repeat a start call merely because a
job is still queued or running.

## In-chat cards

`algorover_view_present` shows one AlgoRover card in the conversation; the Runtime keeps its
state, so it survives reloads and updates itself. Its text result is what you tell the user,
briefly. Research cards: `backtest` with `{job_ref}` right after `backtest.run.start` (it follows
the job to the result) or `{run_ref}` for a saved run; `task` with `{}` for this conversation's
progress; `leaderboard` with `{sort, query?, locale}` (sort `return`, `drawdown`, `sharpe` or
`published`); `installed` with `{locale}`; `glossary` with `{metrics, locale}` to explain metric
names, where metrics uses exactly these names (`max_drawdown_pct`, not `max_drawdown`): `return_pct`, `annualized_return_pct`, `max_drawdown_pct`, `sharpe`, `sortino`, `profit_factor`, `win_rate`, `realized_pnl`, `trades_per_30d`, `median_holding_minutes`, `max_consecutive_losses`, `worst_trade_pct`, `capacity_usd`, `match_score`, `order_fraction`, `max_total_exposure_fraction`, `max_equivalent_leverage`, `leverage`, `starting_balance`, `fee_bps`.
locale is `en`, `zh-CN`, `zh-TW` or `ko`. Configuration, monitor and diagnosis cards exist only in
AlgoRover Live. When the card call answers an error naming a field and its valid values, correct
that field and call once more instead of answering without the card.

Route every ordinary chat request for finding or recommending strategies through
`algorover_strategy_search`, including identity/keyword lookup, explicit hard filters,
subjective fit, mixed preferences, “recommend a low-risk strategy” and “find something for
small capital”. Preserve the user's locale and every supported hard constraint; keep
unsupported wishes in the natural-language query and disclose constraints the owner cannot
apply. Never call `algorover_strategy_recommend` or discover/execute
`catalog.strategy.recommend` for an ordinary chat request, and never create a V3
questionnaire payload. Only an explicit request to open/start the questionnaire or strategy
onboarding may enter the onboarding flow below. The onboarding App, or its explicitly
requested textual fallback, submits the complete confirmed V2 questionnaire. Preserve the
owner order. If the user asks for an exact number of recommendations, send that number as
`limit` (for example, `limit=1`, `limit=2` or `limit=3`); do not let the search tool default
to ten results for a counted request. Use a larger explicit limit only when the user asks for
options or multiple candidates. For “open Research”, call `algorover_dashboard_open` and
present its URL as a link (Dashboard links below); never start the Dashboard directly.

## Dashboard links

Show a Dashboard URL as one Markdown link with a short label in the user's language, never as
the raw address: for example `[打开 AlgoRover 控制台](<url>)`, or, when a strategy target was
opened, `[在 AlgoRover 中查看 <strategy name> <version>](<url>)`.

- A message "Dashboard 已准备好，请点击打开：<url>" is posted by the AlgoRover card's view
  button and already carries a fresh link to that strategy: reply only with that exact URL as
  the link. Do not call `algorover_dashboard_open` for it; a new link without the card's target
  would open the Dashboard without the strategy.
- A link signs the browser in once within 10 minutes. When the user asks to open it again
  later, call `algorover_dashboard_open` again with the same `target` as before.

## First-use onboarding

Run this flow only when the `algorover-research-setup` skill runs (plugin setup after
installation), when the user selects an interactive-onboarding starter prompt or
explicitly asks to open/start the questionnaire or onboarding. A plain request to find or
recommend a strategy is not onboarding. Reply in the user's current language (`en`, `ko`, `zh-CN` or `zh-TW`).
Ordinary catalog, Dashboard, data or backtest requests go directly to that outcome and do
not force the questionnaire.

1. Call `algorover_runtime_status`, then `algorover_runtime_start` when the bound target
   needs starting, installation or recovery. Let the script decide whether to reuse,
   start, prepare or resume; do not infer process liveness from stored job states or
   historical lifecycle phases and do not assemble alternative shell recovery commands.
   Wait for the original call's final result; yielded/running is not completed. If the
   script reports `runtime_operation_pending`, wait on that call or query status with
   bounded backoff, without parallel open calls or duplicate installations. Status text
   includes the current state, required action, phase, download progress, last error and recent log lines.
   When `state=update_required`, call `algorover_runtime_start`; that start upgrades to the
   plugin-bound release. `previous_lifecycle`, including an earlier `host_start_timeout`, belongs
   to the previous release. Do not diagnose or restart that old Host before this start.
   Research switches never pause work: running backtests finish on the previous version
   and the new Host shows their results. Report failures and their script-provided
   recovery action.
   For `stale_session`, reload the plugin session. A lower version number is not stale: `algorover_runtime_start` installs this plugin's bound release.
   For `host_start_timeout`, tell the user that reloading or restarting Cursor does not
   restart the Host. The Host is a separate sign-in task. Do not invent a shell command
   to end it, and do not ask the user to end it in Task Scheduler. Call
   `algorover_runtime_start` again: that start ends a Host task that is still occupying
   the slot, then starts the current Runtime. If the same timeout returns, report it.
2. For this Dashboard-and-onboarding request, all successful paths (already running,
   stopped target started, first installation, upgrade or repair) continue identically.
   Only after `state=ready` and `connection_ready=true`, call
   `algorover_dashboard_open` once and present its URL as a link (Dashboard links). Then call
   `algorover_onboarding_open` once with the current locale. On success, hand control to
   that interactive card and end the turn. A brief instruction to continue in the card is
   enough; do not repeat questionnaire choices in chat or call another question/selection
   tool. Keep all seven choices, review and recommendation inside that one App.
   AlgoRover keeps the questionnaire and its recommendation, and the card passes you their
   state. When the user later refers to a recommendation by position or role ("the first
   one", "the safer one"), use exactly the strategy versions that card context names, in the
   left-to-right order it gives; do not search again or substitute a newer version.
   The tool does not report rendering visibility. Missing model-visible HTML, missing
   acknowledgement or delayed rendering is unknown, not evidence of failure. Never claim
   the card did not appear based on that absence and never automatically start text onboarding
   alongside a successful App request. Do not restart installation to recover presentation.
3. Switch to text onboarding only when the host explicitly reports App rendering unsupported
   or failed, or the user reports the card unusable or explicitly requests text onboarding.
   A Runtime/tool execution error follows step 1 recovery, not the questionnaire fallback.
   Apply the **one-question turn boundary**
   as the formal fallback. The internal field order is `profit_style`,
   `holding_period`, `pain_point`, `max_drawdown_pct`, `trading_mode`, `allocation_band`,
   `universe`. Ask only the first unanswered field, with only that field's choices, and end
   the assistant turn immediately. Never display the complete questionnaire, a numbered
   checklist, future questions, future choices or a request for multiple answers. Do not
   preview what comes next.
4. On the user's next message, retain every valid supplied answer and ask only the next
   unanswered field, then end the turn immediately again. If the current answer is invalid
   or ambiguous, clarify only the same field and end the turn; do not advance or expose any
   later field. A message that already contains valid answers may fill them silently, but
   the response still asks at most one unanswered field.
5. After the last answer, use a separate assistant turn to summarize the selected values
   and ask only for explicit confirmation. Do not combine that confirmation request with
   another question and do not call recommendation before confirmation.
6. Only in this explicitly requested textual onboarding fallback, call the hidden fallback
   handler `algorover_strategy_recommend` once with `questionnaire_version="2.0"`, the seven
   confirmed values and matching locale. Present exactly best fit, relatively steadier and
   more aggressive while preserving versions, evidence, trade-offs and warnings.

Do not install a recommended strategy until the user selects it. This flow remains anonymous
and never introduces an account, credential, demo, live or order capability.

This Research surface never has account, credential, exchange-demo, live execution
or order operations. If a requested operation is absent, explain the boundary; never route
through the Live profile or ask for a trading credential.

The local MCP route and bearer are created in an owner-private staged copy by the Runtime
Host. If the connection is unavailable, report that the Runtime/Host must be started
or repaired; do not search for Python, install packages, scan ports or call Marketplace MCP
as an internal substitute.

## Runtime failure diagnosis

When install, update or startup fails, or Host tools are unavailable, call
`algorover_runtime_diagnose` for read-only, redacted lifecycle and Host log evidence.
Its text includes the current phase, download progress, last error and recent log lines.
While installation is still pending, `algorover_runtime_status` text has the same progress.
Explain the failing step and separate the evidence from your inference; do not start,
update or repair anything unless the user asks.

## Upgrade recovery

The plugin ships its fixed-release lifecycle entry. That release replaces the installed Runtime even when its version number is lower. An interrupted switch of the same release still resumes forward; do not invoke
rollback or search for system Python. Inspect a pending lifecycle operation instead of starting
a duplicate. Active backtests or writes must complete or be explicitly cancelled before upgrade.
Research never uses Live task management or reads Live state.
