/**
 * Read-only deployment check for a project-specific corpus.
 *
 * Validates the configuration the widget will actually use, then confirms the
 * credential can reach every configured collection and that each one returns
 * citable content. It never creates, updates or deletes anything, so it is safe
 * to run against a production credential before and after an ingestion run.
 *
 * Usage:
 *   pnpm check:config
 *   pnpm check:config -- --env-file .env.production
 */
import { AlbertClient } from "../lib/albert/client";
import { type AppConfig, loadConfig } from "../lib/config";
import { toCitations } from "../lib/rag/citations";
import { readSetting, requireSetting } from "./lib/env";

const PROBES = ["procédure", "comment faire une demande", "responsabilité"];

export type CheckResult = {
	ok: boolean;
	lines: string[];
};

type CollectionDeps = {
	search: (params: {
		query: string;
		collectionIds: number[];
		limit: number;
		method: "hybrid";
	}) => Promise<unknown[]>;
	collectionId: number;
};

/** Probes one collection; returns whether it produced citable content. */
export async function checkCollection({
	search,
	collectionId,
}: CollectionDeps): Promise<CheckResult> {
	const lines: string[] = [];
	let answered = 0;
	let lastError = "";

	for (const probe of PROBES) {
		try {
			const hits = await search({
				query: probe,
				collectionIds: [collectionId],
				limit: 5,
				method: "hybrid",
			});
			if (hits.length === 0) continue;

			answered += 1;
			if (answered === 1) {
				const citations = toCitations(hits as never);
				const linked = citations.filter((citation) => citation.url !== null);
				const paged = citations.filter((citation) => citation.page !== null);
				lines.push(
					`     first probe: ${hits.length} hit(s), ${linked.length} linkable, ${paged.length} with a page`,
				);
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	if (answered === 0) {
		lines.unshift(
			lastError
				? `FAIL collection ${collectionId}: search failed (${lastError})`
				: `FAIL collection ${collectionId}: no probe returned content; the collection may be empty or still indexing`,
		);
		return { ok: false, lines };
	}

	lines.unshift(
		`OK   collection ${collectionId}: answered ${answered}/${PROBES.length} probes`,
	);
	return { ok: true, lines };
}

/**
 * Runs the whole check against the given configuration and client factory.
 * Split from `main()` so the behavior is testable without module side effects.
 */
export async function runCheckConfig(
	config: AppConfig,
	createClient: (config: AppConfig) => {
		search: CollectionDeps["search"];
	} = (resolved) =>
		new AlbertClient({ baseUrl: resolved.baseUrl, apiKey: resolved.apiKey }),
): Promise<CheckResult> {
	const lines = [
		`Configuration: ${config.collectionIds.length} collection(s) -> ${config.collectionIds.join(", ")}`,
	];
	const client = createClient(config);
	// Bind explicitly: the client's methods use `this.request`, so a bare
	// method reference would lose its receiver and fail on the first call.
	const search: CollectionDeps["search"] = (params) => client.search(params);

	let failures = 0;
	for (const collectionId of config.collectionIds) {
		const result = await checkCollection({ search, collectionId });
		lines.push(...result.lines);
		if (!result.ok) failures += 1;
	}

	if (failures > 0) {
		lines.push(`\n${failures} collection(s) failed the check.`);
		return { ok: false, lines };
	}

	lines.push("\nConfiguration checked: every collection answers a probe.");
	return { ok: true, lines };
}

async function main() {
	const envFileIndex = process.argv.indexOf("--env-file");
	const envFile =
		envFileIndex === -1 ? undefined : process.argv[envFileIndex + 1];

	const apiKey = requireSetting("ALBERT_API_KEY", envFile);
	const baseUrl =
		readSetting("ALBERT_BASE_URL", envFile) ??
		"https://albert.api.etalab.gouv.fr";

	// Every variable the loader reads must come from the same source, otherwise
	// --env-file would resolve the key but silently ignore the collection list.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		ALBERT_API_KEY: apiKey,
		ALBERT_BASE_URL: baseUrl,
	};
	for (const name of [
		"ALBERT_COLLECTION_IDS",
		"ALBERT_COLLECTION_FR",
		"ALBERT_COLLECTION_EN",
	] as const) {
		const value = readSetting(name, envFile);
		if (value !== undefined) env[name] = value;
	}

	let config: AppConfig;
	try {
		config = loadConfig(env);
	} catch (error) {
		console.error(
			`FAIL configuration: ${error instanceof Error ? error.message : error}`,
		);
		process.exitCode = 1;
		return;
	}

	const result = await runCheckConfig(config);
	console.log(result.lines.join("\n"));
	if (!result.ok) process.exitCode = 1;
}

// Only run when executed as a script, so importing the module has no effect.
if (process.argv[1]?.includes("check-config")) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
