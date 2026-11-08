import { App, TFile, parseYaml } from "obsidian";
import {
	CHECK_HEADING,
	MANUAL_MARK,
	countWorkdays,
	dayCount,
	daysInMonth,
	getISOWeek,
	parseDailyContent,
	parseQuotaActual,
	parseQuotaAmount,
	parseTempTasksFromFrontmatter,
	weekRange,
} from "./daily";
import type { GoalLevel, PoolTask } from "./tasks";
import { listTasks } from "./tasks";
import { bareYear, yearDirName } from "./paths";
import type { BzgSnapshot } from "./bzg";
import { diaryDayWritten, distinctReviewedInRange, readBzgDiaryText, reviewPoolSize, reviewedOn } from "./bzg";
import { TASK_LINE_RE } from "./daily";

/**
 * Statistics (PRD §2.4, 口径 must match the user's legacy system):
 * - 计划打卡率 = days the plan was checked in ÷ expected days in the period
 *   - 写作/健康/学习: expected = total days (week=7, month=month days, year=days since Jan 1)
 *   - 复盘: expected = workdays in the period (unless reviewWorkdays is off)
 * - 临时任务完成率 = completed ÷ total (filtered by period)
 * - 今日进度 = today's checked items ÷ today's total (computed in the view)
 * - M2: 周/月任务统计 = tasks in the period window (from the task pool) done ÷ total
 * - M2: 年度计划进度 = 数量型 uses completed tasks, 打卡型 uses check-in rate
 */

export type PeriodType = "week" | "month" | "year";

/**
 * 目标模式（ADR-0006）：量化目标的语义分类，决定创建流程与进度呈现语境，
 * 与计划量化类型（numeric/check/quota）正交。undefined = 通用模式（现状行为）。
 * - reading：阅读书籍（多级结构分解，同现有引擎）
 * - review：文献复习（纯每日下限，实际量来自 BZG 复习记录）
 * - diary：每日日记（打卡行，完成事实来自 BZG 日记日文件写作内容）
 * - exercise：运动（打卡 + 可选时长/次数）
 */
export type GoalMode = "reading" | "review" | "diary" | "exercise";

export interface PlanRate {
	plan: string;
	/** Days checked in during the period. */
	done: number;
	/** Expected days per PRD §2.4. */
	total: number;
	/** 0-100. */
	percent: number;
}

/** A quantified goal under a plan (v1.2: plans are categories, goals carry counts). */
export interface PlanGoal {
	/** Goal name shown on tasks: 「{name}（第 N {unit}）」. */
	name: string;
	/** Target quantity. */
	count: number;
	/** Counter noun (篇/本/条/个/…), defaults to 个. */
	unit: string;
	/** Optional custom window (defaults to the plan period). */
	start?: string;
	end?: string;
	/**
	 * ADR-0005 章节型（兼容）：逐章节数（下标 0 = 第 1 章，各章允许不同）。
	 * 非空时任务命名为「{name}（第 X 章第 Y 节）」，count = Σ chapters，unit = 节。
	 */
	chapters?: number[];
	/** ADR-0005 v2 多级结构：篇→章→节 等任意 1~3 级单位树（优先于 chapters）。 */
	structure?: GoalLevel[];
	/** 目标模式（ADR-0006）；undefined = 通用模式。模式目标不进任务池分解引擎。 */
	mode?: GoalMode;
	/**
	 * 每日量：review = 当日下限（每天至少 N{unit}，无总量无截止）；
	 * exercise = 可选每日目标量；diary 不用。
	 */
	floor?: number;
}

/** Quota definition under a quota-type plan (ADR-0001 日定额型). */
export interface PlanQuota {
	/** 总量. */
	total: number;
	/** 单位（字/页/章/分钟…），可为空. */
	unit: string;
	/** Start date (defaults to the annual plan period start). */
	start?: string;
	/** Deadline. */
	end: string;
}

/** A plan definition read from the annual note's frontmatter `plans` (read-only). */
export interface PlanDef {
	name: string;
	type: "numeric" | "check" | "quota";
	/** Target description text, e.g. "12 篇公众号文章". */
	target: string;
	/** Target count: Σ goals.count, or regex fallback from target for legacy data. */
	targetCount: number;
	/** Quantified goals under this plan (v1.2). Empty for pure check-in plans. */
	goals: PlanGoal[];
	/** Quota definition (quota type only, ADR-0001). */
	quota?: PlanQuota | null;
	/** Daily check-in action label, e.g. "1小时". */
	action: string;
	/** Icon prefix, e.g. "✍️". */
	label: string;
	/** Plan color (settings override), e.g. "#f59e0b". */
	color: string;
	/** Trading-day-only check-in (复盘). */
	tradingDay: boolean;
	/** Whether this plan appears in the daily check-in (default true; `daily: false` excludes it). */
	daily: boolean;
}

