import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "nano-context";
const CHARACTERS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1200;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const USAGE_ENTRY_TYPE = "nano-context.usage";
const USAGE_EVENT = "nano-context:usage";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const LISTENER_STATE_KEY = Symbol.for("nano-context.usage-listeners");

const USED_SEGMENT_TEXT = "#15181D";
const FREE_SEGMENT_FILL = "#242731";
const FREE_SEGMENT_TEXT = "#C7D46A";

const USED_SEGMENTS = [
	{ key: "system", color: "#82CA7A", labels: ["system", "sys", "s"] },
	{ key: "prompt", color: "#E89BC1", labels: ["prompt", "pr", "p"] },
	{ key: "assistant", color: "#8BC7C2", labels: ["assistant", "ast", "a"] },
	{ key: "thinking", color: "#73D0D2", labels: ["think", "th", "t"] },
	{ key: "tools", color: "#D8A657", labels: ["tools", "tl", "x"] },
] as const;

const FREE_SEGMENT_LABELS = ["free", "fr", "f"] as const;

type ContextSegmentKey = (typeof USED_SEGMENTS)[number]["key"];
type ContextSegments = Readonly<Record<ContextSegmentKey, number>>;
type WritableContextSegments = Record<ContextSegmentKey, number>;

type ContextSnapshot = Readonly<{
	segments: ContextSegments;
	usedTokens: number;
	contextWindow: number;
	usageIsEstimated: boolean;
}>;

type FooterData = Readonly<{
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
}>;

type TrackedUsage = Readonly<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}>;

type WritableTrackedUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type ExternalUsageRecord = Readonly<{
	version: 1;
	id: string;
	source: string;
	sessionId: string;
	timestamp: number;
	usage: TrackedUsage;
}>;

type UsageListenerState = {
	dispose(): void;
};

type SessionUsageTotals = Readonly<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	external: TrackedUsage;
	latestCacheHitRate: number | undefined;
	totalCacheHitRate: number | undefined;
}>;

const emptyContextSegments = (): WritableContextSegments => ({
	system: 0,
	prompt: 0,
	assistant: 0,
	thinking: 0,
	tools: 0,
});

let latestContextSnapshot: ContextSnapshot = {
	segments: emptyContextSegments(),
	usedTokens: 0,
	contextWindow: 0,
	usageIsEstimated: false,
};

const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

const plainWidth = (text: string): number => Array.from(stripAnsi(text)).length;

const truncatePlainText = (text: string, width: number): string => {
	if (width <= 0) return "";

	const characters = Array.from(text);
	if (characters.length <= width) return text;
	if (width === 1) return "…";

	return `${characters.slice(0, width - 1).join("")}…`;
};

const fitStyledText = (text: string, width: number): string =>
	plainWidth(text) <= width ? text : truncatePlainText(stripAnsi(text), width);

const estimateTextTokens = (text: string): number => Math.ceil(text.length / CHARACTERS_PER_TOKEN);

const formatTokens = (count: number): string => {
	const value = Math.max(0, Math.round(count));

	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;

	return `${Math.round(value / 1000000)}M`;
};

const ansiColor = (mode: 38 | 48, hex: string, text: string): string => {
	const value = Number.parseInt(hex.replace(/^#/, ""), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	const reset = mode === 38 ? 39 : 49;

	return `\x1b[${mode};2;${red};${green};${blue}m${text}\x1b[${reset}m`;
};

const foreground = (hex: string, text: string): string => ansiColor(38, hex, text);

const background = (hex: string, text: string): string => ansiColor(48, hex, text);

const centeredText = (text: string, width: number): string => {
	const textWidth = plainWidth(text);
	if (textWidth > width) return " ".repeat(width);

	const left = Math.floor((width - textWidth) / 2);
	const right = width - textWidth - left;

	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object";

const emptyTrackedUsage = (): WritableTrackedUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
});

const addTrackedUsage = (target: WritableTrackedUsage, usage: TrackedUsage): void => {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.cost += usage.cost;
};

const nonNegativeNumber = (value: unknown, label: string): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`Nano Context: ${label} must be a finite non-negative number`);
	}
	return value;
};

