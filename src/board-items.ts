import type { App } from "obsidian";
import type { BzgSnapshot } from "./bzg";
import {
	addDays,
	choreOccurrences,
	countWorkdays,
	dayCount,
	formatDate,
	nextChoreOccurrence,
	parseDateString,
	type GoalCycle,
} from "./daily";
import {
	computePeriodStats,
	readAnnualDefs,
	readPlanPeriod,
	type GoalMode,
	type PlanGoalProgress,
} from "./stats";

/**
 * 完成情况看板（v1.8）：把「计划 → 打卡子项」在计划期间内的事实摊开。
 *
 * 口径全部复用统计层，不在这里重新定义：
 * - 打卡型计划：计划行逐日已勾 = 当日完成（与 computePeriodStats 的 planCheckDates 同源）；
 * - 生活事项：周期窗口命中（ADR-0016），分次事项认次行全勾（ADR-0019）；
 * - 模式子行（复习/日记/运动）：modeStats 逐日事实；
 * - 量化目标（阅读/写作按章节/数量）：只有任务池进度，任务池不存完成日期，
 *   因此不产出日格带（q6-A 的明确取舍，不伪造天数）。
 */

export type BoardItemKind = "plan" | "chore" | "mode" | "goal" | "quota";
export type DayMark = "hit" | "miss" | "off";

export interface DayState {
	date: string;
	state: DayMark;
}

export interface BoardItem {
	/** `${plan}|${name}`，视图 key 用。 */
	key: string;
	name: string;
	kind: BoardItemKind;
	mode?: GoalMode;
	/** 完成量（天/次/节/字，随 unit）。 */
	done: number;
	/** 应做量（仅统计到今天，不含未来）。 */
	total: number;
	/** 0-100。 */
	percent: number;
	/** 完成量量词：天 / 次 / 节 / 字… */
	unit: string;
	/** 日格带；量化目标为 undefined（无完成日期事实）。 */
	days?: DayState[];
	streak?: number;
}

export interface BoardSection {
	plan: string;
	label?: string;
	/** 计划区聚合率（口径见 computeBoardSections 注释）。 */
	percent: number;
	items: BoardItem[];
}

export interface BoardData {
	start: string;
	end: string;
	/** 统计截止日（今天与计划期末取小）。 */
	scanEnd: string;
	sections: BoardSection[];
}

function roundPercent(done: number, total: number): number {
	return total === 0 ? 0 : Math.round((done / total) * 100);
}

function isWeekend(date: string): boolean {
	const day = parseDateString(date).getDay();
	return day === 0 || day === 6;
}

function eachDay(from: string, to: string, fn: (date: string) => void): void {
	if (from > to) return;
	let cur = parseDateString(from);
	const end = parseDateString(to);
	while (cur <= end) {
		fn(formatDate(cur));
		cur = addDays(cur, 1);
	}
}

/**
 * 生活事项日格带：一格 = 一次「该做」（不是一天）。
 * 每日事项两者重合；周/月事项只在做日著色，窗口内补做也算该次命中，
 * 因此格子数与「命中 X / 该做 Y 次」严格一致。
 */
function choreDays(
	cycle: GoalCycle,
	plan: string,
	item: string,
	gStart: string,
	scanEnd: string,
	hitDates: Set<string>
): DayState[] {
	const dues = choreOccurrences(cycle, gStart, scanEnd, 4000);
	const dueHit = new Map<string, boolean>();
	for (let i = 0; i < dues.length; i++) {
		const due = dues[i];
		const next = i + 1 < dues.length ? dues[i + 1] : nextChoreOccurrence(cycle, due);
		const winTo = formatDate(addDays(parseDateString(next), -1));
		const scanTo = winTo < scanEnd ? winTo : scanEnd;
		let hit = false;
		for (let d = due; d <= scanTo; ) {
			if (hitDates.has(`${plan}|${d}|${item}`)) {
				hit = true;
				break;
			}
			d = formatDate(addDays(parseDateString(d), 1));
		}
		dueHit.set(due, hit);
	}
	const states: DayState[] = [];
	eachDay(gStart, scanEnd, (d) => {
		const h = dueHit.get(d);
		states.push({ date: d, state: h === undefined ? "off" : h ? "hit" : "miss" });
	});
	return states;
}

