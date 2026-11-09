import { describe, expect, it } from "vitest";
import {
	type AnswerSource,
	parseAnswer,
	parseSpans,
} from "@/lib/render-answer";

const sources = new Map<number, AnswerSource>([
	[1, { marker: 1, url: "https://e.org/a.pdf#page=4", page: 4 }],
	[2, { marker: 2, url: "https://e.org/b.pdf", page: null }],
	[3, { marker: 3, url: null, page: 7 }],
]);

describe("parseSpans", () => {
	it("turns a known marker into a citation span", () => {
		expect(parseSpans("La MFA est requise [1].", sources)).toEqual([
			{ kind: "text", text: "La MFA est requise " },
			{
				kind: "citation",
				marker: 1,
				page: 4,
				url: "https://e.org/a.pdf#page=4",
			},
			{ kind: "text", text: "." },
		]);
	});

	it("splits runs of markers into one link each", () => {
		const spans = parseSpans("Recommandé [1][2].", sources);
		expect(spans.filter((span) => span.kind === "citation")).toHaveLength(2);
	});

	it("drops a marker that indexes no source", () => {
		// The model sometimes writes a number that is not one of its excerpts — a
		// list position or an article reference. Printing it would show a citation
		// the reader cannot follow, so it is removed and the text kept.
		const spans = parseSpans("Voir [42].", sources);
		expect(spans).toEqual([{ kind: "text", text: "Voir ." }]);
	});

	it("drops an unknown marker between two known ones", () => {
		const spans = parseSpans("a [1] b [43] c", sources);
		expect(spans.map((s) => s.kind)).toEqual(["text", "citation", "text"]);
		expect(
			spans
				.filter((s) => s.kind === "text")
				.map((s) => s.text)
				.join(""),
		).toBe("a  b  c");
	});

	it("carries an unknown page as null rather than guessing one", () => {
		const spans = parseSpans("[2]", sources);
		expect(spans).toEqual([
			{ kind: "citation", marker: 2, page: null, url: "https://e.org/b.pdf" },
		]);
	});

	it("keeps an excerpt-only citation without a URL", () => {
		const spans = parseSpans("Voir [3].", sources);
		expect(spans).toContainEqual({
			kind: "citation",
			marker: 3,
			page: 7,
			url: null,
		});
	});

	it("returns the whole text when there is no marker", () => {
		expect(parseSpans("Aucune citation ici.", sources)).toEqual([
			{ kind: "text", text: "Aucune citation ici." },
		]);
	});
});

describe("parseAnswer", () => {
	it("strips bold markers instead of showing asterisks", () => {
		const blocks = parseAnswer("Une **authentification forte** est requise.");
		expect(blocks).toEqual([
			{ kind: "paragraph", text: "Une authentification forte est requise." },
		]);
	});

	it("strips italic and inline code markers", () => {
		const blocks = parseAnswer("Le *principe* et la commande `sshd` restent.");
		expect(blocks[0]).toEqual({
			kind: "paragraph",
			text: "Le principe et la commande sshd restent.",
		});
	});

	it("renders dash lists as bullets", () => {
		const blocks = parseAnswer(
			"Recommandations :\n- premier point\n- second point",
		);
		expect(blocks).toEqual([
			{ kind: "paragraph", text: "Recommandations :" },
			{ kind: "bullet", text: "premier point" },
			{ kind: "bullet", text: "second point" },
		]);
	});

	it("renders numbered items as ordered entries", () => {
		const blocks = parseAnswer("1. segmenter\n2. journaliser");
		expect(blocks.map((block) => block.kind)).toEqual(["ordered", "ordered"]);
		expect(blocks[1]).toEqual({
			kind: "ordered",
			text: "journaliser",
			number: 2,
		});
	});

	it("keeps a list's own numbering when it follows another block", () => {
		const blocks = parseAnswer(
			"Recommandations :\n1. segmenter\n2. journaliser",
		);
		expect(blocks).toEqual([
			{ kind: "paragraph", text: "Recommandations :" },
			{ kind: "ordered", text: "segmenter", number: 1 },
			{ kind: "ordered", text: "journaliser", number: 2 },
		]);
	});

	it("honours a list that starts at a number other than one", () => {
		const blocks = parseAnswer("3. troisième\n4. quatrième");
		expect(
			blocks.map((block) => (block.kind === "ordered" ? block.number : null)),
		).toEqual([3, 4]);
	});

	it("joins wrapped lines into one paragraph", () => {
		const blocks = parseAnswer(
			"Une phrase\nqui continue ici.\n\nUn second paragraphe.",
		);
		expect(blocks).toEqual([
			{ kind: "paragraph", text: "Une phrase qui continue ici." },
			{ kind: "paragraph", text: "Un second paragraphe." },
		]);
	});

	it("drops heading markers", () => {
		const blocks = parseAnswer("## Synthèse\nLa MFA est requise.");
		expect(blocks[0]).toEqual({ kind: "paragraph", text: "Synthèse" });
	});

	it("keeps citations markers untouched", () => {
		const blocks = parseAnswer("La MFA est requise [1][2].");
		expect(blocks[0]).toEqual({
			kind: "paragraph",
			text: "La MFA est requise [1][2].",
		});
	});

	it("returns no block for empty input", () => {
		expect(parseAnswer("   ")).toEqual([]);
	});

	it("preserves colons and parentheses the model escapes", () => {
		const blocks = parseAnswer("Facteurs \\(FIDO2\\) : carte, OTP.");
		expect(blocks[0]).toEqual({
			kind: "paragraph",
			text: "Facteurs (FIDO2) : carte, OTP.",
		});
	});
});
