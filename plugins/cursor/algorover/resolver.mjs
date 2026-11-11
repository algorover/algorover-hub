import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { connect } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_RESOURCE_BYTES = 768 * 1024;
const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_FORWARD_TIMEOUT_MS = 210_000;
const SEARCH_FORWARD_TIMEOUT_MS = 4_000;
const SUPPORTED_RUNTIME_CONTRACT = Object.freeze({ major: 1, minor: 0 });
const onboardingResourceUri = (runtimeId) => `ui://algorover/strategy-onboarding-v1/${runtimeId.slice("sha256:".length)}.html`;
const searchResultsResourceUri = (runtimeId) => `ui://algorover/strategy-search-results-v1/${runtimeId.slice("sha256:".length)}.html`;
// A release directory is named by the first 16 hex digits of the Runtime ID (Bootstrap
// runtimeDirectory); its manifest's runtime_id stays the identity.
const releaseDirectory = (runtimeId) => runtimeId.slice("sha256:".length, "sha256:".length + 16);
// App-only tools: in-chat cards read and change their Host-owned state (ADR 0020); never listed to
// the model. A card call never installs, updates or starts the Runtime: a card that mounts in an
// old thread must not start AlgoRover, so these answer runtime_not_ready instead.
const CARD_TOOL_NAMES = new Set([
  "algorover_result_state",
  "algorover_view_open",
  "algorover_view_get",
  "algorover_view_act",
]);
const HOST_TOOL_NAMES = new Set([
  "algorover_connection_list",
  "algorover_tool_search",
  "algorover_tool_get",
  "algorover_tool_execute",
  "algorover_result_present",
  "algorover_view_present",
  ...CARD_TOOL_NAMES,
]);
// Pages an old thread may ask for: any earlier Runtime's digest serves the installed page.
const APP_RESOURCE_URI = /^ui:\/\/algorover\/([a-z0-9-]+)\/([0-9a-f]{64})\.html$/;
const APP_RESOURCES = Object.freeze({
  "strategy-onboarding-v1": { file: "onboarding.html", dashboardLinks: true },
  "strategy-search-results-v1": { file: "search-results.html", dashboardLinks: true },
  "runtime-confirmation-v1": { file: "confirmation.html", dashboardLinks: false },
  "runtime-view-v1": { file: "view.html", dashboardLinks: true },
});
const profile = process.argv[2];
if (!new Set(["research", "live"]).has(profile)) fatal("invalid_profile");

const root = dirname(fileURLToPath(import.meta.url));
const DISCOVER_INPUT_SCHEMA = readDiscoverSchema();
// What the model may pass: the discover request without include_access, which Live always adds itself
// so result cards can mark redeem-code strategies (Research has no redeem codes).
const SEARCH_INPUT_SCHEMA = (() => {
  const { include_access: _includeAccess, ...properties } = DISCOVER_INPUT_SCHEMA.properties ?? {};
  return Object.freeze({ ...DISCOVER_INPUT_SCHEMA, properties });
})();
const DISCOVER_OUTPUT_SCHEMA = readDiscoverOutputSchema();
const pluginVersion = readPluginVersion();
const productVersion = pluginVersion.split("+", 1)[0];
const delivery = readDelivery();
// Every status and Dashboard result repeats this identity, so another environment's "ready"
// (for example the local development plugin's) is never mistaken for this plugin's.
const pluginId = delivery.environment === "local" ? `algorover-${profile}-local` : `algorover-${profile}`;
// Each platform binds its own immutable Runtime release; the plugin version only orders
// publications, so a plugin update may keep this platform's Runtime unchanged.
const runtimeBinding = selectRuntimeBinding();
const boundVersion = runtimeBinding?.release_version ?? productVersion;
const boundRuntimeIds = runtimeBinding === null ? [] : [runtimeBinding.runtime_id];
const configuredRoot = process.env.ALGOROVER_PLUGIN_STATE_ROOT;
if (configuredRoot !== undefined && !isAbsolute(configuredRoot)) fatal("invalid_connection_root");
if (delivery.environment === "local" && configuredRoot === undefined) fatal("local_state_root_required");
const runtimeDirectory = `.algorover-runtime-${profile}-production`;
const pluginStateRoot = configuredRoot ?? join(homedir(), runtimeDirectory, "plugins");
const runtimeHome = configuredRoot === undefined ? join(homedir(), runtimeDirectory) : dirname(configuredRoot);
const sharedConnection = join(pluginStateRoot, "connections", `${profile}.json`);
const adjacentConnection = join(root, ".algorover-connection.json");
let admittedRuntimeId = null;
let bindingFailure = delivery.runtime_bindings.length > 0 && runtimeBinding === null ? "runtime_platform_unsupported" : null;
// The Node that runs this bridge also runs Bootstrap. Nodes before 18 lack the fetch and stream
// APIs Bootstrap needs and would fail without a readable cause, so refuse them up front.
const MINIMUM_NODE_MAJOR = 18;
const nodeFailure = Number.parseInt(process.versions.node, 10) < MINIMUM_NODE_MAJOR ? "node_version_unsupported" : null;

class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function handleRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return errorResponse(request?.id ?? null, -32600, "invalid_request");
  }
  const notification = !Object.hasOwn(request, "id");
  if (notification) return null;
  const id = request.id;
  if (request.method === "tools/call" && request.params?.name === "algorover_runtime_target") {
    const argumentsValue = request.params?.arguments ?? {};
    if (!isPlainObject(argumentsValue)) return errorResponse(id, -32602, "invalid_tool_call");
    return resultResponse(id, await executeRuntimeTarget(argumentsValue));
  }
  // On the VPS (ADR 0031), or after a switch in this process, the remote path answers.
  if (remoteTarget !== null || placementSwitched) {
    const response = await handleRemoteRequest(request);
    if (response !== undefined) return response;
  }
  if (request.method === "initialize") {
    return resultResponse(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      serverInfo: {
        name: `algorover-ready-bridge-${profile}`,
        version: productVersion,
        ...(readInstalledRuntimeId() === null ? {} : { runtimeId: readInstalledRuntimeId() }),
      },
      instructions: placementInstructions(),
    });
  }
  if (request.method === "ping") return resultResponse(id, {});
  if (request.method === "tools/list") return resultResponse(id, { tools: await listTools() });
  if (request.method === "tools/call") {
    const name = request.params?.name;
    const argumentsValue = request.params?.arguments ?? {};
    if (typeof name !== "string" || argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
      return errorResponse(id, -32602, "invalid_tool_call");
    }
    if (!(name in LIFECYCLE_HANDLERS) && !CARD_TOOL_NAMES.has(name) && (HOST_TOOL_NAMES.has(name) || ["algorover_strategy_search", "algorover_strategy_recommend", "algorover_onboarding_open", "algorover_dashboard_open", "algorover_redeem_code_open"].includes(name))) {
      const ready = await ensureForUse();
      if (ready !== null) return resultResponse(id, toolResult(ready, true));
    }
    if (name === "algorover_runtime_diagnose") {
      requireEmpty(argumentsValue);
      const diagnosis = await runtimeDiagnosis();
      return resultResponse(id, {
        content: [{ type: "text", text: diagnosisText(diagnosis) }],
        structuredContent: diagnosis,
      });
    }
    if (name === "algorover_strategy_search") return resultResponse(id, await executeStrategySearch(argumentsValue));
    if (name === "algorover_strategy_recommend") return resultResponse(id, await executeHostOperation("catalog.strategy.recommend", recommendationArguments(argumentsValue)));
    if (name === "algorover_onboarding_open") {
      const locale = argumentsValue.locale;
      if (!new Set(["en", "ko", "zh-CN", "zh-TW"]).has(locale)) throw new BridgeError("invalid_locale");
      const connection = await healthyConnection();
      if (connection === null) return resultResponse(id, toolResult({ ...(await runtimeStatus()), message: "runtime_not_ready" }, true));
      // The Host issues the view and keeps its answers and recommendation; the thread id in _meta
      // (Codex) binds the view to this conversation.
      const opened = await forward(connection, { jsonrpc: "2.0", id: "bridge-view-open", method: "tools/call", params: {
        name: "algorover_view_open", arguments: { kind: "onboarding", params: { locale } },
        ...(isPlainObject(request.params?._meta) ? { _meta: request.params._meta } : {}),
      } });
      const viewId = opened?.result?.structuredContent?.view_id;
      if (opened?.result?.isError === true || typeof viewId !== "string" || !/^view_[0-9a-f]{32}$/.test(viewId)) {
        return resultResponse(id, toolResult({ ...(await runtimeStatus()), message: "onboarding_unavailable" }, true));
      }
      return resultResponse(id, {
        ...toolResult({ schema: "algorover-strategy-onboarding-v1", profile, locale, questionnaire_version: "2.0", view_id: viewId }),
        content: [{ type: "text", text: "Onboarding App requested. Let the user continue in the interactive card and end this turn without repeating questionnaire choices or opening another question tool. Rendering visibility is unknown to this tool; do not claim that the App failed to appear. Use text onboarding only if the host explicitly reports App rendering unsupported/failed, or the user reports the card unusable or explicitly requests text onboarding." }],
        _meta: { "algorover/view": { view_id: viewId } },
      });
    }
    if (name === "algorover_dashboard_open") {
      const opened = await executeHostOperation("dashboard.open", dashboardArguments(argumentsValue));
      // The link counts only when this plugin's own bound Runtime still serves it.
      const identity = await boundIdentity();
      if (identity === null) return resultResponse(id, toolResult({ ...(await runtimeStatus()), state: "error", connection_ready: false, message: "environment_mismatch", required_action: "inspect_runtime_status" }, true));
      return resultResponse(id, dashboardOpenResult(opened, identity));
    }
    if (name === "algorover_redeem_code_open") return resultResponse(id, await executeRedeemCodeOpen(argumentsValue));
    if (name in LIFECYCLE_HANDLERS) {
      const result = await LIFECYCLE_HANDLERS[name](argumentsValue);
      const response = resultResponse(id, toolResult(result));
      return response;
    }
    if (!HOST_TOOL_NAMES.has(name)) return errorResponse(id, -32601, "tool_not_found");
    return forwardHost(request);
  }
  if (request.method === "resources/list") {
    if ((await runtimeStatus()).state !== "ready") return resultResponse(id, { resources: [] });
    const connection = await healthyConnection();
    if (connection === null) return resultResponse(id, { resources: [] });
    return forward(connection, request);
  }
  if (request.method === "resources/read") {
    // The running Host knows the Dashboard's actual port; the installed release still serves the
    // page when the Runtime is stopped, so a card can say so instead of staying blank.
    let hosted = null;
    if ((await runtimeStatus()).state === "ready") {
      const connection = await healthyConnection();
      if (connection !== null) {
        try { hosted = await forward(connection, request); } catch { hosted = null; }
        if (hosted?.result) return hosted;
      }
    }
    const local = readLocalAppResource(request.params?.uri);
    if (local !== null) return resultResponse(id, { contents: [local] });
    return hosted ?? errorResponse(id, -32001, "runtime_not_ready");
  }
  return errorResponse(id, -32601, "method_not_found");
}

const LIFECYCLE_HANDLERS = {
  algorover_runtime_status: async (argumentsValue) => {
    requireEmpty(argumentsValue);
    return await runtimeStatus();
  },
  algorover_runtime_start: async (argumentsValue) => {
    return runLifecycle("ensure-start", switchArguments(argumentsValue));
  },
  algorover_runtime_update: async (argumentsValue) => {
    return runLifecycle("update", switchArguments(argumentsValue));
  },
  algorover_runtime_repair: async (argumentsValue) => {
    return runLifecycle("repair", switchArguments(argumentsValue));
  },
};

async function listTools() {
  const connection = await healthyConnection();
  const lifecycle = lifecycleTools(connection?.runtime_id ?? coldOnboardingRuntimeId());
  if (connection === null) return lifecycle;
  const response = await forward(connection, { jsonrpc: "2.0", id: "bridge-tools", method: "tools/list", params: {} });
  const tools = response?.result?.tools;
  return Array.isArray(tools) ? [...lifecycle, ...tools] : lifecycle;
}

// Pin discovery to release metadata before installation, without starting the Runtime.
// Never choose an arbitrary platform from a multi-Runtime release binding.
function coldOnboardingRuntimeId() {
  if (bindingFailure !== null) return null;
  const installedId = readInstalledRuntimeId();
  if (installedId !== null) {
    const runtime = readInstalledRuntime(installedId);
    if (runtime === null || !supportsRuntimeContract(runtime.contractVersion)
        || (admittedRuntimeId !== null && admittedRuntimeId !== installedId)) return null;
    // An older installation still needs the target URI in the client's first tool list.
    // This advertises presentation only; resource reads retain healthyConnection admission.
    if (boundRuntimeIds.length === 1) return boundRuntimeIds[0];
    return matchesRelease(installedId, runtime) ? installedId : null;
  }
  return boundRuntimeIds.length === 1 ? boundRuntimeIds[0] : null;
}