const parseTrackedUsage = (value: unknown, label: string): TrackedUsage => {
	if (!isRecord(value)) throw new Error(`Nano Context: ${label} must be an object`);
	return {
		input: nonNegativeNumber(value.input, `${label}.input`),
		output: nonNegativeNumber(value.output, `${label}.output`),
		cacheRead: nonNegativeNumber(value.cacheRead, `${label}.cacheRead`),
		cacheWrite: nonNegativeNumber(value.cacheWrite, `${label}.cacheWrite`),
		cost: nonNegativeNumber(value.cost, `${label}.cost`),
	};
};

const parseExternalUsageRecord = (value: unknown, label: string): ExternalUsageRecord => {
	if (!isRecord(value)) throw new Error(`Nano Context: ${label} must be an object`);
	if (value.version !== 1) throw new Error(`Nano Context: ${label}.version must be 1`);
	for (const key of ["id", "source", "sessionId"] as const) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			throw new Error(`Nano Context: ${label}.${key} must be a non-empty string`);
		}
	}
	return {
		version: 1,
		id: value.id as string,
		source: value.source as string,
		sessionId: value.sessionId as string,
		timestamp: nonNegativeNumber(value.timestamp, `${label}.timestamp`),
		usage: parseTrackedUsage(value.usage, `${label}.usage`),
	};
};

const usageRecordKey = (record: ExternalUsageRecord): string => `${record.source}\0${record.id}`;

const hasTrackedUsage = (usage: TrackedUsage): boolean =>
	usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 || usage.cost > 0;

const childOriginUsage = async (sessionFiles: readonly string[]): Promise<TrackedUsage> => {
	const total = emptyTrackedUsage();
	for (const sessionFile of new Set(sessionFiles)) {
		const input = createReadStream(sessionFile, { encoding: "utf8" });
		const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		let childSessionId: string | undefined;
		let lineNumber = 0;
		try {
			for await (const line of lines) {
				lineNumber++;
				if (line.trim().length === 0) continue;
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch (error) {
					throw new Error(`Nano Context: invalid child session JSONL ${sessionFile}:${lineNumber}`, { cause: error });
				}
				if (!isRecord(entry)) continue;
				if (entry.type === "session") {
					if (typeof entry.id !== "string" || entry.id.length === 0) {
						throw new Error(`Nano Context: child session header has no id: ${sessionFile}`);
					}
					childSessionId = entry.id;
					continue;
				}
				if (entry.type !== "custom" || entry.customType !== USAGE_ENTRY_TYPE) continue;
				const record = parseExternalUsageRecord(entry.data, `child usage entry ${sessionFile}:${lineNumber}`);
				if (record.sessionId === childSessionId) addTrackedUsage(total, record.usage);
			}
		} finally {
			lines.close();
			input.destroy();
		}
		if (!childSessionId) throw new Error(`Nano Context: child session header not found: ${sessionFile}`);
	}
	return total;
};

const contentRecords = (content: unknown): readonly Record<string, unknown>[] =>
	Array.isArray(content) ? content.filter(isRecord) : [];

const textFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;

	return contentRecords(content)
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
};

const imageCount = (content: unknown): number =>
	contentRecords(content).filter((part) => part.type === "image").length;

const estimateContentTokens = (content: unknown): number =>
	estimateTextTokens(textFromContent(content)) + imageCount(content) * IMAGE_TOKEN_ESTIMATE;

const estimateToolCallTokens = (part: Record<string, unknown>): number => {
	const name = typeof part.name === "string" ? part.name : "";
	const input = JSON.stringify(part.arguments ?? {});

	return estimateTextTokens(`${name}${input}`);
};

const addAssistantTokens = (segments: WritableContextSegments, content: unknown): void => {
	for (const part of contentRecords(content)) {
		if (part.type === "text" && typeof part.text === "string") {
			segments.assistant += estimateTextTokens(part.text);
		}

		if (part.type === "thinking" && typeof part.thinking === "string") {
			segments.thinking += estimateTextTokens(part.thinking);
		}

		if (part.type === "toolCall") {
			segments.assistant += estimateToolCallTokens(part);
		}
	}
};

