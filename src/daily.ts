import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
import type { PlanTemplate } from "./settings";

/**
 * Date + daily-note utilities.
 *
 * All note formats strictly follow PRD §2. Task lines use the Tasks format:
 * `- [ ] 内容 #计划/{计划名} 🛫 YYYY-MM-DD 📅 YYYY-MM-DD`
 */

export const CHECK_HEADING = "## ✅ 今日打卡";
export const SUMMARY_HEADING = "## 📝 今日总结";

/**
 * Parse a single Tasks-style line (DEV.md §5 踩坑记录 #6).
 * Groups: [1]=checkbox, [2]=content, [3]=plan tag, [4]=🛫 date, [5]=📅 date.
 */
export const TASK_LINE_RE =
	/^- \[([ x])\] (.+?)(?: #计划\/(\S+))?(?: 🛫 (\d{4}-\d{2}-\d{2}))?(?: 📅 (\d{4}-\d{2}-\d{2}))?$/;

/** A check-in item inside the daily note. */
export interface CheckItem {
	/** Task content (no `- [ ]` marker, no plan tag). */
	text: string;
	/** Plan tag name (without `#计划/`), or null for temp tasks. */
	plan: string | null;
	checked: boolean;
	/** Due date `📅` (falls back to scheduled date), or null. */
	due: string | null;
	/** 0-based line index inside the note file. */
	line: number;
	/** The full raw line. */
	raw: string;
	/** The note file this item lives in. */
	file: TFile;
}

/** A temp task coming from the daily note or a week/month note frontmatter. */
export interface TempTask {
	text: string;
	plan: string | null;
	checked: boolean;
	/** Due date `📅` (or `end`), or null. */
	due: string | null;
	/** Scheduled date `🛫` (or `start`), or null. */
	start: string | null;
	/** Where the task was read from. */
	source: "daily" | "week" | "month";
	file: TFile;
	/** Index inside the temp-tasks source (frontmatter array / multiline block). */
	index: number;
	/** Line index in the daily note when source is "daily", otherwise -1. */
	line: number;
	/** Full raw line (empty for object-formatted frontmatter tasks). */
	raw: string;
	/** Whether the checkbox can be toggled (object-formatted tasks cannot). */
	togglable: boolean;
}

/** Parsed daily note content. */
export interface DailyData {
	date: string;
	file: TFile;
	content: string;
	/** Check-in items carrying a `#计划/` tag. */
	checkItems: CheckItem[];
	/** Temp tasks written directly in the daily note (no plan tag). */
	tempItems: TempTask[];
	/** Editable summary text (PRD §2.2). */
	summary: string;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function formatDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function parseDateString(s: string): Date {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
	const r = new Date(d);
	r.setDate(r.getDate() + n);
	return r;
}

export function todayStr(): string {
	return formatDate(new Date());
}

export function weekdayName(dateStr: string): string {
	return WEEKDAYS[parseDateString(dateStr).getDay()];
}

/** ISO-8601 week number of a date (with its ISO year). */
export function getISOWeek(dateStr: string): { year: number; week: number } {
	const d = parseDateString(dateStr);
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const dayNum = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return { year: date.getUTCFullYear(), week };
}

/** Monday-start week range (inclusive) containing the given date. */
export function weekRange(dateStr: string): { start: string; end: string } {
	const d = parseDateString(dateStr);
	const day = d.getDay() || 7; // Mon=1 ... Sun=7
	const start = addDays(d, 1 - day);
	return { start: formatDate(start), end: formatDate(addDays(start, 6)) };
}

export function daysInMonth(year: number, month: number): number {
	return new Date(year, month, 0).getDate(); // month is 1-based
}

/** Number of days in [start, end], inclusive. */
export function dayCount(start: string, end: string): number {
	const s = parseDateString(start);
	const e = parseDateString(end);
	return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
}

/** Number of weekdays (Mon-Fri) in [start, end], inclusive. */
export function countWorkdays(start: string, end: string): number {
	const s = parseDateString(start);
	const e = parseDateString(end);
	let count = 0;
	const cur = new Date(s);
	while (cur <= e) {
		const day = cur.getDay();
		if (day !== 0 && day !== 6) count++;
		cur.setDate(cur.getDate() + 1);
	}
	return count;
}

// ---------------------------------------------------------------------------
// Task line parsing
// ---------------------------------------------------------------------------

/** Parse a single task line; returns null when not a Tasks line. */
export function parseTaskLine(line: string): Pick<CheckItem, "text" | "plan" | "checked" | "due"> | null {
	const m = TASK_LINE_RE.exec(line.trim());
	if (!m) return null;
	return {
		text: m[2].trim(),
		plan: m[3] ?? null,
		checked: m[1] === "x",
		due: m[5] ?? m[4] ?? null,
	};
}

/** Parse a daily note's content into structured data. */
export function parseDailyContent(file: TFile, content: string, date: string): DailyData {
	const lines = content.split("\n");
	const checkItems: CheckItem[] = [];
	const tempItems: TempTask[] = [];
	let inCheckSection = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) {
			inCheckSection = line.startsWith(CHECK_HEADING);
			continue;
		}
		if (!inCheckSection) continue;
		const m = TASK_LINE_RE.exec(line);
		if (!m) continue;
		const checked = m[1] === "x";
		const plan = m[3] ?? null;
		const base = {
			text: m[2].trim(),
			plan,
			checked,
			due: m[5] ?? m[4] ?? null,
			raw: line,
		};
		if (plan) {
			checkItems.push({ ...base, line: i, file });
		} else {
			tempItems.push({
				...base,
				start: m[4] ?? null,
				source: "daily",
				file,
				index: i,
				line: i,
				togglable: true,
			});
		}
	}

	return {
		date,
		file,
		content,
		checkItems,
		tempItems,
		summary: extractSummary(content),
	};
}