/**
 * 计算看板的全部计划区。数字一律来自 computePeriodStats / planProgress，
 * 因此与年度视图的「打卡统计」「计划卡」呈现同一口径（唯一差异：看板分母只算到今天）。
 */
export async function computeBoardSections(
	app: App,
	rootPath: string,
	today: string,
	reviewWorkdays: boolean,
	bzg: BzgSnapshot | null = null
): Promise<BoardData> {
	const root = rootPath.replace(/\/+$/, "");
	const year = today.slice(0, 4);
	const defs = await readAnnualDefs(app, root, year);
	const period = (await readPlanPeriod(app, root, year)) ?? {
		start: `${year}-01-01`,
		end: `${year}-12-31`,
	};
	const { start, end } = period;
	const scanEnd = today < start ? start : today > end ? end : today;

	// 空窗口（计划还没开始）：没有可展示事实，但仍回传区间给视图画空态
	if (today < start) return { start, end, scanEnd, sections: [] };

	const stats = await computePeriodStats(app, root, today, "year", reviewWorkdays, bzg);
	const progByName = new Map(stats.planProgress.map((p) => [p.plan, p]));
	const quotaByName = new Map(stats.quotaProgress.map((q) => [q.plan, q]));
	const rateByName = new Map(stats.planRates.map((r) => [r.plan, r]));

	const sections: BoardSection[] = [];

	for (const def of defs) {
		const items: BoardItem[] = [];
		const prog = progByName.get(def.name);
		const goals = prog?.goals ?? [];
		// ADR-0016: 生活计划（type 仍是 check）没有计划级打卡事实——大项行不进 planCheckDates，
		// 聚合率必须按事项应做量加权，否则会恒显示 0%。
		const hasChore = goals.some((g) => g.mode === "chore");
		// 打卡型计划「计到今天」的应做天数（年度 rate 分母含未来，看板不用它当分母）
		const workdayOnly = def.tradingDay === true || (def.name === "复盘" && reviewWorkdays);
		const planTotalDays = workdayOnly ? countWorkdays(start, scanEnd) : dayCount(start, scanEnd);
		let planCheckDone = 0;
		eachDay(start, scanEnd, (d) => {
			if (stats.planCheckDates.has(`${def.name}|${d}`)) planCheckDone++;
		});

		// --- 日定额计划：一行总量进度（无日格带，量纲是字/页而非天） ---
		if (def.type === "quota") {
			const q = quotaByName.get(def.name);
			if (q) {
				items.push({
					key: `${def.name}|quota`,
					name: "总量进度",
					kind: "quota",
					done: q.actual,
					total: q.total,
					percent: q.percent,
					unit: q.unit || "量",
				});
			}
		} else {
			// --- 打卡型计划：有子项时区头用计划自身打卡率，无子项时计划自身成一行 ---
			if (def.type === "check") {
				if (goals.length === 0) {
					// workday 计划：周末置 off（不计 miss，也不进分母）
					const days: DayState[] = [];
					eachDay(start, scanEnd, (d) => {
						const hit = stats.planCheckDates.has(`${def.name}|${d}`);
						days.push({ date: d, state: hit ? "hit" : workdayOnly && isWeekend(d) ? "off" : "miss" });
					});
					const total = workdayOnly ? countWorkdays(start, scanEnd) : dayCount(start, scanEnd);
					items.push({
						key: `${def.name}|check`,
						name: "每日打卡",
						kind: "plan",
						done: planCheckDone,
						total,
						percent: roundPercent(planCheckDone, total),
						unit: "天",
						days,
					});
				} else {
					appendGoalItems(items, def.name, goals, stats.choreHitDates, start, scanEnd);
				}
			} else if (def.type === "numeric") {
				appendGoalItems(items, def.name, goals, stats.choreHitDates, start, scanEnd);
				// 无量化子目标的纯任务计划：给一行任务完成进度（无日格带）
				if (goals.length === 0 && prog && prog.targetCount > 0) {
					items.push({
						key: `${def.name}|task`,
						name: "任务完成",
						kind: "goal",
						done: prog.doneCount,
						total: prog.targetCount,
						percent: prog.percent,
						unit: "项",
					});
				}
			}

			// 兜底：未知类型但有子目标时也要能看到
			if (items.length === 0 && goals.length > 0) {
				appendGoalItems(items, def.name, goals, stats.choreHitDates, start, scanEnd);
			}
		}

		if (items.length === 0) continue;

		// 计划区聚合率：
		// - 日定额：总量百分比
		// - 打卡型（非生活计划）：计划自身打卡率（计到今天）
		// - 生活计划 / 其余：全部子项都按天/次判定时按应做量加权，否则沿用年度计划进度（任务完成率）
		let percent: number;
		if (def.type === "quota") {
			percent = quotaByName.get(def.name)?.percent ?? 0;
		} else if (def.type === "check" && !hasChore) {
			percent = roundPercent(planCheckDone, planTotalDays);
		} else if (items.every((i) => i.days)) {
			const done = items.reduce((a, i) => a + i.done, 0);
			const total = items.reduce((a, i) => a + i.total, 0);
			percent = roundPercent(done, total);
		} else {
			percent = prog?.percent ?? rateByName.get(def.name)?.percent ?? 0;
		}

		sections.push({
			plan: def.name,
			label: def.label,
			percent,
			items,
		});
	}

	return { start, end, scanEnd, sections };
}