const segmentSessionMessages = (messages: readonly unknown[], systemPrompt: string): ContextSegments => {
	const segments = emptyContextSegments();
	segments.system = estimateTextTokens(systemPrompt);

	for (const message of messages) {
		if (!isRecord(message)) continue;

		if (message.role === "user") {
			segments.prompt += estimateContentTokens(message.content);
		}

		if (message.role === "assistant") {
			addAssistantTokens(segments, message.content);
		}

		if (message.role === "toolResult") {
			segments.tools += estimateContentTokens(message.content);
		}
	}

	return segments;
};

const segmentTotal = (segments: ContextSegments): number =>
	USED_SEGMENTS.reduce((total, segment) => total + segments[segment.key], 0);

const allocateProportionally = (values: readonly number[], columns: number): readonly number[] => {
	if (columns <= 0) return values.map(() => 0);

	const total = values.reduce((sum, value) => sum + value, 0);
	if (total <= 0) return values.map(() => 0);

	const rawColumns = values.map((value) => (value / total) * columns);
	const allocatedColumns = rawColumns.map(Math.floor);
	let remainingColumns = columns - allocatedColumns.reduce((sum, value) => sum + value, 0);

	const largestRemainders = rawColumns
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((left, right) => right.remainder - left.remainder);

	for (let index = 0; index < largestRemainders.length && remainingColumns > 0; index++, remainingColumns--) {
		const slot = largestRemainders[index]!;
		allocatedColumns[slot.index] = (allocatedColumns[slot.index] ?? 0) + 1;
	}

	return allocatedColumns;
};

const segmentsFromValues = (values: readonly number[]): ContextSegments => {
	const segments = emptyContextSegments();

	for (const [index, segment] of USED_SEGMENTS.entries()) {
		segments[segment.key] = values[index] ?? 0;
	}

	return segments;
};

const scaleSegmentsToUsage = (segments: ContextSegments, usedTokens: number): ContextSegments => {
	if (usedTokens <= 0 || segmentTotal(segments) <= 0) return segments;

	const values = USED_SEGMENTS.map((segment) => segments[segment.key]);

	return segmentsFromValues(allocateProportionally(values, Math.round(usedTokens)));
};

const sessionMessages = (ctx: ExtensionContext): readonly unknown[] => {
	const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());

	return context.messages as readonly unknown[];
};

const makeContextSnapshot = (ctx: ExtensionContext, messages: readonly unknown[]): ContextSnapshot => {
	const rawSegments = segmentSessionMessages(messages, ctx.getSystemPrompt());
	const usage = ctx.getContextUsage();
	const measuredTokens = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : undefined;
	const estimatedTokens = segmentTotal(rawSegments);
	const usedTokens = measuredTokens ?? estimatedTokens;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

	return {
		segments: scaleSegmentsToUsage(rawSegments, usedTokens),
		usedTokens,
		contextWindow,
		usageIsEstimated: measuredTokens === undefined,
	};
};

const chooseLabel = (labels: readonly string[], width: number): string => {
	for (const label of labels) {
		if (plainWidth(label) <= width) return label;
	}

	return "";
};

const renderUsedSegment = (labels: readonly string[], color: string, width: number): string => {
	if (width <= 0) return "";

	const label = chooseLabel(labels, width);
	const text = label.length > 0 ? foreground(USED_SEGMENT_TEXT, centeredText(label, width)) : " ".repeat(width);

	return background(color, text);
};

const writeText = (target: string[], text: string, start: number): void => {
	for (const [offset, character] of Array.from(text).entries()) {
		const index = start + offset;
		if (index >= 0 && index < target.length) target[index] = character;
	}
};

const chooseRightAlignedText = (options: readonly string[], width: number, blockedUntil: number): string => {
	for (const option of options) {
		const start = width - plainWidth(option);
		if (start > blockedUntil) return option;
	}

	return "";
};