function lifecycleTools(runtimeId = null) {
  const emptyInput = { type: "object", properties: {}, required: [], additionalProperties: false };
  const switchInput = { type: "object", oneOf: [emptyInput, { type: "object", additionalProperties: false,
    properties: { action: { enum: ["defer", "stop_and_continue"] }, operation_id: { type: "string", pattern: "^[0-9a-f-]{36}$" }, snapshot_digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } },
    required: ["action", "operation_id", "snapshot_digest"] }] };
  const output = {
    type: "object",
    properties: {
      state: { enum: ["ready", "stopped", "not_installed", "update_required", "awaiting_confirmation", "deferred", "stale_session", "error"] },
      switch: { type: ["object", "null"] },
      profile: { enum: ["live", "research"] },
      plugin_id: { type: "string" },
      environment: { enum: ["production", "local"] },
      plugin_version: { type: "string" },
      version: { type: "string" },
      expected_product_version: { type: "string" },
      runtime_version: { type: ["string", "null"] },
      runtime_contract_version: { type: ["string", "null"] },
      runtime_id: { type: ["string", "null"] },
      bootstrap_installed: { type: "boolean" },
      lifecycle: { type: ["object", "null"] },
      connection_ready: { type: "boolean" },
      repair_allowed: { type: "boolean" },
      required_action: { type: ["string", "null"] },
      message: { type: ["string", "null"] },
      placement: { enum: ["local", "remote"] },
      node_version: { type: "string" },
      node_required: { type: "string" },
    },
    required: ["state", "profile", "plugin_id", "environment", "version", "plugin_version", "expected_product_version", "runtime_version", "runtime_contract_version", "runtime_id", "bootstrap_installed", "connection_ready", "repair_allowed", "required_action", "message"],
    additionalProperties: false,
  };
  const definitions = [
    ["algorover_runtime_status", "Runtime Status", "Inspect local AlgoRover Runtime and Host readiness without starting them. Reports plugin_id, environment (production or local), plugin_version and runtime_version; only a result whose plugin_id and environment match the plugin you meant to use counts as ready. The text includes the current phase, download progress, last error, and recent redacted log lines.", true],
    ["algorover_runtime_start", "Runtime Start", "Download/install when needed and start the local AlgoRover Runtime Host.", false],
    ["algorover_runtime_update", "Runtime Update", "Update to the channel Runtime and restart the local Host.", false],
    ["algorover_runtime_repair", "Runtime Repair", "Reinstall the channel Runtime and restart the local Host.", false],
  ];
  const tools = definitions.map(([name, title, description, readOnly]) => ({
    name, title, description: readOnly ? description : `${description} If the switch would pause work, returns awaiting_confirmation with the exact snapshot: a "trading" entry means running strategies pause during the switch and resume automatically after it; other entries are old trading tasks of the previous version that will be stopped keeping their positions. Only submit stop_and_continue after the user agrees; defer leaves the old installation running. Background tasks such as backtests keep running either way.`, inputSchema: readOnly ? emptyInput : switchInput, outputSchema: output,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly },
  }));
  tools.push({ name: "algorover_runtime_diagnose", title: "Diagnose Runtime", description: "Collect redacted, read-only evidence for AlgoRover Runtime install, update and startup failures. The text includes the current phase, download progress, last error, and recent log lines, including while installation is still running. Works even when the Runtime is not installed or not running. For failed jobs, backtests or trading runs use the Runtime diagnostics.failure operations instead.", inputSchema: emptyInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
  tools.push({
    name: "algorover_strategy_search", title: "Search Strategies",
    description: `Search profile-scoped strategies for ordinary chat requests with multilingual relevance, strict filters, facets, and match explanations. When the user asks for an exact number of recommendations, pass that number as limit (for example 1, 2, or 3) so the conversation and App show the same count. Use a larger limit only when the user asks for options or multiple candidates. ${profile === "live" ? "For a Live plugin mention with no other message content, open Dashboard and onboarding; do not search." : "Open onboarding only when the user explicitly asks for the questionnaire."}`,
    inputSchema: searchSchema(),
    outputSchema: searchOutputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ...(runtimeId === null ? {} : {
      _meta: {
        ui: { resourceUri: searchResultsResourceUri(runtimeId) },
        "openai/outputTemplate": searchResultsResourceUri(runtimeId),
      },
    }),
  });
  tools.push({
    name: "algorover_onboarding_open", title: "Open Strategy Onboarding",
    description: `Open the interactive seven-question strategy onboarding and show its owner-computed recommendation in the same App.${profile === "live" ? " A Live plugin mention with no other message content requests this onboarding after Dashboard opens." : ""}`,
    inputSchema: { type: "object", properties: { locale: { enum: ["en", "ko", "zh-CN", "zh-TW"] } }, required: ["locale"], additionalProperties: false },
    outputSchema: { type: "object", properties: { schema: { const: "algorover-strategy-onboarding-v1" }, profile: { enum: ["live", "research"] }, locale: { enum: ["en", "ko", "zh-CN", "zh-TW"] }, questionnaire_version: { const: "2.0" }, view_id: { type: "string", pattern: "^view_[0-9a-f]{32}$" } }, required: ["schema", "profile", "locale", "questionnaire_version", "view_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...(runtimeId === null ? {} : {
      _meta: {
        ui: { resourceUri: onboardingResourceUri(runtimeId) },
        "openai/outputTemplate": onboardingResourceUri(runtimeId),
      },
    }),
  });
  if (profile === "live") tools.push({
    name: "algorover_redeem_code_open", title: "Open Redeem Code",
    description: "Use when the user's message contains an AlgoRover agent redeem code (EP-XXXX-XXXX-XXXX-XXXX, any letter case, spaces allowed), for example \"请使用 AlgoRover 兑换码 EP-7K3M-9QX2-H8WD-4TRC 安装策略\". Reads which strategy and agent the code belongs to without using it, and returns a Dashboard link where the user signs in if needed, redeems and installs. A universal code belongs to no strategy: it can be used on any one Invite-only strategy, which the user chooses in the Dashboard. Never redeem the code, choose its strategy or install the strategy from chat.",
    inputSchema: { type: "object", properties: { code: { type: "string", minLength: 1, maxLength: 64 } }, required: ["code"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  });
  tools.push({
    name: "algorover_dashboard_open", title: "Open Dashboard",
    description: `Start or reuse the Host-owned profile Dashboard and optionally open one exact typed target. A target only controls navigation; it never installs or runs anything.${profile === "live" ? " A custom_strategy target opens one of the user's custom strategies (custom_id from custom_strategy.*), at one revision when given." : ""}`,
    inputSchema: dashboardSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  tools.push(runtimeTargetTool());
  return tools;
}

const REDEEM_TARGET_CODE = /^[0-9A-Za-z-]{16,32}$/;
// Live Dashboard pages a card may open; the Host contract's own list.
const DASHBOARD_PAGES = ["strategies", "live"];

function completedOutput(result, operationId) {
  const outcomes = result?.structuredContent?.outcomes;
  const outcome = Array.isArray(outcomes) && outcomes.length === 1 ? outcomes[0] : null;
  return outcome?.operation_id === operationId ? outcome : null;
}

function redeemResult(payload, text, isError = false) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { schema: "algorover-redeem-code-v1", profile, ...payload },
    ...(isError ? { isError: true } : {}),
  };
}

// The Server owns codes and redeeming; chat only previews a code and hands the user to the
// Dashboard, so the model can never use a code on the user's behalf.
async function executeRedeemCodeOpen(value) {
  if (profile !== "live" || Object.keys(value).join(",") !== "code" || typeof value.code !== "string"
      || value.code.length > 64) throw new BridgeError("invalid_tool_call");
  const code = value.code.replace(/\s+/g, "");
  if (!REDEEM_TARGET_CODE.test(code)) {
    return redeemResult({ code_status: "invalid" }, "This is not an AlgoRover redeem code. Ask the user to check it; codes look like EP-XXXX-XXXX-XXXX-XXXX.", true);
  }
  const resolved = await executeHostOperation("redeem.code.resolve", { code });
  if (resolved?.isError === true) return resolved;
  const outcome = completedOutput(resolved, "redeem.code.resolve");
  if (outcome?.status !== "completed") {
    const failure = typeof outcome?.failure?.code === "string" ? outcome.failure.code : "redeem_check_failed";
    const text = failure === "redeem_code_invalid"
      ? "This redeem code does not exist. Ask the user to check it or ask their agent for the correct code."
      : failure === "rate_limited" ? "Too many redeem code checks. Ask the user to try again in a minute."
        : `The redeem code could not be checked (${failure}). Ask the user to try again later.`;
    return redeemResult({ code_status: "unchecked", failure }, text, true);
  }
  const { code_status: status, strategy, agent, viewer, validity_days: days, universal, claimed_strategy: spentOn } = outcome.output ?? {};
  if (universal === true) return redeemUniversalCode(code, { status, viewer, days, spentOn });
  const facts = { code_status: status, strategy: { slug: strategy?.slug, name: strategy?.name }, agent: { display_name: agent?.display_name }, ...(Number.isInteger(days) ? { validity_days: days } : {}), ...(viewer ? { viewer } : {}) };
  const named = `the strategy "${strategy?.name}" (${strategy?.slug}), shared by agent ${agent?.display_name}`;
  // Access from a code lasts validity_days; a code used while access is still valid extends it from its expiry.
  const grants = Number.isInteger(days) ? ` Redeeming it grants ${days} days of access, counted from redeeming.` : "";
  const until = typeof viewer?.expires_at === "string" ? viewer.expires_at : null;
  let target = null;
  let text = "";
  if (status === "available" && strategy?.available === true && viewer?.entitled === true) {
    target = { kind: "redeem", code };
    text = `The signed-in account already has ${named}${until ? ` until ${until}` : ""}. This code renews it: redeeming adds ${Number.isInteger(days) ? `${days} days` : "its days"} to the current expiry date. Give the user this Dashboard link; they confirm the renewal there. Do not redeem it from chat. The link works for about 10 minutes; if it expires, ask the user to send the code again:`;
  } else if (viewer?.entitled === true && strategy?.available === true && strategy?.current_version) {
    // Without a content digest the exact strategy target is impossible; the redeem dialog installs entitled users too.
    target = strategy.content_sha256
      ? { kind: "strategy", slug: strategy.slug, version: strategy.current_version, content_sha256: strategy.content_sha256 }
      : { kind: "redeem", code };
    text = `The signed-in account already has ${named}${until ? ` until ${until}` : ""}; the code cannot be used now and is not needed. Give the user this Dashboard link to install it:`;
  } else if (status === "available" && strategy?.available === true) {
    target = { kind: "redeem", code };
    const lapsed = until && viewer?.entitled === false ? ` The account's earlier access expired on ${until}; redeeming restores it.` : "";
    text = `The redeem code is valid for ${named}.${grants}${lapsed} Give the user this Dashboard link; they sign in if needed, then redeem and install there. Do not redeem or install it from chat. The link works for about 10 minutes; if it expires, ask the user to send the code again:`;
  } else if (viewer?.entitled === true) {
    return redeemResult(facts, `The signed-in account already has ${named}, but it cannot be installed right now; the code is not needed. Ask the user to try again later.`, true);
  } else if (status === "used") {
    return redeemResult(facts, viewer === undefined
      ? `This code for ${named} has already been used. If the user redeemed it with their own account, ask them to sign in to the Dashboard, where the strategy is available to that account.`
      : viewer.used_by_viewer === true
        ? `This account already used this code for ${named}, but its access ${until ? `expired on ${until}` : "is no longer active"}. To keep using the strategy the user needs a new code from their agent.`
        : `This code for ${named} was already used by another account. Ask the user to get a new code from their agent.`, true);
  } else if (status === "disabled") {
    return redeemResult(facts, `This code for ${named} has been disabled. Ask the user to get a new code from their agent.`, true);
  } else {
    return redeemResult(facts, `${named} cannot be installed right now; the code was not used. Ask the user to try again later.`, true);
  }
  const opened = completedOutput(await executeHostOperation("dashboard.open", { target }), "dashboard.open");
  const url = opened?.status === "completed" ? opened.output?.url : null;
  if (!dashboardLoopbackUrl(url)) return redeemResult(facts, "The Dashboard could not be opened. Ask the user to open AlgoRover Dashboard and enter the code on the strategy page.", true);
  return redeemResult({ ...facts, dashboard_url: url }, `${text} ${url}`);
}

// A universal code belongs to no strategy or agent: the user spends it on one Invite-only strategy,
// chosen in the Dashboard's redeem dialog, never in chat.
async function redeemUniversalCode(code, { status, viewer, days, spentOn }) {
  const used = spentOn && typeof spentOn.slug === "string" && typeof spentOn.name === "string" ? { slug: spentOn.slug, name: spentOn.name } : null;
  const facts = { code_status: status, universal: true, ...(Number.isInteger(days) ? { validity_days: days } : {}), ...(used ? { claimed_strategy: used } : {}), ...(viewer ? { viewer } : {}) };
  if (status === "used") {
    return redeemResult(facts, used
      ? `This account already used this universal redeem code on the strategy "${used.name}" (${used.slug}); a code can be used only once.`
      : viewer?.used_by_viewer === true ? "This account already used this universal redeem code; a code can be used only once."
        : viewer === undefined
          ? "This universal redeem code has already been used. If the user redeemed it with their own account, ask them to sign in to the Dashboard, where the strategy they chose is available to that account."
          : "This universal redeem code was already used by another account and cannot be used again.", true);
  }
  if (status !== "available") return redeemResult(facts, "This universal redeem code has been disabled and cannot be used.", true);
  const grants = Number.isInteger(days) ? ` It grants ${days} days of access, counted from redeeming, or added to the current expiry when the account already holds the chosen strategy.` : "";
  const opened = completedOutput(await executeHostOperation("dashboard.open", { target: { kind: "redeem", code } }), "dashboard.open");
  const url = opened?.status === "completed" ? opened.output?.url : null;
  if (!dashboardLoopbackUrl(url)) return redeemResult(facts, "The Dashboard could not be opened. Ask the user to open AlgoRover Dashboard and enter the code on the strategy page.", true);
  return redeemResult({ ...facts, dashboard_url: url }, `This is a universal redeem code: it can be used on any one Invite-only strategy and is then used up.${grants} The user chooses the strategy in the Dashboard. Give the user this Dashboard link; they sign in if needed, choose the strategy, then redeem and install there. Do not choose a strategy for them, redeem or install from chat. The link works for about 10 minutes; if it expires, ask the user to send the code again: ${url}`);
}

function recommendationSchema() {
  const locale = { enum: ["en", "ko", "zh-CN", "zh-TW"] };
  return { type: "object", additionalProperties: false, properties: {
    questionnaire_version: { const: "2.0" },
    profit_style: { enum: ["trend", "reversal", "relative_value"] },
    holding_period: { enum: ["intraday", "multi_day", "multi_week"] },
    pain_point: { enum: ["loss_streak", "inactivity", "tail_loss"] },
    max_drawdown_pct: { enum: [5, 15, 20] },
    trading_mode: { enum: ["long_only_no_leverage", "long_short_low_leverage", "long_short_high_leverage"] },
    allocation_band: { enum: ["under_25k", "25k_100k", "over_100k"] },
    universe: { enum: ["majors", "altcoins", "any"] },
    locale,
  }, required: ["questionnaire_version", "profit_style", "holding_period", "pain_point", "max_drawdown_pct", "trading_mode", "allocation_band", "universe", "locale"] };
}

function dashboardTargetSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { const: "strategy" },
      slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 80 },
      version: { type: "string", pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$", maxLength: 64 },
      content_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    required: ["kind", "slug", "version", "content_sha256"],
  };
}

// Live also opens one custom strategy. One flat object (not oneOf) keeps the schema usable by
// every MCP client; dashboardArguments accepts exactly one of the two shapes.
function liveDashboardTargetSchema() {
  const strategy = dashboardTargetSchema();
  return {
    type: "object",
    additionalProperties: false,
    description: "One of {kind: \"strategy\", slug, version, content_sha256}, {kind: \"custom_strategy\", custom_id, revision (optional)}, {kind: \"page\", page: \"strategies\" | \"live\"} or {kind: \"trading_account\", venue, mode: \"demo\" | \"live\", instance_id (optional)} (the Live page at that account).",
    properties: {
      ...strategy.properties,
      kind: { enum: ["strategy", "custom_strategy", "page", "trading_account"] },
      custom_id: { type: "string", pattern: "^[a-z0-9]{6}$" },
      revision: { type: "integer", minimum: 1, maximum: 999999 },
      page: { enum: DASHBOARD_PAGES },
      venue: { type: "string", pattern: "^[A-Z][A-Z0-9_]{1,31}$" },
      mode: { enum: ["demo", "live"] },
      instance_id: { type: "string", pattern: "^si_[0-9a-z]{1,61}$" },
    },
    required: ["kind"],
  };
}

function dashboardSchema() {
  const target = profile === "live" ? liveDashboardTargetSchema() : dashboardTargetSchema();
  return {
    type: "object",
    additionalProperties: false,
    properties: { target },
    required: [],
  };
}

function dashboardArguments(value) {
  if (Object.keys(value).length === 0) return {};
  if (Object.keys(value).sort().join(",") !== "target" || value.target === null
      || typeof value.target !== "object" || Array.isArray(value.target)) throw new BridgeError("invalid_tool_call");
  const target = value.target;
  // A Live page: what in-chat cards hand over to (ADR 0022).
  if (target.kind === "page" && profile === "live") {
    if (Object.keys(target).sort().join(",") !== "kind,page" || !DASHBOARD_PAGES.includes(target.page)) throw new BridgeError("invalid_tool_call");
    return { target: { kind: "page", page: target.page } };
  }
  // The Live page at one trading account, and one instance when given: what a monitor or incident card opens.
  if (target.kind === "trading_account" && profile === "live") {
    const keys = Object.keys(target).sort().join(",");
    if ((keys !== "kind,mode,venue" && keys !== "instance_id,kind,mode,venue")
        || typeof target.venue !== "string" || !/^[A-Z][A-Z0-9_]{1,31}$/.test(target.venue)
        || (target.mode !== "demo" && target.mode !== "live")
        || (keys.startsWith("instance_id") && (typeof target.instance_id !== "string" || !/^si_[0-9a-z]{1,61}$/.test(target.instance_id)))) {
      throw new BridgeError("invalid_tool_call");
    }
    return { target: { ...target } };
  }
  if (target.kind === "custom_strategy" && profile === "live") {
    const keys = Object.keys(target).sort().join(",");
    if ((keys !== "custom_id,kind" && keys !== "custom_id,kind,revision")
        || typeof target.custom_id !== "string" || !/^[a-z0-9]{6}$/.test(target.custom_id)
        || (keys.endsWith("revision") && (!Number.isInteger(target.revision) || target.revision < 1 || target.revision > 999999))) {
      throw new BridgeError("invalid_tool_call");
    }
    return { target: { ...target } };
  }
  if (Object.keys(target).sort().join(",") !== "content_sha256,kind,slug,version"
      || target.kind !== "strategy" || typeof target.slug !== "string"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.slug) || target.slug.length > 80
      || typeof target.version !== "string" || target.version.length > 64
      || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(target.version)
      || typeof target.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(target.content_sha256)) throw new BridgeError("invalid_tool_call");
  return { target: { ...target } };
}

// Clients that only show content text never see structuredContent. Put the exact
// loopback URL there; keep the structured result for clients that prefer it.
function dashboardOpenResult(result, identity) {
  const outcomes = result?.structuredContent?.outcomes;
  const outcome = Array.isArray(outcomes) && outcomes.length === 1 ? outcomes[0] : null;
  const url = outcome?.output?.url;
  if (outcome?.operation_id !== "dashboard.open" || outcome?.status !== "completed" || !dashboardLoopbackUrl(url)) return result;
  return { ...result, content: [{ type: "text", text: url }], structuredContent: { ...result.structuredContent, identity: { ...identity, dashboard_url: url } } };
}

// The plugin and Runtime a Dashboard link belongs to; null unless the bound Runtime is connected.
async function boundIdentity() {
  const runtimeId = readInstalledRuntimeId();
  const runtime = readInstalledRuntime(runtimeId);
  const connection = await healthyConnection(runtimeId, runtime);
  if (connection === null || runtime === null) return null;
  return { plugin_id: pluginId, environment: delivery.environment, plugin_version: pluginVersion, runtime_version: runtime.releaseVersion, runtime_id: connection.runtime_id };
}

function dashboardLoopbackUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port !== ""
    && parsed.username === "" && parsed.password === "" && parsed.search === ""
    && (parsed.pathname === "" || parsed.pathname === "/");
}

function recommendationArguments(value) {
  const schema = recommendationSchema();
  if (Object.keys(value).sort().join(",") !== [...schema.required].sort().join(",")) throw new BridgeError("invalid_tool_call");
  for (const [key, property] of Object.entries(schema.properties)) {
    if (Object.hasOwn(property, "const") && value[key] !== property.const) throw new BridgeError("invalid_tool_call");
    if (Array.isArray(property.enum) && !property.enum.includes(value[key])) throw new BridgeError("invalid_tool_call");
  }
  return { ...value };
}

function searchSchema() {
  return SEARCH_INPUT_SCHEMA;
}

function searchOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      schema: { const: "algorover-strategy-search-results-v1" },
      profile: { enum: ["live", "research"] },
      request: DISCOVER_INPUT_SCHEMA,
      result: DISCOVER_OUTPUT_SCHEMA,
    },
    required: ["schema", "profile", "request", "result"],
  };
}

function searchArguments(value) {
  const allowed = new Set(Object.keys(searchSchema().properties));
  if (Object.keys(value).some(key => !allowed.has(key))) throw new BridgeError("invalid_tool_call");
  return {
    ...value, diversity: value.diversity ?? "none", limit: value.limit ?? 10,
    ...(profile === "live" ? { include_access: true } : {}),
  };
}

function readDiscoverSchema() {
  let value;
  try { value = JSON.parse(readFileSync(join(root, "strategy-discover-input.json"), "utf8")); }
  catch { fatal("discover_contract_missing"); }
  if (value?.type !== "object" || value.additionalProperties !== false || !Array.isArray(value.required)
      || !value.required.includes("locale") || !value.required.includes("limit") || !value.required.includes("diversity")) {
    fatal("discover_contract_invalid");
  }
  return Object.freeze(value);
}

function readDiscoverOutputSchema() {
  let value;
  try { value = JSON.parse(readFileSync(join(root, "strategy-discover-output.json"), "utf8")); }
  catch { fatal("discover_contract_missing"); }
  if (value?.type !== "object" || value.additionalProperties !== false || !Array.isArray(value.required)
      || !value.required.includes("strategies") || value.properties?.contract_version?.const !== "2.1") {
    fatal("discover_contract_invalid");
  }
  return Object.freeze(value);
}

async function executeStrategySearch(value) {
  const request = searchArguments(value);
  const result = await executeHostOperation("catalog.strategy.discover", request, SEARCH_FORWARD_TIMEOUT_MS);
  if (result?.isError === true) return result;
  const outcomes = result?.structuredContent?.outcomes;
  const outcome = Array.isArray(outcomes) && outcomes.length === 1 ? outcomes[0] : null;
  const output = outcome?.output;
  if (outcome?.operation_id !== "catalog.strategy.discover" || outcome?.status !== "completed"
      || output === null || typeof output !== "object" || Array.isArray(output)
      || output.contract_version !== "2.1" || !Array.isArray(output.strategies)) {
    return toolResult({ schema: "algorover-strategy-search-failure-v1", profile, code: "search_result_invalid" }, true);
  }
  const payload = { schema: "algorover-strategy-search-results-v1", profile, request, result: output };
  return {
    content: [{ type: "text", text: searchFallback(payload) }],
    structuredContent: payload,
  };
}

function searchFallback(payload) {
  const strategies = Number.isInteger(payload.request.limit)
    ? payload.result.strategies.slice(0, payload.request.limit)
    : payload.result.strategies;
  const count = strategies.length;
  const prefix = payload.request.locale === "zh-CN" ? `已准备 ${count} 个搜索结果`
    : payload.request.locale === "zh-TW" ? `已準備 ${count} 個搜尋結果`
      : payload.request.locale === "ko" ? `${count}개의 검색 결과가 준비되었습니다`
        : `${count} search results are ready`;
  const identities = strategies
    .map(strategy => `${strategy.name} (${strategy.slug}@${strategy.version})${redeemNote(strategy)}`)
    .join(", ");
  const notes = [...(payload.result.needs_clarification ?? []), ...(payload.result.unsupported_constraints ?? []), ...(payload.result.relaxed_filters ?? [])];
  return `${prefix}${identities ? `: ${identities}` : ""}${notes.length ? `. Notes: ${notes.join("; ")}` : ""}. Use the interactive strategy result cards to open a strategy in Dashboard.`;
}

// The text the model reads names redeem-code strategies like the cards do; redeeming stays in Dashboard.
function redeemNote(strategy) {
  if (strategy.access?.mode !== "redeem_code") return "";
  return strategy.access.entitled === true ? " [redeem code, unlocked]"
    : strategy.access.entitled === false ? " [needs a redeem code]" : " [redeem-code strategy]";
}

// 只读搜索卡必须绑定请求中的精确 Runtime release，但不应被 Host 会话准入状态阻断。
function readLocalAppResource(uri) {
  if (typeof uri !== "string") return null;
  const match = APP_RESOURCE_URI.exec(uri);
  if (match === null || !Object.hasOwn(APP_RESOURCES, match[1])) return null;
  // The installed Runtime's page first, whatever Runtime the thread recorded; then the recorded
  // Runtime's own page while that release is still on disk. Either must pass the same checks.
  for (const runtimeId of new Set([readInstalledRuntimeId(), `sha256:${match[2]}`])) {
    const content = readReleaseAppResource(runtimeId, APP_RESOURCES[match[1]], uri);
    if (content !== null) return content;
  }
  return null;
}

