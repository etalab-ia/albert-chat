// biome-ignore-all lint/suspicious/noArrayIndexKey: parsed answer blocks and spans are immutable within a render and may repeat identical text; positional keys stay unique.
"use client";

import {
	AuiIf,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useAuiState,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef } from "react";
import {
	type AnswerSource,
	parseAnswer,
	parseSpans,
} from "@/lib/render-answer";
import { SendIcon, StopIcon } from "./icons";

/**
 * The sources attached to the assistant message being rendered, indexed by
 * their marker so "[2]" can link straight to the page it refers to.
 */
function useAnswerSources(): ReadonlyMap<number, AnswerSource> {
	const parts = useAuiState((state) => state.message.parts);

	return useMemo(() => {
		const index = new Map<number, AnswerSource>();
		for (const part of parts) {
			if (part.type !== "source" || part.sourceType !== "url") continue;
			const source = part as {
				marker?: number;
				url?: string;
				page?: number | null;
			};
			if (typeof source.marker !== "number" || typeof source.url !== "string") {
				continue;
			}
			index.set(source.marker, {
				marker: source.marker,
				url: source.url.length > 0 ? source.url : null,
				page: source.page ?? null,
			});
		}
		return index;
	}, [parts]);
}

const SUGGESTIONS = [
	"Quelles sont les recommandations pour segmenter un réseau ?",
	"Comment gérer une crise cyber ?",
	"Que recommande l'ANSSI sur l'authentification multifacteur ?",
];

export function WidgetThread() {
	const viewportRef = useRef<HTMLDivElement>(null);
	const messageCount = useAuiState((state) => state.thread.messages.length);

	// Put each new question at the top of the panel. The library's own anchor
	// handling left a question asked later in a long thread far below the
	// viewport, so the reader saw the end of the previous answer instead of the
	// question they had just sent.
	//
	// The alignment has to run more than once: at the instant the question
	// appears the answer below it is still empty, so the viewport cannot scroll
	// far enough and the position clamps short. It is re-applied as the answer
	// grows, and abandoned as soon as the reader scrolls by hand.
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || messageCount === 0) return;

		let expected: number | null = null;
		let cancelled = false;

		const align = () => {
			if (cancelled) return;
			// The reader took over: stop moving the viewport under them.
			if (expected !== null && Math.abs(viewport.scrollTop - expected) > 2) {
				cancelled = true;
				return;
			}

			const asked = viewport.querySelectorAll("[data-role='user-message']");
			const latest = asked[asked.length - 1];
			if (!latest) return;

			const offset =
				latest.getBoundingClientRect().top -
				viewport.getBoundingClientRect().top +
				viewport.scrollTop;
			const target = Math.max(0, offset - 16);
			if (Math.abs(viewport.scrollTop - target) > 1) {
				viewport.scrollTop = target;
			}
			expected = viewport.scrollTop;
		};

		// The answer below streams in over several seconds, and the target stays
		// clamped until it is tall enough. Watching the subtree means the
		// alignment follows the growth instead of guessing at timings.
		let queued = false;
		const schedule = () => {
			if (queued || cancelled) return;
			queued = true;
			requestAnimationFrame(() => {
				queued = false;
				align();
			});
		};

		const observer = new MutationObserver(schedule);
		observer.observe(viewport, {
			childList: true,
			subtree: true,
			characterData: true,
		});

		const frame = requestAnimationFrame(align);

		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, [messageCount]);

	return (
		<ThreadPrimitive.Root className="flex h-full min-h-0 flex-col bg-white">
			{/* Every automatic scroll-to-bottom is off: on run start and on each
          streamed chunk they carried the reader to the last line of the answer.
          The question is positioned explicitly above instead. */}
			<ThreadPrimitive.Viewport
				ref={viewportRef}
				autoScroll={false}
				scrollToBottomOnRunStart={false}
				scrollToBottomOnInitialize={false}
				scrollToBottomOnThreadSwitch={false}
				className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4"
			>
				<AuiIf condition={(state) => state.thread.isEmpty}>
					<EmptyState />
				</AuiIf>

				<ThreadPrimitive.Messages
					components={{ UserMessage, AssistantMessage }}
				/>
			</ThreadPrimitive.Viewport>

			<Composer />
		</ThreadPrimitive.Root>
	);
}

function EmptyState() {
	return (
		<div className="flex flex-1 flex-col justify-center gap-4 py-6">
			{/* The panel header already shows the name and the logo, so the empty
          state carries only the explanation. */}
			<div className="flex flex-col gap-1.5">
				<p className="text-[13px] leading-relaxed text-slate-600">
					Posez une question sur les guides publics de l&apos;ANSSI. Les
					réponses citent les documents et les pages utilisés.
				</p>
			</div>

			<div className="flex flex-col gap-1.5">
				{SUGGESTIONS.map((suggestion) => (
					<ThreadPrimitive.Suggestion
						key={suggestion}
						prompt={suggestion}
						send
						className="rounded-md border border-slate-200 px-3 py-2 text-left text-[12.5px] leading-snug text-slate-700 transition-colors hover:border-[#000091]/40 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#000091]"
					>
						{suggestion}
					</ThreadPrimitive.Suggestion>
				))}
			</div>
		</div>
	);
}

function UserMessage() {
	return (
		<div className="mb-3 flex justify-end" data-role="user-message">
			<div className="max-w-[85%] rounded-lg rounded-br-sm bg-[#000091] px-3 py-2 text-[13px] leading-relaxed text-white">
				<MessagePrimitive.Parts components={{ Text: PlainText }} />
			</div>
		</div>
	);
}

function PlainText({ text }: { text: string }) {
	return <p className="whitespace-pre-line">{text}</p>;
}