/** 把一个计划的量化目标逐个转成看板行（生活事项 / 模式子行 / 量化目标）。 */
function appendGoalItems(
	items: BoardItem[],
	plan: string,
	goals: PlanGoalProgress[],
	choreHitDates: Set<string>,
	start: string,
	scanEnd: string
): void {
	for (const g of goals) {
		if (g.mode === "chore") {
			const cycle: GoalCycle = g.cycle ?? { unit: "day", days: [] };
			const gStart = g.start || start;
			const gScanEnd = g.end && g.end < scanEnd ? g.end : scanEnd;
			const days = choreDays(cycle, plan, g.name, gStart, gScanEnd, choreHitDates);
			const ms = g.modeStats;
			items.push({
				key: `${plan}|${g.name}`,
				name: g.name,
				kind: "chore",
				done: ms?.hitDays ?? g.done,
				total: ms?.dueDays ?? g.total,
				percent: g.percent,
				unit: cycle.unit === "day" ? "天" : "次",
				days,
				streak: ms?.streak,
			});
			continue;
		}

		if (g.mode === "writing" && g.writingQuota) {
			const ms = g.modeStats;
			items.push({
				key: `${plan}|${g.name}`,
				name: g.name,
				kind: "mode",
				mode: "writing",
				done: ms?.totalAmount ?? 0,
				total: ms?.quotaTotal ?? g.writingQuota.total,
				percent: g.percent,
				unit: ms?.quotaUnit ?? "字",
				days: ms?.dayStates?.map((s): DayState => ({ date: s.date, state: s.hit ? "hit" : "miss" })),
				streak: ms?.streak,
			});
			continue;
		}

		// 复习 / 日记 / 运动：模式子行，逐日达标（写作按章节走任务池，不在此列）
		if (g.mode === "review" || g.mode === "diary" || g.mode === "exercise") {
			const ms = g.modeStats;
			items.push({
				key: `${plan}|${g.name}`,
				name: g.name,
				kind: "mode",
				mode: g.mode,
				done: ms?.hitDays ?? g.done,
				total: ms?.dueDays ?? g.total,
				percent: g.percent,
				unit: "天",
				days: ms?.dayStates?.map((s): DayState => ({ date: s.date, state: s.hit ? "hit" : "miss" })),
				streak: ms?.streak,
			});
			continue;
		}

		// 阅读书籍 / 写作按章节 / 通用数量目标：任务池进度，无完成日期事实
		const unit = g.unit || (g.mode === "writing" ? "章" : "节");
		items.push({
			key: `${plan}|${g.name}`,
			name: g.name,
			kind: "goal",
			mode: g.mode,
			done: g.done,
			total: g.total,
			percent: g.percent,
			unit,
		});
	}
}