function readReleaseAppResource(runtimeId, resource, uri) {
  if (typeof runtimeId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(runtimeId)) return null;
  const digest = runtimeId.slice("sha256:".length);
  const runtimeRoot = join(runtimeHome, "runtime");
  const releasesRoot = join(runtimeRoot, "releases");
  const currentRelease = join(releasesRoot, releaseDirectory(runtimeId));
  const release = existsSync(currentRelease) ? currentRelease : join(releasesRoot, digest);
  const appsRoot = join(release, "apps");
  const appRoot = join(release, "apps", "mcp-app");
  const path = join(appRoot, resource.file);
  try {
    const runtimeMetadata = lstatSync(runtimeRoot);
    const releasesMetadata = lstatSync(releasesRoot);
    const releaseMetadata = lstatSync(release);
    const appsMetadata = lstatSync(appsRoot);
    const appMetadata = lstatSync(appRoot);
    const manifestPath = join(release, "RUNTIME.json");
    const manifestMetadata = lstatSync(manifestPath);
    const metadata = lstatSync(path);
    if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()
        || !releasesMetadata.isDirectory() || releasesMetadata.isSymbolicLink()
        || !releaseMetadata.isDirectory() || releaseMetadata.isSymbolicLink()
        || !appsMetadata.isDirectory() || appsMetadata.isSymbolicLink()
        || !appMetadata.isDirectory() || appMetadata.isSymbolicLink()
        || !manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size > 256 * 1024
        || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RESOURCE_BYTES) return null;
    const manifestBytes = readBoundedRegularFile(manifestPath, 256 * 1024);
    if (manifestBytes === null) return null;
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    const runtime = {
      releaseVersion: manifest?.payload?.release_version,
      contractVersion: manifest?.payload?.contract_version,
    };
    if (manifest?.runtime_id !== runtimeId || !Array.isArray(manifest?.payload?.profiles)
        || !manifest.payload.profiles.includes(profile) || runtimePayloadDigest(manifest.payload) !== runtimeId
        || typeof runtime.releaseVersion !== "string"
        || !Number.isInteger(runtime.contractVersion?.major) || !Number.isInteger(runtime.contractVersion?.minor)
        || !supportsRuntimeContract(runtime.contractVersion) || !matchesRelease(runtimeId, runtime)) return null;
    const entries = manifest.payload.files;
    const expected = Array.isArray(entries)
      ? entries.filter(entry => entry?.path === `apps/mcp-app/${resource.file}`)
      : [];
    if (expected.length !== 1 || expected[0].kind !== "file" || expected[0].executable !== false
        || expected[0].size !== metadata.size || !/^sha256:[0-9a-f]{64}$/.test(expected[0].sha256)) return null;
    const bytes = readBoundedRegularFile(path, MAX_RESOURCE_BYTES);
    if (bytes === null || bytes.length !== metadata.size) return null;
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expected[0].sha256) return null;
    const port = process.env[profile === "live" ? "ALGOROVER_LIVE_DASHBOARD_PORT" : "ALGOROVER_RESEARCH_DASHBOARD_PORT"]
      ?? (profile === "live" ? "9797" : "9696");
    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return null;
    // Without a running Host the actual port is unknown; the default is a known limitation (ADR 0020).
    const origin = `http://127.0.0.1:${port}`;
    return {
      uri,
      mimeType: "text/html;profile=mcp-app",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": {
          connect_domains: [],
          resource_domains: [],
          ...(resource.dashboardLinks ? { redirect_domains: [origin] } : {}),
        },
      },
    };
  } catch { return null; }
}

function readBoundedRegularFile(path, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumBytes) return null;
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    return bytes;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function runtimePayloadDigest(payload) {
  const canonical = value => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    throw new TypeError("runtime manifest payload is not canonical JSON");
  };
  return `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
}

async function executeHostOperation(operationId, argumentsValue, timeoutMs = MCP_FORWARD_TIMEOUT_MS) {
  const connection = await healthyConnection();
  if (connection === null) return toolResult({ ...(await runtimeStatus()), message: "runtime_not_ready" }, true);
  const get = await forward(connection, { jsonrpc: "2.0", id: "bridge-operation-get", method: "tools/call", params: { name: "algorover_tool_get", arguments: { operation_ids: [operationId], include_output_schema: false } } }, timeoutMs);
  const operation = get?.result?.structuredContent?.operations?.[0];
  if (operation?.id !== operationId || typeof operation.schema_revision !== "string") throw new BridgeError("operation_unavailable");
  const execute = await forward(connection, { jsonrpc: "2.0", id: "bridge-operation-execute", method: "tools/call", params: { name: "algorover_tool_execute", arguments: { calls: [{ call_id: `bridge-${operationId.replaceAll(".", "-")}`, operation_id: operationId, schema_revision: operation.schema_revision, authority: "direct", arguments: argumentsValue }], presentation: "never" } } }, timeoutMs);
  if (execute?.error) throw new BridgeError(String(execute.error.message ?? "operation_failed"));
  return execute.result;
}

async function runLifecycle(command, managementArguments = {}) {
  const before = await runtimeStatus();
  if (before.state === "stale_session") return before;
  if (before.message === "node_version_unsupported") return before;
  if (before.message === "runtime_operation_pending") return before;
  if (new Set(["update", "repair"]).has(command) && !before.repair_allowed) return staleSession(before);
  const channelUrl = process.env.ALGOROVER_CHANNEL_URL ?? delivery.channel_url;
  const bootstrap = validateBootstrapFile(configuredBootstrapPath());
  const args = [bootstrap, command, "--runtime-home", runtimeHome, "--channel-url", channelUrl, "--product", profile, "--plugin-version", pluginVersion];
  args.push("--expected-product-version", boundVersion);
  for (const runtimeId of boundRuntimeIds) args.push("--expected-runtime-id", runtimeId);
  args.push("--environment", delivery.environment);
  if (delivery.marketplace_origin !== null) args.push("--marketplace-origin", delivery.marketplace_origin);
  if (process.env.ALGOROVER_LIVE_STATE_ROOT) args.push("--live-state-root", process.env.ALGOROVER_LIVE_STATE_ROOT);
  if (process.env.ALGOROVER_RESEARCH_STATE_ROOT) args.push("--research-state-root", process.env.ALGOROVER_RESEARCH_STATE_ROOT);
  for (const [key, value] of Object.entries(managementArguments)) args.push(`--${key}`, value);
  const completed = await runLifecycleProcess(args);
  if (completed.error?.code === "ETIMEDOUT") throw new BridgeError("runtime_timeout");
  if (completed.status !== 0) {
    const code = /^AlgoRover bootstrap: ([a-z0-9_]+)$/mu.exec(completed.stderr ?? "")?.[1] ?? "bootstrap_failed";
    if (new Set(["runtime_identity_incompatible", "runtime_version_incompatible"]).has(code)) {
      bindingFailure = code;
      return runtimeStatus();
    }
    if (new Set(["plugin_incompatible", "contract_incompatible"]).has(code)) return staleSession(await runtimeStatus());
    return { ...(await runtimeStatus()), state: "error", connection_ready: false, message: code,
      required_action: "inspect_runtime_status" };
  }
  let outcome;
  try { outcome = JSON.parse(completed.stdout); } catch { /* Older lifecycle fixtures return no structured output. */ }
  if (["awaiting_confirmation", "deferred"].includes(outcome?.state)) {
    return { ...(await runtimeStatus()), state: outcome.state, switch: outcome.switch, lifecycle: outcome.lifecycle,
      connection_ready: false, required_action: outcome.required_action, message: outcome.state === "awaiting_confirmation" ? "runtime_switch_confirmation_required" : "runtime_switch_deferred" };
  }
  const connection = await healthyConnection();
  if (connection === null) return { ...(await runtimeStatus()), state: "error", message: "host_not_ready" };
  admittedRuntimeId = connection.runtime_id;
  const result = await runtimeStatus();
  if (result.state !== "ready") return { ...result, message: result.message ?? "host_not_ready" };
  setTimeout(() => {
    writeResponse({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    writeResponse({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
  }, 0);
  return result;
}

async function ensureForUse() {
  const status = await runtimeStatus();
  if (status.state === "stale_session") return status;
  if (status.message === "runtime_operation_pending" || status.message === "runtime_operation_identity_unverified") return status;
  if (["awaiting_confirmation", "deferred"].includes(status.state)) return status;
  if (status.state === "ready") { admittedRuntimeId = status.runtime_id; return null; }
  const result = await runLifecycle("ensure-start");
  return result.state === "ready" ? null : result;
}

function lifecycleSnapshot() {
  const path = join(runtimeHome, "runtime", "lifecycle.json");
  if (!existsSync(path)) return null;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) return { phase: "repair_required", last_error: "lifecycle_state_invalid" };
    const value = JSON.parse(readFileSync(path, "utf8"));
    const phases = ["prepare", "inspect", "awaiting_confirmation", "deferred", "quiesce", "retire", "migrate", "start", "commit", "ready", "blocked", "repair_required"];
    if (value === null || typeof value !== "object" || Array.isArray(value) || !phases.includes(value.phase)) {
      return { phase: "repair_required", last_error: "lifecycle_state_invalid" };
    }
    const snapshot = Object.fromEntries(["operation_id", "target_version", "target_runtime_id", "phase", "last_error", "updated_at", "cleanup_pending", "selection", "blockers"].map(key => [key, value[key] ?? null]));
    if (Number.isSafeInteger(value.download_received) && value.download_received >= 0) snapshot.download_received = value.download_received;
    if (Number.isSafeInteger(value.download_total) && value.download_total >= 0) snapshot.download_total = value.download_total;
    if (phases.includes(value.interrupted_phase)) snapshot.interrupted_phase = value.interrupted_phase;
    return snapshot;
  } catch { return { phase: "repair_required", last_error: "lifecycle_state_invalid" }; }
}

const DIAGNOSE_TAIL_BYTES = 256 * 1024;
const DIAGNOSE_PROBLEM = /error|exception|traceback|failed|failure|denied|refused|timed? ?out|killed|invalid|mismatch|unavailable|AlgoRover bootstrap/iu;

// Read-only install/startup evidence; the Host MCP may be unavailable here.
async function runtimeDiagnosis() {
  const logs = join(runtimeHome, "runtime", "logs");
  const hostLog = diagnosticLines(tailText(join(logs, "host.log")), 40, 10);
  let operations = [];
  try {
    operations = readdirSync(logs).filter(name => /^operation-[0-9a-f-]{36}\.(?:err|out)$/u.test(name))
      .map(name => ({ name, modified: lstatSync(join(logs, name)).mtimeMs }))
      .sort((left, right) => right.modified - left.modified);
  } catch { /* No lifecycle operation has run yet. */ }
  const latest = operations[0]?.name.replace(/\.(?:err|out)$/u, "") ?? null;
  const lastOperation = latest === null ? null : {
    at: new Date(operations[0].modified).toISOString(),
    stderr: diagnosticLines(tailText(join(logs, `${latest}.err`)), 30, 10),
    stdout: diagnosticLines(tailText(join(logs, `${latest}.out`)), 10, 5),
  };
  let lastFailure = null;
  try {
    const path = join(logs, "last-failed-operation.json");
    if (lstatSync(path).isFile() && lstatSync(path).size <= 65536) lastFailure = JSON.parse(readFileSync(path, "utf8"));
  } catch { /* No failed lifecycle operation recorded. */ }
  const status = await runtimeStatus();
  const gaps = [];
  if (!existsSync(logs)) gaps.push("runtime_logs_missing");
  if (hostLog.length === 0) gaps.push("host_log_empty_or_missing");
  if (lastOperation === null && lastFailure === null) gaps.push("no_lifecycle_operation_output");
  return { schema: "algorover-runtime-diagnostics-v1", profile, plugin_version: pluginVersion, status, lifecycle: lifecycleSnapshot(), host_log: hostLog,
    last_operation: lastOperation, last_failed_operation: lastFailure, gaps };
}

// Operation output is deleted after each call; keep one redacted record of the
// most recent failure so install/update/start problems remain diagnosable.
function recordFailedOperation(logs, command, completed) {
  try {
    const record = {
      schema: "algorover-failed-lifecycle-operation-v1", at: new Date().toISOString(), command: String(command ?? ""),
      exit_status: completed.status, stderr: diagnosticLines(completed.stderr, 30, 10), stdout: diagnosticLines(completed.stdout, 10, 5),
    };
    const target = join(logs, "last-failed-operation.json"), temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } catch { /* Diagnostics must never change the lifecycle result. */ }
}

function tailText(path) {
  let descriptor = null;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return "";
    descriptor = openSync(path, "r");
    const length = Math.min(metadata.size, DIAGNOSE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, metadata.size - length);
    return buffer.toString("utf8");
  } catch { return ""; } finally { if (descriptor !== null) closeSync(descriptor); }
}

function diagnosticLines(text, limit, keepTail) {
  const lines = text.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "").split(/\r?\n/u).map(line => line.trimEnd()).filter(Boolean);
  const tailStart = Math.max(0, lines.length - keepTail);
  const chosen = lines.map((line, index) => index >= tailStart || DIAGNOSE_PROBLEM.test(line) ? index : -1).filter(index => index >= 0);
  const selected = [];
  for (const index of chosen.slice(-limit)) {
    const cleaned = scrubDiagnosticLine(lines[index]);
    if (selected.at(-1) !== cleaned) selected.push(cleaned);
  }
  return selected;
}

function scrubDiagnosticLine(line) {
  let value = line.replace(/(bearer\s+)[^\s"',;]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:sign|signature|token|key|apikey|api_key|passphrase|secret)=)[^&\s"']+/giu, "$1[REDACTED]")
    .replace(/((?:password|passwd|pwd|api[_-]?(?:key|secret)|secret|passphrase|token|authorization)\s*[=:]\s*)([^\s,;]+)/giu, "$1[REDACTED]");
  const home = homedir();
  if (home.length > 1) value = value.split(home).join("~");
  value = value.replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s"']+/gu, "~")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[EMAIL]")
    .replace(/(?<![A-Za-z0-9_:/.-])[A-Za-z0-9+/_=-]{40,}/gu, "[TOKEN]");
  return value.length > 400 ? `${value.slice(0, 400)}…` : value;
}

function lifecycleExecution() {
  const lock = join(runtimeHome, "runtime", "lifecycle.lock"), path = join(lock, "owner.json");
  if (!existsSync(lock)) return null;
  try {
    if (!lstatSync(lock).isDirectory() || lstatSync(lock).isSymbolicLink()
        || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 4096) return "unverified";
    const owner = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return "unverified";
    try { process.kill(owner.pid, 0); } catch (error) { return error.code === "ESRCH" ? null : "unverified"; }
    let birth = null;
    if (process.platform === "linux") {
      birth = `linux:${readFileSync(`/proc/${owner.pid}/stat`, "utf8").split(") ")[1].split(" ")[19]}`;
    } else if (process.platform === "darwin") {
      const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(owner.pid)], { encoding: "utf8", timeout: 1000 });
      if (result.status === 0 && result.stdout.trim()) birth = `macos:${result.stdout.trim()}`;
    } else if (process.platform === "win32") {
      const powershell = join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${owner.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf8", timeout: 3000, windowsHide: true });
      if (result.status === 0 && /^\d+$/.test(result.stdout.trim())) birth = `windows:${result.stdout.trim()}`;
    }
    return birth === null || typeof owner.birth !== "string" ? "unverified" : birth === owner.birth ? "running" : null;
  } catch { return existsSync(lock) ? "unverified" : null; }
}

async function runtimeStatus() {
  const runtimeId = readInstalledRuntimeId();
  const bootstrap = configuredBootstrapPath();
  const runtime = readInstalledRuntime(runtimeId);
  const incompatible = runtime !== null && !supportsRuntimeContract(runtime.contractVersion);
  const executing = lifecycleExecution();
  const connection = incompatible || executing !== null ? null : await healthyConnection(runtimeId, runtime);
  const base = {
    profile,
    plugin_id: pluginId,
    environment: delivery.environment,
    lifecycle: lifecycleSnapshot(),
    version: productVersion,
    plugin_version: pluginVersion,
    expected_product_version: boundVersion,
    runtime_version: runtime?.releaseVersion ?? null,
    runtime_contract_version: runtimeContractLabel(runtime?.contractVersion ?? null),
    runtime_id: connection?.runtime_id ?? runtimeId,
    bootstrap_installed: existsSync(bootstrap),
    connection_ready: connection !== null,
    // The VPS copy of this bridge runs with ALGOROVER_RUNTIME_PLACEMENT=remote (ADR 0031).
    placement: process.env.ALGOROVER_RUNTIME_PLACEMENT === "remote" ? "remote" : "local",
  };
  if (nodeFailure !== null) return { ...base, state: "error", connection_ready: false, repair_allowed: false,
    required_action: "install_node", message: nodeFailure, node_version: process.versions.node, node_required: `>=${MINIMUM_NODE_MAJOR}` };
  if (bindingFailure !== null) return { ...base, state: "stale_session", connection_ready: false,
    repair_allowed: false, required_action: "update_plugin_and_reload", message: bindingFailure };
  if (incompatible || (admittedRuntimeId !== null && runtimeId !== admittedRuntimeId)) return staleSession(base);
  if (executing !== null) return { ...base, state: executing === "running" ? "stopped" : "error", connection_ready: false,
    repair_allowed: false, required_action: executing === "running" ? "wait_for_runtime_status" : "inspect_runtime_status",
    message: executing === "running" ? "runtime_operation_pending" : "runtime_operation_identity_unverified" };
  if (base.lifecycle?.selection && base.lifecycle.target_version === boundVersion
      && boundRuntimeIds.includes(base.lifecycle.selection.target_runtime_id)
      && ["awaiting_confirmation", "deferred"].includes(base.lifecycle.phase)) {
    return { ...base, state: base.lifecycle.phase, switch: base.lifecycle.selection, connection_ready: false,
      repair_allowed: true, required_action: base.lifecycle.phase === "awaiting_confirmation" ? "choose_runtime_switch" : null,
      message: base.lifecycle.phase === "awaiting_confirmation" ? "runtime_switch_confirmation_required" : "runtime_switch_deferred" };
  }
  if (runtime !== null && !matchesRelease(runtimeId, runtime)) {
    return { ...base, state: "update_required", connection_ready: false, repair_allowed: true, required_action: "start", message: "runtime_update_required" };
  }
  return {
    ...base,
    state: connection === null ? (runtimeId === null ? "not_installed" : "stopped") : "ready",
    repair_allowed: true,
    required_action: null,
    message: runtimeId !== null && runtime === null ? "runtime_manifest_invalid" : null,
  };
}

function staleSession(value) {
  return { ...value, state: "stale_session", connection_ready: false, repair_allowed: false, required_action: "reload_or_new_task", message: "plugin_session_stale" };
}

function readInstalledRuntimeId() {
  try {
    const value = JSON.parse(readFileSync(join(runtimeHome, "runtime", "current.json"), "utf8"));
    return typeof value.current_runtime_id === "string" ? value.current_runtime_id : null;
  } catch { return null; }
}

function readInstalledRuntime(runtimeId) {
  if (runtimeId === null || !/^sha256:[0-9a-f]{64}$/.test(runtimeId)) return null;
  // Migration (WP-098): until the first switch away from it, a release installed before
  // 16-digit names sits in a directory named by the whole digest.
  for (const directory of [releaseDirectory(runtimeId), runtimeId.slice("sha256:".length)]) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(runtimeHome, "runtime", "releases", directory, "RUNTIME.json"), "utf8")); } catch { continue; }
    if (manifest?.runtime_id !== runtimeId) continue;
    const releaseVersion = manifest.payload?.release_version;
    const contractVersion = manifest.payload?.contract_version;
    if (typeof releaseVersion !== "string" || !Number.isInteger(contractVersion?.major) || !Number.isInteger(contractVersion?.minor)) return null;
    return { releaseVersion, contractVersion };
  }
  return null;
}

function supportsRuntimeContract(value) {
  return value?.major === SUPPORTED_RUNTIME_CONTRACT.major && value.minor <= SUPPORTED_RUNTIME_CONTRACT.minor;
}

function runtimeContractLabel(value) {
  return value === null ? null : `${value.major}.${value.minor}`;
}

async function forwardHost(request) {
  const connection = await healthyConnection();
  if (connection === null) {
    return resultResponse(request.id, toolResult({ ...(await runtimeStatus()), message: "runtime_not_ready" }, true));
  }
  return forward(connection, request);
}

async function forward(connection, request, timeoutMs = MCP_FORWARD_TIMEOUT_MS) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(connection.endpoint, {
      method: "POST",
      headers: {
        "Authorization": ["Bearer", connection.bearer_token].join(" "),
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "X-AlgoRover-Runtime-ID": connection.runtime_id,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
      redirect: "error",
    });
    if (response.status === 202) return null;
    const body = await response.text();
    const maximum = request.method === "resources/read" ? MAX_RESOURCE_BYTES : MAX_MESSAGE_BYTES;
    if (Buffer.byteLength(body, "utf8") > maximum) throw new BridgeError("response_too_large");
    if (!response.ok) throw new BridgeError(`host_http_${response.status}`);
    return JSON.parse(body);
  } catch (error) {
    if (error?.name === "AbortError") throw new BridgeError("host_timeout");
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("host_unavailable");
  } finally {
    clearTimeout(deadline);
  }
}

function readConnection() {
  const path = existsSync(adjacentConnection) ? adjacentConnection : sharedConnection;
  let metadata;
  let connection;
  try {
    metadata = lstatSync(path);
    connection = JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) return null;
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) return null;
  if (Object.keys(connection).sort().join(",") !== "bearer_token,endpoint,profile,runtime_id,schema"
      || connection.schema !== "algorover-loopback-connection-v1" || connection.profile !== profile
      || !/^[A-Za-z0-9._~-]{40,512}$/.test(connection.bearer_token)) return null;
  let endpoint;
  try { endpoint = new URL(connection.endpoint); } catch { return null; }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== `/mcp/${profile}`) return null;
  return connection;
}

async function healthyConnection(
  runtimeId = readInstalledRuntimeId(),
  runtime = readInstalledRuntime(runtimeId),
) {
  const connection = readConnection();
  if (connection === null) return null;
  if (runtimeId === null || connection.runtime_id !== runtimeId
      || runtime === null || !supportsRuntimeContract(runtime.contractVersion) || !matchesRelease(runtimeId, runtime)) return null;
  try {
    const response = await fetch(connection.endpoint, {
      method: "POST",
      headers: { "Authorization": ["Bearer", connection.bearer_token].join(" "), "Content-Type": "application/json", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, "X-AlgoRover-Runtime-ID": runtimeId },
      body: JSON.stringify({ jsonrpc: "2.0", id: "bridge-probe", method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } }),
      redirect: "error",
      signal: AbortSignal.timeout(500),
    });
    const body = response.ok ? await response.json() : null;
    return body?.result?.serverInfo?.runtimeId === runtimeId && body.result.serverInfo.runtimeReady !== false
      && readInstalledRuntimeId() === runtimeId ? connection : null;
  } catch { return null; }
}

function matchesRelease(runtimeId, runtime) {
  return runtime.releaseVersion === boundVersion && (boundRuntimeIds.length === 0 || boundRuntimeIds.includes(runtimeId));
}

function toolResult(value, isError = false) {
  isError ||= value?.state === "error" || value?.state === "stale_session";
  const pending = value?.message === "runtime_operation_pending";
  const unfinished = pending || isError || (typeof value?.state === "string" && value.state !== "ready");
  const upgrading = value?.state === "update_required";
  const progress = installProgressText(value?.lifecycle);
  const lifecycleText = upgrading && progress ? ` previous_lifecycle${progress}` : progress;
  const recentLines = unfinished && !upgrading && value?.state !== "awaiting_confirmation" && value?.state !== "deferred" ? recentOperationEvidence() : [];
  const recent = recentLines.length ? ` Recent: ${recentLines.join(" | ")}.` : "";
  const text = value?.state === "awaiting_confirmation"
    ? "The target Runtime is prepared. Show the listed old processes/tasks and ask once: defer the switch, or stop the listed old version and continue. Stopping programs does not guarantee cancelling orders or closing positions. Only after that explicit choice call the same lifecycle tool with action, operation_id and snapshot_digest. Do not open the old Dashboard or onboarding as target success."
    : value?.state === "deferred" ? "Runtime switch deferred. The old environment is preserved; this target startup request has ended."
    : pending
    ? `AlgoRover Runtime installation or startup is still pending.${identityText(value)}${decisionText(value)}${progress}${recent} Wait for runtime_status to report ready with connection_ready=true before opening Dashboard or onboarding. Do not start another installation.`
    : unfinished
      ? `AlgoRover Runtime is not ready.${identityText(value)}${decisionText(value)}${lifecycleText}${recent} Follow required_action before opening Dashboard or onboarding.`
      : value?.state === "ready"
        ? `AlgoRover Runtime is ready.${identityText(value)} Installation and startup have completed; Dashboard and onboarding may now be opened. This ready belongs only to that plugin_id and environment; a ready from any other plugin (for example the local development plugin) is not this plugin's.`
        : "AlgoRover Runtime operation completed.";
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function identityText(value) {
  if (typeof value?.plugin_id !== "string") return "";
  return ` plugin_id=${value.plugin_id} environment=${value.environment} plugin_version=${value.plugin_version} runtime_version=${value.runtime_version ?? "none"}.`;
}