const renderFreeSegment = (options: readonly string[], width: number): string => {
	if (width <= 0) return "";

	const content = Array.from({ length: width }, () => " ");
	const label = chooseLabel(FREE_SEGMENT_LABELS, width);
	const labelStart = Math.max(0, Math.floor((width - plainWidth(label)) / 2));
	const labelEnd = label.length > 0 ? labelStart + plainWidth(label) : -1;
	const rightText = chooseRightAlignedText(options, width, labelEnd);

	writeText(content, label, labelStart);
	writeText(content, rightText, width - plainWidth(rightText));

	return background(FREE_SEGMENT_FILL, foreground(FREE_SEGMENT_TEXT, content.join("")));
};

const allocateBarColumns = (values: readonly number[], width: number): readonly number[] => {
	const visibleUsedSegments = USED_SEGMENTS
		.map((_, index) => index)
		.filter((index) => (values[index] ?? 0) > 0);

	if (visibleUsedSegments.length === 0 || visibleUsedSegments.length >= width) {
		return allocateProportionally(values, width);
	}

	const minimumColumns = Array.from({ length: values.length }, () => 0);

	for (const index of visibleUsedSegments) {
		minimumColumns[index] = 1;
	}

	const remainingColumns = allocateProportionally(values, width - visibleUsedSegments.length);

	return minimumColumns.map((minimum, index) => minimum + (remainingColumns[index] ?? 0));
};

const renderContextBar = (snapshot: ContextSnapshot, width: number, freeTextOptions: readonly string[]): string => {
	const freeTokens = Math.max(0, snapshot.contextWindow - snapshot.usedTokens);
	const values = [...USED_SEGMENTS.map((segment) => snapshot.segments[segment.key]), freeTokens];
	const columns = allocateBarColumns(values, width);
	const usedSegments = USED_SEGMENTS
		.map((segment, index) => renderUsedSegment(segment.labels, segment.color, columns[index] ?? 0))
		.join("");
	const freeWidth = columns[USED_SEGMENTS.length] ?? 0;

	return `${usedSegments}${renderFreeSegment(freeTextOptions, freeWidth)}`;
};

const renderContextLine = (snapshot: ContextSnapshot, width: number, theme: Theme): string => {
	if (snapshot.contextWindow <= 0) return fitStyledText(theme.fg("dim", "ctx no model"), width);

	const prefix = snapshot.usageIsEstimated ? "~" : "";
	const percent = `${prefix}${((snapshot.usedTokens / snapshot.contextWindow) * 100).toFixed(1)}%`;
	const total = `${prefix}${formatTokens(snapshot.usedTokens)}/${formatTokens(snapshot.contextWindow)}`;
	const free = formatTokens(snapshot.contextWindow - snapshot.usedTokens);

	return renderContextBar(snapshot, width, [
		`ctx ${total} ${percent} ${free}`,
		`${total} ${percent} ${free}`,
		`${total} ${percent}`,
		percent,
	]);
};

const sanitizeStatus = (text: string): string =>
	text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();

const formatWorkingDirectory = (ctx: ExtensionContext, footerData: FooterData): string => {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const workingDirectory = home && ctx.cwd.startsWith(home) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
	const branch = footerData.getGitBranch();
	const sessionName = ctx.sessionManager.getSessionName();

	return [branch ? `${workingDirectory} (${branch})` : workingDirectory, sessionName].filter(Boolean).join(" • ");
};

const cumulativeUsage = (ctx: ExtensionContext): SessionUsageTotals => {
	const main = emptyTrackedUsage();
	const external = emptyTrackedUsage();

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			addTrackedUsage(main, {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cost: usage.cost.total,
			});
		}
		if (entry.type === "custom" && entry.customType === USAGE_ENTRY_TYPE) {
			addTrackedUsage(external, parseExternalUsageRecord(entry.data, `usage entry ${entry.id}`).usage);
		}
	}

	const latestAssistantEntry = [...ctx.sessionManager.getBranch()]
		.reverse()
		.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	const latestUsage = latestAssistantEntry?.type === "message" && latestAssistantEntry.message.role === "assistant"
		? latestAssistantEntry.message.usage
		: undefined;
	const latestPromptTokens = latestUsage
		? latestUsage.input + latestUsage.cacheRead + latestUsage.cacheWrite
		: 0;
	const latestCacheHitRate = latestUsage && latestPromptTokens > 0
		? (latestUsage.cacheRead / latestPromptTokens) * 100
		: undefined;
	const input = main.input + external.input;
	const output = main.output + external.output;
	const cacheRead = main.cacheRead + external.cacheRead;
	const cacheWrite = main.cacheWrite + external.cacheWrite;
	const cost = main.cost + external.cost;
	const totalPromptTokens = input + cacheRead + cacheWrite;
	const totalCacheHitRate = totalPromptTokens > 0
		? (cacheRead / totalPromptTokens) * 100
		: undefined;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost,
		external: { ...external },
		latestCacheHitRate,
		totalCacheHitRate,
	};
};