// ---------------------------------------------------------------------------
// Summary section (PRD §2.2: replace content between the heading and the
// next `##` heading — while preserving trailing callout/tip blocks)
// ---------------------------------------------------------------------------

/** Extract the editable summary text (without the heading). */
export function extractSummary(content: string): string {
	const idx = content.indexOf(SUMMARY_HEADING);
	if (idx === -1) return "";
	const after = content.slice(idx + SUMMARY_HEADING.length);
	let end = after.length;
	const nextHeading = /\n##\s/.exec(after);
	if (nextHeading) end = nextHeading.index;
	let region = after.slice(0, end);
	// Trim trailing callout blocks (e.g. the `> [!tip]` help block in templates).
	const callout = /\n\n>/.exec(region);
	if (callout) region = region.slice(0, callout.index);
	return region.replace(/^\n+/, "").trimEnd();
}

/**
 * Replace the summary region, keeping everything else intact.
 * DEV.md 踩坑记录 #5: never let a regex swallow the newline that separates
 * the summary from the next heading / callout block.
 */
export function replaceSummary(content: string, summary: string): string {
	const idx = content.indexOf(SUMMARY_HEADING);
	if (idx === -1) return content;
	const head = content.slice(0, idx + SUMMARY_HEADING.length);
	const after = content.slice(idx + SUMMARY_HEADING.length);

	let end = after.length;
	const nextHeading = /\n##\s/.exec(after);
	if (nextHeading) end = nextHeading.index;
	const callout = /\n\n>/.exec(after.slice(0, end));

	let tail = "";
	if (callout) {
		tail = after.slice(callout.index + 2); // keep "> [!tip] ..." block
	} else if (nextHeading) {
		tail = after.slice(nextHeading.index + 1); // keep "## next heading"
	}

	let result = head + "\n" + summary;
	if (tail) result += "\n\n" + tail;
	else result += "\n";
	return result;
}

// ---------------------------------------------------------------------------
// Line-level mutations (checkbox / add / remove / move)
// ---------------------------------------------------------------------------

export function toggleTaskLine(content: string, lineIndex: number, checked: boolean, expectedRaw?: string): string {
	const lines = content.split("\n");
	// v2.5 (B2): 内容定位兜底——行号处内容与预期不符说明文件被外部改动（行号漂移），
	// 按原始行文本重定位；找不到则放弃写回（fail-safe，防改错行）
	let idx = lineIndex;
	if (expectedRaw && lines[idx] !== expectedRaw) {
		idx = lines.findIndex((l) => l === expectedRaw);
		if (idx === -1) return content;
	}
	const line = lines[idx];
	if (line === undefined || !/^- \[[ x]\]/.test(line)) return content;
	lines[idx] = line.replace(/^- \[[ x]\]/, checked ? "- [x]" : "- [ ]");
	return lines.join("\n");
}

export function removeLine(content: string, lineIndex: number, expectedRaw?: string): string {
	const lines = content.split("\n");
	let idx = lineIndex;
	if (expectedRaw && lines[idx] !== expectedRaw) {
		idx = lines.findIndex((l) => l === expectedRaw);
		if (idx === -1) return content;
	}
	if (idx < 0 || idx >= lines.length) return content;
	lines.splice(idx, 1);
	return lines.join("\n");
}

export function moveTaskLine(content: string, lineIndex: number, delta: number, expectedRaw?: string): string {
	const lines = content.split("\n");
	let idx = lineIndex;
	if (expectedRaw && lines[idx] !== expectedRaw) {
		idx = lines.findIndex((l) => l === expectedRaw);
		if (idx === -1) return content;
	}
	const target = idx + delta;
	if (idx < 0 || idx >= lines.length) return content;
	if (target < 0 || target >= lines.length) return content;
	if (!/^- \[[ x]\]/.test(lines[idx]) || !/^- \[[ x]\]/.test(lines[target])) return content;
	const tmp = lines[idx];
	lines[idx] = lines[target];
	lines[target] = tmp;
	return lines.join("\n");
}

/** Append a task line inside the `## ✅ 今日打卡` section (after the last task). */
export function appendCheckItem(content: string, line: string): string {
	const lines = content.split("\n");
	const headingIdx = lines.findIndex((l) => l.startsWith(CHECK_HEADING));
	if (headingIdx === -1) {
		return content.replace(/\s*$/, "\n\n" + CHECK_HEADING + "\n" + line + "\n");
	}
	let insertIdx = headingIdx + 1;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) break;
		if (/^- \[[ x]\]/.test(lines[i])) insertIdx = i + 1;
	}
	lines.splice(insertIdx, 0, line);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Quota plans (ADR-0001 日定额型)
// Line format: `- [x] ✍️ 写小说 1170字（实 800字） #计划/小说 🛫 … 📅 …`
// - 勾选 = 记满当日配额；`（实 N{unit}）` 后缀记录实际量（可选项）
// - 惰性生成：打开今日视图时幂等补写当天缺失行，绝不改写已有行
// ---------------------------------------------------------------------------