/** Progress of one goal under a plan. */
export interface PlanGoalProgress extends PlanGoal {
	/** Completed tasks whose name starts with `${goal.name}（`. */
	done: number;
	/** v1.0.4: 任务池中该目标的实际任务总数（单一数据源；count 仅为生成规格）。 */
	total: number;
	/** 0-100. */
	percent: number;
	/** ADR-0006: 模式目标的专属统计（review/diary/exercise；reading/通用无）。 */
	modeStats?: ModeGoalStats;
}

/**
 * ADR-0006: 模式目标的进度统计（文件事实 + BZG 只读快照）。
 * - review：达标天数/应达标天数 + 连续达标 + 覆盖率（年内复习过的不同文献 ÷ 文献池）
 * - diary：完成天数/应写天数 + 连续天数
 * - exercise：打卡天数 + 累计时长/次数
 */
export interface ModeGoalStats {
	mode: GoalMode;
	/** 应达标天数（窗口起点至今日，未过完的窗口不含未来）。 */
	dueDays: number;
	/** 达标/完成/打卡天数。 */
	hitDays: number;
	/** 连续达标天数（今天未达标则从昨天起算；窗口起点截断）。 */
	streak: number;
	/** 0-100 = hitDays ÷ dueDays。 */
	percent: number;
	/** review 专属：年内覆盖的不同文献数 / 文献池文档数。 */
	covered?: number;
	pool?: number;
	/** review 专属：今日 BZG 复习量（无联动为 null）。 */
	todayActual?: number | null;
	/** exercise 专属：累计实际量。 */
	totalAmount?: number;
}

/** Progress of one quota-type plan (ADR-0001). */
export interface QuotaProgress {
	plan: string;
	/** 单位（可为空字符串）. */
	unit: string;
	start: string;
	end: string;
	/** 总量. */
	total: number;
	/** 每日配额 = 总量 ÷ 计划天数（创建时口径，落后不追赶）. */
	dailyQuota: number;
	/** 累计实际完成量（勾选 = 记满当日配额；`（实 N）` = 按实际累计）. */
	actual: number;
	/** 截至今日应完成的量（落后判定基准，不预测未来）. */
	expected: number;
	/** 0-100，封顶 100. */
	percent: number;
	/** 进度落后（actual < expected）. */
	behind: boolean;
}

/** Daily quota = total ÷ planned days, 1-decimal precision. */
export function computeQuotaDaily(total: number, start: string, end: string): number {
	const days = dayCount(start, end);
	if (days <= 0) return total;
	return Math.round((total / days) * 10) / 10;
}

/** Expected cumulative amount by `today` (clamped to the plan window; never predicts the future). */
export function quotaExpected(dailyQuota: number, start: string, end: string, today: string): number {
	if (today < start) return 0;
	const until = today > end ? end : today;
	return Math.round(dailyQuota * dayCount(start, until) * 10) / 10;
}

/** Combined annual plan progress for a single plan (homepage goal card / year view). */
export interface PlanProgress {
	plan: string;
	target: string;
	/** true when quantity-type (progress advances by completed tasks). */
	isNumeric: boolean;
	/** true when quota-type (ADR-0001; progress advances by actual amounts). */
	isQuota: boolean;
	/** Quota progress (quota type only). */
	quota: QuotaProgress | null;
	/** Target count for numeric plans, 0 otherwise. */
	targetCount: number;
	/** Completed tasks under this plan (numeric progress). */
	doneCount: number;
	/** Check-in days for check-type plans. */
	checkDone: number;
	/** Expected check-in days for check-type plans. */
	checkTotal: number;
	/** Check-in rate percent for check-type plans. */
	checkPercent: number;
	/** Display percent (numeric → task progress; check → check-in rate). */
	percent: number;
	/** All pool tasks belonging to this plan. */
	tasks: PoolTask[];
	/** Per-goal progress (v1.2). Empty for pure check-in plans. */
	goals: PlanGoalProgress[];
	/** Daily check-in action label, e.g. "1小时". */
	action: string;
	/** Icon prefix, e.g. "✍️". */
	label: string;
	/** Plan color (settings override), e.g. "#f59e0b". */
	color: string;
	/** Trading-day-only check-in (复盘). */
	tradingDay: boolean;
}

export interface PeriodStats {
	type: PeriodType;
	/** e.g. "2026-W33" / "2026-08" / "2026". */
	label: string;
	/** e.g. "8/10 ~ 8/16". */
	rangeLabel: string;
	planRates: PlanRate[];
	tempTotal: number;
	tempDone: number;
	tempPercent: number;
	/** M2: tasks in the period window (from the task pool). */
	taskTotal: number;
	taskDone: number;
	taskPercent: number;
	tasks: PoolTask[];
	/** M2: annual plan progress (year only; empty for other periods). */
	planProgress: PlanProgress[];
	/** Quota plan progress (ADR-0001; one entry per quota plan definition). */
	quotaProgress: QuotaProgress[];
}

export interface PlanPeriod {
	start: string;
	end: string;
}

/**
 * Read the annual plan's period (start/end) from its frontmatter.
 * Prefers `{root}/{计划{year}}/年度计划.md`, falls back to `{root}/年度计划.md`.
 */