const formatFooterUsage = (usage: SessionUsageTotals, compact: boolean): string => {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const labels = compact
		? { prompt: "P", output: "O", cacheRead: "C", cacheWrite: "W", latestHit: "LH", totalHit: "AH" }
		: { prompt: "prompt ", output: "out ", cacheRead: "cache ", cacheWrite: "write ", latestHit: "last-hit ", totalHit: "all-hit " };
	const parts = [
		promptTokens > 0 ? `${labels.prompt}${formatTokens(promptTokens)}` : "",
		usage.cacheRead > 0 ? `${labels.cacheRead}${formatTokens(usage.cacheRead)}` : "",
		usage.latestCacheHitRate !== undefined
			? `${labels.latestHit}${usage.latestCacheHitRate.toFixed(1)}%`
			: "",
		usage.totalCacheHitRate !== undefined
			? `${labels.totalHit}${usage.totalCacheHitRate.toFixed(1)}%`
			: "",
		usage.cacheWrite > 0 ? `${labels.cacheWrite}${formatTokens(usage.cacheWrite)}` : "",
		usage.output > 0 ? `${labels.output}${formatTokens(usage.output)}` : "",
		usage.cost > 0 ? `$${usage.cost.toFixed(3)}` : "",
	];

	return parts.filter(Boolean).join(" ");
};

const formatExternalUsage = (external: TrackedUsage, compact: boolean): string => {
	if (!hasTrackedUsage(external)) return compact ? "X none" : "external none";

	const promptTokens = external.input + external.cacheRead + external.cacheWrite;
	const cacheHit = promptTokens > 0 ? `${((external.cacheRead / promptTokens) * 100).toFixed(1)}%` : "n/a";
	return compact
		? [
			"X",
			`P${formatTokens(promptTokens)}`,
			`C${formatTokens(external.cacheRead)}`,
			`H${cacheHit}`,
			`W${formatTokens(external.cacheWrite)}`,
			`O${formatTokens(external.output)}`,
			`$${external.cost.toFixed(3)}`,
		].join(" ")
		: [
			"external",
			`prompt ${formatTokens(promptTokens)}`,
			`cache ${formatTokens(external.cacheRead)}`,
			`hit ${cacheHit}`,
			`write ${formatTokens(external.cacheWrite)}`,
			`out ${formatTokens(external.output)}`,
			`$${external.cost.toFixed(3)}`,
		].join(" ");
};

const formatFooterModel = (pi: ExtensionAPI, ctx: ExtensionContext, footerData: FooterData): string => {
	const model = ctx.model;
	if (!model) return "no-model";

	const thinkingLevel = model.reasoning ? ` • ${pi.getThinkingLevel()}` : "";
	const modelName = `${model.id}${thinkingLevel}`;

	return footerData.getAvailableProviderCount() > 1 ? `(${model.provider}) ${modelName}` : modelName;
};