const NO_PART = () => null;
const ANSWER_PARTS = {
	Text: AnswerTextPart,
	Source: NO_PART,
	Image: NO_PART,
	File: NO_PART,
};

/**
 * The parts renderer is given module-level components so React keeps one
 * identity per part type across renders. Defining them inline rebuilt the
 * subtree on every streamed token.
 */
function AnswerTextPart({ text }: { text: string }) {
	const sources = useAnswerSources();
	return <AnswerText text={text} sources={sources} />;
}

function AssistantMessage() {
	return (
		<div className="mb-4 max-w-full">
			<div className="text-[13px] leading-relaxed text-slate-800">
				<MessagePrimitive.Parts components={ANSWER_PARTS} />
				<WaitingDots />
			</div>
		</div>
	);
}

function AnswerText({
	text,
	sources,
}: {
	text: string;
	sources: ReadonlyMap<number, AnswerSource>;
}) {
	if (!text) return null;

	const blocks = parseAnswer(text);

	return (
		<div className="flex flex-col gap-1.5">
			{blocks.map((block, index) => {
				const key =
					block.kind === "ordered"
						? `${block.kind}:${block.number}:${block.text}:${index}`
						: `${block.kind}:${block.text}:${index}`;
				if (block.kind === "bullet") {
					return (
						<div key={key} className="flex gap-2 pl-0.5">
							<span
								aria-hidden="true"
								className="mt-2 size-1 shrink-0 rounded-full bg-slate-400"
							/>
							<p className="flex-1">
								<InlineText text={block.text} sources={sources} />
							</p>
						</div>
					);
				}

				if (block.kind === "ordered") {
					return (
						<div key={key} className="flex gap-2 pl-0.5">
							<span className="shrink-0 tabular-nums text-slate-500">
								{block.number}.
							</span>
							<p className="flex-1">
								<InlineText text={block.text} sources={sources} />
							</p>
						</div>
					);
				}

				return (
					<p key={key} className="whitespace-pre-line">
						<InlineText text={block.text} sources={sources} />
					</p>
				);
			})}
		</div>
	);
}

/**
 * Renders one block of answer text, turning citation markers into links to the
 * cited page. The marker keeps the "[n]" shape so the reader can still see
 * which source a sentence comes from.
 */
function InlineText({
	text,
	sources,
}: {
	text: string;
	sources: ReadonlyMap<number, AnswerSource>;
}) {
	const spans = parseSpans(text, sources);

	if (spans.length === 0) return <>{text}</>;

	return (
		<>
			{spans.map((span, index) => {
				if (span.kind === "text")
					return <span key={`text:${span.text}:${index}`}>{span.text}</span>;

				const where =
					span.page === null ? "le document cité" : `la page ${span.page}`;

				if (span.url === null) {
					return (
						<span
							key={`citation:${span.marker}:excerpt:${index}`}
							title={`Source ${span.marker}, ${where}`}
							className="ml-0.5 inline-flex items-center rounded-sm bg-[#000091]/8 px-1 text-[11.5px] font-medium text-[#000091]"
						>
							<span className="sr-only">{`Source ${span.marker}, ${where}`}</span>
							<span aria-hidden="true">{span.marker}</span>
						</span>
					);
				}

				return (
					<a
						key={`citation:${span.marker}:${span.url}:${index}`}
						href={span.url}
						target="_blank"
						rel="noopener noreferrer"
						title={`Ouvrir ${where}`}
						aria-label={`Source ${span.marker}, ouvrir ${where}`}
						className="ml-0.5 inline-flex items-center rounded-sm bg-[#000091]/8 px-1 text-[11.5px] font-medium text-[#000091] no-underline transition-colors hover:bg-[#000091] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#000091]"
					>
						{span.marker}
					</a>
				);
			})}
		</>
	);
}

function WaitingDots() {
	const isRunning = useAuiState(
		(state) => state.message.status?.type === "running",
	);
	const hasText = useAuiState((state) =>
		state.message.parts.some(
			(part) => part.type === "text" && part.text.trim().length > 0,
		),
	);

	if (!isRunning || hasText) return null;

	return (
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: a named status indicator, not a decorative element.
		<span className="mt-1 flex gap-1" aria-label="Recherche en cours">
			<span className="size-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:-0.3s]" />
			<span className="size-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:-0.15s]" />
			<span className="size-1.5 animate-pulse rounded-full bg-slate-400" />
		</span>
	);
}

function Composer() {
	return (
		<ComposerPrimitive.Root className="border-t border-slate-200 bg-white p-2.5">
			<div className="flex items-end gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 focus-within:border-[#000091] focus-within:ring-2 focus-within:ring-[#000091]/15">
				<ComposerPrimitive.Input
					placeholder="Votre question…"
					rows={1}
					maxRows={4}
					className="max-h-24 min-h-8 flex-1 resize-none bg-transparent py-1 text-[13px] leading-relaxed text-slate-900 outline-none placeholder:text-slate-400"
					aria-label="Votre question"
				/>
				<AuiIf condition={(state) => state.thread.isRunning}>
					<ComposerPrimitive.Cancel
						className="mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#000091]"
						aria-label="Arrêter la réponse"
					>
						<StopIcon className="size-3.5" />
					</ComposerPrimitive.Cancel>
				</AuiIf>
				<AuiIf condition={(state) => !state.thread.isRunning}>
					<ComposerPrimitive.Send
						className="mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-[#000091] text-white transition-opacity hover:opacity-90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#000091]"
						aria-label="Envoyer"
					>
						<SendIcon className="size-3.5" />
					</ComposerPrimitive.Send>
				</AuiIf>
			</div>
		</ComposerPrimitive.Root>
	);
}