export async function readPlanPeriod(app: App, rootPath: string, year: string): Promise<PlanPeriod | null> {
	const root = rootPath.replace(/\/+$/, "");
	for (const path of [`${root}/${yearDirName(year)}/年度计划.md`, `${root}/年度计划.md`]) {
		const f = app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) continue;
		const fm = parseYaml((await app.vault.cachedRead(f)).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "") as {
			start?: string;
			end?: string;
		};
		if (typeof fm?.start === "string" && typeof fm?.end === "string") {
			return { start: fm.start, end: fm.end };
		}
		return null;
	}
	return null;
}

/** Read plan definitions from the annual note (year-level, root-level fallback). */
export async function readAnnualDefs(app: App, rootPath: string, year: string): Promise<PlanDef[]> {
	const root = rootPath.replace(/\/+$/, "");
	for (const path of [`${root}/${yearDirName(year)}/年度计划.md`, `${root}/年度计划.md`]) {
		const f = app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) {
			return parsePlansFromFrontmatter(await app.vault.cachedRead(f));
		}
	}
	return [];
}

export async function computePeriodStats(
	app: App,
	rootPath: string,
	today: string,
	type: PeriodType,
	reviewWorkdays: boolean,
	bzg?: BzgSnapshot | null
): Promise<PeriodStats> {
	const period = resolvePeriod(today, type);
	let { start, end, label, yearDir } = period;
	// yearDir 是带「计划」前缀的目录名（周/月/每日文件直接拼路径用）。传给
	// readPlanPeriod/readAnnualDefs/listTasks 这类内部会自己加前缀的函数时必须用裸年份，
	// 否则双重前缀（计划计划2026）读不到年度文件与任务池——年度视图进度全 0 的根因
	const year = bareYear(yearDir);

	// 年度窗口：优先用年度计划 frontmatter 定义的周期（如 8/10 ~ 12/31），而非自然年
	if (type === "year") {
		const planPeriod = await readPlanPeriod(app, rootPath, year);
		if (planPeriod) {
			start = planPeriod.start;
			end = planPeriod.end;
		}
	}

	// --- Plan definitions (needed for quota plans, ADR-0001) ------------------
	const defs = await readAnnualDefs(app, rootPath, year);
	const quotaDefs = defs.filter((d) => d.type === "quota" && d.quota);
	const quotaPlans = new Set(quotaDefs.map((d) => d.name));

	// --- Plan check-in rates -------------------------------------------------
	const prefix = `${rootPath}/${yearDir}/每日/`;
	const dailyFiles = app.vault
		.getFiles()
		.filter((f) => f.path.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name));

	const planDays = new Map<string, number>(); // checked days per plan
	const planSeen = new Set<string>();
	const quotaActual = new Map<string, number>(); // cumulative actual amount per quota plan

	for (const file of dailyFiles) {
		const date = file.basename;
		if (date < start || date > end) continue;
		const content = await app.vault.cachedRead(file);
		const data = parseDailyContent(file, content, date);
		const checkedPlans = new Set<string>();
		for (const item of data.checkItems) {
			if (!item.plan) continue;
			// ADR-0001: quota rows feed actual amounts, not check-in rates.
			if (quotaPlans.has(item.plan)) {
				if (item.checked) {
					const q = quotaDefs.find((d) => d.name === item.plan)?.quota;
					if (!q) continue;
					const qStart = q.start ?? start;
					const actual =
						parseQuotaActual(item.text) ??
						parseQuotaAmount(item.text) ??
						computeQuotaDaily(q.total, qStart, q.end);
					quotaActual.set(item.plan, (quotaActual.get(item.plan) ?? 0) + actual);
				}
				continue;
			}
			planSeen.add(item.plan);
			if (item.checked) checkedPlans.add(item.plan);
		}
		for (const plan of checkedPlans) planDays.set(plan, (planDays.get(plan) ?? 0) + 1);
	}

	// 周/月类型：打卡率用"至今"口径（未过的未来天不计入分母，周三看 2 天、月初看本月已过天数）
	let rateEnd = end;
	if ((type === "week" || type === "month") && today < end) rateEnd = today;
	const totalDays = dayCount(start, rateEnd);
	const workdays = countWorkdays(start, rateEnd);

	// 工作日口径计划集（ADR-0005 v3）：其他计划可显式 tradingDay: true 开启；「复盘」维持
	// 原行为——由「复盘按工作日统计」设置控制（flag 不参与，避免设置被写死的 flag 架空）
	const workdayPlans = new Set<string>();
	for (const d of defs) {
		if (d.name === "复盘") {
			if (reviewWorkdays) workdayPlans.add(d.name);
		} else if (d.tradingDay === true) {
			workdayPlans.add(d.name);
		}
	}

	const planRates: PlanRate[] = Array.from(planSeen)
		.sort()
		.map((plan) => {
			const total = workdayPlans.has(plan) ? workdays : totalDays;
			const done = planDays.get(plan) ?? 0;
			return { plan, done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
		});

	// --- Temp task completion ------------------------------------------------
	const tempFiles = collectTempTaskFiles(app, rootPath, yearDir, label, type);
	let tempTotal = 0;
	let tempDone = 0;
	for (const file of tempFiles) {
		const source: "week" | "month" = file.path.includes("/周/") ? "week" : "month";
		const tasks = parseTempTasksFromFrontmatter(await app.vault.cachedRead(file), file, source);
		for (const t of tasks) {
			if (!t.text) continue;
			tempTotal++;
			if (t.checked) tempDone++;
		}
	}

	// --- Quota progress (ADR-0001) -------------------------------------------
	const quotaProgress: QuotaProgress[] = quotaDefs.map((d) => {
		const q = d.quota!;
		const qStart = q.start ?? start;
		const dailyQuota = computeQuotaDaily(q.total, qStart, q.end);
		const actual = quotaActual.get(d.name) ?? 0;
		const expected = quotaExpected(dailyQuota, qStart, q.end, today);
		return {
			plan: d.name,
			unit: q.unit,
			start: qStart,
			end: q.end,
			total: q.total,
			dailyQuota,
			actual,
			expected,
			percent: Math.min(100, Math.round((actual / q.total) * 100)),
			behind: actual + 1e-9 < expected,
		};
	});

	// --- Task pool stats (M2) ------------------------------------------------
	const poolTasks = await listTasks(app, rootPath, year);
	const windowTasks = filterTasksInRange(poolTasks, start, end);
	const taskSummary = summarizeTasks(windowTasks);

	// --- Annual plan progress (year only) ------------------------------------
	let planProgress: PlanProgress[] = [];
	if (type === "year") {
		planProgress = await computeAnnualPlanProgress(app, rootPath, today, poolTasks, planRates, quotaProgress, bzg ?? null);
	}

	return {
		type,
		label,
		rangeLabel: `${start.slice(5)} ~ ${end.slice(5)}`,
		planRates,
		tempTotal,
		tempDone,
		tempPercent: tempTotal === 0 ? 0 : Math.round((tempDone / tempTotal) * 100),
		taskTotal: taskSummary.total,
		taskDone: taskSummary.done,
		taskPercent: taskSummary.percent,
		tasks: windowTasks,
		planProgress,
		quotaProgress,
	};
}

