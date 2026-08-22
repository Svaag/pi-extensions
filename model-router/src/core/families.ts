import type { RouterSubscriptionPolicy } from "../config/schema.ts";
import { matchesModelPattern, modelRef } from "./candidates.ts";
import type { RoutingCandidate } from "./types.ts";

export type SubscriptionBilling = "included" | "metered";

/** A policy only routes when it is enabled and has at least one usable family. */
export function isSubscriptionPolicyConfigured(policy: RouterSubscriptionPolicy | undefined): boolean {
	return Boolean(policy?.enabled && policy.ranking.length > 0);
}

export interface SubscriptionArmLike {
	model: string;
	provider?: string;
	name?: string;
	eligible: boolean;
}

export interface SubscriptionPick<T extends SubscriptionArmLike> {
	arm: T;
	familyId: string;
	billing: SubscriptionBilling;
	score: number;
	notes: string[];
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

/**
 * Family membership anchors on the full provider/id ref only. Matching bare
 * ids would pull endpoint mirrors like openrouter/anthropic/claude-* into the
 * official anthropic family.
 */
function matchesFamilyPattern(candidate: Pick<RoutingCandidate, "provider" | "id" | "name">, pattern: string): boolean {
	const ref = candidate.provider ? `${candidate.provider}/${candidate.id}` : candidate.id;
	const trimmed = pattern.trim();
	if (!trimmed) return false;
	if (/[*?]/.test(trimmed)) {
		let source = "";
		for (const ch of trimmed) source += ch === "*" ? ".*" : ch === "?" ? "." : escapeRegex(ch);
		return new RegExp(`^${source}$`, "i").test(ref);
	}
	return ref.toLowerCase() === trimmed.toLowerCase();
}

function candidateFromRef(ref: string, provider?: string, name?: string): Pick<RoutingCandidate, "provider" | "id" | "name"> {
	if (provider) return { provider, id: ref.startsWith(`${provider}/`) ? ref.slice(provider.length + 1) : ref, name };
	const slash = ref.indexOf("/");
	return slash > 0 && slash < ref.length - 1
		? { provider: ref.slice(0, slash), id: ref.slice(slash + 1), name }
		: { id: ref, name };
}

function armCandidate(arm: SubscriptionArmLike): Pick<RoutingCandidate, "provider" | "id" | "name"> {
	return candidateFromRef(arm.model, arm.provider, arm.name);
}

export function familyIdFor(candidate: Pick<RoutingCandidate, "provider" | "id" | "name">, policy: RouterSubscriptionPolicy): string | undefined {
	for (const familyId of policy.ranking) {
		const family = policy.families[familyId];
		if (!family) continue;
		if (family.members.some((pattern) => matchesFamilyPattern(candidate, pattern))) return familyId;
	}
	return undefined;
}

export function familyIdForRef(ref: string, policy: RouterSubscriptionPolicy): string | undefined {
	return familyIdFor(candidateFromRef(ref), policy);
}

export function billingClass(candidate: Pick<RoutingCandidate, "provider">, policy: RouterSubscriptionPolicy): SubscriptionBilling {
	if (!candidate.provider) return "metered";
	if (policy.meteredProviders.includes(candidate.provider)) return "metered";
	return policy.includedProviders.includes(candidate.provider) ? "included" : "metered";
}

export function filterFamilyCandidates(candidates: RoutingCandidate[], policy: RouterSubscriptionPolicy): RoutingCandidate[] {
	return candidates.filter((candidate) => familyIdFor(candidate, policy) !== undefined);
}

export function familyMembers(familyId: string, candidates: RoutingCandidate[], policy: RouterSubscriptionPolicy): RoutingCandidate[] {
	return candidates.filter((candidate) => familyIdFor(candidate, policy) === familyId);
}

export function uniqueFamilyIds(candidates: Array<Pick<RoutingCandidate, "provider" | "id" | "name">>, policy: RouterSubscriptionPolicy): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const familyId of policy.ranking) {
		if (seen.has(familyId)) continue;
		if (!candidates.some((candidate) => familyIdFor(candidate, policy) === familyId)) continue;
		seen.add(familyId);
		ids.push(familyId);
	}
	return ids;
}

export function subscriptionScore(args: {
	familyId: string;
	billing: SubscriptionBilling;
	preferred: boolean;
	cacheAffinity: boolean;
	policy: RouterSubscriptionPolicy;
}): number {
	const rankIndex = args.policy.ranking.indexOf(args.familyId);
	const rank = rankIndex >= 0 ? rankIndex : args.policy.ranking.length;
	return (args.billing === "included" ? 2000 : 1000) - rank
		+ (args.preferred ? 0.1 : 0)
		+ (args.cacheAffinity ? 0.01 : 0);
}