const renderFooter = (pi: ExtensionAPI, ctx: ExtensionContext, footerData: FooterData, width: number, theme: Theme): string[] => {
	const workingDirectory = theme.fg("dim", truncatePlainText(formatWorkingDirectory(ctx, footerData), width));
	const model = formatFooterModel(pi, ctx, footerData);
	const sessionUsage = cumulativeUsage(ctx);
	const fullUsage = formatFooterUsage(sessionUsage, false);
	const compactUsage = formatFooterUsage(sessionUsage, true);
	const usageCandidate = plainWidth(fullUsage) + 2 + plainWidth(model) <= width ? fullUsage : compactUsage;
	const usage = truncatePlainText(usageCandidate, width);
	const minimumGap = usage.length > 0 ? 2 : 0;
	const modelWidth = Math.max(0, width - plainWidth(usage) - minimumGap);
	const modelText = truncatePlainText(model, modelWidth);
	const gap = modelText.length > 0
		? Math.max(minimumGap, width - plainWidth(usage) - plainWidth(modelText))
		: 0;
	const line = theme.fg("dim", `${usage}${" ".repeat(gap)}${modelText}`);
	const fullExternalUsage = formatExternalUsage(sessionUsage.external, false);
	const compactExternalUsage = formatExternalUsage(sessionUsage.external, true);
	const externalCandidate = plainWidth(fullExternalUsage) <= width ? fullExternalUsage : compactExternalUsage;
	const externalText = width === 1 ? "X" : truncatePlainText(externalCandidate, width);
	const externalLine = theme.fg("dim", externalText);
	const statuses = Array.from(footerData.getExtensionStatuses().entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, text]) => sanitizeStatus(text))
		.join(" ");
	const lines = [workingDirectory, line, externalLine];

	return statuses.length > 0
		? [...lines, theme.fg("dim", truncatePlainText(statuses, width))]
		: lines;
};

const updateUi = (pi: ExtensionAPI, ctx: ExtensionContext, messages: readonly unknown[] = sessionMessages(ctx)): void => {
	if (!ctx.hasUI) return;

	latestContextSnapshot = makeContextSnapshot(ctx, messages);

	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
		render: (width: number) => [renderContextLine(latestContextSnapshot, width, theme)],
		invalidate: () => {},
	}), { placement: "belowEditor" });

	ctx.ui.setFooter((_tui, theme, footerData) => ({
		render: (width: number) => renderFooter(pi, ctx, footerData, width, theme),
		invalidate: () => {},
	}));
};

