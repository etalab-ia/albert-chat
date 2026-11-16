import { AlbertClient } from "../lib/albert/client";
import {
	extractFrenchPdfSources,
	fetchCatalogue,
	type PdfSource,
} from "./lib/catalogue";
import { readSetting, requireSetting } from "./lib/env";
import { loadInventory, type SyncReport, syncFrenchGuides } from "./lib/sync";

const COLLECTION_NAME = "anssi-guides-fr";

type Options = {
	dryRun: boolean;
	concurrency: number;
	envFile?: string;
};

function parseArgs(argv: string[]): Options {
	let dryRun = false;
	let concurrency = 2;
	let envFile: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--dry-run") {
			dryRun = true;
		} else if (argument === "--concurrency") {
			concurrency = Number.parseInt(argv[index + 1] ?? "", 10);
			index += 1;
			if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
				throw new Error("--concurrency attend un entier positif");
			}
		} else if (argument === "--env-file") {
			envFile = argv[index + 1];
			index += 1;
			if (!envFile) throw new Error("--env-file attend un chemin");
		} else {
			throw new Error(`Option inconnue: ${argument}`);
		}
	}
	return { dryRun, concurrency, envFile };
}

function printReport(report: SyncReport, dryRun: boolean) {
	const prefix = dryRun ? "[dry-run] Actions prévues" : "Bilan";
	console.log(
		`\n${prefix}: ${report.added} ajoutés, ${report.replaced} remplacés, ` +
			`${report.unchanged} inchangés, ${report.deleted} supprimés, ` +
			`${report.failures.length} échecs, ${report.warnings.length} avertissements`,
	);
	console.log(
		`${report.preservedUnmanaged} documents sans métadonnées du corpus français préservés.`,
	);
	for (const item of report.failures) {
		console.error(`  échec ${item.subject}: ${item.reason}`);
	}
	for (const item of report.warnings) {
		console.warn(`  avertissement ${item.subject}: ${item.reason}`);
	}
}

function printSourceResult(
	source: PdfSource,
	result: {
		action: "added" | "replaced" | "unchanged" | null;
		failures: Array<{ reason: string }>;
		warnings: Array<{ reason: string }>;
	},
	dryRun: boolean,
) {
	const labels = {
		added: dryRun ? "à ajouter" : "ajouté",
		replaced: dryRun ? "à remplacer" : "remplacé",
		unchanged: "inchangé",
	};
	if (result.action) {
		console.log(
			`  ${labels[result.action]} ${source.guideId} — ${source.pdfUrl}`,
		);
	}
	for (const item of result.failures) {
		console.error(`  échec ${source.guideId}: ${item.reason}`);
	}
	for (const item of result.warnings) {
		console.warn(`  avertissement ${source.guideId}: ${item.reason}`);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const client = new AlbertClient({
		baseUrl:
			readSetting("ALBERT_BASE_URL", options.envFile) ??
			"https://albert.api.etalab.gouv.fr",
		apiKey: requireSetting("ALBERT_API_KEY", options.envFile),
	});
	const sources = extractFrenchPdfSources(await fetchCatalogue());
	const collection = await client.findCollectionByName(COLLECTION_NAME);
	if (!collection) {
		throw new Error(
			`Collection Albert introuvable: ${COLLECTION_NAME}. Lancez d'abord pnpm ingest -- --language FR.`,
		);
	}

	console.log(
		`${sources.length} PDF français dans le catalogue; lecture de la collection ${COLLECTION_NAME} (${collection.id}).`,
	);
	const inventory = await loadInventory(
		client,
		collection.id,
		options.concurrency,
	);
	console.log(`${inventory.length} documents existants inventorés.`);
	const report = await syncFrenchGuides({
		sources,
		inventory,
		client,
		collectionId: collection.id,
		dryRun: options.dryRun,
		concurrency: options.concurrency,
		onResult: (source, result) =>
			printSourceResult(source, result, options.dryRun),
	});
	printReport(report, options.dryRun);
	if (report.failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