function isPreferred(candidate: Pick<RoutingCandidate, "provider" | "id" | "name">, familyId: string, policy: RouterSubscriptionPolicy): boolean {
	const preferred = policy.families[familyId]?.preferred;
	return Boolean(preferred && matchesFamilyPattern(candidate, preferred));
}

function pickMember<T extends SubscriptionArmLike>(
	arms: T[],
	familyId: string,
	policy: RouterSubscriptionPolicy,
	cacheAffinityModel?: string,
): T | undefined {
	const family = policy.families[familyId];
	if (!family || arms.length === 0) return undefined;
	const preferred = arms.find((arm) => isPreferred(armCandidate(arm), familyId, policy));
	if (preferred) return preferred;
	if (cacheAffinityModel) {
		const affinity = arms.find((arm) => arm.model === cacheAffinityModel || modelRef(armCandidate(arm)) === cacheAffinityModel);
		if (affinity) return affinity;
	}
	for (const pattern of family.members) {
		const match = arms.find((arm) => matchesFamilyPattern(armCandidate(arm), pattern));
		if (match) return match;
	}
	return arms[0];
}

export function pickSubscriptionArm<T extends SubscriptionArmLike>(
	arms: T[],
	policy: RouterSubscriptionPolicy,
	cacheAffinityModel?: string,
): SubscriptionPick<T> | undefined {
	const eligible = arms.filter((arm) => arm.eligible && familyIdFor(armCandidate(arm), policy));
	if (eligible.length === 0) return undefined;

	const familyBilling = new Map<string, Set<SubscriptionBilling>>();
	for (const arm of eligible) {
		const candidate = armCandidate(arm);
		const familyId = familyIdFor(candidate, policy);
		if (!familyId) continue;
		const billing = billingClass(candidate, policy);
		const set = familyBilling.get(familyId) ?? new Set<SubscriptionBilling>();
		set.add(billing);
		familyBilling.set(familyId, set);
	}

	const includedFamilies = policy.ranking.filter((familyId) => familyBilling.get(familyId)?.has("included"));
	const selectedBilling: SubscriptionBilling = includedFamilies.length > 0 ? "included" : "metered";
	const ranked = (selectedBilling === "included" ? includedFamilies : policy.ranking.filter((familyId) => familyBilling.has(familyId)));
	const familyId = ranked[0];
	if (!familyId) return undefined;

	const subset = eligible.filter((arm) => {
		const candidate = armCandidate(arm);
		return familyIdFor(candidate, policy) === familyId && billingClass(candidate, policy) === selectedBilling;
	});
	const arm = pickMember(subset, familyId, policy, cacheAffinityModel);
	if (!arm) return undefined;
	const candidate = armCandidate(arm);
	const preferred = isPreferred(candidate, familyId, policy);
	const cacheAffinity = Boolean(cacheAffinityModel && (arm.model === cacheAffinityModel || modelRef(candidate) === cacheAffinityModel));
	const notes = [`family:${familyId}`, `billing:${selectedBilling}`];
	if (preferred) notes.push("preferred_member");
	if (cacheAffinity) notes.push("cache_affinity");
	return {
		arm,
		familyId,
		billing: selectedBilling,
		score: subscriptionScore({ familyId, billing: selectedBilling, preferred, cacheAffinity, policy }),
		notes,
	};
}

export function annotateSubscriptionScores<T extends SubscriptionArmLike>(
	arms: T[],
	policy: RouterSubscriptionPolicy,
	cacheAffinityModel?: string,
): Array<{ arm: T; familyId?: string; billing?: SubscriptionBilling; score: number; notes: string[] }> {
	return arms.map((arm) => {
		const candidate = armCandidate(arm);
		const familyId = familyIdFor(candidate, policy);
		if (!familyId) return { arm, score: 0, notes: [] };
		const billing = billingClass(candidate, policy);
		const preferred = isPreferred(candidate, familyId, policy);
		const cacheAffinity = Boolean(cacheAffinityModel && (arm.model === cacheAffinityModel || modelRef(candidate) === cacheAffinityModel));
		return {
			arm,
			familyId,
			billing,
			score: subscriptionScore({ familyId, billing, preferred, cacheAffinity, policy }),
			notes: [`family:${familyId}`, `billing:${billing}`],
		};
	});
}