function decisionText(value) {
  if (typeof value?.state !== "string" || value.state === "ready") return "";
  const message = typeof value.message === "string" && value.message ? ` message=${value.message}` : "";
  const action = typeof value.required_action === "string" && value.required_action ? ` required_action=${value.required_action}` : "";
  const node = typeof value.node_version === "string" ? ` node_version=${value.node_version} node_required=${value.node_required}` : "";
  return ` state=${value.state}${message}${action}${node}.`;
}

function installProgressText(lifecycle) {
  if (lifecycle === null || typeof lifecycle !== "object") return "";
  const parts = [];
  if (typeof lifecycle.phase === "string") parts.push(`phase=${lifecycle.phase}`);
  if (typeof lifecycle.interrupted_phase === "string") parts.push(`interrupted_phase=${lifecycle.interrupted_phase}`);
  if (Number.isSafeInteger(lifecycle.download_received)) {
    parts.push(`download=${lifecycle.download_received}/${Number.isSafeInteger(lifecycle.download_total) ? lifecycle.download_total : "?"}`);
  }
  if (typeof lifecycle.last_error === "string" && lifecycle.last_error) parts.push(`last_error=${lifecycle.last_error}`);
  if (typeof lifecycle.updated_at === "string" && lifecycle.updated_at) parts.push(`updated_at=${lifecycle.updated_at}`);
  return parts.length ? ` ${parts.join(" ")}.` : "";
}

function diagnosisText(value) {
  const progress = installProgressText(value.lifecycle);
  const lines = [
    ...(value.last_operation?.stderr ?? []).slice(-4),
    ...(Array.isArray(value.last_failed_operation?.stderr) ? value.last_failed_operation.stderr.slice(-2) : []),
    ...(value.host_log ?? []).slice(-2),
  ].filter(line => typeof line === "string" && line);
  const unique = [];
  for (const line of lines) if (unique.at(-1) !== line) unique.push(line);
  const recent = unique.length ? ` Recent: ${unique.join(" | ")}.` : "";
  const gaps = Array.isArray(value.gaps) && value.gaps.length ? ` gaps=${value.gaps.join(",")}.` : "";
  return `Runtime install/startup diagnostics.${progress} state=${value.status?.state ?? "unknown"} message=${value.status?.message ?? "none"}.${recent}${gaps} Explain the failing step from this text; separate confirmed causes from guesses. Do not start, update, repair or stop anything unless the user asks.`;
}

function recentOperationEvidence(limit = 4) {
  const logs = join(runtimeHome, "runtime", "logs");
  let stderr = [];
  try {
    const operations = readdirSync(logs).filter(name => /^operation-[0-9a-f-]{36}\.err$/u.test(name))
      .map(name => ({ name, modified: lstatSync(join(logs, name)).mtimeMs }))
      .sort((left, right) => right.modified - left.modified);
    if (operations.length > 0) stderr = diagnosticLines(tailText(join(logs, operations[0].name)), 30, 8);
  } catch { /* No lifecycle operation is running. */ }
  let failed = [];
  try {
    const path = join(logs, "last-failed-operation.json");
    if (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && lstatSync(path).size <= 65536) {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(record.stderr)) failed = record.stderr.filter(line => typeof line === "string").map(scrubDiagnosticLine);
    }
  } catch { /* No failed lifecycle operation recorded. */ }
  const lines = [];
  for (const line of [...stderr, ...failed]) if (lines.at(-1) !== line) lines.push(line);
  return lines.slice(-limit);
}

function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function resultResponse(id, result) { return { jsonrpc: "2.0", id, result }; }
function errorResponse(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function writeResponse(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

function requireEmpty(value) {
  if (Object.keys(value).length !== 0) throw new BridgeError("invalid_arguments");
}

function switchArguments(value) {
  if (Object.keys(value).length === 0) return {};
  if (Object.keys(value).sort().join(",") !== "action,operation_id,snapshot_digest"
      || !["defer", "stop_and_continue"].includes(value.action) || !/^[0-9a-f-]{36}$/.test(value.operation_id)
      || !/^sha256:[0-9a-f]{64}$/.test(value.snapshot_digest)) throw new BridgeError("invalid_arguments");
  return { "switch-action": value.action, "operation-id": value.operation_id, "snapshot-digest": value.snapshot_digest };
}

function fatal(code) {
  process.stderr.write(`AlgoRover MCP bridge: ${code}\n`);
  process.exit(1);
}

function readDelivery() {
  let value;
  try { value = JSON.parse(readFileSync(join(root, "delivery.json"), "utf8")); } catch { throw new BridgeError("delivery_config_missing"); }
  if (value?.schema !== "algorover-delivery-v1" || value.product !== profile || !new Set(["local", "production"]).has(value.environment) || typeof value.channel_url !== "string" || value.compatibility !== "release" || value.product_version !== productVersion || Object.keys(value).sort().join(",") !== "channel_url,compatibility,environment,marketplace_origin,product,product_version,runtime_bindings,schema" || (profile === "live" ? typeof value.marketplace_origin !== "string" : value.marketplace_origin !== null)) throw new BridgeError("delivery_config_invalid");
  if (!validRuntimeBindings(value.runtime_bindings)) throw new BridgeError("delivery_config_invalid");
  if (value.runtime_bindings.length === 0 && productVersion !== "0.0.0" && !existsSync(join(root, ".algorover-connection.json"))) throw new BridgeError("runtime_binding_missing");
  validateDownloadUrl(value.channel_url);
  if ((value.environment === "local") !== (new URL(value.channel_url).hostname === "127.0.0.1")) throw new BridgeError("delivery_environment_invalid");
  if (value.marketplace_origin !== null) validateDownloadUrl(value.marketplace_origin);
  return value;
}

function validRuntimeBindings(bindings) {
  if (!Array.isArray(bindings)) return false;
  const platforms = new Set(), runtimeIds = new Set();
  for (const binding of bindings) {
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)
        || Object.keys(binding).sort().join(",") !== "arch,os,release_version,runtime_id"
        || !["macos", "windows", "linux"].includes(binding.os) || !["arm64", "amd64"].includes(binding.arch)
        || typeof binding.release_version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(binding.release_version)
        || typeof binding.runtime_id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(binding.runtime_id)) return false;
    platforms.add(`${binding.os}-${binding.arch}`);
    runtimeIds.add(binding.runtime_id);
  }
  return platforms.size === bindings.length && runtimeIds.size === bindings.length;
}

// Same platform names as Bootstrap's release directories (`releases/<version>/<os>-<arch>/`).
function selectRuntimeBinding() {
  const os = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  return delivery.runtime_bindings.find((binding) => binding.os === os && binding.arch === arch) ?? null;
}

function readPluginVersion() {
  try {
    const value = JSON.parse(readFileSync(join(root, ".codex-plugin", "plugin.json"), "utf8"));
    return typeof value.version === "string" ? value.version : "0.0.0";
  } catch { return "0.0.0"; }
}

function configuredBootstrapPath() {
  const configured = process.env.ALGOROVER_BOOTSTRAP_PATH;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new BridgeError("bootstrap_path_invalid");
    return configured;
  }
  return join(root, "bootstrap.mjs");
}

function lifecycleProcessEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LANG", "LC_ALL", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ALGOROVER_ENV", "ALGOROVER_LIVE_DASHBOARD_PORT", "ALGOROVER_RESEARCH_DASHBOARD_PORT", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "ALGOROVER_PROXY_URL", "ALGOROVER_PROXY_MODE", "XDG_RUNTIME_DIR", "TMPDIR", "USERNAME", "USERDOMAIN", "ALGOROVER_SERVICE_MODE", "ALGOROVER_RUNTIME_PLACEMENT"]).has(key.toUpperCase())));
  const names = Object.keys(environment).filter((key) => key.toUpperCase() === "NO_PROXY");
  if (names.length === 0) environment.NO_PROXY = "127.0.0.1";
  else for (const name of names) {
    const raw = String(environment[name] ?? "");
    const tokens = raw.split(",").map((item) => item.trim()).filter(Boolean);
    if (!tokens.some((item) => item.toLowerCase() === "127.0.0.1")) {
      environment[name] = ["127.0.0.1", ...tokens].join(",");
    }
  }
  return environment;
}

async function runLifecycleProcess(args) {
  const logs = join(runtimeHome, "runtime", "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const output = join(logs, `operation-${id}.out`), errors = join(logs, `operation-${id}.err`);
  const out = openSync(output, "wx", 0o600), err = openSync(errors, "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true, stdio: ["ignore", out, err], windowsHide: true,
      env: lifecycleProcessEnvironment(),
    });
  } finally { closeSync(out); closeSync(err); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.unref(); reject(new BridgeError("runtime_operation_pending")); }, 20 * 60_000);
    child.once("error", () => { clearTimeout(timer); reject(new BridgeError("runtime_start_failed")); });
    child.once("close", status => {
      clearTimeout(timer);
      const bounded = path => lstatSync(path).size <= 1024 * 1024 ? readFileSync(path, "utf8") : "";
      const completed = { status, stdout: bounded(output), stderr: bounded(errors) };
      if (status !== 0) recordFailedOperation(logs, args[1], completed);
      resolve(completed);
      rmSync(output, { force: true }); rmSync(errors, { force: true });
    });
  });
}

function validateBootstrapFile(path) {
  let metadata;
  try { metadata = lstatSync(path); } catch { throw new BridgeError("bootstrap_missing"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_BOOTSTRAP_BYTES) throw new BridgeError("bootstrap_path_invalid");
  return path;
}

function validateDownloadUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new BridgeError("download_url_invalid"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new BridgeError("download_url_invalid");
}

// ---------------------------------------------------------------------------------------------
// Remote placement (ADR 0031): this product's Runtime runs on the user's own VPS. This bridge then
// speaks MCP to a same-version copy of itself on the VPS over SSH, so the remote copy still sees
// a loopback Runtime and keeps every check it makes. Only one side runs at a time: switching
// refuses open trading work, stops the other side's services and keeps its install. The
// Dashboard opens through an SSH tunnel on the same loopback port, so links and cards work.
// deploy_to_vps prepares the VPS from what the user gives in the conversation (address, user
// and password or a key file): it installs this product's own SSH key, Node.js, linger and,
// for root, a service user, so that every later connection logs in with that key.
// ---------------------------------------------------------------------------------------------
const REMOTE_TARGET_SCHEMA = "algorover-remote-target-v1";
const REMOTE_RESULT_SCHEMA = "algorover-runtime-target-v1";
const remoteRoot = join(runtimeHome, "remote");
const remoteTargetPath = join(remoteRoot, "target.json");
const remoteKnownHosts = join(remoteRoot, "known_hosts");
const remoteKeyPath = join(remoteRoot, "id_ed25519");
const remoteTunnelsPath = join(remoteRoot, "tunnels.json");
// Ports a VPS Host of this product may serve its page on (default and fallback, ADR 0020).
const REMOTE_DASHBOARD_PORTS = profile === "live" ? [9797, 19797] : [9696, 19696];
const REMOTE_CONNECT_TIMEOUT_MS = 60_000;
const REMOTE_LIST_TIMEOUT_MS = 60_000;
// Same budget as the plugin's tool_timeout_sec (1260 s): a remote install can take minutes.
const REMOTE_CALL_TIMEOUT_MS = 1_250_000;
const REMOTE_COMMAND_TIMEOUT_MS = 240_000;
const REMOTE_MAX_LINE_BYTES = 2 * 1024 * 1024;
const MIGRATION_MAX_BYTES = 64 * 1024 * 1024;
const MIGRATION_MAX_FILE_BYTES = 16 * 1024 * 1024;
// Aliases only remain readable in targets saved by earlier versions of this plugin.
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|[0-9A-Fa-f:]{2,39})$/;
const SSH_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const REMOTE_COPY_NAME = /^[0-9A-Za-z.+_-]{1,96}$/;
const MINIMUM_REMOTE_GLIBC = [2, 35];
// The same floor as the bundled bootstrap (bootstrap.mjs::MINIMUM_NODE_MAJOR): an older Node would pass here and fail there.
const MINIMUM_REMOTE_NODE = 20;
const MINIMUM_REMOTE_DISK_BYTES = 3 * 1024 ** 3;
// The non-root user a Runtime runs as when the user gives root.
const REMOTE_SERVICE_USER = "algorover";
// Node.js installed into ~/.algorover-remote/node when the VPS has none (or an older one):
// the current LTS, verified against this digest whichever source answers.
const REMOTE_NODE = { version: "24.22.2", file: "node-v24.22.2-linux-x64.tar.gz",
  sha256: "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9" };
const MAXIMUM_PASSWORD_FAILURES = 2;
// Remote files of one plugin copy: the bridge itself, its bundled bootstrap and the data they read.
const REMOTE_PLUGIN_FILES = ["resolver.mjs", "bootstrap.mjs", "delivery.json", ".codex-plugin/plugin.json",
  "strategy-discover-input.json", "strategy-discover-output.json"];
const LIFECYCLE_TOOL_NAMES = new Set(["algorover_runtime_start", "algorover_runtime_update", "algorover_runtime_repair"]);
const PRODUCT_NAME = profile === "live" ? "Live" : "Research";

let remoteTarget = readRemoteTarget();
let remoteChannel = null;
// Set when this process switched away from a Runtime the conversation already used: like a
// replaced Runtime (stale_session) it must continue in a new conversation.
let placementSwitched = false;
let remoteAdmittedRuntimeId = null;
let remoteStale = false;
let remoteToolAnnotations = new Map();
// Rejected passwords per VPS in this conversation; servers often ban an address after a few.
const passwordFailures = new Map();