export default function nanoContext(pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;
	let seenUsageRecords = new Set<string>();

	const refreshFromSession = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		updateUi(pi, ctx);
	};

	const refreshFromTerminalSize = (): void => {
		if (activeContext) updateUi(pi, activeContext);
	};

	const persistUsageRecord = (record: ExternalUsageRecord): void => {
		if (!activeContext || record.sessionId !== activeContext.sessionManager.getSessionId()) return;
		const key = usageRecordKey(record);
		if (seenUsageRecords.has(key)) return;
		seenUsageRecords.add(key);
		pi.appendEntry(USAGE_ENTRY_TYPE, record);
		refreshFromSession(activeContext);
	};

	const reportForegroundSubagent = async (message: unknown, ctx: ExtensionContext): Promise<void> => {
		if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "subagent") return;
		if (!isRecord(message.details) || message.details.totalChildUsage === undefined) return;
		if (!activeContext) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== activeContext.sessionManager.getSessionId()) return;
		const usage = emptyTrackedUsage();
		addTrackedUsage(usage, parseTrackedUsage(message.details.totalChildUsage, "subagent foreground totalChildUsage"));
		const sessionFiles = Array.isArray(message.details.results)
			? message.details.results
				.filter(isRecord)
				.map((result) => result.sessionFile)
				.filter((sessionFile): sessionFile is string => typeof sessionFile === "string" && sessionFile.length > 0)
			: [];
		addTrackedUsage(usage, await childOriginUsage(sessionFiles));
		if (!hasTrackedUsage(usage)) return;
		if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) {
			throw new Error("Nano Context: subagent foreground result has no toolCallId");
		}
		persistUsageRecord({
			version: 1,
			id: `foreground:${message.toolCallId}`,
			source: "subagents/foreground",
			sessionId,
			timestamp: nonNegativeNumber(message.timestamp, "subagent foreground timestamp"),
			usage,
		});
	};

	const reportAsyncSubagent = async (payload: unknown): Promise<void> => {
		if (!activeContext || !isRecord(payload)) return;
		const sessionId = activeContext.sessionManager.getSessionId();
		if (payload.sessionId !== sessionId) return;
		if (typeof payload.runId !== "string" || payload.runId.length === 0) {
			throw new Error("Nano Context: async subagent completion has no runId");
		}
		if (!Array.isArray(payload.results)) {
			throw new Error(`Nano Context: async subagent ${payload.runId} has no results array`);
		}
		const usage = emptyTrackedUsage();
		const sessionFiles: string[] = [];
		for (const [resultIndex, result] of payload.results.entries()) {
			if (!isRecord(result)) throw new Error(`Nano Context: async subagent result ${resultIndex} is invalid`);
			if (typeof result.sessionPath === "string" && result.sessionPath.length > 0) sessionFiles.push(result.sessionPath);
			if (typeof result.sessionFile === "string" && result.sessionFile.length > 0) sessionFiles.push(result.sessionFile);
			if (result.modelAttempts === undefined) continue;
			if (!Array.isArray(result.modelAttempts)) {
				throw new Error(`Nano Context: async subagent result ${resultIndex}.modelAttempts is invalid`);
			}
			for (const [attemptIndex, attempt] of result.modelAttempts.entries()) {
				if (!isRecord(attempt) || attempt.usage === undefined) {
					throw new Error(`Nano Context: async subagent result ${resultIndex} attempt ${attemptIndex} has no usage`);
				}
				addTrackedUsage(usage, parseTrackedUsage(attempt.usage, `async subagent result ${resultIndex} attempt ${attemptIndex}.usage`));
			}
		}
		addTrackedUsage(usage, await childOriginUsage(sessionFiles));
		if (!hasTrackedUsage(usage)) return;
		const timestamp = nonNegativeNumber(payload.timestamp, `async subagent ${payload.runId}.timestamp`);
		persistUsageRecord({
			version: 1,
			id: `async:${payload.runId}`,
			source: "subagents/async",
			sessionId,
			timestamp,
			usage,
		});
	};

	const globalState = globalThis as unknown as Record<symbol, UsageListenerState | undefined>;
	globalState[LISTENER_STATE_KEY]?.dispose();
	const unsubscribers = [
		pi.events.on(USAGE_EVENT, (payload: unknown) => {
			if (!activeContext) throw new Error("Nano Context: usage event received without an active session");
			persistUsageRecord(parseExternalUsageRecord(payload, "usage event"));
		}),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, reportAsyncSubagent),
	];
	let listenersDisposed = false;
	const listenerState: UsageListenerState = {
		dispose(): void {
			if (listenersDisposed) return;
			listenersDisposed = true;
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
	globalState[LISTENER_STATE_KEY] = listenerState;

	pi.on("session_start", (_event, ctx) => {
		const restoredUsageRecords = new Set<string>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== USAGE_ENTRY_TYPE) continue;
			restoredUsageRecords.add(usageRecordKey(parseExternalUsageRecord(entry.data, `usage entry ${entry.id}`)));
		}
		seenUsageRecords = restoredUsageRecords;
		refreshFromSession(ctx);
	});

	pi.on("context", (event, ctx) => {
		activeContext = ctx;
		updateUi(pi, ctx, event.messages as readonly unknown[]);
	});

	pi.on("message_end", async (event, ctx) => reportForegroundSubagent(event.message, ctx));
	pi.on("agent_end", (_event, ctx) => refreshFromSession(ctx));
	pi.on("model_select", (_event, ctx) => refreshFromSession(ctx));
	pi.on("thinking_level_select", (_event, ctx) => refreshFromSession(ctx));
	pi.on("session_compact", (_event, ctx) => refreshFromSession(ctx));
	pi.on("session_tree", (_event, ctx) => refreshFromSession(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		ctx.ui.setFooter(undefined);
		activeContext = undefined;
		listenerState.dispose();
		if (globalState[LISTENER_STATE_KEY] === listenerState) delete globalState[LISTENER_STATE_KEY];
		process.stdout.off("resize", refreshFromTerminalSize);
	});

	process.stdout.on("resize", refreshFromTerminalSize);
}
