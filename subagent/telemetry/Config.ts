import { isIP } from "node:net";

export type TelemetrySignal = "traces" | "metrics" | "logs";
export type TelemetryLogLevel = "debug" | "info" | "warn" | "error";
export type TelemetryConfigIssueCode =
	| "invalid_enabled"
	| "invalid_allow_remote"
	| "invalid_endpoint"
	| "remote_not_allowed"
	| "remote_requires_https"
	| "endpoint_credentials"
	| "invalid_sample_ratio"
	| "invalid_metric_interval"
	| "invalid_log_level"
	| "invalid_service_name"
	| "invalid_headers";

export interface TelemetryConfigIssue {
	code: TelemetryConfigIssueCode;
	field: string;
	message: string;
}

export interface TelemetrySignalConfig {
	endpoint: URL;
	headers: Readonly<Record<string, string>>;
}

export interface SubagentTelemetryConfig {
	/** True only when telemetry was requested and all exporter settings passed validation. */
	enabled: boolean;
	/** Whether PI_SUBAGENT_OTEL_ENABLED requested telemetry, even if validation disabled it. */
	requestedEnabled: boolean;
	allowRemote: boolean;
	serviceName: string;
	traceSampleRatio: number;
	metricExportIntervalMs: number;
	logLevel: TelemetryLogLevel;
	traces: TelemetrySignalConfig;
	metrics: TelemetrySignalConfig;
	logs: TelemetrySignalConfig;
	prometheusUrl: URL;
	jaegerUrl: URL;
	queryHeaders: Readonly<Record<string, string>>;
	issues: readonly TelemetryConfigIssue[];
}

export interface LoadTelemetryConfigOptions {
	env?: NodeJS.ProcessEnv;
}

const DEFAULT_OTLP_BASE = "http://127.0.0.1:4318";
const DEFAULT_PROMETHEUS_URL = "http://127.0.0.1:9090";
const DEFAULT_JAEGER_URL = "http://127.0.0.1:16686";
const DEFAULT_SERVICE_NAME = "pi-subagent-extension";
const DEFAULT_TRACE_SAMPLE_RATIO = 1;
const DEFAULT_METRIC_INTERVAL_MS = 10_000;
const MIN_METRIC_INTERVAL_MS = 1_000;
const MAX_METRIC_INTERVAL_MS = 300_000;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_NAME_CHARS = 128;
const MAX_HEADER_VALUE_CHARS = 8_192;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", ""]);
const LOG_LEVELS = new Set<TelemetryLogLevel>(["debug", "info", "warn", "error"]);

function issue(code: TelemetryConfigIssueCode, field: string, message: string): TelemetryConfigIssue {
	return { code, field, message };
}

function parseBoolean(
	raw: string | undefined,
	defaultValue: boolean,
	field: string,
	code: "invalid_enabled" | "invalid_allow_remote",
	issues: TelemetryConfigIssue[],
): boolean {
	if (raw === undefined) return defaultValue;
	const value = raw.trim().toLowerCase();
	if (TRUE_VALUES.has(value)) return true;
	if (FALSE_VALUES.has(value)) return false;
	issues.push(issue(code, field, `${field} must be one of 1/0, true/false, yes/no, or on/off.`));
	return defaultValue;
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
	const ipVersion = isIP(normalized);
	if (ipVersion === 4) return normalized.split(".")[0] === "127";
	return ipVersion === 6 && normalized === "::1";
}

function validateUrl(
	raw: string,
	field: string,
	allowRemote: boolean,
	issues: TelemetryConfigIssue[],
): URL | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		issues.push(issue("invalid_endpoint", field, `${field} must be a valid absolute HTTP(S) URL.`));
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		issues.push(issue("invalid_endpoint", field, `${field} must use http:// or https://.`));
		return undefined;
	}
	if (!url.hostname) {
		issues.push(issue("invalid_endpoint", field, `${field} must include a hostname.`));
		return undefined;
	}
	if (url.username || url.password) {
		issues.push(issue("endpoint_credentials", field, `${field} must not contain URL credentials; use exporter/query headers instead.`));
		return undefined;
	}
	if (!isLoopbackHostname(url.hostname)) {
		if (!allowRemote) {
			issues.push(issue("remote_not_allowed", field, `${field} is remote; set PI_SUBAGENT_OTEL_ALLOW_REMOTE=1 to opt in.`));
			return undefined;
		}
		if (url.protocol !== "https:") {
			issues.push(issue("remote_requires_https", field, `${field} must use HTTPS for remote telemetry.`));
			return undefined;
		}
	}
	url.hash = "";
	return url;
}