// ---------------------------------------------------------------------------
// M2: task pool helpers
// ---------------------------------------------------------------------------

/** Tasks whose window (🛫 ~ 📅) overlaps the [start, end] range (DEV.md M2). */
export function filterTasksInRange(tasks: PoolTask[], start: string, end: string): PoolTask[] {
	return tasks.filter((t) => {
		const s = t.start ?? t.due;
		const e = t.due ?? t.start;
		if (!s || !e) return false; // undated tasks have no window
		return s <= end && e >= start;
	});
}

export interface TaskSummary {
	total: number;
	done: number;
	percent: number;
}

export function summarizeTasks(tasks: PoolTask[]): TaskSummary {
	const total = tasks.length;
	const done = tasks.filter((t) => t.checked).length;
	return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

// ---------------------------------------------------------------------------
// M2: annual plan progress
// ---------------------------------------------------------------------------

/**
 * Parse the `plans` list from the annual note's frontmatter.
 * Tolerant to list-of-strings and map-of-objects layouts; `target` is read
 * from the description-like fields. DEV.md M2: structure is read-only.
 */
export function parsePlansFromFrontmatter(content: string): PlanDef[] {
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fmMatch) return [];
	let data: Record<string, unknown> | null | undefined;
	try {
		const parsed: unknown = parseYaml(fmMatch[1]);
		data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return [];
	}
	const raw = data?.plans;
	if (raw === undefined || raw === null) return [];

	const defs: PlanDef[] = [];
	const push = (name: string, obj: Record<string, unknown> | undefined): void => {
		const trimmed = name.trim();
		if (!trimmed) return;
	const target = readPlanTarget(obj);
	const goals = readPlanGoals(obj);
	const quota = readPlanQuota(obj);
	// ADR-0001: quota 类型要求 quota 定义完整（total>0 且有 end）——
	// 只有 type: quota 字样但定义残缺时回退到打卡/数量推断，避免出现算不出配额的死计划
	let type: PlanDef["type"] = "check";
	let targetCount = 0;
	if (quota) {
		type = "quota";
	} else if (goals.length > 0) {
		type = "numeric";
		targetCount = goals.reduce((acc, g) => acc + g.count, 0);
	} else {
		type = readPlanType(obj, target);
		const m =
			/(\d+)\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门|章|节)/.exec(target) ??
			/(?<![0-9/%])(\d+)(?![0-9/%])/.exec(target);
		targetCount = type === "numeric" && m ? parseInt(m[1], 10) : 0;
	}
	defs.push({
		name: trimmed,
		type,
		target,
		targetCount,
		goals,
		quota,
			action: readPlanString(obj, ["action", "动作", "时长", "duration"]),
			label: readPlanString(obj, ["label", "icon", "图标", "emoji"]),
			color: readPlanString(obj, ["color", "colour", "颜色"]),
			tradingDay: !!obj?.tradingDay || !!obj?.tradingday || !!obj?.["交易日"],
			// v2.7: 每日打卡计划标志（daily: false 显式排除；缺省视为每日打卡）
			daily: obj?.daily !== false,
		});
	};

	if (Array.isArray(raw)) {
		for (const el of raw) {
			if (typeof el === "string") {
				const s = el.trim();
				const idx = s.indexOf(":");
				if (idx !== -1) push(s.slice(0, idx), { target: s.slice(idx + 1).trim() });
				else {
					const m = /^(\S+)\s+(.+)$/.exec(s);
					if (m) push(m[1], { target: m[2] });
					else push(s, undefined);
				}
			} else if (el && typeof el === "object") {
				const obj = el as Record<string, unknown>;
				const name = obj.name ?? obj.plan ?? obj["名称"] ?? obj["计划"];
				if (typeof name === "string") {
					push(name, obj);
				} else {
					// Object with a single key: { 写作: { type, target } }
					const key = Object.keys(obj)[0];
					if (key) {
						const val = obj[key];
						push(
							key,
							val && typeof val === "object" ? (val as Record<string, unknown>) : { target: typeof val === "string" ? val : "" }
						);
					}
				}
			}
		}
	} else if (typeof raw === "object") {
		for (const key of Object.keys(raw)) {
			const val = (raw as Record<string, unknown>)[key];
			if (val && typeof val === "object") push(key, val as Record<string, unknown>);
			else if (typeof val === "string") push(key, { target: val });
			else push(key, undefined);
		}
	}
	return defs;
}

