/**
 * x402 Wallet Extension
 *
 * Adds a small, local EVM wallet for x402 payments and a payment-aware HTTP tool.
 * Private keys are never returned to the model; x402 signatures are created and
 * attached inside this extension.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client, x402HTTPClient, type PaymentRequired, type PaymentRequirements } from "@x402/fetch";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const baseDir = dirname(fileURLToPath(import.meta.url));

const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULT_ALLOWED_NETWORKS = ["eip155:8453", "base"];
const DEFAULT_ALLOWED_ASSETS = [BASE_USDC_ADDRESS.toLowerCase()];
const DEFAULT_MAX_USDC = "5.00";
const MAX_BODY_BYTES = 50 * 1024;
const MAX_BODY_LINES = 2000;

const SENSITIVE_RESPONSE_HEADERS = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	"proxy-authorization",
	"payment-signature",
	"x-payment",
]);

type HexPrivateKey = `0x${string}`;

type AnyPaymentRequirement = PaymentRequirements & {
	maxAmountRequired?: string;
	resource?: string;
	description?: string;
	mimeType?: string;
	outputSchema?: Record<string, unknown>;
};

type AnyPaymentRequired = PaymentRequired & {
	accepts: AnyPaymentRequirement[];
};

interface WalletInfo {
	privateKey: HexPrivateKey;
	address: `0x${string}`;
	source: string;
	filePath?: string;
}

interface StoredWalletFile {
	version: 1;
	privateKey: string;
	address: string;
	createdAt: string;
	note: string;
}

interface RequirementSummary {
	x402Version: number;
	scheme: string;
	network: string;
	asset: string;
	amountAtomic: string;
	amount: string;
	decimals: number;
	payTo: string;
	maxTimeoutSeconds?: number;
	resource?: string;
	description?: string;
	mimeType?: string;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getPiAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ? resolve(expandHome(process.env.PI_CODING_AGENT_DIR)) : join(homedir(), ".pi", "agent");
}

function getWalletFilePath(): string {
	const configured = process.env.X402_WALLET_FILE?.trim();
	if (configured) {
		const expanded = expandHome(configured);
		return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
	}
	return join(getPiAgentDir(), "x402-wallet.json");
}

function normalizePrivateKey(raw: string): HexPrivateKey {
	const trimmed = raw.trim();
	const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
	if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
		throw new Error("Invalid EVM private key. Expected 32-byte hex, with or without 0x prefix.");
	}
	return prefixed as HexPrivateKey;
}

function walletFromPrivateKey(privateKey: HexPrivateKey, source: string, filePath?: string): WalletInfo {
	const account = privateKeyToAccount(privateKey);
	return { privateKey, address: account.address, source, filePath };
}

async function loadWalletFromFile(): Promise<WalletInfo | undefined> {
	const filePath = getWalletFilePath();
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}

	const parsed = JSON.parse(text) as Partial<StoredWalletFile>;
	if (typeof parsed.privateKey !== "string") {
		throw new Error(`Wallet file ${filePath} does not contain a privateKey string.`);
	}
	return walletFromPrivateKey(normalizePrivateKey(parsed.privateKey), `file:${filePath}`, filePath);
}

async function loadWallet(): Promise<WalletInfo | undefined> {
	const x402Key = process.env.X402_EVM_PRIVATE_KEY?.trim();
	if (x402Key) return walletFromPrivateKey(normalizePrivateKey(x402Key), "env:X402_EVM_PRIVATE_KEY");

	const evmKey = process.env.EVM_PRIVATE_KEY?.trim();
	if (evmKey) return walletFromPrivateKey(normalizePrivateKey(evmKey), "env:EVM_PRIVATE_KEY");

	return loadWalletFromFile();
}

async function createStoredWallet(overwrite: boolean): Promise<WalletInfo> {
	const filePath = getWalletFilePath();
	if (!overwrite) {
		try {
			await readFile(filePath, "utf8");
			throw new Error(`Wallet file already exists: ${filePath}`);
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
	}

	const privateKey = generatePrivateKey();
	const account = privateKeyToAccount(privateKey);
	const stored: StoredWalletFile = {
		version: 1,
		privateKey,
		address: account.address,
		createdAt: new Date().toISOString(),
		note: "Throwaway x402 EVM wallet for Pi. Fund only with small Base USDC amounts.",
	};

	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
	await chmod(filePath, 0o600).catch(() => undefined);
	return walletFromPrivateKey(privateKey, `file:${filePath}`, filePath);
}

async function deleteStoredWallet(): Promise<boolean> {
	const filePath = getWalletFilePath();
	try {
		await unlink(filePath);
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function getAllowedNetworks(): string[] {
	const configured = process.env.X402_ALLOWED_NETWORKS?.trim();
	const networks = configured ? configured.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ALLOWED_NETWORKS;
	return networks.length > 0 ? networks : DEFAULT_ALLOWED_NETWORKS;
}

function getAllowedAssets(): string[] {
	const configured = process.env.X402_ALLOWED_ASSETS?.trim();
	const assets = configured ? configured.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ALLOWED_ASSETS;
	return assets.length > 0 ? assets : DEFAULT_ALLOWED_ASSETS;
}

function getConfiguredMaxUsdc(): string {
	return process.env.X402_MAX_USDC?.trim() || DEFAULT_MAX_USDC;
}

function isAutoApproveEnabled(): boolean {
	return /^(1|true|yes|y)$/i.test(process.env.X402_AUTO_APPROVE?.trim() ?? "");
}

function getRequirementAmountAtomic(requirement: AnyPaymentRequirement): string {
	const amount = (requirement as any).amount ?? requirement.maxAmountRequired;
	if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
		throw new Error(`Payment requirement is missing an atomic amount: ${JSON.stringify(requirement)}`);
	}
	return amount;
}

function getRequirementDecimals(requirement: AnyPaymentRequirement): number {
	const extra = requirement.extra ?? {};
	for (const key of ["decimals", "assetDecimals", "tokenDecimals"]) {
		const value = (extra as Record<string, unknown>)[key];
		const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
		if (parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 && parsed <= 36) return parsed;
	}
	// x402 Base USDC/EURC requirements are normally 6 decimals. Defaulting high would
	// make small USDC payments look enormous; defaulting to 6 matches x402 stablecoin practice.
	return 6;
}

function pow10(decimals: number): bigint {
	return 10n ** BigInt(decimals);
}

function parseDecimalUnits(value: string, decimals: number): bigint {
	const text = String(value).trim();
	if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid decimal amount: ${value}`);
	const [whole, fraction = ""] = text.split(".");
	if (fraction.length > decimals) throw new Error(`Amount ${value} has more than ${decimals} decimal places.`);
	return BigInt(whole) * pow10(decimals) + BigInt((fraction.padEnd(decimals, "0") || "0"));
}

function formatUnits(amount: bigint, decimals: number): string {
	const divisor = pow10(decimals);
	const whole = amount / divisor;
	const fraction = amount % divisor;
	if (fraction === 0n) return whole.toString();
	const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
	return `${whole}.${padded}`;
}

function minDecimalAmount(a: string, b: string): string {
	const au = parseDecimalUnits(a, 18);
	const bu = parseDecimalUnits(b, 18);
	return au <= bu ? a : b;
}

function normalizeTo18Atomic(requirement: AnyPaymentRequirement): bigint {
	const amount = BigInt(getRequirementAmountAtomic(requirement));
	const decimals = getRequirementDecimals(requirement);
	if (decimals === 18) return amount;
	if (decimals < 18) return amount * pow10(18 - decimals);
	return amount / pow10(decimals - 18);
}

function networkAllowed(network: string, allowedNetworks: string[]): boolean {
	return allowedNetworks.some((allowed) => {
		if (allowed === network) return true;
		if (allowed.endsWith(":*")) return network.startsWith(allowed.slice(0, -1));
		return false;
	});
}

function assetAllowed(asset: string, allowedAssets: string[]): boolean {
	const normalized = asset.toLowerCase();
	return allowedAssets.some((allowed) => {
		const value = allowed.toLowerCase();
		return value === "*" || value === "any" || value === normalized;
	});
}

function summarizeRequirement(paymentRequired: AnyPaymentRequired, requirement: AnyPaymentRequirement): RequirementSummary {
	const decimals = getRequirementDecimals(requirement);
	const amountAtomic = getRequirementAmountAtomic(requirement);
	const amount = formatUnits(BigInt(amountAtomic), decimals);
	const resourceInfo = (paymentRequired as any).resource;
	return {
		x402Version: paymentRequired.x402Version,
		scheme: requirement.scheme,
		network: requirement.network,
		asset: requirement.asset,
		amountAtomic,
		amount,
		decimals,
		payTo: requirement.payTo,
		maxTimeoutSeconds: requirement.maxTimeoutSeconds,
		resource: typeof resourceInfo?.url === "string" ? resourceInfo.url : requirement.resource,
		description: typeof resourceInfo?.description === "string" ? resourceInfo.description : requirement.description,
		mimeType: typeof resourceInfo?.mimeType === "string" ? resourceInfo.mimeType : requirement.mimeType,
	};
}

function summarizeRequirements(paymentRequired: AnyPaymentRequired): RequirementSummary[] {
	return paymentRequired.accepts.map((requirement) => summarizeRequirement(paymentRequired, requirement));
}

function makePaymentPolicy(allowedNetworks: string[], allowedAssets: string[], maxUsdc: string) {
	return (_version: number, requirements: PaymentRequirements[]) => {
		return (requirements as AnyPaymentRequirement[]).filter((requirement) => {
			try {
				if (requirement.scheme !== "exact") return false;
				if (!networkAllowed(requirement.network, allowedNetworks)) return false;
				if (!assetAllowed(requirement.asset, allowedAssets)) return false;
				const decimals = getRequirementDecimals(requirement);
				const maxAtomic = parseDecimalUnits(maxUsdc, decimals);
				return BigInt(getRequirementAmountAtomic(requirement)) <= maxAtomic;
			} catch {
				return false;
			}
		});
	};
}

function selectCheapestRequirement(_version: number, requirements: PaymentRequirements[]): PaymentRequirements {
	if (requirements.length === 0) throw new Error("No payment requirements available.");
	return [...(requirements as AnyPaymentRequirement[])].sort((a, b) => {
		const aa = normalizeTo18Atomic(a);
		const bb = normalizeTo18Atomic(b);
		return aa < bb ? -1 : aa > bb ? 1 : 0;
	})[0] as PaymentRequirements;
}

function getSchemeOptions(): Record<number, { rpcUrl: string }> | undefined {
	const map: Record<number, { rpcUrl: string }> = {};
	const baseRpc = process.env.X402_BASE_RPC_URL?.trim() || process.env.BASE_RPC_URL?.trim();
	if (baseRpc) map[8453] = { rpcUrl: baseRpc };
	const baseSepoliaRpc = process.env.X402_BASE_SEPOLIA_RPC_URL?.trim() || process.env.BASE_SEPOLIA_RPC_URL?.trim();
	if (baseSepoliaRpc) map[84532] = { rpcUrl: baseSepoliaRpc };
	return Object.keys(map).length > 0 ? map : undefined;
}

function createPaymentClients(wallet: WalletInfo, allowedNetworks: string[], allowedAssets: string[], maxUsdc: string) {
	const account = privateKeyToAccount(wallet.privateKey);
	const client = new x402Client(selectCheapestRequirement);
	const v2Networks = allowedNetworks.filter((network) => network.startsWith("eip155:"));
	const config: any = {
		signer: account,
		policies: [makePaymentPolicy(allowedNetworks, allowedAssets, maxUsdc)],
	};
	if (v2Networks.length > 0) config.networks = v2Networks;
	const schemeOptions = getSchemeOptions();
	if (schemeOptions) config.schemeOptions = schemeOptions;
	registerExactEvmScheme(client, config);
	return { client, httpClient: new x402HTTPClient(client) };
}

function headersToObject(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		out[key] = SENSITIVE_RESPONSE_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value.slice(0, 1000);
	}
	return out;
}

function parseJsonMaybe(text: string): unknown | undefined {
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function truncateText(text: string): { text: string; truncated: boolean; originalBytes: number; originalLines: number } {
	const lines = text.split(/\r?\n/);
	let truncated = lines.length > MAX_BODY_LINES;
	let kept = truncated ? lines.slice(0, MAX_BODY_LINES).join("\n") : text;
	let bytes = Buffer.byteLength(kept, "utf8");
	if (bytes > MAX_BODY_BYTES) {
		truncated = true;
		let end = kept.length;
		while (end > 0 && Buffer.byteLength(kept.slice(0, end), "utf8") > MAX_BODY_BYTES) end = Math.floor(end * 0.9);
		kept = kept.slice(0, end);
		bytes = Buffer.byteLength(kept, "utf8");
	}
	if (truncated) {
		kept += `\n\n[Truncated response body to ${MAX_BODY_LINES} lines / ${MAX_BODY_BYTES} bytes for context safety.]`;
	}
	return { text: kept, truncated, originalBytes: Buffer.byteLength(text, "utf8"), originalLines: lines.length };
}

async function readResponseBody(response: Response) {
	const raw = await response.text();
	const truncated = truncateText(raw);
	return {
		raw,
		text: truncated.text,
		json: parseJsonMaybe(raw),
		truncated: truncated.truncated,
		originalBytes: truncated.originalBytes,
		originalLines: truncated.originalLines,
	};
}

function prepareRequest(params: any, signal?: AbortSignal): { method: string; headers: Record<string, string>; body?: string; init: RequestInit } {
	const method = (params.method ?? "GET").toUpperCase();
	const headers: Record<string, string> = { ...(params.headers ?? {}) };
	let body: string | undefined;

	if (params.body !== undefined && params.json !== undefined) {
		throw new Error("Provide either body or json, not both.");
	}
	if (params.json !== undefined) {
		body = JSON.stringify(params.json);
		if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
	} else if (params.body !== undefined) {
		body = String(params.body);
	}

	const init: RequestInit = { method, headers: { ...headers }, signal };
	if (body !== undefined && !["GET", "HEAD"].includes(method)) init.body = body;
	return { method, headers, body, init };
}

function getEffectiveMaxUsdc(requested?: string): string {
	const configured = getConfiguredMaxUsdc();
	parseDecimalUnits(configured, 18);
	if (!requested || !String(requested).trim()) return configured;
	parseDecimalUnits(String(requested), 18);
	return minDecimalAmount(String(requested), configured);
}

async function requirePaymentApproval(ctx: ExtensionContext, wallet: WalletInfo, selected: RequirementSummary, effectiveMaxUsdc: string, reason?: string): Promise<void> {
	if (isAutoApproveEnabled()) return;
	if (!ctx.hasUI) {
		throw new Error(
			`x402 payment requires user approval. Re-run in interactive/RPC UI mode or set X402_AUTO_APPROVE=1 after setting X402_MAX_USDC. Requested ${selected.amount} token units on ${selected.network}.`,
		);
	}

	const message = [
		`Wallet: ${wallet.address}`,
		`Network: ${selected.network}`,
		`Amount: ${selected.amount} (${selected.amountAtomic} atomic units, decimals=${selected.decimals})`,
		`Asset: ${selected.asset}`,
		`Pay to: ${selected.payTo}`,
		selected.resource ? `Resource: ${selected.resource}` : undefined,
		selected.description ? `Description: ${selected.description}` : undefined,
		`Per-call max: ${effectiveMaxUsdc} USDC-equivalent`,
		reason ? `Reason: ${reason}` : undefined,
		"",
		"Approve this x402 payment?",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");

	const approved = await ctx.ui.confirm("Approve x402 payment", message);
	if (!approved) throw new Error("User declined x402 payment.");
}

function formatRequirementLine(summary: RequirementSummary): string {
	return `${summary.amount} units (${summary.amountAtomic} atomic) on ${summary.network} via ${summary.scheme} to ${summary.payTo}`;
}

function walletStatusText(wallet: WalletInfo | undefined): string {
	const allowedNetworks = getAllowedNetworks();
	const allowedAssets = getAllowedAssets();
	if (!wallet) {
		return [
			"No x402 EVM wallet configured.",
			"Run /x402-wallet create to generate a throwaway wallet, or set X402_EVM_PRIVATE_KEY/EVM_PRIVATE_KEY.",
			`Wallet file path: ${getWalletFilePath()}`,
			`Allowed networks: ${allowedNetworks.join(", ")}`,
			`Allowed assets: ${allowedAssets.join(", ")}`,
			`Configured max spend: ${getConfiguredMaxUsdc()} USDC-equivalent`,
		].join("\n");
	}
	return [
		`x402 wallet ready: ${wallet.address}`,
		`Source: ${wallet.source}`,
		`Allowed networks: ${allowedNetworks.join(", ")}`,
		`Allowed assets: ${allowedAssets.join(", ")}`,
		`Configured max spend: ${getConfiguredMaxUsdc()} USDC-equivalent`,
		isAutoApproveEnabled() ? "Auto approval: enabled by X402_AUTO_APPROVE" : "Auto approval: disabled; tool will ask before paying",
		"Funding: send only small throwaway Base USDC amounts to this address.",
	].join("\n");
}

async function handleWalletCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const [actionRaw] = args.trim().split(/\s+/).filter(Boolean);
	const action = actionRaw ?? "status";

	if (["help", "-h", "--help"].includes(action)) {
		ctx.ui.notify(
			[
				"/x402-wallet status  - show wallet address/config",
				"/x402-wallet create  - generate and store a throwaway wallet",
				"/x402-wallet forget  - delete the stored wallet file (env keys are untouched)",
				"Env: X402_EVM_PRIVATE_KEY or EVM_PRIVATE_KEY overrides the stored wallet.",
			].join("\n"),
			"info",
		);
		return;
	}

	if (action === "create") {
		const envActive = Boolean(process.env.X402_EVM_PRIVATE_KEY?.trim() || process.env.EVM_PRIVATE_KEY?.trim());
		if (envActive && ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Environment wallet active",
				"An env private key is currently active, so a stored wallet will not be used until that env var is removed. Create/overwrite the stored wallet anyway?",
			);
			if (!ok) return;
		}

		let overwrite = false;
		const existing = await loadWalletFromFile().catch(() => undefined);
		if (existing) {
			if (!ctx.hasUI) throw new Error(`Stored wallet already exists at ${existing.filePath}.`);
			overwrite = await ctx.ui.confirm("Overwrite x402 wallet?", `A stored wallet already exists at ${existing.filePath}. Overwrite it?`);
			if (!overwrite) return;
		}

		const wallet = await createStoredWallet(overwrite);
		ctx.ui.notify(
			[
				"Created throwaway x402 wallet.",
				`Address: ${wallet.address}`,
				`Stored at: ${wallet.filePath}`,
				"Fund it with only the small amount of Base USDC you are willing to let Pi spend.",
			].join("\n"),
			"info",
		);
		return;
	}

	if (action === "forget") {
		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm("Delete stored x402 wallet?", `Delete ${getWalletFilePath()}? Env private keys will not be changed.`);
			if (!ok) return;
		} else {
			throw new Error("Refusing to delete a wallet without UI confirmation.");
		}
		const deleted = await deleteStoredWallet();
		ctx.ui.notify(deleted ? "Deleted stored x402 wallet." : "No stored x402 wallet file was present.", "info");
		return;
	}

	if (action !== "status") {
		ctx.ui.notify(`Unknown x402-wallet action: ${action}. Try /x402-wallet help`, "warning");
		return;
	}

	ctx.ui.notify(walletStatusText(await loadWallet()), "info");
}

export default function x402WalletExtension(pi: ExtensionAPI): void {
	pi.on("resources_discover", () => ({
		skillPaths: [join(baseDir, "SKILL.md")],
	}));

	pi.registerCommand("x402-wallet", {
		description: "Manage the built-in throwaway x402 EVM wallet (status/create/forget).",
		handler: async (args, ctx) => {
			await handleWalletCommand(args, ctx);
		},
	});

	pi.registerTool({
		name: "x402_wallet_status",
		label: "x402 Wallet Status",
		description: "Show the built-in x402 EVM wallet address and payment safety configuration. Never reveals private keys.",
		promptSnippet: "Show x402 wallet address/configuration without revealing the private key",
		promptGuidelines: [
			"Use x402_wallet_status when an x402 payment flow is blocked on a Base/USDC wallet address or EVM_PRIVATE_KEY; do not ask the user to paste a private key until this tool shows no wallet is configured.",
		],
		parameters: Type.Object({}),
		async execute() {
			const wallet = await loadWallet();
			return {
				content: [{ type: "text", text: walletStatusText(wallet) }],
				details: {
					configured: Boolean(wallet),
					address: wallet?.address,
					source: wallet?.source,
					walletFile: getWalletFilePath(),
					allowedNetworks: getAllowedNetworks(),
					allowedAssets: getAllowedAssets(),
					maxUsdc: getConfiguredMaxUsdc(),
					autoApprove: isAutoApproveEnabled(),
				},
			};
		},
		renderResult(result, _options, theme) {
			const details = result.details as any;
			if (details?.configured) return new Text(theme.fg("success", `✓ x402 wallet ${details.address}`), 0, 0);
			return new Text(theme.fg("warning", "No x402 wallet configured"), 0, 0);
		},
	});

	pi.registerTool({
		name: "x402_request",
		label: "x402 Request",
		description:
			"Make an HTTP request and, if the server returns x402 Payment Required, sign an x402 payment with the built-in EVM wallet and retry. Enforces allowed networks, max spend, and user approval. Response bodies are truncated to 50KB/2000 lines.",
		promptSnippet: "Call paid x402 HTTP APIs using the built-in EVM wallet without exposing private keys",
		promptGuidelines: [
			"Use x402_request for paid x402 HTTP endpoints instead of asking for EVM_PRIVATE_KEY or constructing payment headers manually.",
			"Before x402_request spends, set maxUsdc to the user's approved amount and include a concise reason; the tool enforces wallet/network/spend caps and asks for approval unless X402_AUTO_APPROVE is set.",
			"Use x402_request dryRun=true first when the price is unknown; do not spend more than the user's explicit approval.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute HTTP(S) URL to request" }),
			method: Type.Optional(StringEnum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const, { description: "HTTP method. Defaults to GET." })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "HTTP headers to send (do not include payment headers)" })),
			body: Type.Optional(Type.String({ description: "Raw request body. Use either body or json, not both." })),
			json: Type.Optional(Type.Any({ description: "JSON body. Automatically sets content-type application/json when provided." })),
			maxUsdc: Type.Optional(Type.String({ description: "Maximum USDC-equivalent spend approved for this call, e.g. '1.40'. Effective max is min(this, X402_MAX_USDC)." })),
			dryRun: Type.Optional(Type.Boolean({ description: "If true, stop after reading x402 payment requirements and do not sign/pay." })),
			reason: Type.Optional(Type.String({ description: "Short human-readable reason shown in the payment approval prompt." })),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			return {
				...input,
				maxUsdc: input.maxUsdc ?? input.max_usdc ?? input.maxUSD ?? input.max_usdc_amount,
				dryRun: input.dryRun ?? input.dry_run,
			};
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const wallet = await loadWallet();
			if (!wallet) {
				throw new Error("No x402 EVM wallet configured. Run /x402-wallet create, or set X402_EVM_PRIVATE_KEY/EVM_PRIVATE_KEY to a funded throwaway wallet.");
			}

			const effectiveMaxUsdc = getEffectiveMaxUsdc(params.maxUsdc);
			const allowedNetworks = getAllowedNetworks();
			const allowedAssets = getAllowedAssets();
			const { client, httpClient } = createPaymentClients(wallet, allowedNetworks, allowedAssets, effectiveMaxUsdc);
			const prepared = prepareRequest(params, signal);

			onUpdate?.({ content: [{ type: "text", text: `Requesting ${prepared.method} ${params.url}` }] });
			const initialResponse = await fetch(new Request(params.url, prepared.init));
			const initialBody = await readResponseBody(initialResponse);

			if (initialResponse.status !== 402) {
				const text = `HTTP ${initialResponse.status} ${initialResponse.statusText}\n\n${initialBody.text || "[empty response body]"}`;
				return {
					content: [{ type: "text", text }],
					details: {
						url: params.url,
						method: prepared.method,
						paid: false,
						walletAddress: wallet.address,
						response: {
							status: initialResponse.status,
							statusText: initialResponse.statusText,
							headers: headersToObject(initialResponse.headers),
							bodyText: initialBody.text,
							bodyJson: initialBody.raw.length <= 20_000 ? initialBody.json : undefined,
							truncated: initialBody.truncated,
						},
					},
				};
			}

			let paymentRequired: AnyPaymentRequired;
			try {
				paymentRequired = httpClient.getPaymentRequiredResponse((name) => initialResponse.headers.get(name), initialBody.json) as AnyPaymentRequired;
			} catch (error) {
				throw new Error(`HTTP 402 response did not contain valid x402 payment requirements: ${error instanceof Error ? error.message : String(error)}`);
			}

			let selected: AnyPaymentRequirement;
			try {
				selected = (client as any).selectPaymentRequirements(paymentRequired.x402Version, paymentRequired.accepts) as AnyPaymentRequirement;
			} catch (error) {
				const summaries = summarizeRequirements(paymentRequired);
				return {
					content: [
						{
							type: "text",
							text: [
								`Payment not made: no x402 requirement matched allowed networks/assets/spend cap (networks ${allowedNetworks.join(", ")}; assets ${allowedAssets.join(", ")}; max ${effectiveMaxUsdc} USDC-equivalent).`,
								`Reason: ${error instanceof Error ? error.message : String(error)}`,
								"Accepted requirements:",
								...summaries.map((s) => `- ${formatRequirementLine(s)}`),
							].join("\n"),
						},
					],
					details: {
						url: params.url,
						method: prepared.method,
						paid: false,
						paymentRequired: true,
						walletAddress: wallet.address,
						allowedNetworks,
						allowedAssets,
						maxUsdc: effectiveMaxUsdc,
						accepted: summaries,
						error: error instanceof Error ? error.message : String(error),
					},
				};
			}

			const selectedSummary = summarizeRequirement(paymentRequired, selected);
			if (params.dryRun) {
				return {
					content: [
						{
							type: "text",
							text: [
								"Dry run: x402 payment required, but no payment was signed.",
								`Selected requirement: ${formatRequirementLine(selectedSummary)}`,
								`Wallet: ${wallet.address}`,
								`Effective max: ${effectiveMaxUsdc} USDC-equivalent`,
							].join("\n"),
						},
					],
					details: {
						url: params.url,
						method: prepared.method,
						paid: false,
						dryRun: true,
						paymentRequired: true,
						walletAddress: wallet.address,
						allowedNetworks,
						allowedAssets,
						selected: selectedSummary,
						accepted: summarizeRequirements(paymentRequired),
					},
				};
			}

			await requirePaymentApproval(ctx, wallet, selectedSummary, effectiveMaxUsdc, params.reason);

			onUpdate?.({ content: [{ type: "text", text: `Signing x402 payment for ${formatRequirementLine(selectedSummary)}` }] });
			const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
			const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

			const paidHeaders = new Headers(prepared.headers);
			if (paidHeaders.has("PAYMENT-SIGNATURE") || paidHeaders.has("X-PAYMENT")) {
				throw new Error("Request already includes an x402 payment header; refusing to overwrite it.");
			}
			for (const [key, value] of Object.entries(paymentHeaders)) paidHeaders.set(key, value);
			paidHeaders.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");

			let finalResponse = await fetch(new Request(params.url, { ...prepared.init, headers: paidHeaders }));
			let paymentResult = await httpClient.processPaymentResult(paymentPayload, (name) => finalResponse.headers.get(name), finalResponse.status);

			if (paymentResult.recovered) {
				onUpdate?.({ content: [{ type: "text", text: "x402 payment response requested recovery; retrying with a fresh payment payload." }] });
				const freshPayload = await httpClient.createPaymentPayload(paymentRequired);
				const retryHeaders = new Headers(prepared.headers);
				for (const [key, value] of Object.entries(httpClient.encodePaymentSignatureHeader(freshPayload))) retryHeaders.set(key, value);
				retryHeaders.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");
				finalResponse = await fetch(new Request(params.url, { ...prepared.init, headers: retryHeaders }));
				paymentResult = await httpClient.processPaymentResult(freshPayload, (name) => finalResponse.headers.get(name), finalResponse.status);
			}

			const finalBody = await readResponseBody(finalResponse);
			const settlement = paymentResult.settleResponse;
			const paymentSucceeded = settlement?.success === true || (!settlement && finalResponse.status >= 200 && finalResponse.status < 300);
			const paymentLine = settlement
				? `Payment settlement: ${settlement.success ? "success" : "failed"}${settlement.transaction ? ` tx=${settlement.transaction}` : ""}`
				: "Payment settlement: no PAYMENT-RESPONSE header returned";

			return {
				content: [
					{
						type: "text",
						text: [
							`HTTP ${finalResponse.status} ${finalResponse.statusText} after x402 payment attempt`,
							`Payment requirement: ${formatRequirementLine(selectedSummary)}`,
							paymentLine,
							"",
							finalBody.text || "[empty response body]",
						].join("\n"),
					},
				],
				details: {
					url: params.url,
					method: prepared.method,
					paymentAttempted: true,
					paid: paymentSucceeded,
					walletAddress: wallet.address,
					allowedNetworks,
					allowedAssets,
					selected: selectedSummary,
					settlement,
					response: {
						status: finalResponse.status,
						statusText: finalResponse.statusText,
						headers: headersToObject(finalResponse.headers),
						bodyText: finalBody.text,
						bodyJson: finalBody.raw.length <= 20_000 ? finalBody.json : undefined,
						truncated: finalBody.truncated,
					},
				},
			};
		},
		renderCall(args, theme) {
			const method = (args.method ?? "GET").toUpperCase();
			const dry = args.dryRun ? theme.fg("warning", " dry-run") : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("x402_request"))} ${theme.fg("accent", method)} ${theme.fg("muted", args.url ?? "")}${dry}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as any;
			if (details?.paymentAttempted) {
				const tx = details.settlement?.transaction ? ` ${theme.fg("dim", details.settlement.transaction)}` : "";
				const color = details.paid ? "success" : "warning";
				const prefix = details.paid ? "✓ paid" : "x402 attempted";
				return new Text(theme.fg(color, `${prefix} ${details.selected?.amount ?? ""} on ${details.selected?.network ?? ""}`) + tx, 0, 0);
			}
			if (details?.dryRun) return new Text(theme.fg("warning", `x402 dry run: ${details.selected?.amount ?? ""} on ${details.selected?.network ?? ""}`), 0, 0);
			if (details?.paymentRequired) return new Text(theme.fg("warning", "x402 payment not made"), 0, 0);
			return new Text(theme.fg("success", `HTTP ${details?.response?.status ?? "response"}`), 0, 0);
		},
	});
}
