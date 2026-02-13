#!/usr/bin/env node
import { createRequire } from "node:module";
import process$1 from "node:process";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger } from "tslog";
import JSON5 from "json5";
import chalk, { Chalk } from "chalk";
import crypto, { X509Certificate, randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { execFile, execFileSync, spawn } from "node:child_process";
import util, { promisify } from "node:util";
import fs$1 from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "proper-lockfile";
import { getOAuthProviders } from "@mariozechner/pi-ai";
import "@aws-sdk/client-bedrock";
import AjvPkg from "ajv";
import { z } from "zod";
import { WebSocket } from "ws";
import { Buffer as Buffer$1 } from "node:buffer";
import { Type } from "@sinclair/typebox";
import { spinner } from "@clack/prompts";
import { createOscProgressController, supportsOscProgress } from "osc-progress";

//#region src/terminal/progress-line.ts
let activeStream = null;
function registerActiveProgressLine(stream) {
	if (!stream.isTTY) return;
	activeStream = stream;
}
function clearActiveProgressLine() {
	if (!activeStream?.isTTY) return;
	activeStream.write("\r\x1B[2K");
}
function unregisterActiveProgressLine(stream) {
	if (!activeStream) return;
	if (stream && activeStream !== stream) return;
	activeStream = null;
}

//#endregion
//#region src/terminal/restore.ts
const RESET_SEQUENCE = "\x1B[0m\x1B[?25h\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1006l\x1B[?2004l";
function reportRestoreFailure(scope, err, reason) {
	const suffix = reason ? ` (${reason})` : "";
	const message = `[terminal] restore ${scope} failed${suffix}: ${String(err)}`;
	try {
		process.stderr.write(`${message}\n`);
	} catch (writeErr) {
		console.error(`[terminal] restore reporting failed${suffix}: ${String(writeErr)}`);
	}
}
function restoreTerminalState(reason) {
	try {
		clearActiveProgressLine();
	} catch (err) {
		reportRestoreFailure("progress line", err, reason);
	}
	const stdin = process.stdin;
	if (stdin.isTTY && typeof stdin.setRawMode === "function") {
		try {
			stdin.setRawMode(false);
		} catch (err) {
			reportRestoreFailure("raw mode", err, reason);
		}
		if (typeof stdin.isPaused === "function" && stdin.isPaused()) try {
			stdin.resume();
		} catch (err) {
			reportRestoreFailure("stdin resume", err, reason);
		}
	}
	if (process.stdout.isTTY) try {
		process.stdout.write(RESET_SEQUENCE);
	} catch (err) {
		reportRestoreFailure("stdout reset", err, reason);
	}
}

//#endregion
//#region src/runtime.ts
const defaultRuntime = {
	log: (...args) => {
		clearActiveProgressLine();
		console.log(...args);
	},
	error: (...args) => {
		clearActiveProgressLine();
		console.error(...args);
	},
	exit: (code) => {
		restoreTerminalState("runtime exit");
		process.exit(code);
		throw new Error("unreachable");
	}
};

//#endregion
//#region src/infra/home-dir.ts
function normalize(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function resolveEffectiveHomeDir(env = process.env, homedir = os.homedir) {
	const raw = resolveRawHomeDir(env, homedir);
	return raw ? path.resolve(raw) : void 0;
}
function resolveRawHomeDir(env, homedir) {
	const explicitHome = normalize(env.OPENCLAW_HOME);
	if (explicitHome) {
		if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
			const fallbackHome = normalize(env.HOME) ?? normalize(env.USERPROFILE) ?? normalizeSafe(homedir);
			if (fallbackHome) return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
			return;
		}
		return explicitHome;
	}
	const envHome = normalize(env.HOME);
	if (envHome) return envHome;
	const userProfile = normalize(env.USERPROFILE);
	if (userProfile) return userProfile;
	return normalizeSafe(homedir);
}
function normalizeSafe(homedir) {
	try {
		return normalize(homedir());
	} catch {
		return;
	}
}
function resolveRequiredHomeDir(env = process.env, homedir = os.homedir) {
	return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
function expandHomePrefix(input, opts) {
	if (!input.startsWith("~")) return input;
	const home = normalize(opts?.home) ?? resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
	if (!home) return input;
	return input.replace(/^~(?=$|[\\/])/, home);
}

//#endregion
//#region src/config/paths.ts
/**
* Nix mode detection: When OPENCLAW_NIX_MODE=1, the gateway is running under Nix.
* In this mode:
* - No auto-install flows should be attempted
* - Missing dependencies should produce actionable Nix-specific error messages
* - Config is managed externally (read-only from Nix perspective)
*/
function resolveIsNixMode(env = process.env) {
	return env.OPENCLAW_NIX_MODE === "1";
}
const isNixMode = resolveIsNixMode();
const LEGACY_STATE_DIRNAMES = [
	".clawdbot",
	".moltbot",
	".moldbot"
];
const NEW_STATE_DIRNAME = ".openclaw";
const CONFIG_FILENAME = "openclaw.json";
const LEGACY_CONFIG_FILENAMES = [
	"clawdbot.json",
	"moltbot.json",
	"moldbot.json"
];
function resolveDefaultHomeDir() {
	return resolveRequiredHomeDir(process.env, os.homedir);
}
/** Build a homedir thunk that respects OPENCLAW_HOME for the given env. */
function envHomedir(env) {
	return () => resolveRequiredHomeDir(env, os.homedir);
}
function legacyStateDirs(homedir = resolveDefaultHomeDir) {
	return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}
function newStateDir(homedir = resolveDefaultHomeDir) {
	return path.join(homedir(), NEW_STATE_DIRNAME);
}
/**
* State directory for mutable data (sessions, logs, caches).
* Can be overridden via OPENCLAW_STATE_DIR.
* Default: ~/.openclaw
*/
function resolveStateDir(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (override) return resolveUserPath$1(override, env, effectiveHomedir);
	const newDir = newStateDir(effectiveHomedir);
	const legacyDirs = legacyStateDirs(effectiveHomedir);
	if (fs.existsSync(newDir)) return newDir;
	const existingLegacy = legacyDirs.find((dir) => {
		try {
			return fs.existsSync(dir);
		} catch {
			return false;
		}
	});
	if (existingLegacy) return existingLegacy;
	return newDir;
}
function resolveUserPath$1(input, env = process.env, homedir = envHomedir(env)) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = expandHomePrefix(trimmed, {
			home: resolveRequiredHomeDir(env, homedir),
			env,
			homedir
		});
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
const STATE_DIR = resolveStateDir();
/**
* Config file path (JSON5).
* Can be overridden via OPENCLAW_CONFIG_PATH.
* Default: ~/.openclaw/openclaw.json (or $OPENCLAW_STATE_DIR/openclaw.json)
*/
function resolveCanonicalConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env))) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
	if (override) return resolveUserPath$1(override, env, envHomedir(env));
	return path.join(stateDir, CONFIG_FILENAME);
}
/**
* Resolve the active config path by preferring existing config candidates
* before falling back to the canonical path.
*/
function resolveConfigPathCandidate(env = process.env, homedir = envHomedir(env)) {
	const existing = resolveDefaultConfigCandidates(env, homedir).find((candidate) => {
		try {
			return fs.existsSync(candidate);
		} catch {
			return false;
		}
	});
	if (existing) return existing;
	return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
}
/**
* Active config path (prefers existing config files).
*/
function resolveConfigPath(env = process.env, stateDir = resolveStateDir(env, envHomedir(env)), homedir = envHomedir(env)) {
	const override = env.OPENCLAW_CONFIG_PATH?.trim();
	if (override) return resolveUserPath$1(override, env, homedir);
	const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
	const existing = [path.join(stateDir, CONFIG_FILENAME), ...LEGACY_CONFIG_FILENAMES.map((name) => path.join(stateDir, name))].find((candidate) => {
		try {
			return fs.existsSync(candidate);
		} catch {
			return false;
		}
	});
	if (existing) return existing;
	if (stateOverride) return path.join(stateDir, CONFIG_FILENAME);
	const defaultStateDir = resolveStateDir(env, homedir);
	if (path.resolve(stateDir) === path.resolve(defaultStateDir)) return resolveConfigPathCandidate(env, homedir);
	return path.join(stateDir, CONFIG_FILENAME);
}
const CONFIG_PATH = resolveConfigPathCandidate();
/**
* Resolve default config path candidates across default locations.
* Order: explicit config path → state-dir-derived paths → new default.
*/
function resolveDefaultConfigCandidates(env = process.env, homedir = envHomedir(env)) {
	const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
	const explicit = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
	if (explicit) return [resolveUserPath$1(explicit, env, effectiveHomedir)];
	const candidates = [];
	const openclawStateDir = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (openclawStateDir) {
		const resolved = resolveUserPath$1(openclawStateDir, env, effectiveHomedir);
		candidates.push(path.join(resolved, CONFIG_FILENAME));
		candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(resolved, name)));
	}
	const defaultDirs = [newStateDir(effectiveHomedir), ...legacyStateDirs(effectiveHomedir)];
	for (const dir of defaultDirs) {
		candidates.push(path.join(dir, CONFIG_FILENAME));
		candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(dir, name)));
	}
	return candidates;
}
const DEFAULT_GATEWAY_PORT = 18789;
function resolveGatewayPort(cfg, env = process.env) {
	const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim() || env.CLAWDBOT_GATEWAY_PORT?.trim();
	if (envRaw) {
		const parsed = Number.parseInt(envRaw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	const configPort = cfg?.gateway?.port;
	if (typeof configPort === "number" && Number.isFinite(configPort)) {
		if (configPort > 0) return configPort;
	}
	return DEFAULT_GATEWAY_PORT;
}

//#endregion
//#region src/logging/config.ts
function readLoggingConfig() {
	const configPath = resolveConfigPath();
	try {
		if (!fs.existsSync(configPath)) return;
		const raw = fs.readFileSync(configPath, "utf-8");
		const logging = JSON5.parse(raw)?.logging;
		if (!logging || typeof logging !== "object" || Array.isArray(logging)) return;
		return logging;
	} catch {
		return;
	}
}

//#endregion
//#region src/logging/levels.ts
const ALLOWED_LOG_LEVELS = [
	"silent",
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace"
];
function normalizeLogLevel(level, fallback = "info") {
	const candidate = (level ?? fallback).trim();
	return ALLOWED_LOG_LEVELS.includes(candidate) ? candidate : fallback;
}
function levelToMinLevel(level) {
	return {
		fatal: 0,
		error: 1,
		warn: 2,
		info: 3,
		debug: 4,
		trace: 5,
		silent: Number.POSITIVE_INFINITY
	}[level];
}

//#endregion
//#region src/logging/state.ts
const loggingState = {
	cachedLogger: null,
	cachedSettings: null,
	cachedConsoleSettings: null,
	overrideSettings: null,
	consolePatched: false,
	forceConsoleToStderr: false,
	consoleTimestampPrefix: false,
	consoleSubsystemFilter: null,
	resolvingConsoleSettings: false,
	streamErrorHandlersInstalled: false,
	rawConsole: null
};

//#endregion
//#region src/logging/logger.ts
const DEFAULT_LOG_DIR = "/tmp/openclaw";
const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "openclaw.log");
const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 1440 * 60 * 1e3;
const requireConfig$1 = createRequire(import.meta.url);
const externalTransports = /* @__PURE__ */ new Set();
function attachExternalTransport(logger, transport) {
	logger.attachTransport((logObj) => {
		if (!externalTransports.has(transport)) return;
		try {
			transport(logObj);
		} catch {}
	});
}
function resolveSettings() {
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg) try {
		cfg = requireConfig$1("../config/config.js").loadConfig?.().logging;
	} catch {
		cfg = void 0;
	}
	return {
		level: normalizeLogLevel(cfg?.level, "info"),
		file: cfg?.file ?? defaultRollingPathForToday()
	};
}
function settingsChanged(a, b) {
	if (!a) return true;
	return a.level !== b.level || a.file !== b.file;
}
function buildLogger(settings) {
	fs.mkdirSync(path.dirname(settings.file), { recursive: true });
	if (isRollingPath(settings.file)) pruneOldRollingLogs(path.dirname(settings.file));
	const logger = new Logger({
		name: "openclaw",
		minLevel: levelToMinLevel(settings.level),
		type: "hidden"
	});
	logger.attachTransport((logObj) => {
		try {
			const time = logObj.date?.toISOString?.() ?? (/* @__PURE__ */ new Date()).toISOString();
			const line = JSON.stringify({
				...logObj,
				time
			});
			fs.appendFileSync(settings.file, `${line}\n`, { encoding: "utf8" });
		} catch {}
	});
	for (const transport of externalTransports) attachExternalTransport(logger, transport);
	return logger;
}
function getLogger() {
	const settings = resolveSettings();
	const cachedLogger = loggingState.cachedLogger;
	const cachedSettings = loggingState.cachedSettings;
	if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
		loggingState.cachedLogger = buildLogger(settings);
		loggingState.cachedSettings = settings;
	}
	return loggingState.cachedLogger;
}
function getChildLogger(bindings, opts) {
	const base = getLogger();
	const minLevel = opts?.level ? levelToMinLevel(opts.level) : void 0;
	const name = bindings ? JSON.stringify(bindings) : void 0;
	return base.getSubLogger({
		name,
		minLevel,
		prefix: bindings ? [name ?? ""] : []
	});
}
function formatLocalDate(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function defaultRollingPathForToday() {
	const today = formatLocalDate(/* @__PURE__ */ new Date());
	return path.join(DEFAULT_LOG_DIR, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}
function isRollingPath(file) {
	const base = path.basename(file);
	return base.startsWith(`${LOG_PREFIX}-`) && base.endsWith(LOG_SUFFIX) && base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length;
}
function pruneOldRollingLogs(dir) {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const cutoff = Date.now() - MAX_LOG_AGE_MS;
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) continue;
			const fullPath = path.join(dir, entry.name);
			try {
				if (fs.statSync(fullPath).mtimeMs < cutoff) fs.rmSync(fullPath, { force: true });
			} catch {}
		}
	} catch {}
}

//#endregion
//#region src/terminal/palette.ts
const LOBSTER_PALETTE = {
	accent: "#FF5A2D",
	accentBright: "#FF7A3D",
	accentDim: "#D14A22",
	info: "#FF8A5B",
	success: "#2FBF71",
	warn: "#FFB020",
	error: "#E23D2D",
	muted: "#8B7F77"
};

//#endregion
//#region src/terminal/theme.ts
const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;
const hex = (value) => baseChalk.hex(value);
const theme = {
	accent: hex(LOBSTER_PALETTE.accent),
	accentBright: hex(LOBSTER_PALETTE.accentBright),
	accentDim: hex(LOBSTER_PALETTE.accentDim),
	info: hex(LOBSTER_PALETTE.info),
	success: hex(LOBSTER_PALETTE.success),
	warn: hex(LOBSTER_PALETTE.warn),
	error: hex(LOBSTER_PALETTE.error),
	muted: hex(LOBSTER_PALETTE.muted),
	heading: baseChalk.bold.hex(LOBSTER_PALETTE.accent),
	command: hex(LOBSTER_PALETTE.accentBright),
	option: hex(LOBSTER_PALETTE.warn)
};
const isRich = () => Boolean(baseChalk.level > 0);
const colorize = (rich, color, value) => rich ? color(value) : value;

//#endregion
//#region src/globals.ts
let globalVerbose = false;
function isVerbose() {
	return globalVerbose;
}
function logVerboseConsole(message) {
	if (!globalVerbose) return;
	console.log(theme.muted(message));
}
const success = theme.success;
const warn = theme.warn;
const info = theme.info;
const danger = theme.error;

//#endregion
//#region src/utils.ts
async function ensureDir$1(dir) {
	await fs.promises.mkdir(dir, { recursive: true });
}
/**
* Type guard for plain objects (not arrays, null, Date, RegExp, etc.).
* Uses Object.prototype.toString for maximum safety.
*/
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}
/**
* Type guard for Record<string, unknown> (less strict than isPlainObject).
* Accepts any non-null object that isn't an array.
*/
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveUserPath(input) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = expandHomePrefix(trimmed, {
			home: resolveRequiredHomeDir(process.env, os.homedir),
			env: process.env,
			homedir: os.homedir
		});
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
function resolveConfigDir(env = process.env, homedir = os.homedir) {
	const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
	if (override) return resolveUserPath(override);
	const newDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
	try {
		if (fs.existsSync(newDir)) return newDir;
	} catch {}
	return newDir;
}
function resolveHomeDir() {
	return resolveEffectiveHomeDir(process.env, os.homedir);
}
function resolveHomeDisplayPrefix() {
	const home = resolveHomeDir();
	if (!home) return;
	if (process.env.OPENCLAW_HOME?.trim()) return {
		home,
		prefix: "$OPENCLAW_HOME"
	};
	return {
		home,
		prefix: "~"
	};
}
function shortenHomeInString(input) {
	if (!input) return input;
	const display = resolveHomeDisplayPrefix();
	if (!display) return input;
	return input.split(display.home).join(display.prefix);
}
function formatTerminalLink(label, url, opts) {
	const esc = "\x1B";
	const safeLabel = label.replaceAll(esc, "");
	const safeUrl = url.replaceAll(esc, "");
	if (!(opts?.force === true ? true : opts?.force === false ? false : Boolean(process.stdout.isTTY))) return opts?.fallback ?? `${safeLabel} (${safeUrl})`;
	return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}
const CONFIG_DIR = resolveConfigDir();

//#endregion
//#region src/terminal/links.ts
const DOCS_ROOT = "https://docs.openclaw.ai";
function formatDocsLink(path, label, opts) {
	const trimmed = path.trim();
	const url = trimmed.startsWith("http") ? trimmed : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
	return formatTerminalLink(label ?? url, url, {
		fallback: opts?.fallback ?? url,
		force: opts?.force
	});
}

//#endregion
//#region src/infra/errors.ts
function extractErrorCode(err) {
	if (!err || typeof err !== "object") return;
	const code = err.code;
	if (typeof code === "string") return code;
	if (typeof code === "number") return String(code);
}
function formatErrorMessage(err) {
	if (err instanceof Error) return err.message || err.name || "Error";
	if (typeof err === "string") return err;
	if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
	try {
		return JSON.stringify(err);
	} catch {
		return Object.prototype.toString.call(err);
	}
}
function formatUncaughtError(err) {
	if (extractErrorCode(err) === "INVALID_CONFIG") return formatErrorMessage(err);
	if (err instanceof Error) return err.stack ?? err.message ?? err.name;
	return formatErrorMessage(err);
}

//#endregion
//#region src/cli/cli-utils.ts
async function runCommandWithRuntime(runtime, action, onError) {
	try {
		await action();
	} catch (err) {
		if (onError) {
			onError(err);
			return;
		}
		runtime.error(String(err));
		runtime.exit(1);
	}
}

//#endregion
//#region src/infra/dotenv.ts
function loadDotEnv(opts) {
	const quiet = opts?.quiet ?? true;
	dotenv.config({ quiet });
	const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
	if (!fs.existsSync(globalEnvPath)) return;
	dotenv.config({
		quiet,
		path: globalEnvPath,
		override: false
	});
}

//#endregion
//#region src/plugins/runtime.ts
const createEmptyRegistry = () => ({
	plugins: [],
	tools: [],
	hooks: [],
	typedHooks: [],
	channels: [],
	providers: [],
	gatewayHandlers: {},
	httpHandlers: [],
	httpRoutes: [],
	cliRegistrars: [],
	services: [],
	commands: [],
	diagnostics: []
});
const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
const state = (() => {
	const globalState = globalThis;
	if (!globalState[REGISTRY_STATE]) globalState[REGISTRY_STATE] = {
		registry: createEmptyRegistry(),
		key: null
	};
	return globalState[REGISTRY_STATE];
})();

//#endregion
//#region src/channels/registry.ts
const CHAT_CHANNEL_ORDER = [
	"telegram",
	"whatsapp",
	"discord",
	"irc",
	"googlechat",
	"slack",
	"signal",
	"imessage"
];
const CHANNEL_IDS = [...CHAT_CHANNEL_ORDER];
const CHAT_CHANNEL_ALIASES = {
	imsg: "imessage",
	"internet-relay-chat": "irc",
	"google-chat": "googlechat",
	gchat: "googlechat"
};
const normalizeChannelKey = (raw) => {
	return raw?.trim().toLowerCase() || void 0;
};
function normalizeChatChannelId(raw) {
	const normalized = normalizeChannelKey(raw);
	if (!normalized) return null;
	const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
	return CHAT_CHANNEL_ORDER.includes(resolved) ? resolved : null;
}

//#endregion
//#region src/terminal/ansi.ts
const ANSI_SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";
const ANSI_REGEX = new RegExp(ANSI_SGR_PATTERN, "g");
const OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");
function stripAnsi(input) {
	return input.replace(OSC8_REGEX, "").replace(ANSI_REGEX, "");
}

//#endregion
//#region src/logging/console.ts
const requireConfig = createRequire(import.meta.url);
function normalizeConsoleLevel(level) {
	if (isVerbose()) return "debug";
	return normalizeLogLevel(level, "info");
}
function normalizeConsoleStyle(style) {
	if (style === "compact" || style === "json" || style === "pretty") return style;
	if (!process.stdout.isTTY) return "compact";
	return "pretty";
}
function resolveConsoleSettings() {
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg) if (loggingState.resolvingConsoleSettings) cfg = void 0;
	else {
		loggingState.resolvingConsoleSettings = true;
		try {
			cfg = requireConfig("../config/config.js").loadConfig?.().logging;
		} catch {
			cfg = void 0;
		} finally {
			loggingState.resolvingConsoleSettings = false;
		}
	}
	return {
		level: normalizeConsoleLevel(cfg?.consoleLevel),
		style: normalizeConsoleStyle(cfg?.consoleStyle)
	};
}
function consoleSettingsChanged(a, b) {
	if (!a) return true;
	return a.level !== b.level || a.style !== b.style;
}
function getConsoleSettings() {
	const settings = resolveConsoleSettings();
	const cached = loggingState.cachedConsoleSettings;
	if (!cached || consoleSettingsChanged(cached, settings)) loggingState.cachedConsoleSettings = settings;
	return loggingState.cachedConsoleSettings;
}
function shouldLogSubsystemToConsole(subsystem) {
	const filter = loggingState.consoleSubsystemFilter;
	if (!filter || filter.length === 0) return true;
	return filter.some((prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`));
}
const SUPPRESSED_CONSOLE_PREFIXES = [
	"Closing session:",
	"Opening session:",
	"Removing old closed session:",
	"Session already closed",
	"Session already open"
];
function shouldSuppressConsoleMessage(message) {
	if (isVerbose()) return false;
	if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) return true;
	if (message.startsWith("[EventQueue] Slow listener detected") && message.includes("DiscordMessageListener")) return true;
	return false;
}
function isEpipeError(err) {
	const code = err?.code;
	return code === "EPIPE" || code === "EIO";
}
function formatConsoleTimestamp(style) {
	const now = /* @__PURE__ */ new Date();
	if (style === "pretty") return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const h = String(now.getHours()).padStart(2, "0");
	const m = String(now.getMinutes()).padStart(2, "0");
	const s = String(now.getSeconds()).padStart(2, "0");
	const ms = String(now.getMilliseconds()).padStart(3, "0");
	const tzOffset = now.getTimezoneOffset();
	return `${year}-${month}-${day}T${h}:${m}:${s}.${ms}${tzOffset <= 0 ? "+" : "-"}${String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0")}:${String(Math.abs(tzOffset) % 60).padStart(2, "0")}`;
}
function hasTimestampPrefix(value) {
	return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.test(value);
}
function isJsonPayload(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}
/**
* Route console.* calls through file logging while still emitting to stdout/stderr.
* This keeps user-facing output unchanged but guarantees every console call is captured in log files.
*/
function enableConsoleCapture() {
	if (loggingState.consolePatched) return;
	loggingState.consolePatched = true;
	if (!loggingState.streamErrorHandlersInstalled) {
		loggingState.streamErrorHandlersInstalled = true;
		for (const stream of [process.stdout, process.stderr]) stream.on("error", (err) => {
			if (isEpipeError(err)) return;
			throw err;
		});
	}
	let logger = null;
	const getLoggerLazy = () => {
		if (!logger) logger = getLogger();
		return logger;
	};
	const original = {
		log: console.log,
		info: console.info,
		warn: console.warn,
		error: console.error,
		debug: console.debug,
		trace: console.trace
	};
	loggingState.rawConsole = {
		log: original.log,
		info: original.info,
		warn: original.warn,
		error: original.error
	};
	const forward = (level, orig) => (...args) => {
		const formatted = util.format(...args);
		if (shouldSuppressConsoleMessage(formatted)) return;
		const trimmed = stripAnsi(formatted).trimStart();
		const timestamp = loggingState.consoleTimestampPrefix && trimmed.length > 0 && !hasTimestampPrefix(trimmed) && !isJsonPayload(trimmed) ? formatConsoleTimestamp(getConsoleSettings().style) : "";
		try {
			const resolvedLogger = getLoggerLazy();
			if (level === "trace") resolvedLogger.trace(formatted);
			else if (level === "debug") resolvedLogger.debug(formatted);
			else if (level === "info") resolvedLogger.info(formatted);
			else if (level === "warn") resolvedLogger.warn(formatted);
			else if (level === "error" || level === "fatal") resolvedLogger.error(formatted);
			else resolvedLogger.info(formatted);
		} catch {}
		if (loggingState.forceConsoleToStderr) try {
			const line = timestamp ? `${timestamp} ${formatted}` : formatted;
			process.stderr.write(`${line}\n`);
		} catch (err) {
			if (isEpipeError(err)) return;
			throw err;
		}
		else try {
			if (!timestamp) {
				orig.apply(console, args);
				return;
			}
			if (args.length === 0) {
				orig.call(console, timestamp);
				return;
			}
			if (typeof args[0] === "string") {
				orig.call(console, `${timestamp} ${args[0]}`, ...args.slice(1));
				return;
			}
			orig.call(console, timestamp, ...args);
		} catch (err) {
			if (isEpipeError(err)) return;
			throw err;
		}
	};
	console.log = forward("info", original.log);
	console.info = forward("info", original.info);
	console.warn = forward("warn", original.warn);
	console.error = forward("error", original.error);
	console.debug = forward("debug", original.debug);
	console.trace = forward("trace", original.trace);
}

//#endregion
//#region src/logging/subsystem.ts
function shouldLogToConsole(level, settings) {
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
function isRichConsoleEnv() {
	const term = (process.env.TERM ?? "").toLowerCase();
	if (process.env.COLORTERM || process.env.TERM_PROGRAM) return true;
	return term.length > 0 && term !== "dumb";
}
function getColorForConsole() {
	const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
	if (process.env.NO_COLOR && !hasForceColor) return new Chalk({ level: 0 });
	return Boolean(process.stdout.isTTY || process.stderr.isTTY) || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
}
const SUBSYSTEM_COLORS = [
	"cyan",
	"green",
	"yellow",
	"blue",
	"magenta",
	"red"
];
const SUBSYSTEM_COLOR_OVERRIDES = { "gmail-watcher": "blue" };
const SUBSYSTEM_PREFIXES_TO_DROP = [
	"gateway",
	"channels",
	"providers"
];
const SUBSYSTEM_MAX_SEGMENTS = 2;
const CHANNEL_SUBSYSTEM_PREFIXES = new Set(CHAT_CHANNEL_ORDER);
function pickSubsystemColor(color, subsystem) {
	const override = SUBSYSTEM_COLOR_OVERRIDES[subsystem];
	if (override) return color[override];
	let hash = 0;
	for (let i = 0; i < subsystem.length; i += 1) hash = hash * 31 + subsystem.charCodeAt(i) | 0;
	return color[SUBSYSTEM_COLORS[Math.abs(hash) % SUBSYSTEM_COLORS.length]];
}
function formatSubsystemForConsole(subsystem) {
	const parts = subsystem.split("/").filter(Boolean);
	const original = parts.join("/") || subsystem;
	while (parts.length > 0 && SUBSYSTEM_PREFIXES_TO_DROP.includes(parts[0])) parts.shift();
	if (parts.length === 0) return original;
	if (CHANNEL_SUBSYSTEM_PREFIXES.has(parts[0])) return parts[0];
	if (parts.length > SUBSYSTEM_MAX_SEGMENTS) return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");
	return parts.join("/");
}
function stripRedundantSubsystemPrefixForConsole(message, displaySubsystem) {
	if (!displaySubsystem) return message;
	if (message.startsWith("[")) {
		const closeIdx = message.indexOf("]");
		if (closeIdx > 1) {
			if (message.slice(1, closeIdx).toLowerCase() === displaySubsystem.toLowerCase()) {
				let i = closeIdx + 1;
				while (message[i] === " ") i += 1;
				return message.slice(i);
			}
		}
	}
	if (message.slice(0, displaySubsystem.length).toLowerCase() !== displaySubsystem.toLowerCase()) return message;
	const next = message.slice(displaySubsystem.length, displaySubsystem.length + 1);
	if (next !== ":" && next !== " ") return message;
	let i = displaySubsystem.length;
	while (message[i] === " ") i += 1;
	if (message[i] === ":") i += 1;
	while (message[i] === " ") i += 1;
	return message.slice(i);
}
function formatConsoleLine(opts) {
	const displaySubsystem = opts.style === "json" ? opts.subsystem : formatSubsystemForConsole(opts.subsystem);
	if (opts.style === "json") return JSON.stringify({
		time: (/* @__PURE__ */ new Date()).toISOString(),
		level: opts.level,
		subsystem: displaySubsystem,
		message: opts.message,
		...opts.meta
	});
	const color = getColorForConsole();
	const prefix = `[${displaySubsystem}]`;
	const prefixColor = pickSubsystemColor(color, displaySubsystem);
	const levelColor = opts.level === "error" || opts.level === "fatal" ? color.red : opts.level === "warn" ? color.yellow : opts.level === "debug" || opts.level === "trace" ? color.gray : color.cyan;
	const displayMessage = stripRedundantSubsystemPrefixForConsole(opts.message, displaySubsystem);
	return `${[(() => {
		if (opts.style === "pretty") return color.gray((/* @__PURE__ */ new Date()).toISOString().slice(11, 19));
		if (loggingState.consoleTimestampPrefix) return color.gray((/* @__PURE__ */ new Date()).toISOString());
		return "";
	})(), prefixColor(prefix)].filter(Boolean).join(" ")} ${levelColor(displayMessage)}`;
}
function writeConsoleLine(level, line) {
	clearActiveProgressLine();
	const sanitized = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" ? line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?").replace(/[\uD800-\uDFFF]/g, "?") : line;
	const sink = loggingState.rawConsole ?? console;
	if (loggingState.forceConsoleToStderr || level === "error" || level === "fatal") (sink.error ?? console.error)(sanitized);
	else if (level === "warn") (sink.warn ?? console.warn)(sanitized);
	else (sink.log ?? console.log)(sanitized);
}
function logToFile(fileLogger, level, message, meta) {
	if (level === "silent") return;
	const method = fileLogger[level];
	if (typeof method !== "function") return;
	if (meta && Object.keys(meta).length > 0) method.call(fileLogger, meta, message);
	else method.call(fileLogger, message);
}
function createSubsystemLogger(subsystem) {
	let fileLogger = null;
	const getFileLogger = () => {
		if (!fileLogger) fileLogger = getChildLogger({ subsystem });
		return fileLogger;
	};
	const emit = (level, message, meta) => {
		const consoleSettings = getConsoleSettings();
		let consoleMessageOverride;
		let fileMeta = meta;
		if (meta && Object.keys(meta).length > 0) {
			const { consoleMessage, ...rest } = meta;
			if (typeof consoleMessage === "string") consoleMessageOverride = consoleMessage;
			fileMeta = Object.keys(rest).length > 0 ? rest : void 0;
		}
		logToFile(getFileLogger(), level, message, fileMeta);
		if (!shouldLogToConsole(level, { level: consoleSettings.level })) return;
		if (!shouldLogSubsystemToConsole(subsystem)) return;
		const consoleMessage = consoleMessageOverride ?? message;
		if (!isVerbose() && subsystem === "agent/embedded" && /(sessionId|runId)=probe-/.test(consoleMessage)) return;
		writeConsoleLine(level, formatConsoleLine({
			level,
			subsystem,
			message: consoleSettings.style === "json" ? message : consoleMessage,
			style: consoleSettings.style,
			meta: fileMeta
		}));
	};
	return {
		subsystem,
		trace: (message, meta) => emit("trace", message, meta),
		debug: (message, meta) => emit("debug", message, meta),
		info: (message, meta) => emit("info", message, meta),
		warn: (message, meta) => emit("warn", message, meta),
		error: (message, meta) => emit("error", message, meta),
		fatal: (message, meta) => emit("fatal", message, meta),
		raw: (message) => {
			logToFile(getFileLogger(), "info", message, { raw: true });
			if (shouldLogSubsystemToConsole(subsystem)) {
				if (!isVerbose() && subsystem === "agent/embedded" && /(sessionId|runId)=probe-/.test(message)) return;
				writeConsoleLine("info", message);
			}
		},
		child: (name) => createSubsystemLogger(`${subsystem}/${name}`)
	};
}

//#endregion
//#region src/utils/boolean.ts
const DEFAULT_TRUTHY = [
	"true",
	"1",
	"yes",
	"on"
];
const DEFAULT_FALSY = [
	"false",
	"0",
	"no",
	"off"
];
const DEFAULT_TRUTHY_SET = new Set(DEFAULT_TRUTHY);
const DEFAULT_FALSY_SET = new Set(DEFAULT_FALSY);
function parseBooleanValue(value, options = {}) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return;
	const truthy = options.truthy ?? DEFAULT_TRUTHY;
	const falsy = options.falsy ?? DEFAULT_FALSY;
	const truthySet = truthy === DEFAULT_TRUTHY ? DEFAULT_TRUTHY_SET : new Set(truthy);
	const falsySet = falsy === DEFAULT_FALSY ? DEFAULT_FALSY_SET : new Set(falsy);
	if (truthySet.has(normalized)) return true;
	if (falsySet.has(normalized)) return false;
}

//#endregion
//#region src/infra/env.ts
const log$2 = createSubsystemLogger("env");
function normalizeZaiEnv() {
	if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
}
function isTruthyEnvValue(value) {
	return parseBooleanValue(value) === true;
}
function normalizeEnv() {
	normalizeZaiEnv();
}

//#endregion
//#region src/infra/shell-env.ts
const DEFAULT_TIMEOUT_MS = 15e3;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
let lastAppliedKeys = [];
function resolveShell(env) {
	const shell = env.SHELL?.trim();
	return shell && shell.length > 0 ? shell : "/bin/sh";
}
function parseShellEnv(stdout) {
	const shellEnv = /* @__PURE__ */ new Map();
	const parts = stdout.toString("utf8").split("\0");
	for (const part of parts) {
		if (!part) continue;
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		const key = part.slice(0, eq);
		const value = part.slice(eq + 1);
		if (!key) continue;
		shellEnv.set(key, value);
	}
	return shellEnv;
}
function loadShellEnvFallback(opts) {
	const logger = opts.logger ?? console;
	const exec = opts.exec ?? execFileSync;
	if (!opts.enabled) {
		lastAppliedKeys = [];
		return {
			ok: true,
			applied: [],
			skippedReason: "disabled"
		};
	}
	if (opts.expectedKeys.some((key) => Boolean(opts.env[key]?.trim()))) {
		lastAppliedKeys = [];
		return {
			ok: true,
			applied: [],
			skippedReason: "already-has-keys"
		};
	}
	const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
	const shell = resolveShell(opts.env);
	let stdout;
	try {
		stdout = exec(shell, [
			"-l",
			"-c",
			"env -0"
		], {
			encoding: "buffer",
			timeout: timeoutMs,
			maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
			env: opts.env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn(`[openclaw] shell env fallback failed: ${msg}`);
		lastAppliedKeys = [];
		return {
			ok: false,
			error: msg,
			applied: []
		};
	}
	const shellEnv = parseShellEnv(stdout);
	const applied = [];
	for (const key of opts.expectedKeys) {
		if (opts.env[key]?.trim()) continue;
		const value = shellEnv.get(key);
		if (!value?.trim()) continue;
		opts.env[key] = value;
		applied.push(key);
	}
	lastAppliedKeys = applied;
	return {
		ok: true,
		applied
	};
}
function shouldEnableShellEnvFallback(env) {
	return isTruthyEnvValue(env.OPENCLAW_LOAD_SHELL_ENV);
}
function shouldDeferShellEnvFallback(env) {
	return isTruthyEnvValue(env.OPENCLAW_DEFER_SHELL_ENV_FALLBACK);
}
function resolveShellEnvFallbackTimeoutMs(env) {
	const raw = env.OPENCLAW_SHELL_ENV_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
	return Math.max(0, parsed);
}

//#endregion
//#region src/version.ts
const CORE_PACKAGE_NAME = "openclaw";
const PACKAGE_JSON_CANDIDATES = [
	"../package.json",
	"../../package.json",
	"../../../package.json",
	"./package.json"
];
const BUILD_INFO_CANDIDATES = [
	"../build-info.json",
	"../../build-info.json",
	"./build-info.json"
];
function readVersionFromJsonCandidates(moduleUrl, candidates, opts = {}) {
	try {
		const require = createRequire(moduleUrl);
		for (const candidate of candidates) try {
			const parsed = require(candidate);
			const version = parsed.version?.trim();
			if (!version) continue;
			if (opts.requirePackageName && parsed.name !== CORE_PACKAGE_NAME) continue;
			return version;
		} catch {}
		return null;
	} catch {
		return null;
	}
}
function readVersionFromPackageJsonForModuleUrl(moduleUrl) {
	return readVersionFromJsonCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES, { requirePackageName: true });
}
function readVersionFromBuildInfoForModuleUrl(moduleUrl) {
	return readVersionFromJsonCandidates(moduleUrl, BUILD_INFO_CANDIDATES);
}
function resolveVersionFromModuleUrl(moduleUrl) {
	return readVersionFromPackageJsonForModuleUrl(moduleUrl) || readVersionFromBuildInfoForModuleUrl(moduleUrl);
}
const VERSION = typeof __OPENCLAW_VERSION__ === "string" && __OPENCLAW_VERSION__ || process.env.OPENCLAW_BUNDLED_VERSION || resolveVersionFromModuleUrl(import.meta.url) || "0.0.0";

//#endregion
//#region src/routing/session-key.ts
const DEFAULT_AGENT_ID = "main";
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
function normalizeAgentId(value) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return DEFAULT_AGENT_ID;
	if (VALID_ID_RE.test(trimmed)) return trimmed.toLowerCase();
	return trimmed.toLowerCase().replace(INVALID_CHARS_RE, "-").replace(LEADING_DASH_RE, "").replace(TRAILING_DASH_RE, "").slice(0, 64) || DEFAULT_AGENT_ID;
}

//#endregion
//#region src/config/agent-dirs.ts
var DuplicateAgentDirError = class extends Error {
	constructor(duplicates) {
		super(formatDuplicateAgentDirError(duplicates));
		this.name = "DuplicateAgentDirError";
		this.duplicates = duplicates;
	}
};
function canonicalizeAgentDir(agentDir) {
	const resolved = path.resolve(agentDir);
	if (process.platform === "darwin" || process.platform === "win32") return resolved.toLowerCase();
	return resolved;
}
function collectReferencedAgentIds(cfg) {
	const ids = /* @__PURE__ */ new Set();
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
	const defaultAgentId = agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
	ids.add(normalizeAgentId(defaultAgentId));
	for (const entry of agents) if (entry?.id) ids.add(normalizeAgentId(entry.id));
	const bindings = cfg.bindings;
	if (Array.isArray(bindings)) for (const binding of bindings) {
		const id = binding?.agentId;
		if (typeof id === "string" && id.trim()) ids.add(normalizeAgentId(id));
	}
	return [...ids];
}
function resolveEffectiveAgentDir(cfg, agentId, deps) {
	const id = normalizeAgentId(agentId);
	const trimmed = (Array.isArray(cfg.agents?.list) ? cfg.agents?.list.find((agent) => normalizeAgentId(agent.id) === id)?.agentDir : void 0)?.trim();
	if (trimmed) return resolveUserPath(trimmed);
	const env = deps?.env ?? process.env;
	const root = resolveStateDir(env, deps?.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir)));
	return path.join(root, "agents", id, "agent");
}
function findDuplicateAgentDirs(cfg, deps) {
	const byDir = /* @__PURE__ */ new Map();
	for (const agentId of collectReferencedAgentIds(cfg)) {
		const agentDir = resolveEffectiveAgentDir(cfg, agentId, deps);
		const key = canonicalizeAgentDir(agentDir);
		const entry = byDir.get(key);
		if (entry) entry.agentIds.push(agentId);
		else byDir.set(key, {
			agentDir,
			agentIds: [agentId]
		});
	}
	return [...byDir.values()].filter((v) => v.agentIds.length > 1);
}
function formatDuplicateAgentDirError(dups) {
	return [
		"Duplicate agentDir detected (multi-agent config).",
		"Each agent must have a unique agentDir; sharing it causes auth/session state collisions and token invalidation.",
		"",
		"Conflicts:",
		...dups.map((d) => `- ${d.agentDir}: ${d.agentIds.map((id) => `"${id}"`).join(", ")}`),
		"",
		"Fix: remove the shared agents.list[].agentDir override (or give each agent its own directory).",
		"If you want to share credentials, copy auth-profiles.json instead of sharing the entire agentDir."
	].join("\n");
}

//#endregion
//#region src/agents/defaults.ts
const DEFAULT_CONTEXT_TOKENS = 2e5;

//#endregion
//#region src/logger.ts
const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;
function splitSubsystem(message) {
	const match = message.match(subsystemPrefixRe);
	if (!match) return null;
	const [, subsystem, rest] = match;
	return {
		subsystem,
		rest
	};
}
function logError(message, runtime = defaultRuntime) {
	const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
	if (parsed) {
		createSubsystemLogger(parsed.subsystem).error(parsed.rest);
		return;
	}
	runtime.error(danger(message));
	getLogger().error(message);
}
function logDebug(message) {
	getLogger().debug(message);
	logVerboseConsole(message);
}

//#endregion
//#region src/process/exec.ts
const execFileAsync$2 = promisify(execFile);

//#endregion
//#region src/agents/workspace-templates.ts
const FALLBACK_TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/reference/templates");

//#endregion
//#region src/agents/workspace.ts
function resolveDefaultAgentWorkspaceDir(env = process.env, homedir = os.homedir) {
	const home = resolveRequiredHomeDir(env, homedir);
	const profile = env.OPENCLAW_PROFILE?.trim();
	if (profile && profile.toLowerCase() !== "default") return path.join(home, ".openclaw", `workspace-${profile}`);
	return path.join(home, ".openclaw", "workspace");
}
const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();

//#endregion
//#region src/agents/agent-scope.ts
let defaultAgentWarned = false;
function listAgents(cfg) {
	const list = cfg.agents?.list;
	if (!Array.isArray(list)) return [];
	return list.filter((entry) => Boolean(entry && typeof entry === "object"));
}
function resolveDefaultAgentId(cfg) {
	const agents = listAgents(cfg);
	if (agents.length === 0) return DEFAULT_AGENT_ID;
	const defaults = agents.filter((agent) => agent?.default);
	if (defaults.length > 1 && !defaultAgentWarned) {
		defaultAgentWarned = true;
		console.warn("Multiple agents marked default=true; using the first entry as default.");
	}
	const chosen = (defaults[0] ?? agents[0])?.id?.trim();
	return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}
function resolveAgentEntry(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	return listAgents(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}
function resolveAgentConfig(cfg, agentId) {
	const entry = resolveAgentEntry(cfg, normalizeAgentId(agentId));
	if (!entry) return;
	return {
		name: typeof entry.name === "string" ? entry.name : void 0,
		workspace: typeof entry.workspace === "string" ? entry.workspace : void 0,
		agentDir: typeof entry.agentDir === "string" ? entry.agentDir : void 0,
		model: typeof entry.model === "string" || entry.model && typeof entry.model === "object" ? entry.model : void 0,
		skills: Array.isArray(entry.skills) ? entry.skills : void 0,
		memorySearch: entry.memorySearch,
		humanDelay: entry.humanDelay,
		heartbeat: entry.heartbeat,
		identity: entry.identity,
		groupChat: entry.groupChat,
		subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : void 0,
		sandbox: entry.sandbox,
		tools: entry.tools
	};
}
function resolveAgentWorkspaceDir(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
	if (configured) return resolveUserPath(configured);
	if (id === resolveDefaultAgentId(cfg)) {
		const fallback = cfg.agents?.defaults?.workspace?.trim();
		if (fallback) return resolveUserPath(fallback);
		return resolveDefaultAgentWorkspaceDir(process.env);
	}
	const stateDir = resolveStateDir(process.env);
	return path.join(stateDir, `workspace-${id}`);
}

//#endregion
//#region src/agents/auth-profiles/constants.ts
const EXTERNAL_CLI_SYNC_TTL_MS = 900 * 1e3;
const EXTERNAL_CLI_NEAR_EXPIRY_MS = 600 * 1e3;
const log$1 = createSubsystemLogger("agents/auth-profiles");

//#endregion
//#region src/cli/profile-utils.ts
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function isValidProfileName(value) {
	if (!value) return false;
	return PROFILE_NAME_RE.test(value);
}

//#endregion
//#region src/agents/cli-credentials.ts
const log = createSubsystemLogger("agents/auth-profiles");

//#endregion
//#region src/agents/chutes-oauth.ts
const CHUTES_OAUTH_ISSUER = "https://api.chutes.ai";
const CHUTES_AUTHORIZE_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/authorize`;
const CHUTES_TOKEN_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/token`;
const CHUTES_USERINFO_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/userinfo`;
const DEFAULT_EXPIRES_BUFFER_MS = 300 * 1e3;

//#endregion
//#region src/agents/auth-profiles/oauth.ts
const OAUTH_PROVIDER_IDS = new Set(getOAuthProviders().map((provider) => provider.id));

//#endregion
//#region src/agents/cloudflare-ai-gateway.ts
const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID = "claude-sonnet-4-5";
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF = `${CLOUDFLARE_AI_GATEWAY_PROVIDER_ID}/${CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID}`;

//#endregion
//#region src/agents/synthetic-models.ts
const SYNTHETIC_DEFAULT_MODEL_ID = "hf:MiniMaxAI/MiniMax-M2.1";
const SYNTHETIC_DEFAULT_MODEL_REF = `synthetic/${SYNTHETIC_DEFAULT_MODEL_ID}`;

//#endregion
//#region src/agents/venice-models.ts
const VENICE_DEFAULT_MODEL_ID = "llama-3.3-70b";
const VENICE_DEFAULT_MODEL_REF = `venice/${VENICE_DEFAULT_MODEL_ID}`;

//#endregion
//#region src/agents/models-config.providers.ts
function normalizeGoogleModelId(id) {
	if (id === "gemini-3-pro") return "gemini-3-pro-preview";
	if (id === "gemini-3-flash") return "gemini-3-flash-preview";
	return id;
}

//#endregion
//#region src/agents/model-selection.ts
const ANTHROPIC_MODEL_ALIASES = {
	"opus-4.6": "claude-opus-4-6",
	"opus-4.5": "claude-opus-4-5",
	"sonnet-4.5": "claude-sonnet-4-5"
};
function normalizeProviderId(provider) {
	const normalized = provider.trim().toLowerCase();
	if (normalized === "z.ai" || normalized === "z-ai") return "zai";
	if (normalized === "opencode-zen") return "opencode";
	if (normalized === "qwen") return "qwen-portal";
	if (normalized === "kimi-code") return "kimi-coding";
	return normalized;
}
function normalizeAnthropicModelId(model) {
	const trimmed = model.trim();
	if (!trimmed) return trimmed;
	return ANTHROPIC_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
function normalizeProviderModelId(provider, model) {
	if (provider === "anthropic") return normalizeAnthropicModelId(model);
	if (provider === "google") return normalizeGoogleModelId(model);
	return model;
}
function parseModelRef(raw, defaultProvider) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const slash = trimmed.indexOf("/");
	if (slash === -1) {
		const provider = normalizeProviderId(defaultProvider);
		return {
			provider,
			model: normalizeProviderModelId(provider, trimmed)
		};
	}
	const provider = normalizeProviderId(trimmed.slice(0, slash).trim());
	const model = trimmed.slice(slash + 1).trim();
	if (!provider || !model) return null;
	return {
		provider,
		model: normalizeProviderModelId(provider, model)
	};
}

//#endregion
//#region src/config/agent-limits.ts
const DEFAULT_AGENT_MAX_CONCURRENT = 4;
const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;

//#endregion
//#region src/config/talk.ts
function readTalkApiKeyFromProfile(deps = {}) {
	const fsImpl = deps.fs ?? fs;
	const osImpl = deps.os ?? os;
	const pathImpl = deps.path ?? path;
	const home = osImpl.homedir();
	const candidates = [
		".profile",
		".zprofile",
		".zshrc",
		".bashrc"
	].map((name) => pathImpl.join(home, name));
	for (const candidate of candidates) {
		if (!fsImpl.existsSync(candidate)) continue;
		try {
			const value = fsImpl.readFileSync(candidate, "utf-8").match(/(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^\n"']+)["']?/)?.[1]?.trim();
			if (value) return value;
		} catch {}
	}
	return null;
}
function resolveTalkApiKey(env = process.env, deps = {}) {
	const envValue = (env.ELEVENLABS_API_KEY ?? "").trim();
	if (envValue) return envValue;
	return readTalkApiKeyFromProfile(deps);
}

//#endregion
//#region src/config/defaults.ts
let defaultWarnState = { warned: false };
const DEFAULT_MODEL_ALIASES = {
	opus: "anthropic/claude-opus-4-6",
	sonnet: "anthropic/claude-sonnet-4-5",
	gpt: "openai/gpt-5.2",
	"gpt-mini": "openai/gpt-5-mini",
	gemini: "google/gemini-3-pro-preview",
	"gemini-flash": "google/gemini-3-flash-preview"
};
const DEFAULT_MODEL_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const DEFAULT_MODEL_INPUT = ["text"];
const DEFAULT_MODEL_MAX_TOKENS = 8192;
function isPositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function resolveModelCost(raw) {
	return {
		input: typeof raw?.input === "number" ? raw.input : DEFAULT_MODEL_COST.input,
		output: typeof raw?.output === "number" ? raw.output : DEFAULT_MODEL_COST.output,
		cacheRead: typeof raw?.cacheRead === "number" ? raw.cacheRead : DEFAULT_MODEL_COST.cacheRead,
		cacheWrite: typeof raw?.cacheWrite === "number" ? raw.cacheWrite : DEFAULT_MODEL_COST.cacheWrite
	};
}
function resolveAnthropicDefaultAuthMode(cfg) {
	const profiles = cfg.auth?.profiles ?? {};
	const anthropicProfiles = Object.entries(profiles).filter(([, profile]) => profile?.provider === "anthropic");
	const order = cfg.auth?.order?.anthropic ?? [];
	for (const profileId of order) {
		const entry = profiles[profileId];
		if (!entry || entry.provider !== "anthropic") continue;
		if (entry.mode === "api_key") return "api_key";
		if (entry.mode === "oauth" || entry.mode === "token") return "oauth";
	}
	const hasApiKey = anthropicProfiles.some(([, profile]) => profile?.mode === "api_key");
	const hasOauth = anthropicProfiles.some(([, profile]) => profile?.mode === "oauth" || profile?.mode === "token");
	if (hasApiKey && !hasOauth) return "api_key";
	if (hasOauth && !hasApiKey) return "oauth";
	if (process.env.ANTHROPIC_OAUTH_TOKEN?.trim()) return "oauth";
	if (process.env.ANTHROPIC_API_KEY?.trim()) return "api_key";
	return null;
}
function resolvePrimaryModelRef(raw) {
	if (!raw || typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	return DEFAULT_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
function applyMessageDefaults(cfg) {
	const messages = cfg.messages;
	if (messages?.ackReactionScope !== void 0) return cfg;
	const nextMessages = messages ? { ...messages } : {};
	nextMessages.ackReactionScope = "group-mentions";
	return {
		...cfg,
		messages: nextMessages
	};
}
function applySessionDefaults(cfg, options = {}) {
	const session = cfg.session;
	if (!session || session.mainKey === void 0) return cfg;
	const trimmed = session.mainKey.trim();
	const warn = options.warn ?? console.warn;
	const warnState = options.warnState ?? defaultWarnState;
	const next = {
		...cfg,
		session: {
			...session,
			mainKey: "main"
		}
	};
	if (trimmed && trimmed !== "main" && !warnState.warned) {
		warnState.warned = true;
		warn("session.mainKey is ignored; main session is always \"main\".");
	}
	return next;
}
function applyTalkApiKey(config) {
	const resolved = resolveTalkApiKey();
	if (!resolved) return config;
	if (config.talk?.apiKey?.trim()) return config;
	return {
		...config,
		talk: {
			...config.talk,
			apiKey: resolved
		}
	};
}
function applyModelDefaults(cfg) {
	let mutated = false;
	let nextCfg = cfg;
	const providerConfig = nextCfg.models?.providers;
	if (providerConfig) {
		const nextProviders = { ...providerConfig };
		for (const [providerId, provider] of Object.entries(providerConfig)) {
			const models = provider.models;
			if (!Array.isArray(models) || models.length === 0) continue;
			let providerMutated = false;
			const nextModels = models.map((model) => {
				const raw = model;
				let modelMutated = false;
				const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : false;
				if (raw.reasoning !== reasoning) modelMutated = true;
				const input = raw.input ?? [...DEFAULT_MODEL_INPUT];
				if (raw.input === void 0) modelMutated = true;
				const cost = resolveModelCost(raw.cost);
				if (!raw.cost || raw.cost.input !== cost.input || raw.cost.output !== cost.output || raw.cost.cacheRead !== cost.cacheRead || raw.cost.cacheWrite !== cost.cacheWrite) modelMutated = true;
				const contextWindow = isPositiveNumber(raw.contextWindow) ? raw.contextWindow : DEFAULT_CONTEXT_TOKENS;
				if (raw.contextWindow !== contextWindow) modelMutated = true;
				const defaultMaxTokens = Math.min(DEFAULT_MODEL_MAX_TOKENS, contextWindow);
				const rawMaxTokens = isPositiveNumber(raw.maxTokens) ? raw.maxTokens : defaultMaxTokens;
				const maxTokens = Math.min(rawMaxTokens, contextWindow);
				if (raw.maxTokens !== maxTokens) modelMutated = true;
				if (!modelMutated) return model;
				providerMutated = true;
				return {
					...raw,
					reasoning,
					input,
					cost,
					contextWindow,
					maxTokens
				};
			});
			if (!providerMutated) continue;
			nextProviders[providerId] = {
				...provider,
				models: nextModels
			};
			mutated = true;
		}
		if (mutated) nextCfg = {
			...nextCfg,
			models: {
				...nextCfg.models,
				providers: nextProviders
			}
		};
	}
	const existingAgent = nextCfg.agents?.defaults;
	if (!existingAgent) return mutated ? nextCfg : cfg;
	const existingModels = existingAgent.models ?? {};
	if (Object.keys(existingModels).length === 0) return mutated ? nextCfg : cfg;
	const nextModels = { ...existingModels };
	for (const [alias, target] of Object.entries(DEFAULT_MODEL_ALIASES)) {
		const entry = nextModels[target];
		if (!entry) continue;
		if (entry.alias !== void 0) continue;
		nextModels[target] = {
			...entry,
			alias
		};
		mutated = true;
	}
	if (!mutated) return cfg;
	return {
		...nextCfg,
		agents: {
			...nextCfg.agents,
			defaults: {
				...existingAgent,
				models: nextModels
			}
		}
	};
}
function applyAgentDefaults(cfg) {
	const agents = cfg.agents;
	const defaults = agents?.defaults;
	const hasMax = typeof defaults?.maxConcurrent === "number" && Number.isFinite(defaults.maxConcurrent);
	const hasSubMax = typeof defaults?.subagents?.maxConcurrent === "number" && Number.isFinite(defaults.subagents.maxConcurrent);
	if (hasMax && hasSubMax) return cfg;
	let mutated = false;
	const nextDefaults = defaults ? { ...defaults } : {};
	if (!hasMax) {
		nextDefaults.maxConcurrent = DEFAULT_AGENT_MAX_CONCURRENT;
		mutated = true;
	}
	const nextSubagents = defaults?.subagents ? { ...defaults.subagents } : {};
	if (!hasSubMax) {
		nextSubagents.maxConcurrent = DEFAULT_SUBAGENT_MAX_CONCURRENT;
		mutated = true;
	}
	if (!mutated) return cfg;
	return {
		...cfg,
		agents: {
			...agents,
			defaults: {
				...nextDefaults,
				subagents: nextSubagents
			}
		}
	};
}
function applyLoggingDefaults(cfg) {
	const logging = cfg.logging;
	if (!logging) return cfg;
	if (logging.redactSensitive) return cfg;
	return {
		...cfg,
		logging: {
			...logging,
			redactSensitive: "tools"
		}
	};
}
function applyContextPruningDefaults(cfg) {
	const defaults = cfg.agents?.defaults;
	if (!defaults) return cfg;
	const authMode = resolveAnthropicDefaultAuthMode(cfg);
	if (!authMode) return cfg;
	let mutated = false;
	const nextDefaults = { ...defaults };
	const contextPruning = defaults.contextPruning ?? {};
	const heartbeat = defaults.heartbeat ?? {};
	if (defaults.contextPruning?.mode === void 0) {
		nextDefaults.contextPruning = {
			...contextPruning,
			mode: "cache-ttl",
			ttl: defaults.contextPruning?.ttl ?? "1h"
		};
		mutated = true;
	}
	if (defaults.heartbeat?.every === void 0) {
		nextDefaults.heartbeat = {
			...heartbeat,
			every: authMode === "oauth" ? "1h" : "30m"
		};
		mutated = true;
	}
	if (authMode === "api_key") {
		const nextModels = defaults.models ? { ...defaults.models } : {};
		let modelsMutated = false;
		for (const [key, entry] of Object.entries(nextModels)) {
			const parsed = parseModelRef(key, "anthropic");
			if (!parsed || parsed.provider !== "anthropic") continue;
			const current = entry ?? {};
			const params = current.params ?? {};
			if (typeof params.cacheRetention === "string") continue;
			nextModels[key] = {
				...current,
				params: {
					...params,
					cacheRetention: "short"
				}
			};
			modelsMutated = true;
		}
		const primary = resolvePrimaryModelRef(defaults.model?.primary ?? void 0);
		if (primary) {
			const parsedPrimary = parseModelRef(primary, "anthropic");
			if (parsedPrimary?.provider === "anthropic") {
				const key = `${parsedPrimary.provider}/${parsedPrimary.model}`;
				const current = nextModels[key] ?? {};
				const params = current.params ?? {};
				if (typeof params.cacheRetention !== "string") {
					nextModels[key] = {
						...current,
						params: {
							...params,
							cacheRetention: "short"
						}
					};
					modelsMutated = true;
				}
			}
		}
		if (modelsMutated) {
			nextDefaults.models = nextModels;
			mutated = true;
		}
	}
	if (!mutated) return cfg;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: nextDefaults
		}
	};
}
function applyCompactionDefaults(cfg) {
	const defaults = cfg.agents?.defaults;
	if (!defaults) return cfg;
	const compaction = defaults?.compaction;
	if (compaction?.mode) return cfg;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				compaction: {
					...compaction,
					mode: "safeguard"
				}
			}
		}
	};
}

//#endregion
//#region src/config/env-substitution.ts
/**
* Environment variable substitution for config values.
*
* Supports `${VAR_NAME}` syntax in string values, substituted at config load time.
* - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
* - Escape with `$${}` to output literal `${}`
* - Missing env vars throw `MissingEnvVarError` with context
*
* @example
* ```json5
* {
*   models: {
*     providers: {
*       "vercel-gateway": {
*         apiKey: "${VERCEL_GATEWAY_API_KEY}"
*       }
*     }
*   }
* }
* ```
*/
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
var MissingEnvVarError = class extends Error {
	constructor(varName, configPath) {
		super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
		this.varName = varName;
		this.configPath = configPath;
		this.name = "MissingEnvVarError";
	}
};
function substituteString(value, env, configPath) {
	if (!value.includes("$")) return value;
	const chunks = [];
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if (char !== "$") {
			chunks.push(char);
			continue;
		}
		const next = value[i + 1];
		const afterNext = value[i + 2];
		if (next === "$" && afterNext === "{") {
			const start = i + 3;
			const end = value.indexOf("}", start);
			if (end !== -1) {
				const name = value.slice(start, end);
				if (ENV_VAR_NAME_PATTERN.test(name)) {
					chunks.push(`\${${name}}`);
					i = end;
					continue;
				}
			}
		}
		if (next === "{") {
			const start = i + 2;
			const end = value.indexOf("}", start);
			if (end !== -1) {
				const name = value.slice(start, end);
				if (ENV_VAR_NAME_PATTERN.test(name)) {
					const envValue = env[name];
					if (envValue === void 0 || envValue === "") throw new MissingEnvVarError(name, configPath);
					chunks.push(envValue);
					i = end;
					continue;
				}
			}
		}
		chunks.push(char);
	}
	return chunks.join("");
}
function substituteAny(value, env, path) {
	if (typeof value === "string") return substituteString(value, env, path);
	if (Array.isArray(value)) return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`));
	if (isPlainObject(value)) {
		const result = {};
		for (const [key, val] of Object.entries(value)) result[key] = substituteAny(val, env, path ? `${path}.${key}` : key);
		return result;
	}
	return value;
}
/**
* Resolves `${VAR_NAME}` environment variable references in config values.
*
* @param obj - The parsed config object (after JSON5 parse and $include resolution)
* @param env - Environment variables to use for substitution (defaults to process.env)
* @returns The config object with env vars substituted
* @throws {MissingEnvVarError} If a referenced env var is not set or empty
*/
function resolveConfigEnvVars(obj, env = process.env) {
	return substituteAny(obj, env, "");
}

//#endregion
//#region src/config/env-vars.ts
function collectConfigEnvVars(cfg) {
	const envConfig = cfg?.env;
	if (!envConfig) return {};
	const entries = {};
	if (envConfig.vars) for (const [key, value] of Object.entries(envConfig.vars)) {
		if (!value) continue;
		entries[key] = value;
	}
	for (const [key, value] of Object.entries(envConfig)) {
		if (key === "shellEnv" || key === "vars") continue;
		if (typeof value !== "string" || !value.trim()) continue;
		entries[key] = value;
	}
	return entries;
}

//#endregion
//#region src/config/includes.ts
/**
* Config includes: $include directive for modular configs
*
* @example
* ```json5
* {
*   "$include": "./base.json5",           // single file
*   "$include": ["./a.json5", "./b.json5"] // merge multiple
* }
* ```
*/
const INCLUDE_KEY = "$include";
const MAX_INCLUDE_DEPTH = 10;
var ConfigIncludeError = class extends Error {
	constructor(message, includePath, cause) {
		super(message);
		this.includePath = includePath;
		this.cause = cause;
		this.name = "ConfigIncludeError";
	}
};
var CircularIncludeError = class extends ConfigIncludeError {
	constructor(chain) {
		super(`Circular include detected: ${chain.join(" -> ")}`, chain[chain.length - 1]);
		this.chain = chain;
		this.name = "CircularIncludeError";
	}
};
/** Deep merge: arrays concatenate, objects merge recursively, primitives: source wins */
function deepMerge(target, source) {
	if (Array.isArray(target) && Array.isArray(source)) return [...target, ...source];
	if (isPlainObject(target) && isPlainObject(source)) {
		const result = { ...target };
		for (const key of Object.keys(source)) result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
		return result;
	}
	return source;
}
var IncludeProcessor = class IncludeProcessor {
	constructor(basePath, resolver) {
		this.basePath = basePath;
		this.resolver = resolver;
		this.visited = /* @__PURE__ */ new Set();
		this.depth = 0;
		this.visited.add(path.normalize(basePath));
	}
	process(obj) {
		if (Array.isArray(obj)) return obj.map((item) => this.process(item));
		if (!isPlainObject(obj)) return obj;
		if (!(INCLUDE_KEY in obj)) return this.processObject(obj);
		return this.processInclude(obj);
	}
	processObject(obj) {
		const result = {};
		for (const [key, value] of Object.entries(obj)) result[key] = this.process(value);
		return result;
	}
	processInclude(obj) {
		const includeValue = obj[INCLUDE_KEY];
		const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
		const included = this.resolveInclude(includeValue);
		if (otherKeys.length === 0) return included;
		if (!isPlainObject(included)) throw new ConfigIncludeError("Sibling keys require included content to be an object", typeof includeValue === "string" ? includeValue : INCLUDE_KEY);
		const rest = {};
		for (const key of otherKeys) rest[key] = this.process(obj[key]);
		return deepMerge(included, rest);
	}
	resolveInclude(value) {
		if (typeof value === "string") return this.loadFile(value);
		if (Array.isArray(value)) return value.reduce((merged, item) => {
			if (typeof item !== "string") throw new ConfigIncludeError(`Invalid $include array item: expected string, got ${typeof item}`, String(item));
			return deepMerge(merged, this.loadFile(item));
		}, {});
		throw new ConfigIncludeError(`Invalid $include value: expected string or array of strings, got ${typeof value}`, String(value));
	}
	loadFile(includePath) {
		const resolvedPath = this.resolvePath(includePath);
		this.checkCircular(resolvedPath);
		this.checkDepth(includePath);
		const raw = this.readFile(includePath, resolvedPath);
		const parsed = this.parseFile(includePath, resolvedPath, raw);
		return this.processNested(resolvedPath, parsed);
	}
	resolvePath(includePath) {
		const resolved = path.isAbsolute(includePath) ? includePath : path.resolve(path.dirname(this.basePath), includePath);
		return path.normalize(resolved);
	}
	checkCircular(resolvedPath) {
		if (this.visited.has(resolvedPath)) throw new CircularIncludeError([...this.visited, resolvedPath]);
	}
	checkDepth(includePath) {
		if (this.depth >= MAX_INCLUDE_DEPTH) throw new ConfigIncludeError(`Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ${includePath}`, includePath);
	}
	readFile(includePath, resolvedPath) {
		try {
			return this.resolver.readFile(resolvedPath);
		} catch (err) {
			throw new ConfigIncludeError(`Failed to read include file: ${includePath} (resolved: ${resolvedPath})`, includePath, err instanceof Error ? err : void 0);
		}
	}
	parseFile(includePath, resolvedPath, raw) {
		try {
			return this.resolver.parseJson(raw);
		} catch (err) {
			throw new ConfigIncludeError(`Failed to parse include file: ${includePath} (resolved: ${resolvedPath})`, includePath, err instanceof Error ? err : void 0);
		}
	}
	processNested(resolvedPath, parsed) {
		const nested = new IncludeProcessor(resolvedPath, this.resolver);
		nested.visited = new Set([...this.visited, resolvedPath]);
		nested.depth = this.depth + 1;
		return nested.process(parsed);
	}
};
const defaultResolver = {
	readFile: (p) => fs.readFileSync(p, "utf-8"),
	parseJson: (raw) => JSON5.parse(raw)
};
/**
* Resolves all $include directives in a parsed config object.
*/
function resolveConfigIncludes(obj, configPath, resolver = defaultResolver) {
	return new IncludeProcessor(configPath, resolver).process(obj);
}

//#endregion
//#region src/config/legacy.shared.ts
const getRecord = (value) => isRecord(value) ? value : null;
const ensureRecord = (root, key) => {
	const existing = root[key];
	if (isRecord(existing)) return existing;
	const next = {};
	root[key] = next;
	return next;
};
const mergeMissing = (target, source) => {
	for (const [key, value] of Object.entries(source)) {
		if (value === void 0) continue;
		const existing = target[key];
		if (existing === void 0) {
			target[key] = value;
			continue;
		}
		if (isRecord(existing) && isRecord(value)) mergeMissing(existing, value);
	}
};
const AUDIO_TRANSCRIPTION_CLI_ALLOWLIST = new Set(["whisper"]);
const mapLegacyAudioTranscription = (value) => {
	const transcriber = getRecord(value);
	const command = Array.isArray(transcriber?.command) ? transcriber?.command : null;
	if (!command || command.length === 0) return null;
	const rawExecutable = String(command[0] ?? "").trim();
	if (!rawExecutable) return null;
	const executableName = rawExecutable.split(/[\\/]/).pop() ?? rawExecutable;
	if (!AUDIO_TRANSCRIPTION_CLI_ALLOWLIST.has(executableName)) return null;
	const args = command.slice(1).map((part) => String(part));
	const timeoutSeconds = typeof transcriber?.timeoutSeconds === "number" ? transcriber?.timeoutSeconds : void 0;
	const result = {
		command: rawExecutable,
		type: "cli"
	};
	if (args.length > 0) result.args = args;
	if (timeoutSeconds !== void 0) result.timeoutSeconds = timeoutSeconds;
	return result;
};
const getAgentsList = (agents) => {
	const list = agents?.list;
	return Array.isArray(list) ? list : [];
};
const resolveDefaultAgentIdFromRaw = (raw) => {
	const list = getAgentsList(getRecord(raw.agents));
	const defaultEntry = list.find((entry) => isRecord(entry) && entry.default === true && typeof entry.id === "string" && entry.id.trim() !== "");
	if (defaultEntry) return defaultEntry.id.trim();
	const routing = getRecord(raw.routing);
	const routingDefault = typeof routing?.defaultAgentId === "string" ? routing.defaultAgentId.trim() : "";
	if (routingDefault) return routingDefault;
	const firstEntry = list.find((entry) => isRecord(entry) && typeof entry.id === "string" && entry.id.trim() !== "");
	if (firstEntry) return firstEntry.id.trim();
	return "main";
};
const ensureAgentEntry = (list, id) => {
	const normalized = id.trim();
	const existing = list.find((entry) => isRecord(entry) && typeof entry.id === "string" && entry.id.trim() === normalized);
	if (existing) return existing;
	const created = { id: normalized };
	list.push(created);
	return created;
};

//#endregion
//#region src/config/legacy.migrations.part-1.ts
const LEGACY_CONFIG_MIGRATIONS_PART_1 = [
	{
		id: "bindings.match.provider->bindings.match.channel",
		describe: "Move bindings[].match.provider to bindings[].match.channel",
		apply: (raw, changes) => {
			const bindings = Array.isArray(raw.bindings) ? raw.bindings : null;
			if (!bindings) return;
			let touched = false;
			for (const entry of bindings) {
				if (!isRecord(entry)) continue;
				const match = getRecord(entry.match);
				if (!match) continue;
				if (typeof match.channel === "string" && match.channel.trim()) continue;
				const provider = typeof match.provider === "string" ? match.provider.trim() : "";
				if (!provider) continue;
				match.channel = provider;
				delete match.provider;
				entry.match = match;
				touched = true;
			}
			if (touched) {
				raw.bindings = bindings;
				changes.push("Moved bindings[].match.provider → bindings[].match.channel.");
			}
		}
	},
	{
		id: "bindings.match.accountID->bindings.match.accountId",
		describe: "Move bindings[].match.accountID to bindings[].match.accountId",
		apply: (raw, changes) => {
			const bindings = Array.isArray(raw.bindings) ? raw.bindings : null;
			if (!bindings) return;
			let touched = false;
			for (const entry of bindings) {
				if (!isRecord(entry)) continue;
				const match = getRecord(entry.match);
				if (!match) continue;
				if (match.accountId !== void 0) continue;
				const accountID = typeof match.accountID === "string" ? match.accountID.trim() : match.accountID;
				if (!accountID) continue;
				match.accountId = accountID;
				delete match.accountID;
				entry.match = match;
				touched = true;
			}
			if (touched) {
				raw.bindings = bindings;
				changes.push("Moved bindings[].match.accountID → bindings[].match.accountId.");
			}
		}
	},
	{
		id: "session.sendPolicy.rules.match.provider->match.channel",
		describe: "Move session.sendPolicy.rules[].match.provider to match.channel",
		apply: (raw, changes) => {
			const session = getRecord(raw.session);
			if (!session) return;
			const sendPolicy = getRecord(session.sendPolicy);
			if (!sendPolicy) return;
			const rules = Array.isArray(sendPolicy.rules) ? sendPolicy.rules : null;
			if (!rules) return;
			let touched = false;
			for (const rule of rules) {
				if (!isRecord(rule)) continue;
				const match = getRecord(rule.match);
				if (!match) continue;
				if (typeof match.channel === "string" && match.channel.trim()) continue;
				const provider = typeof match.provider === "string" ? match.provider.trim() : "";
				if (!provider) continue;
				match.channel = provider;
				delete match.provider;
				rule.match = match;
				touched = true;
			}
			if (touched) {
				sendPolicy.rules = rules;
				session.sendPolicy = sendPolicy;
				raw.session = session;
				changes.push("Moved session.sendPolicy.rules[].match.provider → match.channel.");
			}
		}
	},
	{
		id: "messages.queue.byProvider->byChannel",
		describe: "Move messages.queue.byProvider to messages.queue.byChannel",
		apply: (raw, changes) => {
			const messages = getRecord(raw.messages);
			if (!messages) return;
			const queue = getRecord(messages.queue);
			if (!queue) return;
			if (queue.byProvider === void 0) return;
			if (queue.byChannel === void 0) {
				queue.byChannel = queue.byProvider;
				changes.push("Moved messages.queue.byProvider → messages.queue.byChannel.");
			} else changes.push("Removed messages.queue.byProvider (messages.queue.byChannel already set).");
			delete queue.byProvider;
			messages.queue = queue;
			raw.messages = messages;
		}
	},
	{
		id: "providers->channels",
		describe: "Move provider config sections to channels.*",
		apply: (raw, changes) => {
			const legacyEntries = [
				"whatsapp",
				"telegram",
				"discord",
				"slack",
				"signal",
				"imessage",
				"msteams"
			].filter((key) => isRecord(raw[key]));
			if (legacyEntries.length === 0) return;
			const channels = ensureRecord(raw, "channels");
			for (const key of legacyEntries) {
				const legacy = getRecord(raw[key]);
				if (!legacy) continue;
				const channelEntry = ensureRecord(channels, key);
				const hadEntries = Object.keys(channelEntry).length > 0;
				mergeMissing(channelEntry, legacy);
				channels[key] = channelEntry;
				delete raw[key];
				changes.push(hadEntries ? `Merged ${key} → channels.${key}.` : `Moved ${key} → channels.${key}.`);
			}
			raw.channels = channels;
		}
	},
	{
		id: "routing.allowFrom->channels.whatsapp.allowFrom",
		describe: "Move routing.allowFrom to channels.whatsapp.allowFrom",
		apply: (raw, changes) => {
			const routing = raw.routing;
			if (!routing || typeof routing !== "object") return;
			const allowFrom = routing.allowFrom;
			if (allowFrom === void 0) return;
			const channels = getRecord(raw.channels);
			const whatsapp = channels ? getRecord(channels.whatsapp) : null;
			if (!whatsapp) {
				delete routing.allowFrom;
				if (Object.keys(routing).length === 0) delete raw.routing;
				changes.push("Removed routing.allowFrom (channels.whatsapp not configured).");
				return;
			}
			if (whatsapp.allowFrom === void 0) {
				whatsapp.allowFrom = allowFrom;
				changes.push("Moved routing.allowFrom → channels.whatsapp.allowFrom.");
			} else changes.push("Removed routing.allowFrom (channels.whatsapp.allowFrom already set).");
			delete routing.allowFrom;
			if (Object.keys(routing).length === 0) delete raw.routing;
			channels.whatsapp = whatsapp;
			raw.channels = channels;
		}
	},
	{
		id: "routing.groupChat.requireMention->groups.*.requireMention",
		describe: "Move routing.groupChat.requireMention to channels.whatsapp/telegram/imessage groups",
		apply: (raw, changes) => {
			const routing = raw.routing;
			if (!routing || typeof routing !== "object") return;
			const groupChat = routing.groupChat && typeof routing.groupChat === "object" ? routing.groupChat : null;
			if (!groupChat) return;
			const requireMention = groupChat.requireMention;
			if (requireMention === void 0) return;
			const channels = ensureRecord(raw, "channels");
			const applyTo = (key, options) => {
				if (options?.requireExisting && !isRecord(channels[key])) return;
				const section = channels[key] && typeof channels[key] === "object" ? channels[key] : {};
				const groups = section.groups && typeof section.groups === "object" ? section.groups : {};
				const defaultKey = "*";
				const entry = groups[defaultKey] && typeof groups[defaultKey] === "object" ? groups[defaultKey] : {};
				if (entry.requireMention === void 0) {
					entry.requireMention = requireMention;
					groups[defaultKey] = entry;
					section.groups = groups;
					channels[key] = section;
					changes.push(`Moved routing.groupChat.requireMention → channels.${key}.groups."*".requireMention.`);
				} else changes.push(`Removed routing.groupChat.requireMention (channels.${key}.groups."*" already set).`);
			};
			applyTo("whatsapp", { requireExisting: true });
			applyTo("telegram");
			applyTo("imessage");
			delete groupChat.requireMention;
			if (Object.keys(groupChat).length === 0) delete routing.groupChat;
			if (Object.keys(routing).length === 0) delete raw.routing;
			raw.channels = channels;
		}
	},
	{
		id: "gateway.token->gateway.auth.token",
		describe: "Move gateway.token to gateway.auth.token",
		apply: (raw, changes) => {
			const gateway = raw.gateway;
			if (!gateway || typeof gateway !== "object") return;
			const token = gateway.token;
			if (token === void 0) return;
			const gatewayObj = gateway;
			const auth = gatewayObj.auth && typeof gatewayObj.auth === "object" ? gatewayObj.auth : {};
			if (auth.token === void 0) {
				auth.token = token;
				if (!auth.mode) auth.mode = "token";
				changes.push("Moved gateway.token → gateway.auth.token.");
			} else changes.push("Removed gateway.token (gateway.auth.token already set).");
			delete gatewayObj.token;
			if (Object.keys(auth).length > 0) gatewayObj.auth = auth;
			raw.gateway = gatewayObj;
		}
	},
	{
		id: "telegram.requireMention->channels.telegram.groups.*.requireMention",
		describe: "Move telegram.requireMention to channels.telegram.groups.*.requireMention",
		apply: (raw, changes) => {
			const channels = ensureRecord(raw, "channels");
			const telegram = channels.telegram;
			if (!telegram || typeof telegram !== "object") return;
			const requireMention = telegram.requireMention;
			if (requireMention === void 0) return;
			const groups = telegram.groups && typeof telegram.groups === "object" ? telegram.groups : {};
			const defaultKey = "*";
			const entry = groups[defaultKey] && typeof groups[defaultKey] === "object" ? groups[defaultKey] : {};
			if (entry.requireMention === void 0) {
				entry.requireMention = requireMention;
				groups[defaultKey] = entry;
				telegram.groups = groups;
				changes.push("Moved telegram.requireMention → channels.telegram.groups.\"*\".requireMention.");
			} else changes.push("Removed telegram.requireMention (channels.telegram.groups.\"*\" already set).");
			delete telegram.requireMention;
			channels.telegram = telegram;
			raw.channels = channels;
		}
	}
];

//#endregion
//#region src/config/legacy.migrations.part-2.ts
const LEGACY_CONFIG_MIGRATIONS_PART_2 = [
	{
		id: "agent.model-config-v2",
		describe: "Migrate legacy agent.model/allowedModels/modelAliases/modelFallbacks/imageModelFallbacks to agent.models + model lists",
		apply: (raw, changes) => {
			const agentRoot = getRecord(raw.agent);
			const defaults = getRecord(getRecord(raw.agents)?.defaults);
			const agent = agentRoot ?? defaults;
			if (!agent) return;
			const label = agentRoot ? "agent" : "agents.defaults";
			const legacyModel = typeof agent.model === "string" ? String(agent.model) : void 0;
			const legacyImageModel = typeof agent.imageModel === "string" ? String(agent.imageModel) : void 0;
			const legacyAllowed = Array.isArray(agent.allowedModels) ? agent.allowedModels.map(String) : [];
			const legacyModelFallbacks = Array.isArray(agent.modelFallbacks) ? agent.modelFallbacks.map(String) : [];
			const legacyImageModelFallbacks = Array.isArray(agent.imageModelFallbacks) ? agent.imageModelFallbacks.map(String) : [];
			const legacyAliases = agent.modelAliases && typeof agent.modelAliases === "object" ? agent.modelAliases : {};
			if (!(legacyModel || legacyImageModel || legacyAllowed.length > 0 || legacyModelFallbacks.length > 0 || legacyImageModelFallbacks.length > 0 || Object.keys(legacyAliases).length > 0)) return;
			const models = agent.models && typeof agent.models === "object" ? agent.models : {};
			const ensureModel = (rawKey) => {
				if (typeof rawKey !== "string") return;
				const key = rawKey.trim();
				if (!key) return;
				if (!models[key]) models[key] = {};
			};
			ensureModel(legacyModel);
			ensureModel(legacyImageModel);
			for (const key of legacyAllowed) ensureModel(key);
			for (const key of legacyModelFallbacks) ensureModel(key);
			for (const key of legacyImageModelFallbacks) ensureModel(key);
			for (const target of Object.values(legacyAliases)) {
				if (typeof target !== "string") continue;
				ensureModel(target);
			}
			for (const [alias, targetRaw] of Object.entries(legacyAliases)) {
				if (typeof targetRaw !== "string") continue;
				const target = targetRaw.trim();
				if (!target) continue;
				const entry = models[target] && typeof models[target] === "object" ? models[target] : {};
				if (!("alias" in entry)) {
					entry.alias = alias;
					models[target] = entry;
				}
			}
			const currentModel = agent.model && typeof agent.model === "object" ? agent.model : null;
			if (currentModel) {
				if (!currentModel.primary && legacyModel) currentModel.primary = legacyModel;
				if (legacyModelFallbacks.length > 0 && (!Array.isArray(currentModel.fallbacks) || currentModel.fallbacks.length === 0)) currentModel.fallbacks = legacyModelFallbacks;
				agent.model = currentModel;
			} else if (legacyModel || legacyModelFallbacks.length > 0) agent.model = {
				primary: legacyModel,
				fallbacks: legacyModelFallbacks.length ? legacyModelFallbacks : []
			};
			const currentImageModel = agent.imageModel && typeof agent.imageModel === "object" ? agent.imageModel : null;
			if (currentImageModel) {
				if (!currentImageModel.primary && legacyImageModel) currentImageModel.primary = legacyImageModel;
				if (legacyImageModelFallbacks.length > 0 && (!Array.isArray(currentImageModel.fallbacks) || currentImageModel.fallbacks.length === 0)) currentImageModel.fallbacks = legacyImageModelFallbacks;
				agent.imageModel = currentImageModel;
			} else if (legacyImageModel || legacyImageModelFallbacks.length > 0) agent.imageModel = {
				primary: legacyImageModel,
				fallbacks: legacyImageModelFallbacks.length ? legacyImageModelFallbacks : []
			};
			agent.models = models;
			if (legacyModel !== void 0) changes.push(`Migrated ${label}.model string → ${label}.model.primary.`);
			if (legacyModelFallbacks.length > 0) changes.push(`Migrated ${label}.modelFallbacks → ${label}.model.fallbacks.`);
			if (legacyImageModel !== void 0) changes.push(`Migrated ${label}.imageModel string → ${label}.imageModel.primary.`);
			if (legacyImageModelFallbacks.length > 0) changes.push(`Migrated ${label}.imageModelFallbacks → ${label}.imageModel.fallbacks.`);
			if (legacyAllowed.length > 0) changes.push(`Migrated ${label}.allowedModels → ${label}.models.`);
			if (Object.keys(legacyAliases).length > 0) changes.push(`Migrated ${label}.modelAliases → ${label}.models.*.alias.`);
			delete agent.allowedModels;
			delete agent.modelAliases;
			delete agent.modelFallbacks;
			delete agent.imageModelFallbacks;
		}
	},
	{
		id: "routing.agents-v2",
		describe: "Move routing.agents/defaultAgentId to agents.list",
		apply: (raw, changes) => {
			const routing = getRecord(raw.routing);
			if (!routing) return;
			const routingAgents = getRecord(routing.agents);
			const agents = ensureRecord(raw, "agents");
			const list = getAgentsList(agents);
			if (routingAgents) {
				for (const [rawId, entryRaw] of Object.entries(routingAgents)) {
					const agentId = String(rawId ?? "").trim();
					const entry = getRecord(entryRaw);
					if (!agentId || !entry) continue;
					const target = ensureAgentEntry(list, agentId);
					const entryCopy = { ...entry };
					if ("mentionPatterns" in entryCopy) {
						const mentionPatterns = entryCopy.mentionPatterns;
						const groupChat = ensureRecord(target, "groupChat");
						if (groupChat.mentionPatterns === void 0) {
							groupChat.mentionPatterns = mentionPatterns;
							changes.push(`Moved routing.agents.${agentId}.mentionPatterns → agents.list (id "${agentId}").groupChat.mentionPatterns.`);
						} else changes.push(`Removed routing.agents.${agentId}.mentionPatterns (agents.list groupChat mentionPatterns already set).`);
						delete entryCopy.mentionPatterns;
					}
					const legacyGroupChat = getRecord(entryCopy.groupChat);
					if (legacyGroupChat) {
						mergeMissing(ensureRecord(target, "groupChat"), legacyGroupChat);
						delete entryCopy.groupChat;
					}
					const legacySandbox = getRecord(entryCopy.sandbox);
					if (legacySandbox) {
						const sandboxTools = getRecord(legacySandbox.tools);
						if (sandboxTools) {
							mergeMissing(ensureRecord(ensureRecord(ensureRecord(target, "tools"), "sandbox"), "tools"), sandboxTools);
							delete legacySandbox.tools;
							changes.push(`Moved routing.agents.${agentId}.sandbox.tools → agents.list (id "${agentId}").tools.sandbox.tools.`);
						}
						entryCopy.sandbox = legacySandbox;
					}
					mergeMissing(target, entryCopy);
				}
				delete routing.agents;
				changes.push("Moved routing.agents → agents.list.");
			}
			const defaultAgentId = typeof routing.defaultAgentId === "string" ? routing.defaultAgentId.trim() : "";
			if (defaultAgentId) {
				if (!list.some((entry) => isRecord(entry) && entry.default === true)) {
					const entry = ensureAgentEntry(list, defaultAgentId);
					entry.default = true;
					changes.push(`Moved routing.defaultAgentId → agents.list (id "${defaultAgentId}").default.`);
				} else changes.push("Removed routing.defaultAgentId (agents.list default already set).");
				delete routing.defaultAgentId;
			}
			if (list.length > 0) agents.list = list;
			if (Object.keys(routing).length === 0) delete raw.routing;
		}
	},
	{
		id: "routing.config-v2",
		describe: "Move routing bindings/groupChat/queue/agentToAgent/transcribeAudio",
		apply: (raw, changes) => {
			const routing = getRecord(raw.routing);
			if (!routing) return;
			if (routing.bindings !== void 0) {
				if (raw.bindings === void 0) {
					raw.bindings = routing.bindings;
					changes.push("Moved routing.bindings → bindings.");
				} else changes.push("Removed routing.bindings (bindings already set).");
				delete routing.bindings;
			}
			if (routing.agentToAgent !== void 0) {
				const tools = ensureRecord(raw, "tools");
				if (tools.agentToAgent === void 0) {
					tools.agentToAgent = routing.agentToAgent;
					changes.push("Moved routing.agentToAgent → tools.agentToAgent.");
				} else changes.push("Removed routing.agentToAgent (tools.agentToAgent already set).");
				delete routing.agentToAgent;
			}
			if (routing.queue !== void 0) {
				const messages = ensureRecord(raw, "messages");
				if (messages.queue === void 0) {
					messages.queue = routing.queue;
					changes.push("Moved routing.queue → messages.queue.");
				} else changes.push("Removed routing.queue (messages.queue already set).");
				delete routing.queue;
			}
			const groupChat = getRecord(routing.groupChat);
			if (groupChat) {
				const historyLimit = groupChat.historyLimit;
				if (historyLimit !== void 0) {
					const messagesGroup = ensureRecord(ensureRecord(raw, "messages"), "groupChat");
					if (messagesGroup.historyLimit === void 0) {
						messagesGroup.historyLimit = historyLimit;
						changes.push("Moved routing.groupChat.historyLimit → messages.groupChat.historyLimit.");
					} else changes.push("Removed routing.groupChat.historyLimit (messages.groupChat.historyLimit already set).");
					delete groupChat.historyLimit;
				}
				const mentionPatterns = groupChat.mentionPatterns;
				if (mentionPatterns !== void 0) {
					const messagesGroup = ensureRecord(ensureRecord(raw, "messages"), "groupChat");
					if (messagesGroup.mentionPatterns === void 0) {
						messagesGroup.mentionPatterns = mentionPatterns;
						changes.push("Moved routing.groupChat.mentionPatterns → messages.groupChat.mentionPatterns.");
					} else changes.push("Removed routing.groupChat.mentionPatterns (messages.groupChat.mentionPatterns already set).");
					delete groupChat.mentionPatterns;
				}
				if (Object.keys(groupChat).length === 0) delete routing.groupChat;
				else routing.groupChat = groupChat;
			}
			if (routing.transcribeAudio !== void 0) {
				const mapped = mapLegacyAudioTranscription(routing.transcribeAudio);
				if (mapped) {
					const mediaAudio = ensureRecord(ensureRecord(ensureRecord(raw, "tools"), "media"), "audio");
					if ((Array.isArray(mediaAudio.models) ? mediaAudio.models : []).length === 0) {
						mediaAudio.enabled = true;
						mediaAudio.models = [mapped];
						changes.push("Moved routing.transcribeAudio → tools.media.audio.models.");
					} else changes.push("Removed routing.transcribeAudio (tools.media.audio.models already set).");
				} else changes.push("Removed routing.transcribeAudio (unsupported transcription CLI).");
				delete routing.transcribeAudio;
			}
			const audio = getRecord(raw.audio);
			if (audio?.transcription !== void 0) {
				const mapped = mapLegacyAudioTranscription(audio.transcription);
				if (mapped) {
					const mediaAudio = ensureRecord(ensureRecord(ensureRecord(raw, "tools"), "media"), "audio");
					if ((Array.isArray(mediaAudio.models) ? mediaAudio.models : []).length === 0) {
						mediaAudio.enabled = true;
						mediaAudio.models = [mapped];
						changes.push("Moved audio.transcription → tools.media.audio.models.");
					} else changes.push("Removed audio.transcription (tools.media.audio.models already set).");
					delete audio.transcription;
					if (Object.keys(audio).length === 0) delete raw.audio;
					else raw.audio = audio;
				} else {
					delete audio.transcription;
					changes.push("Removed audio.transcription (unsupported transcription CLI).");
					if (Object.keys(audio).length === 0) delete raw.audio;
					else raw.audio = audio;
				}
			}
			if (Object.keys(routing).length === 0) delete raw.routing;
		}
	}
];

//#endregion
//#region src/config/legacy.migrations.part-3.ts
const LEGACY_CONFIG_MIGRATIONS_PART_3 = [
	{
		id: "memorySearch->agents.defaults.memorySearch",
		describe: "Move top-level memorySearch to agents.defaults.memorySearch",
		apply: (raw, changes) => {
			const legacyMemorySearch = getRecord(raw.memorySearch);
			if (!legacyMemorySearch) return;
			const agents = ensureRecord(raw, "agents");
			const defaults = ensureRecord(agents, "defaults");
			const existing = getRecord(defaults.memorySearch);
			if (!existing) {
				defaults.memorySearch = legacyMemorySearch;
				changes.push("Moved memorySearch → agents.defaults.memorySearch.");
			} else {
				const merged = structuredClone(existing);
				mergeMissing(merged, legacyMemorySearch);
				defaults.memorySearch = merged;
				changes.push("Merged memorySearch → agents.defaults.memorySearch (filled missing fields from legacy; kept explicit agents.defaults values).");
			}
			agents.defaults = defaults;
			raw.agents = agents;
			delete raw.memorySearch;
		}
	},
	{
		id: "auth.anthropic-claude-cli-mode-oauth",
		describe: "Switch anthropic:claude-cli auth profile mode to oauth",
		apply: (raw, changes) => {
			const profiles = getRecord(getRecord(raw.auth)?.profiles);
			if (!profiles) return;
			const claudeCli = getRecord(profiles["anthropic:claude-cli"]);
			if (!claudeCli) return;
			if (claudeCli.mode !== "token") return;
			claudeCli.mode = "oauth";
			changes.push("Updated auth.profiles[\"anthropic:claude-cli\"].mode → \"oauth\".");
		}
	},
	{
		id: "tools.bash->tools.exec",
		describe: "Move tools.bash to tools.exec",
		apply: (raw, changes) => {
			const tools = ensureRecord(raw, "tools");
			const bash = getRecord(tools.bash);
			if (!bash) return;
			if (tools.exec === void 0) {
				tools.exec = bash;
				changes.push("Moved tools.bash → tools.exec.");
			} else changes.push("Removed tools.bash (tools.exec already set).");
			delete tools.bash;
		}
	},
	{
		id: "messages.tts.enabled->auto",
		describe: "Move messages.tts.enabled to messages.tts.auto",
		apply: (raw, changes) => {
			const tts = getRecord(getRecord(raw.messages)?.tts);
			if (!tts) return;
			if (tts.auto !== void 0) {
				if ("enabled" in tts) {
					delete tts.enabled;
					changes.push("Removed messages.tts.enabled (messages.tts.auto already set).");
				}
				return;
			}
			if (typeof tts.enabled !== "boolean") return;
			tts.auto = tts.enabled ? "always" : "off";
			delete tts.enabled;
			changes.push(`Moved messages.tts.enabled → messages.tts.auto (${String(tts.auto)}).`);
		}
	},
	{
		id: "agent.defaults-v2",
		describe: "Move agent config to agents.defaults and tools",
		apply: (raw, changes) => {
			const agent = getRecord(raw.agent);
			if (!agent) return;
			const agents = ensureRecord(raw, "agents");
			const defaults = getRecord(agents.defaults) ?? {};
			const tools = ensureRecord(raw, "tools");
			const agentTools = getRecord(agent.tools);
			if (agentTools) {
				if (tools.allow === void 0 && agentTools.allow !== void 0) {
					tools.allow = agentTools.allow;
					changes.push("Moved agent.tools.allow → tools.allow.");
				}
				if (tools.deny === void 0 && agentTools.deny !== void 0) {
					tools.deny = agentTools.deny;
					changes.push("Moved agent.tools.deny → tools.deny.");
				}
			}
			const elevated = getRecord(agent.elevated);
			if (elevated) if (tools.elevated === void 0) {
				tools.elevated = elevated;
				changes.push("Moved agent.elevated → tools.elevated.");
			} else changes.push("Removed agent.elevated (tools.elevated already set).");
			const bash = getRecord(agent.bash);
			if (bash) if (tools.exec === void 0) {
				tools.exec = bash;
				changes.push("Moved agent.bash → tools.exec.");
			} else changes.push("Removed agent.bash (tools.exec already set).");
			const sandbox = getRecord(agent.sandbox);
			if (sandbox) {
				const sandboxTools = getRecord(sandbox.tools);
				if (sandboxTools) {
					mergeMissing(ensureRecord(ensureRecord(tools, "sandbox"), "tools"), sandboxTools);
					delete sandbox.tools;
					changes.push("Moved agent.sandbox.tools → tools.sandbox.tools.");
				}
			}
			const subagents = getRecord(agent.subagents);
			if (subagents) {
				const subagentTools = getRecord(subagents.tools);
				if (subagentTools) {
					mergeMissing(ensureRecord(ensureRecord(tools, "subagents"), "tools"), subagentTools);
					delete subagents.tools;
					changes.push("Moved agent.subagents.tools → tools.subagents.tools.");
				}
			}
			const agentCopy = structuredClone(agent);
			delete agentCopy.tools;
			delete agentCopy.elevated;
			delete agentCopy.bash;
			if (isRecord(agentCopy.sandbox)) delete agentCopy.sandbox.tools;
			if (isRecord(agentCopy.subagents)) delete agentCopy.subagents.tools;
			mergeMissing(defaults, agentCopy);
			agents.defaults = defaults;
			raw.agents = agents;
			delete raw.agent;
			changes.push("Moved agent → agents.defaults.");
		}
	},
	{
		id: "identity->agents.list",
		describe: "Move identity to agents.list[].identity",
		apply: (raw, changes) => {
			const identity = getRecord(raw.identity);
			if (!identity) return;
			const agents = ensureRecord(raw, "agents");
			const list = getAgentsList(agents);
			const defaultId = resolveDefaultAgentIdFromRaw(raw);
			const entry = ensureAgentEntry(list, defaultId);
			if (entry.identity === void 0) {
				entry.identity = identity;
				changes.push(`Moved identity → agents.list (id "${defaultId}").identity.`);
			} else changes.push("Removed identity (agents.list identity already set).");
			agents.list = list;
			raw.agents = agents;
			delete raw.identity;
		}
	}
];

//#endregion
//#region src/config/legacy.migrations.ts
const LEGACY_CONFIG_MIGRATIONS = [
	...LEGACY_CONFIG_MIGRATIONS_PART_1,
	...LEGACY_CONFIG_MIGRATIONS_PART_2,
	...LEGACY_CONFIG_MIGRATIONS_PART_3
];

//#endregion
//#region src/config/legacy.rules.ts
const LEGACY_CONFIG_RULES = [
	{
		path: ["whatsapp"],
		message: "whatsapp config moved to channels.whatsapp (auto-migrated on load)."
	},
	{
		path: ["telegram"],
		message: "telegram config moved to channels.telegram (auto-migrated on load)."
	},
	{
		path: ["discord"],
		message: "discord config moved to channels.discord (auto-migrated on load)."
	},
	{
		path: ["slack"],
		message: "slack config moved to channels.slack (auto-migrated on load)."
	},
	{
		path: ["signal"],
		message: "signal config moved to channels.signal (auto-migrated on load)."
	},
	{
		path: ["imessage"],
		message: "imessage config moved to channels.imessage (auto-migrated on load)."
	},
	{
		path: ["msteams"],
		message: "msteams config moved to channels.msteams (auto-migrated on load)."
	},
	{
		path: ["routing", "allowFrom"],
		message: "routing.allowFrom was removed; use channels.whatsapp.allowFrom instead (auto-migrated on load)."
	},
	{
		path: ["routing", "bindings"],
		message: "routing.bindings was moved; use top-level bindings instead (auto-migrated on load)."
	},
	{
		path: ["routing", "agents"],
		message: "routing.agents was moved; use agents.list instead (auto-migrated on load)."
	},
	{
		path: ["routing", "defaultAgentId"],
		message: "routing.defaultAgentId was moved; use agents.list[].default instead (auto-migrated on load)."
	},
	{
		path: ["routing", "agentToAgent"],
		message: "routing.agentToAgent was moved; use tools.agentToAgent instead (auto-migrated on load)."
	},
	{
		path: [
			"routing",
			"groupChat",
			"requireMention"
		],
		message: "routing.groupChat.requireMention was removed; use channels.whatsapp/telegram/imessage groups defaults (e.g. channels.whatsapp.groups.\"*\".requireMention) instead (auto-migrated on load)."
	},
	{
		path: [
			"routing",
			"groupChat",
			"mentionPatterns"
		],
		message: "routing.groupChat.mentionPatterns was moved; use agents.list[].groupChat.mentionPatterns or messages.groupChat.mentionPatterns instead (auto-migrated on load)."
	},
	{
		path: ["routing", "queue"],
		message: "routing.queue was moved; use messages.queue instead (auto-migrated on load)."
	},
	{
		path: ["routing", "transcribeAudio"],
		message: "routing.transcribeAudio was moved; use tools.media.audio.models instead (auto-migrated on load)."
	},
	{
		path: ["telegram", "requireMention"],
		message: "telegram.requireMention was removed; use channels.telegram.groups.\"*\".requireMention instead (auto-migrated on load)."
	},
	{
		path: ["identity"],
		message: "identity was moved; use agents.list[].identity instead (auto-migrated on load)."
	},
	{
		path: ["agent"],
		message: "agent.* was moved; use agents.defaults (and tools.* for tool/elevated/exec settings) instead (auto-migrated on load)."
	},
	{
		path: ["memorySearch"],
		message: "top-level memorySearch was moved; use agents.defaults.memorySearch instead (auto-migrated on load)."
	},
	{
		path: ["tools", "bash"],
		message: "tools.bash was removed; use tools.exec instead (auto-migrated on load)."
	},
	{
		path: ["agent", "model"],
		message: "agent.model string was replaced by agents.defaults.model.primary/fallbacks and agents.defaults.models (auto-migrated on load).",
		match: (value) => typeof value === "string"
	},
	{
		path: ["agent", "imageModel"],
		message: "agent.imageModel string was replaced by agents.defaults.imageModel.primary/fallbacks (auto-migrated on load).",
		match: (value) => typeof value === "string"
	},
	{
		path: ["agent", "allowedModels"],
		message: "agent.allowedModels was replaced by agents.defaults.models (auto-migrated on load)."
	},
	{
		path: ["agent", "modelAliases"],
		message: "agent.modelAliases was replaced by agents.defaults.models.*.alias (auto-migrated on load)."
	},
	{
		path: ["agent", "modelFallbacks"],
		message: "agent.modelFallbacks was replaced by agents.defaults.model.fallbacks (auto-migrated on load)."
	},
	{
		path: ["agent", "imageModelFallbacks"],
		message: "agent.imageModelFallbacks was replaced by agents.defaults.imageModel.fallbacks (auto-migrated on load)."
	},
	{
		path: [
			"messages",
			"tts",
			"enabled"
		],
		message: "messages.tts.enabled was replaced by messages.tts.auto (auto-migrated on load)."
	},
	{
		path: ["gateway", "token"],
		message: "gateway.token is ignored; use gateway.auth.token instead (auto-migrated on load)."
	}
];

//#endregion
//#region src/config/legacy.ts
function findLegacyConfigIssues(raw) {
	if (!raw || typeof raw !== "object") return [];
	const root = raw;
	const issues = [];
	for (const rule of LEGACY_CONFIG_RULES) {
		let cursor = root;
		for (const key of rule.path) {
			if (!cursor || typeof cursor !== "object") {
				cursor = void 0;
				break;
			}
			cursor = cursor[key];
		}
		if (cursor !== void 0 && (!rule.match || rule.match(cursor, root))) issues.push({
			path: rule.path.join("."),
			message: rule.message
		});
	}
	return issues;
}

//#endregion
//#region src/config/normalize-paths.ts
const PATH_VALUE_RE = /^~(?=$|[\\/])/;
const PATH_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIST_KEYS = new Set(["paths", "pathPrepend"]);
function normalizeStringValue(key, value) {
	if (!PATH_VALUE_RE.test(value.trim())) return value;
	if (!key) return value;
	if (PATH_KEY_RE.test(key) || PATH_LIST_KEYS.has(key)) return resolveUserPath(value);
	return value;
}
function normalizeAny(key, value) {
	if (typeof value === "string") return normalizeStringValue(key, value);
	if (Array.isArray(value)) {
		const normalizeChildren = Boolean(key && PATH_LIST_KEYS.has(key));
		return value.map((entry) => {
			if (typeof entry === "string") return normalizeChildren ? normalizeStringValue(key, entry) : entry;
			if (Array.isArray(entry)) return normalizeAny(void 0, entry);
			if (isPlainObject(entry)) return normalizeAny(void 0, entry);
			return entry;
		});
	}
	if (!isPlainObject(value)) return value;
	for (const [childKey, childValue] of Object.entries(value)) {
		const next = normalizeAny(childKey, childValue);
		if (next !== childValue) value[childKey] = next;
	}
	return value;
}
/**
* Normalize "~" paths in path-ish config fields.
*
* Goal: accept `~/...` consistently across config file + env overrides, while
* keeping the surface area small and predictable.
*/
function normalizeConfigPaths(cfg) {
	if (!cfg || typeof cfg !== "object") return cfg;
	normalizeAny(void 0, cfg);
	return cfg;
}

//#endregion
//#region src/config/runtime-overrides.ts
let overrides = {};
function mergeOverrides(base, override) {
	if (!isPlainObject(base) || !isPlainObject(override)) return override;
	const next = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === void 0) continue;
		next[key] = mergeOverrides(base[key], value);
	}
	return next;
}
function applyConfigOverrides(cfg) {
	if (!overrides || Object.keys(overrides).length === 0) return cfg;
	return mergeOverrides(cfg, overrides);
}

//#endregion
//#region src/plugins/slots.ts
const DEFAULT_SLOT_BY_KEY = { memory: "memory-core" };
function defaultSlotIdForKey(slotKey) {
	return DEFAULT_SLOT_BY_KEY[slotKey];
}

//#endregion
//#region src/plugins/config-state.ts
const BUNDLED_ENABLED_BY_DEFAULT = new Set([
	"device-pair",
	"phone-control",
	"talk-voice"
]);
const normalizeList = (value) => {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
};
const normalizeSlotValue = (value) => {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (trimmed.toLowerCase() === "none") return null;
	return trimmed;
};
const normalizePluginEntries = (entries) => {
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {};
	const normalized = {};
	for (const [key, value] of Object.entries(entries)) {
		if (!key.trim()) continue;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			normalized[key] = {};
			continue;
		}
		const entry = value;
		normalized[key] = {
			enabled: typeof entry.enabled === "boolean" ? entry.enabled : void 0,
			config: "config" in entry ? entry.config : void 0
		};
	}
	return normalized;
};
const normalizePluginsConfig = (config) => {
	const memorySlot = normalizeSlotValue(config?.slots?.memory);
	return {
		enabled: config?.enabled !== false,
		allow: normalizeList(config?.allow),
		deny: normalizeList(config?.deny),
		loadPaths: normalizeList(config?.load?.paths),
		slots: { memory: memorySlot === void 0 ? defaultSlotIdForKey("memory") : memorySlot },
		entries: normalizePluginEntries(config?.entries)
	};
};
function resolveEnableState(id, origin, config) {
	if (!config.enabled) return {
		enabled: false,
		reason: "plugins disabled"
	};
	if (config.deny.includes(id)) return {
		enabled: false,
		reason: "blocked by denylist"
	};
	if (config.allow.length > 0 && !config.allow.includes(id)) return {
		enabled: false,
		reason: "not in allowlist"
	};
	if (config.slots.memory === id) return { enabled: true };
	const entry = config.entries[id];
	if (entry?.enabled === true) return { enabled: true };
	if (entry?.enabled === false) return {
		enabled: false,
		reason: "disabled in config"
	};
	if (origin === "bundled" && BUNDLED_ENABLED_BY_DEFAULT.has(id)) return { enabled: true };
	if (origin === "bundled") return {
		enabled: false,
		reason: "bundled (disabled by default)"
	};
	return { enabled: true };
}
function resolveMemorySlotDecision(params) {
	if (params.kind !== "memory") return { enabled: true };
	if (params.slot === null) return {
		enabled: false,
		reason: "memory slot disabled"
	};
	if (typeof params.slot === "string") {
		if (params.slot === params.id) return {
			enabled: true,
			selected: true
		};
		return {
			enabled: false,
			reason: `memory slot set to "${params.slot}"`
		};
	}
	if (params.selectedId && params.selectedId !== params.id) return {
		enabled: false,
		reason: `memory slot already filled by "${params.selectedId}"`
	};
	return {
		enabled: true,
		selected: true
	};
}

//#endregion
//#region src/plugins/bundled-dir.ts
function resolveBundledPluginsDir() {
	const override = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
	if (override) return override;
	try {
		const execDir = path.dirname(process.execPath);
		const sibling = path.join(execDir, "extensions");
		if (fs.existsSync(sibling)) return sibling;
	} catch {}
	try {
		let cursor = path.dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 6; i += 1) {
			const candidate = path.join(cursor, "extensions");
			if (fs.existsSync(candidate)) return candidate;
			const parent = path.dirname(cursor);
			if (parent === cursor) break;
			cursor = parent;
		}
	} catch {}
}

//#endregion
//#region src/compat/legacy-names.ts
const PROJECT_NAME = "openclaw";
const MANIFEST_KEY = PROJECT_NAME;

//#endregion
//#region src/plugins/manifest.ts
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME];
function normalizeStringList(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function resolvePluginManifestPath(rootDir) {
	for (const filename of PLUGIN_MANIFEST_FILENAMES) {
		const candidate = path.join(rootDir, filename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}
function loadPluginManifest(rootDir) {
	const manifestPath = resolvePluginManifestPath(rootDir);
	if (!fs.existsSync(manifestPath)) return {
		ok: false,
		error: `plugin manifest not found: ${manifestPath}`,
		manifestPath
	};
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch (err) {
		return {
			ok: false,
			error: `failed to parse plugin manifest: ${String(err)}`,
			manifestPath
		};
	}
	if (!isRecord(raw)) return {
		ok: false,
		error: "plugin manifest must be an object",
		manifestPath
	};
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) return {
		ok: false,
		error: "plugin manifest requires id",
		manifestPath
	};
	const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
	if (!configSchema) return {
		ok: false,
		error: "plugin manifest requires configSchema",
		manifestPath
	};
	const kind = typeof raw.kind === "string" ? raw.kind : void 0;
	const name = typeof raw.name === "string" ? raw.name.trim() : void 0;
	const description = typeof raw.description === "string" ? raw.description.trim() : void 0;
	const version = typeof raw.version === "string" ? raw.version.trim() : void 0;
	const channels = normalizeStringList(raw.channels);
	const providers = normalizeStringList(raw.providers);
	const skills = normalizeStringList(raw.skills);
	let uiHints;
	if (isRecord(raw.uiHints)) uiHints = raw.uiHints;
	return {
		ok: true,
		manifest: {
			id,
			configSchema,
			kind,
			channels,
			providers,
			skills,
			name,
			description,
			version,
			uiHints
		},
		manifestPath
	};
}
function getPackageManifestMetadata(manifest) {
	if (!manifest) return;
	return manifest[MANIFEST_KEY];
}

//#endregion
//#region src/plugins/discovery.ts
const EXTENSION_EXTS = new Set([
	".ts",
	".js",
	".mts",
	".cts",
	".mjs",
	".cjs"
]);
function isExtensionFile(filePath) {
	const ext = path.extname(filePath);
	if (!EXTENSION_EXTS.has(ext)) return false;
	return !filePath.endsWith(".d.ts");
}
function readPackageManifest(dir) {
	const manifestPath = path.join(dir, "package.json");
	if (!fs.existsSync(manifestPath)) return null;
	try {
		const raw = fs.readFileSync(manifestPath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
function resolvePackageExtensions(manifest) {
	const raw = getPackageManifestMetadata(manifest)?.extensions;
	if (!Array.isArray(raw)) return [];
	return raw.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function deriveIdHint(params) {
	const base = path.basename(params.filePath, path.extname(params.filePath));
	const rawPackageName = params.packageName?.trim();
	if (!rawPackageName) return base;
	const unscoped = rawPackageName.includes("/") ? rawPackageName.split("/").pop() ?? rawPackageName : rawPackageName;
	if (!params.hasMultipleExtensions) return unscoped;
	return `${unscoped}/${base}`;
}
function addCandidate(params) {
	const resolved = path.resolve(params.source);
	if (params.seen.has(resolved)) return;
	params.seen.add(resolved);
	const manifest = params.manifest ?? null;
	params.candidates.push({
		idHint: params.idHint,
		source: resolved,
		rootDir: path.resolve(params.rootDir),
		origin: params.origin,
		workspaceDir: params.workspaceDir,
		packageName: manifest?.name?.trim() || void 0,
		packageVersion: manifest?.version?.trim() || void 0,
		packageDescription: manifest?.description?.trim() || void 0,
		packageDir: params.packageDir,
		packageManifest: getPackageManifestMetadata(manifest ?? void 0)
	});
}
function discoverInDirectory(params) {
	if (!fs.existsSync(params.dir)) return;
	let entries = [];
	try {
		entries = fs.readdirSync(params.dir, { withFileTypes: true });
	} catch (err) {
		params.diagnostics.push({
			level: "warn",
			message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
			source: params.dir
		});
		return;
	}
	for (const entry of entries) {
		const fullPath = path.join(params.dir, entry.name);
		if (entry.isFile()) {
			if (!isExtensionFile(fullPath)) continue;
			addCandidate({
				candidates: params.candidates,
				seen: params.seen,
				idHint: path.basename(entry.name, path.extname(entry.name)),
				source: fullPath,
				rootDir: path.dirname(fullPath),
				origin: params.origin,
				workspaceDir: params.workspaceDir
			});
		}
		if (!entry.isDirectory()) continue;
		const manifest = readPackageManifest(fullPath);
		const extensions = manifest ? resolvePackageExtensions(manifest) : [];
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const resolved = path.resolve(fullPath, extPath);
				addCandidate({
					candidates: params.candidates,
					seen: params.seen,
					idHint: deriveIdHint({
						filePath: resolved,
						packageName: manifest?.name,
						hasMultipleExtensions: extensions.length > 1
					}),
					source: resolved,
					rootDir: fullPath,
					origin: params.origin,
					workspaceDir: params.workspaceDir,
					manifest,
					packageDir: fullPath
				});
			}
			continue;
		}
		const indexFile = [
			"index.ts",
			"index.js",
			"index.mjs",
			"index.cjs"
		].map((candidate) => path.join(fullPath, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) addCandidate({
			candidates: params.candidates,
			seen: params.seen,
			idHint: entry.name,
			source: indexFile,
			rootDir: fullPath,
			origin: params.origin,
			workspaceDir: params.workspaceDir,
			manifest,
			packageDir: fullPath
		});
	}
}
function discoverFromPath(params) {
	const resolved = resolveUserPath(params.rawPath);
	if (!fs.existsSync(resolved)) {
		params.diagnostics.push({
			level: "error",
			message: `plugin path not found: ${resolved}`,
			source: resolved
		});
		return;
	}
	const stat = fs.statSync(resolved);
	if (stat.isFile()) {
		if (!isExtensionFile(resolved)) {
			params.diagnostics.push({
				level: "error",
				message: `plugin path is not a supported file: ${resolved}`,
				source: resolved
			});
			return;
		}
		addCandidate({
			candidates: params.candidates,
			seen: params.seen,
			idHint: path.basename(resolved, path.extname(resolved)),
			source: resolved,
			rootDir: path.dirname(resolved),
			origin: params.origin,
			workspaceDir: params.workspaceDir
		});
		return;
	}
	if (stat.isDirectory()) {
		const manifest = readPackageManifest(resolved);
		const extensions = manifest ? resolvePackageExtensions(manifest) : [];
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const source = path.resolve(resolved, extPath);
				addCandidate({
					candidates: params.candidates,
					seen: params.seen,
					idHint: deriveIdHint({
						filePath: source,
						packageName: manifest?.name,
						hasMultipleExtensions: extensions.length > 1
					}),
					source,
					rootDir: resolved,
					origin: params.origin,
					workspaceDir: params.workspaceDir,
					manifest,
					packageDir: resolved
				});
			}
			return;
		}
		const indexFile = [
			"index.ts",
			"index.js",
			"index.mjs",
			"index.cjs"
		].map((candidate) => path.join(resolved, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				seen: params.seen,
				idHint: path.basename(resolved),
				source: indexFile,
				rootDir: resolved,
				origin: params.origin,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: resolved
			});
			return;
		}
		discoverInDirectory({
			dir: resolved,
			origin: params.origin,
			workspaceDir: params.workspaceDir,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen
		});
		return;
	}
}
function discoverOpenClawPlugins(params) {
	const candidates = [];
	const diagnostics = [];
	const seen = /* @__PURE__ */ new Set();
	const workspaceDir = params.workspaceDir?.trim();
	const extra = params.extraPaths ?? [];
	for (const extraPath of extra) {
		if (typeof extraPath !== "string") continue;
		const trimmed = extraPath.trim();
		if (!trimmed) continue;
		discoverFromPath({
			rawPath: trimmed,
			origin: "config",
			workspaceDir: workspaceDir?.trim() || void 0,
			candidates,
			diagnostics,
			seen
		});
	}
	if (workspaceDir) {
		const workspaceRoot = resolveUserPath(workspaceDir);
		const workspaceExtDirs = [path.join(workspaceRoot, ".openclaw", "extensions")];
		for (const dir of workspaceExtDirs) discoverInDirectory({
			dir,
			origin: "workspace",
			workspaceDir: workspaceRoot,
			candidates,
			diagnostics,
			seen
		});
	}
	discoverInDirectory({
		dir: path.join(resolveConfigDir(), "extensions"),
		origin: "global",
		candidates,
		diagnostics,
		seen
	});
	const bundledDir = resolveBundledPluginsDir();
	if (bundledDir) discoverInDirectory({
		dir: bundledDir,
		origin: "bundled",
		candidates,
		diagnostics,
		seen
	});
	return {
		candidates,
		diagnostics
	};
}

//#endregion
//#region src/plugins/manifest-registry.ts
const registryCache = /* @__PURE__ */ new Map();
const DEFAULT_MANIFEST_CACHE_MS = 200;
function resolveManifestCacheMs(env) {
	const raw = env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS?.trim();
	if (raw === "" || raw === "0") return 0;
	if (!raw) return DEFAULT_MANIFEST_CACHE_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_MANIFEST_CACHE_MS;
	return Math.max(0, parsed);
}
function shouldUseManifestCache(env) {
	if (env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim()) return false;
	return resolveManifestCacheMs(env) > 0;
}
function buildCacheKey(params) {
	return `${params.workspaceDir ? resolveUserPath(params.workspaceDir) : ""}::${JSON.stringify(params.plugins)}`;
}
function safeStatMtimeMs(filePath) {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}
}
function normalizeManifestLabel(raw) {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : void 0;
}
function buildRecord(params) {
	return {
		id: params.manifest.id,
		name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.packageName,
		description: normalizeManifestLabel(params.manifest.description) ?? params.candidate.packageDescription,
		version: normalizeManifestLabel(params.manifest.version) ?? params.candidate.packageVersion,
		kind: params.manifest.kind,
		channels: params.manifest.channels ?? [],
		providers: params.manifest.providers ?? [],
		skills: params.manifest.skills ?? [],
		origin: params.candidate.origin,
		workspaceDir: params.candidate.workspaceDir,
		rootDir: params.candidate.rootDir,
		source: params.candidate.source,
		manifestPath: params.manifestPath,
		schemaCacheKey: params.schemaCacheKey,
		configSchema: params.configSchema,
		configUiHints: params.manifest.uiHints
	};
}
function loadPluginManifestRegistry(params) {
	const normalized = normalizePluginsConfig((params.config ?? {}).plugins);
	const cacheKey = buildCacheKey({
		workspaceDir: params.workspaceDir,
		plugins: normalized
	});
	const env = params.env ?? process.env;
	const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
	if (cacheEnabled) {
		const cached = registryCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) return cached.registry;
	}
	const discovery = params.candidates ? {
		candidates: params.candidates,
		diagnostics: params.diagnostics ?? []
	} : discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		extraPaths: normalized.loadPaths
	});
	const diagnostics = [...discovery.diagnostics];
	const candidates = discovery.candidates;
	const records = [];
	const seenIds = /* @__PURE__ */ new Set();
	for (const candidate of candidates) {
		const manifestRes = loadPluginManifest(candidate.rootDir);
		if (!manifestRes.ok) {
			diagnostics.push({
				level: "error",
				message: manifestRes.error,
				source: manifestRes.manifestPath
			});
			continue;
		}
		const manifest = manifestRes.manifest;
		if (candidate.idHint && candidate.idHint !== manifest.id) diagnostics.push({
			level: "warn",
			pluginId: manifest.id,
			source: candidate.source,
			message: `plugin id mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`
		});
		if (seenIds.has(manifest.id)) diagnostics.push({
			level: "warn",
			pluginId: manifest.id,
			source: candidate.source,
			message: `duplicate plugin id detected; later plugin may be overridden (${candidate.source})`
		});
		else seenIds.add(manifest.id);
		const configSchema = manifest.configSchema;
		const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
		const schemaCacheKey = manifestMtime ? `${manifestRes.manifestPath}:${manifestMtime}` : manifestRes.manifestPath;
		records.push(buildRecord({
			manifest,
			candidate,
			manifestPath: manifestRes.manifestPath,
			schemaCacheKey,
			configSchema
		}));
	}
	const registry = {
		plugins: records,
		diagnostics
	};
	if (cacheEnabled) {
		const ttl = resolveManifestCacheMs(env);
		if (ttl > 0) registryCache.set(cacheKey, {
			expiresAt: Date.now() + ttl,
			registry
		});
	}
	return registry;
}

//#endregion
//#region src/plugins/schema-validator.ts
const ajv$1 = new AjvPkg({
	allErrors: true,
	strict: false,
	removeAdditional: false
});
const schemaCache = /* @__PURE__ */ new Map();
function formatAjvErrors(errors) {
	if (!errors || errors.length === 0) return ["invalid config"];
	return errors.map((error) => {
		return `${error.instancePath?.replace(/^\//, "").replace(/\//g, ".") || "<root>"}: ${error.message ?? "invalid"}`;
	});
}
function validateJsonSchemaValue(params) {
	let cached = schemaCache.get(params.cacheKey);
	if (!cached || cached.schema !== params.schema) {
		cached = {
			validate: ajv$1.compile(params.schema),
			schema: params.schema
		};
		schemaCache.set(params.cacheKey, cached);
	}
	if (cached.validate(params.value)) return { ok: true };
	return {
		ok: false,
		errors: formatAjvErrors(cached.validate.errors)
	};
}

//#endregion
//#region src/cli/parse-duration.ts
function parseDurationMs(raw, opts) {
	const trimmed = String(raw ?? "").trim().toLowerCase();
	if (!trimmed) throw new Error("invalid duration (empty)");
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);
	if (!m) throw new Error(`invalid duration: ${raw}`);
	const value = Number(m[1]);
	if (!Number.isFinite(value) || value < 0) throw new Error(`invalid duration: ${raw}`);
	const unit = m[2] ?? opts?.defaultUnit ?? "ms";
	const multiplier = unit === "ms" ? 1 : unit === "s" ? 1e3 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5;
	const ms = Math.round(value * multiplier);
	if (!Number.isFinite(ms)) throw new Error(`invalid duration: ${raw}`);
	return ms;
}

//#endregion
//#region src/infra/exec-safety.ts
const SHELL_METACHARS = /[;&|`$<>]/;
const CONTROL_CHARS = /[\r\n]/;
const QUOTE_CHARS = /["']/;
const BARE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/;
function isLikelyPath(value) {
	if (value.startsWith(".") || value.startsWith("~")) return true;
	if (value.includes("/") || value.includes("\\")) return true;
	return /^[A-Za-z]:[\\/]/.test(value);
}
function isSafeExecutableValue(value) {
	if (!value) return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed.includes("\0")) return false;
	if (CONTROL_CHARS.test(trimmed)) return false;
	if (SHELL_METACHARS.test(trimmed)) return false;
	if (QUOTE_CHARS.test(trimmed)) return false;
	if (isLikelyPath(trimmed)) return true;
	if (trimmed.startsWith("-")) return false;
	return BARE_NAME_PATTERN.test(trimmed);
}

//#endregion
//#region src/config/zod-schema.core.ts
const ModelApiSchema = z.union([
	z.literal("openai-completions"),
	z.literal("openai-responses"),
	z.literal("anthropic-messages"),
	z.literal("google-generative-ai"),
	z.literal("github-copilot"),
	z.literal("bedrock-converse-stream")
]);
const ModelCompatSchema = z.object({
	supportsStore: z.boolean().optional(),
	supportsDeveloperRole: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
	maxTokensField: z.union([z.literal("max_completion_tokens"), z.literal("max_tokens")]).optional()
}).strict().optional();
const ModelDefinitionSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	api: ModelApiSchema.optional(),
	reasoning: z.boolean().optional(),
	input: z.array(z.union([z.literal("text"), z.literal("image")])).optional(),
	cost: z.object({
		input: z.number().optional(),
		output: z.number().optional(),
		cacheRead: z.number().optional(),
		cacheWrite: z.number().optional()
	}).strict().optional(),
	contextWindow: z.number().positive().optional(),
	maxTokens: z.number().positive().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	compat: ModelCompatSchema
}).strict();
const ModelProviderSchema = z.object({
	baseUrl: z.string().min(1),
	apiKey: z.string().optional(),
	auth: z.union([
		z.literal("api-key"),
		z.literal("aws-sdk"),
		z.literal("oauth"),
		z.literal("token")
	]).optional(),
	api: ModelApiSchema.optional(),
	headers: z.record(z.string(), z.string()).optional(),
	authHeader: z.boolean().optional(),
	models: z.array(ModelDefinitionSchema)
}).strict();
const BedrockDiscoverySchema = z.object({
	enabled: z.boolean().optional(),
	region: z.string().optional(),
	providerFilter: z.array(z.string()).optional(),
	refreshInterval: z.number().int().nonnegative().optional(),
	defaultContextWindow: z.number().int().positive().optional(),
	defaultMaxTokens: z.number().int().positive().optional()
}).strict().optional();
const ModelsConfigSchema = z.object({
	mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
	providers: z.record(z.string(), ModelProviderSchema).optional(),
	bedrockDiscovery: BedrockDiscoverySchema
}).strict().optional();
const GroupChatSchema = z.object({
	mentionPatterns: z.array(z.string()).optional(),
	historyLimit: z.number().int().positive().optional()
}).strict().optional();
const DmConfigSchema = z.object({ historyLimit: z.number().int().min(0).optional() }).strict();
const IdentitySchema = z.object({
	name: z.string().optional(),
	theme: z.string().optional(),
	emoji: z.string().optional(),
	avatar: z.string().optional()
}).strict().optional();
const QueueModeSchema = z.union([
	z.literal("steer"),
	z.literal("followup"),
	z.literal("collect"),
	z.literal("steer-backlog"),
	z.literal("steer+backlog"),
	z.literal("queue"),
	z.literal("interrupt")
]);
const QueueDropSchema = z.union([
	z.literal("old"),
	z.literal("new"),
	z.literal("summarize")
]);
const ReplyToModeSchema = z.union([
	z.literal("off"),
	z.literal("first"),
	z.literal("all")
]);
const GroupPolicySchema = z.enum([
	"open",
	"disabled",
	"allowlist"
]);
const DmPolicySchema = z.enum([
	"pairing",
	"allowlist",
	"open",
	"disabled"
]);
const BlockStreamingCoalesceSchema = z.object({
	minChars: z.number().int().positive().optional(),
	maxChars: z.number().int().positive().optional(),
	idleMs: z.number().int().nonnegative().optional()
}).strict();
const BlockStreamingChunkSchema = z.object({
	minChars: z.number().int().positive().optional(),
	maxChars: z.number().int().positive().optional(),
	breakPreference: z.union([
		z.literal("paragraph"),
		z.literal("newline"),
		z.literal("sentence")
	]).optional()
}).strict();
const MarkdownTableModeSchema = z.enum([
	"off",
	"bullets",
	"code"
]);
const MarkdownConfigSchema = z.object({ tables: MarkdownTableModeSchema.optional() }).strict().optional();
const TtsProviderSchema = z.enum([
	"elevenlabs",
	"openai",
	"edge"
]);
const TtsModeSchema = z.enum(["final", "all"]);
const TtsAutoSchema = z.enum([
	"off",
	"always",
	"inbound",
	"tagged"
]);
const TtsConfigSchema = z.object({
	auto: TtsAutoSchema.optional(),
	enabled: z.boolean().optional(),
	mode: TtsModeSchema.optional(),
	provider: TtsProviderSchema.optional(),
	summaryModel: z.string().optional(),
	modelOverrides: z.object({
		enabled: z.boolean().optional(),
		allowText: z.boolean().optional(),
		allowProvider: z.boolean().optional(),
		allowVoice: z.boolean().optional(),
		allowModelId: z.boolean().optional(),
		allowVoiceSettings: z.boolean().optional(),
		allowNormalization: z.boolean().optional(),
		allowSeed: z.boolean().optional()
	}).strict().optional(),
	elevenlabs: z.object({
		apiKey: z.string().optional(),
		baseUrl: z.string().optional(),
		voiceId: z.string().optional(),
		modelId: z.string().optional(),
		seed: z.number().int().min(0).max(4294967295).optional(),
		applyTextNormalization: z.enum([
			"auto",
			"on",
			"off"
		]).optional(),
		languageCode: z.string().optional(),
		voiceSettings: z.object({
			stability: z.number().min(0).max(1).optional(),
			similarityBoost: z.number().min(0).max(1).optional(),
			style: z.number().min(0).max(1).optional(),
			useSpeakerBoost: z.boolean().optional(),
			speed: z.number().min(.5).max(2).optional()
		}).strict().optional()
	}).strict().optional(),
	openai: z.object({
		apiKey: z.string().optional(),
		model: z.string().optional(),
		voice: z.string().optional()
	}).strict().optional(),
	edge: z.object({
		enabled: z.boolean().optional(),
		voice: z.string().optional(),
		lang: z.string().optional(),
		outputFormat: z.string().optional(),
		pitch: z.string().optional(),
		rate: z.string().optional(),
		volume: z.string().optional(),
		saveSubtitles: z.boolean().optional(),
		proxy: z.string().optional(),
		timeoutMs: z.number().int().min(1e3).max(12e4).optional()
	}).strict().optional(),
	prefsPath: z.string().optional(),
	maxTextLength: z.number().int().min(1).optional(),
	timeoutMs: z.number().int().min(1e3).max(12e4).optional()
}).strict().optional();
const HumanDelaySchema = z.object({
	mode: z.union([
		z.literal("off"),
		z.literal("natural"),
		z.literal("custom")
	]).optional(),
	minMs: z.number().int().nonnegative().optional(),
	maxMs: z.number().int().nonnegative().optional()
}).strict();
const CliBackendSchema = z.object({
	command: z.string(),
	args: z.array(z.string()).optional(),
	output: z.union([
		z.literal("json"),
		z.literal("text"),
		z.literal("jsonl")
	]).optional(),
	resumeOutput: z.union([
		z.literal("json"),
		z.literal("text"),
		z.literal("jsonl")
	]).optional(),
	input: z.union([z.literal("arg"), z.literal("stdin")]).optional(),
	maxPromptArgChars: z.number().int().positive().optional(),
	env: z.record(z.string(), z.string()).optional(),
	clearEnv: z.array(z.string()).optional(),
	modelArg: z.string().optional(),
	modelAliases: z.record(z.string(), z.string()).optional(),
	sessionArg: z.string().optional(),
	sessionArgs: z.array(z.string()).optional(),
	resumeArgs: z.array(z.string()).optional(),
	sessionMode: z.union([
		z.literal("always"),
		z.literal("existing"),
		z.literal("none")
	]).optional(),
	sessionIdFields: z.array(z.string()).optional(),
	systemPromptArg: z.string().optional(),
	systemPromptMode: z.union([z.literal("append"), z.literal("replace")]).optional(),
	systemPromptWhen: z.union([
		z.literal("first"),
		z.literal("always"),
		z.literal("never")
	]).optional(),
	imageArg: z.string().optional(),
	imageMode: z.union([z.literal("repeat"), z.literal("list")]).optional(),
	serialize: z.boolean().optional()
}).strict();
const normalizeAllowFrom = (values) => (values ?? []).map((v) => String(v).trim()).filter(Boolean);
const requireOpenAllowFrom = (params) => {
	if (params.policy !== "open") return;
	if (normalizeAllowFrom(params.allowFrom).includes("*")) return;
	params.ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: params.path,
		message: params.message
	});
};
const MSTeamsReplyStyleSchema = z.enum(["thread", "top-level"]);
const RetryConfigSchema = z.object({
	attempts: z.number().int().min(1).optional(),
	minDelayMs: z.number().int().min(0).optional(),
	maxDelayMs: z.number().int().min(0).optional(),
	jitter: z.number().min(0).max(1).optional()
}).strict().optional();
const QueueModeBySurfaceSchema = z.object({
	whatsapp: QueueModeSchema.optional(),
	telegram: QueueModeSchema.optional(),
	discord: QueueModeSchema.optional(),
	irc: QueueModeSchema.optional(),
	slack: QueueModeSchema.optional(),
	mattermost: QueueModeSchema.optional(),
	signal: QueueModeSchema.optional(),
	imessage: QueueModeSchema.optional(),
	msteams: QueueModeSchema.optional(),
	webchat: QueueModeSchema.optional()
}).strict().optional();
const DebounceMsBySurfaceSchema = z.record(z.string(), z.number().int().nonnegative()).optional();
const QueueSchema = z.object({
	mode: QueueModeSchema.optional(),
	byChannel: QueueModeBySurfaceSchema,
	debounceMs: z.number().int().nonnegative().optional(),
	debounceMsByChannel: DebounceMsBySurfaceSchema,
	cap: z.number().int().positive().optional(),
	drop: QueueDropSchema.optional()
}).strict().optional();
const InboundDebounceSchema = z.object({
	debounceMs: z.number().int().nonnegative().optional(),
	byChannel: DebounceMsBySurfaceSchema
}).strict().optional();
const TranscribeAudioSchema = z.object({
	command: z.array(z.string()).superRefine((value, ctx) => {
		const executable = value[0];
		if (!isSafeExecutableValue(executable)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: [0],
			message: "expected safe executable name or path"
		});
	}),
	timeoutSeconds: z.number().int().positive().optional()
}).strict().optional();
const HexColorSchema = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");
const ExecutableTokenSchema = z.string().refine(isSafeExecutableValue, "expected safe executable name or path");
const MediaUnderstandingScopeSchema = z.object({
	default: z.union([z.literal("allow"), z.literal("deny")]).optional(),
	rules: z.array(z.object({
		action: z.union([z.literal("allow"), z.literal("deny")]),
		match: z.object({
			channel: z.string().optional(),
			chatType: z.union([
				z.literal("direct"),
				z.literal("group"),
				z.literal("channel"),
				z.literal("dm")
			]).optional(),
			keyPrefix: z.string().optional()
		}).strict().optional()
	}).strict()).optional()
}).strict().optional();
const MediaUnderstandingCapabilitiesSchema = z.array(z.union([
	z.literal("image"),
	z.literal("audio"),
	z.literal("video")
])).optional();
const MediaUnderstandingAttachmentsSchema = z.object({
	mode: z.union([z.literal("first"), z.literal("all")]).optional(),
	maxAttachments: z.number().int().positive().optional(),
	prefer: z.union([
		z.literal("first"),
		z.literal("last"),
		z.literal("path"),
		z.literal("url")
	]).optional()
}).strict().optional();
const DeepgramAudioSchema = z.object({
	detectLanguage: z.boolean().optional(),
	punctuate: z.boolean().optional(),
	smartFormat: z.boolean().optional()
}).strict().optional();
const ProviderOptionValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean()
]);
const ProviderOptionsSchema = z.record(z.string(), z.record(z.string(), ProviderOptionValueSchema)).optional();
const MediaUnderstandingModelSchema = z.object({
	provider: z.string().optional(),
	model: z.string().optional(),
	capabilities: MediaUnderstandingCapabilitiesSchema,
	type: z.union([z.literal("provider"), z.literal("cli")]).optional(),
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	prompt: z.string().optional(),
	maxChars: z.number().int().positive().optional(),
	maxBytes: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	language: z.string().optional(),
	providerOptions: ProviderOptionsSchema,
	deepgram: DeepgramAudioSchema,
	baseUrl: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	profile: z.string().optional(),
	preferredProfile: z.string().optional()
}).strict().optional();
const ToolsMediaUnderstandingSchema = z.object({
	enabled: z.boolean().optional(),
	scope: MediaUnderstandingScopeSchema,
	maxBytes: z.number().int().positive().optional(),
	maxChars: z.number().int().positive().optional(),
	prompt: z.string().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	language: z.string().optional(),
	providerOptions: ProviderOptionsSchema,
	deepgram: DeepgramAudioSchema,
	baseUrl: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	attachments: MediaUnderstandingAttachmentsSchema,
	models: z.array(MediaUnderstandingModelSchema).optional()
}).strict().optional();
const ToolsMediaSchema = z.object({
	models: z.array(MediaUnderstandingModelSchema).optional(),
	concurrency: z.number().int().positive().optional(),
	image: ToolsMediaUnderstandingSchema.optional(),
	audio: ToolsMediaUnderstandingSchema.optional(),
	video: ToolsMediaUnderstandingSchema.optional()
}).strict().optional();
const LinkModelSchema = z.object({
	type: z.literal("cli").optional(),
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	timeoutSeconds: z.number().int().positive().optional()
}).strict();
const ToolsLinksSchema = z.object({
	enabled: z.boolean().optional(),
	scope: MediaUnderstandingScopeSchema,
	maxLinks: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	models: z.array(LinkModelSchema).optional()
}).strict().optional();
const NativeCommandsSettingSchema = z.union([z.boolean(), z.literal("auto")]);
const ProviderCommandsSchema = z.object({
	native: NativeCommandsSettingSchema.optional(),
	nativeSkills: NativeCommandsSettingSchema.optional()
}).strict().optional();

//#endregion
//#region src/config/zod-schema.agent-runtime.ts
const HeartbeatSchema = z.object({
	every: z.string().optional(),
	activeHours: z.object({
		start: z.string().optional(),
		end: z.string().optional(),
		timezone: z.string().optional()
	}).strict().optional(),
	model: z.string().optional(),
	session: z.string().optional(),
	includeReasoning: z.boolean().optional(),
	target: z.string().optional(),
	to: z.string().optional(),
	accountId: z.string().optional(),
	prompt: z.string().optional(),
	ackMaxChars: z.number().int().nonnegative().optional()
}).strict().superRefine((val, ctx) => {
	if (!val.every) return;
	try {
		parseDurationMs(val.every, { defaultUnit: "m" });
	} catch {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["every"],
			message: "invalid duration (use ms, s, m, h)"
		});
	}
	const active = val.activeHours;
	if (!active) return;
	const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
	const validateTime = (raw, opts, path) => {
		if (!raw) return;
		if (!timePattern.test(raw)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["activeHours", path],
				message: "invalid time (use \"HH:MM\" 24h format)"
			});
			return;
		}
		const [hourStr, minuteStr] = raw.split(":");
		const hour = Number(hourStr);
		if (hour === 24 && Number(minuteStr) !== 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["activeHours", path],
				message: "invalid time (24:00 is the only allowed 24:xx value)"
			});
			return;
		}
		if (hour === 24 && !opts.allow24) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["activeHours", path],
			message: "invalid time (start cannot be 24:00)"
		});
	};
	validateTime(active.start, { allow24: false }, "start");
	validateTime(active.end, { allow24: true }, "end");
}).optional();
const SandboxDockerSchema = z.object({
	image: z.string().optional(),
	containerPrefix: z.string().optional(),
	workdir: z.string().optional(),
	readOnlyRoot: z.boolean().optional(),
	tmpfs: z.array(z.string()).optional(),
	network: z.string().optional(),
	user: z.string().optional(),
	capDrop: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	setupCommand: z.string().optional(),
	pidsLimit: z.number().int().positive().optional(),
	memory: z.union([z.string(), z.number()]).optional(),
	memorySwap: z.union([z.string(), z.number()]).optional(),
	cpus: z.number().positive().optional(),
	ulimits: z.record(z.string(), z.union([
		z.string(),
		z.number(),
		z.object({
			soft: z.number().int().nonnegative().optional(),
			hard: z.number().int().nonnegative().optional()
		}).strict()
	])).optional(),
	seccompProfile: z.string().optional(),
	apparmorProfile: z.string().optional(),
	dns: z.array(z.string()).optional(),
	extraHosts: z.array(z.string()).optional(),
	binds: z.array(z.string()).optional()
}).strict().optional();
const SandboxBrowserSchema = z.object({
	enabled: z.boolean().optional(),
	image: z.string().optional(),
	containerPrefix: z.string().optional(),
	cdpPort: z.number().int().positive().optional(),
	vncPort: z.number().int().positive().optional(),
	noVncPort: z.number().int().positive().optional(),
	headless: z.boolean().optional(),
	enableNoVnc: z.boolean().optional(),
	allowHostControl: z.boolean().optional(),
	autoStart: z.boolean().optional(),
	autoStartTimeoutMs: z.number().int().positive().optional()
}).strict().optional();
const SandboxPruneSchema = z.object({
	idleHours: z.number().int().nonnegative().optional(),
	maxAgeDays: z.number().int().nonnegative().optional()
}).strict().optional();
const ToolPolicyBaseSchema = z.object({
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional()
}).strict();
const ToolPolicySchema = ToolPolicyBaseSchema.superRefine((value, ctx) => {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)"
	});
}).optional();
const ToolsWebSearchSchema = z.object({
	enabled: z.boolean().optional(),
	provider: z.union([
		z.literal("brave"),
		z.literal("perplexity"),
		z.literal("grok")
	]).optional(),
	apiKey: z.string().optional(),
	maxResults: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	cacheTtlMinutes: z.number().nonnegative().optional(),
	perplexity: z.object({
		apiKey: z.string().optional(),
		baseUrl: z.string().optional(),
		model: z.string().optional()
	}).strict().optional(),
	grok: z.object({
		apiKey: z.string().optional(),
		model: z.string().optional(),
		inlineCitations: z.boolean().optional()
	}).strict().optional()
}).strict().optional();
const ToolsWebFetchSchema = z.object({
	enabled: z.boolean().optional(),
	maxChars: z.number().int().positive().optional(),
	maxCharsCap: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	cacheTtlMinutes: z.number().nonnegative().optional(),
	maxRedirects: z.number().int().nonnegative().optional(),
	userAgent: z.string().optional()
}).strict().optional();
const ToolsWebSchema = z.object({
	search: ToolsWebSearchSchema,
	fetch: ToolsWebFetchSchema
}).strict().optional();
const ToolProfileSchema = z.union([
	z.literal("minimal"),
	z.literal("coding"),
	z.literal("messaging"),
	z.literal("full")
]).optional();
const ToolPolicyWithProfileSchema = z.object({
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	profile: ToolProfileSchema
}).strict().superRefine((value, ctx) => {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "tools.byProvider policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)"
	});
});
const ElevatedAllowFromSchema = z.record(z.string(), z.array(z.union([z.string(), z.number()]))).optional();
const AgentSandboxSchema = z.object({
	mode: z.union([
		z.literal("off"),
		z.literal("non-main"),
		z.literal("all")
	]).optional(),
	workspaceAccess: z.union([
		z.literal("none"),
		z.literal("ro"),
		z.literal("rw")
	]).optional(),
	sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
	scope: z.union([
		z.literal("session"),
		z.literal("agent"),
		z.literal("shared")
	]).optional(),
	perSession: z.boolean().optional(),
	workspaceRoot: z.string().optional(),
	docker: SandboxDockerSchema,
	browser: SandboxBrowserSchema,
	prune: SandboxPruneSchema
}).strict().optional();
const AgentToolsSchema = z.object({
	profile: ToolProfileSchema,
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
	elevated: z.object({
		enabled: z.boolean().optional(),
		allowFrom: ElevatedAllowFromSchema
	}).strict().optional(),
	exec: z.object({
		host: z.enum([
			"sandbox",
			"gateway",
			"node"
		]).optional(),
		security: z.enum([
			"deny",
			"allowlist",
			"full"
		]).optional(),
		ask: z.enum([
			"off",
			"on-miss",
			"always"
		]).optional(),
		node: z.string().optional(),
		pathPrepend: z.array(z.string()).optional(),
		safeBins: z.array(z.string()).optional(),
		backgroundMs: z.number().int().positive().optional(),
		timeoutSec: z.number().int().positive().optional(),
		approvalRunningNoticeMs: z.number().int().nonnegative().optional(),
		cleanupMs: z.number().int().positive().optional(),
		notifyOnExit: z.boolean().optional(),
		applyPatch: z.object({
			enabled: z.boolean().optional(),
			allowModels: z.array(z.string()).optional()
		}).strict().optional()
	}).strict().optional(),
	sandbox: z.object({ tools: ToolPolicySchema }).strict().optional()
}).strict().superRefine((value, ctx) => {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)"
	});
}).optional();
const MemorySearchSchema = z.object({
	enabled: z.boolean().optional(),
	sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
	extraPaths: z.array(z.string()).optional(),
	experimental: z.object({ sessionMemory: z.boolean().optional() }).strict().optional(),
	provider: z.union([
		z.literal("openai"),
		z.literal("local"),
		z.literal("gemini"),
		z.literal("voyage")
	]).optional(),
	remote: z.object({
		baseUrl: z.string().optional(),
		apiKey: z.string().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		batch: z.object({
			enabled: z.boolean().optional(),
			wait: z.boolean().optional(),
			concurrency: z.number().int().positive().optional(),
			pollIntervalMs: z.number().int().nonnegative().optional(),
			timeoutMinutes: z.number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	fallback: z.union([
		z.literal("openai"),
		z.literal("gemini"),
		z.literal("local"),
		z.literal("voyage"),
		z.literal("none")
	]).optional(),
	model: z.string().optional(),
	local: z.object({
		modelPath: z.string().optional(),
		modelCacheDir: z.string().optional()
	}).strict().optional(),
	store: z.object({
		driver: z.literal("sqlite").optional(),
		path: z.string().optional(),
		vector: z.object({
			enabled: z.boolean().optional(),
			extensionPath: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	chunking: z.object({
		tokens: z.number().int().positive().optional(),
		overlap: z.number().int().nonnegative().optional()
	}).strict().optional(),
	sync: z.object({
		onSessionStart: z.boolean().optional(),
		onSearch: z.boolean().optional(),
		watch: z.boolean().optional(),
		watchDebounceMs: z.number().int().nonnegative().optional(),
		intervalMinutes: z.number().int().nonnegative().optional(),
		sessions: z.object({
			deltaBytes: z.number().int().nonnegative().optional(),
			deltaMessages: z.number().int().nonnegative().optional()
		}).strict().optional()
	}).strict().optional(),
	query: z.object({
		maxResults: z.number().int().positive().optional(),
		minScore: z.number().min(0).max(1).optional(),
		hybrid: z.object({
			enabled: z.boolean().optional(),
			vectorWeight: z.number().min(0).max(1).optional(),
			textWeight: z.number().min(0).max(1).optional(),
			candidateMultiplier: z.number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	cache: z.object({
		enabled: z.boolean().optional(),
		maxEntries: z.number().int().positive().optional()
	}).strict().optional()
}).strict().optional();
const AgentModelSchema = z.union([z.string(), z.object({
	primary: z.string().optional(),
	fallbacks: z.array(z.string()).optional()
}).strict()]);
const AgentEntrySchema = z.object({
	id: z.string(),
	default: z.boolean().optional(),
	name: z.string().optional(),
	workspace: z.string().optional(),
	agentDir: z.string().optional(),
	model: AgentModelSchema.optional(),
	skills: z.array(z.string()).optional(),
	memorySearch: MemorySearchSchema,
	humanDelay: HumanDelaySchema.optional(),
	heartbeat: HeartbeatSchema,
	identity: IdentitySchema,
	groupChat: GroupChatSchema,
	subagents: z.object({
		allowAgents: z.array(z.string()).optional(),
		model: z.union([z.string(), z.object({
			primary: z.string().optional(),
			fallbacks: z.array(z.string()).optional()
		}).strict()]).optional(),
		thinking: z.string().optional()
	}).strict().optional(),
	sandbox: AgentSandboxSchema,
	tools: AgentToolsSchema
}).strict();
const ToolsSchema = z.object({
	profile: ToolProfileSchema,
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
	web: ToolsWebSchema,
	media: ToolsMediaSchema,
	links: ToolsLinksSchema,
	message: z.object({
		allowCrossContextSend: z.boolean().optional(),
		crossContext: z.object({
			allowWithinProvider: z.boolean().optional(),
			allowAcrossProviders: z.boolean().optional(),
			marker: z.object({
				enabled: z.boolean().optional(),
				prefix: z.string().optional(),
				suffix: z.string().optional()
			}).strict().optional()
		}).strict().optional(),
		broadcast: z.object({ enabled: z.boolean().optional() }).strict().optional()
	}).strict().optional(),
	agentToAgent: z.object({
		enabled: z.boolean().optional(),
		allow: z.array(z.string()).optional()
	}).strict().optional(),
	elevated: z.object({
		enabled: z.boolean().optional(),
		allowFrom: ElevatedAllowFromSchema
	}).strict().optional(),
	exec: z.object({
		host: z.enum([
			"sandbox",
			"gateway",
			"node"
		]).optional(),
		security: z.enum([
			"deny",
			"allowlist",
			"full"
		]).optional(),
		ask: z.enum([
			"off",
			"on-miss",
			"always"
		]).optional(),
		node: z.string().optional(),
		pathPrepend: z.array(z.string()).optional(),
		safeBins: z.array(z.string()).optional(),
		backgroundMs: z.number().int().positive().optional(),
		timeoutSec: z.number().int().positive().optional(),
		cleanupMs: z.number().int().positive().optional(),
		notifyOnExit: z.boolean().optional(),
		applyPatch: z.object({
			enabled: z.boolean().optional(),
			allowModels: z.array(z.string()).optional()
		}).strict().optional()
	}).strict().optional(),
	subagents: z.object({ tools: ToolPolicySchema }).strict().optional(),
	sandbox: z.object({ tools: ToolPolicySchema }).strict().optional()
}).strict().superRefine((value, ctx) => {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)"
	});
}).optional();

//#endregion
//#region src/config/zod-schema.agent-defaults.ts
const AgentDefaultsSchema = z.object({
	model: z.object({
		primary: z.string().optional(),
		fallbacks: z.array(z.string()).optional()
	}).strict().optional(),
	imageModel: z.object({
		primary: z.string().optional(),
		fallbacks: z.array(z.string()).optional()
	}).strict().optional(),
	models: z.record(z.string(), z.object({
		alias: z.string().optional(),
		params: z.record(z.string(), z.unknown()).optional(),
		streaming: z.boolean().optional()
	}).strict()).optional(),
	workspace: z.string().optional(),
	repoRoot: z.string().optional(),
	skipBootstrap: z.boolean().optional(),
	bootstrapMaxChars: z.number().int().positive().optional(),
	userTimezone: z.string().optional(),
	timeFormat: z.union([
		z.literal("auto"),
		z.literal("12"),
		z.literal("24")
	]).optional(),
	envelopeTimezone: z.string().optional(),
	envelopeTimestamp: z.union([z.literal("on"), z.literal("off")]).optional(),
	envelopeElapsed: z.union([z.literal("on"), z.literal("off")]).optional(),
	contextTokens: z.number().int().positive().optional(),
	cliBackends: z.record(z.string(), CliBackendSchema).optional(),
	memorySearch: MemorySearchSchema,
	contextPruning: z.object({
		mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
		ttl: z.string().optional(),
		keepLastAssistants: z.number().int().nonnegative().optional(),
		softTrimRatio: z.number().min(0).max(1).optional(),
		hardClearRatio: z.number().min(0).max(1).optional(),
		minPrunableToolChars: z.number().int().nonnegative().optional(),
		tools: z.object({
			allow: z.array(z.string()).optional(),
			deny: z.array(z.string()).optional()
		}).strict().optional(),
		softTrim: z.object({
			maxChars: z.number().int().nonnegative().optional(),
			headChars: z.number().int().nonnegative().optional(),
			tailChars: z.number().int().nonnegative().optional()
		}).strict().optional(),
		hardClear: z.object({
			enabled: z.boolean().optional(),
			placeholder: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	compaction: z.object({
		mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
		reserveTokensFloor: z.number().int().nonnegative().optional(),
		maxHistoryShare: z.number().min(.1).max(.9).optional(),
		memoryFlush: z.object({
			enabled: z.boolean().optional(),
			softThresholdTokens: z.number().int().nonnegative().optional(),
			prompt: z.string().optional(),
			systemPrompt: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	thinkingDefault: z.union([
		z.literal("off"),
		z.literal("minimal"),
		z.literal("low"),
		z.literal("medium"),
		z.literal("high"),
		z.literal("xhigh")
	]).optional(),
	verboseDefault: z.union([
		z.literal("off"),
		z.literal("on"),
		z.literal("full")
	]).optional(),
	elevatedDefault: z.union([
		z.literal("off"),
		z.literal("on"),
		z.literal("ask"),
		z.literal("full")
	]).optional(),
	blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
	blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
	blockStreamingChunk: BlockStreamingChunkSchema.optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	humanDelay: HumanDelaySchema.optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	mediaMaxMb: z.number().positive().optional(),
	typingIntervalSeconds: z.number().int().positive().optional(),
	typingMode: z.union([
		z.literal("never"),
		z.literal("instant"),
		z.literal("thinking"),
		z.literal("message")
	]).optional(),
	heartbeat: HeartbeatSchema,
	maxConcurrent: z.number().int().positive().optional(),
	subagents: z.object({
		maxConcurrent: z.number().int().positive().optional(),
		archiveAfterMinutes: z.number().int().positive().optional(),
		model: z.union([z.string(), z.object({
			primary: z.string().optional(),
			fallbacks: z.array(z.string()).optional()
		}).strict()]).optional(),
		thinking: z.string().optional()
	}).strict().optional(),
	sandbox: z.object({
		mode: z.union([
			z.literal("off"),
			z.literal("non-main"),
			z.literal("all")
		]).optional(),
		workspaceAccess: z.union([
			z.literal("none"),
			z.literal("ro"),
			z.literal("rw")
		]).optional(),
		sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
		scope: z.union([
			z.literal("session"),
			z.literal("agent"),
			z.literal("shared")
		]).optional(),
		perSession: z.boolean().optional(),
		workspaceRoot: z.string().optional(),
		docker: SandboxDockerSchema,
		browser: SandboxBrowserSchema,
		prune: SandboxPruneSchema
	}).strict().optional()
}).strict().optional();

//#endregion
//#region src/config/zod-schema.agents.ts
const AgentsSchema = z.object({
	defaults: z.lazy(() => AgentDefaultsSchema).optional(),
	list: z.array(AgentEntrySchema).optional()
}).strict().optional();
const BindingsSchema = z.array(z.object({
	agentId: z.string(),
	match: z.object({
		channel: z.string(),
		accountId: z.string().optional(),
		peer: z.object({
			kind: z.union([
				z.literal("direct"),
				z.literal("group"),
				z.literal("channel"),
				z.literal("dm")
			]),
			id: z.string()
		}).strict().optional(),
		guildId: z.string().optional(),
		teamId: z.string().optional()
	}).strict()
}).strict()).optional();
const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);
const BroadcastSchema = z.object({ strategy: BroadcastStrategySchema.optional() }).catchall(z.array(z.string())).optional();
const AudioSchema = z.object({ transcription: TranscribeAudioSchema }).strict().optional();

//#endregion
//#region src/config/zod-schema.approvals.ts
const ExecApprovalForwardTargetSchema = z.object({
	channel: z.string().min(1),
	to: z.string().min(1),
	accountId: z.string().optional(),
	threadId: z.union([z.string(), z.number()]).optional()
}).strict();
const ExecApprovalForwardingSchema = z.object({
	enabled: z.boolean().optional(),
	mode: z.union([
		z.literal("session"),
		z.literal("targets"),
		z.literal("both")
	]).optional(),
	agentFilter: z.array(z.string()).optional(),
	sessionFilter: z.array(z.string()).optional(),
	targets: z.array(ExecApprovalForwardTargetSchema).optional()
}).strict().optional();
const ApprovalsSchema = z.object({ exec: ExecApprovalForwardingSchema }).strict().optional();

//#endregion
//#region src/config/zod-schema.hooks.ts
const HookMappingSchema = z.object({
	id: z.string().optional(),
	match: z.object({
		path: z.string().optional(),
		source: z.string().optional()
	}).optional(),
	action: z.union([z.literal("wake"), z.literal("agent")]).optional(),
	wakeMode: z.union([z.literal("now"), z.literal("next-heartbeat")]).optional(),
	name: z.string().optional(),
	agentId: z.string().optional(),
	sessionKey: z.string().optional(),
	messageTemplate: z.string().optional(),
	textTemplate: z.string().optional(),
	deliver: z.boolean().optional(),
	allowUnsafeExternalContent: z.boolean().optional(),
	channel: z.union([
		z.literal("last"),
		z.literal("whatsapp"),
		z.literal("telegram"),
		z.literal("discord"),
		z.literal("irc"),
		z.literal("slack"),
		z.literal("signal"),
		z.literal("imessage"),
		z.literal("msteams")
	]).optional(),
	to: z.string().optional(),
	model: z.string().optional(),
	thinking: z.string().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	transform: z.object({
		module: z.string(),
		export: z.string().optional()
	}).strict().optional()
}).strict().optional();
const InternalHookHandlerSchema = z.object({
	event: z.string(),
	module: z.string(),
	export: z.string().optional()
}).strict();
const HookConfigSchema = z.object({
	enabled: z.boolean().optional(),
	env: z.record(z.string(), z.string()).optional()
}).passthrough();
const HookInstallRecordSchema = z.object({
	source: z.union([
		z.literal("npm"),
		z.literal("archive"),
		z.literal("path")
	]),
	spec: z.string().optional(),
	sourcePath: z.string().optional(),
	installPath: z.string().optional(),
	version: z.string().optional(),
	installedAt: z.string().optional(),
	hooks: z.array(z.string()).optional()
}).strict();
const InternalHooksSchema = z.object({
	enabled: z.boolean().optional(),
	handlers: z.array(InternalHookHandlerSchema).optional(),
	entries: z.record(z.string(), HookConfigSchema).optional(),
	load: z.object({ extraDirs: z.array(z.string()).optional() }).strict().optional(),
	installs: z.record(z.string(), HookInstallRecordSchema).optional()
}).strict().optional();
const HooksGmailSchema = z.object({
	account: z.string().optional(),
	label: z.string().optional(),
	topic: z.string().optional(),
	subscription: z.string().optional(),
	pushToken: z.string().optional(),
	hookUrl: z.string().optional(),
	includeBody: z.boolean().optional(),
	maxBytes: z.number().int().positive().optional(),
	renewEveryMinutes: z.number().int().positive().optional(),
	allowUnsafeExternalContent: z.boolean().optional(),
	serve: z.object({
		bind: z.string().optional(),
		port: z.number().int().positive().optional(),
		path: z.string().optional()
	}).strict().optional(),
	tailscale: z.object({
		mode: z.union([
			z.literal("off"),
			z.literal("serve"),
			z.literal("funnel")
		]).optional(),
		path: z.string().optional(),
		target: z.string().optional()
	}).strict().optional(),
	model: z.string().optional(),
	thinking: z.union([
		z.literal("off"),
		z.literal("minimal"),
		z.literal("low"),
		z.literal("medium"),
		z.literal("high")
	]).optional()
}).strict().optional();

//#endregion
//#region src/config/zod-schema.channels.ts
const ChannelHeartbeatVisibilitySchema = z.object({
	showOk: z.boolean().optional(),
	showAlerts: z.boolean().optional(),
	useIndicator: z.boolean().optional()
}).strict().optional();

//#endregion
//#region src/config/telegram-custom-commands.ts
const TELEGRAM_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
function normalizeTelegramCommandName(value) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return (trimmed.startsWith("/") ? trimmed.slice(1) : trimmed).trim().toLowerCase();
}
function normalizeTelegramCommandDescription(value) {
	return value.trim();
}
function resolveTelegramCustomCommands(params) {
	const entries = Array.isArray(params.commands) ? params.commands : [];
	const reserved = params.reservedCommands ?? /* @__PURE__ */ new Set();
	const checkReserved = params.checkReserved !== false;
	const checkDuplicates = params.checkDuplicates !== false;
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	const issues = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const normalized = normalizeTelegramCommandName(String(entry?.command ?? ""));
		if (!normalized) {
			issues.push({
				index,
				field: "command",
				message: "Telegram custom command is missing a command name."
			});
			continue;
		}
		if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `Telegram custom command "/${normalized}" is invalid (use a-z, 0-9, underscore; max 32 chars).`
			});
			continue;
		}
		if (checkReserved && reserved.has(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `Telegram custom command "/${normalized}" conflicts with a native command.`
			});
			continue;
		}
		if (checkDuplicates && seen.has(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `Telegram custom command "/${normalized}" is duplicated.`
			});
			continue;
		}
		const description = normalizeTelegramCommandDescription(String(entry?.description ?? ""));
		if (!description) {
			issues.push({
				index,
				field: "description",
				message: `Telegram custom command "/${normalized}" is missing a description.`
			});
			continue;
		}
		if (checkDuplicates) seen.add(normalized);
		resolved.push({
			command: normalized,
			description
		});
	}
	return {
		commands: resolved,
		issues
	};
}

//#endregion
//#region src/config/zod-schema.providers-core.ts
const ToolPolicyBySenderSchema$1 = z.record(z.string(), ToolPolicySchema).optional();
const TelegramInlineButtonsScopeSchema = z.enum([
	"off",
	"dm",
	"group",
	"all",
	"allowlist"
]);
const TelegramCapabilitiesSchema = z.union([z.array(z.string()), z.object({ inlineButtons: TelegramInlineButtonsScopeSchema.optional() }).strict()]);
const TelegramTopicSchema = z.object({
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const TelegramGroupSchema = z.object({
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional(),
	topics: z.record(z.string(), TelegramTopicSchema.optional()).optional()
}).strict();
const TelegramCustomCommandSchema = z.object({
	command: z.string().transform(normalizeTelegramCommandName),
	description: z.string().transform(normalizeTelegramCommandDescription)
}).strict();
const validateTelegramCustomCommands = (value, ctx) => {
	if (!value.customCommands || value.customCommands.length === 0) return;
	const { issues } = resolveTelegramCustomCommands({
		commands: value.customCommands,
		checkReserved: false,
		checkDuplicates: false
	});
	for (const issue of issues) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: [
			"customCommands",
			issue.index,
			issue.field
		],
		message: issue.message
	});
};
const TelegramAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: TelegramCapabilitiesSchema.optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	customCommands: z.array(TelegramCustomCommandSchema).optional(),
	configWrites: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	botToken: z.string().optional(),
	tokenFile: z.string().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	draftChunk: BlockStreamingChunkSchema.optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	streamMode: z.enum([
		"off",
		"partial",
		"block"
	]).optional().default("partial"),
	mediaMaxMb: z.number().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	retry: RetryConfigSchema,
	network: z.object({ autoSelectFamily: z.boolean().optional() }).strict().optional(),
	proxy: z.string().optional(),
	webhookUrl: z.string().optional(),
	webhookSecret: z.string().optional(),
	webhookPath: z.string().optional(),
	actions: z.object({
		reactions: z.boolean().optional(),
		sendMessage: z.boolean().optional(),
		deleteMessage: z.boolean().optional(),
		sticker: z.boolean().optional()
	}).strict().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all"
	]).optional(),
	reactionLevel: z.enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	linkPreview: z.boolean().optional(),
	responsePrefix: z.string().optional()
}).strict();
const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.telegram.dmPolicy=\"open\" requires channels.telegram.allowFrom to include \"*\""
	});
	validateTelegramCustomCommands(value, ctx);
});
const TelegramConfigSchema = TelegramAccountSchemaBase.extend({ accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional() }).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.telegram.dmPolicy=\"open\" requires channels.telegram.allowFrom to include \"*\""
	});
	validateTelegramCustomCommands(value, ctx);
	const baseWebhookUrl = typeof value.webhookUrl === "string" ? value.webhookUrl.trim() : "";
	const baseWebhookSecret = typeof value.webhookSecret === "string" ? value.webhookSecret.trim() : "";
	if (baseWebhookUrl && !baseWebhookSecret) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
		path: ["webhookSecret"]
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		if (account.enabled === false) continue;
		if (!(typeof account.webhookUrl === "string" ? account.webhookUrl.trim() : "")) continue;
		if (!(typeof account.webhookSecret === "string" ? account.webhookSecret.trim() : "") && !baseWebhookSecret) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
			path: [
				"accounts",
				accountId,
				"webhookSecret"
			]
		});
	}
});
const DiscordDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupEnabled: z.boolean().optional(),
	groupChannels: z.array(z.union([z.string(), z.number()])).optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.policy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.discord.dm.policy=\"open\" requires channels.discord.dm.allowFrom to include \"*\""
	});
});
const DiscordGuildChannelSchema = z.object({
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional(),
	includeThreadStarter: z.boolean().optional(),
	autoThread: z.boolean().optional()
}).strict();
const DiscordGuildSchema = z.object({
	slug: z.string().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	channels: z.record(z.string(), DiscordGuildChannelSchema.optional()).optional()
}).strict();
const DiscordAccountSchema = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: z.boolean().optional(),
	token: z.string().optional(),
	allowBots: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	maxLinesPerMessage: z.number().int().positive().optional(),
	mediaMaxMb: z.number().positive().optional(),
	retry: RetryConfigSchema,
	actions: z.object({
		reactions: z.boolean().optional(),
		stickers: z.boolean().optional(),
		emojiUploads: z.boolean().optional(),
		stickerUploads: z.boolean().optional(),
		polls: z.boolean().optional(),
		permissions: z.boolean().optional(),
		messages: z.boolean().optional(),
		threads: z.boolean().optional(),
		pins: z.boolean().optional(),
		search: z.boolean().optional(),
		memberInfo: z.boolean().optional(),
		roleInfo: z.boolean().optional(),
		roles: z.boolean().optional(),
		channelInfo: z.boolean().optional(),
		voiceStatus: z.boolean().optional(),
		events: z.boolean().optional(),
		moderation: z.boolean().optional(),
		channels: z.boolean().optional(),
		presence: z.boolean().optional()
	}).strict().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	dm: DiscordDmSchema.optional(),
	guilds: z.record(z.string(), DiscordGuildSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	execApprovals: z.object({
		enabled: z.boolean().optional(),
		approvers: z.array(z.union([z.string(), z.number()])).optional(),
		agentFilter: z.array(z.string()).optional(),
		sessionFilter: z.array(z.string()).optional(),
		cleanupAfterResolve: z.boolean().optional()
	}).strict().optional(),
	intents: z.object({
		presence: z.boolean().optional(),
		guildMembers: z.boolean().optional()
	}).strict().optional(),
	pluralkit: z.object({
		enabled: z.boolean().optional(),
		token: z.string().optional()
	}).strict().optional(),
	responsePrefix: z.string().optional()
}).strict();
const DiscordConfigSchema = DiscordAccountSchema.extend({ accounts: z.record(z.string(), DiscordAccountSchema.optional()).optional() });
const GoogleChatDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.policy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.googlechat.dm.policy=\"open\" requires channels.googlechat.dm.allowFrom to include \"*\""
	});
});
const GoogleChatGroupSchema = z.object({
	enabled: z.boolean().optional(),
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const GoogleChatAccountSchema = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	allowBots: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
	serviceAccount: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
	serviceAccountFile: z.string().optional(),
	audienceType: z.enum(["app-url", "project-number"]).optional(),
	audience: z.string().optional(),
	webhookPath: z.string().optional(),
	webhookUrl: z.string().optional(),
	botUser: z.string().optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().positive().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	actions: z.object({ reactions: z.boolean().optional() }).strict().optional(),
	dm: GoogleChatDmSchema.optional(),
	typingIndicator: z.enum([
		"none",
		"message",
		"reaction"
	]).optional(),
	responsePrefix: z.string().optional()
}).strict();
const GoogleChatConfigSchema = GoogleChatAccountSchema.extend({
	accounts: z.record(z.string(), GoogleChatAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
});
const SlackDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupEnabled: z.boolean().optional(),
	groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
	replyToMode: ReplyToModeSchema.optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.policy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.slack.dm.policy=\"open\" requires channels.slack.dm.allowFrom to include \"*\""
	});
});
const SlackChannelSchema = z.object({
	enabled: z.boolean().optional(),
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	allowBots: z.boolean().optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	skills: z.array(z.string()).optional(),
	systemPrompt: z.string().optional()
}).strict();
const SlackThreadSchema = z.object({
	historyScope: z.enum(["thread", "channel"]).optional(),
	inheritParent: z.boolean().optional()
}).strict();
const SlackReplyToModeByChatTypeSchema = z.object({
	direct: ReplyToModeSchema.optional(),
	group: ReplyToModeSchema.optional(),
	channel: ReplyToModeSchema.optional()
}).strict();
const SlackAccountSchema = z.object({
	name: z.string().optional(),
	mode: z.enum(["socket", "http"]).optional(),
	signingSecret: z.string().optional(),
	webhookPath: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: z.boolean().optional(),
	botToken: z.string().optional(),
	appToken: z.string().optional(),
	userToken: z.string().optional(),
	userTokenReadOnly: z.boolean().optional().default(true),
	allowBots: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().positive().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
	replyToMode: ReplyToModeSchema.optional(),
	replyToModeByChatType: SlackReplyToModeByChatTypeSchema.optional(),
	thread: SlackThreadSchema.optional(),
	actions: z.object({
		reactions: z.boolean().optional(),
		messages: z.boolean().optional(),
		pins: z.boolean().optional(),
		search: z.boolean().optional(),
		permissions: z.boolean().optional(),
		memberInfo: z.boolean().optional(),
		channelInfo: z.boolean().optional(),
		emojiList: z.boolean().optional()
	}).strict().optional(),
	slashCommand: z.object({
		enabled: z.boolean().optional(),
		name: z.string().optional(),
		sessionPrefix: z.string().optional(),
		ephemeral: z.boolean().optional()
	}).strict().optional(),
	dm: SlackDmSchema.optional(),
	channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict();
const SlackConfigSchema = SlackAccountSchema.extend({
	mode: z.enum(["socket", "http"]).optional().default("socket"),
	signingSecret: z.string().optional(),
	webhookPath: z.string().optional().default("/slack/events"),
	accounts: z.record(z.string(), SlackAccountSchema.optional()).optional()
}).superRefine((value, ctx) => {
	const baseMode = value.mode ?? "socket";
	if (baseMode === "http" && !value.signingSecret) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.slack.mode=\"http\" requires channels.slack.signingSecret",
		path: ["signingSecret"]
	});
	if (!value.accounts) return;
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		if (account.enabled === false) continue;
		if ((account.mode ?? baseMode) !== "http") continue;
		if (!(account.signingSecret ?? value.signingSecret)) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "channels.slack.accounts.*.mode=\"http\" requires channels.slack.signingSecret or channels.slack.accounts.*.signingSecret",
			path: [
				"accounts",
				accountId,
				"signingSecret"
			]
		});
	}
});
const SignalAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	account: z.string().optional(),
	httpUrl: z.string().optional(),
	httpHost: z.string().optional(),
	httpPort: z.number().int().positive().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	autoStart: z.boolean().optional(),
	startupTimeoutMs: z.number().int().min(1e3).max(12e4).optional(),
	receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
	ignoreAttachments: z.boolean().optional(),
	ignoreStories: z.boolean().optional(),
	sendReadReceipts: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
	actions: z.object({ reactions: z.boolean().optional() }).strict().optional(),
	reactionLevel: z.enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict();
const SignalAccountSchema = SignalAccountSchemaBase.superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.signal.dmPolicy=\"open\" requires channels.signal.allowFrom to include \"*\""
	});
});
const SignalConfigSchema = SignalAccountSchemaBase.extend({ accounts: z.record(z.string(), SignalAccountSchema.optional()).optional() }).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.signal.dmPolicy=\"open\" requires channels.signal.allowFrom to include \"*\""
	});
});
const IrcGroupSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const IrcNickServSchema = z.object({
	enabled: z.boolean().optional(),
	service: z.string().optional(),
	password: z.string().optional(),
	passwordFile: z.string().optional(),
	register: z.boolean().optional(),
	registerEmail: z.string().optional()
}).strict();
const IrcAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	host: z.string().optional(),
	port: z.number().int().min(1).max(65535).optional(),
	tls: z.boolean().optional(),
	nick: z.string().optional(),
	username: z.string().optional(),
	realname: z.string().optional(),
	password: z.string().optional(),
	passwordFile: z.string().optional(),
	nickserv: IrcNickServSchema.optional(),
	channels: z.array(z.string()).optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groups: z.record(z.string(), IrcGroupSchema.optional()).optional(),
	mentionPatterns: z.array(z.string()).optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().positive().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict();
const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"open\" requires channels.irc.allowFrom to include \"*\""
	});
	if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
});
const IrcConfigSchema = IrcAccountSchemaBase.extend({ accounts: z.record(z.string(), IrcAccountSchema.optional()).optional() }).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"open\" requires channels.irc.allowFrom to include \"*\""
	});
	if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
});
const IMessageAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	dbPath: z.string().optional(),
	remoteHost: z.string().optional(),
	service: z.union([
		z.literal("imessage"),
		z.literal("sms"),
		z.literal("auto")
	]).optional(),
	region: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	includeAttachments: z.boolean().optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	groups: z.record(z.string(), z.object({
		requireMention: z.boolean().optional(),
		tools: ToolPolicySchema,
		toolsBySender: ToolPolicyBySenderSchema$1
	}).strict().optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict();
const IMessageAccountSchema = IMessageAccountSchemaBase.superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.imessage.dmPolicy=\"open\" requires channels.imessage.allowFrom to include \"*\""
	});
});
const IMessageConfigSchema = IMessageAccountSchemaBase.extend({ accounts: z.record(z.string(), IMessageAccountSchema.optional()).optional() }).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.imessage.dmPolicy=\"open\" requires channels.imessage.allowFrom to include \"*\""
	});
});
const BlueBubblesAllowFromEntry = z.union([z.string(), z.number()]);
const BlueBubblesActionSchema = z.object({
	reactions: z.boolean().optional(),
	edit: z.boolean().optional(),
	unsend: z.boolean().optional(),
	reply: z.boolean().optional(),
	sendWithEffect: z.boolean().optional(),
	renameGroup: z.boolean().optional(),
	setGroupIcon: z.boolean().optional(),
	addParticipant: z.boolean().optional(),
	removeParticipant: z.boolean().optional(),
	leaveGroup: z.boolean().optional(),
	sendAttachment: z.boolean().optional()
}).strict().optional();
const BlueBubblesGroupConfigSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1
}).strict();
const BlueBubblesAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	enabled: z.boolean().optional(),
	serverUrl: z.string().optional(),
	password: z.string().optional(),
	webhookPath: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
	groupAllowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	sendReadReceipts: z.boolean().optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	groups: z.record(z.string(), BlueBubblesGroupConfigSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict();
const BlueBubblesAccountSchema = BlueBubblesAccountSchemaBase.superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.bluebubbles.accounts.*.dmPolicy=\"open\" requires allowFrom to include \"*\""
	});
});
const BlueBubblesConfigSchema = BlueBubblesAccountSchemaBase.extend({
	accounts: z.record(z.string(), BlueBubblesAccountSchema.optional()).optional(),
	actions: BlueBubblesActionSchema
}).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.bluebubbles.dmPolicy=\"open\" requires channels.bluebubbles.allowFrom to include \"*\""
	});
});
const MSTeamsChannelSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	replyStyle: MSTeamsReplyStyleSchema.optional()
}).strict();
const MSTeamsTeamSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema$1,
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional()
}).strict();
const MSTeamsConfigSchema = z.object({
	enabled: z.boolean().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	appId: z.string().optional(),
	appPassword: z.string().optional(),
	tenantId: z.string().optional(),
	webhook: z.object({
		port: z.number().int().positive().optional(),
		path: z.string().optional()
	}).strict().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.string()).optional(),
	groupAllowFrom: z.array(z.string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaAllowHosts: z.array(z.string()).optional(),
	mediaAuthAllowHosts: z.array(z.string()).optional(),
	requireMention: z.boolean().optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
	mediaMaxMb: z.number().positive().optional(),
	sharePointSiteId: z.string().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	responsePrefix: z.string().optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.msteams.dmPolicy=\"open\" requires channels.msteams.allowFrom to include \"*\""
	});
});

//#endregion
//#region src/config/zod-schema.providers-whatsapp.ts
const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();
const WhatsAppAccountSchema = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	enabled: z.boolean().optional(),
	sendReadReceipts: z.boolean().optional(),
	messagePrefix: z.string().optional(),
	responsePrefix: z.string().optional(),
	authDir: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	selfChatMode: z.boolean().optional(),
	allowFrom: z.array(z.string()).optional(),
	groupAllowFrom: z.array(z.string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	groups: z.record(z.string(), z.object({
		requireMention: z.boolean().optional(),
		tools: ToolPolicySchema,
		toolsBySender: ToolPolicyBySenderSchema
	}).strict().optional()).optional(),
	ackReaction: z.object({
		emoji: z.string().optional(),
		direct: z.boolean().optional().default(true),
		group: z.enum([
			"always",
			"mentions",
			"never"
		]).optional().default("mentions")
	}).strict().optional(),
	debounceMs: z.number().int().nonnegative().optional().default(0),
	heartbeat: ChannelHeartbeatVisibilitySchema
}).strict().superRefine((value, ctx) => {
	if (value.dmPolicy !== "open") return;
	if ((value.allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean).includes("*")) return;
	ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["allowFrom"],
		message: "channels.whatsapp.accounts.*.dmPolicy=\"open\" requires allowFrom to include \"*\""
	});
});
const WhatsAppConfigSchema = z.object({
	accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	sendReadReceipts: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	messagePrefix: z.string().optional(),
	responsePrefix: z.string().optional(),
	selfChatMode: z.boolean().optional(),
	allowFrom: z.array(z.string()).optional(),
	groupAllowFrom: z.array(z.string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	mediaMaxMb: z.number().int().positive().optional().default(50),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	actions: z.object({
		reactions: z.boolean().optional(),
		sendMessage: z.boolean().optional(),
		polls: z.boolean().optional()
	}).strict().optional(),
	groups: z.record(z.string(), z.object({
		requireMention: z.boolean().optional(),
		tools: ToolPolicySchema,
		toolsBySender: ToolPolicyBySenderSchema
	}).strict().optional()).optional(),
	ackReaction: z.object({
		emoji: z.string().optional(),
		direct: z.boolean().optional().default(true),
		group: z.enum([
			"always",
			"mentions",
			"never"
		]).optional().default("mentions")
	}).strict().optional(),
	debounceMs: z.number().int().nonnegative().optional().default(0),
	heartbeat: ChannelHeartbeatVisibilitySchema
}).strict().superRefine((value, ctx) => {
	if (value.dmPolicy !== "open") return;
	if ((value.allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean).includes("*")) return;
	ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["allowFrom"],
		message: "channels.whatsapp.dmPolicy=\"open\" requires channels.whatsapp.allowFrom to include \"*\""
	});
});

//#endregion
//#region src/config/zod-schema.providers.ts
const ChannelsSchema = z.object({
	defaults: z.object({
		groupPolicy: GroupPolicySchema.optional(),
		heartbeat: ChannelHeartbeatVisibilitySchema
	}).strict().optional(),
	whatsapp: WhatsAppConfigSchema.optional(),
	telegram: TelegramConfigSchema.optional(),
	discord: DiscordConfigSchema.optional(),
	irc: IrcConfigSchema.optional(),
	googlechat: GoogleChatConfigSchema.optional(),
	slack: SlackConfigSchema.optional(),
	signal: SignalConfigSchema.optional(),
	imessage: IMessageConfigSchema.optional(),
	bluebubbles: BlueBubblesConfigSchema.optional(),
	msteams: MSTeamsConfigSchema.optional()
}).passthrough().optional();

//#endregion
//#region src/cli/parse-bytes.ts
const UNIT_MULTIPLIERS = {
	b: 1,
	kb: 1024,
	k: 1024,
	mb: 1024 ** 2,
	m: 1024 ** 2,
	gb: 1024 ** 3,
	g: 1024 ** 3,
	tb: 1024 ** 4,
	t: 1024 ** 4
};
function parseByteSize(raw, opts) {
	const trimmed = String(raw ?? "").trim().toLowerCase();
	if (!trimmed) throw new Error("invalid byte size (empty)");
	const m = /^(\d+(?:\.\d+)?)([a-z]+)?$/.exec(trimmed);
	if (!m) throw new Error(`invalid byte size: ${raw}`);
	const value = Number(m[1]);
	if (!Number.isFinite(value) || value < 0) throw new Error(`invalid byte size: ${raw}`);
	const multiplier = UNIT_MULTIPLIERS[(m[2] ?? opts?.defaultUnit ?? "b").toLowerCase()];
	if (!multiplier) throw new Error(`invalid byte size unit: ${raw}`);
	const bytes = Math.round(value * multiplier);
	if (!Number.isFinite(bytes)) throw new Error(`invalid byte size: ${raw}`);
	return bytes;
}

//#endregion
//#region src/config/zod-schema.session.ts
const SessionResetConfigSchema = z.object({
	mode: z.union([z.literal("daily"), z.literal("idle")]).optional(),
	atHour: z.number().int().min(0).max(23).optional(),
	idleMinutes: z.number().int().positive().optional()
}).strict();
const SessionSendPolicySchema = z.object({
	default: z.union([z.literal("allow"), z.literal("deny")]).optional(),
	rules: z.array(z.object({
		action: z.union([z.literal("allow"), z.literal("deny")]),
		match: z.object({
			channel: z.string().optional(),
			chatType: z.union([
				z.literal("direct"),
				z.literal("group"),
				z.literal("channel"),
				z.literal("dm")
			]).optional(),
			keyPrefix: z.string().optional()
		}).strict().optional()
	}).strict()).optional()
}).strict();
const SessionSchema = z.object({
	scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
	dmScope: z.union([
		z.literal("main"),
		z.literal("per-peer"),
		z.literal("per-channel-peer"),
		z.literal("per-account-channel-peer")
	]).optional(),
	identityLinks: z.record(z.string(), z.array(z.string())).optional(),
	resetTriggers: z.array(z.string()).optional(),
	idleMinutes: z.number().int().positive().optional(),
	reset: SessionResetConfigSchema.optional(),
	resetByType: z.object({
		direct: SessionResetConfigSchema.optional(),
		dm: SessionResetConfigSchema.optional(),
		group: SessionResetConfigSchema.optional(),
		thread: SessionResetConfigSchema.optional()
	}).strict().optional(),
	resetByChannel: z.record(z.string(), SessionResetConfigSchema).optional(),
	store: z.string().optional(),
	typingIntervalSeconds: z.number().int().positive().optional(),
	typingMode: z.union([
		z.literal("never"),
		z.literal("instant"),
		z.literal("thinking"),
		z.literal("message")
	]).optional(),
	mainKey: z.string().optional(),
	sendPolicy: SessionSendPolicySchema.optional(),
	agentToAgent: z.object({ maxPingPongTurns: z.number().int().min(0).max(5).optional() }).strict().optional(),
	maintenance: z.object({
		mode: z.enum(["enforce", "warn"]).optional(),
		pruneAfter: z.union([z.string(), z.number()]).optional(),
		pruneDays: z.number().int().positive().optional(),
		maxEntries: z.number().int().positive().optional(),
		rotateBytes: z.union([z.string(), z.number()]).optional()
	}).strict().superRefine((val, ctx) => {
		if (val.pruneAfter !== void 0) try {
			parseDurationMs(String(val.pruneAfter).trim(), { defaultUnit: "d" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["pruneAfter"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.rotateBytes !== void 0) try {
			parseByteSize(String(val.rotateBytes).trim(), { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["rotateBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
	}).optional()
}).strict().optional();
const MessagesSchema = z.object({
	messagePrefix: z.string().optional(),
	responsePrefix: z.string().optional(),
	groupChat: GroupChatSchema,
	queue: QueueSchema,
	inbound: InboundDebounceSchema,
	ackReaction: z.string().optional(),
	ackReactionScope: z.enum([
		"group-mentions",
		"group-all",
		"direct",
		"all"
	]).optional(),
	removeAckAfterReply: z.boolean().optional(),
	tts: TtsConfigSchema
}).strict().optional();
const CommandsSchema = z.object({
	native: NativeCommandsSettingSchema.optional().default("auto"),
	nativeSkills: NativeCommandsSettingSchema.optional().default("auto"),
	text: z.boolean().optional(),
	bash: z.boolean().optional(),
	bashForegroundMs: z.number().int().min(0).max(3e4).optional(),
	config: z.boolean().optional(),
	debug: z.boolean().optional(),
	restart: z.boolean().optional(),
	useAccessGroups: z.boolean().optional(),
	ownerAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	allowFrom: ElevatedAllowFromSchema.optional()
}).strict().optional().default({
	native: "auto",
	nativeSkills: "auto"
});

//#endregion
//#region src/config/zod-schema.ts
const BrowserSnapshotDefaultsSchema = z.object({ mode: z.literal("efficient").optional() }).strict().optional();
const NodeHostSchema = z.object({ browserProxy: z.object({
	enabled: z.boolean().optional(),
	allowProfiles: z.array(z.string()).optional()
}).strict().optional() }).strict().optional();
const MemoryQmdPathSchema = z.object({
	path: z.string(),
	name: z.string().optional(),
	pattern: z.string().optional()
}).strict();
const MemoryQmdSessionSchema = z.object({
	enabled: z.boolean().optional(),
	exportDir: z.string().optional(),
	retentionDays: z.number().int().nonnegative().optional()
}).strict();
const MemoryQmdUpdateSchema = z.object({
	interval: z.string().optional(),
	debounceMs: z.number().int().nonnegative().optional(),
	onBoot: z.boolean().optional(),
	waitForBootSync: z.boolean().optional(),
	embedInterval: z.string().optional(),
	commandTimeoutMs: z.number().int().nonnegative().optional(),
	updateTimeoutMs: z.number().int().nonnegative().optional(),
	embedTimeoutMs: z.number().int().nonnegative().optional()
}).strict();
const MemoryQmdLimitsSchema = z.object({
	maxResults: z.number().int().positive().optional(),
	maxSnippetChars: z.number().int().positive().optional(),
	maxInjectedChars: z.number().int().positive().optional(),
	timeoutMs: z.number().int().nonnegative().optional()
}).strict();
const MemoryQmdSchema = z.object({
	command: z.string().optional(),
	searchMode: z.union([
		z.literal("query"),
		z.literal("search"),
		z.literal("vsearch")
	]).optional(),
	includeDefaultMemory: z.boolean().optional(),
	paths: z.array(MemoryQmdPathSchema).optional(),
	sessions: MemoryQmdSessionSchema.optional(),
	update: MemoryQmdUpdateSchema.optional(),
	limits: MemoryQmdLimitsSchema.optional(),
	scope: SessionSendPolicySchema.optional()
}).strict();
const MemorySchema = z.object({
	backend: z.union([z.literal("builtin"), z.literal("qmd")]).optional(),
	citations: z.union([
		z.literal("auto"),
		z.literal("on"),
		z.literal("off")
	]).optional(),
	qmd: MemoryQmdSchema.optional()
}).strict().optional();
const OpenClawSchema = z.object({
	meta: z.object({
		lastTouchedVersion: z.string().optional(),
		lastTouchedAt: z.string().optional()
	}).strict().optional(),
	env: z.object({
		shellEnv: z.object({
			enabled: z.boolean().optional(),
			timeoutMs: z.number().int().nonnegative().optional()
		}).strict().optional(),
		vars: z.record(z.string(), z.string()).optional()
	}).catchall(z.string()).optional(),
	wizard: z.object({
		lastRunAt: z.string().optional(),
		lastRunVersion: z.string().optional(),
		lastRunCommit: z.string().optional(),
		lastRunCommand: z.string().optional(),
		lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional()
	}).strict().optional(),
	diagnostics: z.object({
		enabled: z.boolean().optional(),
		flags: z.array(z.string()).optional(),
		otel: z.object({
			enabled: z.boolean().optional(),
			endpoint: z.string().optional(),
			protocol: z.union([z.literal("http/protobuf"), z.literal("grpc")]).optional(),
			headers: z.record(z.string(), z.string()).optional(),
			serviceName: z.string().optional(),
			traces: z.boolean().optional(),
			metrics: z.boolean().optional(),
			logs: z.boolean().optional(),
			sampleRate: z.number().min(0).max(1).optional(),
			flushIntervalMs: z.number().int().nonnegative().optional()
		}).strict().optional(),
		cacheTrace: z.object({
			enabled: z.boolean().optional(),
			filePath: z.string().optional(),
			includeMessages: z.boolean().optional(),
			includePrompt: z.boolean().optional(),
			includeSystem: z.boolean().optional()
		}).strict().optional()
	}).strict().optional(),
	logging: z.object({
		level: z.union([
			z.literal("silent"),
			z.literal("fatal"),
			z.literal("error"),
			z.literal("warn"),
			z.literal("info"),
			z.literal("debug"),
			z.literal("trace")
		]).optional(),
		file: z.string().optional(),
		consoleLevel: z.union([
			z.literal("silent"),
			z.literal("fatal"),
			z.literal("error"),
			z.literal("warn"),
			z.literal("info"),
			z.literal("debug"),
			z.literal("trace")
		]).optional(),
		consoleStyle: z.union([
			z.literal("pretty"),
			z.literal("compact"),
			z.literal("json")
		]).optional(),
		redactSensitive: z.union([z.literal("off"), z.literal("tools")]).optional(),
		redactPatterns: z.array(z.string()).optional()
	}).strict().optional(),
	update: z.object({
		channel: z.union([
			z.literal("stable"),
			z.literal("beta"),
			z.literal("dev")
		]).optional(),
		checkOnStart: z.boolean().optional()
	}).strict().optional(),
	browser: z.object({
		enabled: z.boolean().optional(),
		evaluateEnabled: z.boolean().optional(),
		cdpUrl: z.string().optional(),
		remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
		remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
		color: z.string().optional(),
		executablePath: z.string().optional(),
		headless: z.boolean().optional(),
		noSandbox: z.boolean().optional(),
		attachOnly: z.boolean().optional(),
		defaultProfile: z.string().optional(),
		snapshotDefaults: BrowserSnapshotDefaultsSchema,
		profiles: z.record(z.string().regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"), z.object({
			cdpPort: z.number().int().min(1).max(65535).optional(),
			cdpUrl: z.string().optional(),
			driver: z.union([z.literal("clawd"), z.literal("extension")]).optional(),
			color: HexColorSchema
		}).strict().refine((value) => value.cdpPort || value.cdpUrl, { message: "Profile must set cdpPort or cdpUrl" })).optional()
	}).strict().optional(),
	ui: z.object({
		seamColor: HexColorSchema.optional(),
		assistant: z.object({
			name: z.string().max(50).optional(),
			avatar: z.string().max(200).optional()
		}).strict().optional()
	}).strict().optional(),
	auth: z.object({
		profiles: z.record(z.string(), z.object({
			provider: z.string(),
			mode: z.union([
				z.literal("api_key"),
				z.literal("oauth"),
				z.literal("token")
			]),
			email: z.string().optional()
		}).strict()).optional(),
		order: z.record(z.string(), z.array(z.string())).optional(),
		cooldowns: z.object({
			billingBackoffHours: z.number().positive().optional(),
			billingBackoffHoursByProvider: z.record(z.string(), z.number().positive()).optional(),
			billingMaxHours: z.number().positive().optional(),
			failureWindowHours: z.number().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	models: ModelsConfigSchema,
	nodeHost: NodeHostSchema,
	agents: AgentsSchema,
	tools: ToolsSchema,
	bindings: BindingsSchema,
	broadcast: BroadcastSchema,
	audio: AudioSchema,
	media: z.object({ preserveFilenames: z.boolean().optional() }).strict().optional(),
	messages: MessagesSchema,
	commands: CommandsSchema,
	approvals: ApprovalsSchema,
	session: SessionSchema,
	cron: z.object({
		enabled: z.boolean().optional(),
		store: z.string().optional(),
		maxConcurrentRuns: z.number().int().positive().optional(),
		sessionRetention: z.union([z.string(), z.literal(false)]).optional()
	}).strict().optional(),
	hooks: z.object({
		enabled: z.boolean().optional(),
		path: z.string().optional(),
		token: z.string().optional(),
		allowedAgentIds: z.array(z.string()).optional(),
		maxBodyBytes: z.number().int().positive().optional(),
		presets: z.array(z.string()).optional(),
		transformsDir: z.string().optional(),
		mappings: z.array(HookMappingSchema).optional(),
		gmail: HooksGmailSchema,
		internal: InternalHooksSchema
	}).strict().optional(),
	web: z.object({
		enabled: z.boolean().optional(),
		heartbeatSeconds: z.number().int().positive().optional(),
		reconnect: z.object({
			initialMs: z.number().positive().optional(),
			maxMs: z.number().positive().optional(),
			factor: z.number().positive().optional(),
			jitter: z.number().min(0).max(1).optional(),
			maxAttempts: z.number().int().min(0).optional()
		}).strict().optional()
	}).strict().optional(),
	channels: ChannelsSchema,
	discovery: z.object({
		wideArea: z.object({ enabled: z.boolean().optional() }).strict().optional(),
		mdns: z.object({ mode: z.enum([
			"off",
			"minimal",
			"full"
		]).optional() }).strict().optional()
	}).strict().optional(),
	canvasHost: z.object({
		enabled: z.boolean().optional(),
		root: z.string().optional(),
		port: z.number().int().positive().optional(),
		liveReload: z.boolean().optional()
	}).strict().optional(),
	talk: z.object({
		voiceId: z.string().optional(),
		voiceAliases: z.record(z.string(), z.string()).optional(),
		modelId: z.string().optional(),
		outputFormat: z.string().optional(),
		apiKey: z.string().optional(),
		interruptOnSpeech: z.boolean().optional()
	}).strict().optional(),
	gateway: z.object({
		port: z.number().int().positive().optional(),
		mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
		bind: z.union([
			z.literal("auto"),
			z.literal("lan"),
			z.literal("loopback"),
			z.literal("custom"),
			z.literal("tailnet")
		]).optional(),
		controlUi: z.object({
			enabled: z.boolean().optional(),
			basePath: z.string().optional(),
			root: z.string().optional(),
			allowedOrigins: z.array(z.string()).optional(),
			allowInsecureAuth: z.boolean().optional(),
			dangerouslyDisableDeviceAuth: z.boolean().optional()
		}).strict().optional(),
		auth: z.object({
			mode: z.union([z.literal("token"), z.literal("password")]).optional(),
			token: z.string().optional(),
			password: z.string().optional(),
			allowTailscale: z.boolean().optional()
		}).strict().optional(),
		trustedProxies: z.array(z.string()).optional(),
		tailscale: z.object({
			mode: z.union([
				z.literal("off"),
				z.literal("serve"),
				z.literal("funnel")
			]).optional(),
			resetOnExit: z.boolean().optional()
		}).strict().optional(),
		remote: z.object({
			url: z.string().optional(),
			transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),
			token: z.string().optional(),
			password: z.string().optional(),
			tlsFingerprint: z.string().optional(),
			sshTarget: z.string().optional(),
			sshIdentity: z.string().optional()
		}).strict().optional(),
		reload: z.object({
			mode: z.union([
				z.literal("off"),
				z.literal("restart"),
				z.literal("hot"),
				z.literal("hybrid")
			]).optional(),
			debounceMs: z.number().int().min(0).optional()
		}).strict().optional(),
		tls: z.object({
			enabled: z.boolean().optional(),
			autoGenerate: z.boolean().optional(),
			certPath: z.string().optional(),
			keyPath: z.string().optional(),
			caPath: z.string().optional()
		}).optional(),
		http: z.object({ endpoints: z.object({
			chatCompletions: z.object({ enabled: z.boolean().optional() }).strict().optional(),
			responses: z.object({
				enabled: z.boolean().optional(),
				maxBodyBytes: z.number().int().positive().optional(),
				files: z.object({
					allowUrl: z.boolean().optional(),
					allowedMimes: z.array(z.string()).optional(),
					maxBytes: z.number().int().positive().optional(),
					maxChars: z.number().int().positive().optional(),
					maxRedirects: z.number().int().nonnegative().optional(),
					timeoutMs: z.number().int().positive().optional(),
					pdf: z.object({
						maxPages: z.number().int().positive().optional(),
						maxPixels: z.number().int().positive().optional(),
						minTextChars: z.number().int().nonnegative().optional()
					}).strict().optional()
				}).strict().optional(),
				images: z.object({
					allowUrl: z.boolean().optional(),
					allowedMimes: z.array(z.string()).optional(),
					maxBytes: z.number().int().positive().optional(),
					maxRedirects: z.number().int().nonnegative().optional(),
					timeoutMs: z.number().int().positive().optional()
				}).strict().optional()
			}).strict().optional()
		}).strict().optional() }).strict().optional(),
		nodes: z.object({
			browser: z.object({
				mode: z.union([
					z.literal("auto"),
					z.literal("manual"),
					z.literal("off")
				]).optional(),
				node: z.string().optional()
			}).strict().optional(),
			allowCommands: z.array(z.string()).optional(),
			denyCommands: z.array(z.string()).optional()
		}).strict().optional()
	}).strict().optional(),
	memory: MemorySchema,
	skills: z.object({
		allowBundled: z.array(z.string()).optional(),
		load: z.object({
			extraDirs: z.array(z.string()).optional(),
			watch: z.boolean().optional(),
			watchDebounceMs: z.number().int().min(0).optional()
		}).strict().optional(),
		install: z.object({
			preferBrew: z.boolean().optional(),
			nodeManager: z.union([
				z.literal("npm"),
				z.literal("pnpm"),
				z.literal("yarn"),
				z.literal("bun")
			]).optional()
		}).strict().optional(),
		entries: z.record(z.string(), z.object({
			enabled: z.boolean().optional(),
			apiKey: z.string().optional(),
			env: z.record(z.string(), z.string()).optional(),
			config: z.record(z.string(), z.unknown()).optional()
		}).strict()).optional()
	}).strict().optional(),
	plugins: z.object({
		enabled: z.boolean().optional(),
		allow: z.array(z.string()).optional(),
		deny: z.array(z.string()).optional(),
		load: z.object({ paths: z.array(z.string()).optional() }).strict().optional(),
		slots: z.object({ memory: z.string().optional() }).strict().optional(),
		entries: z.record(z.string(), z.object({
			enabled: z.boolean().optional(),
			config: z.record(z.string(), z.unknown()).optional()
		}).strict()).optional(),
		installs: z.record(z.string(), z.object({
			source: z.union([
				z.literal("npm"),
				z.literal("archive"),
				z.literal("path")
			]),
			spec: z.string().optional(),
			sourcePath: z.string().optional(),
			installPath: z.string().optional(),
			version: z.string().optional(),
			installedAt: z.string().optional()
		}).strict()).optional()
	}).strict().optional()
}).strict().superRefine((cfg, ctx) => {
	const agents = cfg.agents?.list ?? [];
	if (agents.length === 0) return;
	const agentIds = new Set(agents.map((agent) => agent.id));
	const broadcast = cfg.broadcast;
	if (!broadcast) return;
	for (const [peerId, ids] of Object.entries(broadcast)) {
		if (peerId === "strategy") continue;
		if (!Array.isArray(ids)) continue;
		for (let idx = 0; idx < ids.length; idx += 1) {
			const agentId = ids[idx];
			if (!agentIds.has(agentId)) ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [
					"broadcast",
					peerId,
					idx
				],
				message: `Unknown agent id "${agentId}" (not in agents.list).`
			});
		}
	}
});

//#endregion
//#region src/config/validation.ts
const AVATAR_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;
function isWorkspaceAvatarPath(value, workspaceDir) {
	const workspaceRoot = path.resolve(workspaceDir);
	const resolved = path.resolve(workspaceRoot, value);
	const relative = path.relative(workspaceRoot, resolved);
	if (relative === "") return true;
	if (relative.startsWith("..")) return false;
	return !path.isAbsolute(relative);
}
function validateIdentityAvatar(config) {
	const agents = config.agents?.list;
	if (!Array.isArray(agents) || agents.length === 0) return [];
	const issues = [];
	for (const [index, entry] of agents.entries()) {
		if (!entry || typeof entry !== "object") continue;
		const avatarRaw = entry.identity?.avatar;
		if (typeof avatarRaw !== "string") continue;
		const avatar = avatarRaw.trim();
		if (!avatar) continue;
		if (AVATAR_DATA_RE.test(avatar) || AVATAR_HTTP_RE.test(avatar)) continue;
		if (avatar.startsWith("~")) {
			issues.push({
				path: `agents.list.${index}.identity.avatar`,
				message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI."
			});
			continue;
		}
		if (AVATAR_SCHEME_RE.test(avatar) && !WINDOWS_ABS_RE.test(avatar)) {
			issues.push({
				path: `agents.list.${index}.identity.avatar`,
				message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI."
			});
			continue;
		}
		if (!isWorkspaceAvatarPath(avatar, resolveAgentWorkspaceDir(config, entry.id ?? resolveDefaultAgentId(config)))) issues.push({
			path: `agents.list.${index}.identity.avatar`,
			message: "identity.avatar must stay within the agent workspace."
		});
	}
	return issues;
}
function validateConfigObject(raw) {
	const legacyIssues = findLegacyConfigIssues(raw);
	if (legacyIssues.length > 0) return {
		ok: false,
		issues: legacyIssues.map((iss) => ({
			path: iss.path,
			message: iss.message
		}))
	};
	const validated = OpenClawSchema.safeParse(raw);
	if (!validated.success) return {
		ok: false,
		issues: validated.error.issues.map((iss) => ({
			path: iss.path.join("."),
			message: iss.message
		}))
	};
	const duplicates = findDuplicateAgentDirs(validated.data);
	if (duplicates.length > 0) return {
		ok: false,
		issues: [{
			path: "agents.list",
			message: formatDuplicateAgentDirError(duplicates)
		}]
	};
	const avatarIssues = validateIdentityAvatar(validated.data);
	if (avatarIssues.length > 0) return {
		ok: false,
		issues: avatarIssues
	};
	return {
		ok: true,
		config: applyModelDefaults(applyAgentDefaults(applySessionDefaults(validated.data)))
	};
}
function validateConfigObjectWithPlugins(raw) {
	const base = validateConfigObject(raw);
	if (!base.ok) return {
		ok: false,
		issues: base.issues,
		warnings: []
	};
	const config = base.config;
	const issues = [];
	const warnings = [];
	const pluginsConfig = config.plugins;
	const normalizedPlugins = normalizePluginsConfig(pluginsConfig);
	const registry = loadPluginManifestRegistry({
		config,
		workspaceDir: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)) ?? void 0
	});
	const knownIds = new Set(registry.plugins.map((record) => record.id));
	for (const diag of registry.diagnostics) {
		let path = diag.pluginId ? `plugins.entries.${diag.pluginId}` : "plugins";
		if (!diag.pluginId && diag.message.includes("plugin path not found")) path = "plugins.load.paths";
		const message = `${diag.pluginId ? `plugin ${diag.pluginId}` : "plugin"}: ${diag.message}`;
		if (diag.level === "error") issues.push({
			path,
			message
		});
		else warnings.push({
			path,
			message
		});
	}
	const entries = pluginsConfig?.entries;
	if (entries && isRecord(entries)) {
		for (const pluginId of Object.keys(entries)) if (!knownIds.has(pluginId)) issues.push({
			path: `plugins.entries.${pluginId}`,
			message: `plugin not found: ${pluginId}`
		});
	}
	const allow = pluginsConfig?.allow ?? [];
	for (const pluginId of allow) {
		if (typeof pluginId !== "string" || !pluginId.trim()) continue;
		if (!knownIds.has(pluginId)) issues.push({
			path: "plugins.allow",
			message: `plugin not found: ${pluginId}`
		});
	}
	const deny = pluginsConfig?.deny ?? [];
	for (const pluginId of deny) {
		if (typeof pluginId !== "string" || !pluginId.trim()) continue;
		if (!knownIds.has(pluginId)) issues.push({
			path: "plugins.deny",
			message: `plugin not found: ${pluginId}`
		});
	}
	const memorySlot = normalizedPlugins.slots.memory;
	if (typeof memorySlot === "string" && memorySlot.trim() && !knownIds.has(memorySlot)) issues.push({
		path: "plugins.slots.memory",
		message: `plugin not found: ${memorySlot}`
	});
	const allowedChannels = new Set(["defaults", ...CHANNEL_IDS]);
	for (const record of registry.plugins) for (const channelId of record.channels) allowedChannels.add(channelId);
	if (config.channels && isRecord(config.channels)) for (const key of Object.keys(config.channels)) {
		const trimmed = key.trim();
		if (!trimmed) continue;
		if (!allowedChannels.has(trimmed)) issues.push({
			path: `channels.${trimmed}`,
			message: `unknown channel id: ${trimmed}`
		});
	}
	const heartbeatChannelIds = /* @__PURE__ */ new Set();
	for (const channelId of CHANNEL_IDS) heartbeatChannelIds.add(channelId.toLowerCase());
	for (const record of registry.plugins) for (const channelId of record.channels) {
		const trimmed = channelId.trim();
		if (trimmed) heartbeatChannelIds.add(trimmed.toLowerCase());
	}
	const validateHeartbeatTarget = (target, path) => {
		if (typeof target !== "string") return;
		const trimmed = target.trim();
		if (!trimmed) {
			issues.push({
				path,
				message: "heartbeat target must not be empty"
			});
			return;
		}
		const normalized = trimmed.toLowerCase();
		if (normalized === "last" || normalized === "none") return;
		if (normalizeChatChannelId(trimmed)) return;
		if (heartbeatChannelIds.has(normalized)) return;
		issues.push({
			path,
			message: `unknown heartbeat target: ${target}`
		});
	};
	validateHeartbeatTarget(config.agents?.defaults?.heartbeat?.target, "agents.defaults.heartbeat.target");
	if (Array.isArray(config.agents?.list)) for (const [index, entry] of config.agents.list.entries()) validateHeartbeatTarget(entry?.heartbeat?.target, `agents.list.${index}.heartbeat.target`);
	let selectedMemoryPluginId = null;
	const seenPlugins = /* @__PURE__ */ new Set();
	for (const record of registry.plugins) {
		const pluginId = record.id;
		if (seenPlugins.has(pluginId)) continue;
		seenPlugins.add(pluginId);
		const entry = normalizedPlugins.entries[pluginId];
		const entryHasConfig = Boolean(entry?.config);
		const enableState = resolveEnableState(pluginId, record.origin, normalizedPlugins);
		let enabled = enableState.enabled;
		let reason = enableState.reason;
		if (enabled) {
			const memoryDecision = resolveMemorySlotDecision({
				id: pluginId,
				kind: record.kind,
				slot: memorySlot,
				selectedId: selectedMemoryPluginId
			});
			if (!memoryDecision.enabled) {
				enabled = false;
				reason = memoryDecision.reason;
			}
			if (memoryDecision.selected && record.kind === "memory") selectedMemoryPluginId = pluginId;
		}
		if (enabled || entryHasConfig) if (record.configSchema) {
			const res = validateJsonSchemaValue({
				schema: record.configSchema,
				cacheKey: record.schemaCacheKey ?? record.manifestPath ?? pluginId,
				value: entry?.config ?? {}
			});
			if (!res.ok) for (const error of res.errors) issues.push({
				path: `plugins.entries.${pluginId}.config`,
				message: `invalid config: ${error}`
			});
		} else issues.push({
			path: `plugins.entries.${pluginId}`,
			message: `plugin schema missing for ${pluginId}`
		});
		if (!enabled && entryHasConfig) warnings.push({
			path: `plugins.entries.${pluginId}`,
			message: `plugin disabled (${reason ?? "disabled"}) but config is present`
		});
	}
	if (issues.length > 0) return {
		ok: false,
		issues,
		warnings
	};
	return {
		ok: true,
		config,
		warnings
	};
}

//#endregion
//#region src/config/version.ts
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/;
function parseOpenClawVersion(raw) {
	if (!raw) return null;
	const match = raw.trim().match(VERSION_RE);
	if (!match) return null;
	const [, major, minor, patch, revision] = match;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10),
		revision: revision ? Number.parseInt(revision, 10) : 0
	};
}
function compareOpenClawVersions(a, b) {
	const parsedA = parseOpenClawVersion(a);
	const parsedB = parseOpenClawVersion(b);
	if (!parsedA || !parsedB) return null;
	if (parsedA.major !== parsedB.major) return parsedA.major < parsedB.major ? -1 : 1;
	if (parsedA.minor !== parsedB.minor) return parsedA.minor < parsedB.minor ? -1 : 1;
	if (parsedA.patch !== parsedB.patch) return parsedA.patch < parsedB.patch ? -1 : 1;
	if (parsedA.revision !== parsedB.revision) return parsedA.revision < parsedB.revision ? -1 : 1;
	return 0;
}

//#endregion
//#region src/config/io.ts
const SHELL_ENV_EXPECTED_KEYS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"GEMINI_API_KEY",
	"ZAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"MINIMAX_API_KEY",
	"SYNTHETIC_API_KEY",
	"ELEVENLABS_API_KEY",
	"TELEGRAM_BOT_TOKEN",
	"DISCORD_BOT_TOKEN",
	"SLACK_BOT_TOKEN",
	"SLACK_APP_TOKEN",
	"OPENCLAW_GATEWAY_TOKEN",
	"OPENCLAW_GATEWAY_PASSWORD"
];
const CONFIG_BACKUP_COUNT = 5;
const loggedInvalidConfigs = /* @__PURE__ */ new Set();
function hashConfigRaw(raw) {
	return crypto.createHash("sha256").update(raw ?? "").digest("hex");
}
function coerceConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}
async function rotateConfigBackups(configPath, ioFs) {
	if (CONFIG_BACKUP_COUNT <= 1) return;
	const backupBase = `${configPath}.bak`;
	const maxIndex = CONFIG_BACKUP_COUNT - 1;
	await ioFs.unlink(`${backupBase}.${maxIndex}`).catch(() => {});
	for (let index = maxIndex - 1; index >= 1; index -= 1) await ioFs.rename(`${backupBase}.${index}`, `${backupBase}.${index + 1}`).catch(() => {});
	await ioFs.rename(backupBase, `${backupBase}.1`).catch(() => {});
}
function warnOnConfigMiskeys(raw, logger) {
	if (!raw || typeof raw !== "object") return;
	const gateway = raw.gateway;
	if (!gateway || typeof gateway !== "object") return;
	if ("token" in gateway) logger.warn("Config uses \"gateway.token\". This key is ignored; use \"gateway.auth.token\" instead.");
}
function stampConfigVersion(cfg) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return {
		...cfg,
		meta: {
			...cfg.meta,
			lastTouchedVersion: VERSION,
			lastTouchedAt: now
		}
	};
}
function warnIfConfigFromFuture(cfg, logger) {
	const touched = cfg.meta?.lastTouchedVersion;
	if (!touched) return;
	const cmp = compareOpenClawVersions(VERSION, touched);
	if (cmp === null) return;
	if (cmp < 0) logger.warn(`Config was last written by a newer OpenClaw (${touched}); current version is ${VERSION}.`);
}
function applyConfigEnv(cfg, env) {
	const entries = collectConfigEnvVars(cfg);
	for (const [key, value] of Object.entries(entries)) {
		if (env[key]?.trim()) continue;
		env[key] = value;
	}
}
function resolveConfigPathForDeps(deps) {
	if (deps.configPath) return deps.configPath;
	return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir));
}
function normalizeDeps(overrides = {}) {
	return {
		fs: overrides.fs ?? fs,
		json5: overrides.json5 ?? JSON5,
		env: overrides.env ?? process.env,
		homedir: overrides.homedir ?? (() => resolveRequiredHomeDir(overrides.env ?? process.env, os.homedir)),
		configPath: overrides.configPath ?? "",
		logger: overrides.logger ?? console
	};
}
function maybeLoadDotEnvForConfig(env) {
	if (env !== process.env) return;
	loadDotEnv({ quiet: true });
}
function parseConfigJson5(raw, json5 = JSON5) {
	try {
		return {
			ok: true,
			parsed: json5.parse(raw)
		};
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
}
function createConfigIO(overrides = {}) {
	const deps = normalizeDeps(overrides);
	const requestedConfigPath = resolveConfigPathForDeps(deps);
	const configPath = (deps.configPath ? [requestedConfigPath] : resolveDefaultConfigCandidates(deps.env, deps.homedir)).find((candidate) => deps.fs.existsSync(candidate)) ?? requestedConfigPath;
	function loadConfig() {
		try {
			maybeLoadDotEnvForConfig(deps.env);
			if (!deps.fs.existsSync(configPath)) {
				if (shouldEnableShellEnvFallback(deps.env) && !shouldDeferShellEnvFallback(deps.env)) loadShellEnvFallback({
					enabled: true,
					env: deps.env,
					expectedKeys: SHELL_ENV_EXPECTED_KEYS,
					logger: deps.logger,
					timeoutMs: resolveShellEnvFallbackTimeoutMs(deps.env)
				});
				return {};
			}
			const raw = deps.fs.readFileSync(configPath, "utf-8");
			const resolved = resolveConfigIncludes(deps.json5.parse(raw), configPath, {
				readFile: (p) => deps.fs.readFileSync(p, "utf-8"),
				parseJson: (raw) => deps.json5.parse(raw)
			});
			if (resolved && typeof resolved === "object" && "env" in resolved) applyConfigEnv(resolved, deps.env);
			const resolvedConfig = resolveConfigEnvVars(resolved, deps.env);
			warnOnConfigMiskeys(resolvedConfig, deps.logger);
			if (typeof resolvedConfig !== "object" || resolvedConfig === null) return {};
			const preValidationDuplicates = findDuplicateAgentDirs(resolvedConfig, {
				env: deps.env,
				homedir: deps.homedir
			});
			if (preValidationDuplicates.length > 0) throw new DuplicateAgentDirError(preValidationDuplicates);
			const validated = validateConfigObjectWithPlugins(resolvedConfig);
			if (!validated.ok) {
				const details = validated.issues.map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`).join("\n");
				if (!loggedInvalidConfigs.has(configPath)) {
					loggedInvalidConfigs.add(configPath);
					deps.logger.error(`Invalid config at ${configPath}:\\n${details}`);
				}
				const error = /* @__PURE__ */ new Error("Invalid config");
				error.code = "INVALID_CONFIG";
				error.details = details;
				throw error;
			}
			if (validated.warnings.length > 0) {
				const details = validated.warnings.map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`).join("\n");
				deps.logger.warn(`Config warnings:\\n${details}`);
			}
			warnIfConfigFromFuture(validated.config, deps.logger);
			const cfg = applyModelDefaults(applyCompactionDefaults(applyContextPruningDefaults(applyAgentDefaults(applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config)))))));
			normalizeConfigPaths(cfg);
			const duplicates = findDuplicateAgentDirs(cfg, {
				env: deps.env,
				homedir: deps.homedir
			});
			if (duplicates.length > 0) throw new DuplicateAgentDirError(duplicates);
			applyConfigEnv(cfg, deps.env);
			if ((shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true) && !shouldDeferShellEnvFallback(deps.env)) loadShellEnvFallback({
				enabled: true,
				env: deps.env,
				expectedKeys: SHELL_ENV_EXPECTED_KEYS,
				logger: deps.logger,
				timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env)
			});
			return applyConfigOverrides(cfg);
		} catch (err) {
			if (err instanceof DuplicateAgentDirError) {
				deps.logger.error(err.message);
				throw err;
			}
			if (err?.code === "INVALID_CONFIG") return {};
			deps.logger.error(`Failed to read config at ${configPath}`, err);
			return {};
		}
	}
	async function readConfigFileSnapshot() {
		maybeLoadDotEnvForConfig(deps.env);
		if (!deps.fs.existsSync(configPath)) {
			const hash = hashConfigRaw(null);
			return {
				path: configPath,
				exists: false,
				raw: null,
				parsed: {},
				valid: true,
				config: applyTalkApiKey(applyModelDefaults(applyCompactionDefaults(applyContextPruningDefaults(applyAgentDefaults(applySessionDefaults(applyMessageDefaults({}))))))),
				hash,
				issues: [],
				warnings: [],
				legacyIssues: []
			};
		}
		try {
			const raw = deps.fs.readFileSync(configPath, "utf-8");
			const hash = hashConfigRaw(raw);
			const parsedRes = parseConfigJson5(raw, deps.json5);
			if (!parsedRes.ok) return {
				path: configPath,
				exists: true,
				raw,
				parsed: {},
				valid: false,
				config: {},
				hash,
				issues: [{
					path: "",
					message: `JSON5 parse failed: ${parsedRes.error}`
				}],
				warnings: [],
				legacyIssues: []
			};
			let resolved;
			try {
				resolved = resolveConfigIncludes(parsedRes.parsed, configPath, {
					readFile: (p) => deps.fs.readFileSync(p, "utf-8"),
					parseJson: (raw) => deps.json5.parse(raw)
				});
			} catch (err) {
				const message = err instanceof ConfigIncludeError ? err.message : `Include resolution failed: ${String(err)}`;
				return {
					path: configPath,
					exists: true,
					raw,
					parsed: parsedRes.parsed,
					valid: false,
					config: coerceConfig(parsedRes.parsed),
					hash,
					issues: [{
						path: "",
						message
					}],
					warnings: [],
					legacyIssues: []
				};
			}
			if (resolved && typeof resolved === "object" && "env" in resolved) applyConfigEnv(resolved, deps.env);
			let substituted;
			try {
				substituted = resolveConfigEnvVars(resolved, deps.env);
			} catch (err) {
				const message = err instanceof MissingEnvVarError ? err.message : `Env var substitution failed: ${String(err)}`;
				return {
					path: configPath,
					exists: true,
					raw,
					parsed: parsedRes.parsed,
					valid: false,
					config: coerceConfig(resolved),
					hash,
					issues: [{
						path: "",
						message
					}],
					warnings: [],
					legacyIssues: []
				};
			}
			const resolvedConfigRaw = substituted;
			const legacyIssues = findLegacyConfigIssues(resolvedConfigRaw);
			const validated = validateConfigObjectWithPlugins(resolvedConfigRaw);
			if (!validated.ok) return {
				path: configPath,
				exists: true,
				raw,
				parsed: parsedRes.parsed,
				valid: false,
				config: coerceConfig(resolvedConfigRaw),
				hash,
				issues: validated.issues,
				warnings: validated.warnings,
				legacyIssues
			};
			warnIfConfigFromFuture(validated.config, deps.logger);
			return {
				path: configPath,
				exists: true,
				raw,
				parsed: parsedRes.parsed,
				valid: true,
				config: normalizeConfigPaths(applyTalkApiKey(applyModelDefaults(applyAgentDefaults(applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))))))),
				hash,
				issues: [],
				warnings: validated.warnings,
				legacyIssues
			};
		} catch (err) {
			return {
				path: configPath,
				exists: true,
				raw: null,
				parsed: {},
				valid: false,
				config: {},
				hash: hashConfigRaw(null),
				issues: [{
					path: "",
					message: `read failed: ${String(err)}`
				}],
				warnings: [],
				legacyIssues: []
			};
		}
	}
	async function writeConfigFile(cfg) {
		clearConfigCache();
		const validated = validateConfigObjectWithPlugins(cfg);
		if (!validated.ok) {
			const issue = validated.issues[0];
			const pathLabel = issue?.path ? issue.path : "<root>";
			throw new Error(`Config validation failed: ${pathLabel}: ${issue?.message ?? "invalid"}`);
		}
		if (validated.warnings.length > 0) {
			const details = validated.warnings.map((warning) => `- ${warning.path}: ${warning.message}`).join("\n");
			deps.logger.warn(`Config warnings:\n${details}`);
		}
		const dir = path.dirname(configPath);
		await deps.fs.promises.mkdir(dir, {
			recursive: true,
			mode: 448
		});
		const json = JSON.stringify(applyModelDefaults(stampConfigVersion(cfg)), null, 2).trimEnd().concat("\n");
		const tmp = path.join(dir, `${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
		await deps.fs.promises.writeFile(tmp, json, {
			encoding: "utf-8",
			mode: 384
		});
		if (deps.fs.existsSync(configPath)) {
			await rotateConfigBackups(configPath, deps.fs.promises);
			await deps.fs.promises.copyFile(configPath, `${configPath}.bak`).catch(() => {});
		}
		try {
			await deps.fs.promises.rename(tmp, configPath);
		} catch (err) {
			const code = err.code;
			if (code === "EPERM" || code === "EEXIST") {
				await deps.fs.promises.copyFile(tmp, configPath);
				await deps.fs.promises.chmod(configPath, 384).catch(() => {});
				await deps.fs.promises.unlink(tmp).catch(() => {});
				return;
			}
			await deps.fs.promises.unlink(tmp).catch(() => {});
			throw err;
		}
	}
	return {
		configPath,
		loadConfig,
		readConfigFileSnapshot,
		writeConfigFile
	};
}
const DEFAULT_CONFIG_CACHE_MS = 200;
let configCache = null;
function resolveConfigCacheMs(env) {
	const raw = env.OPENCLAW_CONFIG_CACHE_MS?.trim();
	if (raw === "" || raw === "0") return 0;
	if (!raw) return DEFAULT_CONFIG_CACHE_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_CONFIG_CACHE_MS;
	return Math.max(0, parsed);
}
function shouldUseConfigCache(env) {
	if (env.OPENCLAW_DISABLE_CONFIG_CACHE?.trim()) return false;
	return resolveConfigCacheMs(env) > 0;
}
function clearConfigCache() {
	configCache = null;
}
function loadConfig() {
	const io = createConfigIO();
	const configPath = io.configPath;
	const now = Date.now();
	if (shouldUseConfigCache(process.env)) {
		const cached = configCache;
		if (cached && cached.configPath === configPath && cached.expiresAt > now) return cached.config;
	}
	const config = io.loadConfig();
	if (shouldUseConfigCache(process.env)) {
		const cacheMs = resolveConfigCacheMs(process.env);
		if (cacheMs > 0) configCache = {
			configPath,
			expiresAt: now + cacheMs,
			config
		};
	}
	return config;
}

//#endregion
//#region src/infra/device-identity.ts
const DEFAULT_DIR = path.join(STATE_DIR, "identity");
const DEFAULT_FILE = path.join(DEFAULT_DIR, "device.json");
function ensureDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function base64UrlEncode(buf) {
	return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function derivePublicKeyRaw(publicKeyPem) {
	const spki = crypto.createPublicKey(publicKeyPem).export({
		type: "spki",
		format: "der"
	});
	if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) return spki.subarray(ED25519_SPKI_PREFIX.length);
	return spki;
}
function fingerprintPublicKey(publicKeyPem) {
	const raw = derivePublicKeyRaw(publicKeyPem);
	return crypto.createHash("sha256").update(raw).digest("hex");
}
function generateIdentity() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	const publicKeyPem = publicKey.export({
		type: "spki",
		format: "pem"
	}).toString();
	const privateKeyPem = privateKey.export({
		type: "pkcs8",
		format: "pem"
	}).toString();
	return {
		deviceId: fingerprintPublicKey(publicKeyPem),
		publicKeyPem,
		privateKeyPem
	};
}
function loadOrCreateDeviceIdentity(filePath = DEFAULT_FILE) {
	try {
		if (fs.existsSync(filePath)) {
			const raw = fs.readFileSync(filePath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed?.version === 1 && typeof parsed.deviceId === "string" && typeof parsed.publicKeyPem === "string" && typeof parsed.privateKeyPem === "string") {
				const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
				if (derivedId && derivedId !== parsed.deviceId) {
					const updated = {
						...parsed,
						deviceId: derivedId
					};
					fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 384 });
					try {
						fs.chmodSync(filePath, 384);
					} catch {}
					return {
						deviceId: derivedId,
						publicKeyPem: parsed.publicKeyPem,
						privateKeyPem: parsed.privateKeyPem
					};
				}
				return {
					deviceId: parsed.deviceId,
					publicKeyPem: parsed.publicKeyPem,
					privateKeyPem: parsed.privateKeyPem
				};
			}
		}
	} catch {}
	const identity = generateIdentity();
	ensureDir(filePath);
	const stored = {
		version: 1,
		deviceId: identity.deviceId,
		publicKeyPem: identity.publicKeyPem,
		privateKeyPem: identity.privateKeyPem,
		createdAtMs: Date.now()
	};
	fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 384 });
	try {
		fs.chmodSync(filePath, 384);
	} catch {}
	return identity;
}
function signDevicePayload(privateKeyPem, payload) {
	const key = crypto.createPrivateKey(privateKeyPem);
	return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}
function publicKeyRawBase64UrlFromPem(publicKeyPem) {
	return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

//#endregion
//#region src/infra/tailnet.ts
function isTailnetIPv4(address) {
	const parts = address.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map((p) => Number.parseInt(p, 10));
	if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
	const [a, b] = octets;
	return a === 100 && b >= 64 && b <= 127;
}
function isTailnetIPv6(address) {
	return address.trim().toLowerCase().startsWith("fd7a:115c:a1e0:");
}
function listTailnetAddresses() {
	const ipv4 = [];
	const ipv6 = [];
	const ifaces = os.networkInterfaces();
	for (const entries of Object.values(ifaces)) {
		if (!entries) continue;
		for (const e of entries) {
			if (!e || e.internal) continue;
			const address = e.address?.trim();
			if (!address) continue;
			if (isTailnetIPv4(address)) ipv4.push(address);
			if (isTailnetIPv6(address)) ipv6.push(address);
		}
	}
	return {
		ipv4: [...new Set(ipv4)],
		ipv6: [...new Set(ipv6)]
	};
}
function pickPrimaryTailnetIPv4() {
	return listTailnetAddresses().ipv4[0];
}

//#endregion
//#region src/infra/tls/fingerprint.ts
function normalizeFingerprint(input) {
	return input.trim().replace(/^sha-?256\s*:?\s*/i, "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

//#endregion
//#region src/infra/tls/gateway.ts
const execFileAsync$1 = promisify(execFile);
async function fileExists(filePath) {
	try {
		await fs$1.access(filePath);
		return true;
	} catch {
		return false;
	}
}
async function generateSelfSignedCert(params) {
	const certDir = path.dirname(params.certPath);
	const keyDir = path.dirname(params.keyPath);
	await ensureDir$1(certDir);
	if (keyDir !== certDir) await ensureDir$1(keyDir);
	await execFileAsync$1("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-sha256",
		"-days",
		"3650",
		"-nodes",
		"-keyout",
		params.keyPath,
		"-out",
		params.certPath,
		"-subj",
		"/CN=openclaw-gateway"
	]);
	await fs$1.chmod(params.keyPath, 384).catch(() => {});
	await fs$1.chmod(params.certPath, 384).catch(() => {});
	params.log?.info?.(`gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`);
}
async function loadGatewayTlsRuntime(cfg, log) {
	if (!cfg || cfg.enabled !== true) return {
		enabled: false,
		required: false
	};
	const autoGenerate = cfg.autoGenerate !== false;
	const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
	const certPath = resolveUserPath(cfg.certPath ?? path.join(baseDir, "gateway-cert.pem"));
	const keyPath = resolveUserPath(cfg.keyPath ?? path.join(baseDir, "gateway-key.pem"));
	const caPath = cfg.caPath ? resolveUserPath(cfg.caPath) : void 0;
	const hasCert = await fileExists(certPath);
	const hasKey = await fileExists(keyPath);
	if (!hasCert && !hasKey && autoGenerate) try {
		await generateSelfSignedCert({
			certPath,
			keyPath,
			log
		});
	} catch (err) {
		return {
			enabled: false,
			required: true,
			certPath,
			keyPath,
			error: `gateway tls: failed to generate cert (${String(err)})`
		};
	}
	if (!await fileExists(certPath) || !await fileExists(keyPath)) return {
		enabled: false,
		required: true,
		certPath,
		keyPath,
		error: "gateway tls: cert/key missing"
	};
	try {
		const cert = await fs$1.readFile(certPath, "utf8");
		const key = await fs$1.readFile(keyPath, "utf8");
		const ca = caPath ? await fs$1.readFile(caPath, "utf8") : void 0;
		const fingerprintSha256 = normalizeFingerprint(new X509Certificate(cert).fingerprint256 ?? "");
		if (!fingerprintSha256) return {
			enabled: false,
			required: true,
			certPath,
			keyPath,
			caPath,
			error: "gateway tls: unable to compute certificate fingerprint"
		};
		return {
			enabled: true,
			required: true,
			certPath,
			keyPath,
			caPath,
			fingerprintSha256,
			tlsOptions: {
				cert,
				key,
				ca,
				minVersion: "TLSv1.3"
			}
		};
	} catch (err) {
		return {
			enabled: false,
			required: true,
			certPath,
			keyPath,
			caPath,
			error: `gateway tls: failed to load cert (${String(err)})`
		};
	}
}

//#endregion
//#region src/gateway/protocol/client-info.ts
const GATEWAY_CLIENT_IDS = {
	WEBCHAT_UI: "webchat-ui",
	CONTROL_UI: "openclaw-control-ui",
	WEBCHAT: "webchat",
	CLI: "cli",
	GATEWAY_CLIENT: "gateway-client",
	MACOS_APP: "openclaw-macos",
	IOS_APP: "openclaw-ios",
	ANDROID_APP: "openclaw-android",
	NODE_HOST: "node-host",
	TEST: "test",
	FINGERPRINT: "fingerprint",
	PROBE: "openclaw-probe"
};
const GATEWAY_CLIENT_NAMES = GATEWAY_CLIENT_IDS;
const GATEWAY_CLIENT_MODES = {
	WEBCHAT: "webchat",
	CLI: "cli",
	UI: "ui",
	BACKEND: "backend",
	NODE: "node",
	PROBE: "probe",
	TEST: "test"
};
const GATEWAY_CLIENT_ID_SET = new Set(Object.values(GATEWAY_CLIENT_IDS));
const GATEWAY_CLIENT_MODE_SET = new Set(Object.values(GATEWAY_CLIENT_MODES));

//#endregion
//#region src/infra/device-auth-store.ts
const DEVICE_AUTH_FILE = "device-auth.json";
function resolveDeviceAuthPath(env = process.env) {
	return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}
function normalizeRole(role) {
	return role.trim();
}
function normalizeScopes(scopes) {
	if (!Array.isArray(scopes)) return [];
	const out = /* @__PURE__ */ new Set();
	for (const scope of scopes) {
		const trimmed = scope.trim();
		if (trimmed) out.add(trimmed);
	}
	return [...out].toSorted();
}
function readStore(filePath) {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") return null;
		if (!parsed.tokens || typeof parsed.tokens !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}
function writeStore(filePath, store) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 384 });
	try {
		fs.chmodSync(filePath, 384);
	} catch {}
}
function loadDeviceAuthToken(params) {
	const store = readStore(resolveDeviceAuthPath(params.env));
	if (!store) return null;
	if (store.deviceId !== params.deviceId) return null;
	const role = normalizeRole(params.role);
	const entry = store.tokens[role];
	if (!entry || typeof entry.token !== "string") return null;
	return entry;
}
function storeDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	const existing = readStore(filePath);
	const role = normalizeRole(params.role);
	const next = {
		version: 1,
		deviceId: params.deviceId,
		tokens: existing && existing.deviceId === params.deviceId && existing.tokens ? { ...existing.tokens } : {}
	};
	const entry = {
		token: params.token,
		role,
		scopes: normalizeScopes(params.scopes),
		updatedAtMs: Date.now()
	};
	next.tokens[role] = entry;
	writeStore(filePath, next);
	return entry;
}
function clearDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	const store = readStore(filePath);
	if (!store || store.deviceId !== params.deviceId) return;
	const role = normalizeRole(params.role);
	if (!store.tokens[role]) return;
	const next = {
		version: 1,
		deviceId: store.deviceId,
		tokens: { ...store.tokens }
	};
	delete next.tokens[role];
	writeStore(filePath, next);
}

//#endregion
//#region src/infra/ws.ts
function rawDataToString(data, encoding = "utf8") {
	if (typeof data === "string") return data;
	if (Buffer$1.isBuffer(data)) return data.toString(encoding);
	if (Array.isArray(data)) return Buffer$1.concat(data).toString(encoding);
	if (data instanceof ArrayBuffer) return Buffer$1.from(data).toString(encoding);
	return Buffer$1.from(String(data)).toString(encoding);
}

//#endregion
//#region src/gateway/device-auth.ts
function buildDeviceAuthPayload(params) {
	const version = params.version ?? (params.nonce ? "v2" : "v1");
	const scopes = params.scopes.join(",");
	const token = params.token ?? "";
	const base = [
		version,
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token
	];
	if (version === "v2") base.push(params.nonce ?? "");
	return base.join("|");
}

//#endregion
//#region src/sessions/session-label.ts
const SESSION_LABEL_MAX_LENGTH = 64;

//#endregion
//#region src/gateway/protocol/schema/primitives.ts
const NonEmptyString = Type.String({ minLength: 1 });
const SessionLabelString = Type.String({
	minLength: 1,
	maxLength: SESSION_LABEL_MAX_LENGTH
});
const GatewayClientIdSchema = Type.Union(Object.values(GATEWAY_CLIENT_IDS).map((value) => Type.Literal(value)));
const GatewayClientModeSchema = Type.Union(Object.values(GATEWAY_CLIENT_MODES).map((value) => Type.Literal(value)));

//#endregion
//#region src/gateway/protocol/schema/agent.ts
const AgentEventSchema = Type.Object({
	runId: NonEmptyString,
	seq: Type.Integer({ minimum: 0 }),
	stream: NonEmptyString,
	ts: Type.Integer({ minimum: 0 }),
	data: Type.Record(Type.String(), Type.Unknown())
}, { additionalProperties: false });
const SendParamsSchema = Type.Object({
	to: NonEmptyString,
	message: Type.Optional(Type.String()),
	mediaUrl: Type.Optional(Type.String()),
	mediaUrls: Type.Optional(Type.Array(Type.String())),
	gifPlayback: Type.Optional(Type.Boolean()),
	channel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const PollParamsSchema = Type.Object({
	to: NonEmptyString,
	question: NonEmptyString,
	options: Type.Array(NonEmptyString, {
		minItems: 2,
		maxItems: 12
	}),
	maxSelections: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 12
	})),
	durationHours: Type.Optional(Type.Integer({ minimum: 1 })),
	channel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const AgentParamsSchema = Type.Object({
	message: NonEmptyString,
	agentId: Type.Optional(NonEmptyString),
	to: Type.Optional(Type.String()),
	replyTo: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	deliver: Type.Optional(Type.Boolean()),
	attachments: Type.Optional(Type.Array(Type.Unknown())),
	channel: Type.Optional(Type.String()),
	replyChannel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	replyAccountId: Type.Optional(Type.String()),
	threadId: Type.Optional(Type.String()),
	groupId: Type.Optional(Type.String()),
	groupChannel: Type.Optional(Type.String()),
	groupSpace: Type.Optional(Type.String()),
	timeout: Type.Optional(Type.Integer({ minimum: 0 })),
	lane: Type.Optional(Type.String()),
	extraSystemPrompt: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString,
	label: Type.Optional(SessionLabelString),
	spawnedBy: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentIdentityParamsSchema = Type.Object({
	agentId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentIdentityResultSchema = Type.Object({
	agentId: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	avatar: Type.Optional(NonEmptyString),
	emoji: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const AgentWaitParamsSchema = Type.Object({
	runId: NonEmptyString,
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const WakeParamsSchema = Type.Object({
	mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
	text: NonEmptyString
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/agents-models-skills.ts
const ModelChoiceSchema = Type.Object({
	id: NonEmptyString,
	name: NonEmptyString,
	provider: NonEmptyString,
	contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
	reasoning: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const AgentSummarySchema = Type.Object({
	id: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	identity: Type.Optional(Type.Object({
		name: Type.Optional(NonEmptyString),
		theme: Type.Optional(NonEmptyString),
		emoji: Type.Optional(NonEmptyString),
		avatar: Type.Optional(NonEmptyString),
		avatarUrl: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });
const AgentsListResultSchema = Type.Object({
	defaultId: NonEmptyString,
	mainKey: NonEmptyString,
	scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
	agents: Type.Array(AgentSummarySchema)
}, { additionalProperties: false });
const AgentsCreateParamsSchema = Type.Object({
	name: NonEmptyString,
	workspace: NonEmptyString,
	emoji: Type.Optional(Type.String()),
	avatar: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsCreateResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	name: NonEmptyString,
	workspace: NonEmptyString
}, { additionalProperties: false });
const AgentsUpdateParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	workspace: Type.Optional(NonEmptyString),
	model: Type.Optional(NonEmptyString),
	avatar: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsUpdateResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString
}, { additionalProperties: false });
const AgentsDeleteParamsSchema = Type.Object({
	agentId: NonEmptyString,
	deleteFiles: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const AgentsDeleteResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	removedBindings: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const AgentsFileEntrySchema = Type.Object({
	name: NonEmptyString,
	path: NonEmptyString,
	missing: Type.Boolean(),
	size: Type.Optional(Type.Integer({ minimum: 0 })),
	updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	content: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsFilesListParamsSchema = Type.Object({ agentId: NonEmptyString }, { additionalProperties: false });
const AgentsFilesListResultSchema = Type.Object({
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	files: Type.Array(AgentsFileEntrySchema)
}, { additionalProperties: false });
const AgentsFilesGetParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: NonEmptyString
}, { additionalProperties: false });
const AgentsFilesGetResultSchema = Type.Object({
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	file: AgentsFileEntrySchema
}, { additionalProperties: false });
const AgentsFilesSetParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: NonEmptyString,
	content: Type.String()
}, { additionalProperties: false });
const AgentsFilesSetResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	file: AgentsFileEntrySchema
}, { additionalProperties: false });
const ModelsListParamsSchema = Type.Object({}, { additionalProperties: false });
const ModelsListResultSchema = Type.Object({ models: Type.Array(ModelChoiceSchema) }, { additionalProperties: false });
const SkillsStatusParamsSchema = Type.Object({ agentId: Type.Optional(NonEmptyString) }, { additionalProperties: false });
const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });
const SkillsBinsResultSchema = Type.Object({ bins: Type.Array(NonEmptyString) }, { additionalProperties: false });
const SkillsInstallParamsSchema = Type.Object({
	name: NonEmptyString,
	installId: NonEmptyString,
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1e3 }))
}, { additionalProperties: false });
const SkillsUpdateParamsSchema = Type.Object({
	skillKey: NonEmptyString,
	enabled: Type.Optional(Type.Boolean()),
	apiKey: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(NonEmptyString, Type.String()))
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/channels.ts
const TalkModeParamsSchema = Type.Object({
	enabled: Type.Boolean(),
	phase: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChannelsStatusParamsSchema = Type.Object({
	probe: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ChannelAccountSnapshotSchema = Type.Object({
	accountId: NonEmptyString,
	name: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	configured: Type.Optional(Type.Boolean()),
	linked: Type.Optional(Type.Boolean()),
	running: Type.Optional(Type.Boolean()),
	connected: Type.Optional(Type.Boolean()),
	reconnectAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
	lastConnectedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastError: Type.Optional(Type.String()),
	lastStartAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastStopAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastInboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastOutboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastProbeAt: Type.Optional(Type.Integer({ minimum: 0 })),
	mode: Type.Optional(Type.String()),
	dmPolicy: Type.Optional(Type.String()),
	allowFrom: Type.Optional(Type.Array(Type.String())),
	tokenSource: Type.Optional(Type.String()),
	botTokenSource: Type.Optional(Type.String()),
	appTokenSource: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	allowUnmentionedGroups: Type.Optional(Type.Boolean()),
	cliPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	dbPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	port: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
	probe: Type.Optional(Type.Unknown()),
	audit: Type.Optional(Type.Unknown()),
	application: Type.Optional(Type.Unknown())
}, { additionalProperties: true });
const ChannelUiMetaSchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	detailLabel: NonEmptyString,
	systemImage: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChannelsStatusResultSchema = Type.Object({
	ts: Type.Integer({ minimum: 0 }),
	channelOrder: Type.Array(NonEmptyString),
	channelLabels: Type.Record(NonEmptyString, NonEmptyString),
	channelDetailLabels: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
	channelSystemImages: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
	channelMeta: Type.Optional(Type.Array(ChannelUiMetaSchema)),
	channels: Type.Record(NonEmptyString, Type.Unknown()),
	channelAccounts: Type.Record(NonEmptyString, Type.Array(ChannelAccountSnapshotSchema)),
	channelDefaultAccountId: Type.Record(NonEmptyString, NonEmptyString)
}, { additionalProperties: false });
const ChannelsLogoutParamsSchema = Type.Object({
	channel: NonEmptyString,
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const WebLoginStartParamsSchema = Type.Object({
	force: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	verbose: Type.Optional(Type.Boolean()),
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const WebLoginWaitParamsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/config.ts
const ConfigGetParamsSchema = Type.Object({}, { additionalProperties: false });
const ConfigSetParamsSchema = Type.Object({
	raw: NonEmptyString,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ConfigApplyParamsSchema = Type.Object({
	raw: NonEmptyString,
	baseHash: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ConfigPatchParamsSchema = Type.Object({
	raw: NonEmptyString,
	baseHash: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ConfigSchemaParamsSchema = Type.Object({}, { additionalProperties: false });
const UpdateRunParamsSchema = Type.Object({
	sessionKey: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const ConfigUiHintSchema = Type.Object({
	label: Type.Optional(Type.String()),
	help: Type.Optional(Type.String()),
	group: Type.Optional(Type.String()),
	order: Type.Optional(Type.Integer()),
	advanced: Type.Optional(Type.Boolean()),
	sensitive: Type.Optional(Type.Boolean()),
	placeholder: Type.Optional(Type.String()),
	itemTemplate: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const ConfigSchemaResponseSchema = Type.Object({
	schema: Type.Unknown(),
	uiHints: Type.Record(Type.String(), ConfigUiHintSchema),
	version: NonEmptyString,
	generatedAt: NonEmptyString
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/cron.ts
const CronScheduleSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("at"),
		at: NonEmptyString
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("every"),
		everyMs: Type.Integer({ minimum: 1 }),
		anchorMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("cron"),
		expr: NonEmptyString,
		tz: Type.Optional(Type.String())
	}, { additionalProperties: false })
]);
const CronPayloadSchema = Type.Union([Type.Object({
	kind: Type.Literal("systemEvent"),
	text: NonEmptyString
}, { additionalProperties: false }), Type.Object({
	kind: Type.Literal("agentTurn"),
	message: NonEmptyString,
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
	allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
	deliver: Type.Optional(Type.Boolean()),
	channel: Type.Optional(Type.String()),
	to: Type.Optional(Type.String()),
	bestEffortDeliver: Type.Optional(Type.Boolean())
}, { additionalProperties: false })]);
const CronPayloadPatchSchema = Type.Union([Type.Object({
	kind: Type.Literal("systemEvent"),
	text: Type.Optional(NonEmptyString)
}, { additionalProperties: false }), Type.Object({
	kind: Type.Literal("agentTurn"),
	message: Type.Optional(NonEmptyString),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
	allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
	deliver: Type.Optional(Type.Boolean()),
	channel: Type.Optional(Type.String()),
	to: Type.Optional(Type.String()),
	bestEffortDeliver: Type.Optional(Type.Boolean())
}, { additionalProperties: false })]);
const CronDeliverySchema = Type.Object({
	mode: Type.Union([Type.Literal("none"), Type.Literal("announce")]),
	channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
	to: Type.Optional(Type.String()),
	bestEffort: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const CronDeliveryPatchSchema = Type.Object({
	mode: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("announce")])),
	channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
	to: Type.Optional(Type.String()),
	bestEffort: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const CronJobStateSchema = Type.Object({
	nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastStatus: Type.Optional(Type.Union([
		Type.Literal("ok"),
		Type.Literal("error"),
		Type.Literal("skipped")
	])),
	lastError: Type.Optional(Type.String()),
	lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const CronJobSchema = Type.Object({
	id: NonEmptyString,
	agentId: Type.Optional(NonEmptyString),
	name: NonEmptyString,
	description: Type.Optional(Type.String()),
	enabled: Type.Boolean(),
	deleteAfterRun: Type.Optional(Type.Boolean()),
	createdAtMs: Type.Integer({ minimum: 0 }),
	updatedAtMs: Type.Integer({ minimum: 0 }),
	schedule: CronScheduleSchema,
	sessionTarget: Type.Union([Type.Literal("main"), Type.Literal("isolated")]),
	wakeMode: Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]),
	payload: CronPayloadSchema,
	delivery: Type.Optional(CronDeliverySchema),
	state: CronJobStateSchema
}, { additionalProperties: false });
const CronListParamsSchema = Type.Object({ includeDisabled: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
const CronStatusParamsSchema = Type.Object({}, { additionalProperties: false });
const CronAddParamsSchema = Type.Object({
	name: NonEmptyString,
	agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	description: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	deleteAfterRun: Type.Optional(Type.Boolean()),
	schedule: CronScheduleSchema,
	sessionTarget: Type.Union([Type.Literal("main"), Type.Literal("isolated")]),
	wakeMode: Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]),
	payload: CronPayloadSchema,
	delivery: Type.Optional(CronDeliverySchema)
}, { additionalProperties: false });
const CronJobPatchSchema = Type.Object({
	name: Type.Optional(NonEmptyString),
	agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	description: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	deleteAfterRun: Type.Optional(Type.Boolean()),
	schedule: Type.Optional(CronScheduleSchema),
	sessionTarget: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("isolated")])),
	wakeMode: Type.Optional(Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")])),
	payload: Type.Optional(CronPayloadPatchSchema),
	delivery: Type.Optional(CronDeliveryPatchSchema),
	state: Type.Optional(Type.Partial(CronJobStateSchema))
}, { additionalProperties: false });
const CronUpdateParamsSchema = Type.Union([Type.Object({
	id: NonEmptyString,
	patch: CronJobPatchSchema
}, { additionalProperties: false }), Type.Object({
	jobId: NonEmptyString,
	patch: CronJobPatchSchema
}, { additionalProperties: false })]);
const CronRemoveParamsSchema = Type.Union([Type.Object({ id: NonEmptyString }, { additionalProperties: false }), Type.Object({ jobId: NonEmptyString }, { additionalProperties: false })]);
const CronRunParamsSchema = Type.Union([Type.Object({
	id: NonEmptyString,
	mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")]))
}, { additionalProperties: false }), Type.Object({
	jobId: NonEmptyString,
	mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")]))
}, { additionalProperties: false })]);
const CronRunsParamsSchema = Type.Union([Type.Object({
	id: NonEmptyString,
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 5e3
	}))
}, { additionalProperties: false }), Type.Object({
	jobId: NonEmptyString,
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 5e3
	}))
}, { additionalProperties: false })]);
const CronRunLogEntrySchema = Type.Object({
	ts: Type.Integer({ minimum: 0 }),
	jobId: NonEmptyString,
	action: Type.Literal("finished"),
	status: Type.Optional(Type.Union([
		Type.Literal("ok"),
		Type.Literal("error"),
		Type.Literal("skipped")
	])),
	error: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	sessionId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(NonEmptyString),
	runAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/exec-approvals.ts
const ExecApprovalsAllowlistEntrySchema = Type.Object({
	id: Type.Optional(NonEmptyString),
	pattern: Type.String(),
	lastUsedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastUsedCommand: Type.Optional(Type.String()),
	lastResolvedPath: Type.Optional(Type.String())
}, { additionalProperties: false });
const ExecApprovalsDefaultsSchema = Type.Object({
	security: Type.Optional(Type.String()),
	ask: Type.Optional(Type.String()),
	askFallback: Type.Optional(Type.String()),
	autoAllowSkills: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ExecApprovalsAgentSchema = Type.Object({
	security: Type.Optional(Type.String()),
	ask: Type.Optional(Type.String()),
	askFallback: Type.Optional(Type.String()),
	autoAllowSkills: Type.Optional(Type.Boolean()),
	allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema))
}, { additionalProperties: false });
const ExecApprovalsFileSchema = Type.Object({
	version: Type.Literal(1),
	socket: Type.Optional(Type.Object({
		path: Type.Optional(Type.String()),
		token: Type.Optional(Type.String())
	}, { additionalProperties: false })),
	defaults: Type.Optional(ExecApprovalsDefaultsSchema),
	agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema))
}, { additionalProperties: false });
const ExecApprovalsSnapshotSchema = Type.Object({
	path: NonEmptyString,
	exists: Type.Boolean(),
	hash: NonEmptyString,
	file: ExecApprovalsFileSchema
}, { additionalProperties: false });
const ExecApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });
const ExecApprovalsSetParamsSchema = Type.Object({
	file: ExecApprovalsFileSchema,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ExecApprovalsNodeGetParamsSchema = Type.Object({ nodeId: NonEmptyString }, { additionalProperties: false });
const ExecApprovalsNodeSetParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	file: ExecApprovalsFileSchema,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ExecApprovalRequestParamsSchema = Type.Object({
	id: Type.Optional(NonEmptyString),
	command: NonEmptyString,
	cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	security: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	ask: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const ExecApprovalResolveParamsSchema = Type.Object({
	id: NonEmptyString,
	decision: NonEmptyString
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/devices.ts
const DevicePairListParamsSchema = Type.Object({}, { additionalProperties: false });
const DevicePairApproveParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const DevicePairRejectParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const DeviceTokenRotateParamsSchema = Type.Object({
	deviceId: NonEmptyString,
	role: NonEmptyString,
	scopes: Type.Optional(Type.Array(NonEmptyString))
}, { additionalProperties: false });
const DeviceTokenRevokeParamsSchema = Type.Object({
	deviceId: NonEmptyString,
	role: NonEmptyString
}, { additionalProperties: false });
const DevicePairRequestedEventSchema = Type.Object({
	requestId: NonEmptyString,
	deviceId: NonEmptyString,
	publicKey: NonEmptyString,
	displayName: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	clientId: Type.Optional(NonEmptyString),
	clientMode: Type.Optional(NonEmptyString),
	role: Type.Optional(NonEmptyString),
	roles: Type.Optional(Type.Array(NonEmptyString)),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	remoteIp: Type.Optional(NonEmptyString),
	silent: Type.Optional(Type.Boolean()),
	isRepair: Type.Optional(Type.Boolean()),
	ts: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const DevicePairResolvedEventSchema = Type.Object({
	requestId: NonEmptyString,
	deviceId: NonEmptyString,
	decision: NonEmptyString,
	ts: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/snapshot.ts
const PresenceEntrySchema = Type.Object({
	host: Type.Optional(NonEmptyString),
	ip: Type.Optional(NonEmptyString),
	version: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	modelIdentifier: Type.Optional(NonEmptyString),
	mode: Type.Optional(NonEmptyString),
	lastInputSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
	reason: Type.Optional(NonEmptyString),
	tags: Type.Optional(Type.Array(NonEmptyString)),
	text: Type.Optional(Type.String()),
	ts: Type.Integer({ minimum: 0 }),
	deviceId: Type.Optional(NonEmptyString),
	roles: Type.Optional(Type.Array(NonEmptyString)),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	instanceId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const HealthSnapshotSchema = Type.Any();
const SessionDefaultsSchema = Type.Object({
	defaultAgentId: NonEmptyString,
	mainKey: NonEmptyString,
	mainSessionKey: NonEmptyString,
	scope: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const StateVersionSchema = Type.Object({
	presence: Type.Integer({ minimum: 0 }),
	health: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const SnapshotSchema = Type.Object({
	presence: Type.Array(PresenceEntrySchema),
	health: HealthSnapshotSchema,
	stateVersion: StateVersionSchema,
	uptimeMs: Type.Integer({ minimum: 0 }),
	configPath: Type.Optional(NonEmptyString),
	stateDir: Type.Optional(NonEmptyString),
	sessionDefaults: Type.Optional(SessionDefaultsSchema)
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/frames.ts
const TickEventSchema = Type.Object({ ts: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const ShutdownEventSchema = Type.Object({
	reason: NonEmptyString,
	restartExpectedMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ConnectParamsSchema = Type.Object({
	minProtocol: Type.Integer({ minimum: 1 }),
	maxProtocol: Type.Integer({ minimum: 1 }),
	client: Type.Object({
		id: GatewayClientIdSchema,
		displayName: Type.Optional(NonEmptyString),
		version: NonEmptyString,
		platform: NonEmptyString,
		deviceFamily: Type.Optional(NonEmptyString),
		modelIdentifier: Type.Optional(NonEmptyString),
		mode: GatewayClientModeSchema,
		instanceId: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }),
	caps: Type.Optional(Type.Array(NonEmptyString, { default: [] })),
	commands: Type.Optional(Type.Array(NonEmptyString)),
	permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
	pathEnv: Type.Optional(Type.String()),
	role: Type.Optional(NonEmptyString),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	device: Type.Optional(Type.Object({
		id: NonEmptyString,
		publicKey: NonEmptyString,
		signature: NonEmptyString,
		signedAt: Type.Integer({ minimum: 0 }),
		nonce: Type.Optional(NonEmptyString)
	}, { additionalProperties: false })),
	auth: Type.Optional(Type.Object({
		token: Type.Optional(Type.String()),
		password: Type.Optional(Type.String())
	}, { additionalProperties: false })),
	locale: Type.Optional(Type.String()),
	userAgent: Type.Optional(Type.String())
}, { additionalProperties: false });
const HelloOkSchema = Type.Object({
	type: Type.Literal("hello-ok"),
	protocol: Type.Integer({ minimum: 1 }),
	server: Type.Object({
		version: NonEmptyString,
		commit: Type.Optional(NonEmptyString),
		host: Type.Optional(NonEmptyString),
		connId: NonEmptyString
	}, { additionalProperties: false }),
	features: Type.Object({
		methods: Type.Array(NonEmptyString),
		events: Type.Array(NonEmptyString)
	}, { additionalProperties: false }),
	snapshot: SnapshotSchema,
	canvasHostUrl: Type.Optional(NonEmptyString),
	auth: Type.Optional(Type.Object({
		deviceToken: NonEmptyString,
		role: NonEmptyString,
		scopes: Type.Array(NonEmptyString),
		issuedAtMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false })),
	policy: Type.Object({
		maxPayload: Type.Integer({ minimum: 1 }),
		maxBufferedBytes: Type.Integer({ minimum: 1 }),
		tickIntervalMs: Type.Integer({ minimum: 1 })
	}, { additionalProperties: false })
}, { additionalProperties: false });
const ErrorShapeSchema = Type.Object({
	code: NonEmptyString,
	message: NonEmptyString,
	details: Type.Optional(Type.Unknown()),
	retryable: Type.Optional(Type.Boolean()),
	retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const RequestFrameSchema = Type.Object({
	type: Type.Literal("req"),
	id: NonEmptyString,
	method: NonEmptyString,
	params: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const ResponseFrameSchema = Type.Object({
	type: Type.Literal("res"),
	id: NonEmptyString,
	ok: Type.Boolean(),
	payload: Type.Optional(Type.Unknown()),
	error: Type.Optional(ErrorShapeSchema)
}, { additionalProperties: false });
const EventFrameSchema = Type.Object({
	type: Type.Literal("event"),
	event: NonEmptyString,
	payload: Type.Optional(Type.Unknown()),
	seq: Type.Optional(Type.Integer({ minimum: 0 })),
	stateVersion: Type.Optional(StateVersionSchema)
}, { additionalProperties: false });
const GatewayFrameSchema = Type.Union([
	RequestFrameSchema,
	ResponseFrameSchema,
	EventFrameSchema
], { discriminator: "type" });

//#endregion
//#region src/gateway/protocol/schema/logs-chat.ts
const LogsTailParamsSchema = Type.Object({
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 5e3
	})),
	maxBytes: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 1e6
	}))
}, { additionalProperties: false });
const LogsTailResultSchema = Type.Object({
	file: NonEmptyString,
	cursor: Type.Integer({ minimum: 0 }),
	size: Type.Integer({ minimum: 0 }),
	lines: Type.Array(Type.String()),
	truncated: Type.Optional(Type.Boolean()),
	reset: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ChatHistoryParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 1e3
	}))
}, { additionalProperties: false });
const ChatSendParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	message: Type.String(),
	thinking: Type.Optional(Type.String()),
	deliver: Type.Optional(Type.Boolean()),
	attachments: Type.Optional(Type.Array(Type.Unknown())),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const ChatAbortParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	runId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ChatInjectParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	message: NonEmptyString,
	label: Type.Optional(Type.String({ maxLength: 100 }))
}, { additionalProperties: false });
const ChatEventSchema = Type.Object({
	runId: NonEmptyString,
	sessionKey: NonEmptyString,
	seq: Type.Integer({ minimum: 0 }),
	state: Type.Union([
		Type.Literal("delta"),
		Type.Literal("final"),
		Type.Literal("aborted"),
		Type.Literal("error")
	]),
	message: Type.Optional(Type.Unknown()),
	errorMessage: Type.Optional(Type.String()),
	usage: Type.Optional(Type.Unknown()),
	stopReason: Type.Optional(Type.String())
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/nodes.ts
const NodePairRequestParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	displayName: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	version: Type.Optional(NonEmptyString),
	coreVersion: Type.Optional(NonEmptyString),
	uiVersion: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	modelIdentifier: Type.Optional(NonEmptyString),
	caps: Type.Optional(Type.Array(NonEmptyString)),
	commands: Type.Optional(Type.Array(NonEmptyString)),
	remoteIp: Type.Optional(NonEmptyString),
	silent: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const NodePairListParamsSchema = Type.Object({}, { additionalProperties: false });
const NodePairApproveParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const NodePairRejectParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const NodePairVerifyParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	token: NonEmptyString
}, { additionalProperties: false });
const NodeRenameParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	displayName: NonEmptyString
}, { additionalProperties: false });
const NodeListParamsSchema = Type.Object({}, { additionalProperties: false });
const NodeDescribeParamsSchema = Type.Object({ nodeId: NonEmptyString }, { additionalProperties: false });
const NodeInvokeParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	command: NonEmptyString,
	params: Type.Optional(Type.Unknown()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const NodeInvokeResultParamsSchema = Type.Object({
	id: NonEmptyString,
	nodeId: NonEmptyString,
	ok: Type.Boolean(),
	payload: Type.Optional(Type.Unknown()),
	payloadJSON: Type.Optional(Type.String()),
	error: Type.Optional(Type.Object({
		code: Type.Optional(NonEmptyString),
		message: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const NodeEventParamsSchema = Type.Object({
	event: NonEmptyString,
	payload: Type.Optional(Type.Unknown()),
	payloadJSON: Type.Optional(Type.String())
}, { additionalProperties: false });
const NodeInvokeRequestEventSchema = Type.Object({
	id: NonEmptyString,
	nodeId: NonEmptyString,
	command: NonEmptyString,
	paramsJSON: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: Type.Optional(NonEmptyString)
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/sessions.ts
const SessionsListParamsSchema = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
	includeGlobal: Type.Optional(Type.Boolean()),
	includeUnknown: Type.Optional(Type.Boolean()),
	includeDerivedTitles: Type.Optional(Type.Boolean()),
	includeLastMessage: Type.Optional(Type.Boolean()),
	label: Type.Optional(SessionLabelString),
	spawnedBy: Type.Optional(NonEmptyString),
	agentId: Type.Optional(NonEmptyString),
	search: Type.Optional(Type.String())
}, { additionalProperties: false });
const SessionsPreviewParamsSchema = Type.Object({
	keys: Type.Array(NonEmptyString, { minItems: 1 }),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	maxChars: Type.Optional(Type.Integer({ minimum: 20 }))
}, { additionalProperties: false });
const SessionsResolveParamsSchema = Type.Object({
	key: Type.Optional(NonEmptyString),
	sessionId: Type.Optional(NonEmptyString),
	label: Type.Optional(SessionLabelString),
	agentId: Type.Optional(NonEmptyString),
	spawnedBy: Type.Optional(NonEmptyString),
	includeGlobal: Type.Optional(Type.Boolean()),
	includeUnknown: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsPatchParamsSchema = Type.Object({
	key: NonEmptyString,
	label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
	thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	verboseLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	reasoningLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	responseUsage: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("tokens"),
		Type.Literal("full"),
		Type.Literal("on"),
		Type.Null()
	])),
	elevatedLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execHost: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execSecurity: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execAsk: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execNode: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	spawnedBy: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	sendPolicy: Type.Optional(Type.Union([
		Type.Literal("allow"),
		Type.Literal("deny"),
		Type.Null()
	])),
	groupActivation: Type.Optional(Type.Union([
		Type.Literal("mention"),
		Type.Literal("always"),
		Type.Null()
	]))
}, { additionalProperties: false });
const SessionsResetParamsSchema = Type.Object({ key: NonEmptyString }, { additionalProperties: false });
const SessionsDeleteParamsSchema = Type.Object({
	key: NonEmptyString,
	deleteTranscript: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsCompactParamsSchema = Type.Object({
	key: NonEmptyString,
	maxLines: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const SessionsUsageParamsSchema = Type.Object({
	key: Type.Optional(NonEmptyString),
	startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	includeContextWeight: Type.Optional(Type.Boolean())
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/wizard.ts
const WizardStartParamsSchema = Type.Object({
	mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
	workspace: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardAnswerSchema = Type.Object({
	stepId: NonEmptyString,
	value: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const WizardNextParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	answer: Type.Optional(WizardAnswerSchema)
}, { additionalProperties: false });
const WizardCancelParamsSchema = Type.Object({ sessionId: NonEmptyString }, { additionalProperties: false });
const WizardStatusParamsSchema = Type.Object({ sessionId: NonEmptyString }, { additionalProperties: false });
const WizardStepOptionSchema = Type.Object({
	value: Type.Unknown(),
	label: NonEmptyString,
	hint: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardStepSchema = Type.Object({
	id: NonEmptyString,
	type: Type.Union([
		Type.Literal("note"),
		Type.Literal("select"),
		Type.Literal("text"),
		Type.Literal("confirm"),
		Type.Literal("multiselect"),
		Type.Literal("progress"),
		Type.Literal("action")
	]),
	title: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	options: Type.Optional(Type.Array(WizardStepOptionSchema)),
	initialValue: Type.Optional(Type.Unknown()),
	placeholder: Type.Optional(Type.String()),
	sensitive: Type.Optional(Type.Boolean()),
	executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")]))
}, { additionalProperties: false });
const WizardNextResultSchema = Type.Object({
	done: Type.Boolean(),
	step: Type.Optional(WizardStepSchema),
	status: Type.Optional(Type.Union([
		Type.Literal("running"),
		Type.Literal("done"),
		Type.Literal("cancelled"),
		Type.Literal("error")
	])),
	error: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardStartResultSchema = Type.Object({
	sessionId: NonEmptyString,
	done: Type.Boolean(),
	step: Type.Optional(WizardStepSchema),
	status: Type.Optional(Type.Union([
		Type.Literal("running"),
		Type.Literal("done"),
		Type.Literal("cancelled"),
		Type.Literal("error")
	])),
	error: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardStatusResultSchema = Type.Object({
	status: Type.Union([
		Type.Literal("running"),
		Type.Literal("done"),
		Type.Literal("cancelled"),
		Type.Literal("error")
	]),
	error: Type.Optional(Type.String())
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/protocol-schemas.ts
const PROTOCOL_VERSION = 3;

//#endregion
//#region src/gateway/protocol/index.ts
const ajv = new AjvPkg({
	allErrors: true,
	strict: false,
	removeAdditional: false
});
const validateConnectParams = ajv.compile(ConnectParamsSchema);
const validateRequestFrame = ajv.compile(RequestFrameSchema);
const validateResponseFrame = ajv.compile(ResponseFrameSchema);
const validateEventFrame = ajv.compile(EventFrameSchema);
const validateSendParams = ajv.compile(SendParamsSchema);
const validatePollParams = ajv.compile(PollParamsSchema);
const validateAgentParams = ajv.compile(AgentParamsSchema);
const validateAgentIdentityParams = ajv.compile(AgentIdentityParamsSchema);
const validateAgentWaitParams = ajv.compile(AgentWaitParamsSchema);
const validateWakeParams = ajv.compile(WakeParamsSchema);
const validateAgentsListParams = ajv.compile(AgentsListParamsSchema);
const validateAgentsCreateParams = ajv.compile(AgentsCreateParamsSchema);
const validateAgentsUpdateParams = ajv.compile(AgentsUpdateParamsSchema);
const validateAgentsDeleteParams = ajv.compile(AgentsDeleteParamsSchema);
const validateAgentsFilesListParams = ajv.compile(AgentsFilesListParamsSchema);
const validateAgentsFilesGetParams = ajv.compile(AgentsFilesGetParamsSchema);
const validateAgentsFilesSetParams = ajv.compile(AgentsFilesSetParamsSchema);
const validateNodePairRequestParams = ajv.compile(NodePairRequestParamsSchema);
const validateNodePairListParams = ajv.compile(NodePairListParamsSchema);
const validateNodePairApproveParams = ajv.compile(NodePairApproveParamsSchema);
const validateNodePairRejectParams = ajv.compile(NodePairRejectParamsSchema);
const validateNodePairVerifyParams = ajv.compile(NodePairVerifyParamsSchema);
const validateNodeRenameParams = ajv.compile(NodeRenameParamsSchema);
const validateNodeListParams = ajv.compile(NodeListParamsSchema);
const validateNodeDescribeParams = ajv.compile(NodeDescribeParamsSchema);
const validateNodeInvokeParams = ajv.compile(NodeInvokeParamsSchema);
const validateNodeInvokeResultParams = ajv.compile(NodeInvokeResultParamsSchema);
const validateNodeEventParams = ajv.compile(NodeEventParamsSchema);
const validateSessionsListParams = ajv.compile(SessionsListParamsSchema);
const validateSessionsPreviewParams = ajv.compile(SessionsPreviewParamsSchema);
const validateSessionsResolveParams = ajv.compile(SessionsResolveParamsSchema);
const validateSessionsPatchParams = ajv.compile(SessionsPatchParamsSchema);
const validateSessionsResetParams = ajv.compile(SessionsResetParamsSchema);
const validateSessionsDeleteParams = ajv.compile(SessionsDeleteParamsSchema);
const validateSessionsCompactParams = ajv.compile(SessionsCompactParamsSchema);
const validateSessionsUsageParams = ajv.compile(SessionsUsageParamsSchema);
const validateConfigGetParams = ajv.compile(ConfigGetParamsSchema);
const validateConfigSetParams = ajv.compile(ConfigSetParamsSchema);
const validateConfigApplyParams = ajv.compile(ConfigApplyParamsSchema);
const validateConfigPatchParams = ajv.compile(ConfigPatchParamsSchema);
const validateConfigSchemaParams = ajv.compile(ConfigSchemaParamsSchema);
const validateWizardStartParams = ajv.compile(WizardStartParamsSchema);
const validateWizardNextParams = ajv.compile(WizardNextParamsSchema);
const validateWizardCancelParams = ajv.compile(WizardCancelParamsSchema);
const validateWizardStatusParams = ajv.compile(WizardStatusParamsSchema);
const validateTalkModeParams = ajv.compile(TalkModeParamsSchema);
const validateChannelsStatusParams = ajv.compile(ChannelsStatusParamsSchema);
const validateChannelsLogoutParams = ajv.compile(ChannelsLogoutParamsSchema);
const validateModelsListParams = ajv.compile(ModelsListParamsSchema);
const validateSkillsStatusParams = ajv.compile(SkillsStatusParamsSchema);
const validateSkillsBinsParams = ajv.compile(SkillsBinsParamsSchema);
const validateSkillsInstallParams = ajv.compile(SkillsInstallParamsSchema);
const validateSkillsUpdateParams = ajv.compile(SkillsUpdateParamsSchema);
const validateCronListParams = ajv.compile(CronListParamsSchema);
const validateCronStatusParams = ajv.compile(CronStatusParamsSchema);
const validateCronAddParams = ajv.compile(CronAddParamsSchema);
const validateCronUpdateParams = ajv.compile(CronUpdateParamsSchema);
const validateCronRemoveParams = ajv.compile(CronRemoveParamsSchema);
const validateCronRunParams = ajv.compile(CronRunParamsSchema);
const validateCronRunsParams = ajv.compile(CronRunsParamsSchema);
const validateDevicePairListParams = ajv.compile(DevicePairListParamsSchema);
const validateDevicePairApproveParams = ajv.compile(DevicePairApproveParamsSchema);
const validateDevicePairRejectParams = ajv.compile(DevicePairRejectParamsSchema);
const validateDeviceTokenRotateParams = ajv.compile(DeviceTokenRotateParamsSchema);
const validateDeviceTokenRevokeParams = ajv.compile(DeviceTokenRevokeParamsSchema);
const validateExecApprovalsGetParams = ajv.compile(ExecApprovalsGetParamsSchema);
const validateExecApprovalsSetParams = ajv.compile(ExecApprovalsSetParamsSchema);
const validateExecApprovalRequestParams = ajv.compile(ExecApprovalRequestParamsSchema);
const validateExecApprovalResolveParams = ajv.compile(ExecApprovalResolveParamsSchema);
const validateExecApprovalsNodeGetParams = ajv.compile(ExecApprovalsNodeGetParamsSchema);
const validateExecApprovalsNodeSetParams = ajv.compile(ExecApprovalsNodeSetParamsSchema);
const validateLogsTailParams = ajv.compile(LogsTailParamsSchema);
const validateChatHistoryParams = ajv.compile(ChatHistoryParamsSchema);
const validateChatSendParams = ajv.compile(ChatSendParamsSchema);
const validateChatAbortParams = ajv.compile(ChatAbortParamsSchema);
const validateChatInjectParams = ajv.compile(ChatInjectParamsSchema);
const validateChatEvent = ajv.compile(ChatEventSchema);
const validateUpdateRunParams = ajv.compile(UpdateRunParamsSchema);
const validateWebLoginStartParams = ajv.compile(WebLoginStartParamsSchema);
const validateWebLoginWaitParams = ajv.compile(WebLoginWaitParamsSchema);

//#endregion
//#region src/gateway/client.ts
var GatewayClient = class {
	constructor(opts) {
		this.ws = null;
		this.pending = /* @__PURE__ */ new Map();
		this.backoffMs = 1e3;
		this.closed = false;
		this.lastSeq = null;
		this.connectNonce = null;
		this.connectSent = false;
		this.connectTimer = null;
		this.lastTick = null;
		this.tickIntervalMs = 3e4;
		this.tickTimer = null;
		this.opts = {
			...opts,
			deviceIdentity: opts.deviceIdentity ?? loadOrCreateDeviceIdentity()
		};
	}
	start() {
		if (this.closed) return;
		const url = this.opts.url ?? "ws://127.0.0.1:18789";
		if (this.opts.tlsFingerprint && !url.startsWith("wss://")) {
			this.opts.onConnectError?.(/* @__PURE__ */ new Error("gateway tls fingerprint requires wss:// gateway url"));
			return;
		}
		const wsOptions = { maxPayload: 25 * 1024 * 1024 };
		if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
			wsOptions.rejectUnauthorized = false;
			wsOptions.checkServerIdentity = ((_host, cert) => {
				const fingerprintValue = typeof cert === "object" && cert && "fingerprint256" in cert ? cert.fingerprint256 ?? "" : "";
				const fingerprint = normalizeFingerprint(typeof fingerprintValue === "string" ? fingerprintValue : "");
				const expected = normalizeFingerprint(this.opts.tlsFingerprint ?? "");
				if (!expected) return /* @__PURE__ */ new Error("gateway tls fingerprint missing");
				if (!fingerprint) return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
				if (fingerprint !== expected) return /* @__PURE__ */ new Error("gateway tls fingerprint mismatch");
			});
		}
		this.ws = new WebSocket(url, wsOptions);
		this.ws.on("open", () => {
			if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
				const tlsError = this.validateTlsFingerprint();
				if (tlsError) {
					this.opts.onConnectError?.(tlsError);
					this.ws?.close(1008, tlsError.message);
					return;
				}
			}
			this.queueConnect();
		});
		this.ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
		this.ws.on("close", (code, reason) => {
			const reasonText = rawDataToString(reason);
			this.ws = null;
			this.flushPendingErrors(/* @__PURE__ */ new Error(`gateway closed (${code}): ${reasonText}`));
			this.scheduleReconnect();
			this.opts.onClose?.(code, reasonText);
		});
		this.ws.on("error", (err) => {
			logDebug(`gateway client error: ${String(err)}`);
			if (!this.connectSent) this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
		});
	}
	stop() {
		this.closed = true;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.ws?.close();
		this.ws = null;
		this.flushPendingErrors(/* @__PURE__ */ new Error("gateway client stopped"));
	}
	sendConnect() {
		if (this.connectSent) return;
		this.connectSent = true;
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
		const role = this.opts.role ?? "operator";
		const storedToken = this.opts.deviceIdentity ? loadDeviceAuthToken({
			deviceId: this.opts.deviceIdentity.deviceId,
			role
		})?.token : null;
		const authToken = storedToken ?? this.opts.token ?? void 0;
		const canFallbackToShared = Boolean(storedToken && this.opts.token);
		const auth = authToken || this.opts.password ? {
			token: authToken,
			password: this.opts.password
		} : void 0;
		const signedAtMs = Date.now();
		const nonce = this.connectNonce ?? void 0;
		const scopes = this.opts.scopes ?? ["operator.admin"];
		const device = (() => {
			if (!this.opts.deviceIdentity) return;
			const payload = buildDeviceAuthPayload({
				deviceId: this.opts.deviceIdentity.deviceId,
				clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
				clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
				role,
				scopes,
				signedAtMs,
				token: authToken ?? null,
				nonce
			});
			const signature = signDevicePayload(this.opts.deviceIdentity.privateKeyPem, payload);
			return {
				id: this.opts.deviceIdentity.deviceId,
				publicKey: publicKeyRawBase64UrlFromPem(this.opts.deviceIdentity.publicKeyPem),
				signature,
				signedAt: signedAtMs,
				nonce
			};
		})();
		const params = {
			minProtocol: this.opts.minProtocol ?? PROTOCOL_VERSION,
			maxProtocol: this.opts.maxProtocol ?? PROTOCOL_VERSION,
			client: {
				id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
				displayName: this.opts.clientDisplayName,
				version: this.opts.clientVersion ?? "dev",
				platform: this.opts.platform ?? process.platform,
				mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
				instanceId: this.opts.instanceId
			},
			caps: Array.isArray(this.opts.caps) ? this.opts.caps : [],
			commands: Array.isArray(this.opts.commands) ? this.opts.commands : void 0,
			permissions: this.opts.permissions && typeof this.opts.permissions === "object" ? this.opts.permissions : void 0,
			pathEnv: this.opts.pathEnv,
			auth,
			role,
			scopes,
			device
		};
		this.request("connect", params).then((helloOk) => {
			const authInfo = helloOk?.auth;
			if (authInfo?.deviceToken && this.opts.deviceIdentity) storeDeviceAuthToken({
				deviceId: this.opts.deviceIdentity.deviceId,
				role: authInfo.role ?? role,
				token: authInfo.deviceToken,
				scopes: authInfo.scopes ?? []
			});
			this.backoffMs = 1e3;
			this.tickIntervalMs = typeof helloOk.policy?.tickIntervalMs === "number" ? helloOk.policy.tickIntervalMs : 3e4;
			this.lastTick = Date.now();
			this.startTickWatch();
			this.opts.onHelloOk?.(helloOk);
		}).catch((err) => {
			if (canFallbackToShared && this.opts.deviceIdentity) clearDeviceAuthToken({
				deviceId: this.opts.deviceIdentity.deviceId,
				role
			});
			this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
			const msg = `gateway connect failed: ${String(err)}`;
			if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE) logDebug(msg);
			else logError(msg);
			this.ws?.close(1008, "connect failed");
		});
	}
	handleMessage(raw) {
		try {
			const parsed = JSON.parse(raw);
			if (validateEventFrame(parsed)) {
				const evt = parsed;
				if (evt.event === "connect.challenge") {
					const payload = evt.payload;
					const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
					if (nonce) {
						this.connectNonce = nonce;
						this.sendConnect();
					}
					return;
				}
				const seq = typeof evt.seq === "number" ? evt.seq : null;
				if (seq !== null) {
					if (this.lastSeq !== null && seq > this.lastSeq + 1) this.opts.onGap?.({
						expected: this.lastSeq + 1,
						received: seq
					});
					this.lastSeq = seq;
				}
				if (evt.event === "tick") this.lastTick = Date.now();
				this.opts.onEvent?.(evt);
				return;
			}
			if (validateResponseFrame(parsed)) {
				const pending = this.pending.get(parsed.id);
				if (!pending) return;
				const status = parsed.payload?.status;
				if (pending.expectFinal && status === "accepted") return;
				this.pending.delete(parsed.id);
				if (parsed.ok) pending.resolve(parsed.payload);
				else pending.reject(new Error(parsed.error?.message ?? "unknown error"));
			}
		} catch (err) {
			logDebug(`gateway client parse error: ${String(err)}`);
		}
	}
	queueConnect() {
		this.connectNonce = null;
		this.connectSent = false;
		if (this.connectTimer) clearTimeout(this.connectTimer);
		this.connectTimer = setTimeout(() => {
			this.sendConnect();
		}, 750);
	}
	scheduleReconnect() {
		if (this.closed) return;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, 3e4);
		setTimeout(() => this.start(), delay).unref();
	}
	flushPendingErrors(err) {
		for (const [, p] of this.pending) p.reject(err);
		this.pending.clear();
	}
	startTickWatch() {
		if (this.tickTimer) clearInterval(this.tickTimer);
		const interval = Math.max(this.tickIntervalMs, 1e3);
		this.tickTimer = setInterval(() => {
			if (this.closed) return;
			if (!this.lastTick) return;
			if (Date.now() - this.lastTick > this.tickIntervalMs * 2) this.ws?.close(4e3, "tick timeout");
		}, interval);
	}
	validateTlsFingerprint() {
		if (!this.opts.tlsFingerprint || !this.ws) return null;
		const expected = normalizeFingerprint(this.opts.tlsFingerprint);
		if (!expected) return /* @__PURE__ */ new Error("gateway tls fingerprint missing");
		const socket = this.ws._socket;
		if (!socket || typeof socket.getPeerCertificate !== "function") return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
		const fingerprint = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256 ?? "");
		if (!fingerprint) return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
		if (fingerprint !== expected) return /* @__PURE__ */ new Error("gateway tls fingerprint mismatch");
		return null;
	}
	async request(method, params, opts) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("gateway not connected");
		const id = randomUUID();
		const frame = {
			type: "req",
			id,
			method,
			params
		};
		if (!validateRequestFrame(frame)) throw new Error(`invalid request frame: ${JSON.stringify(validateRequestFrame.errors, null, 2)}`);
		const expectFinal = opts?.expectFinal === true;
		const p = new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value),
				reject,
				expectFinal
			});
		});
		this.ws.send(JSON.stringify(frame));
		return p;
	}
};

//#endregion
//#region src/gateway/net.ts
/**
* Pick the primary non-internal IPv4 address (LAN IP).
* Prefers common interface names (en0, eth0) then falls back to any external IPv4.
*/
function pickPrimaryLanIPv4() {
	const nets = os.networkInterfaces();
	for (const name of ["en0", "eth0"]) {
		const entry = nets[name]?.find((n) => n.family === "IPv4" && !n.internal);
		if (entry?.address) return entry.address;
	}
	for (const list of Object.values(nets)) {
		const entry = list?.find((n) => n.family === "IPv4" && !n.internal);
		if (entry?.address) return entry.address;
	}
}

//#endregion
//#region src/gateway/call.ts
function resolveExplicitGatewayAuth(opts) {
	return {
		token: typeof opts?.token === "string" && opts.token.trim().length > 0 ? opts.token.trim() : void 0,
		password: typeof opts?.password === "string" && opts.password.trim().length > 0 ? opts.password.trim() : void 0
	};
}
function ensureExplicitGatewayAuth(params) {
	if (!params.urlOverride) return;
	if (params.auth.token || params.auth.password) return;
	const message = [
		"gateway url override requires explicit credentials",
		params.errorHint,
		params.configPath ? `Config: ${params.configPath}` : void 0
	].filter(Boolean).join("\n");
	throw new Error(message);
}
function buildGatewayConnectionDetails(options = {}) {
	const config = options.config ?? loadConfig();
	const configPath = options.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
	const isRemoteMode = config.gateway?.mode === "remote";
	const remote = isRemoteMode ? config.gateway?.remote : void 0;
	const tlsEnabled = config.gateway?.tls?.enabled === true;
	const localPort = resolveGatewayPort(config);
	const tailnetIPv4 = pickPrimaryTailnetIPv4();
	const bindMode = config.gateway?.bind ?? "loopback";
	const preferTailnet = bindMode === "tailnet" && !!tailnetIPv4;
	const preferLan = bindMode === "lan";
	const lanIPv4 = preferLan ? pickPrimaryLanIPv4() : void 0;
	const scheme = tlsEnabled ? "wss" : "ws";
	const localUrl = preferTailnet && tailnetIPv4 ? `${scheme}://${tailnetIPv4}:${localPort}` : preferLan && lanIPv4 ? `${scheme}://${lanIPv4}:${localPort}` : `${scheme}://127.0.0.1:${localPort}`;
	const urlOverride = typeof options.url === "string" && options.url.trim().length > 0 ? options.url.trim() : void 0;
	const remoteUrl = typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : void 0;
	const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
	const url = urlOverride || remoteUrl || localUrl;
	const urlSource = urlOverride ? "cli --url" : remoteUrl ? "config gateway.remote.url" : remoteMisconfigured ? "missing gateway.remote.url (fallback local)" : preferTailnet && tailnetIPv4 ? `local tailnet ${tailnetIPv4}` : preferLan && lanIPv4 ? `local lan ${lanIPv4}` : "local loopback";
	const remoteFallbackNote = remoteMisconfigured ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local." : void 0;
	const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : void 0;
	return {
		url,
		urlSource,
		bindDetail,
		remoteFallbackNote,
		message: [
			`Gateway target: ${url}`,
			`Source: ${urlSource}`,
			`Config: ${configPath}`,
			bindDetail,
			remoteFallbackNote
		].filter(Boolean).join("\n")
	};
}
async function callGateway(opts) {
	const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 1e4;
	const safeTimerTimeoutMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2147483647));
	const config = opts.config ?? loadConfig();
	const isRemoteMode = config.gateway?.mode === "remote";
	const remote = isRemoteMode ? config.gateway?.remote : void 0;
	const urlOverride = typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : void 0;
	const explicitAuth = resolveExplicitGatewayAuth({
		token: opts.token,
		password: opts.password
	});
	ensureExplicitGatewayAuth({
		urlOverride,
		auth: explicitAuth,
		errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
		configPath: opts.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env))
	});
	const remoteUrl = typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : void 0;
	if (isRemoteMode && !urlOverride && !remoteUrl) {
		const configPath = opts.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
		throw new Error([
			"gateway remote mode misconfigured: gateway.remote.url missing",
			`Config: ${configPath}`,
			"Fix: set gateway.remote.url, or set gateway.mode=local."
		].join("\n"));
	}
	const authToken = config.gateway?.auth?.token;
	const authPassword = config.gateway?.auth?.password;
	const connectionDetails = buildGatewayConnectionDetails({
		config,
		url: urlOverride,
		...opts.configPath ? { configPath: opts.configPath } : {}
	});
	const url = connectionDetails.url;
	const tlsRuntime = config.gateway?.tls?.enabled === true && !urlOverride && !remoteUrl && url.startsWith("wss://") ? await loadGatewayTlsRuntime(config.gateway?.tls) : void 0;
	const remoteTlsFingerprint = isRemoteMode && !urlOverride && remoteUrl && typeof remote?.tlsFingerprint === "string" ? remote.tlsFingerprint.trim() : void 0;
	const tlsFingerprint = (typeof opts.tlsFingerprint === "string" ? opts.tlsFingerprint.trim() : void 0) || remoteTlsFingerprint || (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : void 0);
	const token = explicitAuth.token || (!urlOverride ? isRemoteMode ? typeof remote?.token === "string" && remote.token.trim().length > 0 ? remote.token.trim() : void 0 : process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() || (typeof authToken === "string" && authToken.trim().length > 0 ? authToken.trim() : void 0) : void 0);
	const password = explicitAuth.password || (!urlOverride ? process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() || (isRemoteMode ? typeof remote?.password === "string" && remote.password.trim().length > 0 ? remote.password.trim() : void 0 : typeof authPassword === "string" && authPassword.trim().length > 0 ? authPassword.trim() : void 0) : void 0);
	const formatCloseError = (code, reason) => {
		const reasonText = reason?.trim() || "no close reason";
		const hint = code === 1006 ? "abnormal closure (no close frame)" : code === 1e3 ? "normal closure" : "";
		return `gateway closed (${code}${hint ? ` ${hint}` : ""}): ${reasonText}\n${connectionDetails.message}`;
	};
	const formatTimeoutError = () => `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
	return await new Promise((resolve, reject) => {
		let settled = false;
		let ignoreClose = false;
		const stop = (err, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) reject(err);
			else resolve(value);
		};
		const client = new GatewayClient({
			url,
			token,
			password,
			tlsFingerprint,
			instanceId: opts.instanceId ?? randomUUID(),
			clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
			clientDisplayName: opts.clientDisplayName,
			clientVersion: opts.clientVersion ?? "dev",
			platform: opts.platform,
			mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
			role: "operator",
			scopes: [
				"operator.admin",
				"operator.approvals",
				"operator.pairing"
			],
			deviceIdentity: loadOrCreateDeviceIdentity(),
			minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
			maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
			onHelloOk: async () => {
				try {
					const result = await client.request(opts.method, opts.params, { expectFinal: opts.expectFinal });
					ignoreClose = true;
					stop(void 0, result);
					client.stop();
				} catch (err) {
					ignoreClose = true;
					client.stop();
					stop(err);
				}
			},
			onClose: (code, reason) => {
				if (settled || ignoreClose) return;
				ignoreClose = true;
				client.stop();
				stop(new Error(formatCloseError(code, reason)));
			}
		});
		const timer = setTimeout(() => {
			ignoreClose = true;
			client.stop();
			stop(new Error(formatTimeoutError()));
		}, safeTimerTimeoutMs);
		client.start();
	});
}

//#endregion
//#region src/cli/progress.ts
const DEFAULT_DELAY_MS = 0;
let activeProgress = 0;
const noopReporter = {
	setLabel: () => {},
	setPercent: () => {},
	tick: () => {},
	done: () => {}
};
function createCliProgress(options) {
	if (options.enabled === false) return noopReporter;
	if (activeProgress > 0) return noopReporter;
	const stream = options.stream ?? process.stderr;
	const isTty = stream.isTTY;
	const allowLog = !isTty && options.fallback === "log";
	if (!isTty && !allowLog) return noopReporter;
	const delayMs = typeof options.delayMs === "number" ? options.delayMs : DEFAULT_DELAY_MS;
	const canOsc = isTty && supportsOscProgress(process.env, isTty);
	const allowSpinner = isTty && (options.fallback === void 0 || options.fallback === "spinner");
	const allowLine = isTty && options.fallback === "line";
	let started = false;
	let label = options.label;
	const total = options.total ?? null;
	let completed = 0;
	let percent = 0;
	let indeterminate = options.indeterminate ?? (options.total === void 0 || options.total === null);
	activeProgress += 1;
	if (isTty) registerActiveProgressLine(stream);
	const controller = canOsc ? createOscProgressController({
		env: process.env,
		isTty: stream.isTTY,
		write: (chunk) => stream.write(chunk)
	}) : null;
	const spin = allowSpinner ? spinner() : null;
	const renderLine = allowLine ? () => {
		if (!started) return;
		const suffix = indeterminate ? "" : ` ${percent}%`;
		clearActiveProgressLine();
		stream.write(`${theme.accent(label)}${suffix}`);
	} : null;
	const renderLog = allowLog ? (() => {
		let lastLine = "";
		let lastAt = 0;
		const throttleMs = 250;
		return () => {
			if (!started) return;
			const suffix = indeterminate ? "" : ` ${percent}%`;
			const nextLine = `${label}${suffix}`;
			const now = Date.now();
			if (nextLine === lastLine && now - lastAt < throttleMs) return;
			lastLine = nextLine;
			lastAt = now;
			stream.write(`${nextLine}\n`);
		};
	})() : null;
	let timer = null;
	const applyState = () => {
		if (!started) return;
		if (controller) if (indeterminate) controller.setIndeterminate(label);
		else controller.setPercent(label, percent);
		if (spin) spin.message(theme.accent(label));
		if (renderLine) renderLine();
		if (renderLog) renderLog();
	};
	const start = () => {
		if (started) return;
		started = true;
		if (spin) spin.start(theme.accent(label));
		applyState();
	};
	if (delayMs === 0) start();
	else timer = setTimeout(start, delayMs);
	const setLabel = (next) => {
		label = next;
		applyState();
	};
	const setPercent = (nextPercent) => {
		percent = Math.max(0, Math.min(100, Math.round(nextPercent)));
		indeterminate = false;
		applyState();
	};
	const tick = (delta = 1) => {
		if (!total) return;
		completed = Math.min(total, completed + delta);
		setPercent(total > 0 ? Math.round(completed / total * 100) : 0);
	};
	const done = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!started) {
			activeProgress = Math.max(0, activeProgress - 1);
			return;
		}
		if (controller) controller.clear();
		if (spin) spin.stop();
		clearActiveProgressLine();
		if (isTty) unregisterActiveProgressLine(stream);
		activeProgress = Math.max(0, activeProgress - 1);
	};
	return {
		setLabel,
		setPercent,
		tick,
		done
	};
}
async function withProgress(options, work) {
	const progress = createCliProgress(options);
	try {
		return await work(progress);
	} finally {
		progress.done();
	}
}

//#endregion
//#region src/cli/gateway-cli/call.ts
const gatewayCallOpts = (cmd) => cmd.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--password <password>", "Gateway password (password auth)").option("--timeout <ms>", "Timeout in ms", "10000").option("--expect-final", "Wait for final response (agent)", false).option("--json", "Output JSON", false);
const callGatewayCli = async (method, opts, params) => withProgress({
	label: `Gateway ${method}`,
	indeterminate: true,
	enabled: opts.json !== true
}, async () => await callGateway({
	url: opts.url,
	token: opts.token,
	password: opts.password,
	method,
	params,
	expectFinal: Boolean(opts.expectFinal),
	timeoutMs: Number(opts.timeout ?? 1e4),
	clientName: GATEWAY_CLIENT_NAMES.CLI,
	mode: GATEWAY_CLIENT_MODES.CLI
}));

//#endregion
//#region src/commands/status-client.ts
function resolveAuthMode(cfg) {
	const mode = cfg.gateway?.auth?.mode;
	if (mode === "token" || mode === "password") return mode;
	if (cfg.gateway?.auth?.token) return "token";
	if (cfg.gateway?.auth?.password) return "password";
	return "none";
}
function buildSummary() {
	const cfg = loadConfig();
	const configPath = resolveConfigPath();
	const stateDir = resolveStateDir();
	const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
	const tls = Boolean(cfg.gateway?.tls?.enabled);
	const port = resolveGatewayPort(cfg);
	const fallbackUrl = `${tls ? "wss" : "ws"}://127.0.0.1:${port}`;
	const remoteUrl = cfg.gateway?.remote?.url?.trim() || "";
	return {
		configPath,
		stateDir,
		gateway: {
			mode,
			url: mode === "remote" ? remoteUrl || fallbackUrl : fallbackUrl,
			tls,
			authMode: resolveAuthMode(cfg)
		}
	};
}
async function statusClientCommand(opts = {}) {
	const summary = buildSummary();
	if (opts.json) {
		console.log(JSON.stringify(summary, null, 2));
		return;
	}
	console.log("OpenClaw status (client build)");
	console.log(`Config: ${summary.configPath}`);
	console.log(`State:  ${summary.stateDir}`);
	console.log(`Gateway mode: ${summary.gateway.mode}`);
	console.log(`Gateway target: ${summary.gateway.url}`);
	console.log(`Gateway TLS: ${summary.gateway.tls ? "enabled" : "disabled"}`);
	console.log(`Gateway auth: ${summary.gateway.authMode}`);
}

//#endregion
//#region src/cli/gateway-cli/register-client.ts
function runGatewayCommand(action, label) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		const message = String(err);
		defaultRuntime.error(label ? `${label}: ${message}` : message);
		defaultRuntime.exit(1);
	});
}
function registerGatewayCliClient(program) {
	const gateway = program.command("gateway").description("Gateway RPC helpers (client build)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`);
	gatewayCallOpts(gateway.command("call").description("Call a Gateway method").argument("<method>", "Method name").option("--params <json>", "JSON object string for params", "{}").action(async (method, opts) => {
		await runGatewayCommand(async () => {
			const result = await callGatewayCli(method, opts, JSON.parse(String(opts.params ?? "{}")));
			if (opts.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			const rich = isRich();
			defaultRuntime.log(`${colorize(rich, theme.heading, "Gateway call")}: ${colorize(rich, theme.muted, String(method))}`);
			defaultRuntime.log(JSON.stringify(result, null, 2));
		}, "Gateway call failed");
	}));
	gateway.command("status").description("Show gateway target + connection info").option("--json", "Output JSON", false).action(async (opts) => {
		await runGatewayCommand(async () => {
			await statusClientCommand({ json: Boolean(opts.json) });
		}, "Gateway status failed");
	});
}

//#endregion
//#region src/node-host/config.ts
const NODE_HOST_FILE = "node.json";
function resolveNodeHostConfigPath() {
	return path.join(resolveStateDir(), NODE_HOST_FILE);
}
function normalizeConfig(config) {
	const base = {
		version: 1,
		nodeId: "",
		token: config?.token,
		displayName: config?.displayName,
		gateway: config?.gateway
	};
	if (config?.version === 1 && typeof config.nodeId === "string") base.nodeId = config.nodeId.trim();
	if (!base.nodeId) base.nodeId = crypto.randomUUID();
	return base;
}
async function loadNodeHostConfig() {
	const filePath = resolveNodeHostConfigPath();
	try {
		const raw = await fs$1.readFile(filePath, "utf8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return null;
	}
}
async function saveNodeHostConfig(config) {
	const filePath = resolveNodeHostConfigPath();
	await fs$1.mkdir(path.dirname(filePath), { recursive: true });
	const payload = JSON.stringify(config, null, 2);
	await fs$1.writeFile(filePath, `${payload}\n`, { mode: 384 });
	try {
		await fs$1.chmod(filePath, 384);
	} catch {}
}
async function ensureNodeHostConfig() {
	const normalized = normalizeConfig(await loadNodeHostConfig());
	await saveNodeHostConfig(normalized);
	return normalized;
}

//#endregion
//#region src/infra/machine-name.ts
const execFileAsync = promisify(execFile);
let cachedPromise = null;
async function tryScutil(key) {
	try {
		const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--get", key], {
			timeout: 1e3,
			windowsHide: true
		});
		const value = String(stdout ?? "").trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}
function fallbackHostName() {
	return os.hostname().replace(/\.local$/i, "").trim() || "openclaw";
}
async function getMachineDisplayName() {
	if (cachedPromise) return cachedPromise;
	cachedPromise = (async () => {
		if (process.env.VITEST || false) return fallbackHostName();
		if (process.platform === "darwin") {
			const computerName = await tryScutil("ComputerName");
			if (computerName) return computerName;
			const localHostName = await tryScutil("LocalHostName");
			if (localHostName) return localHostName;
		}
		return fallbackHostName();
	})();
	return cachedPromise;
}

//#endregion
//#region src/infra/brew.ts
function normalizePathValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function resolveBrewPathDirs(opts) {
	const homeDir = opts?.homeDir ?? os.homedir();
	const env = opts?.env ?? process.env;
	const dirs = [];
	const prefix = normalizePathValue(env.HOMEBREW_PREFIX);
	if (prefix) dirs.push(path.join(prefix, "bin"), path.join(prefix, "sbin"));
	dirs.push(path.join(homeDir, ".linuxbrew", "bin"));
	dirs.push(path.join(homeDir, ".linuxbrew", "sbin"));
	dirs.push("/home/linuxbrew/.linuxbrew/bin", "/home/linuxbrew/.linuxbrew/sbin");
	dirs.push("/opt/homebrew/bin", "/usr/local/bin");
	return dirs;
}

//#endregion
//#region src/infra/path-env.ts
function isExecutable(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function isDirectory(dirPath) {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}
function mergePath(params) {
	const partsExisting = params.existing.split(path.delimiter).map((part) => part.trim()).filter(Boolean);
	const partsPrepend = params.prepend.map((part) => part.trim()).filter(Boolean);
	const seen = /* @__PURE__ */ new Set();
	const merged = [];
	for (const part of [...partsPrepend, ...partsExisting]) if (!seen.has(part)) {
		seen.add(part);
		merged.push(part);
	}
	return merged.join(path.delimiter);
}
function candidateBinDirs(opts) {
	const execPath = opts.execPath ?? process.execPath;
	const cwd = opts.cwd ?? process.cwd();
	const homeDir = opts.homeDir ?? os.homedir();
	const platform = opts.platform ?? process.platform;
	const candidates = [];
	try {
		const execDir = path.dirname(execPath);
		if (isExecutable(path.join(execDir, "openclaw"))) candidates.push(execDir);
	} catch {}
	const localBinDir = path.join(cwd, "node_modules", ".bin");
	if (isExecutable(path.join(localBinDir, "openclaw"))) candidates.push(localBinDir);
	const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
	const miseShims = path.join(miseDataDir, "shims");
	if (isDirectory(miseShims)) candidates.push(miseShims);
	candidates.push(...resolveBrewPathDirs({ homeDir }));
	if (platform === "darwin") candidates.push(path.join(homeDir, "Library", "pnpm"));
	if (process.env.XDG_BIN_HOME) candidates.push(process.env.XDG_BIN_HOME);
	candidates.push(path.join(homeDir, ".local", "bin"));
	candidates.push(path.join(homeDir, ".local", "share", "pnpm"));
	candidates.push(path.join(homeDir, ".bun", "bin"));
	candidates.push(path.join(homeDir, ".yarn", "bin"));
	candidates.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
	return candidates.filter(isDirectory);
}
/**
* Best-effort PATH bootstrap so skills that require the `openclaw` CLI can run
* under launchd/minimal environments (and inside the macOS app bundle).
*/
function ensureOpenClawCliOnPath(opts = {}) {
	if (isTruthyEnvValue(process.env.OPENCLAW_PATH_BOOTSTRAPPED)) return;
	process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";
	const existing = opts.pathEnv ?? process.env.PATH ?? "";
	const prepend = candidateBinDirs(opts);
	if (prepend.length === 0) return;
	const merged = mergePath({
		existing,
		prepend
	});
	if (merged) process.env.PATH = merged;
}

//#endregion
//#region src/node-host/runner-client.ts
const OUTPUT_CAP = 2e5;
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
function sanitizeEnv(overrides) {
	if (!overrides) return;
	const merged = { ...process.env };
	const basePath = process.env.PATH ?? DEFAULT_NODE_PATH;
	for (const [rawKey, value] of Object.entries(overrides)) {
		const key = rawKey.trim();
		if (!key) continue;
		if (key.toUpperCase() === "PATH") {
			const trimmed = value.trim();
			if (!trimmed) continue;
			const suffix = `${path.delimiter}${basePath}`;
			merged[key] = trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
			continue;
		}
		merged[key] = value;
	}
	return merged;
}
function ensureNodePathEnv() {
	ensureOpenClawCliOnPath({ pathEnv: process.env.PATH ?? "" });
	const current = process.env.PATH ?? "";
	if (current.trim()) return current;
	process.env.PATH = DEFAULT_NODE_PATH;
	return DEFAULT_NODE_PATH;
}
async function runCommand(argv, cwd, env, timeoutMs) {
	return await new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let outputLen = 0;
		let timedOut = false;
		let settled = false;
		const child = spawn(argv[0], argv.slice(1), {
			cwd,
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		const onChunk = (chunk, target) => {
			if (outputLen >= OUTPUT_CAP) return;
			const remaining = OUTPUT_CAP - outputLen;
			const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
			const str = slice.toString("utf8");
			outputLen += slice.length;
			if (target === "stdout") stdout += str;
			else stderr += str;
		};
		child.stdout?.on("data", (chunk) => onChunk(chunk, "stdout"));
		child.stderr?.on("data", (chunk) => onChunk(chunk, "stderr"));
		let timer;
		if (timeoutMs && timeoutMs > 0) timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {}
		}, timeoutMs);
		const finalize = (exitCode, error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				exitCode,
				timedOut,
				success: exitCode === 0 && !timedOut && !error,
				stdout,
				stderr,
				error: error ?? null
			});
		};
		child.on("error", (err) => {
			finalize(void 0, err.message);
		});
		child.on("exit", (code) => {
			finalize(code === null ? void 0 : code, null);
		});
	});
}
function resolveEnvPath(env) {
	return (env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? DEFAULT_NODE_PATH).split(path.delimiter).filter(Boolean);
}
function resolveExecutable(bin, env) {
	if (bin.includes("/") || bin.includes("\\")) return null;
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.toLowerCase()) : [""];
	for (const dir of resolveEnvPath(env)) for (const ext of extensions) {
		const candidate = path.join(dir, bin + ext);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
async function handleSystemWhich(params, env) {
	const bins = params.bins.map((bin) => bin.trim()).filter(Boolean);
	const found = {};
	for (const bin of bins) {
		const resolved = resolveExecutable(bin, env);
		if (resolved) found[bin] = resolved;
	}
	return { bins: found };
}
async function runNodeHostClient(opts) {
	const config = await ensureNodeHostConfig();
	const nodeId = opts.nodeId?.trim() || config.nodeId;
	if (nodeId !== config.nodeId) config.nodeId = nodeId;
	const displayName = opts.displayName?.trim() || config.displayName || await getMachineDisplayName();
	config.displayName = displayName;
	const gateway = {
		host: opts.gatewayHost,
		port: opts.gatewayPort,
		tls: opts.gatewayTls ?? loadConfig().gateway?.tls?.enabled ?? false,
		tlsFingerprint: opts.gatewayTlsFingerprint
	};
	config.gateway = gateway;
	await saveNodeHostConfig(config);
	const cfg = loadConfig();
	const isRemoteMode = cfg.gateway?.mode === "remote";
	const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || (isRemoteMode ? cfg.gateway?.remote?.token : cfg.gateway?.auth?.token);
	const password = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || (isRemoteMode ? cfg.gateway?.remote?.password : cfg.gateway?.auth?.password);
	const host = gateway.host ?? "127.0.0.1";
	const port = gateway.port ?? 18789;
	const url = `${gateway.tls ? "wss" : "ws"}://${host}:${port}`;
	const pathEnv = ensureNodePathEnv();
	const client = new GatewayClient({
		url,
		token: token?.trim() || void 0,
		password: password?.trim() || void 0,
		instanceId: nodeId,
		clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
		clientDisplayName: displayName,
		clientVersion: VERSION,
		platform: process.platform,
		mode: GATEWAY_CLIENT_MODES.NODE,
		role: "node",
		scopes: [],
		caps: ["system"],
		commands: ["system.run", "system.which"],
		pathEnv,
		permissions: void 0,
		deviceIdentity: loadOrCreateDeviceIdentity(),
		tlsFingerprint: gateway.tlsFingerprint,
		onEvent: (evt) => {
			if (evt.event !== "node.invoke.request") return;
			const payload = coerceNodeInvokePayload(evt.payload);
			if (!payload) return;
			handleInvoke(payload, client);
		},
		onConnectError: (err) => {
			console.error(`node host gateway connect failed: ${err.message}`);
		},
		onClose: (code, reason) => {
			console.error(`node host gateway closed (${code}): ${reason}`);
		}
	});
	client.start();
	await new Promise(() => {});
}
async function handleInvoke(frame, client) {
	const command = String(frame.command ?? "");
	if (command === "system.which") {
		try {
			const params = decodeParams(frame.paramsJSON);
			if (!Array.isArray(params.bins)) throw new Error("INVALID_REQUEST: bins required");
			const payload = await handleSystemWhich(params, sanitizeEnv(void 0));
			await sendInvokeResult(client, frame, {
				ok: true,
				payloadJSON: JSON.stringify(payload)
			});
		} catch (err) {
			await sendInvokeResult(client, frame, {
				ok: false,
				error: {
					code: "INVALID_REQUEST",
					message: String(err)
				}
			});
		}
		return;
	}
	if (command !== "system.run") {
		await sendInvokeResult(client, frame, {
			ok: false,
			error: {
				code: "UNAVAILABLE",
				message: "command not supported"
			}
		});
		return;
	}
	let params;
	try {
		params = decodeParams(frame.paramsJSON);
	} catch (err) {
		await sendInvokeResult(client, frame, {
			ok: false,
			error: {
				code: "INVALID_REQUEST",
				message: String(err)
			}
		});
		return;
	}
	if (!Array.isArray(params.command) || params.command.length === 0) {
		await sendInvokeResult(client, frame, {
			ok: false,
			error: {
				code: "INVALID_REQUEST",
				message: "command required"
			}
		});
		return;
	}
	const argv = params.command.map((item) => String(item));
	const env = sanitizeEnv(params.env ?? void 0);
	const result = await runCommand(argv, params.cwd?.trim() || void 0, env, params.timeoutMs ?? void 0);
	await sendInvokeResult(client, frame, {
		ok: true,
		payloadJSON: JSON.stringify({
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			success: result.success,
			stdout: result.stdout,
			stderr: result.stderr,
			error: result.error ?? null
		})
	});
}
function decodeParams(raw) {
	if (!raw) throw new Error("INVALID_REQUEST: paramsJSON required");
	return JSON.parse(raw);
}
function coerceNodeInvokePayload(payload) {
	if (!payload || typeof payload !== "object") return null;
	const obj = payload;
	const id = typeof obj.id === "string" ? obj.id.trim() : "";
	const nodeId = typeof obj.nodeId === "string" ? obj.nodeId.trim() : "";
	const command = typeof obj.command === "string" ? obj.command.trim() : "";
	if (!id || !nodeId || !command) return null;
	return {
		id,
		nodeId,
		command,
		paramsJSON: typeof obj.paramsJSON === "string" ? obj.paramsJSON : obj.params !== void 0 ? JSON.stringify(obj.params) : null
	};
}
async function sendInvokeResult(client, frame, result) {
	try {
		await client.request("node.invoke.result", buildNodeInvokeResultParams(frame, result));
	} catch {}
}
function buildNodeInvokeResultParams(frame, result) {
	const params = {
		id: frame.id,
		nodeId: frame.nodeId,
		ok: result.ok
	};
	if (result.payload !== void 0) params.payload = result.payload;
	if (typeof result.payloadJSON === "string") params.payloadJSON = result.payloadJSON;
	if (result.error) params.error = result.error;
	return params;
}

//#endregion
//#region src/cli/node-cli/register-client.ts
function parsePort(value) {
	if (value === void 0 || value === null) return null;
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}
function parsePortWithFallback(value, fallback) {
	return parsePort(value) ?? fallback;
}
function registerNodeCliClient(program) {
	program.command("node").description("Run a headless node host (client build)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/node", "docs.openclaw.ai/cli/node")}\n`).command("run").description("Run the headless node host (foreground)").option("--host <host>", "Gateway host").option("--port <port>", "Gateway port").option("--tls", "Use TLS for the gateway connection", false).option("--tls-fingerprint <sha256>", "Expected TLS certificate fingerprint (sha256)").option("--node-id <id>", "Override node id").option("--display-name <name>", "Override node display name").action(async (opts) => {
		const existing = await loadNodeHostConfig();
		await runNodeHostClient({
			gatewayHost: opts.host?.trim() || existing?.gateway?.host || "127.0.0.1",
			gatewayPort: parsePortWithFallback(opts.port, existing?.gateway?.port ?? 18789),
			gatewayTls: Boolean(opts.tls) || Boolean(opts.tlsFingerprint),
			gatewayTlsFingerprint: opts.tlsFingerprint,
			nodeId: opts.nodeId,
			displayName: opts.displayName
		});
	});
}

//#endregion
//#region src/cli/profile.ts
function takeValue(raw, next) {
	if (raw.includes("=")) {
		const [, value] = raw.split("=", 2);
		return {
			value: (value ?? "").trim() || null,
			consumedNext: false
		};
	}
	return {
		value: (next ?? "").trim() || null,
		consumedNext: Boolean(next)
	};
}
function parseCliProfileArgs(argv) {
	if (argv.length < 2) return {
		ok: true,
		profile: null,
		argv
	};
	const out = argv.slice(0, 2);
	let profile = null;
	let sawDev = false;
	let sawCommand = false;
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === void 0) continue;
		if (sawCommand) {
			out.push(arg);
			continue;
		}
		if (arg === "--dev") {
			if (profile && profile !== "dev") return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};
			sawDev = true;
			profile = "dev";
			continue;
		}
		if (arg === "--profile" || arg.startsWith("--profile=")) {
			if (sawDev) return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};
			const next = args[i + 1];
			const { value, consumedNext } = takeValue(arg, next);
			if (consumedNext) i += 1;
			if (!value) return {
				ok: false,
				error: "--profile requires a value"
			};
			if (!isValidProfileName(value)) return {
				ok: false,
				error: "Invalid --profile (use letters, numbers, \"_\", \"-\" only)"
			};
			profile = value;
			continue;
		}
		if (!arg.startsWith("-")) {
			sawCommand = true;
			out.push(arg);
			continue;
		}
		out.push(arg);
	}
	return {
		ok: true,
		profile,
		argv: out
	};
}
function resolveProfileStateDir(profile, env, homedir) {
	const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
	return path.join(resolveRequiredHomeDir(env, homedir), `.openclaw${suffix}`);
}
function applyCliProfileEnv(params) {
	const env = params.env ?? process.env;
	const homedir = params.homedir ?? os.homedir;
	const profile = params.profile.trim();
	if (!profile) return;
	env.OPENCLAW_PROFILE = profile;
	const stateDir = env.OPENCLAW_STATE_DIR?.trim() || resolveProfileStateDir(profile, env, homedir);
	if (!env.OPENCLAW_STATE_DIR?.trim()) env.OPENCLAW_STATE_DIR = stateDir;
	if (!env.OPENCLAW_CONFIG_PATH?.trim()) env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
	if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) env.OPENCLAW_GATEWAY_PORT = "19001";
}

//#endregion
//#region src/infra/runtime-guard.ts
const MIN_NODE = {
	major: 22,
	minor: 12,
	patch: 0
};
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;
function parseSemver(version) {
	if (!version) return null;
	const match = version.match(SEMVER_RE);
	if (!match) return null;
	const [, major, minor, patch] = match;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10)
	};
}
function isAtLeast(version, minimum) {
	if (!version) return false;
	if (version.major !== minimum.major) return version.major > minimum.major;
	if (version.minor !== minimum.minor) return version.minor > minimum.minor;
	return version.patch >= minimum.patch;
}
function detectRuntime() {
	return {
		kind: process$1.versions?.node ? "node" : "unknown",
		version: process$1.versions?.node ?? null,
		execPath: process$1.execPath ?? null,
		pathEnv: process$1.env.PATH ?? "(not set)"
	};
}
function runtimeSatisfies(details) {
	const parsed = parseSemver(details.version);
	if (details.kind === "node") return isAtLeast(parsed, MIN_NODE);
	return false;
}
function assertSupportedRuntime(runtime = defaultRuntime, details = detectRuntime()) {
	if (runtimeSatisfies(details)) return;
	const versionLabel = details.version ?? "unknown";
	const runtimeLabel = details.kind === "unknown" ? "unknown runtime" : `${details.kind} ${versionLabel}`;
	const execLabel = details.execPath ?? "unknown";
	runtime.error([
		"openclaw requires Node >=22.12.0.",
		`Detected: ${runtimeLabel} (exec: ${execLabel}).`,
		`PATH searched: ${details.pathEnv}`,
		"Install Node: https://nodejs.org/en/download",
		"Upgrade Node and re-run openclaw."
	].join("\n"));
	runtime.exit(1);
}

//#endregion
//#region src/infra/unhandled-rejections.ts
const handlers = /* @__PURE__ */ new Set();
const FATAL_ERROR_CODES = new Set([
	"ERR_OUT_OF_MEMORY",
	"ERR_SCRIPT_EXECUTION_TIMEOUT",
	"ERR_WORKER_OUT_OF_MEMORY",
	"ERR_WORKER_UNCAUGHT_EXCEPTION",
	"ERR_WORKER_INITIALIZATION_FAILED"
]);
const CONFIG_ERROR_CODES = new Set([
	"INVALID_CONFIG",
	"MISSING_API_KEY",
	"MISSING_CREDENTIALS"
]);
const TRANSIENT_NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ENOTFOUND",
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
	"ECONNABORTED",
	"EPIPE",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_DNS_RESOLVE_FAILED",
	"UND_ERR_CONNECT",
	"UND_ERR_SOCKET",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT"
]);
function getErrorCause(err) {
	if (!err || typeof err !== "object") return;
	return err.cause;
}
function extractErrorCodeWithCause(err) {
	const direct = extractErrorCode(err);
	if (direct) return direct;
	return extractErrorCode(getErrorCause(err));
}
/**
* Checks if an error is an AbortError.
* These are typically intentional cancellations (e.g., during shutdown) and shouldn't crash.
*/
function isAbortError(err) {
	if (!err || typeof err !== "object") return false;
	if (("name" in err ? String(err.name) : "") === "AbortError") return true;
	if (("message" in err && typeof err.message === "string" ? err.message : "") === "This operation was aborted") return true;
	return false;
}
function isFatalError(err) {
	const code = extractErrorCodeWithCause(err);
	return code !== void 0 && FATAL_ERROR_CODES.has(code);
}
function isConfigError(err) {
	const code = extractErrorCodeWithCause(err);
	return code !== void 0 && CONFIG_ERROR_CODES.has(code);
}
/**
* Checks if an error is a transient network error that shouldn't crash the gateway.
* These are typically temporary connectivity issues that will resolve on their own.
*/
function isTransientNetworkError(err) {
	if (!err) return false;
	const code = extractErrorCodeWithCause(err);
	if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
	if (err instanceof TypeError && err.message === "fetch failed") {
		const cause = getErrorCause(err);
		if (cause) return isTransientNetworkError(cause);
		return true;
	}
	const cause = getErrorCause(err);
	if (cause && cause !== err) return isTransientNetworkError(cause);
	if (err instanceof AggregateError && err.errors?.length) return err.errors.some((e) => isTransientNetworkError(e));
	return false;
}
function isUnhandledRejectionHandled(reason) {
	for (const handler of handlers) try {
		if (handler(reason)) return true;
	} catch (err) {
		console.error("[openclaw] Unhandled rejection handler failed:", err instanceof Error ? err.stack ?? err.message : err);
	}
	return false;
}
function installUnhandledRejectionHandler() {
	process$1.on("unhandledRejection", (reason, _promise) => {
		if (isUnhandledRejectionHandled(reason)) return;
		if (isAbortError(reason)) {
			console.warn("[openclaw] Suppressed AbortError:", formatUncaughtError(reason));
			return;
		}
		if (isFatalError(reason)) {
			console.error("[openclaw] FATAL unhandled rejection:", formatUncaughtError(reason));
			process$1.exit(1);
			return;
		}
		if (isConfigError(reason)) {
			console.error("[openclaw] CONFIGURATION ERROR - requires fix:", formatUncaughtError(reason));
			process$1.exit(1);
			return;
		}
		if (isTransientNetworkError(reason)) {
			console.warn("[openclaw] Non-fatal unhandled rejection (continuing):", formatUncaughtError(reason));
			return;
		}
		console.error("[openclaw] Unhandled promise rejection:", formatUncaughtError(reason));
		process$1.exit(1);
	});
}

//#endregion
//#region src/infra/warning-filter.ts
const warningFilterKey = Symbol.for("openclaw.warning-filter");
function shouldIgnoreWarning(warning) {
	if (warning.code === "DEP0040" && warning.message?.includes("punycode")) return true;
	if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) return true;
	if (warning.name === "ExperimentalWarning" && warning.message?.includes("SQLite is an experimental feature")) return true;
	return false;
}
function normalizeWarningArgs(args) {
	const warningArg = args[0];
	const secondArg = args[1];
	const thirdArg = args[2];
	let name;
	let code;
	let message;
	if (warningArg instanceof Error) {
		name = warningArg.name;
		message = warningArg.message;
		code = warningArg.code;
	} else if (typeof warningArg === "string") message = warningArg;
	if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
		const options = secondArg;
		if (typeof options.type === "string") name = options.type;
		if (typeof options.code === "string") code = options.code;
	} else {
		if (typeof secondArg === "string") name = secondArg;
		if (typeof thirdArg === "string") code = thirdArg;
	}
	return {
		name,
		code,
		message
	};
}
function installProcessWarningFilter() {
	const globalState = globalThis;
	if (globalState[warningFilterKey]?.installed) return;
	const originalEmitWarning = process.emitWarning.bind(process);
	const wrappedEmitWarning = ((...args) => {
		if (shouldIgnoreWarning(normalizeWarningArgs(args))) return;
		return Reflect.apply(originalEmitWarning, process, args);
	});
	process.emitWarning = wrappedEmitWarning;
	globalState[warningFilterKey] = { installed: true };
}

//#endregion
//#region src/entry-client.ts
process$1.title = "openclaw";
installProcessWarningFilter();
loadDotEnv({ quiet: true });
normalizeEnv();
ensureOpenClawCliOnPath();
enableConsoleCapture();
assertSupportedRuntime();
if (process$1.argv.includes("--no-color")) {
	process$1.env.NO_COLOR = "1";
	process$1.env.FORCE_COLOR = "0";
}
const parsed = parseCliProfileArgs(process$1.argv);
if (!parsed.ok) {
	const parseError = parsed.error;
	console.error(`[openclaw] ${parseError}`);
	process$1.exit(2);
}
const selectedProfile = parsed.profile;
if (selectedProfile) {
	applyCliProfileEnv({ profile: selectedProfile });
	process$1.argv = parsed.argv;
}
const program = new Command();
program.name("openclaw").description("OpenClaw client CLI (node + gateway RPC)").version(VERSION).option("--profile <name>", "Use a named profile (isolates OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH under ~/.openclaw-<name>)").option("--dev", "Dev profile: isolate state under ~/.openclaw-dev and default gateway port 19001", false).option("--no-color", "Disable ANSI colors", false).showHelpAfterError(true);
program.configureHelp({
	sortSubcommands: true,
	sortOptions: true,
	optionTerm: (option) => theme.option(option.flags),
	subcommandTerm: (cmd) => theme.command(cmd.name())
});
program.configureOutput({
	writeOut: (str) => {
		const colored = str.replace(/^Usage:/gm, theme.heading("Usage:")).replace(/^Options:/gm, theme.heading("Options:")).replace(/^Commands:/gm, theme.heading("Commands:"));
		process$1.stdout.write(colored);
	},
	writeErr: (str) => process$1.stderr.write(str),
	outputError: (str, write) => write(theme.error(str))
});
registerNodeCliClient(program);
registerGatewayCliClient(program);
program.command("status").description("Show local config + gateway target summary").option("--json", "Output JSON", false).action(async (opts) => {
	await statusClientCommand({ json: Boolean(opts.json) });
});
program.addHelpText("afterAll", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli", "docs.openclaw.ai/cli")}\n${theme.muted("Client build includes:")} node, gateway call/status/probe, status`);
installUnhandledRejectionHandler();
process$1.on("uncaughtException", (error) => {
	console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
	process$1.exit(1);
});
await program.parseAsync(process$1.argv).catch((err) => {
	const rich = isRich();
	console.error(colorize(rich, theme.error, `[openclaw] CLI failed: ${formatUncaughtError(err)}`));
	process$1.exit(1);
});

//#endregion
export {  };