function runtimeTargetTool() {
  const secret = { type: "string", minLength: 1, maxLength: 512 };
  return {
    name: "algorover_runtime_target", title: "Runtime Location",
    description: [
      `Choose where this AlgoRover ${PRODUCT_NAME} Runtime runs: on this computer (default) or on the user's own Linux VPS (Ubuntu 22.04/24.04 or similar, x86_64), which keeps strategies running while the computer is off. Only one side runs at a time.`,
      "status: the current location.",
      "deploy_to_vps: ask the user once for the VPS address, SSH port (22 when not given), user name and password, or instead of the password the path of a private key file on this computer (such as a cloud provider's .pem). Pass them exactly as given and never repeat the password in a reply. The first call checks the VPS (it only copies this plugin there) and changes nothing else; it returns needs_input (ask only for the listed items, then call again with all arguments), unsuitable (explain why), refused (explain what to do first) or awaiting_confirmation with a plan. Show the plan and only after the user agrees call deploy_to_vps again with the same arguments plus confirmation: it prepares the VPS (AlgoRover's own SSH key, Node.js, background services, a separate user when given root), installs and starts the Runtime there and, when this computer has one, copies the user's strategies to the VPS and stops the Runtime here. When a step fails, calling deploy_to_vps again continues from it.",
      "switch_to_local: first returns awaiting_confirmation with a summary and a confirmation digest; only after the user agrees call it again with confirmation. Switching is refused while strategies run or hold positions or a background task runs. force=true is only for a VPS that cannot be reached, after warning that its strategies may still run.",
      "When a result's required_action is new_conversation, tell the user to start a new conversation and do not call other AlgoRover tools in this one.",
    ].join(" "),
    inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { enum: ["status", "deploy_to_vps", "switch_to_local"] },
      host: { type: "string", pattern: SSH_HOST.source },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      user: { type: "string", pattern: SSH_USER.source },
      password: secret,
      sudo_password: secret,
      key_file: { type: "string", minLength: 1, maxLength: 1024 },
      allow_not_durable: { type: "boolean" },
      reset_host_key: { type: "boolean" },
      confirmation: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      force: { type: "boolean" },
    } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}

// One sentence the client gives the model at the start of every conversation.
function placementInstructions() {
  const where = remoteTarget === null ? "this computer" : `the user's VPS ${destinationLabel(remoteTarget.destination)}`;
  return `AlgoRover ${PRODUCT_NAME} runs on ${where}. Say so when reporting the Runtime status or opening the Dashboard. To change it, use algorover_runtime_target.`;
}

// --- persisted state -----------------------------------------------------------------------

