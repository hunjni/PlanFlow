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
 * `manual = true` 时追加 `✋` 手动标记（ADR-0007：标记后自动逻辑不再碰该行）。
 */
export function setQuotaActual(
	content: string,
	lineIndex: number,
	actual: number,
	unit: string,
	checked: boolean,
	expectedRaw?: string,
	manual = false
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
	let rebuilt = `- [${checked ? "x" : " "}] ${text}${actualPart}${manual ? MANUAL_MARK : ""}`;
	if (m[3]) rebuilt += ` #计划/${m[3]}`;
	if (m[4]) rebuilt += ` 🛫 ${m[4]}`;
	if (m[5]) rebuilt += ` 📅 ${m[5]}`;
	lines[idx] = rebuilt;
	return lines.join("\n");
}

/**
 * 给任务行打 `✋` 手动标记（ADR-0007）。已有标记则原样返回（幂等）。
 * 用户在 UI 里手动勾/退勾的模式行会调用——之后自动逻辑不再碰该行。
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