function readPlanTarget(obj?: Record<string, unknown>): string {
	if (!obj) return "";
	for (const k of ["target", "description", "desc", "目标", "描述", "goal", "值"]) {
		if (typeof obj[k] === "string") return obj[k];
	}
	return "";
}

function readPlanString(obj: Record<string, unknown> | undefined, keys: string[]): string {
	if (!obj) return "";
	for (const k of keys) {
		if (typeof obj[k] === "string") return obj[k];
	}
	return "";
}

/** Parse the `goals` array under a plan (v1.2). Tolerant of string/number/object entries. */
function readPlanGoals(obj?: Record<string, unknown>): PlanGoal[] {
	if (!obj || !Array.isArray(obj.goals)) return [];
	const out: PlanGoal[] = [];
	for (const g of obj.goals) {
		if (typeof g === "string") {
			// "阅读 10 本 2026-08-12~2026-12-31" or "阅读 10 本"
			const m = /^(.+?)\s+(\d+)\s*(篇|本|条|个|部|期|集|次|份|张|幅|门|天|章|节)?(?:\s+(\d{4}-\d{2}-\d{2})~\s*(\d{4}-\d{2}-\d{2}))?$/.exec(g.trim());
			if (m) {
				out.push({ name: m[1].trim(), count: parseInt(m[2], 10), unit: m[3] ?? "个", start: m[4], end: m[5] });
			}
			continue;
		}
		if (!g || typeof g !== "object") continue;
		const rec = g as Record<string, unknown>;
		const name = readPlanString(rec, ["name", "名称", "goal", "任务"]);
		if (!name) continue;
		// ADR-0006: 目标模式（阅读/复习/日记/运动；中英文键都认）。模式目标允许 count=0。
		const mode = parseGoalMode(readPlanString(rec, ["mode", "模式"]));
		const count =
			typeof rec.count === "number"
				? rec.count
				: typeof rec["数量"] === "number"
					? rec["数量"]
					: (() => {
							const cv: unknown = rec.count ?? rec["数量"];
							return parseInt(cv == null ? "0" : typeof cv === "string" || typeof cv === "number" ? String(cv) : "0", 10);
						})();
		if (!mode && (!count || Number.isNaN(count) || count <= 0)) continue;
		const unit = readPlanString(rec, ["unit", "单位", "量词"]) || (mode ? "" : "个");
		const start = readPlanString(rec, ["start", "开始", "起"]);
		const end = readPlanString(rec, ["end", "结束", "止"]);
		// ADR-0005 章节型：chapters 支持 flow 序列 [2, 3, 4]，也容忍手写标量 "2, 3, 4"；非法项丢弃
		const rawChapters: unknown = rec.chapters;
		const toInt = (v: unknown): number => (typeof v === "number" ? v : parseInt(String(v).trim(), 10));
		const validChapters = (arr: unknown[]): number[] =>
			arr.map(toInt).filter((c) => Number.isFinite(c) && c > 0);
		let chapters: number[] | undefined;
		if (Array.isArray(rawChapters)) {
			chapters = validChapters(rawChapters);
		} else if (typeof rawChapters === "string" && rawChapters.trim()) {
			chapters = validChapters(rawChapters.replace(/[[\]]/g, "").split(/[,，\s]+/));
		}
		const goal: PlanGoal = { name: name.trim(), count, unit, start: start || undefined, end: end || undefined };
		if (mode) {
			goal.mode = mode;
			// review 必有下限（缺省 1）；exercise 下限可选；diary 无量
			const rawFloor = rec.floor ?? rec["下限"] ?? rec["每日"];
			const floorVal = typeof rawFloor === "number" ? rawFloor : parseFloat(String(rawFloor ?? ""));
			if (Number.isFinite(floorVal) && floorVal > 0) goal.floor = floorVal;
			else if (mode === "review") goal.floor = 1;
		}
		if (chapters && chapters.length > 0) goal.chapters = chapters;
		// ADR-0005 v2 多级结构：structure: [{unit, counts}, …]（1~8 级；引擎优先于 chapters）
		// counts 容忍 flow 序列 / 字符串 "[2, 2, 3]"（手写 frontmatter / 简版解析器）
		const rawStructure: unknown = rec.structure;
		if (Array.isArray(rawStructure)) {
			const levels: GoalLevel[] = [];
			for (const lv of rawStructure.slice(0, 8)) {
				if (!lv || typeof lv !== "object") continue;
				const obj = lv as Record<string, unknown>;
				const unit2 = readPlanString(obj, ["unit", "单位"]);
				const rawCounts: unknown = obj.counts ?? obj["数目"];
				if (!unit2 || (rawCounts === undefined || rawCounts === null)) continue;
				const list = (Array.isArray(rawCounts) ? rawCounts : String(rawCounts).replace(/[[\]]/g, "").split(/[,，\s]+/))
					.filter((c) => String(c).trim() !== "")
					.map(toInt)
					.filter((c) => Number.isFinite(c) && c > 0);
				if (list.length > 0) levels.push({ unit: unit2, counts: list });
			}
			if (levels.length > 0) goal.structure = levels;
		}
		out.push(goal);
	}
	return out;
}

