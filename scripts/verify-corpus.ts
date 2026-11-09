/**
 * Checks the indexed corpus end to end: every collection answers a probe query
 * and returns chunks carrying a page number and a citation URL.
 *
 * Usage: pnpm verify:corpus
 */
import { AlbertClient } from "../lib/albert/client";
import { loadConfig } from "../lib/config";
import {
	buildCitationUrl,
	type Citation,
	toCitations,
} from "../lib/rag/citations";

const PROBES = [
	"recommandations de sécurité réseau",
	"authentification multifacteur",
	"gestion de crise cyber",
];

async function main() {
	const config = loadConfig();
	const client = new AlbertClient({
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
	});

	let problems = 0;

	for (const collectionId of config.collectionIds) {
		console.log(`\nCollection ${collectionId}`);
		let answered = 0;

		for (const probe of PROBES) {
			const hits = await client.search({
				query: probe,
				collectionIds: [collectionId],
				limit: 5,
				method: "hybrid",
			});

			if (hits.length === 0) {
				console.log(`  "${probe}": aucun résultat`);
				continue;
			}

			const citations = toCitations(hits);
			const withPage = citations.filter(
				(citation): citation is Citation & { page: number; url: string } =>
					citation.page !== null && citation.url !== null,
			);

			if (withPage.length === 0) {
				console.log(
					`  "${probe}": ${hits.length} résultats, aucun numéro de page avec URL`,
				);
				problems += 1;
				continue;
			}

			const sample = withPage[0];
			const expected = buildCitationUrl(sample.url.split("#")[0], sample.page);

			if (sample.url !== expected) {
				console.log(
					`  "${probe}": URL de citation incohérente (${sample.url})`,
				);
				problems += 1;
				continue;
			}

			answered += 1;
			console.log(
				`  "${probe}": ${hits.length} résultats, ex. ${sample.title} p.${sample.page}`,
			);
		}

		if (answered === 0) {
			console.log("  collection sans citation exploitable");
			problems += 1;
		}
	}

	if (problems > 0) {
		console.error(`\n${problems} problème(s) détecté(s).`);
		process.exitCode = 1;
		return;
	}

	console.log("\nCorpus vérifié: citations et numéros de page présents.");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