function readPrivateJson(path, maximumBytes = 64 * 1024) {
  let metadata;
  try { metadata = lstatSync(path); } catch { return null; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) return null;
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writePrivateJson(path, value) {
  mkdirSync(remoteRoot, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function validDestination(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys === "alias" && typeof value.alias === "string" && SSH_ALIAS.test(value.alias)) return { alias: value.alias };
  if (keys === "host,port,user" && typeof value.host === "string" && SSH_HOST.test(value.host)
      && Number.isSafeInteger(value.port) && value.port >= 1 && value.port <= 65535
      && typeof value.user === "string" && SSH_USER.test(value.user)) return { host: value.host, port: value.port, user: value.user };
  return null;
}

function sameDestination(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(validDestination(right));
}

function destinationLabel(destination) {
  return destination === null ? null : destination.alias ?? `${destination.user}@${destination.host}${destination.port === 22 ? "" : `:${destination.port}`}`;
}

function readRemoteTarget() {
  const value = readPrivateJson(remoteTargetPath);
  if (value === null || value.schema !== REMOTE_TARGET_SCHEMA || value.profile !== profile) return null;
  const destination = validDestination(value.destination);
  return destination === null ? null : { destination, activated_at: typeof value.activated_at === "string" ? value.activated_at : null,
    check: isPlainObject(value.check) ? value.check : null };
}

// --- SSH -----------------------------------------------------------------------------------

// ssh parses -o values itself: forward slashes and quotes keep Windows and spaced paths intact.
function sshPath(path) {
  const value = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

// How a connection logs in. batch: this product's key (once installed) and the user's own SSH
// keys, never a prompt. key_file: only the given private key. password: only the password,
// answered from memory through SSH_ASKPASS (withAskpass).
const BATCH = { mode: "batch" };

function sshOptions({ knownHosts = remoteKnownHosts, hostKeys = "yes", forwarding = false, auth = BATCH } = {}) {
  const login = auth.mode === "password"
    ? ["-o", "BatchMode=no", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=keyboard-interactive,password", "-o", "NumberOfPasswordPrompts=1"]
    : auth.mode === "key_file"
      ? ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", sshPath(auth.path)]
      : ["-o", "BatchMode=yes", ...(existsSync(remoteKeyPath) ? ["-i", sshPath(remoteKeyPath)] : [])];
  return ["-T", ...login, "-o", `StrictHostKeyChecking=${hostKeys}`,
    "-o", `UserKnownHostsFile=${sshPath(knownHosts)}`, "-o", `GlobalKnownHostsFile=${sshPath(knownHosts)}`,
    "-o", "UpdateHostKeys=no", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
    "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no", "-o", "LogLevel=ERROR",
    ...(forwarding ? ["-o", "ExitOnForwardFailure=yes"] : ["-o", "ClearAllForwardings=yes"])];
}

function sshDestination(destination) {
  return destination.alias !== undefined ? [destination.alias] : ["-p", String(destination.port), "-l", destination.user, destination.host];
}

function sshEnvironment(extra = {}) {
  // ssh needs the user's own environment (HOME, SSH_AUTH_SOCK, PATH); nothing else is passed on.
  return { ...process.env, ...extra };
}

function runProcess(command, args, { input = null, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS, maximumBytes = 8 * 1024 * 1024, env = sshEnvironment() } = {}) {
  return new Promise((accept) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    } catch { accept({ status: null, stdout: "", stderr: "", missing: true }); return; }
    const out = [], err = [];
    let outBytes = 0, errBytes = 0;
    child.stdout.on("data", (chunk) => { outBytes += chunk.length; if (outBytes <= maximumBytes) out.push(chunk); });
    child.stderr.on("data", (chunk) => { errBytes += chunk.length; if (errBytes <= 256 * 1024) err.push(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); accept({ status: null, stdout: "", stderr: "", missing: error?.code === "ENOENT" }); });
    child.once("close", (status) => {
      clearTimeout(timer);
      accept({ status, stdout: outBytes <= maximumBytes ? Buffer.concat(out).toString("utf8") : "", stderr: Buffer.concat(err).toString("utf8"),
        truncated: outBytes > maximumBytes, timedOut: status === null });
    });
    child.stdin.on("error", () => { /* the remote side may exit before reading everything */ });
    child.stdin.end(input ?? undefined);
  });
}

// ssh asks SSH_ASKPASS for the password; the helper prints it from a private file that exists
// only while this one ssh runs. The password never appears in arguments or the environment.
async function withAskpass(password, run) {
  mkdirSync(remoteRoot, { recursive: true, mode: 0o700 });
  const directory = join(remoteRoot, `askpass-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  try {
    const secret = join(directory, "secret");
    writeFileSync(secret, password, { mode: 0o600 });
    const helper = join(directory, process.platform === "win32" ? "askpass.cmd" : "askpass");
    writeFileSync(helper, process.platform === "win32" ? `@type "${secret}"\r\n` : `#!/bin/sh\nexec cat "${secret.replaceAll('"', '\\"')}"\n`, { mode: 0o700 });
    return await run({ SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || ":0" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// One fixed POSIX script run by the VPS user's login shell. It finds Node (the copy this plugin
// installs first, then PATH and the usual locations a non-interactive SSH shell misses) and never
// contains user input: data travels on stdin.
function remoteShell(body, { node = true } = {}) {
  const findNode = "N=\"\"; for c in \"$HOME\"/.algorover-remote/node/bin/node \"$(command -v node 2>/dev/null)\" /usr/local/bin/node /usr/bin/node \"$HOME\"/.nvm/versions/node/*/bin/node \"$HOME\"/.volta/bin/node \"$HOME\"/.local/bin/node; do if [ -z \"$N\" ] && [ -n \"$c\" ] && [ -x \"$c\" ]; then N=\"$c\"; fi; done; [ -n \"$N\" ] || { echo \"AlgoRover remote: node_missing\" >&2; exit 3; }; ";
  const script = (node ? findNode : "") + body;
  if (script.includes("'")) throw new BridgeError("remote_command_invalid");
  return `/bin/sh -c '${script}'`;
}

function remoteCopyName() {
  const name = `${pluginVersion}-${remoteBundle().digest.slice(0, 12)}`;
  if (!REMOTE_COPY_NAME.test(name)) throw new BridgeError("remote_copy_name_invalid");
  return name;
}

function remoteCopyDirectory() { return `"$HOME/.algorover-remote/${profile}/${remoteCopyName()}"`; }

async function runSsh(destination, command, { input = null, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS, hostKeys = "yes", knownHosts = remoteKnownHosts, auth = BATCH } = {}) {
  mkdirSync(remoteRoot, { recursive: true, mode: 0o700 });
  const args = [...sshOptions({ hostKeys, knownHosts, auth }), ...sshDestination(destination), command];
  const result = auth.mode === "password"
    ? await withAskpass(auth.password, (extra) => runProcess("ssh", args, { input, timeoutMs, env: sshEnvironment(extra) }))
    : await runProcess("ssh", args, { input, timeoutMs });
  return { ...result, code: result.status === 0 ? null : sshFailureCode(result) };
}

function sshFailureCode(result) {
  if (result.missing) return "ssh_missing";
  if (result.timedOut) return "ssh_timeout";
  const stderr = String(result.stderr ?? "");
  const own = /AlgoRover (?:remote|bootstrap): ([a-z0-9_]+)/u.exec(stderr)?.[1];
  if (own) return own;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed|host key .* differs/iu.test(stderr)) return "ssh_host_key_changed";
  if (/Host key verification failed|No .*host key is known|host key is not known/iu.test(stderr)) return "ssh_host_key_unknown";
  if (/Permission denied|Too many authentication failures|no more authentication methods|Authentication failed/iu.test(stderr)) return "ssh_auth_failed";
  if (/Could not resolve hostname|Name or service not known|nodename nor servname|No such host/iu.test(stderr)) return "ssh_host_not_found";
  if (/Connection refused/iu.test(stderr)) return "ssh_connection_refused";
  if (/timed out|Operation timed out|Network is unreachable|No route to host/iu.test(stderr)) return "ssh_timeout";
  if (/Connection closed|Connection reset|kex_exchange_identification/iu.test(stderr)) return "ssh_connection_closed";
  if (/Bad configuration option|Bad owner or permissions|unknown option|Unsupported option|Can't open user config|Load key .*: (?:invalid format|bad permissions)/iu.test(stderr)) return "ssh_config_invalid";
  return result.status === 255 ? "ssh_failed" : "remote_command_failed";
}

const SSH_GUIDANCE = {
  ssh_missing: "This computer has no ssh command. Install the OpenSSH client (built into macOS, Linux and Windows 10+).",
  ssh_auth_failed: "The VPS refused the login: check the user name and the password (or key file) with the user, then call deploy_to_vps again.",
  ssh_host_key_changed: "The VPS presents a different identity (host key) than before. If the user reinstalled or replaced this server, call deploy_to_vps again with reset_host_key=true; otherwise stop and ask the user to check with their VPS provider.",
  ssh_host_not_found: "The VPS address cannot be resolved. Check the address with the user.",
  ssh_connection_refused: "The VPS refused the SSH connection. Check the port (often 22) with the user and that SSH runs on the server.",
  ssh_connection_closed: "The VPS closed the SSH connection. The server may block this address after failed logins, or only allow other networks; check with the user or the VPS provider.",
  ssh_timeout: "The VPS did not answer in time. Check the address and port, the network (a server on an internal network needs this computer on the same network or VPN) and the VPS firewall.",
  ssh_config_invalid: "ssh rejected its configuration or the key file; check the key file path with the user.",
  node_missing: "The VPS has no usable Node.js; call deploy_to_vps, which installs it.",
  node_too_old: `The VPS Node.js is older than ${MINIMUM_REMOTE_NODE}; call deploy_to_vps, which installs a current one.`,
};

function guidance(code) { return SSH_GUIDANCE[code] ?? STEP_TEXT[code] ?? "Check the VPS and try again."; }

async function hostKeyFingerprints(path) {
  if (!existsSync(path)) return [];
  const result = await runProcess("ssh-keygen", ["-l", "-E", "sha256", "-f", path], { timeoutMs: 15_000 });
  if (result.status !== 0) return [];
  return [...new Set(result.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\d+\s+(SHA256:[A-Za-z0-9+/]{43})\s+.*\((\w+)\)\s*$/u.exec(line.trim());
    return match ? [`${match[1]} (${match[2]})`] : [];
  }))];
}

// This product's own key on this computer: the VPS trusts it once deploy_to_vps installed it.
async function pluginPublicKey() {
  if (!existsSync(remoteKeyPath)) {
    mkdirSync(remoteRoot, { recursive: true, mode: 0o700 });
    const created = await runProcess("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `algorover-${profile}`, "-f", remoteKeyPath], { timeoutMs: 30_000 });
    if (created.status !== 0) throw new BridgeError(created.missing ? "ssh_missing" : "ssh_key_create_failed");
  }
  const line = readFileSync(`${remoteKeyPath}.pub`, "utf8").trim().split(/\s+/u).slice(0, 3).join(" ");
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [A-Za-z0-9@._-]+)?$/u.test(line)) throw new BridgeError("ssh_key_invalid");
  return line;
}

// --- plugin copy and remote checks ---------------------------------------------------------

let cachedBundle = null;
function remoteBundle() {
  if (cachedBundle !== null) return cachedBundle;
  const files = REMOTE_PLUGIN_FILES.map((path) => {
    const bytes = readBoundedRegularFile(join(root, ...path.split("/")), MAX_BOOTSTRAP_BYTES);
    if (bytes === null) throw new BridgeError("remote_plugin_incomplete");
    return { path, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const digest = createHash("sha256").update(files.map((file) => `${file.path}\0${file.sha256}`).join("\n")).digest("hex");
  cachedBundle = { files, digest };
  return cachedBundle;
}

// A self-contained ES module piped to `node --input-type=module -` on the VPS: it writes the plugin
// copy to a temporary directory, verifies every digest, renames it into place and keeps one older
// copy. Data travels as a JSON literal, never through the shell.
function remoteSyncProgram() {
  const bundle = remoteBundle();
  const payload = JSON.stringify({ profile, copy: remoteCopyName(), files: bundle.files });
  return `import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const bundle = ${payload};
if (Number(process.versions.node.split(".")[0]) < ${MINIMUM_REMOTE_NODE}) { process.stderr.write("AlgoRover remote: node_too_old\\n"); process.exit(5); }
const base = join(homedir(), ".algorover-remote", bundle.profile);
mkdirSync(base, { recursive: true, mode: 0o700 });
if (lstatSync(base).isSymbolicLink()) { process.stderr.write("AlgoRover remote: remote_path_invalid\\n"); process.exit(6); }
const target = join(base, bundle.copy);
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const intact = () => bundle.files.every((file) => { try { return lstatSync(join(target, file.path)).isFile() && digest(join(target, file.path)) === file.sha256; } catch { return false; } });
let synced = false;
if (!intact()) {
  const temporary = join(base, ".incoming-" + randomUUID());
  for (const file of bundle.files) {
    if (file.path.split("/").some((part) => part === "" || part === "." || part === "..")) { process.stderr.write("AlgoRover remote: remote_path_invalid\\n"); process.exit(6); }
    const path = join(temporary, ...file.path.split("/"));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(file.data, "base64"), { mode: 0o600 });
    if (digest(path) !== file.sha256) { rmSync(temporary, { recursive: true, force: true }); process.stderr.write("AlgoRover remote: remote_copy_corrupt\\n"); process.exit(7); }
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(temporary, target);
  synced = true;
}
const others = readdirSync(base).filter((name) => name !== bundle.copy && !name.startsWith(".")).map((name) => ({ name, at: statSync(join(base, name)).mtimeMs })).sort((a, b) => b.at - a.at);
for (const old of others.slice(1)) rmSync(join(base, old.name), { recursive: true, force: true });
for (const name of readdirSync(base).filter((name) => name.startsWith(".incoming-"))) rmSync(join(base, name), { recursive: true, force: true });
process.stdout.write(JSON.stringify({ schema: "algorover-remote-sync-v1", synced, copy: bundle.copy }) + "\\n");
`;
}

async function syncRemotePlugin(destination, auth = BATCH) {
  const result = await runSsh(destination, remoteShell("exec \"$N\" --input-type=module -"), { input: remoteSyncProgram(), auth });
  if (result.code !== null) throw new BridgeError(result.code);
  return lastJsonLine(result.stdout);
}

function lastJsonLine(text) {
  const line = String(text ?? "").trim().split(/\r?\n/u).at(-1);
  try { return JSON.parse(line); } catch { throw new BridgeError("remote_output_invalid"); }
}

async function remoteBootstrap(destination, args, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS, auth = BATCH) {
  const quoted = args.map((value) => {
    if (!/^[A-Za-z0-9_.:=-]+$/u.test(value)) throw new BridgeError("remote_command_invalid");
    return value;
  }).join(" ");
  const command = remoteShell(`D=${remoteCopyDirectory()}; [ -f "$D/bootstrap.mjs" ] || { echo "AlgoRover remote: remote_plugin_missing" >&2; exit 4; }; exec "$N" "$D/bootstrap.mjs" ${quoted}`);
  let result = await runSsh(destination, command, { timeoutMs, auth });
  if (result.code === "remote_plugin_missing") {
    await syncRemotePlugin(destination, auth);
    result = await runSsh(destination, command, { timeoutMs, auth });
  }
  return result;
}

async function remoteHostCheck(destination, auth = BATCH) {
  await syncRemotePlugin(destination, auth);
  const checked = await remoteBootstrap(destination, ["host-check", "--product", profile, "--network", profile === "live" ? "yes" : "no"], REMOTE_COMMAND_TIMEOUT_MS, auth);
  if (checked.code !== null) throw new BridgeError(checked.code);
  return lastJsonLine(checked.stdout);
}

function compareVersionParts(text, minimum) {
  const parts = String(text ?? "").replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const value = Number.isFinite(parts[index]) ? parts[index] : 0;
    if (value !== minimum[index]) return value - minimum[index];
  }
  return 0;
}

// --- probing and preparing the VPS ---------------------------------------------------------

// Read-only facts about the VPS, gathered by the login user in one round trip without Node.
// With root the Runtime runs as REMOTE_SERVICE_USER, so its home, Node and linger are checked.
// stdin carries one line: the sudo password, which is only tried with `sudo -k true`.
const PROBE_SCRIPT = [
  "IFS= read -r P || P=\"\"",
  "I=$(id -u); U=$(id -un)",
  `if [ "$I" = 0 ]; then TU=${REMOTE_SERVICE_USER}; else TU="$U"; fi`,
  // The login session's own home is where sshd reads its keys; the passwd entry only for another user.
  "if [ \"$TU\" = \"$U\" ]; then TH=\"$HOME\"; else TH=$(getent passwd \"$TU\" 2>/dev/null | cut -d: -f6); fi",
  "echo os=$(uname -s); echo arch=$(uname -m); echo uid=$I; echo user=$U; echo target_user=$TU",
  "if [ -n \"$TH\" ]; then echo target_exists=yes; else echo target_exists=no; fi",
  "echo glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | cut -d\" \" -f2)",
  "V=\"\"; for c in \"$TH\"/.algorover-remote/node/bin/node \"$(command -v node 2>/dev/null)\" /usr/local/bin/node /usr/bin/node; do if [ -z \"$V\" ] && [ -n \"$c\" ] && [ -x \"$c\" ]; then V=$(\"$c\" -v 2>/dev/null); fi; done; echo node=$V",
  "if [ \"$(ps -o comm= -p 1 2>/dev/null)\" = systemd ]; then echo systemd=yes; else echo systemd=no; fi",
  "echo linger=$(loginctl show-user \"$TU\" -p Linger --value 2>/dev/null)",
  "echo ntp=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)",
  "echo disk_kb=$(df -Pk \"${TH:-$HOME}\" 2>/dev/null | tail -n 1 | tr -s \" \" | cut -d\" \" -f4)",
  "echo memory_kb=$(grep MemAvailable /proc/meminfo 2>/dev/null | tr -s \" \" | cut -d\" \" -f2)",
  "if [ \"$I\" = 0 ]; then S=root; elif sudo -n true >/dev/null 2>&1; then S=nopasswd; elif id -nG 2>/dev/null | tr \" \" \"\\n\" | grep -qx -e sudo -e wheel -e admin; then S=password; else S=none; fi; echo sudo=$S",
  "if [ \"$S\" = password ] && [ -n \"$P\" ]; then if printf \"%s\\n\" \"$P\" | sudo -S -k -p \"\" true >/dev/null 2>&1; then echo sudo_password=ok; else echo sudo_password=rejected; fi; fi",
  `if [ -n "$TH" ] && [ -f "$TH/.algorover-runtime-${profile}-production/runtime/current.json" ]; then echo installed=yes; else echo installed=no; fi`,
].join("; ");

async function probeVps(destination, auth, sudoPassword) {
  const result = await runSsh(destination, remoteShell(PROBE_SCRIPT, { node: false }), { input: `${sudoPassword ?? ""}\n`, hostKeys: "accept-new", auth, timeoutMs: 60_000 });
  if (result.code !== null) throw new BridgeError(result.code);
  const facts = {};
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^([a-z_]+)=(.*)$/u.exec(line.trim());
    if (match) facts[match[1]] = match[2].trim();
  }
  if (!facts.uid || !facts.user) throw new BridgeError("remote_output_invalid");
  return facts;
}

const STEP_TEXT = {
  create_user: `create the user "${REMOTE_SERVICE_USER}" to run AlgoRover (it does not run as root)`,
  enable_linger: "keep AlgoRover's services running after logout and start them at boot (linger)",
  sync_time: "turn on clock synchronization",
  install_key: "install AlgoRover's own SSH key, so later connections need no password",
  install_node: `install Node.js ${REMOTE_NODE.version} for AlgoRover only (in its home folder)`,
  install_runtime: "install and start the AlgoRover Runtime",
  connect_runtime: "connect to the AlgoRover Runtime already installed there",
  remote_platform_unsupported: "the VPS must be Linux on x86_64; arm64 and other systems are not supported",
  remote_glibc_too_old: "the VPS system is too old: it needs glibc 2.35 or newer (Ubuntu 22.04 or 24.04, Debian 12)",
  remote_runtime_unavailable: "this plugin version has no Linux Runtime",
  remote_disk_full: "less than 3 GB of disk space is free on the VPS",
  remote_services_unmanaged: "the VPS has no systemd, so AlgoRover does not restart on its own after a reboot or crash",
  remote_linger_unavailable: "AlgoRover cannot be kept running after logout (no sudo rights to turn on linger)",
  remote_clock_unsynchronized: "the VPS clock is not synchronized and there are no rights to turn it on (Binance rejects skewed requests)",
  remote_disk_low: "less than 5 GB of disk space is free",
  remote_memory_low: "less than 1.5 GB of memory is available",
  remote_dashboard_port_exposed: "a Dashboard port listens on a public address; the page has no sign-in, close it in the firewall",
  user_create_failed: "the user could not be created on the VPS",
  linger_failed: "linger could not be turned on",
  key_install_failed: "the SSH key could not be installed",
  key_login_refused: "the VPS does not accept AlgoRover's SSH key (the server may disable key login: PubkeyAuthentication in /etc/ssh/sshd_config)",
  node_download_failed: "Node.js could not be downloaded on the VPS (no internet access, or neither curl nor wget is installed)",
  node_checksum_mismatch: "the downloaded Node.js did not match its checksum",
  node_install_failed: "Node.js could not be unpacked on the VPS",
};

function checkText(code) {
  if (code.startsWith("remote_venue_restricted:")) return `${code.split(":")[1]} refuses this VPS region`;
  if (code.startsWith("remote_venue_unreachable:")) return `${code.split(":")[1]} cannot be reached from this VPS`;
  return STEP_TEXT[code] ?? code;
}

// What deploy_to_vps would do: blocking problems end it, needs are asked from the user, steps are
// what it will do on the VPS, warnings are shown in the plan.
function evaluateVps(facts, { keyLogin, sudoPassword, allowNotDurable, report }) {
  const blocking = [], needs = [], steps = [], warnings = [];
  const root = facts.uid === "0";
  if (facts.os !== "Linux" || !["x86_64", "amd64"].includes(facts.arch)) blocking.push("remote_platform_unsupported");
  else if (!facts.glibc || compareVersionParts(facts.glibc, MINIMUM_REMOTE_GLIBC) < 0) blocking.push("remote_glibc_too_old");
  if (!delivery.runtime_bindings.some((binding) => binding.os === "linux" && binding.arch === "amd64")) blocking.push("remote_runtime_unavailable");
  const disk = Number(facts.disk_kb) * 1024;
  if (Number.isFinite(disk) && disk > 0 && disk < MINIMUM_REMOTE_DISK_BYTES) blocking.push("remote_disk_full");
  const privileged = root || facts.sudo === "nopasswd" || facts.sudo_password === "ok";
  if (root && facts.target_exists !== "yes") steps.push("create_user");
  // linger belongs to systemd-logind: without systemd there is nothing to turn on (see the warning below).
  if (facts.linger !== "yes" && facts.systemd === "yes") {
    if (privileged) steps.push("enable_linger");
    else if (facts.sudo === "password" && !allowNotDurable) needs.push(facts.sudo_password === "rejected" || sudoPassword ? "sudo_password_rejected" : "sudo_password");
    else warnings.push("remote_linger_unavailable");
  }
  if (facts.ntp === "no") {
    if (privileged) steps.push("sync_time");
    else warnings.push("remote_clock_unsynchronized");
  }
  if (!keyLogin) steps.push("install_key");
  if (!facts.node || compareVersionParts(facts.node, [MINIMUM_REMOTE_NODE]) < 0) steps.push("install_node");
  steps.push(facts.installed === "yes" ? "connect_runtime" : "install_runtime");
  if (facts.systemd !== "yes") warnings.push("remote_services_unmanaged");
  if (Number.isFinite(disk) && disk > 0 && disk < 5 * 1024 ** 3 && !blocking.includes("remote_disk_full")) warnings.push("remote_disk_low");
  const memory = Number(facts.memory_kb) * 1024;
  if (Number.isFinite(memory) && memory > 0 && memory < 1536 * 1024 ** 2) warnings.push("remote_memory_low");
  if (Array.isArray(report?.exposed_ports) && report.exposed_ports.length > 0) warnings.push("remote_dashboard_port_exposed");
  const venues = [];
  for (const venue of Array.isArray(report?.venues) ? report.venues : []) {
    if (typeof venue?.venue !== "string") continue;
    venues.push({ venue: venue.venue, reachable: venue.result === "reachable" });
    if (venue.result !== "reachable") warnings.push(`remote_venue_${venue.result === "restricted" ? "restricted" : "unreachable"}:${venue.venue}`);
  }
  // Without linger or systemd the services stop when SSH logs out or the VPS reboots: no live trading.
  const durable = facts.systemd === "yes" && (facts.linger === "yes" || steps.includes("enable_linger"));
  return { blocking, needs, steps, warnings, venues: report ? venues : null, suitable_for_live: blocking.length === 0 && durable };
}

// The preparation that needs the login user's rights, in one connection: the service user,
// linger, clock synchronization and this product's key. stdin: sudo password, public key.
function setupScript(steps) {
  const parts = [
    "IFS= read -r P || P=\"\"; IFS= read -r K",
    "fail() { echo \"AlgoRover remote: $1\" >&2; exit 9; }",
    "R() { if [ \"$(id -u)\" = 0 ]; then \"$@\"; elif [ -n \"$P\" ]; then printf \"%s\\n\" \"$P\" | sudo -S -p \"\" \"$@\"; else sudo -n \"$@\"; fi; }",
    `if [ "$(id -u)" = 0 ]; then TU=${REMOTE_SERVICE_USER}; else TU=$(id -un); fi`,
  ];
  if (steps.includes("create_user")) parts.push(`id "$TU" >/dev/null 2>&1 || useradd -m -s /bin/bash "$TU" >/dev/null 2>&1 || fail user_create_failed`);
  parts.push("if [ \"$TU\" = \"$(id -un)\" ]; then TH=\"$HOME\"; else TH=$(getent passwd \"$TU\" 2>/dev/null | cut -d: -f6); fi",
    "[ -n \"$TH\" ] && [ -d \"$TH\" ] || fail key_install_failed");
  if (steps.includes("enable_linger")) parts.push("R loginctl enable-linger \"$TU\" >/dev/null 2>&1 || fail linger_failed");
  if (steps.includes("sync_time")) parts.push("R timedatectl set-ntp true >/dev/null 2>&1 || true");
  if (steps.includes("install_key")) {
    parts.push("mkdir -p \"$TH/.ssh\" && touch \"$TH/.ssh/authorized_keys\" || fail key_install_failed",
      "grep -qxF \"$K\" \"$TH/.ssh/authorized_keys\" || printf \"%s\\n\" \"$K\" >> \"$TH/.ssh/authorized_keys\" || fail key_install_failed",
      "chmod go-w \"$TH\"; chmod 700 \"$TH/.ssh\"; chmod 600 \"$TH/.ssh/authorized_keys\"",
      "if [ \"$(id -u)\" = 0 ]; then chown -R \"$TU\": \"$TH/.ssh\" || fail key_install_failed; fi");
  }
  parts.push("echo setup=ok");
  return parts.join("; ");
}

// Node.js for AlgoRover only, verified by digest and swapped into place. stdin: two download
// addresses (this product's release storage first, then nodejs.org) and the digest.
const NODE_INSTALL_SCRIPT = [
  "IFS= read -r A; IFS= read -r B; IFS= read -r H",
  "fail() { echo \"AlgoRover remote: $1\" >&2; exit 9; }",
  "D=\"$HOME/.algorover-remote/node\"; T=\"$D.incoming\"; rm -rf \"$T\"; mkdir -p \"$T\" || fail node_install_failed",
  "get() { if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 --connect-timeout 20 -o \"$T/node.tar.gz\" \"$1\"; elif command -v wget >/dev/null 2>&1; then wget -q -T 20 -O \"$T/node.tar.gz\" \"$1\"; else return 1; fi; }",
  "ok=no; bad=no; for u in \"$A\" \"$B\"; do if [ $ok = no ] && [ -n \"$u\" ] && get \"$u\"; then if echo \"$H  $T/node.tar.gz\" | sha256sum -c - >/dev/null 2>&1; then ok=yes; else bad=yes; fi; fi; done",
  "if [ $ok = no ]; then rm -rf \"$T\"; if [ $bad = yes ]; then fail node_checksum_mismatch; else fail node_download_failed; fi; fi",
  "tar -xzf \"$T/node.tar.gz\" -C \"$T\" --strip-components=1 && rm -f \"$T/node.tar.gz\" && \"$T/bin/node\" -v >/dev/null 2>&1 || { rm -rf \"$T\"; fail node_install_failed; }",
  "rm -rf \"$D\" && mv \"$T\" \"$D\" || fail node_install_failed",
  "echo node=$(\"$D/bin/node\" -v)",
].join("; ");

function nodeSources() {
  // Release storage: the directory above <product>/channels/ of this plugin's channel.
  const storage = /^(https:\/\/[^\s'"]+)\/(?:live|research)\/channels\/[^/]+$/u.exec(delivery.channel_url ?? "")?.[1];
  return { urls: [...(storage ? [`${storage}/node/${REMOTE_NODE.file}`] : []), `https://nodejs.org/dist/v${REMOTE_NODE.version}/${REMOTE_NODE.file}`], sha256: REMOTE_NODE.sha256 };
}

// --- deploy_to_vps -------------------------------------------------------------------------

function canonicalDigest(value) {
  const canonical = (item) => Array.isArray(item) ? `[${item.map(canonical).join(",")}]`
    : isPlainObject(item) ? `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}` : JSON.stringify(item ?? null);
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function bootstrapLifecycleArguments(command, extra = []) {
  const args = [validateBootstrapFile(configuredBootstrapPath()), command, "--runtime-home", runtimeHome, "--product", profile, "--environment", delivery.environment];
  if (delivery.marketplace_origin !== null) args.push("--marketplace-origin", delivery.marketplace_origin);
  if (process.env.ALGOROVER_LIVE_STATE_ROOT) args.push("--live-state-root", process.env.ALGOROVER_LIVE_STATE_ROOT);
  if (process.env.ALGOROVER_RESEARCH_STATE_ROOT) args.push("--research-state-root", process.env.ALGOROVER_RESEARCH_STATE_ROOT);
  return [...args, ...extra];
}

async function localDisable(checkOnly) {
  if (readInstalledRuntimeId() === null && !existsSync(join(runtimeHome, "runtime", "services.json"))) return { state: "not_installed" };
  const completed = await runLifecycleProcess(bootstrapLifecycleArguments("disable", ["--check-only", checkOnly ? "yes" : "no"]));
  if (completed.status !== 0) return { state: "refused", code: /^AlgoRover bootstrap: ([a-z0-9_]+)$/mu.exec(completed.stderr ?? "")?.[1] ?? "bootstrap_failed" };
  return { state: checkOnly ? "allowed" : "disabled" };
}

async function remoteDisable(destination, checkOnly) {
  const result = await remoteBootstrap(destination, ["disable", "--product", profile, "--check-only", checkOnly ? "yes" : "no"], 300_000);
  if (result.code === null) return { state: checkOnly ? "allowed" : "disabled" };
  if (["trading_work_open", "runtime_in_use", "legacy_trading_state_present", "host_stop_failed", "trading_service_drain_timeout"].includes(result.code)) return { state: "refused", code: result.code };
  if (result.code.startsWith("ssh_")) return { state: "unreachable", code: result.code };
  return { state: "refused", code: result.code };
}

const REFUSAL_TEXT = {
  trading_work_open: "strategies still run, hold positions or have open orders; stop them (and close positions) first",
  runtime_in_use: "a background task (backtest or data download) still runs; wait for it or cancel it first",
  legacy_trading_state_present: "old v1 trading tasks are still being handed over; update once first",
};

function deployArguments(value) {
  const allowed = new Set(["action", "host", "port", "user", "password", "sudo_password", "key_file", "allow_not_durable", "reset_host_key", "confirmation"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new BridgeError("invalid_arguments");
  for (const key of ["password", "sudo_password"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 512 || /[\r\n\0]/u.test(value[key]))) throw new BridgeError("invalid_arguments");
  }
  for (const key of ["allow_not_durable", "reset_host_key"]) if (value[key] !== undefined && typeof value[key] !== "boolean") throw new BridgeError("invalid_arguments");
  if (value.confirmation !== undefined && (typeof value.confirmation !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.confirmation))) throw new BridgeError("invalid_arguments");
  const port = value.port === undefined ? 22 : typeof value.port === "string" && /^\d{1,5}$/u.test(value.port) ? Number(value.port) : value.port;
  const destination = validDestination({ host: value.host, port, user: value.user });
  if (destination === null) throw new BridgeError("invalid_destination");
  let keyFile = null;
  if (value.key_file !== undefined) {
    if (typeof value.key_file !== "string" || value.key_file.length > 1024 || /[\r\n\0]/u.test(value.key_file)) throw new BridgeError("invalid_arguments");
    const path = value.key_file.startsWith("~") ? join(homedir(), value.key_file.slice(1)) : value.key_file;
    if (!isAbsolute(path)) throw new BridgeError("key_file_not_found");
    let metadata;
    try { metadata = lstatSync(path); } catch { throw new BridgeError("key_file_not_found"); }
    if (!metadata.isFile() || metadata.size > 64 * 1024) throw new BridgeError("key_file_not_found");
    keyFile = path;
  }
  return { destination, password: value.password ?? null, sudoPassword: value.sudo_password ?? value.password ?? null, keyFile,
    allowNotDurable: value.allow_not_durable === true, resetHostKey: value.reset_host_key === true, confirmation: value.confirmation };
}

function needsResult(needs, context, text) {
  return targetResult({ state: "needs_input", needs, destination: destinationLabel(context.destination), required_action: "ask_user" }, false, text);
}

// Logs in with the first method that works: this product's own key (installed by an earlier
// deploy), the user's own SSH keys, then the given key file or password.
async function vpsLogin(input) {
  const target = { ...input.destination, user: input.destination.user === "root" ? REMOTE_SERVICE_USER : input.destination.user };
  const probeWith = async (destination, auth, keyLogin) => {
    const result = await runSsh(destination, "exit 0", { hostKeys: "accept-new", auth, timeoutMs: 60_000 });
    return result.code === null ? { destination, auth, keyLogin } : { failure: result.code };
  };
  // With root, log in as root even when the service user already has the key: only root can
  // still create the user or turn on linger (installing the key again changes nothing).
  if (target.user === input.destination.user && existsSync(remoteKeyPath)) {
    const own = await probeWith(target, { mode: "key_file", path: remoteKeyPath }, true);
    if (!own.failure) return own;
    if (own.failure !== "ssh_auth_failed") return { failure: own.failure };
  }
  const users = await probeWith(input.destination, BATCH, false);
  if (!users.failure) return users;
  if (users.failure !== "ssh_auth_failed") return { failure: users.failure };
  if (input.keyFile !== null) {
    const keyed = await probeWith(input.destination, { mode: "key_file", path: input.keyFile }, false);
    if (!keyed.failure) return keyed;
    if (keyed.failure !== "ssh_auth_failed") return { failure: keyed.failure };
    return { failure: "key_file_rejected" };
  }
  if (input.password !== null) {
    const label = destinationLabel(input.destination);
    if ((passwordFailures.get(label) ?? 0) >= MAXIMUM_PASSWORD_FAILURES) return { failure: "password_attempts_exhausted" };
    const passworded = await probeWith(input.destination, { mode: "password", password: input.password }, false);
    if (!passworded.failure) { passwordFailures.delete(label); return passworded; }
    if (passworded.failure !== "ssh_auth_failed") return { failure: passworded.failure };
    passwordFailures.set(label, (passwordFailures.get(label) ?? 0) + 1);
    return { failure: (passwordFailures.get(label) ?? 0) >= MAXIMUM_PASSWORD_FAILURES ? "password_attempts_exhausted" : "password_rejected" };
  }
  return { failure: "password_required" };
}

const LOGIN_NEEDS = {
  password_required: "Ask the user for the VPS password (or the path of the private key file the VPS provider gave them), then call deploy_to_vps again with all arguments.",
  password_rejected: "The VPS rejected the password. Ask the user to check the user name and password, then call deploy_to_vps again. After one more wrong password this conversation stops trying, because servers often block an address after failed logins.",
  password_attempts_exhausted: "Two passwords were rejected, so no more are tried in this conversation (servers often block an address after failed logins). Ask the user to check the password, for example by logging in at the VPS provider's web console, then start a new conversation.",
  key_file_rejected: "The VPS rejected that key file. Ask the user to check the file and the user name (for example ubuntu or ec2-user on cloud servers), or give the password instead.",
};

async function deployToVps(argumentsValue) {
  const input = deployArguments(argumentsValue);
  if (input.keyFile === null) return deployWith(input, argumentsValue);
  // ssh refuses a private key others can read, as downloaded .pem files often are: use a private copy.
  mkdirSync(remoteRoot, { recursive: true, mode: 0o700 });
  const copy = join(remoteRoot, `imported-key-${randomUUID()}`);
  try {
    writeFileSync(copy, readFileSync(input.keyFile), { mode: 0o600 });
    return await deployWith({ ...input, keyFile: copy }, argumentsValue);
  } finally {
    rmSync(copy, { force: true });
  }
}

async function deployWith(input, argumentsValue) {
  const context = { destination: input.destination };
  if (remoteTarget !== null) {
    const current = remoteTarget.destination;
    const same = current.host === input.destination.host && current.port === input.destination.port
      && [input.destination.user, REMOTE_SERVICE_USER].includes(current.user);
    if (same) return targetStatus("AlgoRover already runs on this VPS.");
    return targetResult({ state: "refused", message: "remote_target_active", required_action: "switch_to_local_first" }, true,
      `AlgoRover ${PRODUCT_NAME} already runs on ${destinationLabel(current)}. Switch back to this computer first (switch_to_local), then deploy to the other VPS: one VPS per product.`);
  }
  if (input.resetHostKey) rmSync(remoteKnownHosts, { force: true });
  const publicKey = await pluginPublicKey();
  const login = await vpsLogin(input);
  if (login.failure) {
    if (LOGIN_NEEDS[login.failure]) return needsResult([login.failure], context, LOGIN_NEEDS[login.failure]);
    if (login.failure === "ssh_host_key_changed") return needsResult(["confirm_server_replaced"], context, guidance(login.failure));
    return targetResult({ state: "error", message: login.failure, destination: destinationLabel(input.destination), required_action: "fix_connection" }, true,
      `Cannot log in to ${destinationLabel(input.destination)} (${login.failure}). ${guidance(login.failure)}`);
  }
  const facts = await probeVps(login.destination, login.auth, input.sudoPassword);
  const target = { host: input.destination.host, port: input.destination.port, user: facts.target_user };
  if (!validDestination(target)) throw new BridgeError("remote_output_invalid");
  // Exchange reachability needs Node on the VPS: checked now when it is there, otherwise after installing it.
  let report = null;
  if (facts.user === facts.target_user && facts.node && compareVersionParts(facts.node, [MINIMUM_REMOTE_NODE]) >= 0) {
    try { report = await remoteHostCheck(login.destination, login.auth); } catch { report = null; }
  }
  const evaluation = evaluateVps(facts, { keyLogin: login.keyLogin, sudoPassword: argumentsValue.sudo_password, allowNotDurable: input.allowNotDurable, report });
  const fingerprints = await hostKeyFingerprints(remoteKnownHosts);
  if (evaluation.blocking.length) {
    return targetResult({ state: "unsuitable", destination: destinationLabel(target), check: evaluation, required_action: "fix_remote_host" }, true,
      `${destinationLabel(input.destination)} cannot run AlgoRover: ${evaluation.blocking.map(checkText).join("; ")}. Nothing was changed.`);
  }
  if (evaluation.needs.length) {
    const rejected = evaluation.needs.includes("sudo_password_rejected");
    return needsResult(evaluation.needs, context, `${rejected ? "The sudo password was rejected." : `The user "${facts.user}" needs a sudo password to keep AlgoRover running after logout (linger).`} Ask the user for the sudo password (often the login password) and call deploy_to_vps again with sudo_password; or, if they do not have it, call again with allow_not_durable=true: AlgoRover then stops when nobody is logged in, so it is not suitable for 7x24 live trading.`);
  }
  const local = await localDisable(true);
  const migration = profile === "live" ? migrationInventory() : { accounts: 0, items: 0, bytes: 0, too_large: false, list: [] };
  const summary = { action: "deploy_to_vps", profile, destination: target, login_user: facts.user, steps: evaluation.steps,
    warnings: evaluation.warnings.filter((code) => !code.startsWith("remote_venue_")), suitable_for_live: evaluation.suitable_for_live, local,
    migration: { items: migration.items, bytes: migration.bytes, too_large: migration.too_large } };
  const plan = { ...summary, destination: destinationLabel(target), host_key_fingerprints: fingerprints, venues: evaluation.venues, warnings: evaluation.warnings };
  if (local.state === "refused") return targetResult({ state: "refused", message: local.code, plan }, true,
    `Cannot move AlgoRover to the VPS yet: on this computer ${REFUSAL_TEXT[local.code] ?? local.code}.`);
  if (migration.too_large) return targetResult({ state: "refused", message: "migration_too_large", plan }, true,
    "The strategies to copy from this computer exceed 64 MB; nothing was changed.");
  const digest = canonicalDigest(summary);
  if (input.confirmation !== digest) {
    const newConversation = local.state !== "not_installed";
    return targetResult({ state: "awaiting_confirmation", plan, confirmation: digest, required_action: "confirm_deploy" }, false, [
      input.confirmation === undefined ? "" : "The situation changed since the last plan; show this new one.",
      `Ask the user to approve this plan for ${destinationLabel(target)}${facts.user === target.user ? "" : ` (logged in as ${facts.user})`}:`,
      evaluation.steps.map((step, index) => `${index + 1}) ${checkText(step)};`).join(" "),
      profile === "live" && migration.items > 0 ? `then ${migration.items} items from this computer (custom strategies, strategy configurations and installed strategy packages, ${(migration.bytes / 1024 ** 2).toFixed(1)} MB) are copied to the VPS, keeping what is already there; backtest results stay here;` : "",
      local.state === "not_installed" ? "" : "this computer's Runtime services stop and no longer start automatically; its install and data stay, so switching back is possible;",
      "on the VPS the user signs in again, enters exchange API keys again (without withdrawal permission) and redeploys strategies.",
      fingerprints.length ? `VPS host key ${fingerprints[0].split(" ")[0]} is remembered; a different one later is refused.` : "",
      evaluation.venues ? `Exchanges reachable from the VPS: ${evaluation.venues.filter((venue) => venue.reachable).map((venue) => venue.venue).join(", ") || "none"}${evaluation.venues.some((venue) => !venue.reachable) ? `; not reachable: ${evaluation.venues.filter((venue) => !venue.reachable).map((venue) => venue.venue).join(", ")}` : ""}.` : (profile === "live" ? "Exchange reachability is checked after Node.js is installed." : ""),
      evaluation.warnings.filter((code) => !code.startsWith("remote_venue_")).length ? `Warnings: ${evaluation.warnings.filter((code) => !code.startsWith("remote_venue_")).map(checkText).join("; ")}.` : "",
      evaluation.suitable_for_live ? "The VPS is suitable for 7x24 trading." : "This VPS is NOT suitable for 7x24 live trading: AlgoRover stops when nobody is logged in or after a reboot.",
      newConversation ? "Afterwards the user continues in a new conversation." : "",
      "Only after the user agrees, call deploy_to_vps again with the same arguments plus this confirmation.",
    ].filter(Boolean).join(" "));
  }
  return executeDeploy({ input, login, facts, target, evaluation, local, migration, publicKey, plan });
}

async function executeDeploy({ input, login, facts, target, evaluation, local, migration, publicKey, plan }) {
  const done = [];
  const failed = (step, code, extra = {}) => targetResult({ state: "error", message: code, failed_step: step, completed_steps: done, plan, required_action: "retry_deploy", ...extra }, true,
    `Step "${checkText(step)}" failed (${code}): ${guidance(code)} Completed: ${done.length ? done.map(checkText).join("; ") : "nothing"}. Nothing on this computer was changed. Calling deploy_to_vps again continues from the failed step.`);
  const privileged = evaluation.steps.filter((step) => ["create_user", "enable_linger", "sync_time", "install_key"].includes(step));
  if (privileged.length) {
    const setup = await runSsh(login.destination, remoteShell(setupScript(privileged), { node: false }), { input: `${input.sudoPassword ?? ""}\n${publicKey}\n`, hostKeys: "accept-new", auth: login.auth, timeoutMs: 120_000 });
    if (setup.code !== null) return failed(privileged[0], setup.code);
    done.push(...privileged);
  }
  // From here on this product's own key logs in as the user AlgoRover runs as.
  const own = await runSsh(target, "exit 0", { auth: { mode: "key_file", path: remoteKeyPath }, timeoutMs: 60_000 });
  if (own.code !== null) return failed("install_key", own.code === "ssh_auth_failed" ? "key_login_refused" : own.code);
  if (evaluation.steps.includes("install_node")) {
    const sources = nodeSources();
    const installed = await runSsh(target, remoteShell(NODE_INSTALL_SCRIPT, { node: false }), { input: `${sources.urls[0] ?? ""}\n${sources.urls[1] ?? ""}\n${sources.sha256}\n`, timeoutMs: 600_000 });
    if (installed.code !== null) return failed("install_node", installed.code);
    done.push("install_node");
  }
  let report;
  try { report = await remoteHostCheck(target); } catch (error) { return failed("install_runtime", error instanceof BridgeError ? error.code : "remote_check_failed"); }
  if (report?.platform?.os !== "linux" || report.platform.arch !== "amd64" || compareVersionParts(report.platform.glibc, MINIMUM_REMOTE_GLIBC) < 0) return failed("install_runtime", "remote_platform_unsupported");
  const venues = Array.isArray(report?.venues) ? report.venues.filter((venue) => typeof venue?.venue === "string").map((venue) => ({ venue: venue.venue, reachable: venue.result === "reachable" })) : null;
  const channel = new RemoteChannel(target);
  let started;
  try {
    await channel.open();
    const response = await channel.request("tools/call", { name: "algorover_runtime_start", arguments: {} }, REMOTE_CALL_TIMEOUT_MS);
    started = response?.result?.structuredContent ?? null;
  } catch (error) {
    channel.close();
    return failed("install_runtime", error instanceof BridgeError ? error.code : "remote_start_failed");
  }
  if (started?.state !== "ready") {
    channel.close();
    return failed("install_runtime", started?.message ?? `remote_runtime_${started?.state ?? "unknown"}`, { remote_status: started });
  }
  done.push(evaluation.steps.includes("connect_runtime") ? "connect_runtime" : "install_runtime");
  let copied = null;
  if (profile === "live") {
    try { copied = await migrateToRemote(target, migration); } catch (error) {
      channel.close();
      return failed("install_runtime", error instanceof BridgeError ? error.code : "migration_failed");
    }
  }
  if (local.state !== "not_installed") {
    const disabled = await localDisable(false);
    if (disabled.state === "refused") {
      channel.close();
      return targetResult({ state: "refused", message: disabled.code, completed_steps: done, plan }, true,
        `The VPS is ready, but this computer's Runtime could not stop: ${REFUSAL_TEXT[disabled.code] ?? disabled.code}. Nothing was switched; calling deploy_to_vps again finishes the move.`);
    }
  }
  const check = { suitable_for_live: evaluation.suitable_for_live, warnings: evaluation.warnings.filter((code) => !code.startsWith("remote_venue_")) };
  writePrivateJson(remoteTargetPath, { schema: REMOTE_TARGET_SCHEMA, profile, destination: target, activated_at: new Date().toISOString(), check });
  remoteTarget = readRemoteTarget();
  remoteChannel?.close();
  remoteChannel = channel;
  remoteAdmittedRuntimeId = typeof started.runtime_id === "string" ? started.runtime_id : null;
  remoteStale = false;
  // A first installation had nothing on this computer the conversation could have used.
  placementSwitched = local.state !== "not_installed";
  const tunnel = await ensureTunnel(REMOTE_DASHBOARD_PORTS[0]);
  announceListChanged();
  const dashboard = `http://127.0.0.1:${REMOTE_DASHBOARD_PORTS[0]}/`;
  return targetResult({ state: "deployed", placement: "remote", destination: destinationLabel(target), completed_steps: done, migration: copied, tunnel, venues,
    suitable_for_live: evaluation.suitable_for_live, dashboard_url: dashboard, required_action: placementSwitched ? "new_conversation" : "continue" }, false, [
    `AlgoRover ${PRODUCT_NAME} now runs on the VPS ${destinationLabel(target)}.`,
    copied && copied.copied + copied.skipped > 0 ? `Copied ${copied.copied} items from this computer, kept ${copied.skipped} already on the VPS.` : "",
    local.state === "not_installed" ? "" : "This computer's Runtime is stopped and kept, so switching back is possible.",
    venues ? `Exchanges reachable from the VPS: ${venues.filter((venue) => venue.reachable).map((venue) => venue.venue).join(", ") || "none"}.` : "",
    `Dashboard: ${dashboard} (through an SSH tunnel${tunnel === "ok" ? "" : `; tunnel not ready: ${tunnel}`}). There the user signs in, enters exchange API keys (bind them to the VPS's public IP, without withdrawal permission) and deploys strategies.`,
    placementSwitched ? "Tell the user to start a new conversation." : "Continue in this conversation.",
  ].filter(Boolean).join(" "));
}

async function remoteSwitchToLocal(argumentsValue) {
  const allowed = new Set(["action", "confirmation", "force"]);
  if (Object.keys(argumentsValue).some((key) => !allowed.has(key)) || (argumentsValue.force !== undefined && typeof argumentsValue.force !== "boolean"))
    throw new BridgeError("invalid_arguments");
  if (remoteTarget === null) return targetStatus("This product already runs on this computer.");
  const destination = remoteTarget.destination;
  const remote = await remoteDisable(destination, true);
  const summary = { action: "switch_to_local", profile, destination, remote, force: argumentsValue.force === true };
  if (remote.state === "refused") return targetResult({ state: "refused", message: remote.code, summary }, true,
    `Cannot switch back yet: on the VPS ${REFUSAL_TEXT[remote.code] ?? remote.code}.`);
  if (remote.state === "unreachable" && argumentsValue.force !== true) return targetResult({ state: "awaiting_confirmation", summary, required_action: "confirm_force_switch" }, true,
    `The VPS cannot be reached (${remote.code}), so nobody can confirm whether strategies still run there. Warn the user that they may keep trading on the VPS and should log in to the VPS (or the exchange) to check. Only if the user still wants to switch back, call switch_to_local with force=true.`);
  const digest = canonicalDigest(summary);
  if (argumentsValue.confirmation !== digest) {
    return targetResult({ state: "awaiting_confirmation", summary, confirmation: digest, required_action: "confirm_switch" }, false, [
      `Ask the user to approve moving AlgoRover ${PRODUCT_NAME} back to this computer:`,
      remote.state === "unreachable" ? "the VPS is unreachable and is NOT stopped;" : "the VPS Runtime services stop and no longer start automatically; its install and data stay on the VPS;",
      "this computer's Runtime starts on the next use (it is installed first if needed) with its earlier data; strategies deployed on the VPS must be redeployed here; then the user starts a new conversation.",
      "Only after the user agrees, call switch_to_local again with this confirmation.",
    ].join(" "));
  }
  if (remote.state !== "unreachable") {
    const disabled = await remoteDisable(destination, false);
    if (disabled.state !== "disabled") return targetResult({ state: "refused", message: disabled.code, summary }, true,
      `The VPS Runtime could not stop (${disabled.code}): ${REFUSAL_TEXT[disabled.code] ?? "nothing was switched"}.`);
  }
  stopTunnels();
  rmSync(remoteTargetPath, { force: true });
  remoteTarget = null;
  remoteChannel?.close();
  remoteChannel = null;
  placementSwitched = true;
  announceListChanged();
  return targetResult({ state: "switched", placement: "local", destination: destinationLabel(destination), required_action: "new_conversation" }, false,
    `AlgoRover ${PRODUCT_NAME} runs on this computer again${remote.state === "unreachable" ? " (the unreachable VPS was not stopped)" : ""}. Tell the user to start a new conversation; the Runtime here starts (or installs) on first use.`);
}

async function targetStatus(prefix = "") {
  let reachable = null, error = null;
  if (remoteTarget !== null) {
    try { await openRemote(); reachable = true; } catch (failure) { reachable = false; error = failure instanceof BridgeError ? failure.code : "remote_unreachable"; }
  }
  const destination = remoteTarget?.destination ?? null;
  const value = { state: "status", placement: remoteTarget === null ? "local" : "remote", destination: destinationLabel(destination),
    check: remoteTarget?.check ?? null, remote_reachable: reachable, message: error,
    tunnels: remoteTarget === null ? [] : readTunnels().map(({ port }) => port), conversation: placementSwitched ? "stale" : "current",
    local_runtime_installed: readInstalledRuntimeId() !== null };
  const where = remoteTarget === null ? "this computer" : `the VPS ${destinationLabel(destination)}${reachable ? "" : ` (unreachable: ${error}; ${guidance(error)})`}`;
  return targetResult(value, false, `${prefix ? `${prefix} ` : ""}AlgoRover ${PRODUCT_NAME} runs on ${where}.${placementSwitched ? " This conversation was opened before a switch: start a new one." : ""}`);
}

function targetResult(value, isError, text) {
  return { content: [{ type: "text", text }], structuredContent: { schema: REMOTE_RESULT_SCHEMA, profile, ...value }, ...(isError ? { isError: true } : {}) };
}

async function executeRuntimeTarget(argumentsValue) {
  const action = argumentsValue.action;
  if (action === "status") { if (Object.keys(argumentsValue).length !== 1) throw new BridgeError("invalid_arguments"); return targetStatus(); }
  if (!["deploy_to_vps", "switch_to_local"].includes(action)) throw new BridgeError("invalid_arguments");
  if (delivery.environment !== "production" && action !== "switch_to_local")
    return targetResult({ state: "refused", message: "remote_requires_production" }, true, "Running on a VPS is only available for the production plugin.");
  try {
    if (action === "deploy_to_vps") return await deployToVps(argumentsValue);
    return await remoteSwitchToLocal(argumentsValue);
  } catch (error) {
    if (!(error instanceof BridgeError) || ["invalid_arguments", "invalid_destination"].includes(error.code)) throw error;
    return targetResult({ state: "error", message: error.code, required_action: "fix_remote_host" }, true,
      `The VPS step failed: ${error.code}. ${guidance(error.code)}`);
  }
}

function announceListChanged() {
  setTimeout(() => {
    writeResponse({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    writeResponse({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
  }, 0);
}

// --- strategy migration (Live, D1) ---------------------------------------------------------

// What moves with the user: each account's custom strategies, strategy configurations and
// installed strategy packages (without their backtest runs). Credentials, trading journals,
// sign-in tokens and downloaded data never move. The account key is derived from the user and
// Marketplace, so the same account on the VPS finds them after it signs in.
function migrationInventory() {
  const live = process.env.ALGOROVER_LIVE_STATE_ROOT ?? join(homedir(), ".algorover");
  const accounts = join(live, "accounts");
  const items = [];
  let bytes = 0, tooLarge = false;
  const walk = (directory, relative, item) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        if (relative.length === 2 && relative[0] === "strategies" && (name === "runs" || name === ".descriptor")) continue;
        if (name === "__pycache__") continue;
        walk(path, [...relative, name], item);
      } else if (metadata.isFile()) {
        if (metadata.size > MIGRATION_MAX_FILE_BYTES) { tooLarge = true; continue; }
        bytes += metadata.size;
        item.files.push({ path: [...relative, name].join("/"), source: path, size: metadata.size });
      }
    }
  };
  let accountNames = [];
  try { if (lstatSync(accounts).isDirectory()) accountNames = readdirSync(accounts).filter((name) => /^[0-9a-f]{64}$/u.test(name)); } catch { accountNames = []; }
  for (const account of accountNames) {
    const accountRoot = join(accounts, account);
    if (lstatSync(accountRoot).isSymbolicLink() || !lstatSync(accountRoot).isDirectory()) continue;
    for (const area of ["custom-strategies", "strategy-configurations", "strategies"]) {
      const areaRoot = join(accountRoot, area);
      let names = [];
      try { if (lstatSync(areaRoot).isDirectory() && !lstatSync(areaRoot).isSymbolicLink()) names = readdirSync(areaRoot); } catch { names = []; }
      for (const name of names) {
        if (name.startsWith(".") || name === "__init__.py" || name === "__pycache__") continue;
        const path = join(areaRoot, name);
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) continue;
        const item = { account, top: `${area}/${name}`, files: [] };
        if (metadata.isDirectory()) walk(path, [area, name], item);
        else if (metadata.isFile() && metadata.size <= MIGRATION_MAX_FILE_BYTES) { bytes += metadata.size; item.files.push({ path: `${area}/${name}`, source: path, size: metadata.size }); }
        if (item.files.length) items.push(item);
      }
    }
  }
  return { accounts: accountNames.length, items: items.length, bytes, too_large: tooLarge || bytes > MIGRATION_MAX_BYTES, list: items };
}

async function migrateToRemote(destination, inventory) {
  if (inventory.list.length === 0) return { copied: 0, skipped: 0 };
  const items = inventory.list.map((item) => ({ account: item.account, top: item.top, files: item.files.map((file) => {
    const bytes = readBoundedRegularFile(file.source, MIGRATION_MAX_FILE_BYTES);
    if (bytes === null) throw new BridgeError("migration_source_changed");
    return { path: file.path, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
  }) }));
  const program = `import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const items = ${JSON.stringify(items)};
const live = join(homedir(), ".algorover");
const safe = (path) => path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
let copied = 0, skipped = 0;
for (const item of items) {
  if (!/^[0-9a-f]{64}$/.test(item.account) || !safe(item.top)) { process.stderr.write("AlgoRover remote: remote_path_invalid\\n"); process.exit(6); }
  const account = join(live, "accounts", item.account);
  const target = join(account, ...item.top.split("/"));
  if (existsSync(target)) { skipped += 1; continue; }
  const temporary = join(account, ".migrating-" + randomUUID());
  for (const file of item.files) {
    if (!safe(file.path) || !file.path.startsWith(item.top)) { rmSync(temporary, { recursive: true, force: true }); process.stderr.write("AlgoRover remote: remote_path_invalid\\n"); process.exit(6); }
    const path = join(temporary, ...file.path.split("/"));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(file.data, "base64"), { mode: 0o600 });
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256) { rmSync(temporary, { recursive: true, force: true }); process.stderr.write("AlgoRover remote: migration_corrupt\\n"); process.exit(7); }
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  renameSync(join(temporary, ...item.top.split("/")), target);
  rmSync(temporary, { recursive: true, force: true });
  copied += 1;
}
process.stdout.write(JSON.stringify({ schema: "algorover-remote-migration-v1", copied, skipped }) + "\\n");
`;
  const result = await runSsh(destination, remoteShell("exec \"$N\" --input-type=module -"), { input: program, timeoutMs: 600_000 });
  if (result.code !== null) throw new BridgeError(result.code);
  const value = lastJsonLine(result.stdout);
  return { copied: value.copied, skipped: value.skipped };
}

// --- Dashboard tunnel ----------------------------------------------------------------------

function readTunnels() {
  const value = readPrivateJson(remoteTunnelsPath);
  return Array.isArray(value?.tunnels) ? value.tunnels.filter((item) => REMOTE_DASHBOARD_PORTS.includes(item?.port) && Number.isSafeInteger(item?.pid) && item.pid > 0) : [];
}

function processCommandLine(pid) {
  try {
    if (process.platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    if (process.platform === "darwin") {
      const result = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
      return result.status === 0 ? result.stdout.trim() : null;
    }
    if (process.platform === "win32") {
      const powershell = join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", timeout: 5000, windowsHide: true });
      return result.status === 0 ? result.stdout.trim() : null;
    }
  } catch { return null; }
  return null;
}

// Only a process whose command line is this tunnel is ever treated as ours (PIDs are reused).
function ownTunnel(entry) {
  const command = processCommandLine(entry.pid);
  return typeof command === "string" && /\bssh(?:\.exe)?\b/u.test(command) && command.includes(`127.0.0.1:${entry.port}:127.0.0.1:${entry.port}`);
}

function portOpen(port) {
  return new Promise((accept) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value) => { socket.destroy(); accept(value); };
    socket.setTimeout(400, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// Tunnels this process verified recently: a command-line check costs a PowerShell start on Windows.
const verifiedTunnels = new Map();

async function ensureTunnel(port) {
  if (remoteTarget === null || !REMOTE_DASHBOARD_PORTS.includes(port)) return "not_remote";
  const tunnels = readTunnels();
  const current = tunnels.find((item) => item.port === port);
  const recent = current !== undefined && verifiedTunnels.get(port)?.pid === current.pid && Date.now() - verifiedTunnels.get(port).at < 60_000;
  const alive = current !== undefined && (recent || ownTunnel(current));
  if (alive) verifiedTunnels.set(port, { pid: current.pid, at: recent ? verifiedTunnels.get(port).at : Date.now() });
  if (alive && await portOpen(port)) return "ok";
  if (!alive && await portOpen(port)) return "local_dashboard_port_in_use";
  let child;
  try {
    child = spawn("ssh", [...sshOptions({ forwarding: true }), "-N", "-L", `127.0.0.1:${port}:127.0.0.1:${port}`, ...sshDestination(remoteTarget.destination)],
      { detached: true, stdio: "ignore", windowsHide: true, env: sshEnvironment() });
  } catch { return "ssh_missing"; }
  const exited = new Promise((accept) => { child.once("exit", () => accept(true)); child.once("error", () => accept(true)); });
  child.unref();
  writePrivateJson(remoteTunnelsPath, { schema: "algorover-remote-tunnels-v1", tunnels: [...tunnels.filter((item) => item.port !== port), { port, pid: child.pid, started_at: new Date().toISOString() }] });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return "ok";
    if (await Promise.race([exited, new Promise((accept) => setTimeout(() => accept(false), 250))])) return "tunnel_failed";
  }
  return "tunnel_timeout";
}

function stopTunnels() {
  verifiedTunnels.clear();
  for (const entry of readTunnels()) {
    if (ownTunnel(entry)) { try { process.kill(entry.pid); } catch { /* already gone */ } }
  }
  rmSync(remoteTunnelsPath, { force: true });
}

// Every loopback Dashboard origin a VPS result links to gets its tunnel before the link is shown.
async function ensureTunnelsFor(value) {
  const ports = new Set();
  const text = JSON.stringify(value ?? null);
  for (const match of text.matchAll(/http:\/\/127\.0\.0\.1:(\d{2,5})/gu)) {
    const port = Number(match[1]);
    if (REMOTE_DASHBOARD_PORTS.includes(port)) ports.add(port);
  }
  const failures = [];
  for (const port of ports) {
    const state = await ensureTunnel(port);
    if (state !== "ok") failures.push(`${port}:${state}`);
  }
  return failures;
}

// --- the MCP channel to the VPS copy -------------------------------------------------------

class RemoteChannel {
  constructor(destination) {
    this.destination = destination;
    this.child = null;
    this.pending = new Map();
    this.next = 0;
    this.opening = null;
    this.stderr = "";
    this.runtimeId = null;
    this.closed = false;
  }

  get alive() { return this.child !== null && this.opening === null; }

  open() {
    if (this.child !== null && this.opening === null) return Promise.resolve(this);
    if (this.opening === null) this.opening = this.#start().finally(() => { this.opening = null; });
    return this.opening;
  }

  async #start() {
    try { await this.#spawn(); } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "remote_plugin_missing") throw error;
      await syncRemotePlugin(this.destination);
      await this.#spawn();
    }
    return this;
  }

  #spawn() {
    const command = remoteShell(`D=${remoteCopyDirectory()}; [ -f "$D/resolver.mjs" ] || { echo "AlgoRover remote: remote_plugin_missing" >&2; exit 4; }; ALGOROVER_RUNTIME_PLACEMENT=remote ALGOROVER_ENV=production; export ALGOROVER_RUNTIME_PLACEMENT ALGOROVER_ENV; exec "$N" "$D/resolver.mjs" ${profile}`);
    mkdirSync(remoteRoot, { recursive: true, mode: 0o700 });
    let child;
    try {
      child = spawn("ssh", [...sshOptions(), ...sshDestination(this.destination), command], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: sshEnvironment() });
    } catch { return Promise.reject(new BridgeError("ssh_missing")); }
    this.child = child;
    this.stderr = "";
    child.stdin.on("error", () => { /* reported through close */ });
    child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16 * 1024); });
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > REMOTE_MAX_LINE_BYTES && !buffer.includes("\n")) { child.kill(); return; }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.#receive(line);
      }
    });
    const closed = new Promise((accept) => {
      child.once("error", (error) => accept(error?.code === "ENOENT" ? "ssh_missing" : "ssh_failed"));
      child.once("close", (status) => accept(sshFailureCode({ status, stderr: this.stderr })));
    });
    closed.then((code) => {
      if (this.child === child) this.child = null;
      for (const [, waiter] of this.pending) waiter.reject(new BridgeError(code === "remote_command_failed" ? "remote_disconnected" : code));
      this.pending.clear();
    });
    const closedFailure = closed.then((code) => { throw new BridgeError(code === "remote_command_failed" ? "remote_disconnected" : code); });
    closedFailure.catch(() => { /* observed through the race below or a later request */ });
    return Promise.race([
      this.#call("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: `algorover-remote-bridge-${profile}`, version: productVersion } }, REMOTE_CONNECT_TIMEOUT_MS)
        .then((response) => {
          if (!isPlainObject(response?.result)) throw new BridgeError("remote_initialize_failed");
          this.runtimeId = typeof response.result.serverInfo?.runtimeId === "string" ? response.result.serverInfo.runtimeId : null;
          this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
        }),
      closedFailure,
    ]);
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!isPlainObject(message)) return;
    if (typeof message.method === "string" && !Object.hasOwn(message, "id")) {
      // Only notifications travel back unasked; a list change also drops the cached annotations.
      if (message.method.startsWith("notifications/")) {
        if (message.method === "notifications/tools/list_changed") remoteToolAnnotations = new Map();
        writeResponse(message);
      }
      return;
    }
    const waiter = this.pending.get(message.id);
    if (waiter === undefined) return;
    this.pending.delete(message.id);
    waiter.accept(message);
  }

  #write(message) {
    if (this.child === null) throw new BridgeError("remote_disconnected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #call(method, params, timeoutMs) {
    const id = `algorover-remote-${++this.next}`;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError("remote_timeout")); }, timeoutMs);
      this.pending.set(id, { accept: (value) => { clearTimeout(timer); accept(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      try { this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async request(method, params, timeoutMs) {
    await this.open();
    return this.#call(method, params, timeoutMs);
  }

  notify(method, params) {
    if (this.child === null) return;
    try { this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }); } catch { /* the next request reconnects */ }
  }

  close() {
    this.closed = true;
    if (this.child !== null) { try { this.child.stdin.end(); this.child.kill(); } catch { /* already gone */ } }
    this.child = null;
  }
}

async function openRemote() {
  if (remoteTarget === null) throw new BridgeError("remote_not_configured");
  if (remoteChannel === null || !sameDestination(remoteTarget.destination, remoteChannel.destination)) {
    remoteChannel?.close();
    remoteChannel = new RemoteChannel(remoteTarget.destination);
  }
  const reconnect = !remoteChannel.alive;
  await remoteChannel.open();
  if (reconnect) {
    // A VPS Runtime replaced since this conversation started ends it, as on this computer.
    if (remoteAdmittedRuntimeId !== null && remoteChannel.runtimeId !== null && remoteChannel.runtimeId !== remoteAdmittedRuntimeId) remoteStale = true;
    if (remoteAdmittedRuntimeId === null) remoteAdmittedRuntimeId = remoteChannel.runtimeId;
  }
  return remoteChannel;
}

function remoteUnreachableStatus(code) {
  return { state: "error", profile, plugin_id: pluginId, environment: delivery.environment,
    version: productVersion, plugin_version: pluginVersion, expected_product_version: boundVersion,
    runtime_version: null, runtime_contract_version: null, runtime_id: null, bootstrap_installed: existsSync(configuredBootstrapPath()),
    lifecycle: null, connection_ready: false, repair_allowed: false, required_action: "check_remote_connection", message: code, placement: "remote" };
}

function remoteUnreachableResult(code) {
  return { content: [{ type: "text", text: `AlgoRover runs on the VPS ${destinationLabel(remoteTarget?.destination ?? null)}, which cannot be reached right now (${code}). ${SSH_GUIDANCE[code] ?? ""} Strategies already running on the VPS keep running. Use algorover_runtime_target status to check again.` }],
    structuredContent: remoteUnreachableStatus(code), isError: true };
}

function switchedResult() {
  return { content: [{ type: "text", text: "AlgoRover moved to another location during this conversation. Ask the user to start a new conversation; do not call other AlgoRover tools here." }],
    structuredContent: staleSession({ profile, plugin_id: pluginId, environment: delivery.environment,
      version: productVersion, plugin_version: pluginVersion, expected_product_version: boundVersion, runtime_version: null,
      runtime_contract_version: null, runtime_id: null, bootstrap_installed: existsSync(configuredBootstrapPath()), lifecycle: null }), isError: true };
}

function remoteErrorCode(error) { return error instanceof BridgeError ? error.code : "remote_unreachable"; }

// Requests while this product runs on the VPS, or after a switch in this process. Returns
// undefined for the few methods the local bridge answers itself.
async function handleRemoteRequest(request) {
  const id = request.id;
  if (request.method === "ping") return undefined;
  if (request.method === "initialize") {
    return resultResponse(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      serverInfo: { name: `algorover-ready-bridge-${profile}`, version: productVersion }, instructions: placementInstructions() });
  }
  if (placementSwitched) {
    if (request.method === "tools/list") return resultResponse(id, { tools: [runtimeTargetTool()] });
    if (request.method === "tools/call") return resultResponse(id, switchedResult());
    if (request.method === "resources/list") return resultResponse(id, { resources: [] });
    return errorResponse(id, -32001, "plugin_session_stale");
  }
  if (request.method === "tools/list") {
    try {
      const channel = await openRemote();
      const response = await channel.request("tools/list", request.params ?? {}, REMOTE_LIST_TIMEOUT_MS);
      const tools = Array.isArray(response?.result?.tools) ? response.result.tools.filter((tool) => tool?.name !== "algorover_runtime_target") : [];
      remoteToolAnnotations = new Map(tools.map((tool) => [tool.name, tool.annotations ?? {}]));
      return resultResponse(id, { tools: [runtimeTargetTool(), ...tools] });
    } catch {
      // Status and diagnosis stay listed so the user can still ask what is wrong.
      return resultResponse(id, { tools: [runtimeTargetTool(), ...lifecycleTools(null).filter((tool) => ["algorover_runtime_status", "algorover_runtime_diagnose"].includes(tool.name))] });
    }
  }
  if (request.method === "tools/call") {
    const name = request.params?.name;
    const local = name === "algorover_runtime_status" || name === "algorover_runtime_diagnose";
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let channel;
      try { channel = await openRemote(); } catch (error) { return resultResponse(id, remoteUnreachableResult(remoteErrorCode(error))); }
      if (remoteStale && !LIFECYCLE_TOOL_NAMES.has(name) && !local) return resultResponse(id, switchedResult());
      try {
        response = await channel.request("tools/call", request.params, REMOTE_CALL_TIMEOUT_MS);
        break;
      } catch (error) {
        const code = remoteErrorCode(error);
        // A call that reached the VPS may have run: only read-only tools repeat, once, after a reconnect.
        if (attempt === 0 && (local || remoteToolAnnotations.get(name)?.readOnlyHint === true) && ["remote_disconnected", "ssh_failed"].includes(code)) continue;
        if (local) return resultResponse(id, remoteUnreachableResult(code));
        return resultResponse(id, { content: [{ type: "text", text: `The connection to the VPS dropped during ${name} (${code}); whether it ran is unknown. Check the result (status or the Dashboard) before repeating it.` }],
          structuredContent: { ...remoteUnreachableStatus(code), message: "remote_result_unknown" }, isError: true });
      }
    }
    const result = response?.result;
    if (name === "algorover_runtime_status" && Array.isArray(result?.content) && result.content[0]?.type === "text") {
      result.content[0] = { ...result.content[0], text: `Runs on the VPS ${destinationLabel(remoteTarget.destination)}. ${result.content[0].text}` };
    }
    if (LIFECYCLE_TOOL_NAMES.has(name) && result?.structuredContent?.state === "ready" && typeof result.structuredContent.runtime_id === "string") {
      remoteAdmittedRuntimeId = result.structuredContent.runtime_id;
      remoteStale = false;
    }
    if (result !== undefined) {
      const failures = await ensureTunnelsFor(result);
      if (failures.length && Array.isArray(result.content)) {
        result.content = [...result.content, { type: "text", text: `Dashboard tunnel to the VPS is not ready (${failures.join(", ")}); the link may not open until it is.` }];
      }
    }
    return { ...response, id };
  }
  try {
    const channel = await openRemote();
    const timeout = request.method === "resources/read" ? REMOTE_LIST_TIMEOUT_MS : REMOTE_CALL_TIMEOUT_MS;
    const response = await channel.request(request.method, request.params, timeout);
    return { ...response, id };
  } catch (error) {
    return errorResponse(id, -32001, request.method.startsWith("resources/") ? "runtime_not_ready" : remoteErrorCode(error));
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of input) {
  if (!line.trim()) continue;
  if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
    writeResponse(errorResponse(null, -32600, "request_too_large"));
    continue;
  }
  let request;
  try { request = JSON.parse(line); } catch {
    writeResponse(errorResponse(null, -32700, "invalid_json"));
    continue;
  }
  try {
    const response = await handleRequest(request);
    if (response !== null) writeResponse(response);
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : "bridge_internal_failure";
    if (!(error instanceof BridgeError)) process.stderr.write(`AlgoRover MCP bridge diagnostic: ${error instanceof Error ? `${error.name}:${error.message}` : "unknown"}\n`);
    writeResponse(errorResponse(request?.id ?? null, -32603, code));
  }
}
// The client closed stdin: end the VPS conversation so this process can exit.
remoteChannel?.close();