/** Parse the `quota` object under a plan (ADR-0001). Tolerant of string/number forms. */
function readPlanQuota(obj?: Record<string, unknown>): PlanQuota | null {
	if (!obj) return null;
	const raw = obj.quota ?? obj["定额"] ?? obj["日定额"];
	let rec: Record<string, unknown> | null = null;
	if (raw && typeof raw === "object") {
		rec = raw as Record<string, unknown>;
	} else if (typeof raw === "string") {
		// "100000字 2026-09-01~2026-12-31" string form
		const m = /^([\d.]+)\s*([^0-9~]*)(?:\s+(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2}))?$/.exec(raw.trim());
		if (m) {
			rec = { total: parseFloat(m[1]), unit: m[2].trim(), start: m[3], end: m[4] };
		}
	}
	if (!rec) return null;
	const totalRaw = rec.total ?? rec["总量"] ?? rec["数量"];
	const total = typeof totalRaw === "number" ? totalRaw : parseFloat(String(totalRaw ?? ""));
	if (!Number.isFinite(total) || total <= 0) return null;
	const unitRaw = rec.unit ?? rec["单位"];
	const unit = typeof unitRaw === "string" ? unitRaw.trim() : "";
	const start = [rec.start, rec["开始"], rec["起"]].find((v): v is string => typeof v === "string" && !!v.trim());
	const end = [rec.end, rec["结束"], rec["止"], rec["截止"]].find((v): v is string => typeof v === "string" && !!v.trim());
	if (!end) return null;
	return { total, unit, start: start?.trim() || undefined, end: end.trim() };
}

/** ADR-0006: 目标模式解析（中英文键；未知值 → undefined = 通用）。 */
function parseGoalMode(raw: string): GoalMode | undefined {
	const v = raw.trim().toLowerCase();
	if (!v) return undefined;
	if (/^(reading|阅读(书籍)?|book)$/.test(v)) return "reading";
	if (/^(review|复习)$/.test(v)) return "review";
	if (/^(diary|日记)$/.test(v)) return "diary";
	if (/^(exercise|运动|锻炼)$/.test(v)) return "exercise";
	return undefined;
}

/**
 * ADR-0006: 模式目标进度统计（review/diary/exercise）。
 * 数据源 = 文件事实（每日笔记打卡行）+ BZG 只读快照（review.json / 日记日文件）。
 * 统计窗口 = 目标显式窗口 → 年度计划周期 → 自然年；应达标天数只算已过部分。
 */