/**
 * 手动优先标记（ADR-0007）：用户在 UI 里手动勾/退勾或手填实际量的行会带上 `✋`，
 * 自动逻辑（BZG 联动写实量/自动勾）遇到 `✋` 一律跳过——手动永远优先。
 */
export const MANUAL_MARK = "✋";

/** `（实 800字）` suffix on a quota check-in line（容忍尾随 `✋` 手动标记）. */
export const QUOTA_ACTUAL_RE = /（实\s*([\d.]+)\s*[^）]*）\s*(?:✋\s*)?$/;

/** Extract the actual amount recorded on a quota line, or null. */
export function parseQuotaActual(text: string): number | null {
	const m = QUOTA_ACTUAL_RE.exec(text);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** Extract the per-day quota amount embedded in the line text (e.g. "1170字" → 1170). */
export function parseQuotaAmount(text: string): number | null {
	const stripped = text.replace(QUOTA_ACTUAL_RE, "");
	const matches = [...stripped.matchAll(/\d+(?:\.\d+)?/g)];
	if (matches.length === 0) return null;
	const n = parseFloat(matches[matches.length - 1][0]);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** Format an amount: integers stay integers, fractions keep 1 decimal. */
export function formatQuotaAmount(n: number): string {
	const r = Math.round(n * 10) / 10;
	return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export interface BuildQuotaLineParams {
	/** Icon prefix, e.g. "✍️". May be empty. */
	label: string;
	/** Plan name (also the plan tag). */
	plan: string;
	/** Daily quota amount. */
	quota: number;
	/** Unit, e.g. "字". May be empty. */
	unit: string;
	date: string;
}

/** Build a quota check-in line: `- [ ] ✍️ 写小说 1170字 #计划/小说 🛫 … 📅 …`. */
export function buildQuotaCheckLine({ label, plan, quota, unit, date }: BuildQuotaLineParams): string {
	const name = label ? `${label} ${plan}` : plan;
	return `- [ ] ${name} ${formatQuotaAmount(quota)}${unit} #计划/${plan} 🛫 ${date} 📅 ${date}`;
}

/**
 * Record the actual amount on a quota line (replacing any previous `（实 …）`)
 * and set its checkbox. `actual <= 0` clears the suffix. Other line parts
 * (plan tag / 🛫 / 📅) are preserved from the parsed groups.
 * 残留的 `✋` 一并剥除（ADR-0011：模式行取消手动豁免，勾选/实数一律镜像完成事实）。
 */
export function setQuotaActual(
	content: string,
	lineIndex: number,
	actual: number,
	unit: string,
	checked: boolean,
	expectedRaw?: string
): string {
	const lines = content.split("\n");
	let idx = lineIndex;
	if (expectedRaw && lines[idx] !== expectedRaw) {
		idx = lines.findIndex((l) => l === expectedRaw);
		if (idx === -1) return content;
	}
	const line = lines[idx];
	if (line === undefined) return content;
	const m = TASK_LINE_RE.exec(line.trim());
	if (!m) return content;
	const text = m[2].trim().replace(/（实[^）]*）\s*(?:✋\s*)?$/, "").replace(MANUAL_MARK, "").trimEnd();
	const actualPart = actual > 0 ? `（实 ${formatQuotaAmount(actual)}${unit}）` : "";
	let rebuilt = `- [${checked ? "x" : " "}] ${text}${actualPart}`;
	if (m[3]) rebuilt += ` #计划/${m[3]}`;
	if (m[4]) rebuilt += ` 🛫 ${m[4]}`;
	if (m[5]) rebuilt += ` 📅 ${m[5]}`;
	lines[idx] = rebuilt;
	return lines.join("\n");
}

/**
 * 给任务行打 `✋` 手动标记。已有标记则原样返回（幂等）。
 * 仅阅读联动使用（ADR-0009：联动叶手动退勾/推进忽略落 ✋，此后自动逻辑不再勾该叶）；
 * 模式行已无 ✋ 豁免（ADR-0011：事实优先）。
 */
export function markTaskLineManual(content: string, lineIndex: number, expectedRaw?: string): string {
	const lines = content.split("\n");
	let idx = lineIndex;
	if (expectedRaw && lines[idx] !== expectedRaw) {
		idx = lines.findIndex((l) => l === expectedRaw);
		if (idx === -1) return content;
	}
	const line = lines[idx];
	if (line === undefined || !/^- \[[ x]\]/.test(line)) return content;
	if (line.includes(MANUAL_MARK)) return content;
	const m = TASK_LINE_RE.exec(line.trim());
	if (!m) return content;
	let rebuilt = `- [${m[1]}] ${m[2].trimEnd()}${MANUAL_MARK}`;
	if (m[3]) rebuilt += ` #计划/${m[3]}`;
	if (m[4]) rebuilt += ` 🛫 ${m[4]}`;
	if (m[5]) rebuilt += ` 📅 ${m[5]}`;
	lines[idx] = rebuilt;
	return lines.join("\n");
}

/**
 * 清除任务行上的 `✋` 手动标记，勾选态/实数/标签/日期原样保留（幂等）。
 * ADR-0011：模式行取消手动豁免后，存量行的残留标记由自动回填顺带清掉；
 * 阅读联动的 ✋ 不走模式行回填，不受影响。
 */
export function clearManualMark(content: string, lineIndex: number, expectedRaw?: string): string {
	const lines = content.split("\n");
	let idx = lineIndex;
	if (expectedRaw && lines[idx] !== expectedRaw) {
		idx = lines.findIndex((l) => l === expectedRaw);
		if (idx === -1) return content;
	}
	const line = lines[idx];
	if (line === undefined || !line.includes(MANUAL_MARK)) return content;
	const m = TASK_LINE_RE.exec(line.trim());
	if (!m) return content;
	let rebuilt = `- [${m[1]}] ${m[2].replace(MANUAL_MARK, "").trimEnd()}`;
	if (m[3]) rebuilt += ` #计划/${m[3]}`;
	if (m[4]) rebuilt += ` 🛫 ${m[4]}`;
	if (m[5]) rebuilt += ` 📅 ${m[5]}`;
	lines[idx] = rebuilt;
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 模式目标每日行（ADR-0006 目标模式：复习/日记/运动）
// 复习/运动：`- [ ] 🗣️ 文献复习 5篇（实 3篇） #计划/学习 🛫 D 📅 D`
// 日记：    `- [ ] 📝 日记 #计划/复盘 🛫 D 📅 D`
// 与 quota 行同构（惰性幂等补写；已存在的行一律不重建）。
// ---------------------------------------------------------------------------

/** 一条模式行生成规格（structural，避免依赖 stats）。 */
export interface ModeLineSpec {
	/** Plan tag name. */
	plan: string;
	/** Goal name（行文本的核心词，识别既有行用 includes 匹配）. */
	name: string;
	/** Plan icon prefix, e.g. "🗣️". May be empty. */
	label: string;
	/** 每日量（复习=下限；运动=可选目标量；日记恒 0）。 */
	floor: number;
	/** 单位（篇/分钟…），可为空。 */
	unit: string;
}

/** 构建模式行：`- [ ] {label} {name} {floor}{unit} #计划/{plan} 🛫 D 📅 D`。 */
export function buildModeCheckLine({ plan, name, label, floor, unit }: ModeLineSpec, date: string): string {
	let content = label ? `${label} ${name}` : name;
	if (floor > 0) content += ` ${formatQuotaAmount(floor)}${unit}`;
	return `- [ ] ${content} #计划/${plan} 🛫 ${date} 📅 ${date}`;
}

/**
 * 判断打卡行文本是否为某模式目标的行（ADR-0006 行识别，防止把计划默认打卡行误判）：
 * - 剥离行首 emoji/符号前缀后，须以目标名开头；
 * - 有每日量（floor>0）时，行内须含「N{unit}」记号（如「5篇」「30分钟」）；
 * - 无量（floor=0，日记/纯打卡运动）时，整行剥离前缀后必须恰为目标名
 *   ——计划默认行（如「运动 每天半小时」）永远多出动作文本，不会被误判。
 */
export function matchesModeLine(text: string, name: string, floor: number, unit: string): boolean {
	const stripped = text
		.trim()
		.replace(/^[^\w\u4e00-\u9fff]+/, "")
		.trim();
	if (floor > 0) {
		return stripped.startsWith(name) && stripped.includes(`${formatQuotaAmount(floor)}${unit || ""}`);
	}
	return stripped === name;
}

/** 大项口径下的一个顶层打卡行（今日打卡进度 / 连续打卡共用的计数单位）。 */
export interface TopCheckRow {
	/** 顶层行自身（非模式子行的打卡行）。 */
	item: CheckItem;
	/** 嵌套渲染在该父行下的模式子行（保持文件顺序）。 */
	modeChildren: CheckItem[];
	/** 聚合完成态：自身已勾，或模式子行全勾（与「勾满子 → 父自动勾」级联同一把尺）。 */
	done: boolean;
}

/**
 * 今日打卡大项口径（ADR-0012）：顶层行 = 非模式行；同计划首个非模式行是该计划的
 * 父行，模式行嵌套其下（ADR-0006，与 updateChecklist 的渲染嵌套同一规则）。
 * 父行聚合完成态含「子行全勾」——回填勾子与级联勾父的间隙不吞完成度。
 * 无父行的模式行保持顶层（渲染同款兜底），任务池子任务不进此口径（书叶有自己的今日书进度）。
 */
export function topLevelCheckRows(
	checkItems: CheckItem[],
	isModeLine: (item: CheckItem) => boolean
): TopCheckRow[] {
	const childrenOf = new Map<CheckItem, CheckItem[]>();
	const isChild = new Set<CheckItem>();
	for (const item of checkItems) {
		if (!item.plan || !isModeLine(item)) continue;
		const parent = checkItems.find((it) => it.plan === item.plan && !isModeLine(it));
		if (!parent) continue;
		isChild.add(item);
		const arr = childrenOf.get(parent) ?? [];
		arr.push(item);
		childrenOf.set(parent, arr);
	}
	return checkItems
		.filter((it) => !isChild.has(it))
		.map((item) => {
			const modeChildren = childrenOf.get(item) ?? [];
			return {
				item,
				modeChildren,
				done: item.checked || (modeChildren.length > 0 && modeChildren.every((c) => c.checked)),
			};
		});
}

/**
 * ADR-0010: 写作字数行识别（放宽版模式行匹配）——剥离行首 emoji 前缀后以目标名开头且名后带数字
 * （行文本 = `{名} {配额}字（实 N字）`）。不校验配额数本身：历史行的配额冻结于创建时，
 * 目标编辑总量/截止后旧行数字过期是常态，统计必须跨配额变更累计（与 matchesModeLine 的差异）。
 * 剥离用 Extended_Pictographic 范围（不动 CJK 标点）——书名号《开头的目标名不能被吃掉。
 */
export function matchesWritingLine(text: string, name: string): boolean {
	const stripped = text
		.trim()
		.replace(/^(?:[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s])+/u, "")
		.trim();
	if (!stripped.startsWith(name)) return false;
	const rest = stripped.slice(name.length);
	return /\d/.test(rest);
}

/**
 * 返回今日缺失的模式行（ADR-0006 惰性生成，幂等）。
 * 识别既有行：同计划标签 + 行文本包含目标名（label 前缀不影响）。
 */
export function missingModeLines(content: string, specs: ModeLineSpec[], date: string): string[] {
	const existing = new Set<string>();
	const lines = content.split("\n");
	let inCheck = false;
	for (const line of lines) {
		if (/^##\s/.test(line)) {
			inCheck = line.startsWith(CHECK_HEADING);
			continue;
		}
		if (!inCheck) continue;
		const m = TASK_LINE_RE.exec(line);
		if (m?.[3]) existing.add(`${m[3]}|${m[2].trim()}`);
	}
	const out: string[] = [];
	for (const s of specs) {
		let found = false;
		for (const key of existing) {
			const [plan, text] = key.split("|");
			if (plan === s.plan && text.includes(s.name)) {
				found = true;
				break;
			}
		}
		if (!found) out.push(buildModeCheckLine(s, date));
	}
	return out;
}

/** A quota plan flattened for line generation (structural; avoids importing stats). */
export interface QuotaLineSpec {
	plan: string;
	label: string;
	quota: number;
	unit: string;
}

/**
 * Return the quota check-in lines missing from the daily note's
 * `## ✅ 今日打卡` section (ADR-0001 惰性生成，幂等：已有该计划标签的行
 * 一律不重写——含用户手删后次日复活的取舍，见 ADR）。
 */
export function missingQuotaLines(content: string, quotas: QuotaLineSpec[], date: string): string[] {
	const existing = new Set<string>();
	const lines = content.split("\n");
	let inCheck = false;
	for (const line of lines) {
		if (/^##\s/.test(line)) {
			inCheck = line.startsWith(CHECK_HEADING);
			continue;
		}
		if (!inCheck) continue;
		const m = TASK_LINE_RE.exec(line);
		if (m?.[3]) existing.add(m[3]);
	}
	const out: string[] = [];
	for (const q of quotas) {
		if (existing.has(q.plan)) continue;
		out.push(buildQuotaCheckLine({ label: q.label, plan: q.plan, quota: q.quota, unit: q.unit, date }));
	}
	return out;
}

/** ADR-0013 父行对账的按计划聚合事实（视图从任务池快照/目标窗口算好传入）。 */
export interface ParentRollupFact {
	/** 计划标签。 */
	plan: string;
	/** 今日在任一目标窗口内（纯打卡行/定额行无目标恒 false，窗口已过的计划也 false）。 */
	live: boolean;
	/** 任务池待办清空（pendingPoolChildren 为空）。 */
	pendingEmpty: boolean;
	/**
	 * ADR-0015 独立完成事实（如复盘 = 日记「# 当日复盘」小节非空）：为真时无视窗口与
	 * 待办直接勾父行——该计划的完成事实不由任务池/模式子行聚合，而由外部文件事实给定。
	 */
	factDone?: boolean;
}

/**
 * ADR-0013 刷新期父行对账：返回应被自动勾上的父行（行号 + 原文，供 toggleTaskLine 定位）。
 * 口径与渲染嵌套同一把尺（ADR-0006/0012）：同计划第一个非模式行 = 父行。
 * 勾选条件：父行未勾且无 ✋ 豁免，且以下二者取其一——
 *  - ADR-0013 聚合：计划今日在目标窗口内（fact.live），全部模式子行已勾（依内容事实判定，
 *    无模式行视为真），任务池待办清空；
 *  - ADR-0015 独立事实：fact.factDone 为真（如复盘 = 日记当日复盘小节非空），
 *    无视窗口与待办——该计划的完成事实由外部文件事实给定，不由任务池聚合。
 * 单向镜像：手动取消不落豁免，刷新即重勾（factDone 同样如此，✋ 是唯一长期豁免）。
 */
export function parentCheckTargets(
	content: string,
	facts: ParentRollupFact[],
	isModeLineText: (plan: string, text: string) => boolean
): { line: number; raw: string; plan: string }[] {
	const factByPlan = new Map(facts.map((f) => [f.plan, f]));
	const modesDone = new Map<string, boolean>();
	const parentAt = new Map<string, { line: number; raw: string; checked: boolean }>();
	const lines = content.split("\n");
	let inCheck = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) {
			inCheck = line.startsWith(CHECK_HEADING);
			continue;
		}
		if (!inCheck) continue;
		const m = TASK_LINE_RE.exec(line);
		if (!m || !m[3]) continue;
		const plan = m[3];
		const fact = factByPlan.get(plan);
		if (!fact || (!fact.live && !fact.factDone)) continue;
		const text = m[2].trim();
		if (isModeLineText(plan, text)) {
			const checked = m[1] === "x";
			modesDone.set(plan, (modesDone.get(plan) ?? true) && checked);
			continue;
		}
		if (!parentAt.has(plan)) parentAt.set(plan, { line: i, raw: line, checked: m[1] === "x" });
	}
	const out: { line: number; raw: string; plan: string }[] = [];
	for (const [plan, at] of parentAt) {
		const fact = factByPlan.get(plan)!;
		if (at.checked || at.raw.includes(MANUAL_MARK)) continue;
		if (fact.factDone) {
			out.push({ line: at.line, raw: at.raw, plan });
			continue;
		}
		if ((modesDone.get(plan) ?? true) && fact.pendingEmpty) out.push({ line: at.line, raw: at.raw, plan });
	}
	return out;
}

// ---------------------------------------------------------------------------
// 日常生活计划（ADR-0016 生活模式：固定日子式周期 + 事项级逾期策略）
// ---------------------------------------------------------------------------

/** 固定日子式周期单位：day=每天；week=每周指定星期几；month=每月指定几号；year=每年指定某月某日。 */
export type ChoreCycleUnit = "day" | "week" | "month" | "year";

/** 生活事项逾期策略：skip=放弃（缺省，不落盘）；postpone=往后延（挂账到补做）。 */
export type ChoreOverdue = "skip" | "postpone";

/** ADR-0016 固定日子式周期（生活事项）。 */
export interface GoalCycle {
	unit: ChoreCycleUnit;
	/**
	 * unit 语义下的「日子」集合：
	 * - day: 忽略（恒 []）
	 * - week: 星期几 0~6（0=周日，同 Date.getDay）
	 * - month: 几号 1~31（当月无此号落到当月最后一天）
	 * - year: 恰两个 [月(1~12), 日(1~31)]（当月无此日如 2/29 落到当月最后一天）
	 */
	days: number[];
}

const CHORE_UNIT_ALIASES: [RegExp, ChoreCycleUnit][] = [
	[/^(day|daily|每天|每日|天天)$/, "day"],
	[/^(week|weekly|每周|周)$/, "week"],
	[/^(month|monthly|每月|月)$/, "month"],
	[/^(year|yearly|annual|每年|年)$/, "year"],
];

/** 解析 frontmatter 的 cycle 值（容忍中文单位 / 字符串 days）；非法 → undefined。 */
export function parseChoreCycle(raw: unknown): GoalCycle | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const rec = raw as Record<string, unknown>;
	const unitRaw = typeof rec.unit === "string" ? rec.unit : typeof rec["单位"] === "string" ? String(rec["单位"]) : "";
	const v = unitRaw.trim().toLowerCase();
	if (!v) return undefined;
	const unit = CHORE_UNIT_ALIASES.find(([re]) => re.test(v))?.[1];
	if (!unit) return undefined;
	const daysRaw: unknown = rec.days ?? rec["日子"];
	const toInt = (x: unknown): number => (typeof x === "number" ? x : parseInt(String(x).trim(), 10));
	const list = (Array.isArray(daysRaw) ? daysRaw : String(daysRaw ?? "").replace(/[[\]]/g, "").split(/[,，\s]+/))
		.map(toInt)
		.filter((n) => Number.isFinite(n));
	if (unit === "day") return { unit, days: [] };
	if (unit === "week") {
		const days = [...new Set(list.filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b);
		return days.length > 0 ? { unit, days } : undefined;
	}
	if (unit === "month") {
		const days = [...new Set(list.filter((n) => n >= 1 && n <= 31))].sort((a, b) => a - b);
		return days.length > 0 ? { unit, days } : undefined;
	}
	// year: 恰两个 [月, 日]
	if (list.length !== 2) return undefined;
	const [mm, dd] = list;
	if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return undefined;
	return { unit, days: [mm, dd] };
}

/**
 * 解析逾期策略（中英文值）；仅 postpone 会落盘——skip / 放弃 / 未知值一律 undefined
 * （缺省 = 放弃，frontmatter 保持干净）。
 */
export function parseChoreOverdue(raw: unknown): "postpone" | undefined {
	const v = String(raw ?? "").trim().toLowerCase();
	return /^(postpone|defer|往后延|顺延|延后)$/.test(v) ? "postpone" : undefined;
}

/** 星期短名（0=周日，同 Date.getDay）——cycleLabel 与周期选择 UI 共用。 */
export const CHORE_WEEKDAY_SHORT = ["日", "一", "二", "三", "四", "五", "六"];

/** 周期的人类可读文案（徽标 / 管理列表共用）；postpone 追加「 · 漏了往后延」（CONTEXT.md 逾期策略措辞）。 */
export function choreCycleLabel(cycle: GoalCycle, overdue?: ChoreOverdue): string {
	let base: string;
	if (cycle.unit === "day") base = "每天";
	else if (cycle.unit === "week") {
		const ds = [...cycle.days].sort((a, b) => a - b);
		base = `每${ds.map((d) => `周${CHORE_WEEKDAY_SHORT[d] ?? "?"}`).join("、")}`;
	} else if (cycle.unit === "month") {
		const ds = [...cycle.days].sort((a, b) => a - b);
		base = `每月 ${ds.join("、")} 号`;
	} else {
		const [mm, dd] = cycle.days;
		base = `每年 ${mm} 月 ${dd} 日`;
	}
	return overdue === "postpone" ? `${base} · 漏了往后延` : base;
}

/**
 * 该做日判定：date 是否轮到该周期（month / year 含「无此号月份落到当月最后一天」回落）。
 */
export function isChoreDueOn(cycle: GoalCycle, date: string): boolean {
	const d = parseDateString(date);
	if (cycle.unit === "day") return true;
	if (cycle.unit === "week") return cycle.days.includes(d.getDay());
	const dim = daysInMonth(d.getFullYear(), d.getMonth() + 1);
	const dayOfMonth = d.getDate();
	if (cycle.unit === "month") {
		return cycle.days.some((x) => x === dayOfMonth || (x > dim && dayOfMonth === dim));
	}
	// year: days = [月, 日]
	const [mm, dd] = cycle.days;
	return d.getMonth() + 1 === mm && (dd === dayOfMonth || (dd > dim && dayOfMonth === dim));
}

/** 最近一个该做日（≤ date；日历连续，恒存在）。 */
export function prevChoreOccurrence(cycle: GoalCycle, date: string): string {
	if (cycle.unit === "day") return date;
	let cur = parseDateString(date);
	for (let i = 0; i < 400; i++) {
		const s = formatDate(cur);
		if (isChoreDueOn(cycle, s)) return s;
		cur = addDays(cur, -1);
	}
	return date; // 不可达（400 天内必有该做日）
}

/** 下一个该做日（严格晚于 date）。 */
export function nextChoreOccurrence(cycle: GoalCycle, date: string): string {
	let cur = addDays(parseDateString(date), 1);
	for (let i = 0; i < 400; i++) {
		const s = formatDate(cur);
		if (isChoreDueOn(cycle, s)) return s;
		cur = addDays(cur, 1);
	}
	return date; // 不可达
}

/** [start, end] 内的该做日升序枚举（cap 防失控，默认 400）。 */
export function choreOccurrences(cycle: GoalCycle, start: string, end: string, cap = 400): string[] {
	const out: string[] = [];
	if (start > end) return out;
	let cur = parseDateString(start);
	for (let i = 0; i < 800; i++) {
		const s = formatDate(cur);
		if (s > end) break;
		if (isChoreDueOn(cycle, s)) {
			out.push(s);
			if (out.length >= cap) break;
		}
		cur = addDays(cur, 1);
	}
	return out;
}

/** 生活事项行生成规格（structural，避免依赖 stats）。 */
export interface ChoreLineSpec {
	/** 计划标签（日常生活）。 */
	plan: string;
	/** 事项名（行文本剥 emoji 前缀后须恰为此名，精确匹配防近名顶替）。 */
	name: string;
}

/**
 * 今日缺失的生活事项行（ADR-0016 惰性生成，幂等）。
 * 识别既有行 = 同计划标签 + matchesModeLine 精确匹配（floor=0 口径：剥 emoji 后
 * 整行恰为事项名）——「洗碗机」不顶替「洗碗」，带后缀的历史行不算数。
 */
export function missingChoreLines(content: string, specs: ChoreLineSpec[], date: string): string[] {
	const existing = new Set<string>();
	const lines = content.split("\n");
	let inCheck = false;
	for (const line of lines) {
		if (/^##\s/.test(line)) {
			inCheck = line.startsWith(CHECK_HEADING);
			continue;
		}
		if (!inCheck) continue;
		const m = TASK_LINE_RE.exec(line);
		if (!m?.[3]) continue;
		existing.add(`${m[3]}|${m[2].trim()}`);
	}
	const out: string[] = [];
	for (const s of specs) {
		let found = false;
		for (const key of existing) {
			const [plan, text] = key.split("|");
			if (plan === s.plan && matchesModeLine(text, s.name, 0, "")) {
				found = true;
				break;
			}
		}
		if (!found) out.push(buildModeCheckLine({ plan: s.plan, name: s.name, label: "", floor: 0, unit: "" }, date));
	}
	return out;
}

/**
 * ADR-0016: [from, to]（含端点）逐日扫每日文件，找该事项的已勾行（精确匹配：
 * 同计划 + 剥 emoji 后整行恰为事项名）。文件事实为准，命中即停。
 * backward=true 从 to 端往回扫——挂账清账判定用：最近勾的先命中，常态只读最近几天。
 */
export async function scanChoreHit(
	app: App,
	prefix: string,
	plan: string,
	name: string,
	from: string,
	to: string,
	backward = false
): Promise<boolean> {
	const fmt = (d: Date): string => formatDate(d);
	let cur = backward ? parseDateString(to) : parseDateString(from);
	const stopAt = backward ? from : to;
	for (let i = 0; i < 800; i++) {
		const ds = fmt(cur);
		if (backward ? ds < stopAt : ds > stopAt) return false;
		const f = app.vault.getAbstractFileByPath(`${prefix}${ds}.md`);
		if (f instanceof TFile) {
			const content = await app.vault.cachedRead(f);
			let inCheck = false;
			for (const line of content.split("\n")) {
				if (/^##\s/.test(line)) {
					inCheck = line.startsWith(CHECK_HEADING);
					continue;
				}
				if (!inCheck) continue;
				const m = TASK_LINE_RE.exec(line);
				if (!m || m[3] !== plan || m[1] !== "x") continue;
				if (matchesModeLine(m[2].trim(), name, 0, "")) return true;
			}
		}
		cur = addDays(cur, backward ? -1 : 1);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Note templates
// ---------------------------------------------------------------------------

export interface BuildCheckLineParams {
	name: string;
	duration: string;
	plan: string;
	includeReview: boolean;
	date: string;
}

/** Build a task line, e.g. `- [ ] ✍️ 写作 1小时 #计划/写作 🛫 2026-08-11 📅 2026-08-11`. */
export function buildCheckLine({ name, duration, plan, includeReview, date }: BuildCheckLineParams): string {
	let content = name;
	if (duration && duration.trim()) content += " " + duration.trim();
	if (includeReview) content += ` → [[${date} 复盘]]`;
	return `- [ ] ${content} #计划/${plan} 🛫 ${date} 📅 ${date}`;
}

/** Template for a new daily note (PRD §2.2). */
export function buildDailyTemplate(date: string, templates: PlanTemplate[]): string {
	const tasks = templates.map((t) =>
		buildCheckLine({
			name: t.name,
			duration: t.duration,
			plan: t.plan,
			includeReview: t.includeReview,
			date,
		})
	);
	return [
		"---",
		`date: ${date}`,
		"type: daily",
		"---",
		`# 📅 ${date} ${weekdayName(date)}`,
		"",
		CHECK_HEADING,
		tasks.join("\n"),
		"",
		SUMMARY_HEADING,
		// v1.7.4: 删除默认总结 bullet（用户已删过这些文本，新建笔记不应再写入）
		"",
	].join("\n");
}

/**
 * Build a review note from the user-configured template.
 * `{date}` placeholders are replaced with the given date.
 * (v1.8: template moved to settings.reviewTemplate — was hard-coded A股复盘 before.)
 */
export function buildReviewTemplate(date: string, template: string): string {
	return template.replace(/\{date\}/g, date);
}

// ---------------------------------------------------------------------------
// Temp tasks from week/month frontmatter (PRD §2.3)
// ---------------------------------------------------------------------------

/**
 * Parse `temp-tasks` from a week/month note's frontmatter.
 * Supports the multiline block (`temp-tasks: |`) and array-of-strings forms;
 * array-of-objects ({name, start, end}) is surfaced as read-only info.
 */
export function parseTempTasksFromFrontmatter(
	content: string,
	file: TFile,
	source: "week" | "month"
): TempTask[] {
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fmMatch) return [];
	let data: Record<string, unknown> | null | undefined;
	try {
		const parsed: unknown = parseYaml(fmMatch[1]);
		data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return [];
	}
	const raw = data?.["temp-tasks"];
	if (raw === undefined || raw === null) return [];

	const tasks: TempTask[] = [];
	if (typeof raw === "string") {
		raw.split("\n").forEach((line, i) => {
			const t = parseTaskLine(line);
			if (!t) return;
			tasks.push({
				text: t.text,
				plan: t.plan,
				checked: t.checked,
				due: t.due,
				start: null,
				source,
				file,
				index: i,
				line: -1,
				raw: line.trim(),
				togglable: true,
			});
		});
	} else if (Array.isArray(raw)) {
		raw.forEach((el, i) => {
			if (typeof el === "string") {
				const t = parseTaskLine(el);
				if (!t) return;
				tasks.push({
					text: t.text,
					plan: t.plan,
					checked: t.checked,
					due: t.due,
					start: null,
					source,
					file,
					index: i,
					line: -1,
					raw: el.trim(),
					togglable: true,
				});
			} else if (el && typeof el === "object") {
				const obj = el as Record<string, unknown>;
				const start = typeof obj.start === "string" ? obj.start : null;
				const end = typeof obj.end === "string" ? obj.end : null;
				tasks.push({
					text: typeof obj.name === "string" ? obj.name : JSON.stringify(obj),
					plan: null,
					checked: false,
					due: end ?? start ?? null,
					start,
					source,
					file,
					index: i,
					line: -1,
					raw: "",
					togglable: false,
				});
			}
		});
	}
	return tasks;
}

/** Whether a temp task is due or active on the given date. */
export function isActiveToday(task: TempTask, today: string): boolean {
	if (task.due === today) return true;
	if (!task.due && task.start === today) return true;
	if (task.start && task.due && task.start <= today && today <= task.due) return true;
	return false;
}

/** Toggle a temp task in its source file. */
export async function toggleTempTask(app: App, task: TempTask, checked: boolean): Promise<string> {
	if (task.source === "daily") {
		return app.vault.process(task.file, (data) => toggleTaskLine(data, task.line, checked));
	}
	return app.vault.process(task.file, (data) =>
		setTempTaskCheckedInFrontmatter(data, task.index, checked)
	);
}

/**
 * Toggle the Nth task inside a week/month note's frontmatter `temp-tasks`.
 * Re-serializes the frontmatter with parseYaml/stringifyYaml (DEV.md #5) —
 * preserves all other keys and the note body.
 */
export function setTempTaskCheckedInFrontmatter(
	content: string,
	taskIndex: number,
	checked: boolean
): string {
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fmMatch) return content;
	let data: Record<string, unknown> | null | undefined;
	try {
		const parsed: unknown = parseYaml(fmMatch[1]);
		data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return content;
	}
	const tt = data?.["temp-tasks"];
	const marker = checked ? "- [x]" : "- [ ]";
	let changed = false;

	if (typeof tt === "string") {
		const lines = tt.split("\n");
		if (taskIndex >= 0 && taskIndex < lines.length && /^- \[[ x]\]/.test(lines[taskIndex])) {
			lines[taskIndex] = lines[taskIndex].replace(/^- \[[ x]\]/, marker);
			if (data) data["temp-tasks"] = lines.join("\n");
			changed = true;
		}
	} else if (Array.isArray(tt)) {
		const el: unknown = tt[taskIndex];
		if (typeof el === "string" && /^- \[[ x]\]/.test(el)) {
			tt[taskIndex] = el.replace(/^- \[[ x]\]/, marker);
			changed = true;
		}
	}

	if (!changed) return content;
	const newFm = stringifyYaml(data).trimEnd();
	return content.replace(fmMatch[0], `---\n${newFm}\n---`);
}