function appendSignalPath(base: URL, signal: TelemetrySignal): URL {
	const result = new URL(base.toString());
	const expectedSuffix = `/v1/${signal}`;
	const pathname = result.pathname.replace(/\/+$/, "");
	if (!pathname.endsWith(expectedSuffix)) result.pathname = `${pathname}${expectedSuffix}`.replace(/^\/\//, "/");
	result.search = "";
	result.hash = "";
	return result;
}

function parseJsonHeaders(raw: string | undefined, field: string, issues: TelemetryConfigIssue[]): Readonly<Record<string, string>> {
	if (!raw?.trim()) return Object.freeze({});
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		issues.push(issue("invalid_headers", field, `${field} must be a JSON object containing string header values.`));
		return Object.freeze({});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		issues.push(issue("invalid_headers", field, `${field} must be a JSON object containing string header values.`));
		return Object.freeze({});
	}
	const entries = Object.entries(parsed as Record<string, unknown>);
	if (entries.length > MAX_HEADER_COUNT) {
		issues.push(issue("invalid_headers", field, `${field} may contain at most ${MAX_HEADER_COUNT} headers.`));
		return Object.freeze({});
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of entries) {
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.length > MAX_HEADER_NAME_CHARS || typeof value !== "string" || value.length > MAX_HEADER_VALUE_CHARS) {
			issues.push(issue("invalid_headers", field, `${field} contains an invalid header name or non-string/oversized value.`));
			return Object.freeze({});
		}
		headers[name] = value;
	}
	return Object.freeze(headers);
}

/** Parse the W3C-style comma-delimited OTEL_EXPORTER_OTLP_*_HEADERS format. */
function parseOtelHeaders(raw: string | undefined, field: string, issues: TelemetryConfigIssue[]): Readonly<Record<string, string>> {
	if (!raw?.trim()) return Object.freeze({});
	const headers: Record<string, string> = {};
	const parts = raw.split(",");
	if (parts.length > MAX_HEADER_COUNT) {
		issues.push(issue("invalid_headers", field, `${field} may contain at most ${MAX_HEADER_COUNT} headers.`));
		return Object.freeze({});
	}
	for (const part of parts) {
		const separator = part.indexOf("=");
		if (separator <= 0) {
			issues.push(issue("invalid_headers", field, `${field} must use comma-delimited name=value entries.`));
			return Object.freeze({});
		}
		const name = part.slice(0, separator).trim();
		let value: string;
		try {
			value = decodeURIComponent(part.slice(separator + 1).trim());
		} catch {
			issues.push(issue("invalid_headers", field, `${field} contains invalid percent-encoding.`));
			return Object.freeze({});
		}
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.length > MAX_HEADER_NAME_CHARS || value.length > MAX_HEADER_VALUE_CHARS) {
			issues.push(issue("invalid_headers", field, `${field} contains an invalid header name or oversized value.`));
			return Object.freeze({});
		}
		headers[name] = value;
	}
	return Object.freeze(headers);
}

function signalEndpointEnv(signal: TelemetrySignal): string {
	return `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`;
}

function signalHeadersEnv(signal: TelemetrySignal): string {
	return `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`;
}

function fallbackUrl(rawFallback: string): URL {
	return new URL(rawFallback);
}