export async function computeModeGoalStats(
	app: App,
	rootPath: string,
	year: string,
	planName: string,
	goal: PlanGoal,
	today: string,
	bzg: BzgSnapshot | null
): Promise<ModeGoalStats> {
	const mode = goal.mode!;
	const period = (await readPlanPeriod(app, rootPath, year)) ?? { start: `${year}-01-01`, end: `${year}-12-31` };
	const start = goal.start || period.start;
	const end = goal.end || period.end;
	const floor = goal.floor ?? 0;
	const dueEnd = today < end ? today : end;
	const dueDays = today < start ? 0 : Math.max(0, dayCount(start, dueEnd));

	const prefix = `${rootPath.replace(/\/+$/, "")}/${yearDirName(year)}/每日/`;
	interface DayLine {
		checked: boolean;
		actual: number | null;
		manual: boolean;
	}
	const lineOfDay = new Map<string, DayLine>();
	const NONE: DayLine = { checked: false, actual: null, manual: false };
	const readDayLine = async (date: string): Promise<DayLine> => {
		const cached = lineOfDay.get(date);
		if (cached) return cached;
		const f = app.vault.getAbstractFileByPath(`${prefix}${date}.md`);
		if (!(f instanceof TFile)) {
			lineOfDay.set(date, NONE);
			return NONE;
		}
		const content = await app.vault.cachedRead(f);
		let found: DayLine | null = null;
		let inCheck = false;
		for (const line of content.split("\n")) {
			if (/^##\s/.test(line)) {
				// 只认「## ✅ 今日打卡」小节内的行（与 parseDailyContent 同口径）
				inCheck = line.startsWith(CHECK_HEADING);
				continue;
			}
			if (!inCheck) continue;
			const m = TASK_LINE_RE.exec(line);
			if (!m || m[3] !== planName) continue;
			const text = m[2].trim();
			if (!text.includes(goal.name)) continue;
			found = {
				checked: m[1] === "x",
				actual: parseQuotaActual(text),
				manual: line.includes(MANUAL_MARK),
			};
			break;
		}
		const result = found ?? NONE;
		lineOfDay.set(date, result);
		return result;
	};

	let hitDays = 0;
	let totalAmount = 0;
	const days: boolean[] = []; // 窗口内逐日是否达标（streak 用，下标 0 = 窗口第一天）
	for (let d = start; d <= dueEnd; ) {
		const line = await readDayLine(d);
		const bzgCount = bzg ? reviewedOn(bzg, d) : null;
		let hit = false;
		if (mode === "review") {
			const actual = line.manual && line.actual != null ? line.actual : Math.max(line.actual ?? 0, bzgCount ?? 0);
			hit = line.checked || actual >= floor;
		} else if (mode === "diary") {
			hit = line.checked;
			if (!hit && bzg) {
				const diary = await readBzgDiaryText(app, bzg, d);
				hit = diaryDayWritten(diary);
			}
		} else {
			// exercise：打卡即达标；累计量 = 手动/行内实际量，勾选无量按下限记
			hit = line.checked;
			const amount = line.actual ?? (line.checked ? floor || 0 : 0);
			totalAmount += amount;
		}
		if (hit) hitDays++;
		days.push(hit);
		// 日期推进（ISO 字符串逐日）
		const [yy, mm, dd] = d.split("-").map(Number);
		const next = new Date(yy, mm - 1, dd + 1);
		d = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
	}

	// 连续达标：今天达标从今天起算，否则从昨天起算；窗口起点截断
	let streak = 0;
	{
		let i = days.length - 1;
		if (i >= 0 && !days[i]) i--;
		while (i >= 0 && days[i]) {
			streak++;
			i--;
		}
	}

	const stats: ModeGoalStats = {
		mode,
		dueDays,
		hitDays,
		streak,
		percent: dueDays > 0 ? Math.min(100, Math.round((hitDays / dueDays) * 100)) : 0,
	};
	if (mode === "review" && bzg) {
		stats.covered = distinctReviewedInRange(bzg, start, dueEnd);
		stats.pool = reviewPoolSize(app, bzg);
		stats.todayActual = reviewedOn(bzg, today);
	}
	if (mode === "exercise") stats.totalAmount = totalAmount;
	return stats;
}

function readPlanType(obj: Record<string, unknown> | undefined, target: string): PlanDef["type"] {
	let t = "";
	if (obj) {
		for (const k of ["type", "kind", "类型", "模式"]) {
			if (typeof obj[k] === "string") {
				t = obj[k];
				break;
			}
		}
	}
	if (t) {
		if (/数量|量化|count|numeric|project|任务|篇|个|次/.test(t)) return "numeric";
		if (/打卡|习惯|habit|check|daily|复盘/.test(t)) return "check";
	}
	// 无 type 字段：target 含"数量词+单位"（12 篇 / 1 条 / 3 个）→ 数量型；否则打卡型
	if (/\d+\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门)/.test(target)) return "numeric";
	return "check";
}

/**
 * Build annual plan progress for every plan defined in `年度计划.md`.
 * - numeric: doneCount = completed pool tasks under the plan
 * - check:   progress = the plan's annual check-in rate (from planRates)
 * - quota:   progress = cumulative actual amount ÷ total (from quotaProgress, ADR-0001)
 * - numeric 且只有模式目标（ADR-0006）：无任务池事实 → 进度 = 各模式目标达标率的均值
 */