export function loadSubagentTelemetryConfig(options: LoadTelemetryConfigOptions = {}): SubagentTelemetryConfig {
	const env = options.env ?? process.env;
	const issues: TelemetryConfigIssue[] = [];
	const requestedEnabled = parseBoolean(env.PI_SUBAGENT_OTEL_ENABLED, false, "PI_SUBAGENT_OTEL_ENABLED", "invalid_enabled", issues);
	const allowRemote = parseBoolean(env.PI_SUBAGENT_OTEL_ALLOW_REMOTE, false, "PI_SUBAGENT_OTEL_ALLOW_REMOTE", "invalid_allow_remote", issues);

	const serviceName = env.PI_SUBAGENT_OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
	if (serviceName.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(serviceName)) {
		issues.push(issue("invalid_service_name", "PI_SUBAGENT_OTEL_SERVICE_NAME", "PI_SUBAGENT_OTEL_SERVICE_NAME must be 1-128 characters using letters, digits, dot, underscore, or hyphen."));
	}

	const rawSampleRatio = env.PI_SUBAGENT_OTEL_TRACE_SAMPLE_RATIO;
	const traceSampleRatio = rawSampleRatio === undefined ? DEFAULT_TRACE_SAMPLE_RATIO : Number(rawSampleRatio);
	if (!Number.isFinite(traceSampleRatio) || traceSampleRatio < 0 || traceSampleRatio > 1) {
		issues.push(issue("invalid_sample_ratio", "PI_SUBAGENT_OTEL_TRACE_SAMPLE_RATIO", "PI_SUBAGENT_OTEL_TRACE_SAMPLE_RATIO must be a number from 0 through 1."));
	}

	const rawMetricInterval = env.PI_SUBAGENT_OTEL_METRIC_INTERVAL_MS;
	const metricExportIntervalMs = rawMetricInterval === undefined ? DEFAULT_METRIC_INTERVAL_MS : Number(rawMetricInterval);
	if (!Number.isInteger(metricExportIntervalMs) || metricExportIntervalMs < MIN_METRIC_INTERVAL_MS || metricExportIntervalMs > MAX_METRIC_INTERVAL_MS) {
		issues.push(issue("invalid_metric_interval", "PI_SUBAGENT_OTEL_METRIC_INTERVAL_MS", `PI_SUBAGENT_OTEL_METRIC_INTERVAL_MS must be an integer from ${MIN_METRIC_INTERVAL_MS} through ${MAX_METRIC_INTERVAL_MS}.`));
	}

	const rawLogLevel = (env.PI_SUBAGENT_OTEL_LOG_LEVEL ?? "info").trim().toLowerCase();
	const logLevel = LOG_LEVELS.has(rawLogLevel as TelemetryLogLevel) ? rawLogLevel as TelemetryLogLevel : "info";
	if (!LOG_LEVELS.has(rawLogLevel as TelemetryLogLevel)) {
		issues.push(issue("invalid_log_level", "PI_SUBAGENT_OTEL_LOG_LEVEL", "PI_SUBAGENT_OTEL_LOG_LEVEL must be debug, info, warn, or error."));
	}

	const baseRaw = env.PI_SUBAGENT_OTEL_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_BASE;
	const base = validateUrl(baseRaw, env.PI_SUBAGENT_OTEL_ENDPOINT !== undefined ? "PI_SUBAGENT_OTEL_ENDPOINT" : env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined ? "OTEL_EXPORTER_OTLP_ENDPOINT" : "default OTLP endpoint", allowRemote, issues)
		?? fallbackUrl(DEFAULT_OTLP_BASE);
	const sharedHeaders = parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS, "OTEL_EXPORTER_OTLP_HEADERS", issues);

	const signalConfigs = {} as Record<TelemetrySignal, TelemetrySignalConfig>;
	for (const signal of ["traces", "metrics", "logs"] as const) {
		const endpointField = signalEndpointEnv(signal);
		const explicitRaw = env[endpointField];
		const endpoint = explicitRaw
			? validateUrl(explicitRaw, endpointField, allowRemote, issues) ?? appendSignalPath(fallbackUrl(DEFAULT_OTLP_BASE), signal)
			: appendSignalPath(base, signal);
		const headersField = signalHeadersEnv(signal);
		const headers = env[headersField] !== undefined ? parseOtelHeaders(env[headersField], headersField, issues) : sharedHeaders;
		signalConfigs[signal] = { endpoint, headers };
	}

	const prometheusUrl = validateUrl(env.PI_SUBAGENT_PROMETHEUS_URL ?? DEFAULT_PROMETHEUS_URL, "PI_SUBAGENT_PROMETHEUS_URL", allowRemote, issues)
		?? fallbackUrl(DEFAULT_PROMETHEUS_URL);
	const jaegerUrl = validateUrl(env.PI_SUBAGENT_JAEGER_URL ?? DEFAULT_JAEGER_URL, "PI_SUBAGENT_JAEGER_URL", allowRemote, issues)
		?? fallbackUrl(DEFAULT_JAEGER_URL);
	const queryHeaders = parseJsonHeaders(env.PI_SUBAGENT_OTEL_QUERY_HEADERS, "PI_SUBAGENT_OTEL_QUERY_HEADERS", issues);

	return {
		enabled: requestedEnabled && issues.length === 0,
		requestedEnabled,
		allowRemote,
		serviceName: serviceName.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(serviceName) ? serviceName : DEFAULT_SERVICE_NAME,
		traceSampleRatio: Number.isFinite(traceSampleRatio) && traceSampleRatio >= 0 && traceSampleRatio <= 1 ? traceSampleRatio : DEFAULT_TRACE_SAMPLE_RATIO,
		metricExportIntervalMs: Number.isInteger(metricExportIntervalMs) && metricExportIntervalMs >= MIN_METRIC_INTERVAL_MS && metricExportIntervalMs <= MAX_METRIC_INTERVAL_MS ? metricExportIntervalMs : DEFAULT_METRIC_INTERVAL_MS,
		logLevel,
		traces: signalConfigs.traces,
		metrics: signalConfigs.metrics,
		logs: signalConfigs.logs,
		prometheusUrl,
		jaegerUrl,
		queryHeaders,
		issues: Object.freeze([...issues]),
	};
}

/** Return an endpoint description safe for UI and logs. Paths, query strings, and credentials are omitted. */
export function safeEndpointOrigin(url: URL): string {
	return url.origin;
}

export const TELEMETRY_CONFIG_DEFAULTS = Object.freeze({
	otlpBase: DEFAULT_OTLP_BASE,
	prometheusUrl: DEFAULT_PROMETHEUS_URL,
	jaegerUrl: DEFAULT_JAEGER_URL,
	serviceName: DEFAULT_SERVICE_NAME,
	traceSampleRatio: DEFAULT_TRACE_SAMPLE_RATIO,
	metricExportIntervalMs: DEFAULT_METRIC_INTERVAL_MS,
});