export async function computeAnnualPlanProgress(
	app: App,
	rootPath: string,
	today: string,
	tasks: PoolTask[],
	planRates: PlanRate[],
	quotaProgress: QuotaProgress[] = [],
	bzg: BzgSnapshot | null = null
): Promise<PlanProgress[]> {
	const root = rootPath.replace(/\/+$/, "");
	const year = today.slice(0, 4);
	const f = app.vault.getAbstractFileByPath(`${root}/${yearDirName(year)}/年度计划.md`);
	if (!(f instanceof TFile)) return [];
	const content = await app.vault.cachedRead(f);
	const defs = parsePlansFromFrontmatter(content);
	const rateByName = new Map(planRates.map((r) => [r.plan, r]));
	const quotaByName = new Map(quotaProgress.map((r) => [r.plan, r]));

	return Promise.all(
		defs.map(async (def) => {
			const planTasks = tasks.filter((t) => t.plan === def.name);
			const rate = rateByName.get(def.name);
			// v1.2: per-goal progress = completed tasks whose name starts with 「{goal.name}（」
			// v1.0.4: 分母改为任务池实际任务数（单一数据源），g.count 仅是生成规格
			// ADR-0006: 模式目标（review/diary/exercise）不走任务池，走专属统计
			const goalProgress: PlanGoalProgress[] = await Promise.all(
				def.goals.map(async (g) => {
					if (g.mode && g.mode !== "reading") {
						const stats = await computeModeGoalStats(app, rootPath, year, def.name, g, today, bzg);
						return { ...g, done: stats.hitDays, total: stats.dueDays, percent: stats.percent, modeStats: stats };
					}
					const prefix = `${g.name}（`;
					const goalTasks = planTasks.filter((t) => t.text.trim().startsWith(prefix));
					const done = goalTasks.filter((t) => t.checked).length;
					const percent = goalTasks.length > 0 ? Math.round((done / goalTasks.length) * 100) : 0;
					return { ...g, done, total: goalTasks.length, percent };
				})
			);
			const base = {
				plan: def.name,
				target: def.target,
				action: def.action,
				label: def.label,
				color: def.color,
				tradingDay: def.tradingDay,
				goals: goalProgress,
				tasks: planTasks,
			};
			if (def.type === "quota") {
				const qp = quotaByName.get(def.name) ?? null;
				return {
					...base,
					isNumeric: false,
					isQuota: true,
					quota: qp,
					targetCount: 0,
					doneCount: 0,
					checkDone: 0,
					checkTotal: 0,
					checkPercent: 0,
					percent: qp?.percent ?? 0,
				};
			}
			if (def.type === "numeric") {
				const doneCount = planTasks.filter((t) => t.checked).length;
				// v1.0.4: 进度分母 = 任务池中该计划的实际任务总数——单一数据源（任务池），
				// 不再使用 frontmatter target 文本/goals 推导的数字，避免"定义已删、进度仍按旧数显示"
				const totalCount = planTasks.length;
				let percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
				// ADR-0006: 无任务池事实但有模式目标 → 进度 = 模式目标达标率均值
				const modePercents = goalProgress.filter((g) => g.modeStats).map((g) => g.percent);
				if (totalCount === 0 && modePercents.length > 0) {
					percent = Math.round(modePercents.reduce((a, b) => a + b, 0) / modePercents.length);
				}
				return {
					...base,
					isNumeric: true,
					isQuota: false,
					quota: null,
					targetCount: totalCount,
					doneCount,
					checkDone: 0,
					checkTotal: 0,
					checkPercent: 0,
					percent,
				};
			}
			return {
				...base,
				isNumeric: false,
				isQuota: false,
				quota: null,
				targetCount: 0,
				doneCount: 0,
				checkDone: rate?.done ?? 0,
				checkTotal: rate?.total ?? 0,
				checkPercent: rate?.percent ?? 0,
				percent: rate?.percent ?? 0,
			};
		})
	);
}

interface PeriodBounds {
	start: string;
	end: string;
	label: string;
	yearDir: string;
}

function resolvePeriod(today: string, type: PeriodType): PeriodBounds {
	if (type === "week") {
		const { year, week } = getISOWeek(today);
		const { start, end } = weekRange(today);
		return {
			start,
			end,
			label: `${year}-W${String(week).padStart(2, "0")}`,
			yearDir: yearDirName(String(year)),
		};
	}
	if (type === "month") {
		const [y, m] = today.split("-").map(Number);
		const mm = String(m).padStart(2, "0");
		const dd = String(daysInMonth(y, m)).padStart(2, "0");
		return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${dd}`, label: `${y}-${mm}`, yearDir: yearDirName(String(y)) };
	}
	const [y] = today.split("-").map(Number);
	return { start: `${y}-01-01`, end: today, label: String(y), yearDir: yearDirName(String(y)) };
}

function collectTempTaskFiles(
	app: App,
	rootPath: string,
	yearDir: string,
	label: string,
	type: PeriodType
): TFile[] {
	if (type === "week") {
		const f = app.vault.getAbstractFileByPath(`${rootPath}/${yearDir}/周/${label}.md`);
		return f instanceof TFile ? [f] : [];
	}
	if (type === "month") {
		const f = app.vault.getAbstractFileByPath(`${rootPath}/${yearDir}/月/${label}.md`);
		return f instanceof TFile ? [f] : [];
	}
	// Year: all week + month notes of the year.
	return app.vault
		.getFiles()
		.filter(
			(f) =>
				f.name.endsWith(".md") &&
				(f.path.startsWith(`${rootPath}/${yearDir}/周/`) || f.path.startsWith(`${rootPath}/${yearDir}/月/`))
		);
}
