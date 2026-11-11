import { App, ButtonComponent, ItemView, MarkdownView, Menu, Modal, Notice, Setting, TAbstractFile, TFile, TFolder, WorkspaceLeaf, parseYaml } from "obsidian";
import type PlanBoardPlugin from "../main";
import type { CheckItem, ChoreOverdue, ChoreLineSpec, DailyData, GoalCycle, ModeLineSpec, ParentRollupFact } from "./daily";
import {
	MANUAL_MARK,
	appendCheckItem,
	buildCheckLine,
	clearManualMark,
	CHECK_HEADING,
	buildDailyTemplate,
	buildQuotaCheckLine,
	buildReviewTemplate,
	choreCycleLabel,
	choreOccurrences,
	dayCount,
	addDays,
	formatDate,
	formatQuotaAmount,
	isChoreDueOn,
	missingChoreLines,
	CHORE_WEEKDAY_SHORT,
	missingModeLines,
	missingQuotaLines,
	markTaskLineManual,
	matchesModeLine,
	moveTaskLine,
	parentCheckTargets,
	parseDailyContent,
	parseDateString,
	parseQuotaActual,
	prevChoreOccurrence,
	removeLine,
	replaceSummary,
	scanChoreHit,
	setQuotaActual,
	topLevelCheckRows,
	TASK_LINE_RE,
	todayStr,
	toggleTaskLine,
	weekRange,
	daysInMonth,
} from "./daily";
import type { GoalMode, PeriodStats, PeriodType, PlanDef, PlanGoal, PlanGoalProgress, PlanProgress, PlanRate, QuotaProgress } from "./stats";
import { yearDirName } from "./paths";
import {
	computePeriodStats,
	computeAnnualPlanProgress,
	computeQuotaDaily,
	computeWritingDaily,
	filterTasksInRange,
	hasChoreGoal,
	parsePlansFromFrontmatter,
	readPlanPeriod,
} from "./stats";
import type { AutoTaskPlan, BookGroup, NewTaskInput, PoolTask, ShareClearEntry } from "./tasks";
import { addTask, DAY_MS, deleteTask, diffShareClear, editTask, ensureAutoTasks, extractGoalName, groupPoolTasksByGoal, isAutoTask, isRestartUnit, listTasks, planCounterUnit, suggestNextUnit, toggleTask, expandGoalStructure, expandGoalLeaves, chaptersToStructure, rescheduleChapterLine, STRUCT_UNITS, type ChapterRescheduleContext, type GoalLeaf, type GoalLevel } from "./tasks";
import { badgeCounts, computeStreak, readMonthBadges, readPeriodBadges, settleMonth, settleMonthCheckin, settleWeek, settleWeekCheckin, tierFor } from "./achievements";
import { attachGanttDrag } from "./gantt-drag";
import { syncPlanTrackingToDiary, syncPoolTaskToDiary, writeReviewToDiary, writeSummaryToDiary, extractReviewSection, buildReviewPrefill, extractNextDayPlanSection, writeNextDayPlanToDiary, type TrackingItem } from "./diary-sync";
import { DEFAULT_PLAN_COLORS, type PlanTemplate } from "./settings";
import type { BzgSnapshot } from "./bzg";
import { diaryDayWritten, loadBzgSnapshot, readBzgDiaryText, reviewPoolSize, reviewedOn } from "./bzg";
import { parseToc, tocLeafRange, tocSummary } from "./toc";
import {
	getWeaveBridge,
	passedLeafIndicesFine,
	resumeLeafCount,
	weaveTocToStructure,
	inferNeighborSpines,
	resolveMissingAnchors,
	type WeaveBookSummary,
	type WeaveBridgeApi,
	type WeaveTocNode,
} from "./weave-bridge";
import {
	ensureWeaveAlignment,
	getWeaveAlignment,
	isAlignCached,
	reconcileIfOpen,
} from "./weave-runtime";

/** v1.7.4: 插件改名 PlanFlow——view type 同步改（workspace 布局重新打开一次即可） */
export const VIEW_TYPE_PLANFLOW = "planflow";
let renderQueued = false;


type TabKey = PeriodType | "today" | "board" | "gantt";

const PERIOD_TITLES: Record<PeriodType, string> = {
	week: "本周",
	month: "本月",
	year: "年度",
};

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 达成音效：WebAudio 合成"叮"（880→1320Hz 双音，零资源文件）。 */
function playAchievementSound(): void {
	try {
		const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Ctx) return;
		const ctx = new Ctx();
		const now = ctx.currentTime;
		// 主音 880Hz（A5）
		const osc = ctx.createOscillator();
		osc.type = "sine";
		osc.frequency.setValueAtTime(880, now);
		osc.frequency.exponentialRampToValueAtTime(1320, now + 0.09);
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
		osc.connect(gain).connect(ctx.destination);
		osc.start(now);
		osc.stop(now + 0.55);
		// 泛音（加亮）
		const osc2 = ctx.createOscillator();
		osc2.type = "triangle";
		osc2.frequency.setValueAtTime(1760, now);
		const g2 = ctx.createGain();
		g2.gain.setValueAtTime(0.0001, now);
		g2.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
		g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
		osc2.connect(g2).connect(ctx.destination);
		osc2.start(now);
		osc2.stop(now + 0.4);
		window.setTimeout(() => void ctx.close(), 800);
	} catch {
		/* 音效失败不影响功能 */
	}
}

/** 份额清空提醒音效：WebAudio 合成「叮-咚」下行双音（E6→C6，零资源文件），与成就音的上行扫频区分。 */
function playShareClearSound(): void {
	try {
		const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Ctx) return;
		const ctx = new Ctx();
		const now = ctx.currentTime;
		// 「叮」E6（1318.5Hz）短音
		const ding = ctx.createOscillator();
		ding.type = "sine";
		ding.frequency.setValueAtTime(1318.5, now);
		const dingGain = ctx.createGain();
		dingGain.gain.setValueAtTime(0.0001, now);
		dingGain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
		dingGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
		ding.connect(dingGain).connect(ctx.destination);
		ding.start(now);
		ding.stop(now + 0.3);
		// 「咚」C6（1046.5Hz）接续长音
		const dong = ctx.createOscillator();
		dong.type = "sine";
		dong.frequency.setValueAtTime(1046.5, now + 0.18);
		const dongGain = ctx.createGain();
		dongGain.gain.setValueAtTime(0.0001, now + 0.18);
		dongGain.gain.exponentialRampToValueAtTime(0.16, now + 0.22);
		dongGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
		dong.connect(dongGain).connect(ctx.destination);
		dong.start(now + 0.18);
		dong.stop(now + 0.65);
		window.setTimeout(() => void ctx.close(), 900);
	} catch {
		/* 音效失败不影响功能 */
	}
}

/** Days since the ISO base date (1-based), e.g. dayIndexOf("2026-02-01", "2026-01-01") = 32. */
function dayIndexOf(d: string, base: string): number {
	return Math.round((parseDateString(d).getTime() - parseDateString(base).getTime()) / DAY_MS) + 1;
}

/** v1.6: 徽章内容拆分——emoji 放大显示（奖牌数字清晰），文字常规字号。 */
function setBadgeContent(el: HTMLElement, emoji: string, text: string): void {
	el.empty();
	el.createSpan({ cls: "planboard-badge-emoji", text: emoji });
	el.createSpan({ cls: "planboard-badge-text", text: text });
}

/** 卡片底部拖拽调整高度（月/周任务列表、打卡卡、总结卡），持久化到插件设置。
 *  target 为高度变化元素（月/周=列表，打卡/总结=卡片自身）；handle 挂卡片上（列表 empty() 不会清掉）。
 *  linked 可选：并排联动卡（拖一张，另一张同高同步）。 */
/** v1.6: 计划卡拖拽排序——实时重排 + FLIP 动画（react-beautiful-dnd / dnd-kit 网格标准）：
 *  被拖卡 fixed 脱离流跟手（left/top 跟随鼠标）；
 *  拖动中实时 2D 碰撞检测（中心点 vs 其他卡矩形）→ 跨项即重排 DOM；
 *  重排后其他卡用 FLIP 动画平滑滑到新位置（左右上下都可拖）；
 *  松手恢复流式布局 + FLIP 归位。window 捕获阶段拦截（抢在 Obsidian 之前）。
 *  顺序持久化到 settings.planOrder。 */
function attachPlanSort(card: HTMLElement, container: HTMLElement, plugin: PlanBoardPlugin, planName: string, columns?: HTMLElement[]): void {
	const head = card.querySelector<HTMLElement>(".planboard-plan-head") ?? card;
	head.addClass("planboard-drag-head");
	card.setAttribute("data-plan-name", planName);
	// v1.7.4: JS 显式两列容器——columns 为列容器数组（默认 [container] 兼容非年度视图调用）
	const cols: HTMLElement[] = columns && columns.length ? columns : [container];
	const othersAll = (): HTMLElement[] => cols.flatMap((c) => Array.from(c.children)) as HTMLElement[];
	const parentOf = (el: HTMLElement): HTMLElement => (el.parentElement as HTMLElement) || container;
	let dragging = false;
	let grabX = 0;
	let grabY = 0;
	let offsetX = 0; // v1.6: 重排补偿（重排后 DOM 位置变化，transform 基准随之修正）
	let offsetY = 0;
	let lastMoveT = 0; // v1.6: 时间节流（替代 rAF——后台页面 rAF 暂停）
	let lastKey = ""; // v1.6.2: 防重键 = 目标计划名 + 模式（同目标不同模式可推进：before→swap）
	// v1.6.1: 逻辑位置缓存——碰撞检测用【布局最终位置】（FLIP 动画中间帧 rect 会抖动碰撞判断）
	const logicRects = new Map<HTMLElement, DOMRect>();
	const rectOf = (el: HTMLElement): DOMRect => logicRects.get(el) ?? el.getBoundingClientRect();
	// v1.6.2: 反推布局位置（视觉 rect − transform 偏移）——offset 补偿必须用布局位置（用视觉 rect 会被旧位移污染导致跟手断裂）
	const layoutOf = (el: HTMLElement): { left: number; top: number } => {
		const r = el.getBoundingClientRect();
		const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform);
		if (m) {
			return { left: r.left - parseFloat(m[1]), top: r.top - parseFloat(m[2]) };
		}
		return { left: r.left, top: r.top };
	};

	/** FLIP：让其他卡从旧位置平滑滑到新位置（重排后调用）；并缓存逻辑位置供碰撞检测。 */
	const flipOthers = (): void => {
		const others = othersAll().filter((c) => c !== card);
		const firsts = others.map((c) => c.getBoundingClientRect());
		// （DOM 已被调用方重排；这里仅做动画 + 缓存逻辑位置）
		others.forEach((c, i) => {
			const r = c.getBoundingClientRect();
			logicRects.set(c, r);
			const dx = firsts[i].left - r.left;
			const dy = firsts[i].top - r.top;
			if (dx || dy) {
				// 对齐看板列模式：先禁过渡（瞬间定位）→ 设 transform → 强制重排 → 开过渡归位
				c.addClass("planflow-flip-none");
				c.style.transform = `translate(${dx}px, ${dy}px)`;
				void c.offsetWidth;
				c.removeClass("planflow-flip-none");
				c.addClass("planflow-flip-med");
				c.style.removeProperty("transform");
			}
		});
	};

	/** v1.7.4 重写：列感知中心定位（columns 瀑布专用）。
	 *  目标列 = 被拖卡中心 x 所在列（±8 吸附）；
	 *  列内：中心 y 落某卡内 → swap（对准哪张换哪张，无歧义）；
	 *        中心 y 落两卡间隙 → 插入（before/after）；
	 *        中心 y 低于该列底部 → 列内末尾插入（修复旧 end 检测跨列误判——大卡撑高全局阈值，
	 *        小卡拖向矮列被误判为"拖到所有卡末尾"而无法移入）。 */
	interface RefResult {
		target: HTMLElement;
		mode: "swap" | "before" | "after" | "end" | "first";
	}
	/** 拖拽判定（v2.1 分离语义，实测校准）：
	 *  两列（年度视图）→ v2.0 间隙插入模型：列归属（横向重叠）→ 列内按中心 cy 找间隙
	 *    （列首 before / 卡内按中心± / 列尾 after / 空列 first），无 swap、无方向判定、无方向锁
	 *    （v2.2: 删除 lastRef2 锁——它把"拖到第一行上方"锁死在 after；年度卡大间距大本就不抖）；
	 *  单列（周/月视图）→ v1.7.5 swap 语义原样保留（用户实测确认满意，不再改动）。 */
	const computeRef = (): RefResult | null => {
		const others = othersAll().filter((c) => c !== card);
		const dr = card.getBoundingClientRect(); // 被拖卡视觉 rect（含 transform = 当前跟手位置）
		const cx = dr.left + dr.width / 2;
		const cy = dr.top + dr.height / 2;
		// ===== 两列（年度视图）：v2.0 间隙插入模型 =====
		if (cols.length > 1) {
			// 1. 列归属：与【列容器】横向重叠宽度最大者（v2.3: 用列容器而非卡聚类——
			//    空列不在卡聚类里，拖入空列会被判死区；列容器 rect 天然包含空列）。
			//    全部零重叠（列间隙）时用中心点兜底。
			let targetColEl: HTMLElement | null = null;
			let bestOverlap = 0;
			const colRects = cols.map((c) => c.getBoundingClientRect());
			for (let i = 0; i < cols.length; i++) {
				const cr = colRects[i];
				const ov = Math.min(dr.right, cr.right) - Math.max(dr.left, cr.left);
				if (ov > bestOverlap) {
					bestOverlap = ov;
					targetColEl = cols[i];
				}
			}
			if (!targetColEl || bestOverlap <= 0) {
				for (let i = 0; i < cols.length; i++) {
					const cr = colRects[i];
					if (cx >= cr.left && cx <= cr.right) {
						targetColEl = cols[i];
						break;
					}
				}
			}
			if (!targetColEl) return null;
			const sameCol = Array.from(targetColEl.children).filter((c) => c !== card) as HTMLElement[];
			// 2. 空列 → 插列首（第一行）
			if (sameCol.length === 0) {
				return { target: targetColEl, mode: "first" };
			}
			// 3. 列内按【卡顶 top】找间隙（v2.3: 卡中心会被大卡高度滞后——写作卡 h435 拖到列首上方
			//    时中心还在下面，插不到第一行；卡顶 = 鼠标抓取位置，判定更直觉）
			const top = dr.top;
			for (const o of sameCol) {
				const r = rectOf(o);
				if (top < r.top) return { target: o, mode: "before" }; // 列首
				if (top <= r.bottom) {
					// 卡内：按相对卡中心，上半插前、下半插后（吸附感）
					return { target: o, mode: top < (r.top + r.bottom) / 2 ? "before" : "after" };
				}
			}
			return { target: sameCol[sameCol.length - 1], mode: "after" }; // 列尾
		}
		// ===== 单列（周/月视图）：v1.7.5 swap 语义（原样保留）=====
		const dy = (card.style.transform.match(/translate3d\([^,]+,\s*(-?[\d.]+)px/) ?? [null, "0"])[1];
		const movingDown = parseFloat(dy ?? "0") >= 0;
		// 0. 全局末尾：中心 y 低于【所有卡】最大底部 +12 → append（真正拖到最底部）
		const maxBottom = others.reduce((m, o) => Math.max(m, rectOf(o).bottom), -Infinity);
		if (others.length > 0 && cy > maxBottom + 12) {
			return { target: others[others.length - 1], mode: "end" };
		}
		// 1. 列归属：按 left 聚类成列（同列 left 相同），中心 x 落在哪列 → 目标列
		const colGroups = new Map<number, HTMLElement[]>();
		for (const o of others) {
			const left = Math.round(rectOf(o).left);
			const list = colGroups.get(left) ?? [];
			list.push(o);
			colGroups.set(left, list);
		}
		let targetCol: HTMLElement[] | null = null;
		for (const [left, list] of colGroups) {
			const colRight = left + rectOf(list[0]).width;
			if (cx >= left && cx <= colRight) {
				targetCol = list;
				break;
			}
		}
		if (!targetCol) return null; // 中心在列间死区（间隙）——不动
		// 2. 列内沿拖动方向找垂直重叠 ≥ 1/3 的最大卡 → swap（重叠 1/3 即交换）
		let best: HTMLElement | null = null;
		let bestRatio = 0;
		for (const o of targetCol) {
			const r = rectOf(o);
			// 只沿拖动方向：向下拖只看下方卡，向上拖只看上方卡
			if (movingDown && r.top < dr.top - 2) continue;
			if (!movingDown && r.bottom > dr.bottom + 2) continue;
			const vOverlap = Math.min(dr.bottom, r.bottom) - Math.max(dr.top, r.top);
			if (vOverlap <= 0) continue;
			const ratio = vOverlap / Math.min(dr.height, r.height);
			if (ratio > bestRatio) {
				bestRatio = ratio;
				best = o;
			}
		}
		if (best && bestRatio >= 0.34) {
			return { target: best, mode: "swap" };
		}
		return null;
	};

	const onMove = (ev: PointerEvent): void => {
		if (!dragging) return;
		// v1.6: 时间节流 ~60fps——不用 rAF（后台/未聚焦页面 rAF 被 Chromium 暂停，拖拽会完全失效）
		const now = Date.now();
		if (now - lastMoveT < 16) return;
		lastMoveT = now;
		// transform 跟手（相对流式位置 + 重排补偿）——不用 fixed（Obsidian transform 祖先劫持 fixed 坐标基准）
		// v2.1: 移动阈值（activation constraint）——原始位移 <4px 视为"按下未拖"，不判定不重排
		//（修复：按下瞬间 dy≈0 时判定会锁死方向/触发无操作重排，周月年度通杀）
		const rawX = ev.clientX - grabX;
		const rawY = ev.clientY - grabY;
		if (Math.abs(rawX) < 4 && Math.abs(rawY) < 4) return;
		const dx = rawX + offsetX;
		const dy = rawY + offsetY;
		card.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
		// 2D 目标位置（单列 swap / 两列间隙插入；null=死区不动）
		const res = computeRef();
		if (res && res.target !== card) {
			const key = res.target.getAttribute("data-plan-name") + ":" + res.mode;
			if (key !== lastKey) {
				// v2.3 修复: 原位保护——C 已在目标位置则不重排（无操作 insertBefore + FLIP 是抖动源）。
				// 条件曾写反（before 用 previousElementSibling）：card 在 target【后】时判定 before
				// 被误判"已在位"跳过 → 拖到第一行上方插不进去。已在位 = card 紧邻 target 前/后。
				if (
					(res.mode === "before" && card.nextElementSibling === res.target) ||
					(res.mode === "after" && card.previousElementSibling === res.target) ||
					(res.mode === "first" && card.parentElement === res.target && card === res.target.firstChild)
				) {
					lastKey = key;
					return;
				}
				lastKey = key;
				// 重排：记录【布局位置】→ DOM 操作 → 补偿 offset（视觉连续）
				const oldL = layoutOf(card);
				if (res.mode === "swap") {
					// v1.7.5: 真交换（单列用）——重叠 1/3 即交换：相邻时单步移动，不相邻时两步对调
					if (card.nextSibling === res.target) {
						// card 紧邻 target 前 → card 移到 target 后
						parentOf(card).insertBefore(card, res.target.nextSibling);
					} else if (res.target.nextSibling === card) {
						// card 紧邻 target 后 → card 移到 target 前
						parentOf(card).insertBefore(card, res.target);
					} else {
						// 不相邻：target 移到 card 前，card 移到 target 原位
						const cardCol = parentOf(card);
						const targetCol = parentOf(res.target);
						const targetNext = res.target.nextSibling;
						cardCol.insertBefore(res.target, card);
						targetCol.insertBefore(card, targetNext);
					}
				} else if (res.mode === "after") {
					// 插目标后（列尾时 nextElementSibling=null → append 到该列末尾）
					const tc = parentOf(res.target);
					tc.insertBefore(card, res.target.nextElementSibling);
				} else if (res.mode === "first") {
					// 空列 → 插到列容器开头（第一行）
					res.target.insertBefore(card, res.target.firstChild);
				} else if (res.mode === "end") {
					// 拖到最底部 → 最后一列末尾（单列）
					cols[cols.length - 1].appendChild(card);
				} else {
					// before：插目标前（同列或跨列 insertBefore 均正确）
					parentOf(res.target).insertBefore(card, res.target);
				}
				const newL = layoutOf(card);
				offsetX += oldL.left - newL.left;
				offsetY += oldL.top - newL.top;
				card.style.transform = `translate3d(${rawX + offsetX}px, ${rawY + offsetY}px, 0)`;
				flipOthers();
			}
		}
	};

	const finish = (ev?: PointerEvent): void => {
		if (!dragging) return;
		dragging = false;
		window.removeEventListener("pointermove", onMove, true);
		window.removeEventListener("pointerup", finish, true);
		window.removeEventListener("pointercancel", finish, true);
		if (ev) ev.preventDefault();
		// v1.6.1: 清逻辑位置缓存
		logicRects.clear();
		// 先清其他卡所有残留 transform/transition（FLIP 动画残留会污染 rect 计算）
		othersAll().forEach((c) => {
				if (c === card) return;
				c.removeClass("planflow-flip-none");
				c.removeClass("planflow-flip-fast");
				c.removeClass("planflow-flip-med");
				c.removeClass("planflow-flip-slow");
				c.style.removeProperty("transform");
			});
		// 被拖卡恢复流式布局 + FLIP 归位（从鼠标位置滑入格子）
		const from = card.getBoundingClientRect();
		card.removeClass("is-plan-dragging");
		card.style.removeProperty("transform");
		const to = card.getBoundingClientRect();
		const dx = from.left - to.left;
		const dy = from.top - to.top;
		if (dx || dy) {
			card.addClass("planflow-flip-none");
			card.style.transform = `translate(${dx}px, ${dy}px)`;
			void card.offsetWidth;
			card.removeClass("planflow-flip-none");
			card.addClass("planflow-flip-slow");
			card.style.removeProperty("transform");
		}
		// 兜底清理（rAF 不可靠时 300ms 后强制归零）
		window.setTimeout(() => {
			card.removeClass("planflow-flip-none");
			card.removeClass("planflow-flip-fast");
			card.removeClass("planflow-flip-med");
			card.removeClass("planflow-flip-slow");
			card.style.removeProperty("transform");
		}, 320);
		const names = othersAll().map((c) => c.getAttribute("data-plan-name") || "").filter(Boolean);
		plugin.settings.planOrder = names;
		void plugin.saveSettings();
	};

	// window 捕获阶段拦截 pointerdown（最早执行，抢在 Obsidian 任何监听之前）
	const onCapture = (e: PointerEvent): void => {
		if (!card.isConnected) {
			window.removeEventListener("pointerdown", onCapture, true);
			return;
		}
		// v1.7.4: 只响应左键——右键让位给卡头 contextmenu（编辑/删除计划菜单）
		if (e.button !== 0) return;
		const t = e.target as HTMLElement;
		if (t.closest("button, input, textarea, .planboard-icon-btn")) return;
		// v1.6: 精确匹配【本卡的 head】——路径里必须含本卡 head 才激活（修复"拖哪张都是第一张动"）
		if (!e.composedPath().includes(head)) return;
		e.preventDefault();
		e.stopImmediatePropagation(); // 阻断 Obsidian 及一切后续监听
		// v1.6: 拖动前彻底清理——防上次残留 transform 污染 rect 计算
		othersAll().forEach((c) => {
			c.removeClass("planflow-flip-none");
			c.removeClass("planflow-flip-fast");
			c.removeClass("planflow-flip-med");
			c.removeClass("planflow-flip-slow");
			c.style.removeProperty("transform");
		});
		// v1.6.1: 按下快照逻辑位置（此时无动画，实时 rect = 布局位置）
		logicRects.clear();
		othersAll().forEach((c) => {
			logicRects.set(c, c.getBoundingClientRect());
		});
		dragging = true;
		offsetX = 0;
		offsetY = 0;
		grabX = e.clientX;
		grabY = e.clientY;
		card.addClass("is-plan-dragging");
		lastKey = "";
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", finish, true);
		window.addEventListener("pointercancel", finish, true);
	};
	window.addEventListener("pointerdown", onCapture, true);
}
/** v1.7.2: 看板任务卡拖拽——列内重排（1D 垂直，重叠 1/3 触发）+ 跨列移动（拖入其他列松手写回）。
 *  mode: "category"（跨列 = 改 plan）/ "status"（跨列 = 改状态）。
 *  onDrop(task, targetCol) 负责数据写回 + 视图刷新。轻点（无移动）放行 click（打开编辑/勾选）。 */

function attachResizeHandle(
	card: HTMLElement,
	target: HTMLElement,
	plugin: PlanBoardPlugin,
	key: "monthCardHeight" | "weekCardHeight" | "checkCardHeight" | "summaryCardHeight" | "yearPlanHeights",
	linked?: { target: () => HTMLElement | null; key: "monthCardHeight" | "weekCardHeight" | "checkCardHeight" | "summaryCardHeight" },
	mapKey?: string,
): void {
	const handle = card.createDiv({ cls: "planboard-resize-handle", attr: { title: "拖动调整高度" } });
	let startY = 0;
	let startH = 0;
	const writeH = (h: number): void => {
		if (key === "yearPlanHeights" && mapKey) {
			plugin.settings.yearPlanHeights[mapKey] = h;
		} else {
			(plugin.settings as unknown as Record<string, number>)[key] = h;
		}
	};
	handle.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		startY = e.clientY;
		startH = target.clientHeight;
		const move = (ev: PointerEvent): void => {
			// v1.7.4: 自由缩放（min 80）——handle 贴底即下边框，二者相对固定；
			// 内容溢出由各卡内容容器滚动/裁剪处理（见 styles.css 年度卡 plan-tasks 滚动）
			const h = Math.min(1200, Math.max(80, startH + (ev.clientY - startY)));
			target.style.height = `${h}px`;
			card.addClass("is-height-fixed"); // 拖动即视为"拖过卡高"（年度卡量化目标框据此改为卡内滚动；其余卡类型无匹配 CSS，no-op）
			writeH(h);
			if (linked) {
				const lt = linked.target();
				if (lt) {
					lt.style.height = `${h}px`;
					plugin.settings[linked.key] = h;
				}
			}
		};
		const up = (): void => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			void plugin.saveSettings();
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	});
}

/** v2.x: 年度卡「量化目标框 ⇆ 任务区」拖拽分隔条——拖动调框高（每计划持久化 yearGoalBoxHeights），
 *  任务区吃剩余空间。框高钳制上限随当前卡高收紧（-120 留给卡头/任务区），防止框把分隔条顶出卡外摸不到。 */
function attachGoalsDivider(
	card: HTMLElement,
	goalsBox: HTMLElement,
	plugin: PlanBoardPlugin,
	plan: string,
): void {
	const divider = card.createDiv({ cls: "planboard-goals-divider", attr: { title: "拖动调整量化目标区高度" } });
	let startY = 0;
	let startH = 0;
	divider.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		startY = e.clientY;
		startH = goalsBox.clientHeight;
		const maxH = Math.max(80, Math.min(1200, card.clientHeight - 120));
		const move = (ev: PointerEvent): void => {
			const h = Math.min(maxH, Math.max(80, startH + (ev.clientY - startY)));
			goalsBox.style.height = `${h}px`;
			goalsBox.addClass("is-height-fixed");
			plugin.settings.yearGoalBoxHeights[plan] = h;
		};
		const up = (): void => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			void plugin.saveSettings();
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	});
}

/** 异步确认对话框（替代原生 confirm()，满足 Obsidian 官方审查合规要求）。返回 boolean。 */
function confirmDialog(app: App, message: string, opts: { confirmText?: string; cancelText?: string; danger?: boolean } = {}): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const modal = new Modal(app);
		modal.contentEl.addClass("planboard-confirm-modal");
		modal.contentEl.createEl("p", { text: message });
		const row = modal.contentEl.createDiv({ cls: "planboard-confirm-buttons" });
		const ok = new ButtonComponent(row)
			.setButtonText(opts.confirmText ?? "确定")
			.onClick(() => { resolve(true); modal.close(); });
		if (opts.danger) ok.buttonEl.addClass("mod-warning"); // 红色危险按钮（setWarning 已 deprecated、setDestructive 需 1.13+，用内置 CSS 类等效且无版本限制）
		new ButtonComponent(row)
			.setButtonText(opts.cancelText ?? "取消")
			.onClick(() => { resolve(false); modal.close(); });
		// Esc / 点遮罩关闭时兜底返回 false（按钮路径已先 resolve，二次 resolve 无效）
		modal.onClose = () => resolve(false);
		modal.open();
	});
}

/** 完成率分档（奖励机制）：≥100 金 / ≥80 银 / ≥60 铜 / 其余默认 */
function tierClass(percent: number): string {
	if (percent >= 100) return "is-gold";
	if (percent >= 80) return "is-silver";
	if (percent >= 60) return "is-bronze";
	return "";
}

/** 设置进度条分档 class（换档时清理旧档） */
function setTier(el: HTMLElement, percent: number): void {
	el.removeClass("is-gold", "is-silver", "is-bronze");
	const t = tierClass(percent);
	if (t) el.addClass(t);
}

/** Pre-filled fields for the new-task modal. */
interface TaskDefaults {
	plan?: string;
	start?: string;
	due?: string;
}

/** Fields editable in PlanEditModal (new or edit a plan category). */
interface PlanEditInput {
	name: string;
	label: string;
	action: string;
	target: string;
	color: string;
	daily: boolean;
	/** 打卡率分母按工作日（周一至周五）统计——仅打卡型计划有意义。 */
	tradingDay: boolean;
}

/** Fields editable in GoalEditModal (new or edit a quantified goal). */
interface GoalInput {
	name: string;
	count: number;
	unit: string;
	start?: string;
	end?: string;
	/** ADR-0005 兼容：逐章节数；非空时按「第 X 章第 Y 节」分解（count = Σ chapters）。 */
	chapters?: number[];
	/** ADR-0005 v2 多级结构：篇→章→节 等 1~3 级单位树（优先于 chapters）。 */
	structure?: GoalLevel[];
	/** ADR-0006: 目标模式；undefined = 通用模式。 */
	mode?: GoalMode;
	/** ADR-0006: 每日量（review=当日下限；exercise=可选每日目标量）。 */
	floor?: number;
	/** ADR-0009: weave 阅读器联动——来源书 sid + 接续阅读预勾叶数 + 每叶锚点快照。 */
	reader?: { sid: string; resumeLeaves: number; anchors?: { spine: number; href: string; progress?: number }[] };
	/** ADR-0010 写作模式·按字数：总量 + 接续已累计字数（floor 由保存链按窗口冻结计算）。 */
	writingQuota?: { total: number; initial: number };
	/** ADR-0010 写作模式·按章节：接续预勾章数（与接续阅读同一预勾实现）。 */
	resumeLeaves?: number;
	/** ADR-0016 生活模式：固定日子式周期 + 逾期策略（postpone 落盘，缺省放弃）。 */
	cycle?: GoalCycle;
	overdue?: ChoreOverdue;
}

/** 目标模式展示元数据（ADR-0006/0010/0016）。 */
const GOAL_MODE_META: Record<GoalMode, { emoji: string; label: string; desc: string }> = {
	reading: { emoji: "📖", label: "阅读书籍", desc: "按书籍结构逐节拆解，自动安排阅读时长" },
	writing: { emoji: "✍️", label: "写小说", desc: "按字数（每日配额）或按章节（逐章任务）量化，下拉选择" },
	review: { emoji: "🔁", label: "复习", desc: "每天至少复习 N 篇文献，实际量自动来自 BZG" },
	diary: { emoji: "📝", label: "日记", desc: "每天至少一篇日记，检测到当天有亲手写下的内容即自动打钩" },
	exercise: { emoji: "🏃", label: "运动", desc: "每日运动打卡，可附记时长或次数" },
	chore: { emoji: "🏠", label: "生活", desc: "洗碗、做卫生、买菜等：按固定日子循环（每天/每周日/每月几号/每年某日），漏了可放弃或顺延" },
};

/** ADR-0016: 生活事项的承载计划名（保存时缺则自动创建，label 🏠）。 */
const CHORE_PLAN_NAME = "日常生活";

/** 运动模式常用单位（下拉直选；「自定义…」兜底任意单位词）。 */
const EXERCISE_UNITS = ["次", "组", "分钟", "小时", "公里", "千卡"];

/** Palette offered in PlanEditModal (spec v1.2); empty choice = auto-rotate. */
/** 计划色板：value 存 hex（数据兼容），label 用中文名（ADR-0002 时代的 UI 可读性需求）。 */
const PLAN_COLOR_OPTIONS: { value: string; label: string }[] = [
	{ value: "#f59e0b", label: "琥珀橙" },
	{ value: "#10b981", label: "翡翠绿" },
	{ value: "#3b82f6", label: "天空蓝" },
	{ value: "#ef4444", label: "珊瑚红" },
	{ value: "#8b5cf6", label: "紫罗兰" },
	{ value: "#ec4899", label: "桃花粉" },
	{ value: "#14b8a6", label: "青碧色" },
	{ value: "#f97316", label: "鲜橙色" },
];

/**
 * Main PlanBoard view: tab bar + per-tab panels (PRD §3, DEV.md M2).
 * Today panel is the home page (年度目标卡 → 本月任务卡 → 本周任务卡 → 今日打卡),
 * with live check-in toggling and task-pool CRUD in week/month/year views.
 */
export class PlanBoardView extends ItemView {
	plugin: PlanBoardPlugin;

	private tab: TabKey = "today";
	private today = todayStr();
	private dailyData: DailyData | null = null;
	private refreshTimer: number | null = null;
	/** True while the view itself is writing to a vault file (suppresses modify events). */
	private selfWrite = false;
	/** Which panel's skeleton is currently rendered in the DOM. */
	private currentPanel: TabKey | null = null;
	private summaryFocused = false;
	/**
	 * Gantt sub-mode（v1.3）：week / month / year。
	 * v1.0.4：按用户要求移除周/月视图，甘特只保留年视图——字段与默认值保留仅为
	 * 兼容 data-axis 属性语义，恒为 "year"。
	 */
	private ganttMode: "week" | "month" | "year" = "year";
	/** Board sub-mode (v1.3): group by plan category or by status. */
	private boardMode: "category" | "status" = "category";

	// Task-pool data for the current period (refreshed on vault modify).
	private weekTasks: PoolTask[] = [];
	private monthTasks: PoolTask[] = [];
	/** ADR-0003: 任务池全量快照（buildHomeData 时刷新）——今日打卡子任务的单一来源。 */
	private allPoolTasks: PoolTask[] = [];
	/** ADR-0008: 已展开「今日已勾叶」的完成书组（`${plan}||${书名}`）——视图级临时状态，不落文件。 */
	private expandedBookGroups = new Set<string>();
	/** Latest gantt task list (drag write-back resolves tasks by pool line). */
	private ganttBarTasks: PoolTask[] = [];
	private planProgress: PlanProgress[] = [];
	/** ADR-0001: 当前 quota 计划名集合（配额行的「实际量」按钮判定用）。 */
	private quotaPlanSet = new Set<string>();
	/** ADR-0007: BZG 只读联动快照（每次刷新重建；联动关闭/BZG 缺席为 null）。 */
	private bzgSnapshot: BzgSnapshot | null = null;
	/** ADR-0006: 当前模式目标清单（实按钮判定/自动勾选；buildHomeData 时重建）。 */
	private modeGoals: { plan: string; goal: PlanGoal; label: string }[] = [];
	/** ADR-0016: 生活事项挂账事实（`${plan}|${name}` → 有旧挂账未清），ensureChoreTracking 重建，逾期徽标判定用。 */
	private choreDebtMap = new Map<string, boolean>();
	/** ADR-0009: weave 阅读器桥（设置开关门控；fork 缺席/形状不符为 null）。 */
	private weaveBridge: WeaveBridgeApi | null = null;
	/** ADR-0009: sid → 叶序锚点缓存（spine 章序 + href；结构与目录形状一致才缓存，null = 形状不符）。 */
	/** ADR-0009: 进行中的锚点解析（in-flight 去重）。 */
	/** ADR-0009: 对齐失败已提示过的 sid（一次性提示，避免刷屏）。 */
	/** ADR-0009: 上次对账时刻（节流——对账是兜底不是追问，vault 改动驱动的刷新不重跑）。 */
	/** ADR-0009: 锚点补齐后的重渲染去重（同一时刻只刷一次打卡列表）。 */
	/** ADR-0009: 进行中的推进确认通知（同一目标不重复弹；hide 时移除）。 */

	// DOM refs (nullable — guard before touching)
	private panelEl: HTMLElement | null = null;
	/** 顶部日期行（v1.4）。 */
	private homeDateMainEl: HTMLElement | null = null;
	private homeDateSubEl: HTMLElement | null = null;
	private tabsEl: HTMLElement | null = null;
	private checklistEl: HTMLElement | null = null;
	private summaryEl: HTMLTextAreaElement | null = null;
	/** 打卡自动生成区（完成/未完成/鼓励语，v1.4）。 */
	private summaryAutoEl: HTMLElement | null = null;
	/** ADR-0014: 「昨日留的计划」只读块（昨日日记「# 次日计划」的实时侧读展示）。 */
	private yesterdayPlanEl: HTMLElement | null = null;
	private progressNumberEl: HTMLElement | null = null;
	private todayBadgeEl: HTMLElement | null = null;
	private progressFillEl: HTMLElement | null = null;

	// Home-page task cards
	private goalListEl: HTMLElement | null = null;
	private goalEmptyEl: HTMLElement | null = null;
	private monthTaskNumberEl: HTMLElement | null = null;
	private monthTaskFillEl: HTMLElement | null = null;
	private monthPreviewEl: HTMLElement | null = null;
	private monthPreviewEmptyEl: HTMLElement | null = null;
	private weekTaskNumberEl: HTMLElement | null = null;
	private weekTaskFillEl: HTMLElement | null = null;
	private weekPreviewEl: HTMLElement | null = null;
	private weekPreviewEmptyEl: HTMLElement | null = null;
	private streakEl: HTMLElement | null = null;
	private monthTaskBadgeEl: HTMLElement | null = null;
	private weekTaskBadgeEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PlanBoardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_PLANFLOW;
	}

	getDisplayText(): string {
		return "计划总览";
	}

	getIcon(): string {
		return this.plugin.settings.icon || "calendar";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("planboard-root");
		await this.injectPlanColorStyles();
		this.tabsEl = root.createDiv({ cls: "planboard-tabs" });
		this.renderTabs();
		this.panelEl = root.createDiv({ cls: "planboard-content" });
		this.registerEvent(this.app.vault.on("modify", this.onVaultModify));
		this.registerEvent(this.app.vault.on("create", this.onVaultModify));
		this.registerEvent(this.app.vault.on("delete", this.onVaultDelete));
		this.registerEvent(this.app.vault.on("rename", this.onVaultRename));
		await this.refresh();
		// v1.7.3: 打开时自动创建今日笔记（保持计划总览完整）——Obsidian 启动时 vault 索引异步，
		// 延迟重试直到索引就绪，仍缺失则静默按模板创建。
		if (!this.getTodayFile()) {
			window.setTimeout(() => void this.autoEnsureTodayNote(), 1200);
			window.setTimeout(() => void this.autoEnsureTodayNote(), 3500);
		}
		// Gantt drag: event-delegated on the root (survives DOM rebuilds).
		attachGanttDrag(this.app, root, {
			resolveTask: (line) => this.ganttBarTasks.find((t) => t.line === line),
			onEdit: (task) => void this.openTaskModal(task),
			onChanged: () => void this.refresh(),
		});
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
	}

	/** Called by the plugin when settings change. */
	requestRefresh(): void {
		void this.injectPlanColorStyles();
		void this.refresh();
	}

	// -------------------------------------------------------------------------
	// Vault event handling (PRD §4: modify + 500ms debounce, live sync)
	// -------------------------------------------------------------------------

	private onVaultModify = (file: TAbstractFile): void => {
		if (this.selfWrite) return;
		if (file instanceof TFile && file.path.startsWith(this.plugin.settings.rootPath)) {
			this.scheduleRefresh();
			return;
		}
		// ADR-0007: BZG 数据面变化（review.json 整写 / 日记日文件写入）→ 刷新今日自动勾/实际量
		const snap = this.bzgSnapshot;
		if (!snap) return;
		if (file.path === `${snap.storagePath}/review.json` || file.path.startsWith(`${snap.diaryDir}/`)) {
			this.scheduleRefresh();
		}
	};

	private onVaultDelete = (file: TAbstractFile): void => {
		if (file.path.startsWith(this.plugin.settings.rootPath)) this.scheduleRefresh();
	};

	private onVaultRename = (file: TAbstractFile, oldPath: string): void => {
		if (file.path.startsWith(this.plugin.settings.rootPath) || oldPath.startsWith(this.plugin.settings.rootPath)) {
			this.scheduleRefresh();
		}
	};

	private scheduleRefresh(): void {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 500);
	}

	// -------------------------------------------------------------------------
	// Tabs & panel switching
	// -------------------------------------------------------------------------

	private renderTabs(): void {
		if (!this.tabsEl) return;
		this.tabsEl.empty();
		const tabs: Array<{ key: TabKey; label: string }> = [
			{ key: "today", label: "今日" },
			{ key: "week", label: "本周" },
			{ key: "month", label: "本月" },
			{ key: "year", label: "年度" },
			{ key: "board", label: "看板" },
			{ key: "gantt", label: "甘特" },
		];
		for (const t of tabs) {
			const btn = this.tabsEl.createEl("button", {
				cls: "planboard-tab" + (this.tab === t.key ? " is-active" : ""),
				text: t.label,
			});
			btn.addEventListener("click", () => void this.switchTab(t.key));
		}
	}

	private async switchTab(tab: TabKey): Promise<void> {
		if (this.tab === tab) return;
		this.tab = tab;
		this.currentPanel = null; // force skeleton rebuild
		this.renderTabs();
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		// 计划增改后色表必须重建，否则新计划标签回退灰色（onOpen 只覆盖首次打开）
		await this.injectPlanColorStyles();
		// ADR-0009: weave 桥按当前设置重建（fork 缺席/关闭为 null，全链路静默降级）
		this.weaveBridge = getWeaveBridge(this.app, this.plugin.settings.weaveEnabled);
		if (this.tab === "today") {
			await this.refreshToday();
			// ADR-0009 对账兜底（Q13=B）：打开今日面板按书架位置批量确认补勾（最终一致）
			reconcileIfOpen(this.plugin);
		} else if (this.tab === "board") {
			await this.renderBoardPanel();
		} else if (this.tab === "gantt") {
			await this.renderGanttPanel();
		} else {
			await this.refreshPeriod(this.tab);
		}
	}

	// -------------------------------------------------------------------------
	// Today panel (home page)
	// -------------------------------------------------------------------------

	private getTodayPath(): string {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		return `${root}/${yearDirName(this.today.slice(0, 4))}/每日/${this.today}.md`;
	}

	private getTodayFile(): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.getTodayPath());
		return f instanceof TFile ? f : null;
	}

	/** Build the home page data: year goals + month/week task windows. */
	private async buildHomeData(): Promise<void> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);

		// v1.2 auto decomposition: top up this week's quota tasks for quantity plans.
		await this.ensureAutoTasksForToday(root, year);

		const tasks = await listTasks(this.app, root, year);
		this.allPoolTasks = tasks;

		const { start: ws, end: we } = weekRange(this.today);
		this.weekTasks = filterTasksInRange(tasks, ws, we);

		const [y, m] = this.today.split("-").map(Number);
		const monthStart = `${this.today.slice(0, 7)}-01`;
		const monthEnd = `${this.today.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
		this.monthTasks = filterTasksInRange(tasks, monthStart, monthEnd);

		// ADR-0007: BZG 只读快照（复习/日记模式的完成事实源）
		this.bzgSnapshot = await loadBzgSnapshot(this.app, this.plugin.settings.bzgEnabled);

		// Annual check-in rates (needed for check-type plan progress).
		const yearStats = await computePeriodStats(
			this.app,
			this.plugin.settings.rootPath,
			this.today,
			"year",
			this.plugin.settings.reviewWorkdays,
			this.bzgSnapshot
		);
		this.planProgress = await computeAnnualPlanProgress(
			this.app,
			root,
			this.today,
			tasks,
			yearStats.planRates,
			yearStats.quotaProgress,
			this.bzgSnapshot
		);
		this.quotaPlanSet = new Set(this.planProgress.filter((p) => p.isQuota).map((p) => p.plan));
		this.modeGoals = this.planProgress.flatMap((p) =>
			p.goals
				// ADR-0006/0010: 模式目标每日行走惰性补写；写作按章节是任务池口径，无每日行
				.filter((g) => g.mode && g.mode !== "reading" && !(g.mode === "writing" && !g.writingQuota))
				.map((g) => ({ plan: p.plan, goal: g, label: p.label }))
		);
	}

	/**
	 * ADR-0006: 识别一行是否为模式目标行（紧凑匹配：剥 emoji 后以目标名开头 +
	 * 有量须含「N单位」/ 无量须整行恰为名）。松散 includes 会把计划默认打卡行
	 * （如目标也叫「运动」时的「运动 每天半小时」）误判成模式行。
	 */
	private modeLineMatch(item: CheckItem): { plan: string; goal: PlanGoal; label: string } | null {
		if (!item.plan) return null;
		for (const mg of this.modeGoals) {
			if (mg.plan !== item.plan) continue;
			if (matchesModeLine(item.text, mg.goal.name, mg.goal.floor ?? 0, mg.goal.unit || "")) return mg;
		}
		return null;
	}

	/** ADR-0006: 某计划在今日打卡区的父行 = 同计划第一个非模式行（无则 null，模式行保持顶层）。 */
	private modeParentOf(item: CheckItem): CheckItem | null {
		if (!this.dailyData || !item.plan) return null;
		for (const it of this.dailyData.checkItems) {
			if (it.plan === item.plan && !this.modeLineMatch(it)) return it;
		}
		return null;
	}

	/** ADR-0006: 父行下的全部模式子行（今日打卡区、保持文件顺序）。 */
	private modeChildrenOf(parent: CheckItem): CheckItem[] {
		if (!this.dailyData || !parent.plan) return [];
		return this.dailyData.checkItems.filter((it) => it.plan === parent.plan && this.modeLineMatch(it));
	}

	// -------------------------------------------------------------------------
	// ADR-0009 weave 阅读器联动：推进事实（确认门）+ 对账兜底 + 跳转
	// -------------------------------------------------------------------------

	/** 按叶行文本找所属联动目标（叶行 = `{书名}（第…）` 前缀匹配）。 */
	private findReaderGoal(plan: string | null, text: string): { plan: string; goal: PlanGoal } | null {
		if (!plan) return null;
		for (const p of this.planProgress) {
			if (p.plan !== plan) continue;
			for (const g of p.goals) {
				if (g.readerSid && text.startsWith(`${g.name}（`)) return { plan, goal: g };
			}
		}
		return null;
	}

	/** ADR-0009: 叶锚点委托运行时（落盘快照优先，旧目标实时对齐）。 */
	private leafAnchorsFor(goal: PlanGoal): { spine: number[]; progress: number[]; hrefs: string[] } | null {
		return getWeaveAlignment(goal);
	}

	/** Read the annual plan's `plans` frontmatter (year-level, root-level fallback). */
	private async readAnnualPlanDefs(root: string, year: string): Promise<PlanDef[] | null> {
		for (const path of [`${root}/${yearDirName(year)}/年度计划.md`, `${root}/年度计划.md`]) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) {
				return parsePlansFromFrontmatter(await this.app.vault.cachedRead(f));
			}
		}
		return null;
	}

	/**
	 * v2.7: 今日打卡默认项 = 年度计划里 daily 计划的自动推导（无独立模板数据）。
	 * name = "{label} {计划名}"、duration = action。
	 * ADR-0014: 复盘计划不再自动追加 `→ [[{date} 复盘]]` 链接——写复盘自 ADR-0004 扩展三
	 * 起写入日记，链接目标文件从不存在，天天挂空链；手动建项的「含复盘链接」开关不受影响。
	 */
	private async buildDefaultCheckItems(): Promise<PlanTemplate[]> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const defs = await this.readAnnualPlanDefs(root, this.today.slice(0, 4));
		if (!defs) return [];
		return defs
			// ADR-0001: quota 计划的每日行由配额惰性生成，不进模板推导
			// ADR-0016: 生活计划的父行/事项行由 ensureChoreTracking 惰性生成——空日整计划不出现
			.filter((d) => d.daily && d.type !== "quota" && !hasChoreGoal(d))
			.map((d) => ({
				name: composeCheckItemName(d.label, d.name),
				duration: d.action ?? "",
				plan: d.name,
				includeReview: false,
			}));
	}

	/** 有效时间窗：目标显式 start/end 优先，缺省回退年度计划周期，再缺省自然年（与分解引擎同一口径）。 */
	private async resolveGoalWindow(
		input: GoalInput,
		root: string,
		year: string
	): Promise<{ start: string; end: string }> {
		if (input.start && input.end) return { start: input.start, end: input.end };
		const period = (await readPlanPeriod(this.app, root, year)) ?? {
			start: `${year}-01-01`,
			end: `${year}-12-31`,
		};
		return { start: input.start ?? period.start, end: input.end ?? period.end };
	}

	/**
	 * DEV.md v1.2: generate this week's quota tasks for quantity-type plans.
	 * Writes through the task pool (via ensureAutoTasks) only; suppressed from
	 * the vault-modify refresh loop via selfWrite.
	 */
	private async ensureAutoTasksForToday(root: string, year: string): Promise<void> {
		const defs = await this.readAnnualPlanDefs(root, year);
		if (!defs) return;
		const autoPlans: AutoTaskPlan[] = defs
			.filter((d) => d.type === "numeric" && d.targetCount > 0)
			.map((d) => ({
				name: d.name,
				target: d.target,
				targetCount: d.targetCount,
				// ADR-0006/0010: 模式目标不进任务池分解引擎（复习/日记/运动/写作按字数），
				// 阅读与写作按章节（无字数配额 = structure 平铺）分解
				goals: d.goals
					.filter((g) => !g.mode || g.mode === "reading" || (g.mode === "writing" && !g.writingQuota))
					.map((g) => ({ name: g.name, count: g.count, unit: g.unit, start: g.start, end: g.end, chapters: g.chapters, structure: g.structure })),
			}));
		if (autoPlans.length === 0) return;
		// 周期缺省回退自然年（与 computePeriodStats 同口径）——此前 readPlanPeriod 返回 null 时
		// 静默 return，年度文件没有顶层 start/end（老文件/手建）会导致所有分解永不执行、目标卡 0/0
		const period = (await readPlanPeriod(this.app, root, year)) ?? {
			start: `${year}-01-01`,
			end: `${year}-12-31`,
		};
		this.selfWrite = true;
		try {
			// v1.0.4: 传入墓碑（用户手动删除过的自动任务名），删除不再被补额"复活"
			const skip = new Set(this.plugin.settings.deletedAutoTasks ?? []);
			await ensureAutoTasks(this.app, root, year, this.today, autoPlans, period.start, period.end, skip);
		} finally {
			this.selfWrite = false;
		}
	}

	/**
	 * ADR-0001 惰性生成：今日打卡区缺失的 quota 行幂等补写（打开今日视图时触发；
	 * 已有该计划标签的行一律不重写；不打开视图不写文件，绝不碰历史日期）。
	 */
	private async ensureQuotaCheckItemsForToday(): Promise<void> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const defs = await this.readAnnualPlanDefs(root, year);
		if (!defs) return;
		const quotaDefs = defs.filter((d) => d.type === "quota" && d.quota);
		if (quotaDefs.length === 0) return;
		// 配额行默认文本的日期口径：quota.start 优先，缺省用年度计划周期起点，再缺省用年初
		const period = await readPlanPeriod(this.app, root, year);
		const quotas = quotaDefs.map((d) => {
			const q = d.quota!;
			const qStart = q.start ?? period?.start ?? `${year}-01-01`;
			return {
				plan: d.name,
				label: d.label ?? "",
				quota: computeQuotaDaily(q.total, qStart, q.end),
				unit: q.unit,
			};
		});
		const file = this.getTodayFile();
		if (!file) return;
		const content = await this.app.vault.cachedRead(file);
		const missing = missingQuotaLines(content, quotas, this.today);
		if (missing.length === 0) return;
		this.selfWrite = true;
		try {
			await this.app.vault.process(file, (data) => missing.reduce((acc, line) => appendCheckItem(acc, line), data));
		} finally {
			this.selfWrite = false;
		}
	}

	/**
	 * ADR-0006: 模式目标今日行惰性补写 + ADR-0007 自动状态写入。
	 * - 复习：BZG 今日实际复习篇数 → 写 `（实 M{unit}）`，M ≥ 当日下限自动勾选
	 * - 日记：当天日记日文件有亲手写下的内容（随笔/触动点）→ 自动勾选
	 * - 运动：无自动（手动打卡 +「实」记录）
	 * 事实优先（ADR-0011）：勾选/实数是完成事实的镜像，手动勾退不豁免——刷新即按事实回填；
	 * 未达下限也照实记录实际量（不勾选）。模式行存量 `✋` 顺带清除。
	 */
	private async ensureModeGoalTracking(): Promise<void> {
		if (this.modeGoals.length === 0) return;
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const period = (await readPlanPeriod(this.app, root, year)) ?? { start: `${year}-01-01`, end: `${year}-12-31` };
		const specs: ModeLineSpec[] = [];
		interface AutoOp {
			spec: ModeLineSpec;
			mode: GoalMode;
			floor: number;
		}
		const autos: AutoOp[] = [];
		for (const { plan, goal, label } of this.modeGoals) {
			// ADR-0016: 生活事项的惰性补写走 ensureChoreTracking（该做日 + 逾期挂账），不日日出行
			if (goal.mode === "chore") continue;
			const start = goal.start || period.start;
			const end = goal.end || period.end;
			if (this.today < start || this.today > end) continue;
			const unit = goal.unit || (goal.mode === "review" ? "篇" : "");
			const spec: ModeLineSpec = { plan, name: goal.name, label: label ?? "", floor: goal.floor ?? 0, unit };
			specs.push(spec);
			autos.push({ spec, mode: goal.mode!, floor: goal.floor ?? 0 });
		}
		if (specs.length === 0) return;
		const file = this.getTodayFile();
		if (!file) return;
		const bzg = this.bzgSnapshot;
		// 日记「写了没」是异步读——进程回调必须同步，先取好布尔量
		let diaryWrittenToday = false;
		if (bzg) {
			const diaryText = await readBzgDiaryText(this.app, bzg, this.today);
			diaryWrittenToday = diaryDayWritten(diaryText);
		}
		const today = this.today;
		this.selfWrite = true;
		try {
			await this.app.vault.process(file, (data) => {
				let out = missingModeLines(data, specs, today).reduce((acc, line) => appendCheckItem(acc, line), data);
				type Op = (acc: string) => string;
				const ops: Op[] = [];
				const lines = out.split("\n");
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
					const text = m[2].trim();
					const op = autos.find((a) => m[3] === a.spec.plan && matchesModeLine(text, a.spec.name, a.spec.floor, a.spec.unit));
					if (!op) continue;
					const checkedNow = m[1] === "x";
					// ADR-0011 事实优先：✋ 不再豁免模式行；每行至多一个写回操作（防 expectedRaw 定位互踩）
					let pushed = false;
					if (op.mode === "review" && bzg) {
						const count = reviewedOn(bzg, today);
						const cur = parseQuotaActual(text);
						const shouldCheck = count >= op.floor;
						if (cur !== count) {
							const raw = line;
							const idx = i;
							ops.push((acc) => setQuotaActual(acc, idx, count, op.spec.unit, shouldCheck, raw));
							pushed = true;
						} else {
							if (shouldCheck && !checkedNow) {
								const raw = line;
								const idx = i;
								ops.push((acc) => toggleTaskLine(acc, idx, true, raw));
								pushed = true;
							}
						}
					} else if (op.mode === "diary" && diaryWrittenToday && !checkedNow) {
						const raw = line;
						const idx = i;
						ops.push((acc) => toggleTaskLine(acc, idx, true, raw));
						pushed = true;
					}
					if (!pushed && line.includes(MANUAL_MARK)) {
						const raw = line;
						const idx = i;
						ops.push((acc) => clearManualMark(acc, idx, raw));
					}
				}
				// ADR-0006/0013: 「勾满模式子行/清空任务池待办 → 父行自动勾」已上移到
				// ensureParentRollup（刷新链在模式回填之后统一对账，全计划同一把尺）。
				return ops.reduce((acc, fn) => fn(acc), out);
			});
		} finally {
			this.selfWrite = false;
		}
	}

	/**
	 * ADR-0013: 刷新期父行对账——把「待办清空 → 勾父」（ADR-0003/0008）从今日打卡的
	 * 两条交互路径推广到一切勾选来源（阅读联动自动勾、周/月/年卡勾任务、外部编辑）。
	 * 挂在今日刷新链上（所有来源都经 refreshToday 收敛），在模式回填
	 * （ensureModeGoalTracking）之后跑：文件里模式子行已是事实态，父行判定全依文件 +
	 * 任务池快照。单向镜像：手动取消父行不落豁免，事实未变时刷新即重勾；要长期免勾
	 * 可在父行手加 ✋（本对账沿用的豁免记号）。幂等：已勾/✋/非活窗口计划一律跳过。
	 */
	private async ensureParentRollup(): Promise<void> {
		const file = this.getTodayFile();
		if (!file) return;
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const period = (await readPlanPeriod(this.app, root, year)) ?? { start: `${year}-01-01`, end: `${year}-12-31` };
		const today = this.today;
		// 活窗口守卫：任一目标今日在窗内才参与对账（与模式回填的窗口口径一致）；
		// 纯打卡行/定额行无目标 → 恒不自动勾，窗口已过的计划也不再日日白勾。
		// ADR-0015: 复盘行例外——它的完成事实 = 今天日记「# 当日复盘」小节非空
		//（文件事实：写复盘弹窗写入、直接在日记手写都算），factDone 直通勾父行。
		let reviewFactDone = false;
		const diaryDir = this.plugin.settings.diaryDir.replace(/\/+$/, "").trim();
		if (diaryDir) {
			const df = this.app.vault.getAbstractFileByPath(`${diaryDir}/${today}.md`);
			if (df instanceof TFile) {
				const body = extractReviewSection(await this.app.vault.cachedRead(df));
				reviewFactDone = body !== null && body.trim() !== "";
			}
		}
		const facts: ParentRollupFact[] = this.planProgress.map((p) => ({
			plan: p.plan,
			// ADR-0016: 生活计划父行不进对账——生活事项无事实镜像（Q5a），手动取消父行是终态，
			// 勾满事项自动勾父走 toggleCheckItem 交互级联（ADR-0003/0006 同款）
			live: !hasChoreGoal(p) && p.goals.some((g) => (g.start || period.start) <= today && today <= (g.end || period.end)),
			pendingEmpty: this.pendingPoolChildren(p.plan).length === 0,
			...(p.plan === "复盘" ? { factDone: reviewFactDone } : {}),
		}));
		const isModeLineText = (plan: string, text: string): boolean =>
			this.modeGoals.some((mg) => mg.plan === plan && matchesModeLine(text, mg.goal.name, mg.goal.floor ?? 0, mg.goal.unit || ""));
		// 常态无账可对：先用缓存读预检，避免无谓写文件；写回前在进程回调内对最新内容重扫（防竞态错位）。
		const pre = parentCheckTargets(await this.app.vault.cachedRead(file), facts, isModeLineText);
		if (pre.length === 0) return;
		this.selfWrite = true;
		try {
			await this.app.vault.process(file, (data) => {
				const targets = parentCheckTargets(data, facts, isModeLineText);
				return targets.reduce((acc, t) => toggleTaskLine(acc, t.line, true, t.raw), data);
			});
		} finally {
			this.selfWrite = false;
		}
	}

	/** ADR-0016: 该计划是否生活计划（含生活事项目标）。 */
	private isChorePlan(plan: string | null): boolean {
		if (!plan) return false;
		return this.planProgress.some((p) => p.plan === plan && hasChoreGoal(p));
	}

	/**
	 * ADR-0016: 一次扫描今日打卡区该计划的行型（父行 / 事项行 / 未勾事项行的行号）。
	 * 父行 = 不匹配任何事项名的打卡行；事项行 = matchesModeLine 精确匹配。
	 */
	private choreLineShapes(
		content: string,
		plan: string,
		itemNames: string[]
	): { hasParent: boolean; hasItem: boolean; uncheckedItemLines: { line: number; raw: string }[] } {
		let hasParent = false;
		let hasItem = false;
		const uncheckedItemLines: { line: number; raw: string }[] = [];
		let inCheck = false;
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/^##\s/.test(line)) {
				inCheck = line.startsWith(CHECK_HEADING);
				continue;
			}
			if (!inCheck) continue;
			const m = TASK_LINE_RE.exec(line);
			if (!m || m[3] !== plan) continue;
			const isItem = itemNames.some((n) => matchesModeLine(m[2].trim(), n, 0, ""));
			if (isItem) {
				hasItem = true;
				if (m[1] !== "x") uncheckedItemLines.push({ line: i, raw: line });
			} else {
				hasParent = true;
			}
		}
		return { hasParent, hasItem, uncheckedItemLines };
	}

	/**
	 * ADR-0016: 生活事项今日行惰性补写（该做日 + 逾期挂账）+ 父行自愈 + 陈旧挂账清除。
	 * - 该做日：isChoreDueOn(cycle, today) → 出行
	 * - 逾期挂账：overdue=postpone 且最近一个该做日至今（不含今天）回扫无已勾行 → 出行；
	 *   挂账事实记入 choreDebtMap（渲染逾期徽标用——该做日恰逢旧挂账、每天周期也能亮标）。
	 *   勾一次清全部挂账（回扫命中即视为已清）。
	 * - 陈旧挂账：非 postpone 事项在非该做日仍留有未勾行（策略刚从往后延改回放弃）→ 移除
	 *   （共识：策略改放弃时当前挂账立即消失；仅删今日未勾行，已勾记录与历史文件不动）。
	 * - 父行：今日有事项行（现存的或本次要补的）而父行缺失时补写（父行 = 大项口径顶层行）；
	 *   空日（无该做、无挂账）整计划不出行——不进今日进度分母、不断连击。
	 * 幂等：只在今日文件补缺失行/删陈旧未勾行，绝不回写历史（与 quota/模式行同铁律）。
	 */
	private async ensureChoreTracking(): Promise<void> {
		const chorePlans = this.planProgress.filter((p) => hasChoreGoal(p));
		if (chorePlans.length === 0) return;
		const file = this.getTodayFile();
		if (!file) return;
		const today = this.today;
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const prefix = `${root}/${yearDirName(today.slice(0, 4))}/每日/`;
		const yesterday = formatDate(addDays(parseDateString(today), -1));
		// 今日应出行的事项（该做 or 挂账）+ 挂账事实（徽标判定）
		const dueSpecs = new Map<string, { names: string[]; label: string; specs: ChoreLineSpec[] }>();
		const staleSpecs = new Map<string, { names: string[]; label: string; specs: ChoreLineSpec[] }>();
		this.choreDebtMap = new Map();
		for (const p of chorePlans) {
			for (const g of p.goals) {
				if (g.mode !== "chore") continue;
				const cycle: GoalCycle = g.cycle ?? { unit: "day", days: [] };
				if (isChoreDueOn(cycle, today)) {
					if (g.overdue === "postpone") {
						// 该做日也可能带着旧挂账（上期漏了今天该做）——徽标照实亮
						const lastDue = prevChoreOccurrence(cycle, yesterday);
						const debt = !(await scanChoreHit(this.app, prefix, p.plan, g.name, lastDue, yesterday, true));
						if (debt) this.choreDebtMap.set(`${p.plan}|${g.name}`, true);
					}
					this.addChoreSpec(dueSpecs, p.plan, p.label, g.name);
					continue;
				}
				if (g.overdue !== "postpone") continue;
				const lastDue = prevChoreOccurrence(cycle, yesterday);
				if (await scanChoreHit(this.app, prefix, p.plan, g.name, lastDue, yesterday, true)) continue;
				this.choreDebtMap.set(`${p.plan}|${g.name}`, true);
				this.addChoreSpec(dueSpecs, p.plan, p.label, g.name);
			}
		}
		const content = await this.app.vault.cachedRead(file);
		// 陈旧挂账行（非 postpone 且今天不该做）→ 待删
		for (const p of chorePlans) {
			for (const g of p.goals) {
				if (g.mode !== "chore" || g.overdue === "postpone") continue;
				const cycle: GoalCycle = g.cycle ?? { unit: "day", days: [] };
				if (isChoreDueOn(cycle, today)) continue;
				this.addChoreSpec(staleSpecs, p.plan, p.label, g.name);
			}
		}
		// 预检：要补的行（缺失事项 + 缺父行）或要删的陈旧行，有一才写
		let needsWrite = staleSpecs.size > 0;
		for (const [plan, info] of dueSpecs) {
			const missing = missingChoreLines(content, info.specs, today);
			const { hasParent, hasItem } = this.choreLineShapes(content, plan, info.names);
			if (missing.length > 0 || (hasItem && !hasParent)) needsWrite = true;
		}
		if (!needsWrite) return;
		this.selfWrite = true;
		try {
			await this.app.vault.process(file, (data) => {
				let out = data;
				// 先补/删，行号重算一次完成：删除按 expectedRaw 定位（行漂移安全）
				for (const [, info] of staleSpecs) {
					const { uncheckedItemLines } = this.choreLineShapes(out, info.specs[0].plan, info.names);
					for (const stale of info.specs) {
						const hit = uncheckedItemLines.find((l) => matchesModeLine(TASK_LINE_RE.exec(l.raw)?.[2]?.trim() ?? "", stale.name, 0, ""));
						if (hit) out = removeLine(out, hit.line, hit.raw);
					}
				}
				for (const [plan, info] of dueSpecs) {
					if (!this.choreLineShapes(out, plan, info.names).hasParent) {
						// 父行先于事项行（文件序 = 展示序：父行在上、事项折叠其下）
						const parentLine = buildCheckLine({
							name: composeCheckItemName(info.label, plan),
							duration: "",
							plan,
							includeReview: false,
							date: today,
						});
						out = appendCheckItem(out, parentLine);
					}
					const missing = missingChoreLines(out, info.specs, today);
					out = missing.reduce((acc, line) => appendCheckItem(acc, line), out);
				}
				return out;
			});
		} finally {
			this.selfWrite = false;
		}
	}

	/** ADR-0016: 按计划聚合今日应出行/待删的事项规格（Map upsert）。 */
	private addChoreSpec(
		map: Map<string, { names: string[]; label: string; specs: ChoreLineSpec[] }>,
		plan: string,
		label: string,
		name: string
	): void {
		const cur = map.get(plan) ?? { names: [], label: label ?? "", specs: [] };
		cur.names.push(name);
		cur.specs.push({ plan, name });
		if (label) cur.label = label;
		map.set(plan, cur);
	}

	private async refreshToday(): Promise<void> {
		await this.buildHomeData();
		// 份额清空提醒：须先于任何音效位（任务卡徽章/今日徽章的成就音在本轮可能升档）
		this.detectShareClears();
		await this.updateStreak();
		this.updateHomeDate();

		if (this.currentPanel !== "today") {
			this.panelEl?.empty();
			this.buildTodaySkeleton();
			this.currentPanel = "today";
		}

		// Home-page cards always render (independent of the daily note).
		this.updateYearGoals();
		this.updateMonthTaskCard();
		this.updateWeekTaskCard();

		// ADR-0001: 打开今日视图时幂等补写缺失的 quota 行（在读文件前执行）
		await this.ensureQuotaCheckItemsForToday();
		// ADR-0006: 模式目标（复习/日记/运动）行惰性补写 + BZG 自动写实量/自动勾选
		await this.ensureModeGoalTracking();
		// ADR-0016: 生活事项该做日/逾期挂账行惰性补写 + 父行自愈（空日整计划不出现）
		await this.ensureChoreTracking();
		// ADR-0013: 父行对账（待办清空 → 勾父，一切勾选来源统一收敛；须在模式回填后跑）
		await this.ensureParentRollup();

		const file = this.getTodayFile();
		if (!file) {
			this.setDailyCardsVisible(false);
			this.renderTodayDailyMissing();
			return;
		}
		this.setDailyCardsVisible(true);
		// Remove a stale "missing note" card left from an earlier refresh.
		this.panelEl?.querySelectorAll(".planboard-missing-card").forEach((el) => el.remove());
		const content = await this.app.vault.cachedRead(file);
		this.dailyData = parseDailyContent(file, content, this.today);
		this.updateProgress();
		this.updateChecklist();
		this.updateSummary();
		// ADR-0014: 侧读昨日日记「# 次日计划」到总结卡只读块
		void this.updateYesterdayPlan();
		// ADR-0004 扩展: 今日打卡计划项全量镜像到日记「## 完成情况跟踪」（含未勾选）
		void this.syncTrackingToDiary();
	}

	/**
	 * ADR-0004 扩展: 把今日打卡的全部计划项（plan 行，不含临时任务）镜像到当天日记
	 * 「## 完成情况跟踪」小节——确保存在 + 勾选态实时同步；缺小节/缺日记文件静默跳过。
	 */
	private async syncTrackingToDiary(): Promise<void> {
		if (!this.dailyData) return;
		const items: TrackingItem[] = this.dailyData.checkItems
			.filter((it) => it.plan !== null)
			.map((it) => ({ title: it.text, checked: it.checked }));
		await syncPlanTrackingToDiary(this.app, this.plugin.settings.diaryDir, items);
	}

	private buildTodaySkeleton(): void {
		if (!this.panelEl) return;
		const panel = this.panelEl;

		// v1.0.3: 本月/本周卡改为纯展示 + 目标追踪（进度条/任务列表），新建统一在年度视图——
		// 原 4 个「+ 新建」按钮（header 与空态各一）已移除。
		// 注意：monthEnd/weekStart/weekEnd 仅被这些按钮使用，随之删除。

		// --- 1. 年度目标卡 (compact one-line strip, per-plan mini bars) ---
		const goalCard = panel.createDiv({ cls: "planboard-card planboard-goal-card" });
		const goalHeader = goalCard.createDiv({ cls: "planboard-card-header planboard-goal-header" });
		goalHeader.createDiv({ cls: "planboard-card-title", text: "🎯 年度目标" });
		// v1.5: 日期+问候并入年度标题行（左侧标题，右侧日期，省一行）
		const dateWrap = goalHeader.createDiv({ cls: "planboard-home-date" });
		this.homeDateMainEl = dateWrap.createSpan({ cls: "planboard-home-date-main" });
		this.homeDateSubEl = dateWrap.createSpan({ cls: "planboard-home-date-sub" });
		this.goalListEl = goalCard.createDiv({ cls: "planboard-goal-strip" });
		this.goalEmptyEl = goalCard.createDiv({ cls: "planboard-empty", text: "年度计划未配置，请在「年度计划.md」frontmatter 定义 plans。" });

		// --- 2. 月/周任务卡 (grid, two columns) ---
		const taskGrid = panel.createDiv({ cls: "planboard-grid-2" });

		const monthCard = taskGrid.createDiv({ cls: "planboard-card planboard-month-task-card" });
		const monthHeader = monthCard.createDiv({ cls: "planboard-card-header" });
		monthHeader.createDiv({ cls: "planboard-card-title", text: "🗓️ 本月任务" });
		// v1.4: 任务数 + 徽章内联到标题行（省纵向空间）
		const monthNumWrap = monthHeader.createDiv({ cls: "planboard-task-number planboard-task-number--inline" });
		this.monthTaskNumberEl = monthNumWrap.createSpan();
		this.monthTaskBadgeEl = monthNumWrap.createSpan({ cls: "planboard-badge planboard-hidden" });
		const monthBar = monthCard.createDiv({ cls: "planboard-progress-bar planboard-progress-bar--thin" });
		this.monthTaskFillEl = monthBar.createDiv({ cls: "planboard-progress-fill" });
		this.monthPreviewEl = monthCard.createEl("ul", { cls: "planboard-checklist planboard-home-preview" });
		if (this.plugin.settings.monthCardHeight > 0) this.monthPreviewEl.style.height = `${this.plugin.settings.monthCardHeight}px`;
		attachResizeHandle(monthCard, this.monthPreviewEl, this.plugin, "monthCardHeight", {
			target: () => this.weekPreviewEl,
			key: "weekCardHeight",
		});
		this.monthPreviewEmptyEl = monthCard.createDiv({ cls: "planboard-empty planboard-empty-cta" });
		this.monthPreviewEmptyEl.createSpan({ text: "本月暂无任务" });

		const weekCard = taskGrid.createDiv({ cls: "planboard-card planboard-week-task-card" });
		const weekHeader = weekCard.createDiv({ cls: "planboard-card-header" });
		weekHeader.createDiv({ cls: "planboard-card-title", text: "📋 本周任务" });
		const weekNumWrap = weekHeader.createDiv({ cls: "planboard-task-number planboard-task-number--inline" });
		this.weekTaskNumberEl = weekNumWrap.createSpan();
		this.weekTaskBadgeEl = weekNumWrap.createSpan({ cls: "planboard-badge planboard-hidden" });
		const weekBar = weekCard.createDiv({ cls: "planboard-progress-bar planboard-progress-bar--thin" });
		this.weekTaskFillEl = weekBar.createDiv({ cls: "planboard-progress-fill" });
		this.weekPreviewEl = weekCard.createEl("ul", { cls: "planboard-checklist planboard-home-preview" });
		if (this.plugin.settings.weekCardHeight > 0) this.weekPreviewEl.style.height = `${this.plugin.settings.weekCardHeight}px`;
		attachResizeHandle(weekCard, this.weekPreviewEl, this.plugin, "weekCardHeight", {
			target: () => this.monthPreviewEl,
			key: "monthCardHeight",
		});
		this.weekPreviewEmptyEl = weekCard.createDiv({ cls: "planboard-empty planboard-empty-cta" });
		this.weekPreviewEmptyEl.createSpan({ text: "本周暂无任务" });

		// --- 3. 今日打卡 + 今日总结 (grid, equal columns) ---
		const dailyGrid = panel.createDiv({ cls: "planboard-grid-2 planboard-daily-only" });

		const checkCard = dailyGrid.createDiv({ cls: "planboard-card planboard-check-card" });
		const checkHeader = checkCard.createDiv({ cls: "planboard-card-header" });
		const checkTitle = checkHeader.createDiv({ cls: "planboard-card-title planboard-check-title" });
		checkTitle.createSpan({ text: "✅ 今日打卡" });
		// v1.4: 进度数字内联到标题行（与月/周卡一致，省纵向空间）
		this.progressNumberEl = checkHeader.createSpan({ cls: "planboard-progress-number planboard-progress-number--inline" });
		this.streakEl = checkTitle.createSpan({ cls: "planboard-streak planboard-hidden" });
		// 今日打卡分档徽章（即时显示，不结算进徽章墙）
		this.todayBadgeEl = checkTitle.createSpan({ cls: "planboard-badge planboard-today-badge planboard-hidden" });
		const addBtn = checkHeader.createEl("button", { cls: "planboard-btn planboard-btn-outline planboard-add-btn", text: "+ 添加" });
		addBtn.addEventListener("click", () => this.openAddItemModal());
		const bar = checkCard.createDiv({ cls: "planboard-progress-bar" });
		this.progressFillEl = bar.createDiv({ cls: "planboard-progress-fill" });
		this.checklistEl = checkCard.createEl("ul", { cls: "planboard-checklist" });
		// v1.4: 打卡卡也可拖底部调高（内容 flex 填充），与总结卡联动同步
		if (this.plugin.settings.checkCardHeight > 0) checkCard.style.height = `${this.plugin.settings.checkCardHeight}px`;
		attachResizeHandle(checkCard, checkCard, this.plugin, "checkCardHeight", {
			target: () => this.summaryEl?.closest(".planboard-summary-card") ?? null,
			key: "summaryCardHeight",
		});

		const summaryCard = dailyGrid.createDiv({ cls: "planboard-card planboard-summary-card" });
		// v1.7.4: 标题包进 header（与打卡卡同构——两卡 header 等高 38px + center，标题/按钮同一中心线）
		const summaryHeader = summaryCard.createDiv({ cls: "planboard-card-header" });
		summaryHeader.createDiv({ cls: "planboard-card-title", text: "📝 今日总结" });
		// v1.4: 打卡自动生成区（完成/未完成/鼓励语，只读展示，不写文件）
		this.summaryAutoEl = summaryCard.createDiv({ cls: "planboard-summary-auto" });
		// ADR-0014: 「昨日留的计划」只读块——实时侧读昨日日记「# 次日计划」（无文件/无小节整块隐藏）
		this.yesterdayPlanEl = summaryCard.createDiv({ cls: "planboard-yesterday-plan planboard-hidden" });
		this.summaryEl = summaryCard.createEl("textarea", {
			cls: "planboard-summary-input",
			attr: { placeholder: "今天完成了什么？写点什么吧…" },
		});
		this.summaryEl.addEventListener("focus", () => {
			this.summaryFocused = true;
		});
		this.summaryEl.addEventListener("blur", () => {
			this.summaryFocused = false;
			void this.saveSummary();
		});
		// v1.4: 复盘入口移到总结区底部（不占 header）
		// v1.7.5: 底部按钮排——并排 flex 行（ADR-0014 起三枚：「写入备注」「写复盘」「次日计划」，各占三分之一）
		const summaryActions = summaryCard.createDiv({ cls: "planboard-summary-actions" });
		const writeBtn = summaryActions.createEl("button", { cls: "planboard-btn planboard-btn-outline planboard-review-btn", text: "📥 写入备注" });
		writeBtn.addEventListener("click", () => void this.writeSummaryToDiary());
		const reviewBtn = summaryActions.createEl("button", { cls: "planboard-btn planboard-btn-outline planboard-review-btn planboard-review-bottom", text: "📝 写复盘 →" });
		reviewBtn.addEventListener("click", () => this.openReviewModal());
		const nextDayBtn = summaryActions.createEl("button", { cls: "planboard-btn planboard-btn-outline planboard-review-btn planboard-review-bottom", text: "📆 次日计划" });
		nextDayBtn.addEventListener("click", () => void this.openNextDayPlanModal(this.today));
		// v1.4: 总结卡也可拖底部调高（textarea flex 填充），与打卡卡联动同步
		if (this.plugin.settings.summaryCardHeight > 0) summaryCard.style.height = `${this.plugin.settings.summaryCardHeight}px`;
		attachResizeHandle(summaryCard, summaryCard, this.plugin, "summaryCardHeight", {
			target: () => this.checklistEl?.closest(".planboard-check-card") ?? null,
			key: "checkCardHeight",
		});
		// 骨架重建后刷新日期行（refreshToday 的调用可能早于重建）
		this.updateHomeDate();
	}

	private setDailyCardsVisible(visible: boolean): void {
		this.panelEl?.querySelectorAll(".planboard-daily-only").forEach((el) => {
			(el as HTMLElement).toggleClass("planboard-hidden", !visible);
		});
	}

	// --- Home page cards -----------------------------------------------------

	private updateYearGoals(): void {
		if (!this.goalListEl || !this.goalEmptyEl) return;
		this.goalListEl.empty();
		this.goalEmptyEl.hidden = this.planProgress.length > 0;
		for (const prog of this.planProgress) {
			this.goalListEl.appendChild(this.renderGoalRow(prog));
		}
	}

	private renderGoalRow(prog: PlanProgress): HTMLElement {
		// v1.4 紧凑条：每计划 = 图标+名 + 数字 + 迷你进度条，一行内一目了然（无展开交互）
		const item = createDiv({ cls: "planboard-goal-strip-item" });
		item.createSpan({
			cls: "planboard-goal-name",
			// label 含名称时不重复拼接（"✍️ 写作"），纯 emoji/空时补上计划名
			text: prog.label && !prog.label.includes(prog.plan) ? `${prog.label} ${prog.plan}` : prog.label || prog.plan,
		});

		let number: string;
		let title = prog.target || prog.plan;
		if (prog.isQuota && prog.quota) {
			// ADR-0001: 累计实际量 / 总量
			const q = prog.quota;
			number = `${formatQuotaAmount(q.actual)}/${formatQuotaAmount(q.total)}${q.unit ? ` ${q.unit}` : ""}`;
			title = `${prog.plan}：累计 ${formatQuotaAmount(q.actual)}/${formatQuotaAmount(q.total)}${q.unit} · 今日配额 ${formatQuotaAmount(q.dailyQuota)}${q.unit}${q.behind ? " · 进度落后" : ""}`;
		} else if (prog.isNumeric && prog.goals.length > 0) {
			// 多 goal：显示合计 done/target（如 3/22），子目标 hover 可见
			number = `${prog.doneCount}/${prog.targetCount}`;
		} else if (prog.isNumeric) {
			const unit = planCounterUnit(prog.target);
			number = `${prog.doneCount}/${prog.targetCount}${unit ? ` ${unit}` : ""}`;
		} else {
			number = `${prog.percent}%`;
		}
		item.setAttribute("title", title);
		item.createSpan({ cls: "planboard-goal-number", text: number });

		const bar = item.createDiv({ cls: "planboard-progress-bar planboard-progress-bar--mini" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${prog.percent}%`;
		setTier(fill, prog.percent);
		if (prog.isQuota && prog.quota?.behind) fill.addClass("planboard-quota-behind-fill");
		return item;
	}

	private updateMonthTaskCard(): void {
		const { total, done, percent } = summarize(this.monthTasks);
		this.monthTaskNumberEl?.setText(total === 0 ? "0/0" : `${done}/${total}`);
		this.updateTaskBadge(this.monthTaskBadgeEl, done, total);
		if (this.monthTaskFillEl) {
			this.monthTaskFillEl.style.width = `${percent}%`;
			setTier(this.monthTaskFillEl, percent);
		}

		if (!this.monthPreviewEl || !this.monthPreviewEmptyEl) return;
		this.monthPreviewEl.empty();
		this.monthPreviewEmptyEl.hidden = this.monthTasks.length > 0;
		// v1.4: 全量列出当期任务（卡片内滚动）
		for (const t of this.monthTasks) {
			this.monthPreviewEl.appendChild(this.renderTaskItem(t));
		}
	}

	private updateWeekTaskCard(): void {
		const { total, done, percent } = summarize(this.weekTasks);
		this.weekTaskNumberEl?.setText(total === 0 ? "0/0" : `${done}/${total}`);
		this.updateTaskBadge(this.weekTaskBadgeEl, done, total);
		if (this.weekTaskFillEl) {
			this.weekTaskFillEl.style.width = `${percent}%`;
			setTier(this.weekTaskFillEl, percent);
		}

		if (!this.weekPreviewEl || !this.weekPreviewEmptyEl) return;
		this.weekPreviewEl.empty();
		this.weekPreviewEmptyEl.hidden = this.weekTasks.length > 0;
		// v1.4: 全量列出当期任务（卡片内滚动）
		for (const t of this.weekTasks) {
			this.weekPreviewEl.appendChild(this.renderTaskItem(t));
		}
	}

	/** v1.6: 计划在 settings.planOrder 中的位置（未收录 = 末尾，保持原相对顺序）。 */
	private orderIndexOf(plan: string): number {
		const i = this.plugin.settings.planOrder.indexOf(plan);
		return i === -1 ? Number.MAX_SAFE_INTEGER : i;
	}

	/** v1.6: 给计划卡挂拖拽排序（grip 在卡头最左）。 */
	private attachPlanSortTo(card: HTMLElement, container: HTMLElement, plan: string, cols?: HTMLElement[]): void {
		attachPlanSort(card, container, this.plugin, plan, cols);
	}

	/** 🔥 连续打卡天数：从昨天往前数，每天全部大项完成才计一天（ADR-0012 大项口径）。 */
	private async updateStreak(): Promise<void> {
		if (!this.streakEl) return;
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const streak = await computeStreak(this.app, root, year, this.today, (it) => this.modeLineMatch(it) !== null);
		if (streak > 0) {
			this.streakEl.setText(`🔥 连续打卡 ${streak} 天`);
			this.streakEl.removeClass("planboard-hidden");
		} else {
			this.streakEl.setText("");
			this.streakEl.addClass("planboard-hidden");
		}
	}

	/** v1.4: 顶部日期 + 时段问候（时间锚点）。 */
	private updateHomeDate(): void {
		if (!this.homeDateMainEl) return;
		const [y, m, d] = this.today.split("-").map(Number);
		const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
		const wd = weekdays[new Date(y, m - 1, d).getDay()];
		this.homeDateMainEl.setText(`${m}月${d}日 周${wd}`);
		if (!this.homeDateSubEl) return;
		const h = new Date().getHours();
		let greet: string;
		if (h < 6) greet = "夜深了，早点休息 🌙";
		else if (h < 9) greet = "早上好，开始今天的打卡吧 ☀️";
		else if (h < 12) greet = "上午好，保持节奏 📈";
		else if (h < 14) greet = "中午好，别忘了今日打卡 🍚";
		else if (h < 18) greet = "下午好，继续加油 💪";
		else if (h < 22) greet = "晚上好，今天打卡了吗 ✨";
		else greet = "夜深了，收尾今天的打卡吧 🌙";
		this.homeDateSubEl.setText(greet);
	}

	/** 任务卡进度数字旁的完成率徽章（≥60 铜 / ≥80 银 / 100 金）。 */
	private updateTaskBadge(el: HTMLElement | null, done: number, total: number): void {
		if (!el) return;
		el.removeClass("is-gold", "is-silver", "is-bronze", "planboard-hidden");
		const tier = tierFor(done, total);
		const prev = el.dataset.tier ?? "";
		if (tier) {
			setBadgeContent(el, tier.emoji, tier.qualifier);
			el.addClass(tier.cls);
			// v1.4: 档位变化 → 弹出动画 + 音效（与今日打卡徽章一致）；
			// 首次渲染（prev 为空）不播音效，避免打开视图时响
			if (tier.cls !== prev && prev !== "") {
				el.addClass("planboard-badge-pop");
				window.setTimeout(() => el.removeClass("planboard-badge-pop"), 700);
				// 份额清空音本轮已播则让位（同刷新只播一个音，防双音叠糊；下轮成就音照常）
				if (this.plugin.settings.achievementSound && !this.shareChimeThisCycle) playAchievementSound();
			}
			const pct = total === 0 ? 0 : Math.round((done / total) * 100);
			el.setAttribute("title", `完成率 ${pct}%（${total > 0 ? `${done}/${total}` : "暂无任务"}），达成${tier.qualifier}`);
		} else {
			el.setText("");
			el.addClass("planboard-hidden");
		}
		el.dataset.tier = tier?.cls ?? "";
	}

	// --- Daily check-in (M1, preserved) -------------------------------------

	private lastTierKey = "";
	/** 今日徽章是否已初始化（首次渲染不播音效，v1.4）。 */
	private badgeInitialized = false;
	/** 份额清空提醒：上一轮各书「今日份额已清空」快照（键 = 计划名||书名）；null = 首轮基线（不提醒）。 */
	private shareClearSnapshot: Map<string, boolean> | null = null;
	/** 本轮刷新是否播了份额清空音——true 则成就音本轮让位一次（同刷新只播一个音）。 */
	private shareChimeThisCycle = false;

	private updateProgress(): void {
		// ADR-0012 大项口径：顶层计划行计数，模式子行折叠进父行（与渲染嵌套同一把尺）
		const rows = topLevelCheckRows(this.dailyData?.checkItems ?? [], (it) => this.modeLineMatch(it) !== null);
		const done = rows.filter((r) => r.done).length;
		const total = rows.length;
		const pct = total === 0 ? 0 : Math.round((done / total) * 100);
		this.progressNumberEl?.setText(total === 0 ? "0/0" : `${done}/${total}`);
		// Dynamic width is the only in-DOM value; the 200ms animation comes from CSS.
		if (this.progressFillEl) {
			this.progressFillEl.style.width = `${pct}%`;
			setTier(this.progressFillEl, pct);
		}
		// 今日分档徽章（即时反馈；周结算时并入徽章墙）
		if (this.todayBadgeEl) {
			const tier = tierFor(done, total);
			const tierKey = tier ? tier.cls : "";
			if (tier) {
				this.todayBadgeEl.removeClass("is-gold", "is-silver", "is-bronze");
				setBadgeContent(this.todayBadgeEl, tier.emoji, tier.qualifier);
				this.todayBadgeEl.addClass(tier.cls);
				this.todayBadgeEl.removeClass("planboard-hidden");
				// 达成（升档）时刻：弹出动画 + 叮声（首次渲染不播）
				if (tierKey !== this.lastTierKey && this.badgeInitialized) {
					this.todayBadgeEl.removeClass("planboard-badge-pop");
					// 强制重排以重触发动画
					void this.todayBadgeEl.offsetWidth;
					this.todayBadgeEl.addClass("planboard-badge-pop");
					window.setTimeout(() => this.todayBadgeEl?.removeClass("planboard-badge-pop"), 800);
					// 份额清空音本轮已播则让位（同刷新只播一个音，防双音叠糊；下轮成就音照常）
				if (this.plugin.settings.achievementSound && !this.shareChimeThisCycle) playAchievementSound();
				}
				this.badgeInitialized = true;
				this.todayBadgeEl.setAttribute("title", `今日完成率 ${pct}%，达成${tier.qualifier}`);
			} else {
				this.todayBadgeEl.removeClass("is-gold", "is-silver", "is-bronze");
				this.todayBadgeEl.addClass("planboard-hidden");
			}
			this.lastTierKey = tierKey;
		}
	}

	/**
	 * 份额清空提醒（CONTEXT.md 术语）：每轮刷新对「今日有安排的书」做清空态快照对比，
	 * false → true 跃迁即提醒（提示音 + Notice，同批多书合并一条）。挂在数据读取后、
	 * 任何音效位之前——成就音据此让位一轮；首轮基线不提醒。四条勾选路径（手动勾、
	 * 推进自动勾、联动回写、书行连带）统一经刷新收敛到此处检测，不在勾选侧各埋钩子。
	 */
	private detectShareClears(): void {
		this.shareChimeThisCycle = false;
		const entries: ShareClearEntry[] = [];
		for (const p of this.planProgress) {
			for (const g of this.computeBookView(p.plan).scheduled) {
				entries.push({ key: `${p.plan}||${g.name}`, name: g.name, cleared: g.pending.length === 0 });
			}
		}
		const { next, cleared } = diffShareClear(this.shareClearSnapshot, entries);
		this.shareClearSnapshot = next;
		if (cleared.length === 0) return;
		this.shareChimeThisCycle = true;
		if (!this.plugin.settings.shareChime) return;
		playShareClearSound();
		const copy = cleared.length === 1
			? `📖《${cleared[0]}》今日阅读计划已完成 ✅`
			: `📖 ${cleared.length} 本书的今日计划已完成：${cleared.map((n) => `《${n}》`).join("")}`;
		new Notice(copy, 4000);
	}

	private updateChecklist(): void {
		if (!this.dailyData || !this.checklistEl) return;
		this.checklistEl.empty();
		// ADR-0006: 模式行嵌套——同计划有父打卡项（非模式行）时，模式行渲染为其子项；
		// 无父行（计划 daily=false / 默认行被删）时保持顶层原样。
		// ADR-0012: 嵌套规则收敛到 topLevelCheckRows（与进度计数同一实现，防两把尺漂移）。
		for (const row of topLevelCheckRows(this.dailyData.checkItems, (it) => this.modeLineMatch(it) !== null)) {
			this.checklistEl.appendChild(this.renderCheckItem(row.item, row.modeChildren));
		}
	}

	/**
	 * ADR-0003: 某计划「该做还没做」的任务池任务 = 今日打卡的子任务。
	 * 口径：未勾选，且已开始（🛫 ≤ 今天；无 🛫 用 📅 兜底）——过期未完成的任务
	 * 自然留在列表里（🛫 早已 ≤ 今天），即「当天没完成自动顺延到第二天」，不改日期。
	 * 无日期任务不进子列表（与 filterTasksInRange 的口径一致）。
	 */
	private pendingPoolChildren(plan: string): PoolTask[] {
		return this.allPoolTasks.filter((t) => t.plan === plan && this.isPendingPoolChild(t));
	}

	/** ADR-0003: 「该做还没做」判定（未勾选且已开始），扁平列表与 ADR-0008 书组共用。 */
	private isPendingPoolChild(t: PoolTask): boolean {
		if (t.checked) return false;
		const effStart = t.start ?? t.due;
		return !!effStart && effStart <= this.today;
	}

	/**
	 * ADR-0008: 某计划今日级联的书组视图（分组渲染与父行「N/M 本」分数共用一次计算）。
	 * scheduled = 今日有安排的书（今日书进度分母）；组内 pending 清空 = 今日份额完成（分子）。
	 * 识别不到目标名的待办（ungroupedPending）平铺在子列表顶部。
	 */
	private computeBookView(plan: string): { scheduled: BookGroup[]; ungroupedPending: PoolTask[] } {
		const planTasks = this.allPoolTasks.filter((t) => t.plan === plan);
		// ADR-0009: 已知书名前缀优先（真实标题无编号后缀的叶也能归组）
		const known = this.planProgress
			.filter((p) => p.plan === plan)
			.flatMap((p) => p.goals.map((g) => g.name));
		const { groups, ungrouped } = groupPoolTasksByGoal(planTasks, this.today, known);
		return {
			scheduled: groups.filter((g) => g.scheduled),
			ungroupedPending: ungrouped.filter((t) => this.isPendingPoolChild(t)),
		};
	}

	private renderCheckItem(item: CheckItem, modeChildren: CheckItem[] = []): HTMLElement {
		const li = createEl("li", { cls: "planboard-check-item" + (item.checked ? " is-checked" : "") });
		li.setAttribute("data-line", String(item.line));

		// ADR-0008: 书组视图一次算好——分组渲染与父行「N/M 本」分数共用
		const bookView = item.plan ? this.computeBookView(item.plan) : null;

		const label = li.createEl("label", { cls: "planboard-check-label" });
		const cb = label.createEl("input", { type: "checkbox", cls: "planboard-checkbox" });
		cb.checked = item.checked;
		cb.addEventListener("change", () => void this.toggleCheckItem(item, cb.checked));
		label.createSpan({ cls: "planboard-check-text", text: item.text });
		if (item.plan) {
			const tag = label.createSpan({ cls: "planboard-plan-tag", text: item.plan });
			tag.setAttribute("data-plan", item.plan);
			this.applyPlanColor(tag, item.plan);
		}
		// ADR-0008: 今日书进度 = 今日份额清空的书 ÷ 今日有安排的书（仅多书计划显示）
		if (bookView && bookView.scheduled.length >= 2) {
			const done = bookView.scheduled.filter((g) => g.pending.length === 0).length;
			const frac = label.createSpan({ cls: "planboard-book-fraction", text: `${done}/${bookView.scheduled.length} 本` });
			frac.setAttribute("title", `今日书进度：${done}/${bookView.scheduled.length} 本已完成今日份额（逾期欠账清完才算完成）`);
		}
		// ADR-0016: 生活计划父行的今日事项分数（已勾事项 ÷ 今日文件中的事项行，含挂账）
		if (item.plan && this.isChorePlan(item.plan) && modeChildren.length > 0) {
			const done = modeChildren.filter((c) => c.checked).length;
			const frac = label.createSpan({ cls: "planboard-book-fraction", text: `${done}/${modeChildren.length}` });
			frac.setAttribute("title", `今日生活事项：${done}/${modeChildren.length} 已完成`);
		}

		const actions = li.createDiv({ cls: "planboard-item-actions" });
		// ADR-0016: 生活计划父行——「＋」新增事项 /「☰」管理事项（增改删走小弹窗，年度计划.md 为事实源）
		if (item.plan && this.isChorePlan(item.plan)) {
			const addBtn = actions.createEl("button", {
				cls: "planboard-icon-btn planboard-chore-add-btn",
				attr: { "aria-label": "新增生活事项", title: "新增生活事项" },
			});
			addBtn.setText("＋");
			addBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.openChoreItemModal(item.plan!, null);
			});
			const manageBtn = actions.createEl("button", {
				cls: "planboard-icon-btn planboard-chore-manage-btn",
				attr: { "aria-label": "管理生活事项", title: "管理生活事项（改周期/改名/删除）" },
			});
			manageBtn.setText("☰");
			manageBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.openChoreManageModal(item.plan!);
			});
		}
		// ADR-0001: quota 行追加「实际量」录入按钮（勾选 = 记满配额；填数 = 按实际累计）
		// ADR-0006: 复习/运动模式行同样提供「实」按钮（复习下限/运动每日量语境）；生活事项无量无「实」
		const modeHit = this.modeLineMatch(item);
		if (item.plan && (this.quotaPlanSet.has(item.plan) || (modeHit && modeHit.goal.mode !== "diary" && modeHit.goal.mode !== "chore"))) {
			const actBtn = actions.createEl("button", {
				cls: "planboard-icon-btn planboard-quota-actual-btn",
				attr: { "aria-label": "记录实际量", title: "记录实际量" },
			});
			actBtn.setText("实");
			actBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				void this.openQuotaActualModal(item);
			});
		}
		const upBtn = actions.createEl("button", { cls: "planboard-icon-btn planboard-move-btn", attr: { "aria-label": "上移", title: "上移" } });
		upBtn.setText("↑");
		upBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.moveCheckItem(item, -1);
		});
		const downBtn = actions.createEl("button", { cls: "planboard-icon-btn planboard-move-btn", attr: { "aria-label": "下移", title: "下移" } });
		downBtn.setText("↓");
		downBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.moveCheckItem(item, 1);
		});
		const delBtn = actions.createEl("button", { cls: "planboard-icon-btn planboard-del-btn", attr: { "aria-label": "删除", title: "删除" } });
		delBtn.setText("✕");
		delBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.deleteCheckItem(item);
		});

		// ADR-0003: 下一级子任务 = 任务池中该计划「该做还没做」的任务；全勾完自动勾父行
		// ADR-0008: 今日有安排的书 ≥ 2 时按书分组（书行 + 叶），否则维持扁平列表
		// ADR-0009: 单书同样折叠书行（阈值 ≥1；书行勾=清当日份额，多书规则不变）
		if (item.plan && bookView) {
			if (bookView.scheduled.length >= 1) {
				this.renderGroupedChildren(li, item, bookView);
			} else {
				const children = this.pendingPoolChildren(item.plan);
				if (children.length > 0) {
					li.addClass("has-sublist");
					const sub = li.createEl("ul", { cls: "planboard-sublist" });
					for (const t of children) sub.appendChild(this.renderPoolLeaf(item, t));
				}
			}
		}

		// ADR-0006: 模式目标行 = 计划父打卡项的子项（拉升/八段锦挂在「运动」下）；
		// 勾父 → 级联勾全部子（ADR-0003 同款），勾满子 → 父自动勾。
		if (modeChildren.length > 0) {
			li.addClass("has-sublist");
			const sub = li.createEl("ul", { cls: "planboard-sublist planboard-mode-sublist" });
			for (const c of modeChildren) sub.appendChild(this.renderModeChild(c));
		}

		return li;
	}

	/** ADR-0006: 模式子行（父打卡项下嵌套渲染）：勾选写回自身行；复习/运动子行带「实」按钮。 */
	private renderModeChild(item: CheckItem): HTMLElement {
		const mg = this.modeLineMatch(item);
		const li = createEl("li", { cls: "planboard-subitem planboard-mode-child" + (item.checked ? " is-checked" : "") });
		li.setAttribute("data-line", String(item.line));
		const label = li.createEl("label", { cls: "planboard-check-label" });
		const cb = label.createEl("input", { type: "checkbox", cls: "planboard-checkbox planboard-subcheckbox" });
		cb.checked = item.checked;
		cb.addEventListener("change", () => void this.toggleCheckItem(item, cb.checked));
		label.createSpan({ cls: "planboard-check-text", text: item.text });
		// ADR-0016: 生活事项子行——逾期挂账徽标（ensureChoreTracking 回扫出的挂账事实，
		// 该做日恰逢旧挂账、每天周期漏了也能亮标）+ 勾一次清账提示
		if (mg?.goal.mode === "chore" && this.choreDebtMap.get(`${item.plan}|${mg.goal.name}`)) {
			const cycle: GoalCycle = mg.goal.cycle ?? { unit: "day", days: [] };
			const badge = label.createSpan({ cls: "planboard-chore-overdue", text: "逾期" });
			badge.setAttribute("title", `${choreCycleLabel(cycle, mg.goal.overdue)}：有该做未做的挂账，勾一次即清账`);
		}
		if (mg && mg.goal.mode !== "diary" && mg.goal.mode !== "chore") {
			const actions = li.createDiv({ cls: "planboard-item-actions" });
			const actBtn = actions.createEl("button", {
				cls: "planboard-icon-btn planboard-quota-actual-btn",
				attr: { "aria-label": "记录实际量", title: "记录实际量" },
			});
			actBtn.setText("实");
			actBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				void this.openQuotaActualModal(item);
			});
		}
		return li;
	}

	/** ADR-0003: 单片待办叶（勾选写回任务池；点行打开任务详情）。 */
	private renderPoolLeaf(item: CheckItem, t: PoolTask): HTMLElement {
		const sli = createEl("li", { cls: "planboard-subitem" });
		const slabel = sli.createEl("label", { cls: "planboard-check-label" });
		const scb = slabel.createEl("input", { type: "checkbox", cls: "planboard-checkbox planboard-subcheckbox" });
		scb.addEventListener("change", () => void this.togglePoolChild(item, t, scb.checked));
		slabel.createSpan({ cls: "planboard-check-text", text: t.text });
		// ADR-0009: 联动叶行尾 🔗——在阅读器中打开对应章节（Q14=B：不劫持勾选语义）
		if (item.plan && !t.checked && this.weaveBridge) {
			const hit = this.findReaderGoal(item.plan, t.text.trim());
			const sid = hit?.goal.readerSid;
			if (hit && sid) {
				const leaves = expandGoalLeaves(hit.goal.name, hit.goal);
				const ord = leaves ? leaves.findIndex((l) => l.name === t.text.trim()) : -1;
				// 锚点优先取目标落盘快照（同步、随结构确认落盘、改名不失效）；旧目标回退实时对齐缓存
				const align = this.leafAnchorsFor(hit.goal);
				const href = ord >= 0 ? align?.hrefs[ord] : undefined;
					if (!href && !hit.goal.readerAnchors?.length && !isAlignCached(sid)) {
						// 旧目标无快照：锚点解析是异步的，首帧缓存常为空——补齐后刷一次列表
						void ensureWeaveAlignment(sid, hit.goal).then((a) => {
							if (!a || renderQueued) return;
							renderQueued = true;
							window.setTimeout(() => {
								renderQueued = false;
								if (this.contentEl?.isConnected) this.updateChecklist();
							}, 50);
						});
					}
				if (href) {
					const jump = sli.createEl("button", {
						cls: "planboard-icon-btn planboard-jump-btn",
						attr: { "aria-label": "在阅读器中打开", title: "在阅读器中打开对应章节" },
					});
					jump.setText("🔗");
					jump.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						try {
							this.weaveBridge?.openChapter(sid, href);
						} catch {
							new Notice("跳转失败：阅读器插件未响应");
						}
					});
				}
			}
		}
		slabel.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).tagName === "INPUT") return;
			e.preventDefault();
			void this.openTaskModal(t);
		});
		return sli;
	}

	/**
	 * ADR-0008: 书组渲染——识别不到目标名的待办平铺在顶部，其后按任务池文件序逐书一组。
	 * 待办书 = 书行（未勾）+ 该书今日待办叶（含逾期欠账，诚实呈现）；
	 * 完成书 = 书行打勾（派生态，叶隐藏），点击书行展开今日已勾叶逐叶退钩。
	 */
	private renderGroupedChildren(li: HTMLElement, item: CheckItem, bookView: { scheduled: BookGroup[]; ungroupedPending: PoolTask[] }): void {
		li.addClass("has-sublist");
		const sub = li.createEl("ul", { cls: "planboard-sublist planboard-booklist" });
		for (const t of bookView.ungroupedPending) {
			sub.appendChild(this.renderPoolLeaf(item, t));
		}
		for (const g of bookView.scheduled) {
			sub.appendChild(this.renderBookGroup(item, g));
		}
	}

	/** ADR-0008: 一个书组——书行勾 = 该书今日份额清空，状态从待办推导，不落任何文件。 */
	private renderBookGroup(item: CheckItem, g: BookGroup): HTMLElement {
		const done = g.pending.length === 0;
		const key = `${item.plan ?? ""}||${g.name}`;
		const liB = createEl("li", { cls: "planboard-bookitem" + (done ? " is-done" : "") });
		const label = liB.createEl("label", { cls: "planboard-check-label" });
		const cb = label.createEl("input", { type: "checkbox", cls: "planboard-checkbox planboard-subcheckbox" });
		cb.checked = done;
		cb.addEventListener("change", () => void this.toggleBookGroup(item, g, cb.checked));
		label.createSpan({ cls: "planboard-check-text planboard-bookname", text: g.name });
		// ADR-0009: 书行 🔗——在阅读器中打开这本书（恢复上次阅读位置）；旧版 fork 无 openBook 时不显示
		if (this.weaveBridge?.openBook) {
			const goal = this.planProgress.find((p) => p.plan === item.plan)?.goals.find((x) => x.name === g.name);
			const sid = goal?.readerSid;
			if (sid) {
				const jump = label.createEl("button", {
					cls: "planboard-icon-btn planboard-jump-btn",
					attr: { "aria-label": "在阅读器中打开这本书", title: "在阅读器中打开（恢复上次阅读位置）" },
				});
				jump.setText("🔗");
				jump.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					try {
						this.weaveBridge?.openBook?.(sid);
					} catch {
						new Notice("跳转失败：阅读器插件未响应");
					}
				});
			}
		}

		if (!done) {
			const sub = liB.createEl("ul", { cls: "planboard-sublist planboard-leaflist" });
			for (const t of g.pending) sub.appendChild(this.renderPoolLeaf(item, t));
			return liB;
		}

		// 完成书：checkbox 禁用（派生态无法直接取消，取消必须经退叶）；
		// 点击书行展开/收起今日已勾叶（反悔路径）
		cb.disabled = true;
		liB.addClass("is-expandable");
		label.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).tagName === "INPUT") return;
			e.preventDefault();
			if (this.expandedBookGroups.has(key)) this.expandedBookGroups.delete(key);
			else this.expandedBookGroups.add(key);
			this.updateChecklist();
		});
		if (g.todayDone.length > 0 && this.expandedBookGroups.has(key)) {
			liB.addClass("is-expanded");
			const sub = liB.createEl("ul", { cls: "planboard-sublist planboard-leaflist" });
			for (const t of g.todayDone) {
				const sli = sub.createEl("li", { cls: "planboard-subitem is-checked" });
				const slabel = sli.createEl("label", { cls: "planboard-check-label" });
				const scb = slabel.createEl("input", { type: "checkbox", cls: "planboard-checkbox planboard-subcheckbox" });
				scb.checked = true;
				scb.addEventListener("change", () => void this.togglePoolChild(item, t, false));
				slabel.createSpan({ cls: "planboard-check-text", text: t.text });
			}
		}
		return liB;
	}

	/**
	 * ADR-0008: 勾书行 → 连带勾掉该书全部待办叶（写任务池 + 日记投影，与逐叶勾同路径）；
	 * 级联后若全计划待办清空 → 父行自动打钩（与勾最后一叶同规则，ADR-0003）。
	 * 书行勾选是派生态：只处理「勾」，取消在视图层不可能发生（checkbox 已禁用）。
	 */
	private async toggleBookGroup(item: CheckItem, g: BookGroup, checked: boolean): Promise<void> {
		if (!checked || g.pending.length === 0) return;
		this.selfWrite = true;
		try {
			const cascaded: PoolTask[] = [];
			for (const t of g.pending) {
				await toggleTask(this.app, t, true);
				// ADR-0004: 级联勾掉的子任务同步投影到当天日记「## 代办事项」
				await syncPoolTaskToDiary(this.app, this.plugin.settings.diaryDir, t.text, true);
				cascaded.push(t);
			}
			if (item.plan && !item.checked) {
				// 快照里剔除刚级联勾掉的任务后无剩余 → 全部完成
				const rest = this.pendingPoolChildren(item.plan).filter((t) => !cascaded.includes(t));
				if (rest.length === 0) {
					await this.app.vault.process(item.file, (data) => toggleTaskLine(data, item.line, true, item.raw));
					item.checked = true;
				}
			}
		} finally {
			this.selfWrite = false;
		}
		await this.refresh(); // 任务池与父行都可能变化：统一重算
	}

	private async toggleCheckItem(item: CheckItem, checked: boolean): Promise<void> {
		if (!this.dailyData) return;
		const modeHit = this.modeLineMatch(item);
		const modeParent = modeHit ? this.modeParentOf(item) : null;
		this.selfWrite = true;
		try {
			// ADR-0011: 模式行手动勾/退勾不再落 ✋——勾选是完成事实的镜像，刷新即按事实回填
			await this.app.vault.process(item.file, (data) => toggleTaskLine(data, item.line, checked, item.raw));
			// ADR-0006: 勾计划父行 → 级联勾掉该计划全部模式子行（不打 ✋——复习行的 BZG
			// 自动实量随后照常写入）；取消父行不回退子行（与任务池子任务同语义）。
			if (checked && !modeHit && item.plan) {
				for (const child of this.modeChildrenOf(item)) {
					if (child.checked || child === item) continue;
					await this.app.vault.process(child.file, (data) => toggleTaskLine(data, child.line, true, child.raw));
					child.checked = true;
				}
			}
			// ADR-0003: 勾父行 → 连带勾掉该计划全部待办子任务（Q3a）；
			// 取消父行不回退子任务——防误触清掉任务池里的进度记录。
			if (checked && item.plan && !modeHit) {
				for (const t of this.pendingPoolChildren(item.plan)) {
					await toggleTask(this.app, t, true);
					// ADR-0004: 级联勾掉的子任务同步投影到当天日记「## 代办事项」
					await syncPoolTaskToDiary(this.app, this.plugin.settings.diaryDir, t.text, true);
				}
			}
			// ADR-0006: 勾满某计划的全部模式子行 → 父打卡行自动勾（ADR-0003「全子完成勾父」同款）
			if (modeHit && checked && modeParent && !modeParent.checked) {
				const siblings = this.modeChildrenOf(modeParent);
				const allDone =
					siblings.every((c) => c.checked || c === item) &&
					(modeParent.plan ? this.pendingPoolChildren(modeParent.plan).length === 0 : true);
				if (siblings.length > 0 && allDone) {
					await this.app.vault.process(modeParent.file, (data) =>
						toggleTaskLine(data, modeParent.line, true, modeParent.raw));
					modeParent.checked = true;
				}
			}
		} finally {
			this.selfWrite = false;
		}
		item.checked = checked;
		this.updateProgress();
		this.updateChecklist();
		this.updateSummary(); // 联动：总结区三行（✅/⬜/💪）随打卡实时刷新
		// ADR-0004 扩展: 计划项勾选态镜像到日记「## 完成情况跟踪」（退钩保留行，同 TODO 语义）
		if (item.plan) void this.syncTrackingToDiary();
	}

	/**
	 * ADR-0003: 勾/取消今日打卡的子任务（任务池任务写回任务池）。
	 * 勾掉最后一个待办子任务 → 父行自动打钩（「全部完成，自动对上一级打钩」）。
	 * ADR-0004: 勾/退钩同步投影到当天日记「## 代办事项」（与 bz 待办同格式）。
	 */
	private async togglePoolChild(item: CheckItem, task: PoolTask, checked: boolean): Promise<void> {
		this.selfWrite = true;
		try {
			// ADR-0009: 联动叶手动退勾 → 同一笔写回内落 ✋（单向只勾不退：自动此后不再勾该叶）
			const readerHit = !checked && item.plan ? this.findReaderGoal(item.plan, task.text.trim()) : null;
			if (readerHit) {
				await this.app.vault.process(task.file, (data) => {
					const lines = data.split("\n");
					let idx = lines.indexOf(task.raw);
					if (idx === -1) idx = lines.findIndex((l) => l.startsWith(`- [${task.checked ? "x" : " "}] ${task.text}`));
					if (idx === -1) return data;
					return markTaskLineManual(toggleTaskLine(data, idx, checked), idx);
				});
			} else {
				await toggleTask(this.app, task, checked);
			}
			await syncPoolTaskToDiary(this.app, this.plugin.settings.diaryDir, task.text, checked);
			if (checked && item.plan && !item.checked) {
				// 快照里剔除刚勾掉的任务后无剩余 → 全部完成
				const rest = this.pendingPoolChildren(item.plan).filter((t) => t !== task);
				if (rest.length === 0) {
					await this.app.vault.process(item.file, (data) => toggleTaskLine(data, item.line, true, item.raw));
					item.checked = true;
				}
			}
		} finally {
			this.selfWrite = false;
		}
		await this.refresh(); // 任务池与父行都可能变化：planProgress / 周卡 / 打卡区统一重算
	}

	/** ADR-0001: 打开「实际量」录入弹窗（quota 行专用）。 */
	private async openQuotaActualModal(item: CheckItem): Promise<void> {
		// ADR-0006: 复习/运动模式行 → 下限语境的录入（留空 = 记满下限）
		const modeHit = this.modeLineMatch(item);
		if (modeHit) {
			const unit = modeHit.goal.unit || (modeHit.goal.mode === "review" ? "篇" : "");
			const floor = modeHit.goal.floor ?? 0;
			new QuotaActualModal(this.app, item, unit, floor, (actual) => this.applyModeGoalActual(item, modeHit, actual)).open();
			return;
		}
		const q = this.planProgress.find((p) => p.plan === item.plan)?.quota ?? null;
		const unit = q?.unit ?? "";
		const dailyQuota = q?.dailyQuota ?? 0;
		new QuotaActualModal(this.app, item, unit, dailyQuota, (actual) => this.applyQuotaActual(item, actual)).open();
	}

	/**
	 * ADR-0006: 模式行实际量手动写回（BZG 缺席时的手动记录路径；ADR-0011 起不再落 `✋`）。
	 * actual=0 = 记满当日下限并勾选；actual ≥ 下限自动勾选，未达下限照实记录不勾。
	 */
	private async applyModeGoalActual(
		item: CheckItem,
		modeHit: { plan: string; goal: PlanGoal; label: string },
		actual: number
	): Promise<void> {
		if (!this.dailyData) return;
		const unit = modeHit.goal.unit || (modeHit.goal.mode === "review" ? "篇" : "");
		const floor = modeHit.goal.floor ?? 0;
		const checked = actual <= 0 || actual >= floor;
		this.selfWrite = true;
		let newContent: string;
		try {
			newContent = await this.app.vault.process(item.file, (data) =>
				setQuotaActual(data, item.line, actual, unit, checked, item.raw));
		} finally {
			this.selfWrite = false;
		}
		this.dailyData = parseDailyContent(item.file, newContent, this.today);
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
		await this.refresh();
	}

	/** ADR-0001: 写回实际量（actual=0 表示清除后缀、仅勾选记满配额）。 */
	private async applyQuotaActual(item: CheckItem, actual: number): Promise<void> {
		if (!this.dailyData) return;
		const q = this.planProgress.find((p) => p.plan === item.plan)?.quota ?? null;
		const unit = q?.unit ?? "";
		this.selfWrite = true;
		let newContent: string;
		try {
			newContent = await this.app.vault.process(item.file, (data) =>
				setQuotaActual(data, item.line, actual, unit, true, item.raw));
		} finally {
			this.selfWrite = false;
		}
		this.dailyData = parseDailyContent(item.file, newContent, this.today);
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
		await this.refresh(); // 累计进度（planProgress）随实际量变化，需重算
	}

	private async moveCheckItem(item: CheckItem, delta: number): Promise<void> {
		if (!this.dailyData) return;
		this.selfWrite = true;
		let newContent: string;
		try {
			newContent = await this.app.vault.process(item.file, (data) => moveTaskLine(data, item.line, delta, item.raw));
		} finally {
			this.selfWrite = false;
		}
		this.dailyData = parseDailyContent(item.file, newContent, this.today);
		this.updateChecklist();
		this.updateProgress();
	}

	private async deleteCheckItem(item: CheckItem): Promise<void> {
		if (!this.dailyData) return;
		this.selfWrite = true;
		let newContent: string;
		try {
			newContent = await this.app.vault.process(item.file, (data) => removeLine(data, item.line, item.raw));
		} finally {
			this.selfWrite = false;
		}
		this.dailyData = parseDailyContent(item.file, newContent, this.today);
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
	}

	private async addCheckItem(line: string): Promise<void> {
		if (!this.dailyData) return;
		this.selfWrite = true;
		try {
			const newContent = await this.app.vault.process(this.dailyData.file, (data) => appendCheckItem(data, line));
			this.dailyData = parseDailyContent(this.dailyData.file, newContent, this.today);
		} finally {
			this.selfWrite = false;
		}
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
	}

	// --- Summary -------------------------------------------------------------

	private updateSummary(): void {
		if (!this.dailyData || !this.summaryEl) return;
		// Don't clobber the textarea while the user is typing.
		if (document.activeElement === this.summaryEl) return;
		this.summaryEl.value = this.dailyData.summary;
		this.updateSummaryAuto();
	}

	/** v1.4: 打卡自动生成三行（✅完成数量 / ⬜未完成数量 / 💪鼓励语），只读展示不写文件。 */
	private updateSummaryAuto(): void {
		if (!this.summaryAutoEl || !this.dailyData) return;
		// ADR-0012 大项口径：与打卡卡进度同一把尺（并排两卡不得出现两个完成度）
		const rows = topLevelCheckRows(this.dailyData.checkItems, (it) => this.modeLineMatch(it) !== null);
		const done = rows.filter((r) => r.done).length;
		const pending = rows.length - done;
		this.summaryAutoEl.empty();

		const total = rows.length;
		const doneLine = this.summaryAutoEl.createDiv({ cls: "planboard-summary-auto-line is-done" });
		doneLine.createSpan({ cls: "planboard-summary-auto-label", text: "✅ 已完成" });
		doneLine.createSpan({ cls: "planboard-summary-auto-text", text: `${done}/${total}` });

		const pendLine = this.summaryAutoEl.createDiv({ cls: "planboard-summary-auto-line is-pending" });
		pendLine.createSpan({ cls: "planboard-summary-auto-label", text: "⬜ 未完成" });
		pendLine.createSpan({ cls: "planboard-summary-auto-text", text: `${pending}/${total}` });

		const pct = total === 0 ? 0 : Math.round((done / total) * 100);
		let cheer: string;
		if (total === 0) cheer = "今天还没有打卡项，去添加一个吧";
		else if (pct === 100) cheer = "全勤达成！今天的你闪闪发光";
		else if (pct >= 80) cheer = `已完成 ${pct}%，快完成啦，再坚持一下！`;
		else if (pct >= 50) cheer = `已完成 ${pct}%，势头不错，继续冲！`;
		else if (pct > 0) cheer = `已完成 ${pct}%，加油突破，动起来！`;
		else cheer = "今天还没开始打卡哦，从第一项开始吧";
		const cheerLine = this.summaryAutoEl.createDiv({ cls: "planboard-summary-auto-line is-cheer" });
		cheerLine.createSpan({ cls: "planboard-summary-auto-label", text: "💪" });
		cheerLine.createSpan({ cls: "planboard-summary-auto-text", text: cheer });
	}

	/**
	 * ADR-0014: 「昨日留的计划」只读块——实时侧读昨日日记「# 次日计划」小节。
	 * 零复制零同步：昨晚改了日记，今天看到的就是最新的（文件事实为准）。
	 * 昨日日记不存在 / 无该节 / 内容空白 → 整块隐藏；严格只看昨日一天，不向前回溯。
	 */
	private async updateYesterdayPlan(): Promise<void> {
		const el = this.yesterdayPlanEl;
		if (!el) return;
		const dir = this.plugin.settings.diaryDir.replace(/\/+$/, "").trim();
		const yesterday = formatDate(addDays(parseDateString(this.today), -1));
		let text: string | null = null;
		if (dir) {
			const f = this.app.vault.getAbstractFileByPath(`${dir}/${yesterday}.md`);
			if (f instanceof TFile) text = extractNextDayPlanSection(await this.app.vault.cachedRead(f));
		}
		el.empty();
		if (text === null || text.trim() === "") {
			el.addClass("planboard-hidden");
			return;
		}
		el.removeClass("planboard-hidden");
		const head = el.createDiv({ cls: "planboard-yesterday-plan-head" });
		head.createSpan({ cls: "planboard-yesterday-plan-title", text: "📌 昨日留的计划" });
		const editBtn = head.createEl("button", {
			cls: "planboard-btn planboard-btn-outline planboard-yesterday-plan-edit",
			text: "去修改",
		});
		editBtn.addEventListener("click", () => void this.openNextDayPlanModal(yesterday));
		el.createDiv({ cls: "planboard-yesterday-plan-body", text });
	}

	private async saveSummary(): Promise<void> {
		if (!this.dailyData || !this.summaryEl) return;
		const value = this.summaryEl.value;
		if (value === this.dailyData.summary) return;
		this.selfWrite = true;
		try {
			await this.app.vault.process(this.dailyData.file, (data) => replaceSummary(data, value));
		} finally {
			this.selfWrite = false;
		}
		this.dailyData.summary = value;
		new Notice("总结已保存");
	}

	/**
	 * ADR-0004 扩展/扩展五:「写入备注」——把当前今日总结写进当天日记「## 备注」小节。
	 * 无标记方案：`- ` 列表样式写入；替换锚点 = 设置 summaryDiaryLast 记录的上次写入块；
	 * 有已填编号行则续接编号（Q2b）。用户主动触发，三种结果都给 Notice 反馈。
	 */
	private async writeSummaryToDiary(): Promise<void> {
		if (!this.summaryEl) return;
		const value = this.summaryEl.value.trim();
		if (value === "") {
			new Notice("今日总结为空，先写点内容再写入");
			return;
		}
		const r = await writeSummaryToDiary(this.app, this.plugin.settings.diaryDir, value, this.plugin.settings.summaryDiaryLast);
		if (r.status === "no-diary") {
			new Notice(`未找到今日日记：${this.plugin.settings.diaryDir}/${this.today}.md`);
		} else if (r.status === "no-section") {
			new Notice("日记中未找到「## 备注」小节，未写入");
		} else {
			// 记录本次写入块（替换锚点，ADR-0004 扩展五）；data.json 随库同步
			this.plugin.settings.summaryDiaryLast = r.written;
			await this.plugin.saveSettings();
			new Notice("已写入日记「## 备注」");
		}
	}

	// --- Missing note / creation ---------------------------------------------

	private renderTodayDailyMissing(): void {
		if (!this.panelEl) return;
		if (this.panelEl.querySelector(".planboard-missing-card")) return;
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-missing-card" });
		card.createDiv({ cls: "planboard-card-title", text: "今日笔记不存在" });
		card.createDiv({ cls: "planboard-missing-desc", text: "尚未创建今日笔记，点击下方按钮按模板一键生成。" });
		const btn = card.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "创建今日笔记" });
		btn.addEventListener("click", () => void this.createTodayNote());
	}

	private async autoEnsureTodayNote(): Promise<void> {
		if (this.getTodayFile()) return;
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const dir = `${root}/${yearDirName(this.today.slice(0, 4))}/每日`;
		const path = `${dir}/${this.today}.md`;
		try {
			await this.ensureFolder(dir);
			const items = await this.buildDefaultCheckItems();
			await this.app.vault.create(path, buildDailyTemplate(this.today, items));
			await this.refresh();
		} catch {
			// 静默：重试由第二个定时器兜底
		}
	}

	private async createTodayNote(): Promise<void> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const dir = `${root}/${yearDirName(this.today.slice(0, 4))}/每日`;
		const path = `${dir}/${this.today}.md`;
		if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) {
			new Notice("今日笔记已存在");
			await this.refreshToday();
			return;
		}
		try {
			await this.ensureFolder(dir);
			const items = await this.buildDefaultCheckItems();
			await this.app.vault.create(path, buildDailyTemplate(this.today, items));
			new Notice("今日笔记已创建");
			await this.refreshToday();
		} catch (e) {
			new Notice(`创建今日笔记失败：${(e as Error).message ?? String(e)}`);
		}
	}

	/**
	 * ADR-0004 扩展三: 写复盘改为弹窗输入——内容写入当天日记「# 当日复盘」小节
	 * （插在「# 随笔」之后；已有小节则原位替换）。不再创建「{date} 复盘.md」文件。
	 * 扩展四：弹窗预填——日记已有当日复盘 → 预填已有内容（改写不丢字）；
	 * 否则预填复盘模板（{root}/复盘模板.md → settings.reviewTemplate），{date} 占位替换。
	 */
	private async openReviewModal(): Promise<void> {
		const prefill = await this.loadReviewPrefill();
		new ReviewModal(this.app, {
			prefill,
			onSubmit: async (text) => {
				const r = await writeReviewToDiary(this.app, this.plugin.settings.diaryDir, text);
				if (r === "no-diary") {
					new Notice(`未找到今日日记：${this.plugin.settings.diaryDir}/${this.today}.md`);
				} else if (r === "no-anchor") {
					new Notice("日记中未找到「# 随笔」小节，无法定位写入位置");
				} else {
					new Notice("复盘已写入日记「# 当日复盘」");
					// ADR-0015: 复盘事实已落盘 → 立即对账，复盘行即时勾上（不等下一次刷新）
					await this.refreshToday();
				}
			},
		}).open();
	}

	/**
	 * ADR-0014: 「次日计划」弹窗——与写复盘同构，写入目标 = `date` 那天日记的「# 次日计划」小节。
	 * 主按钮恒指今天（给明天排的计划）；视图只读块的「去修改」指昨天（改昨晚留给今天的）。
	 * 预填：该日记已有小节正文 → 预填（替换语义防丢字）；否则空白（次日计划无固定骨架，Q8）。
	 */
	private async openNextDayPlanModal(date: string): Promise<void> {
		const dir = this.plugin.settings.diaryDir.replace(/\/+$/, "").trim();
		let prefill = "";
		if (dir) {
			const f = this.app.vault.getAbstractFileByPath(`${dir}/${date}.md`);
			if (f instanceof TFile) {
				const existing = extractNextDayPlanSection(await this.app.vault.cachedRead(f));
				if (existing !== null) prefill = existing;
			}
		}
		const isToday = date === this.today;
		new ReviewModal(this.app, {
			prefill,
			title: isToday ? "📆 次日计划" : `📆 修改昨日次日计划（${date}）`,
			hint: isToday
				? "内容将写入今天日记「# 次日计划」小节（当日复盘之后）；明天打开今日视图会在总结卡上方看到。再次写入会替换内容。"
				: `内容将写入 ${date} 日记「# 次日计划」小节；再次写入会替换内容。`,
			emptyNotice: "次日计划内容为空，先写点什么",
			onSubmit: async (text) => {
				const r = await writeNextDayPlanToDiary(this.app, this.plugin.settings.diaryDir, text, date);
				if (r === "no-diary") {
					new Notice(`未找到${isToday ? "今日" : "该日"}日记：${this.plugin.settings.diaryDir}/${date}.md`);
				} else if (r === "no-anchor") {
					new Notice("日记中未找到「# 当日复盘」或「# 随笔」小节，无法定位写入位置");
				} else {
					new Notice(`次日计划已写入${isToday ? "今日" : ""}日记「# 次日计划」`);
					// 只读块侧读的是昨天日记——写昨天（去修改入口）才可能变块内容
					if (!isToday) await this.updateYesterdayPlan();
				}
			},
		}).open();
	}

	/** 扩展四：弹窗预填内容——优先当日复盘已有正文，其次复盘模板骨架。 */
	private async loadReviewPrefill(): Promise<string> {
		// 1) 日记里已有「# 当日复盘」→ 预填已有内容（替换语义下保护已写内容）
		const dir = this.plugin.settings.diaryDir.replace(/\/+$/, "").trim();
		if (dir) {
			const df = this.app.vault.getAbstractFileByPath(`${dir}/${this.today}.md`);
			if (df instanceof TFile) {
				const existing = extractReviewSection(await this.app.vault.cachedRead(df));
				if (existing !== null && existing.trim() !== "") return existing;
			}
		}
		// 2) 复盘模板：文件优先（设置页「打开模板」维护的那份），退回设置内文本
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const tf = this.app.vault.getAbstractFileByPath(`${root}/复盘模板.md`);
		const template = tf instanceof TFile ? await this.app.vault.cachedRead(tf) : this.plugin.settings.reviewTemplate;
		return buildReviewPrefill(template, this.today);
	}

	private async openFileInEditMode(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		// DEV.md 踩坑记录 #2: openFile inherits preview mode — force edit mode.
		const view = leaf.view;
		if (view instanceof MarkdownView && view.getMode() === "preview") {
			// toggleMode() exists at runtime in 1.13.x but is missing from the 1.5.x typings (DEV.md #1).
			(view as unknown as { toggleMode(): void }).toggleMode();
		}
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const parts = folderPath.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(cur);
			if (existing instanceof TFolder) continue;
			if (existing) {
				new Notice(`路径冲突：${cur}`);
				return;
			}
			try {
				await this.app.vault.createFolder(cur);
			} catch (e) {
				// v1.0.5: 索引滞后的竞态兜底（与 main.ts ensureFolder 同步）——重查一次放行
				if (this.app.vault.getAbstractFileByPath(cur) instanceof TFolder) continue;
				throw e;
			}
		}
	}

	// --- Add item modal -------------------------------------------------------

	private openAddItemModal(): void {
		new AddCheckItemModal(this.app, this.plugin, this.today, (line) => void this.addCheckItem(line)).open();
	}

	// -------------------------------------------------------------------------
	// Task pool CRUD (M2)
	// -------------------------------------------------------------------------

	private async openTaskModal(task: PoolTask | null, defaults?: TaskDefaults): Promise<void> {
		const plans = await this.getTaskPlanOptions();
		new TaskModal(this.app, this.plugin, task, plans, defaults ?? {}, (input) => void this.saveTask(task, input)).open();
	}

	/** Plan options for the task modal: annual plans + defaults + daily templates. */
	private async getTaskPlanOptions(): Promise<string[]> {
		const plans = new Set<string>();
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const defs = await this.readAnnualPlanDefs(root, year);
		if (defs) {
			for (const def of defs) plans.add(def.name);
		}
		for (const p of Object.keys(DEFAULT_PLAN_COLORS)) plans.add(p);
		return Array.from(plans);
	}

	private async saveTask(existing: PoolTask | null, input: NewTaskInput): Promise<void> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		this.selfWrite = true;
		try {
			if (existing) {
				await editTask(this.app, existing, input);
			} else {
				await addTask(this.app, root, year, input);
			}
		} finally {
			this.selfWrite = false;
		}
		new Notice(existing ? "任务已更新" : "任务已添加");
		await this.refresh();
	}

	private async togglePoolTask(task: PoolTask, checked: boolean): Promise<void> {
		this.selfWrite = true;
		try {
			await toggleTask(this.app, task, checked);
			// ADR-0004: 周/月卡等任意入口勾选任务池任务，同样投影到当天日记「## 代办事项」
			await syncPoolTaskToDiary(this.app, this.plugin.settings.diaryDir, task.text, checked);
		} finally {
			this.selfWrite = false;
		}
		await this.refresh();
	}

	private async deletePoolTask(task: PoolTask): Promise<void> {
		this.selfWrite = true;
		try {
			await deleteTask(this.app, task);
			// v1.0.4: 自动分解任务打墓碑——防止 ensureAutoTasks 补额时复活（非自动任务无需）
			if (isAutoTask(task)) {
				const name = task.text.trim();
				if (!this.plugin.settings.deletedAutoTasks.includes(name)) {
					this.plugin.settings.deletedAutoTasks.push(name);
					await this.plugin.saveSettings();
				}
			}
		} finally {
			this.selfWrite = false;
		}
		new Notice("任务已删除");
		await this.refresh();
	}

	/** v1.0.4: 清掉匹配前缀的自动任务墓碑（目标重建/删除后，原墓碑不再有意义）。 */
	private clearAutoTombstones(prefix: string): void {
		const before = this.plugin.settings.deletedAutoTasks?.length ?? 0;
		this.plugin.settings.deletedAutoTasks = (this.plugin.settings.deletedAutoTasks ?? []).filter((n) => !n.startsWith(prefix));
		if (this.plugin.settings.deletedAutoTasks.length !== before) void this.plugin.saveSettings();
	}

	/**
	 * ADR-0005: 章节目标按名对账的墓碑清理——前缀匹配的墓碑里，只有「新序列中仍存在」
	 * 的名字保留（用户手动删过的节编辑后不复活），其余清除；不在任何前缀下的不动。
	 */
	private pruneAutoTombstones(prefixes: string[], keep: ReadonlySet<string>): void {
		const before = this.plugin.settings.deletedAutoTasks ?? [];
		const filtered = before.filter((n) => {
			if (!prefixes.some((p) => n.startsWith(p))) return true;
			return keep.has(n);
		});
		if (filtered.length !== before.length) {
			this.plugin.settings.deletedAutoTasks = filtered;
			void this.plugin.saveSettings();
		}
	}

	/**
	 * Render one pool task row. Checkbox toggles it back to the pool;
	 * clicking the text opens the edit modal; ✕ deletes it.
	 */
	/** v1.7.3: 看板列（大类卡片）拖拽排序——水平 1D 重排 + 松手持久化 boardColumnOrder。 */
	private attachColSort(board: HTMLElement, col: HTMLElement, plan: string): void {
		const header = col.querySelector(".planboard-board-col-header") as HTMLElement;
		if (!header) return;
		let dragging = false;
		let moved = false;
		let grabX = 0;
		let startX = 0;
		let startY = 0;
		let offsetX = 0;
		let lastKey = "";
		let lastMoveT = 0;
		const logicRects = new Map<HTMLElement, DOMRect>();
		const rectOf = (el: HTMLElement): DOMRect => logicRects.get(el) ?? el.getBoundingClientRect();
		// v1.7.3 修复：layoutOf 用实时 rect（含 transform）——重排前后取真实视觉位置，offsetX 补偿才正确
		const layoutOf = (el: HTMLElement): { left: number; top: number } => {
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top };
		};
		const flipOthers = (): void => {
			Array.from(board.children).forEach((c) => {
				const el = c as HTMLElement;
				if (el === col) return;
				const oldR = logicRects.get(el);
				const newR = el.getBoundingClientRect();
				if (!oldR) return;
				const dx = oldR.left - newR.left;
				const dy = oldR.top - newR.top;
				if (dx !== 0 || dy !== 0) {
					el.addClass("planflow-flip-none");
					el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
					void el.offsetWidth;
					el.removeClass("planflow-flip-none");
					el.style.removeProperty("transform");
				}
				logicRects.set(el, newR);
			});
		};
		// v1.7.4: 列拖拽改回"宽度重叠判定"（用户拍板——鼠标位置判定受抓取点偏移影响，手感不统一）。
		// 用被拖列视觉 rect（含 transform）与目标列求水平宽度重叠：重叠比例 ≥ 1/3 即判定，与抓取偏移无关。
		const computeRef = (): { target: HTMLElement; mode: "before" | "after" | "end" } | null => {
			const others = Array.from(board.children).filter((c) => c !== col) as HTMLElement[];
			const dr = col.getBoundingClientRect(); // 被拖列视觉 rect（含 transform = 当前跟手位置）
			const dcx = dr.left + dr.width / 2;
			const drW = dr.width;
			// 0. 末尾检测：被拖列中心在所有列最大右缘 +8 之外 → append
			const maxRight = others.reduce((m, o) => Math.max(m, rectOf(o).right), -Infinity);
			if (others.length > 0 && dcx > maxRight + 8) {
				return { target: others[others.length - 1], mode: "end" };
			}
			// 1. 水平宽度重叠比例 ≥ 1/3 的最大列（分母 = 双方较小宽度 → 列宽差距不影响触发）
			let best: HTMLElement | null = null;
			let bestRatio = 0;
			for (const o of others) {
				const r = rectOf(o);
				const w = Math.min(dr.right, r.right) - Math.max(dr.left, r.left);
				if (w <= 0) continue;
				const ratio = w / Math.min(drW, r.width);
				if (ratio > bestRatio) {
					bestRatio = ratio;
					best = o;
				}
			}
			if (best && bestRatio >= 0.34) {
				const r = rectOf(best);
				// 方向：被拖列中心在目标列中心左侧 → before；右侧 → after（与抓取点无关）
				const ncx = r.left + r.width / 2;
				return dcx < ncx ? { target: best, mode: "before" } : { target: best, mode: "after" };
			}
			return null;
		};
		const onMove = (ev: PointerEvent): void => {
			if (!dragging) return;
			if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
			moved = true;
			const now = Date.now();
			if (now - lastMoveT < 16) return;
			lastMoveT = now;
			const dx = ev.clientX - grabX + offsetX;
			col.style.transform = `translate3d(${dx}px, 0, 0)`;
			const res = computeRef();
			if (res && res.target !== col) {
				const key = res.mode + ":" + (res.target.getAttribute("data-plan") ?? "");
				if (key !== lastKey) {
					lastKey = key;
					const oldL = layoutOf(col);
					if (res.mode === "end") board.appendChild(col);
					else if (res.mode === "after") board.insertBefore(col, res.target.nextElementSibling);
					else board.insertBefore(col, res.target);
					const newL = layoutOf(col);
					offsetX += oldL.left - newL.left;
					col.style.transform = `translate3d(${ev.clientX - grabX + offsetX}px, 0, 0)`;
					flipOthers();
				}
			}
		};
		const finish = (ev?: PointerEvent): void => {
			if (!dragging) return;
			dragging = false;
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", finish, true);
			window.removeEventListener("pointercancel", finish, true);
			if (ev) ev.preventDefault();
			if (moved) {
				col.removeClass("planflow-flip-none");
				col.addClass("planflow-flip-fast");
				col.style.removeProperty("transform");
				window.setTimeout(() => {
					col.removeClass("planflow-flip-fast");
				}, 160);
				// 持久化列顺序
				const order = Array.from(board.children).map((c) => (c as HTMLElement).getAttribute("data-plan") || "其他");
				this.plugin.settings.boardColumnOrder = order;
				void this.plugin.saveSettings();
			}
			col.removeClass("is-col-dragging");
		};
		const onCapture = (e: PointerEvent): void => {
			if (!col.isConnected) {
				window.removeEventListener("pointerdown", onCapture, true);
				return;
			}
			const t = e.target as HTMLElement;
			if (t.closest("button, input, textarea")) return;
			if (!e.composedPath().includes(header)) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			dragging = true;
			moved = false;
			lastKey = "";
			offsetX = 0;
			grabX = e.clientX;
			startX = e.clientX;
			startY = e.clientY;
			Array.from(board.children).forEach((c) => logicRects.set(c as HTMLElement, (c as HTMLElement).getBoundingClientRect()));
			col.addClass("is-col-dragging");
			window.addEventListener("pointermove", onMove, true);
			window.addEventListener("pointerup", finish, true);
			window.addEventListener("pointercancel", finish, true);
		};
		window.addEventListener("pointerdown", onCapture, true);
	}

	private renderTaskItem(task: PoolTask): HTMLElement {
		const li = createEl("li", { cls: "planboard-check-item planboard-pool-item" + (task.checked ? " is-checked" : "") });
		li.setAttribute("data-line", String(task.line));

		const label = li.createEl("label", { cls: "planboard-check-label" });
		const cb = label.createEl("input", { type: "checkbox", cls: "planboard-checkbox" });
		cb.checked = task.checked;
		cb.addEventListener("change", () => void this.togglePoolTask(task, cb.checked));
		label.createSpan({ cls: "planboard-check-text", text: task.text });
		// v1.7.3: 标签 + 起止日期合并到第二行（meta 行）——标题第一行完整显示，不再被标签挤换行
		const meta = li.createDiv({ cls: "planboard-task-meta" });
		if (task.plan) {
			const tag = meta.createSpan({ cls: "planboard-plan-tag", text: task.plan });
			tag.setAttribute("data-plan", task.plan);
			this.applyPlanColor(tag, task.plan);
		}
		const dates: string[] = [];
		if (task.start) dates.push(`🛫 ${task.start}`);
		if (task.due) dates.push(`📅 ${task.due}`);
		if (dates.length > 0) {
			meta.createSpan({ cls: "planboard-task-dates", text: dates.join("  ") });
		}
		// Clicking the text (not the checkbox) opens the edit modal.
		label.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).tagName === "INPUT") return;
			e.preventDefault();
			void this.openTaskModal(task);
		});

		const actions = li.createDiv({ cls: "planboard-item-actions" });
		const editBtn = actions.createEl("button", {
			cls: "planboard-icon-btn",
			attr: { "aria-label": "编辑", title: "编辑" },
		});
		editBtn.setText("✏️");
		editBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.openTaskModal(task);
		});
		const delBtn = actions.createEl("button", {
			cls: "planboard-icon-btn planboard-del-btn",
			attr: { "aria-label": "删除", title: "删除" },
		});
		delBtn.setText("✕");
		delBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.deletePoolTask(task);
		});

		return li;
	}

	// -------------------------------------------------------------------------
	// Board view (M3 + v1.3): category columns (all plans) or status columns
	// -------------------------------------------------------------------------

	private async renderBoardPanel(): Promise<void> {
		if (!this.panelEl) return;
		const panel = this.panelEl;
		panel.empty();
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);

		const header = panel.createDiv({ cls: "planboard-period-header" });
		header.createDiv({ cls: "planboard-period-title", text: "📋 任务看板" });
		header.createDiv({
			cls: "planboard-period-label",
			text: `${year} · ${this.boardMode === "category" ? "按计划分组" : "按状态分组"} · 共 ${tasks.length} 个任务`,
		});

		const subtabs = panel.createDiv({ cls: "planboard-subtabs" });
		const modes: Array<{ key: "category" | "status"; label: string }> = [
			{ key: "category", label: "分类" },
			{ key: "status", label: "状态" },
		];
		for (const m of modes) {
			const btn = subtabs.createEl("button", {
				cls: "planboard-subtab" + (this.boardMode === m.key ? " is-active" : ""),
				text: m.label,
			});
			btn.addEventListener("click", () => {
				this.boardMode = m.key;
				void this.refresh();
			});
		}

		if (this.boardMode === "category") {
			await this.renderBoardCategory(panel, tasks);
		} else {
			this.renderBoardStatus(panel, tasks);
		}
	}

	/**
	 * Category columns: every annual-plan category (even zero-task ones), plus a
	 * "其他" column for unplanned tasks. Empty columns show a "暂无任务" state.
	 */
	private async renderBoardCategory(panel: HTMLElement, tasks: PoolTask[]): Promise<void> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const defs = (await this.readAnnualPlanDefs(root, year)) ?? [];

		// Group by plan (unplanned tasks → "其他").
		const groups = new Map<string, PoolTask[]>();
		for (const t of tasks) {
			const key = t.plan ?? "其他";
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(t);
		}

		// Column order: annual plan categories first (empty ones included), then
		// any task plans not defined in the annual note, then "其他".
		const columns: string[] = [];
		const seen = new Set<string>();
		for (const def of defs) {
			columns.push(def.name);
			seen.add(def.name);
		}
		for (const [plan] of groups) {
			if (plan !== "其他" && !seen.has(plan)) {
				seen.add(plan);
				columns.push(plan);
			}
		}
		if (groups.has("其他")) columns.push("其他");

		// v1.7.3: 用户拖拽过的列顺序（boardColumnOrder）优先；新列追加尾部
		if (this.plugin.settings.boardColumnOrder.length > 0) {
			const known = new Set<string>(columns);
			const ordered = this.plugin.settings.boardColumnOrder.filter((c) => known.has(c));
			for (const c of columns) if (!ordered.includes(c)) ordered.push(c);
			columns.length = 0;
			columns.push(...ordered);
		}

		// 计划名显示：有 icon 时 "✍️ 写作"，否则用原始名。
		const displayByName = new Map<string, string>();
		for (const def of defs) {
			displayByName.set(def.name, def.label ? `${def.label} ${def.name}` : def.name);
		}

		if (columns.length === 0) {
			panel.createDiv({ cls: "planboard-empty", text: "任务池为空 · 在今日/本周/本月视图新建任务" });
			return;
		}

		const board = panel.createDiv({ cls: "planboard-board" });
		for (const plan of columns) {
			const list = groups.get(plan) ?? [];
			const done = list.filter((t) => t.checked).length;
			const col = board.createDiv({ cls: "planboard-board-col" });
			col.setAttribute("data-plan", plan === "其他" ? "" : plan); // v1.7.2: 跨列写回用
			this.applyPlanColor(col, plan === "其他" ? undefined : plan);
			const colHeader = col.createDiv({ cls: "planboard-board-col-header" });
			colHeader.createDiv({ cls: "planboard-board-col-title", text: displayByName.get(plan) ?? plan });
			colHeader.createDiv({ cls: "planboard-board-col-count", text: `${done}/${list.length}` });
			// v1.7.3: 列头拖拽排序（大类卡片拖动——水平 1D 重排 + 持久化 boardColumnOrder）
			this.attachColSort(board, col, plan);
			// Unfinished first (by due/start), finished sink to bottom.
			const sorted = [...list].sort((a, b) => {
				if (a.checked !== b.checked) return a.checked ? 1 : -1;
				return (a.due ?? a.start ?? "").localeCompare(b.due ?? b.start ?? "");
			});
			if (sorted.length === 0) {
				col.createDiv({ cls: "planboard-empty", text: "暂无任务" });
			}
			for (const t of sorted) {
				col.appendChild(this.renderTaskItem(t));
			}
		}
	}

	/** Status columns (spec v1.3): 📋 未开始 / 🔥 进行中 / ✅ 已完成. */
	private renderBoardStatus(panel: HTMLElement, tasks: PoolTask[]): void {
		const cols: Array<{ key: "todo" | "doing" | "done"; label: string }> = [
			{ key: "todo", label: "📋 未开始" },
			{ key: "doing", label: "🔥 进行中" },
			{ key: "done", label: "✅ 已完成" },
		];
		const board = panel.createDiv({ cls: "planboard-board" });
		for (const c of cols) {
			const list = tasks.filter((t) => taskStatus(t, this.today) === c.key);
			const col = board.createDiv({ cls: `planboard-board-col planboard-board-col-status-${c.key}` });
			const colHeader = col.createDiv({ cls: "planboard-board-col-header" });
			colHeader.createDiv({ cls: "planboard-board-col-title", text: c.label });
			colHeader.createDiv({ cls: "planboard-board-col-count", text: String(list.length) });
			// Unfinished first (by due/start), finished sink to bottom.
			const sorted = [...list].sort((a, b) => {
				if (a.checked !== b.checked) return a.checked ? 1 : -1;
				return (a.due ?? a.start ?? "").localeCompare(b.due ?? b.start ?? "");
			});
			if (sorted.length === 0) {
				col.createDiv({ cls: "planboard-empty", text: "暂无任务" });
			}
			for (const t of sorted) {
				col.appendChild(this.renderTaskItem(t));
			}
		}
	}

	// -------------------------------------------------------------------------
	// Gantt view (M3 + v1.3): week / month / year sub-modes, task bars with handles
	// -------------------------------------------------------------------------

	private async renderGanttPanel(): Promise<void> {
		if (!this.panelEl) return;
		const panel = this.panelEl;
		panel.empty();
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		// ADR-0005 v3: 结构型目标在甘特里按「书」聚合（逐叶一行在百节级批量分解下不可用）
		const defs = (await this.readAnnualPlanDefs(root, year)) ?? [];

		const header = panel.createDiv({ cls: "planboard-period-header" });
		header.createDiv({ cls: "planboard-period-title", text: "📊 甘特图" });
		header.createDiv({ cls: "planboard-period-label", text: `${year} · 任务时间条` });

		// v1.0.4: 周/月子视图移除（用户确认甘特只看年维度），直接渲染年视图
		this.renderGanttYear(panel, tasks, defs);
		// Drag write-back needs the full task list (bars carry pool line numbers).
		this.ganttBarTasks = tasks;
	}

	/** A task's effective window (🛫 ~ 📅); at least one date is guaranteed. */
	private taskWindow(t: PoolTask): { start: string; end: string } {
		return { start: t.start ?? t.due!, end: t.due ?? t.start! };
	}

	/**
	 * Intersect a task's window with [start, end] and map it onto a 1..N axis
	 * via `unit` (day index within the year). This is
	 * the cross-window clamp Hermes' drag code depends on.
	 */
	private ganttBarRange(
		t: PoolTask,
		start: string,
		end: string,
		unit: (d: string) => number
	): { s: number; e: number } {
		const w = this.taskWindow(t);
		const isStart = w.start < start ? start : w.start;
		const isEnd = w.end > end ? end : w.end;
		const s = unit(isStart);
		const e = unit(isEnd);
		// Intersecting windows always satisfy s <= e; guard defensively.
		return { s: Math.min(s, e), e: Math.max(s, e) };
	}

	/**
	 * Render one task bar with drag handles (v1.3). Hermes' drag.ts reads the
	 * data-* attributes and left/width to recompute dates — keep this DOM exact.
	 */
	private renderGanttBar(track: HTMLElement, t: PoolTask, s: number, e: number, n: number): void {
		const bar = track.createDiv({ cls: "planboard-gantt-bar" + (t.checked ? " is-done" : "") });
		if (t.plan) {
			bar.setAttribute("data-plan", t.plan);
			this.applyPlanColor(bar, t.plan);
		}
		bar.setAttribute("data-line", String(t.line));
		bar.setAttribute("data-start", t.start ?? "");
		bar.setAttribute("data-due", t.due ?? "");
		bar.setAttribute("data-axis", "year"); // v1.0.4: 甘特只保留年视图
		bar.style.left = `${((s - 1) / n) * 100}%`;
		bar.style.width = `${Math.max(((e - s + 1) / n) * 100, 1.2)}%`;
		bar.createDiv({ cls: "planboard-gantt-handle is-left" });
		bar.createDiv({ cls: "planboard-gantt-handle is-right" });
		bar.setAttribute("title", `${t.text}${t.checked ? " ✓" : ""}`);
	}

	/** Shared "🗂️ 未排期任务" card below the chart. */
	private renderUnscheduled(panel: HTMLElement, tasks: PoolTask[]): void {
		if (tasks.length === 0) return;
		const uCard = panel.createDiv({ cls: "planboard-card" });
		const uHeader = uCard.createDiv({ cls: "planboard-card-header" });
		uHeader.createDiv({ cls: "planboard-card-title", text: "🗂️ 未排期任务" });
		for (const t of tasks) uCard.appendChild(this.renderTaskItem(t));
	}

	/** 甘特图里处于展开状态的结构型目标（「计划名/目标名」键；会话内记忆）。 */
	private ganttExpandedGoals = new Set<string>();

	/** Year axis: 1月~12月 (12 cells), bars positioned by day index (v1.5), current month highlighted. */
	private renderGanttYear(panel: HTMLElement, tasks: PoolTask[], defs: PlanDef[]): void {
		const year = this.today.slice(0, 4);
		const yearStart = `${year}-01-01`;
		const yearEnd = `${year}-12-31`;
		const todayMonth = Number(this.today.slice(5, 7));
		// v1.5: 全年天数（条/今日线的天粒度坐标系分母）
		const totalDays = Math.round((parseDateString(yearEnd).getTime() - parseDateString(yearStart).getTime()) / DAY_MS) + 1;
		const inWindow = filterTasksInRange(tasks, yearStart, yearEnd);
		const unscheduled = tasks.filter((t) => !t.start && !t.due);

		const chart = panel.createDiv({ cls: "planboard-gantt" });

		const axisRow = chart.createDiv({ cls: "planboard-gantt-axis" });
		for (let m = 1; m <= 12; m++) {
			const cell = axisRow.createDiv({
				cls: "planboard-gantt-axis-cell" + (m === todayMonth ? " is-today" : ""),
				text: `${m}月`,
			});
			cell.style.width = `${100 / 12}%`;
		}

		if (inWindow.length === 0) {
			chart.createDiv({ cls: "planboard-empty", text: "本年没有带日期的任务" });
		}

		// --- ADR-0005 v3: 结构型目标聚合为一行（逐叶一行在百节级阅读计划下不可用） ---
		interface GoalGroup {
			key: string;
			plan: string;
			goalName: string;
			leafNames: Set<string>;
			tasks: PoolTask[];
		}
		const groups = new Map<string, GoalGroup>();
		const groupOfText = new Map<string, GoalGroup>();
		for (const def of defs) {
			for (const goal of def.goals) {
				const leaves = expandGoalLeaves(goal.name, goal);
				// 叶太少不聚合（逐行 + 拖拽更直观）
				if (!leaves || leaves.length < 3) continue;
				const key = `${def.name}/${goal.name}`;
				const group: GoalGroup = { key, plan: def.name, goalName: goal.name, leafNames: new Set(leaves.map((l) => l.name)), tasks: [] };
				groups.set(key, group);
				for (const n of group.leafNames) groupOfText.set(n, group);
			}
		}
		for (const t of inWindow) {
			const g = groupOfText.get(t.text.trim());
			if (g) g.tasks.push(t);
		}
		const grouped = new Set<PoolTask>();
		for (const g of groups.values()) for (const t of g.tasks) grouped.add(t);
		const plain = inWindow.filter((t) => !grouped.has(t));

		const renderTaskRow = (t: PoolTask, child?: boolean): void => {
			const row = chart.createDiv({ cls: "planboard-gantt-row" + (child ? " is-child" : "") });
			const suffix = t.text.includes("（") ? t.text.slice(t.text.indexOf("（") + 1, -1) : "";
			const label = row.createDiv({
				cls: "planboard-gantt-label",
				text: child && suffix ? suffix : t.text.slice(0, 14),
				attr: { title: t.text },
			});
			if (t.plan) label.setAttribute("data-plan", t.plan);
			const track = row.createDiv({ cls: "planboard-gantt-track" });
			const todayMark = track.createDiv({ cls: "planboard-gantt-today" });
			todayMark.style.left = `${((dayIndexOf(this.today, yearStart) - 1) / totalDays) * 100}%`;
			const { s, e } = this.ganttBarRange(t, yearStart, yearEnd, (d) => dayIndexOf(d, yearStart));
			this.renderGanttBar(track, t, s, e, totalDays);
		};

		for (const g of groups.values()) {
			if (g.tasks.length === 0) continue;
			const done = g.tasks.filter((t) => t.checked).length;
			const expanded = this.ganttExpandedGoals.has(g.key);

			const row = chart.createDiv({ cls: "planboard-gantt-row is-group" });
			row.addEventListener("click", () => {
				if (expanded) this.ganttExpandedGoals.delete(g.key);
				else this.ganttExpandedGoals.add(g.key);
				void this.renderGanttPanel();
			});
			const label = row.createDiv({
				cls: "planboard-gantt-label",
				attr: { title: `${g.goalName}：已完成 ${done}/${g.tasks.length}（点击展开/收起逐节条）` },
			});
			label.setText(g.goalName);
			if (g.plan) label.setAttribute("data-plan", g.plan);
			label.createSpan({ cls: "planboard-gantt-count", text: ` ${done}/${g.tasks.length} ${expanded ? "▾" : "▸"}` });
			const track = row.createDiv({ cls: "planboard-gantt-track" });
			const todayMark = track.createDiv({ cls: "planboard-gantt-today" });
			todayMark.style.left = `${((dayIndexOf(this.today, yearStart) - 1) / totalDays) * 100}%`;

			// 组条跨度 = 各叶 🛫min ~ 📅max；条内每叶一小段刻度（已完成实心/未完成半透明）
			const spans = g.tasks.map((t) => this.taskWindow(t));
			const spanStart = spans.reduce((min, w) => (w.start < min ? w.start : min), spans[0].start);
			const spanEnd = spans.reduce((max, w) => (w.end > max ? w.end : max), spans[0].end);
			const s = dayIndexOf(spanStart, yearStart);
			const e = dayIndexOf(spanEnd, yearStart);
			const bar = track.createDiv({ cls: "planboard-gantt-bar is-group" });
			if (g.plan) {
				bar.setAttribute("data-plan", g.plan);
				this.applyPlanColor(bar, g.plan);
			}
			bar.style.left = `${((s - 1) / totalDays) * 100}%`;
			bar.style.width = `${Math.max(((e - s + 1) / totalDays) * 100, 1.2)}%`;
			const spanLen = Math.max(e - s + 1, 1);
			for (const t of g.tasks) {
				const r = this.ganttBarRange(t, yearStart, yearEnd, (d) => dayIndexOf(d, yearStart));
				const tick = bar.createDiv({ cls: "planboard-gantt-tick " + (t.checked ? "is-done" : "is-open") });
				tick.style.left = `${((r.s - s) / spanLen) * 100}%`;
				tick.style.width = `${Math.max(((r.e - r.s + 1) / spanLen) * 100, 1.5)}%`;
			}

			if (expanded) for (const t of g.tasks) renderTaskRow(t, true);
		}
		for (const t of plain) renderTaskRow(t);

		this.renderUnscheduled(panel, unscheduled);
	}

	// -------------------------------------------------------------------------
	// Period panels (week / month / year)
	// -------------------------------------------------------------------------

	private async refreshPeriod(type: PeriodType): Promise<void> {
		this.panelEl?.empty();
		this.currentPanel = type;
		// ADR-0007: 年度视图的模式目标统计需要 BZG 快照（周/月用不到，代价仅一次小文件读）
		this.bzgSnapshot = await loadBzgSnapshot(this.app, this.plugin.settings.bzgEnabled);
		const stats = await computePeriodStats(
			this.app,
			this.plugin.settings.rootPath,
			this.today,
			type,
			this.plugin.settings.reviewWorkdays,
			this.bzgSnapshot
		);
		await this.settleIfNeeded(stats);
		await this.renderPeriodPanel(stats);
	}

	/**
	 * 周/月徽章结算（reward v3）：只在有任务数据时结算，成就.md 仅由
	 * settleWeek/settleMonth 写入（幂等，该周期已记录不重复写）。
	 */
	private async settleIfNeeded(stats: PeriodStats): Promise<void> {
		if (stats.type !== "week" && stats.type !== "month") return;
		if (stats.taskDone <= 0 || stats.taskTotal <= 0) return;
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = stats.label.slice(0, 4);
		this.selfWrite = true;
		try {
			if (stats.type === "week") {
				await settleWeek(this.app, root, year, stats.label, stats.taskDone, stats.taskTotal);
				// 周打卡完成率（习惯维度）：各计划打卡 Σdone/Σtotal
				const sum = stats.planRates.reduce(
					(acc, r) => ({ done: acc.done + r.done, total: acc.total + r.total }),
					{ done: 0, total: 0 }
				);
				if (sum.total > 0 && sum.done > 0) {
					await settleWeekCheckin(this.app, root, year, stats.label, sum.done, sum.total);
				}
			} else {
				await settleMonth(this.app, root, year, stats.label, stats.taskDone, stats.taskTotal);
				// 月打卡完成率（习惯维度）：各计划打卡 Σdone/Σtotal
				const sum = stats.planRates.reduce(
					(acc, r) => ({ done: acc.done + r.done, total: acc.total + r.total }),
					{ done: 0, total: 0 }
				);
				if (sum.total > 0 && sum.done > 0) {
					await settleMonthCheckin(this.app, root, year, stats.label, sum.done, sum.total);
				}
			}
		} finally {
			this.selfWrite = false;
		}
	}

	private async renderPeriodPanel(stats: PeriodStats): Promise<void> {
		if (!this.panelEl) return;
		const panel = this.panelEl;

		const header = panel.createDiv({ cls: "planboard-period-header" });
		header.createDiv({ cls: "planboard-period-title", text: PERIOD_TITLES[stats.type] });
		header.createDiv({ cls: "planboard-period-label", text: `${stats.label} · ${stats.rangeLabel}` });
		// --- 本周/本月徽章墙（reward v3.1：层级递进） ---
		if (stats.type === "week" || stats.type === "month") {
			const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
			const badges =
				stats.type === "week"
					? await readPeriodBadges(this.app, root, stats.label.slice(0, 4), stats.label)
					: await readMonthBadges(this.app, root, stats.label.slice(0, 4), stats.label);
			const wallCard = panel.createDiv({ cls: "planboard-card planboard-period-wall" });
			const wallHeader = wallCard.createDiv({ cls: "planboard-card-header" });
			wallHeader.createDiv({ cls: "planboard-card-title", text: stats.type === "week" ? "🏆 本周徽章墙" : "🏆 本月徽章墙" });
			if (badges.length > 0) {
				const row = wallCard.createDiv({ cls: "planboard-period-wall-row" });
				for (const b of badges) {
					const cls = b.includes("🥇") ? "is-gold" : b.includes("🥈") ? "is-silver" : "is-bronze";
					const span = row.createSpan({ cls: `planboard-badge ${cls}` });
					// v1.6: emoji 单独放大 + 去掉「（任务）/（打卡）」来源后缀
					const text = b.slice(2).replace(/（[^）]*）$/, "").trim();
					setBadgeContent(span, b.slice(0, 2), text);
				}
			} else {
				wallCard.createDiv({
					cls: "planboard-badge-wall-empty",
					text: "暂无徽章 · 本周任务完成 60%+ / 每日打卡 60%+ 即可获得",
				});
			}
		}

		if (stats.type === "year") {
			await this.renderYearPanel(panel, stats);
			return;
		}

		// --- 计划打卡率（v1.6: 2 列 grid 分栏；临时任务/任务统计卡已删除——信息在下方任务列表卡冗余） ---
		const grid = panel.createDiv({ cls: "planboard-plan-grid" });
		// v2.6: 过滤孤儿计划（历史打卡残留但当前已无定义的计划不显示，避免孤立卡无法管理）
		// v2.7: "当前计划" = 年度计划 frontmatter 里的计划（dailyTemplates 已废除，改为数据联动）
		const rootPath0 = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const defs = (await this.readAnnualPlanDefs(rootPath0, stats.label.slice(0, 4))) ?? [];
		const knownPlans = new Set(defs.map((d) => d.name));
		const liveRates = stats.planRates.filter((r) => knownPlans.has(r.plan));
		if (liveRates.length === 0) {
			grid.createDiv({ cls: "planboard-card planboard-empty-card", text: "周期内暂无打卡数据" });
		}
		const rates = [...liveRates].sort((a, b) => this.orderIndexOf(a.plan) - this.orderIndexOf(b.plan));
		for (const rate of rates) {
			const card = this.renderPlanRateCard(rate);
			grid.appendChild(card);
			this.attachPlanSortTo(card, grid, rate.plan);
		}
		// ADR-0001: 日定额计划卡（进度 = 累计实际量 ÷ 总量，与打卡率卡并列）
		const quotaCards = stats.quotaProgress
			.filter((q) => knownPlans.has(q.plan))
			.sort((a, b) => this.orderIndexOf(a.plan) - this.orderIndexOf(b.plan));
		for (const q of quotaCards) {
			grid.appendChild(this.renderQuotaCard(q));
		}

		const isWeek = stats.type === "week";
		const listCard = panel.createDiv({ cls: "planboard-card planboard-tasks-card" });
		const listHeader = listCard.createDiv({ cls: "planboard-card-header" });
		listHeader.createDiv({ cls: "planboard-card-title", text: isWeek ? "本周任务" : "本月任务" });
		const newBtn = listHeader.createEl("button", { cls: "planboard-btn planboard-btn-primary planboard-add-btn", text: "+ 新建任务" });
		newBtn.addEventListener("click", () => void this.openTaskModal(null));
		if (stats.tasks.length === 0) {
			listCard.createDiv({ cls: "planboard-empty", text: isWeek ? "本周暂无任务" : "本月暂无任务" });
		} else {
			const ul = listCard.createEl("ul", { cls: "planboard-checklist" });
			for (const t of stats.tasks) ul.appendChild(this.renderTaskItem(t));
		}
	}

	/** Year view: badge wall + plan detail cards (target + progress + the plan's task list). */
	private async renderYearPanel(panel: HTMLElement, stats: PeriodStats): Promise<void> {
		// v1.6: 「＋ 新增计划」按钮并入 period header（标题/日期同一行右侧）。
		const addPlanBtn = panel.createEl("button", {
			cls: "planboard-btn planboard-btn-outline planboard-year-add-btn",
			text: "＋ 新增计划",
		});
		addPlanBtn.addEventListener("click", () => void this.openPlanModal(null));
		const header = panel.querySelector<HTMLElement>(".planboard-period-header");
		if (header) {
			header.appendChild(addPlanBtn);
		} else {
			panel.appendChild(addPlanBtn);
		}

		// 徽章墙（reward v3）：计数从成就.md 读取。空状态也显示（引导用户）。
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const counts = await badgeCounts(this.app, root, stats.label);
		const totalBadges = counts.gold + counts.silver + counts.bronze;
		{
				// v1.6: 年度徽章墙与周/月同款卡片容器（宽度/样式一致）
				const wall = panel.createDiv({ cls: "planboard-card planboard-period-wall" });
				const wallHeader = wall.createDiv({ cls: "planboard-card-header" });
				wallHeader.createDiv({ cls: "planboard-card-title", text: "🏆 徽章墙" });
				if (totalBadges > 0) {
					const row = wall.createDiv({ cls: "planboard-period-wall-row" });
					if (counts.gold > 0) {
						const b = row.createSpan({ cls: "planboard-badge is-gold" });
						setBadgeContent(b, "🥇", `完美 ×${counts.gold}`);
					}
					if (counts.silver > 0) {
						const b = row.createSpan({ cls: "planboard-badge is-silver" });
						setBadgeContent(b, "🥈", `优秀 ×${counts.silver}`);
					}
					if (counts.bronze > 0) {
						const b = row.createSpan({ cls: "planboard-badge is-bronze" });
						setBadgeContent(b, "🥉", `合格 ×${counts.bronze}`);
					}
				} else {
					wall.createDiv({ cls: "planboard-badge-wall-empty", text: "暂无徽章 · 周/月任务完成 60%+ 即可获得" });
				}
			}
		if (stats.planProgress.length === 0) {
			panel.createDiv({
				cls: "planboard-card planboard-empty-card",
				text: "年度计划未配置，请在「年度计划.md」frontmatter 定义 plans。",
			});
		}
		// v1.7.4: 年度计划卡 JS 显式两列容器（替代 CSS columns——拖放精确：列内/跨列任意插入，
		//   不再受 columns 列平衡牵连；保留卡高自由）
		const grid = panel.createDiv({ cls: "planboard-plan-grid is-masonry" });
		const cols = [grid.createDiv({ cls: "planboard-plan-col" }), grid.createDiv({ cls: "planboard-plan-col" })];
		const progs = [...stats.planProgress].sort((a, b) => this.orderIndexOf(a.plan) - this.orderIndexOf(b.plan));
		const colH = [0, 0]; // 贪心分列：每次放进较矮列（含 saved 高度）
		for (const prog of progs) {
			const card = this.renderYearPlanCard(prog);
			// v1.7.2: 卡下边缘拖拽调整高度（每卡独立持久化）
			// v1.7.4: 任意保存值生效（含小于内容的——任务列表滚动承接，见 styles.css）
			const saved = this.plugin.settings.yearPlanHeights[prog.plan] ?? 0;
			if (saved > 0) {
				card.style.height = `${saved}px`;
				// v2.x: 拖过卡高打标——量化目标框改在卡内滚动承接（否则被 overflow:hidden 静默裁剪，见 styles.css）
				card.addClass("is-height-fixed");
			}
			const idx = colH[0] <= colH[1] ? 0 : 1;
			cols[idx].appendChild(card);
			colH[idx] += card.offsetHeight + 12; // 12 = 列内 gap
			this.attachPlanSortTo(card, grid, prog.plan, cols);
			attachResizeHandle(card, card, this.plugin, "yearPlanHeights", undefined, prog.plan);
		}

		// v1.6: 打卡统计卡整行展示（内部按计划分栏）
		const checkCard = panel.createDiv({ cls: "planboard-card planboard-plan-card" });
		checkCard.createDiv({ cls: "planboard-card-title", text: "打卡统计" });
		// v2.6: 只显示当前年度计划里存在的计划（过滤历史打卡残留的孤儿计划，如测试数据）
		const liveRates = stats.planRates.filter((r) => stats.planProgress.some((p) => p.plan === r.plan));
		if (liveRates.length === 0) {
			checkCard.createDiv({ cls: "planboard-empty", text: "暂无打卡数据" });
		} else {
			const statsGrid = checkCard.createDiv({ cls: "planboard-check-stats-grid" });
			for (const rate of liveRates) {
				const row = statsGrid.createDiv({ cls: "planboard-goal-row" });
				const head = row.createDiv({ cls: "planboard-goal-head" });
				head.createSpan({ cls: "planboard-plan-name", text: rate.plan });
				head.createSpan({ cls: "planboard-goal-target", text: `${rate.done}/${rate.total} 天` });
				const bar = row.createDiv({ cls: "planboard-progress-bar" });
				const fill = bar.createDiv({ cls: "planboard-progress-fill" });
				fill.style.width = `${rate.percent}%`;
				row.createDiv({ cls: "planboard-goal-meta", text: `${rate.percent}%` });
			}
		}
	}

	private renderYearPlanCard(prog: PlanProgress): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		card.setAttribute("data-plan-name", prog.plan);
		this.applyPlanColor(card, prog.plan);

		// 卡头：名称 + [＋ 新增量化目标]；计划编辑/删除移入右键菜单（v1.7.4，与"编辑用右键"标准一致）
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: prog.label ? `${prog.label} ${prog.plan}` : prog.plan });
		head.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((item) => item.setTitle("编辑计划").setIcon("pencil").onClick(() => void this.openPlanModal(toPlanDef(prog))));
			menu.addItem((item) => item.setTitle("删除计划").setIcon("trash").onClick(() => void this.deletePlan(prog)));
			menu.showAtMouseEvent(e);
		});

		// ADR-0001: 日定额计划卡——无量化目标/任务列表，展示配额信息
		if (prog.isQuota && prog.quota) {
			const q = prog.quota;
			if (prog.target) card.createDiv({ cls: "planboard-plan-target-line", text: prog.target });
			const bar = card.createDiv({ cls: "planboard-progress-bar" });
			const fill = bar.createDiv({ cls: "planboard-progress-fill" });
			fill.style.width = `${q.percent}%`;
			setTier(fill, q.percent);
			const meta = card.createDiv({ cls: "planboard-goal-meta" });
			meta.setText(`累计 ${formatQuotaAmount(q.actual)}/${formatQuotaAmount(q.total)}${q.unit} · ${q.percent}%`);
			const info = card.createDiv({ cls: "planboard-goal-meta planboard-quota-meta" });
			info.setText(`今日配额 ${formatQuotaAmount(q.dailyQuota)}${q.unit} · 截止 ${q.end}`);
			if (q.behind) {
				const warn = card.createDiv({ cls: "planboard-goal-meta planboard-quota-behind" });
				warn.setText(`进度落后：至今日应完成 ${formatQuotaAmount(q.expected)}${q.unit}（${formatQuotaAmount(q.dailyQuota)}${q.unit}/天）`);
			}
			return card;
		}

		const headActions = head.createDiv({ cls: "planboard-head-actions" });
		const goalBtn = headActions.createEl("button", {
			cls: "planboard-btn planboard-btn-outline planboard-goal-add-btn",
			attr: { "aria-label": "新增量化目标", title: "新增量化目标" },
		});
		goalBtn.setText("＋ 新增量化目标");
		goalBtn.addEventListener("click", () => void this.openGoalModal(prog.plan, null));

		if (prog.target) card.createDiv({ cls: "planboard-plan-target-line", text: prog.target });

		const bar = card.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${prog.percent}%`;
		setTier(fill, prog.percent);

		const meta = card.createDiv({ cls: "planboard-goal-meta" });
		if (prog.isNumeric) {
			// ADR-0006: 只有模式目标（无任务池事实）的计划 → 按目标达标率口径
			if (prog.targetCount === 0 && prog.goals.some((g) => g.modeStats)) {
				meta.setText(`按目标统计 · ${prog.percent}%`);
			} else {
				meta.setText(`已完成 ${prog.doneCount}/${prog.targetCount} · ${prog.percent}%`);
			}
		} else {
			meta.setText(`打卡率 ${prog.checkDone}/${prog.checkTotal} 天 · ${prog.percent}%`);
		}

		// 量化目标区（有 goals 的计划即显示——ADR-0006 后打卡型计划也可挂模式目标）。
		if (prog.goals.length > 0) {
			const goalsBox = card.createDiv({ cls: "planboard-goals-box" });
			goalsBox.createDiv({ cls: "planboard-goals-title", text: "🎯 量化目标" });
			for (const goal of prog.goals) {
				goalsBox.appendChild(this.renderYearGoalRow(goal, prog));
			}
			// v2.x: 恢复拖过的框高；框⇆任务区分隔条（CSS 仅在拖过卡高的卡显示，拖动调框高、任务区吃剩余）
			const savedBox = this.plugin.settings.yearGoalBoxHeights[prog.plan] ?? 0;
			if (savedBox > 0) {
				goalsBox.style.height = `${savedBox}px`;
				goalsBox.addClass("is-height-fixed");
			}
			attachGoalsDivider(card, goalsBox, this.plugin, prog.plan);
		}

		card.createDiv({ cls: "planboard-plan-tasks-title", text: "任务" });
		// Sort by 📅 ascending; completed tasks sink to the bottom.
		const sorted = sortTasksByDue(prog.tasks);
		if (sorted.length === 0) {
			card.createDiv({ cls: "planboard-empty", text: "暂无关联任务" });
		} else {
			const ul = card.createEl("ul", { cls: "planboard-checklist planboard-plan-tasks" });
			for (const t of sorted) ul.appendChild(this.renderTaskItem(t));
		}

		// v1.7.4: 量化目标按钮已移入卡头（head-actions ＋ icon）——原底部按钮在拖拽调高时悬空（实测确认）
		return card;
	}

	/** One quantified-goal row inside the year plan card: name + count + mini bar + [✏️][🗑️]. */
	private renderYearGoalRow(goal: PlanGoalProgress, prog: PlanProgress): HTMLElement {
		// ADR-0005: 章节型目标 = 目标行 + 章级迷你进度区；扁平目标结构与原状一致
		const block = createDiv({ cls: "planboard-goal-block" });
		const row = block.createDiv({ cls: "planboard-goal-row planboard-goal-row--mini" });
		// ADR-0006: 模式徽章（📖/🔁/📝/🏃；通用无徽章）
		const modeMeta = goal.mode ? GOAL_MODE_META[goal.mode] : null;
		if (modeMeta) {
			row.createSpan({ cls: "planboard-goal-mode-badge", attr: { title: `${modeMeta.label}模式：${modeMeta.desc}` }, text: modeMeta.emoji });
		}
		row.createDiv({ cls: "planboard-goal-name", text: goal.name });
		// ADR-0006/0010: 模式目标的计数文本走专属口径；阅读/通用沿用任务池口径
		let countText = `${goal.done}/${goal.total} ${goal.unit || "个"}`;
		if (goal.modeStats) {
			const s = goal.modeStats;
			if (s.mode === "review") countText = `达标 ${s.hitDays}/${s.dueDays} 天`;
			else if (s.mode === "diary") countText = `完成 ${s.hitDays}/${s.dueDays} 天`;
			else if (s.mode === "writing")
				countText = `累计 ${formatQuotaAmount(s.totalAmount ?? 0)}/${formatQuotaAmount(s.quotaTotal ?? 0)}${s.quotaUnit || "字"}${s.quotaBehind ? " · 落后" : ""}`;
			else countText = `打卡 ${s.hitDays}/${s.dueDays} 天`;
		}
		const countDiv = row.createDiv({ cls: "planboard-goal-count", text: countText });
		const ws = goal.modeStats?.mode === "writing" ? goal.modeStats : null;
		if (ws?.quotaDaily) {
			countDiv.setAttribute(
				"title",
				`每日配额 ${formatQuotaAmount(ws.quotaDaily)}${ws.quotaUnit || "字"}；动笔 ${ws.hitDays}/${ws.dueDays} 天${ws.quotaInitial ? `（接续初始 ${formatQuotaAmount(ws.quotaInitial)}${ws.quotaUnit || "字"}）` : ""}${ws.quotaBehind ? "；进度落后，多写几笔追上" : ""}`
			);
		}
		const bar = row.createDiv({ cls: "planboard-goal-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${goal.percent}%`;
		setTier(fill, goal.percent);
		const actions = row.createDiv({ cls: "planboard-item-actions planboard-goal-actions" });
		const editBtn = actions.createEl("button", {
			cls: "planboard-icon-btn",
			attr: { "aria-label": "编辑目标", title: "编辑目标" },
		});
		editBtn.setText("✏️");
		editBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.openGoalModal(prog.plan, goal);
		});
		const delBtn = actions.createEl("button", {
			cls: "planboard-icon-btn planboard-del-btn",
			attr: { "aria-label": "删除目标", title: "删除目标" },
		});
		delBtn.setText("🗑️");
		delBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.deleteGoal(prog, goal);
		});
		const groupRows = this.structureProgressOf(goal, prog);
		if (groupRows.length > 0) block.appendChild(this.renderChapterProgress(groupRows));
		// ADR-0006: 模式目标的补充指标行（连续天数/覆盖率/累计量）
		if (goal.modeStats) {
			const s = goal.modeStats;
			const parts: string[] = [];
			if (s.streak > 0) parts.push(`连续 ${s.streak} 天`);
			if (s.mode === "review") {
				if (s.covered != null && s.pool != null && s.pool > 0) parts.push(`覆盖 ${s.covered}/${s.pool} 篇`);
				if (s.todayActual != null) parts.push(`今日 ${s.todayActual} 篇`);
			}
			if (s.mode === "exercise" && (s.totalAmount ?? 0) > 0) {
				parts.push(`累计 ${formatQuotaAmount(s.totalAmount!)}${goal.unit || ""}`);
			}
			if (parts.length > 0) {
				block.createDiv({ cls: "planboard-goal-mode-meta", text: parts.join(" · ") });
			}
		}
		return block;
	}

	/**
	 * ADR-0005 v2: 从任务池事实统计各汇总组（倒数第二级，如章/篇）的已勾叶子数。
	 * 叶名精确匹配（展开结构与任务名一一对应），非结构型目标返回空数组。
	 */
	private structureProgressOf(
		goal: PlanGoalProgress,
		prog: PlanProgress
	): { label: string; done: number; total: number }[] {
		const leaves = expandGoalLeaves(goal.name, goal);
		if (!leaves || leaves.length === 0) return [];
		const groupList: { label: string; done: number; total: number }[] = [];
		const byLabel = new Map<string, { label: string; done: number; total: number }>();
		const groupOfName = new Map<string, string>();
		for (const l of leaves) {
			groupOfName.set(l.name, l.group);
			if (!l.group) continue;
			let g = byLabel.get(l.group);
			if (!g) {
				g = { label: l.group, done: 0, total: 0 };
				byLabel.set(l.group, g);
				groupList.push(g);
			}
			g.total++;
		}
		for (const t of prog.tasks) {
			if (t.plan !== prog.plan || !t.checked) continue;
			const grp = groupOfName.get(t.text.trim());
			if (!grp) continue;
			const g = byLabel.get(grp);
			if (g) g.done++;
		}
		for (const g of groupList) g.done = Math.min(g.done, g.total);
		return groupList;
	}

	/** ADR-0005: 组级迷你进度条（每组一行，正在读的高亮）；组数 > 12 折叠为紧凑单行。 */
	private renderChapterProgress(chapters: { label: string; done: number; total: number }[]): HTMLElement {
		if (chapters.length > 12) {
			const compact = createDiv({ cls: "planboard-goal-chapters planboard-goal-chapters--compact" });
			compact.setText(chapters.map((c) => `${c.label} ${c.done}/${c.total}`).join(" · "));
			return compact;
		}
		const box = createDiv({ cls: "planboard-goal-chapters" });
		// 当前组 = 第一个未读完的组（全部读完则无高亮）
		const currentIdx = chapters.findIndex((c) => c.done < c.total);
		for (let i = 0; i < chapters.length; i++) {
			const c = chapters[i];
			const cls = ["planboard-goal-chapter"];
			if (i === currentIdx) cls.push("planboard-goal-chapter--current");
			if (c.total > 0 && c.done >= c.total) cls.push("planboard-goal-chapter--done");
			const rowEl = box.createDiv({ cls: cls.join(" ") });
			rowEl.createSpan({ cls: "planboard-goal-chapter-name", text: c.label });
			const bar = rowEl.createDiv({ cls: "planboard-goal-bar" });
			const fill = bar.createDiv({ cls: "planboard-progress-fill" });
			const pct = c.total > 0 ? Math.round((c.done / c.total) * 100) : 0;
			fill.style.width = `${pct}%`;
			setTier(fill, pct);
			rowEl.createSpan({ cls: "planboard-goal-chapter-count", text: `${c.done}/${c.total}` });
		}
		return box;
	}

	private renderPlanRateCard(rate: PlanRate): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		card.setAttribute("data-plan-name", rate.plan);
		this.applyPlanColor(card, rate.plan);
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: rate.plan });
		head.createSpan({ cls: "planboard-plan-rate", text: `${rate.done}/${rate.total} 天` });
		const bar = card.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${rate.percent}%`;
		card.createDiv({ cls: "planboard-plan-percent", text: `${rate.percent}%` });
		return card;
	}

	/** ADR-0001: 日定额计划卡（周/月视图）：累计实际量进度 + 今日配额 + 落后提示。 */
	private renderQuotaCard(q: QuotaProgress): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		card.setAttribute("data-plan-name", q.plan);
		this.applyPlanColor(card, q.plan);
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: q.plan });
		head.createSpan({
			cls: "planboard-plan-rate",
			text: `${formatQuotaAmount(q.actual)}/${formatQuotaAmount(q.total)}${q.unit}`,
		});
		const bar = card.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${q.percent}%`;
		setTier(fill, q.percent);
		const pct = card.createDiv({ cls: "planboard-plan-percent", text: `${q.percent}%` });
		if (q.behind) pct.addClass("planboard-quota-behind");
		const meta = card.createDiv({ cls: "planboard-goal-meta planboard-quota-meta" });
		meta.setText(`今日配额 ${formatQuotaAmount(q.dailyQuota)}${q.unit} · 截止 ${q.end}${q.behind ? " · 进度落后" : ""}`);
		if (q.behind) meta.addClass("planboard-quota-behind");
		return card;
	}

	private renderTempSummaryCard(stats: PeriodStats): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: "临时任务" });
		head.createSpan({ cls: "planboard-plan-rate", text: `${stats.tempDone}/${stats.tempTotal} 完成` });
		const bar = card.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill planboard-progress-fill--temp" });
		fill.style.width = `${stats.tempPercent}%`;
		card.createDiv({ cls: "planboard-plan-percent", text: `${stats.tempPercent}%` });
		return card;
	}

	private renderTaskSummaryCard(stats: PeriodStats): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: "任务" });
		head.createSpan({ cls: "planboard-plan-rate", text: `${stats.taskDone}/${stats.taskTotal} 完成` });
		const bar = card.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${stats.taskPercent}%`;
		const pct = card.createDiv({ cls: "planboard-plan-percent" });
		pct.setText(`${stats.taskPercent}%`);
		const tier = tierFor(stats.taskDone, stats.taskTotal);
		if (tier) {
			pct.createSpan({ cls: `planboard-badge ${tier.cls}`, text: `${tier.emoji} ${tier.qualifier}` });
		}
		return card;
	}

	// -------------------------------------------------------------------------
	// Plan & goal management (v1.2: PlanEditModal / GoalEditModal / delete)
	// -------------------------------------------------------------------------

	/**
	 * Resolve the annual plan file (`{root}/{计划{year}}/年度计划.md`, falls back to `{root}/年度计划.md`).
	 * v1.0.5: create=true 时文件缺失则调用插件的 ensurePlanRoot 自愈重建（修复「未找到年度计划文件」：
	 * 首启目录骨架创建若因 vault 索引滞后静默失败，保存计划时兜底补建）。
	 */
	private async findAnnualPlanFile(create = false): Promise<TFile | null> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		for (const path of [`${root}/${yearDirName(year)}/年度计划.md`, `${root}/年度计划.md`]) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) return f;
		}
		if (!create) return null;
		try {
			await this.plugin.ensurePlanRoot();
		} catch (e) {
			new Notice(`创建年度计划文件失败：${(e as Error).message ?? String(e)}`);
			return null;
		}
		const p = `${root}/${yearDirName(year)}/年度计划.md`;
		const f2 = this.app.vault.getAbstractFileByPath(p);
		return f2 instanceof TFile ? f2 : null;
	}

	/** Per-plan `daily` flag from the raw frontmatter (preserved on write-back). */
	private readRawDailyMap(content: string): Record<string, boolean> {
		const out: Record<string, boolean> = {};
		for (const [name, obj] of readRawPlans(content)) {
			out[name] = obj.daily === true || obj.daily === "true";
		}
		return out;
	}

	private async openPlanModal(plan: PlanDef | null): Promise<void> {
		// 新增大类默认每日打卡（大类=日常例行，例外才取消勾选）
		let daily = true;
		if (plan) {
			const file = await this.findAnnualPlanFile();
			if (file) {
				const content = await this.app.vault.cachedRead(file);
				daily = this.readRawDailyMap(content)[plan.name] ?? false;
			}
		}
		new PlanEditModal(this.app, plan, daily, (input) => this.savePlan(plan, input)).open();
	}

	private async openGoalModal(planName: string, goal: PlanGoal | null): Promise<void> {
		// ADR-0006: 复习表单的联动状态提示（文献池大小 / 降级说明）
		let bzgHint = "";
		if (this.plugin.settings.bzgEnabled) {
			const snap = this.bzgSnapshot ?? (await loadBzgSnapshot(this.app, true));
			if (snap) {
				const pool = reviewPoolSize(this.app, snap);
				bzgHint = pool > 0 ? `BZG 联动已启用：每日实际复习量自动记录（文献池现有 ${pool} 篇）` : "BZG 联动已启用：每日实际复习量自动记录（未找到文献池文件夹，覆盖率不可用）";
			} else {
				bzgHint = "未检测到 BZG 插件：实际复习量需手动记录（每日行「实」按钮），或检查设置页联动开关";
			}
		} else {
			bzgHint = "BZG 联动已在设置中关闭：实际复习量手动记录（每日行「实」按钮）";
		}
		// ADR-0009: weave 桥探测（设置门控；fork 缺席 → null，向导静默走粘贴兜底流程）
		const weave = getWeaveBridge(this.app, this.plugin.settings.weaveEnabled);
		new GoalEditModal(this.app, planName, goal, bzgHint, weave, (input) => this.saveGoal(planName, goal, input)).open();
	}

	/** Save a new/edited plan category back to the annual frontmatter. Returns success. */
	private async savePlan(existing: PlanDef | null, input: PlanEditInput): Promise<boolean> {
		const file = await this.findAnnualPlanFile(true);
		if (!file) {
			new Notice("未找到年度计划文件");
			return false;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		const dailyMap = this.readRawDailyMap(content);

		if (existing) {
			const def = defs.find((d) => d.name === existing.name);
			if (!def) {
				new Notice("未找到该计划");
				return false;
			}
			if (input.name !== existing.name && defs.some((d) => d.name === input.name)) {
				new Notice(`已存在同名计划「${input.name}」`);
				return false;
			}
			def.name = input.name;
			def.label = input.label;
			def.action = input.action;
			def.target = input.target;
			def.tradingDay = input.tradingDay;
			if (input.color) def.color = input.color;
			dailyMap[input.name] = input.daily;
			if (input.name !== existing.name) delete dailyMap[existing.name];
		} else {
			if (defs.some((d) => d.name === input.name)) {
				new Notice(`已存在同名计划「${input.name}」`);
				return false;
			}
			defs.push({
				name: input.name,
				type: "check",
				target: input.target,
				targetCount: 0,
				goals: [],
				action: input.action,
				label: input.label,
				color: input.color || rotatePlanColor(defs),
				tradingDay: input.tradingDay,
				daily: input.daily,
			});
			dailyMap[input.name] = input.daily;
		}

		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, dailyMap);
			// 大类改名联动：任务池 + 每日笔记的 #计划/{旧名} → #计划/{新名}（防前缀误伤，跨年一致）
			if (existing && input.name !== existing.name) {
				const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
				const oldTag = `#计划/${existing.name}`;
				const newTag = `#计划/${input.name}`;
				const re = new RegExp(`${escapeRegExp(oldTag)}(?=\\s|$)`, "g");
				for (const tf of this.app.vault.getFiles()) {
					if (!tf.path.startsWith(root)) continue;
					const isPool = /(^|\/)任务\.md$/.test(tf.path);
					const isDaily = /\/每日\/\d{4}-\d{2}-\d{2}\.md$/.test(tf.path);
					if (!isPool && !isDaily) continue;
					const c = await this.app.vault.cachedRead(tf);
					if (!c.includes(oldTag)) continue;
					await this.app.vault.process(tf, (data) => data.replace(re, newTag));
				}
			}
			// 新增大类(每日打卡)：今日笔记补打卡项（模板只影响新建笔记，已有今日笔记需补）
			if (!existing && input.daily) {
				const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
				const todayPath = `${root}/${yearDirName(this.today.slice(0, 4))}/每日/${this.today}.md`;
				const todayFile = this.app.vault.getAbstractFileByPath(todayPath);
				if (todayFile instanceof TFile) {
					const todayContent = await this.app.vault.cachedRead(todayFile);
					if (!todayContent.includes(`#计划/${input.name}`)) {
					const line = buildCheckLine({
						name: composeCheckItemName(input.label, input.name),
						duration: input.action,
						plan: input.name,
						includeReview: false,
						date: this.today,
					});
						await this.app.vault.process(todayFile, (data) => appendCheckItem(data, line));
					}
				}
			}
		} finally {
			this.selfWrite = false;
		}
		new Notice("计划已保存");
		await this.refresh();
		return true;
	}

	/** Save a new/edited quantified goal back to its plan's goals array. Returns success. */
	private async saveGoal(planName: string, existing: PlanGoal | null, input: GoalInput): Promise<boolean> {
		// ADR-0016: 生活事项恒挂「日常生活」计划（从其他计划入口选了生活卡也归位）
		if (input.mode === "chore" && planName !== CHORE_PLAN_NAME) planName = CHORE_PLAN_NAME;
		if (input.mode === "chore" && !this.guardChoreName(input.name)) return false;
		const file = await this.findAnnualPlanFile(true);
		if (!file) {
			new Notice("未找到年度计划文件");
			return false;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		let def = defs.find((d) => d.name === planName);
		if (!def) {
			// ADR-0016: 生活计划缺则自愈创建（label 🏠）并预填缺省事项
			if (input.mode !== "chore") {
				new Notice("未找到该计划");
				return false;
			}
			def = this.ensureChorePlanDef(defs, input.name);
		}
		const goal: PlanGoal = { name: input.name, count: input.count, unit: input.unit || "个" };
		if (input.start) goal.start = input.start;
		if (input.end) goal.end = input.end;
		// ADR-0006/0010: 目标模式与每日量（review 下限必填；exercise 可选）。
		// 写作按章节（无字数配额）是任务池口径，不算模式目标——走结构分解/重排/接续全套
		const isModeGoal = !!input.mode && input.mode !== "reading" && !(input.mode === "writing" && !input.writingQuota);
		if (input.mode) goal.mode = input.mode;
		if (typeof input.floor === "number" && input.floor > 0) goal.floor = input.floor;
		// ADR-0016 生活模式：周期 + 逾期策略落盘（无量无单位，count 0）
		if (input.mode === "chore") {
			goal.unit = "";
			if (input.cycle) goal.cycle = input.cycle;
			if (input.overdue) goal.overdue = input.overdue;
		}
		// ADR-0010 写作按字数：目标级字数配额落盘 + 每日配额冻结（(总量−初始) ÷ 窗口天数，创建时算死）。
		// floor 冻结的配额数同时充当模式行识别记号（matchesModeLine「N字」）与「实」按钮记满语境。
		if (input.writingQuota) {
			const win = await this.resolveGoalWindow(input, this.plugin.settings.rootPath.replace(/\/+$/, ""), this.today.slice(0, 4));
			goal.writingQuota = {
				total: input.writingQuota.total,
				unit: "字",
				start: win.start,
				end: win.end,
				...(input.writingQuota.initial > 0 ? { initial: input.writingQuota.initial } : {}),
			};
			const daily = computeWritingDaily(input.writingQuota.total, input.writingQuota.initial, win.start, win.end);
			if (daily > 0) goal.floor = daily;
			goal.count = 0;
			goal.unit = "字";
		}
		// ADR-0009: 阅读器联动 sid（新建来自选书；编辑走旧流程时保留既有绑定，避免联动丢失）
		if (input.reader?.sid) goal.readerSid = input.reader.sid;
		else if (existing?.readerSid) goal.readerSid = existing.readerSid;
		// ADR-0009: 每叶锚点快照随目标落盘（确认步提取树推导；编辑走旧流程保留既有锚点）
		if (input.reader?.anchors?.length) goal.readerAnchors = input.reader.anchors.map((a) => ({ ...a }));
		else if (existing?.readerAnchors) goal.readerAnchors = existing.readerAnchors;
		// ADR-0005：结构型目标（多级 structure 或兼容 chapters）；count/单位由叶子推导
		const leaves = expandGoalLeaves(input.name, input);
		const isStructured = !isModeGoal && !!(leaves && leaves.length > 0);
		if (isStructured && leaves) {
			if (input.structure?.length) goal.structure = input.structure;
			if (input.chapters?.length) goal.chapters = input.chapters;
			goal.count = leaves.length;
			goal.unit = input.structure?.length
				? input.structure[input.structure.length - 1].unit
				: "节";
		}

		if (existing) {
			const idx = def.goals.findIndex((g) => g.name === existing.name);
			if (idx === -1) {
				new Notice("未找到该量化目标");
				return false;
			}
			if (input.name !== existing.name && def.goals.some((g) => g.name === input.name)) {
				new Notice(`同计划下已存在同名目标「${input.name}」`);
				return false;
			}
			// 改名联动：任务池中「旧名（第 N …）」任务改为新名，避免失联后重复分解
			if (input.name !== existing.name) {
				const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
				const year = this.today.slice(0, 4);
				if (isModeGoal) {
					// ADR-0006: 模式目标无任务池任务——改打卡行的目标名即可
					const oldName = existing.name;
					const newName = input.name;
					if (input.mode === "writing" && input.writingQuota) {
						// ADR-0010: 写作字数进度 = 历史每日行累计——只改今天会丢历史账，须扫全部每日文件
						const dailyDir = `${root}/${yearDirName(year)}/每日/`;
						const dailyFiles = this.app.vault
							.getFiles()
							.filter((f) => f.path.startsWith(dailyDir) && /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name));
						this.selfWrite = true;
						try {
							for (const f of dailyFiles) {
								await this.app.vault.process(f, (data) => {
									if (!data.includes(oldName)) return data;
									return data
										.split("\n")
										.map((l) => {
											const m = TASK_LINE_RE.exec(l);
											if (!m || m[3] !== planName || !m[2].includes(oldName)) return l;
											return l.replace(oldName, newName);
										})
										.join("\n");
								});
							}
						} finally {
							this.selfWrite = false;
						}
					} else {
						// 复习/日记/运动：进度 = 天数口径，历史行名称不影响累计——只改今日行。
						// ADR-0016: 生活事项行名易互为子串（洗碗/洗碗机），用 matchesModeLine 精确匹配防误伤
						const todayFile = this.getTodayFile();
						if (todayFile) {
							await this.app.vault.process(todayFile, (data) => {
								if (!data.includes(oldName)) return data;
								return data
									.split("\n")
									.map((l) => {
										const m = TASK_LINE_RE.exec(l);
										if (!m || m[3] !== planName) return l;
										const hit = input.mode === "chore"
											? matchesModeLine(m[2].trim(), oldName, 0, "")
											: m[2].includes(oldName);
										if (!hit) return l;
										return l.replace(oldName, newName);
									})
									.join("\n");
							});
						}
					}
				} else {
					const pool = this.app.vault.getAbstractFileByPath(`${root}/${yearDirName(year)}/任务.md`);
					if (pool instanceof TFile) {
						const oldPrefix = `${existing.name}（`;
						const newPrefix = `${input.name}（`;
						await this.app.vault.process(pool, (data) => {
							if (!data.includes(oldPrefix)) return data;
							return data
								.split("\n")
								.map((l) => (l.includes(oldPrefix) ? l.replace(oldPrefix, newPrefix) : l))
								.join("\n");
						});
					}
				}
			}
			def.goals[idx] = goal;
		} else {
			if (def.goals.some((g) => g.name === input.name)) {
				new Notice(`同计划下已存在同名目标「${input.name}」`);
				return false;
			}
			// ADR-0009: 同一本书同时只允许一个未完成目标（推进事实只落单一目标，避免勾选扇出）；
			// 跨计划查重——书架级约束而非计划级。「未完成」= 存在未勾叶（全勾完 = 已读完，
			// 允许建重读目标，与提示语承诺一致）
			if (input.reader?.sid) {
				const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
				const poolTasks = await listTasks(this.app, root, this.today.slice(0, 4));
				const dup = defs
					.flatMap((d) => d.goals.map((g) => ({ plan: d.name, g })))
					.filter((x) => x.g.readerSid === input.reader?.sid)
					.find((x) => {
						const ls = expandGoalLeaves(x.g.name, x.g) ?? [];
						if (ls.length === 0) return true;
						return ls.some((l) => {
							const t = poolTasks.find((p) => p.text.trim() === l.name);
							return !t || !t.checked;
						});
					});
				if (dup) {
					new Notice(`《${dup.g.name}》（计划「${dup.plan}」）正在读这本书（同书同时仅一个未完成目标）；读完后再建重读目标`);
					return false;
				}
			}
			def.goals.push(goal);
		}

		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, this.readRawDailyMap(content));
		} finally {
			this.selfWrite = false;
		}
		new Notice("量化目标已保存");
		// v1.5 联动 + 修复：编辑目标后重建分解任务；【新建目标同样触发分解】（此前新建只写文件不生成任务）
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const pool = this.app.vault.getAbstractFileByPath(`${root}/${yearDirName(year)}/任务.md`);
		if (isModeGoal) {
			// ADR-0006: 模式目标（复习/日记/运动）不进任务池分解引擎——
			// 今日打卡行由 ensureModeGoalTracking 在刷新链中惰性补写，此处无需重建任务
		} else if (existing) {
			if (isStructured && leaves) {
				// ADR-0005: 结构编辑 = 按名对账 + 剩余重排——只删「新序列里已不存在」的任务，
				// 同名叶子保留（勾选状态不丢，调节奏不丢进度）；未勾的叶子作为剩余序列从新窗口
				// 第一天起重新摊开（重启/调速），已勾的保留原日期作进度记录、不占新窗口位置
				//（ADR-0009: 与接续阅读新建共用同一重排实现）
				const { rewritten: m, end: gEnd } = await this.rescheduleRemainingReading(planName, input.name, leaves, input, root, year);
				// 时间窗已结束 → 分解被窗口守卫跳过，显式提示避免静默 0 任务
				if (gEnd < this.today) {
					new Notice(`注意：目标时间窗已于 ${gEnd} 结束，未生成分解任务；重新安排请编辑时间窗`);
				}
				// 墓碑语义：新序列里仍存在的名字保留墓碑（用户手动删过的节编辑后不复活），
				// 其余（含改名后的旧前缀残留、已消失的章节名）一律清除
				const valid = new Set(leaves.map((l) => l.name));
				this.pruneAutoTombstones([`${existing.name}（`, `${input.name}（`], valid);
				await this.ensureAutoTasksForToday(root, year);
				new Notice(m > 0 ? `目标已更新：已完成章节保留记录，剩余 ${m} 节按新时间窗从头重排` : "目标已更新：全部章节已完成，无待重排内容");
			} else {
				if (pool instanceof TFile) {
					const prefix = `${existing.name}（`;
					this.selfWrite = true;
					try {
						await this.app.vault.process(pool, (data) =>
							data
								.split("\n")
								.filter((l) => {
									const m = TASK_LINE_RE.exec(l);
									if (!m) return true;
									return !(m[3] === planName && l.includes(prefix));
								})
								.join("\n")
						);
					} finally {
						this.selfWrite = false;
					}
				}
				// v1.0.4: 目标重建 = 全量重生成，先清掉该目标的删除墓碑（旧名一并清，防残留）
				this.clearAutoTombstones(`${existing.name}（`);
				this.clearAutoTombstones(`${input.name}（`);
				await this.ensureAutoTasksForToday(root, year);
				// 时间窗已结束 → 重建被窗口守卫跳过，显式提示避免静默 0 任务
				const { end: flatEnd } = await this.resolveGoalWindow(input, root, year);
				if (flatEnd < this.today) {
					new Notice(`注意：目标时间窗已于 ${flatEnd} 结束，未生成分解任务；重新安排请编辑时间窗`);
				}
				new Notice("目标已更新，分解任务已按新设置重建");
			}
		} else {
			// v1.0.4: 新建同名目标时清掉旧墓碑，避免分解被误跳过
			this.clearAutoTombstones(`${input.name}（`);
			// ADR-0009 接续阅读 / ADR-0010 接续写作：先把已越过叶子以已勾态写入任务池（日期在窗口前一日，
			// 作进度记录、不占每日分配）；分解引擎幂等跳过已存在任务名，剩余叶子随后重摊
			const resumeN = isStructured && leaves ? Math.min(input.reader?.resumeLeaves ?? input.resumeLeaves ?? 0, leaves.length - 1) : 0;
			if (resumeN > 0 && leaves) {
				const { start: gStart } = await this.resolveGoalWindow(input, root, year);
				const anchor = formatDate(addDays(parseDateString(gStart), -1));
				this.selfWrite = true;
				try {
					for (const leaf of leaves.slice(0, resumeN)) {
						await addTask(this.app, root, year, { text: leaf.name, plan: planName, start: anchor, due: anchor, checked: true });
					}
				} finally {
					this.selfWrite = false;
				}
			}
			await this.ensureAutoTasksForToday(root, year);
			// ADR-0009: 剩余（未勾）叶子按剩余序列从窗口第一天重摊（与编辑路径同一公式）
			if (resumeN > 0 && leaves) {
				await this.rescheduleRemainingReading(planName, input.name, leaves, input, root, year);
			}
			new Notice(
				resumeN > 0
					? input.mode === "writing"
						? `目标已保存：已写完 ${resumeN} 章记为完成，剩余章节按新窗口重摊`
						: `目标已保存：已读 ${resumeN} 节记为完成，剩余叶子按新窗口重摊`
					: input.mode === "chore"
						? "生活事项已保存，该做日会自动出现在当日清单"
						: "目标已保存，分解任务已生成"
			);
		}
		await this.refresh();
		return true;
	}

	/** ADR-0016: 生活事项编辑弹窗入口（父行「＋」/ 管理弹窗共用）。 */
	private openChoreItemModal(planName: string, existing: PlanGoal | null): void {
		new ChoreItemModal(this.app, existing, (input) => this.saveChoreGoal(planName, existing, input)).open();
	}

	/** ADR-0016: 生活事项管理弹窗入口（父行「☰」）。 */
	private openChoreManageModal(planName: string): void {
		const goals = this.planProgress
			.find((p) => p.plan === planName)
			?.goals.filter((g) => g.mode === "chore") ?? [];
		new ChoreManageModal(this.app, planName, goals, {
			onEdit: (g) => this.openChoreItemModal(planName, g),
			onDelete: (g) => this.deleteChoreGoal(planName, g.name),
			onAdd: () => this.openChoreItemModal(planName, null),
		}).open();
	}

	/**
	 * ADR-0016: 生活事项 frontmatter 目标组装（无量无单位，count 0；postpone 才落盘）。
	 * saveGoal（向导路径）与 saveChoreGoal（事项弹窗路径）共用一份口径。
	 */
	private makeChoreGoal(input: ChoreItemInput): PlanGoal {
		const goal: PlanGoal = { name: input.name, count: 0, unit: "", mode: "chore", cycle: input.cycle };
		if (input.overdue) goal.overdue = input.overdue;
		return goal;
	}

	/**
	 * ADR-0016: 找到或自愈创建「日常生活」计划 def（label 🏠），创建时预填缺省事项
	 * （与 exceptName 同名跳过，可后续在管理弹窗改/删）。两处保存路径共用，防漂移。
	 */
	private ensureChorePlanDef(defs: PlanDef[], exceptName: string): PlanDef {
		let def = defs.find((d) => d.name === CHORE_PLAN_NAME);
		if (!def) {
			def = {
				name: CHORE_PLAN_NAME,
				type: "check",
				target: "日常生活事项循环打卡",
				targetCount: 0,
				goals: [],
				quota: null,
				action: "",
				label: "🏠",
				color: "",
				tradingDay: false,
				daily: true,
			};
			defs.push(def);
			for (const item of CHORE_DEFAULT_ITEMS) {
				if (item.name === exceptName || def.goals.some((g) => g.name === item.name)) continue;
				def.goals.push({ name: item.name, count: 0, unit: "", mode: "chore", cycle: item.cycle });
			}
		}
		return def;
	}

	/** ADR-0016: 事项名守卫——不得与承载计划名同名（剥 emoji 后父行文本恰为计划名，同名会让父行被误判成事项行）。 */
	private guardChoreName(name: string): boolean {
		if (name !== CHORE_PLAN_NAME) return true;
		new Notice(`事项名不能叫「${CHORE_PLAN_NAME}」：会与大项行混淆，换一个名字`);
		return false;
	}

	/**
	 * ADR-0016: 保存生活事项（新增/编辑）——写入年度计划 frontmatter（唯一事实源）。
	 * 改名只重写今日行（历史行文件事实为准，与复习/运动改名同口径）。
	 */
	private async saveChoreGoal(planName: string, existing: PlanGoal | null, input: ChoreItemInput): Promise<boolean> {
		if (!this.guardChoreName(input.name)) return false;
		const file = await this.findAnnualPlanFile(true);
		if (!file) {
			new Notice("未找到年度计划文件");
			return false;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		const def = this.ensureChorePlanDef(defs, input.name);
		const goal = this.makeChoreGoal(input);
		if (existing) {
			const idx = def.goals.findIndex((g) => g.mode === "chore" && g.name === existing.name);
			if (idx === -1) {
				new Notice("未找到该生活事项");
				return false;
			}
			if (input.name !== existing.name && def.goals.some((g) => g.name === input.name)) {
				new Notice(`已存在同名事项「${input.name}」`);
				return false;
			}
			def.goals[idx] = goal;
			// 改名联动：只改今日行（历史行不动，进度以文件事实为准）
			if (input.name !== existing.name) {
				const todayFile = this.getTodayFile();
				if (todayFile) {
					this.selfWrite = true;
					try {
						await this.app.vault.process(todayFile, (data) => {
							if (!data.includes(existing.name)) return data;
							return data
								.split("\n")
								.map((l) => {
									const m = TASK_LINE_RE.exec(l);
									if (!m || m[3] !== planName || !matchesModeLine(m[2].trim(), existing.name, 0, "")) return l;
									return l.replace(existing.name, input.name);
								})
								.join("\n");
						});
					} finally {
						this.selfWrite = false;
					}
				}
			}
		} else {
			if (def.goals.some((g) => g.name === input.name)) {
				new Notice(`已存在同名事项「${input.name}」`);
				return false;
			}
			def.goals.push(goal);
		}
		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, this.readRawDailyMap(content));
		} finally {
			this.selfWrite = false;
		}
		new Notice("生活事项已保存");
		await this.refresh();
		return true;
	}

	/**
	 * ADR-0016: 删除生活事项——从 frontmatter 移除 + 今日未勾行随之移除（挂账无主，留着会以
	 * 孤儿行身份被误认成父行）；已勾行与历史文件原样保留（文件事实为准）。
	 */
	private async deleteChoreGoal(planName: string, goalName: string): Promise<boolean> {
		const file = await this.findAnnualPlanFile(true);
		if (!file) {
			new Notice("未找到年度计划文件");
			return false;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		const def = defs.find((d) => d.name === planName);
		if (!def) {
			new Notice("未找到该计划");
			return false;
		}
		const before = def.goals.length;
		def.goals = def.goals.filter((g) => !(g.mode === "chore" && g.name === goalName));
		if (def.goals.length === before) {
			new Notice("未找到该生活事项");
			return false;
		}
		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, this.readRawDailyMap(content));
			// 今日未勾行移除（已勾行 = 完成记录，保留）
			const todayFile = this.getTodayFile();
			if (todayFile) {
				const todayContent = await this.app.vault.cachedRead(todayFile);
				const { uncheckedItemLines } = this.choreLineShapes(todayContent, planName, [goalName]);
				if (uncheckedItemLines.length > 0) {
					await this.app.vault.process(todayFile, (data) =>
						uncheckedItemLines.reduce((acc, l) => removeLine(acc, l.line, l.raw), data)
					);
				}
			}
		} finally {
			this.selfWrite = false;
		}
		new Notice(`生活事项「${goalName}」已删除（已完成的打卡记录保留）`);
		await this.refresh();
		return true;
	}

	/**
	 * ADR-0005/0009：剩余（未勾）叶子从窗口首日按剩余序列重摊（已勾的保留原日期作
	 * 进度记录，不占新窗口位置）。编辑目标与接续阅读新建共用同一公式；
	 * 返回重排叶数与窗口终点（窗口守卫提示用）。
	 */
	private async rescheduleRemainingReading(
		planName: string,
		goalName: string,
		leaves: GoalLeaf[],
		input: GoalInput,
		root: string,
		year: string
	): Promise<{ rewritten: number; end: string }> {
		// 重排基准窗口：显式 start/end，缺省回退年度计划周期，再缺省自然年（与分解引擎同一口径）
		const { start: gStart, end: gEnd } = await this.resolveGoalWindow(input, root, year);
		const pool = this.app.vault.getAbstractFileByPath(`${root}/${yearDirName(year)}/任务.md`);
		let m = 0;
		if (pool instanceof TFile) {
			const valid = new Set(leaves.map((l) => l.name));
			// 剩余序列 = 任务池事实中未勾的有效叶子（按书序重新编号 1..m）
			const poolTasks = await listTasks(this.app, root, year);
			const remaining = new Set(
				poolTasks.filter((t) => !t.checked && valid.has(t.text.trim())).map((t) => t.text.trim())
			);
			const leafIndexByName = new Map<string, number>();
			for (const l of leaves) {
				if (remaining.has(l.name)) leafIndexByName.set(l.name, ++m);
			}
			if (m > 0) {
				const ctx: ChapterRescheduleContext = {
					plan: planName,
					prefix: `${goalName}（`,
					valid,
					leafIndexByName,
					total: m,
					start: gStart,
					end: gEnd,
				};
				this.selfWrite = true;
				try {
					await this.app.vault.process(pool, (data) =>
						data
							.split("\n")
							.map((l) => rescheduleChapterLine(l, ctx))
							.filter((l): l is string => l !== null)
							.join("\n")
					);
				} finally {
					this.selfWrite = false;
				}
			}
		}
		return { rewritten: m, end: gEnd };
	}

	/** Delete a plan category + all of its pool tasks (incl. decomposed). */
	private async deletePlan(prog: PlanProgress): Promise<void> {
		if (!await confirmDialog(this.app, `删除计划「${prog.plan}」将同时删除其全部任务（含分解任务），确定？`, { danger: true })) return;
		const file = await this.findAnnualPlanFile();
		if (!file) {
			new Notice("未找到年度计划文件");
			return;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		const idx = defs.findIndex((d) => d.name === prog.plan);
		if (idx === -1) return;
		defs.splice(idx, 1);
		const dailyMap = this.readRawDailyMap(content);
		delete dailyMap[prog.plan];

		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		const toDelete = tasks.filter((t) => t.plan === prog.plan).sort((a, b) => b.line - a.line);

		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, dailyMap);
			for (const t of toDelete) await deleteTask(this.app, t);
			// v1.0.4: 计划连同任务删除 → 清掉这些任务的删除墓碑
			const deletedTexts = new Set(toDelete.map((t) => t.text.trim()));
			this.plugin.settings.deletedAutoTasks = (this.plugin.settings.deletedAutoTasks ?? []).filter((n) => !deletedTexts.has(n));
			void this.plugin.saveSettings();
			// v1.4 联动：清理今日笔记中该计划的打卡行（v2.7: dailyTemplates 已废除，打卡默认项由年度计划自动推导）
			const todayFile = this.getTodayFile();
			if (todayFile) {
				const todayContent = await this.app.vault.cachedRead(todayFile);
				const lines = todayContent.split("\n");
				const keep = lines.filter((l) => {
					const m = TASK_LINE_RE.exec(l);
					return !m || (m[3] ?? null) !== prog.plan;
				});
				if (keep.length !== lines.length) {
					await this.app.vault.modify(todayFile, keep.join("\n"));
				}
			}
		} finally {
			this.selfWrite = false;
		}
		new Notice("计划已删除");
		await this.refresh();
	}

	/** Delete a quantified goal + its decomposed pool tasks. */
	private async deleteGoal(prog: PlanProgress, goal: PlanGoalProgress): Promise<void> {
		if (!await confirmDialog(this.app, `删除量化目标「${goal.name}」及其分解任务？`, { danger: true })) return;
		const file = await this.findAnnualPlanFile();
		if (!file) {
			new Notice("未找到年度计划文件");
			return;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		const def = defs.find((d) => d.name === prog.plan);
		if (!def) {
			new Notice("未找到该计划");
			return;
		}
		const idx = def.goals.findIndex((g) => g.name === goal.name);
		if (idx === -1) return;
		def.goals.splice(idx, 1);

		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		const prefix = `${goal.name}（`;
		const toDelete = tasks
			.filter((t) => t.plan === prog.plan && t.text.trim().startsWith(prefix))
			.sort((a, b) => b.line - a.line);

		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, this.readRawDailyMap(content));
			for (const t of toDelete) await deleteTask(this.app, t);
			// v1.0.4: 目标已删除 → 其分解任务墓碑随之作废
			this.clearAutoTombstones(`${goal.name}（`);
		} finally {
			this.selfWrite = false;
		}
		new Notice("量化目标已删除");
		await this.refresh();
	}

	/** Whether the pool already has auto tasks named `{goal.name}（第 N …」. */
	private async goalHasDecomposedTasks(planName: string, goalName: string): Promise<boolean> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		return tasks.some((t) => t.plan === planName && t.text.trim().startsWith(`${goalName}（`));
	}

	// -------------------------------------------------------------------------
	// Plan color styles (settings-driven, applied via setCssProps — no <style> elements)
	// -------------------------------------------------------------------------

	/** 计划名 → 颜色变量集（setCssProps 用）。 */
	private planColorVars: Record<string, Record<string, string>> = {};

	/** 在渲染元素上应用计划色（CSS 变量方式，替代被禁的 <style> 注入）。 */
	applyPlanColor(el: HTMLElement, plan: string | undefined | null): void {
		if (!plan) return;
		const vars = this.planColorVars[plan];
		if (!vars) return;
		el.setCssProps(vars);
	}

	private async injectPlanColorStyles(): Promise<void> {
		// settings 优先，年度计划 frontmatter 的 color 字段兜底（spec v1.2 #6）。
		const colors: Record<string, string> = { ...(this.plugin.settings.planColors ?? {}) };
		const rootPath = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const defs = await this.readAnnualPlanDefs(rootPath, year);
		const planNames = new Set<string>();
		if (defs) {
			for (const def of defs) {
				planNames.add(def.name);
				if (def.color && !(def.name in colors)) colors[def.name] = def.color;
			}
		}
		// v1.7.2: 未配置颜色的计划 → 调色板哈希分配（卡片颜色区分）
		const PALETTE = ["#e07b5a", "#5a9e6f", "#5b8dd6", "#c77dbf", "#d6a24b", "#6fb3b8", "#b86b6b", "#7d8fd6", "#8aa65a", "#d68a5b"];
		const hashName = (s: string): number => {
			let h = 0;
			for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
			return h;
		};
		let idx = 0;
		for (const name of planNames) {
			if (!(name in colors)) {
				colors[name] = PALETTE[hashName(name) % PALETTE.length];
				// 避免相邻计划撞色：与已分配色冲突则顺延
				const used = new Set(Object.values(colors));
				let guard = 0;
				while (used.has(colors[name]) && guard++ < PALETTE.length) {
					colors[name] = PALETTE[(hashName(name) + idx++) % PALETTE.length];
				}
			}
		}
		this.planColorVars = {};
		for (const [plan, color] of Object.entries(colors)) {
			const bg = hexToRgba(color, 0.08); /* v1.7.4: 标签降饱和（0.14→0.08），降"彩虹糖"感 */
			const barBg = hexToRgba(color, 0.55);
			this.planColorVars[plan] = {
				"--pb-accent": color,
				"--pb-accent-bg": bg,
				"--pb-accent-dim": hexToRgba(color, 0.28),
				"--plan-tag-color": color,
				"--plan-tag-bg": bg,
				"--plan-gantt-bg": barBg,
				"--plan-gantt-border": color,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarize(tasks: PoolTask[]): { total: number; done: number; percent: number } {
	const total = tasks.length;
	const done = tasks.filter((t) => t.checked).length;
	return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Derive a task's status column (spec v1.3). Undated, unchecked tasks → "todo". */
function taskStatus(t: PoolTask, today: string): "todo" | "doing" | "done" {
	if (t.checked) return "done";
	if (t.start && today >= t.start && (!t.due || today <= t.due)) return "doing";
	return "todo";
}

/** Sort pool tasks by due date ascending; completed tasks sink to the bottom. */
function sortTasksByDue(tasks: PoolTask[]): PoolTask[] {
	return [...tasks].sort((a, b) => {
		if (a.checked !== b.checked) return a.checked ? 1 : -1;
		const ad = a.due ?? "9999-12-31";
		const bd = b.due ?? "9999-12-31";
		return ad < bd ? -1 : ad > bd ? 1 : 0;
	});
}

/** ADR-0016: 生活事项表单提交值。 */
interface ChoreItemInput {
	name: string;
	cycle: GoalCycle;
	overdue?: ChoreOverdue;
}

const CHORE_WEEKDAY_LABELS = CHORE_WEEKDAY_SHORT;
/** ADR-0016: 生活计划缺省事项（首次自动建计划时预填，名称撞车跳过，均可改/删）。 */
const CHORE_DEFAULT_ITEMS: { name: string; cycle: GoalCycle }[] = [
	{ name: "洗碗", cycle: { unit: "day", days: [] } },
	{ name: "做卫生", cycle: { unit: "week", days: [0] } },
	{ name: "买菜", cycle: { unit: "week", days: [1, 4] } },
];

/**
 * ADR-0016: 生活事项编辑弹窗（新增/编辑）——名称 + 固定日子式周期（天/周/月/年）
 * + 逾期策略（放弃/往后延）。周多选星期、月多号逗号分隔、年月+日两输入。
 */
class ChoreItemModal extends Modal {
	private existing: PlanGoal | null;
	private onSubmit: (input: ChoreItemInput) => Promise<boolean>;

	private nameValue = "";
	private unitValue: GoalCycle["unit"] = "day";
	private weekDays: number[] = [0];
	private monthDaysValue = "1";
	private yearMonthValue = "1";
	private yearDayValue = "1";
	private overdueValue: ChoreOverdue = "skip";

	constructor(app: App, existing: PlanGoal | null, onSubmit: (input: ChoreItemInput) => Promise<boolean>) {
		super(app);
		this.existing = existing;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		if (this.existing) {
			this.nameValue = this.existing.name;
			const c = this.existing.cycle;
			if (c) {
				this.unitValue = c.unit;
				if (c.unit === "week") this.weekDays = c.days.length > 0 ? [...c.days] : [0];
				else if (c.unit === "month") this.monthDaysValue = c.days.join(", ");
				else if (c.unit === "year") {
					this.yearMonthValue = String(c.days[0] ?? 1);
					this.yearDayValue = String(c.days[1] ?? 1);
				}
			}
			if (this.existing.overdue === "postpone") this.overdueValue = "postpone";
		}
		this.renderModal();
	}

	private renderModal(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: this.existing ? "编辑生活事项" : "新增生活事项" });

		new Setting(contentEl).setName("事项名称").addText((text) => {
			text.setValue(this.nameValue);
			text.setPlaceholder("例如：洗碗 / 做卫生 / 买菜");
			text.inputEl.addEventListener("input", () => {
				this.nameValue = text.inputEl.value;
			});
		});

		new Setting(contentEl).setName("重复周期").setDesc("只有轮到的日子，事项才出现在当日清单").addDropdown((drop) => {
			drop.addOption("day", "每天");
			drop.addOption("week", "每周…（选星期）");
			drop.addOption("month", "每月…（选几号）");
			drop.addOption("year", "每年…（选月日）");
			drop.setValue(this.unitValue);
			drop.onChange((v) => {
				this.unitValue = (["day", "week", "month", "year"] as const).includes(v as GoalCycle["unit"])
					? (v as GoalCycle["unit"])
					: "day";
				this.renderModal();
			});
		});

		if (this.unitValue === "week") {
			const wrap = new Setting(contentEl).setName("每周几（可多选）").controlEl;
			const box = wrap.createDiv({ cls: "planboard-chore-weekdays" });
			for (let d = 0; d < 7; d++) {
				const b = box.createEl("button", {
					cls: "planboard-chore-weekday" + (this.weekDays.includes(d) ? " is-active" : ""),
					text: CHORE_WEEKDAY_LABELS[d],
					attr: { type: "button", title: `星期${CHORE_WEEKDAY_LABELS[d]}` },
				});
				b.addEventListener("click", () => {
					if (this.weekDays.includes(d)) this.weekDays = this.weekDays.filter((x) => x !== d);
					else this.weekDays = [...this.weekDays, d].sort((a, c) => a - c);
					b.toggleClass("is-active", this.weekDays.includes(d));
				});
			}
		} else if (this.unitValue === "month") {
			new Setting(contentEl).setName("每月几号（可多选，逗号分隔）").setDesc("当月没有的号（如 31 号遇小月）自动落到当月最后一天").addText((text) => {
				text.setValue(this.monthDaysValue);
				text.setPlaceholder("例如：1, 11, 21");
				text.inputEl.addEventListener("input", () => {
					this.monthDaysValue = text.inputEl.value;
				});
			});
		} else if (this.unitValue === "year") {
			new Setting(contentEl).setName("每年几月几日").addText((text) => {
				text.setValue(this.yearMonthValue);
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "12";
				text.setPlaceholder("月");
				text.inputEl.addEventListener("input", () => {
					this.yearMonthValue = text.inputEl.value;
				});
			}).addText((text) => {
				text.setValue(this.yearDayValue);
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "31";
				text.setPlaceholder("日");
				text.inputEl.addEventListener("input", () => {
					this.yearDayValue = text.inputEl.value;
				});
			});
		}

		new Setting(contentEl).setName("漏了怎么办").setDesc("放弃 = 当天没做该次就消失；往后延 = 每天挂出提醒，补做一次即清账").addDropdown((drop) => {
			drop.addOption("skip", "放弃（漏了就漏了）");
			drop.addOption("postpone", "往后延（挂账到补做）");
			drop.setValue(this.overdueValue);
			drop.onChange((v) => {
				this.overdueValue = v === "postpone" ? "postpone" : "skip";
			});
		});

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		ok.addEventListener("click", () => void this.save());
	}

	private async save(): Promise<void> {
		const name = this.nameValue.trim();
		if (!name) {
			new Notice("请输入事项名称");
			return;
		}
		let cycle: GoalCycle;
		if (this.unitValue === "day") {
			cycle = { unit: "day", days: [] };
		} else if (this.unitValue === "week") {
			if (this.weekDays.length === 0) {
				new Notice("每周至少选一天");
				return;
			}
			cycle = { unit: "week", days: [...new Set(this.weekDays)].sort((a, b) => a - b) };
		} else if (this.unitValue === "month") {
			const days = [...new Set(
				this.monthDaysValue
					.replace(/[[\]]/g, "")
					.split(/[,，\s]+/)
					.map((s) => parseInt(s, 10))
					.filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
			)].sort((a, b) => a - b);
			if (days.length === 0) {
				new Notice("请填写有效日期（1~31，逗号分隔）");
				return;
			}
			cycle = { unit: "month", days };
		} else {
			const mm = parseInt(this.yearMonthValue, 10);
			const dd = parseInt(this.yearDayValue, 10);
			if (!Number.isFinite(mm) || mm < 1 || mm > 12 || !Number.isFinite(dd) || dd < 1 || dd > 31) {
				new Notice("请填写有效的月（1~12）与日（1~31）");
				return;
			}
			cycle = { unit: "year", days: [mm, dd] };
		}
		const input: ChoreItemInput = { name, cycle };
		if (this.overdueValue === "postpone") input.overdue = "postpone";
		const saved = await this.onSubmit(input);
		if (saved) this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** ADR-0016: 生活事项管理弹窗——全部事项一览（周期文案 + 编辑/两步确认删除）+ 新增入口。 */
class ChoreManageModal extends Modal {
	private planName: string;
	private goals: PlanGoal[];
	private onEdit: (goal: PlanGoal) => void;
	private onDelete: (goal: PlanGoal) => Promise<boolean>;
	private onAdd: () => void;

	constructor(
		app: App,
		planName: string,
		goals: PlanGoal[],
		handlers: { onEdit: (goal: PlanGoal) => void; onDelete: (goal: PlanGoal) => Promise<boolean>; onAdd: () => void }
	) {
		super(app);
		this.planName = planName;
		this.goals = goals.map((g) => g);
		this.onEdit = handlers.onEdit;
		this.onDelete = handlers.onDelete;
		this.onAdd = handlers.onAdd;
	}

	onOpen(): void {
		this.renderList();
	}

	private renderList(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: `管理生活事项（${this.planName}）` });
		if (this.goals.length === 0) {
			contentEl.createDiv({ cls: "planboard-goal-preview", text: "还没有生活事项，点下方「新增事项」添加" });
		}
		for (const g of this.goals) {
			const row = contentEl.createDiv({ cls: "planboard-chore-row" });
			const info = row.createDiv({ cls: "planboard-chore-row-info" });
			info.createSpan({ cls: "planboard-chore-row-name", text: g.name });
			info.createSpan({
				cls: "planboard-goal-preview",
				text: g.cycle ? choreCycleLabel(g.cycle, g.overdue) : "每天",
			});
			const ops = row.createDiv({ cls: "planboard-chore-row-ops" });
			const editBtn = ops.createEl("button", { cls: "planboard-icon-btn", attr: { title: "编辑", "aria-label": "编辑" } });
			editBtn.setText("✎");
			editBtn.addEventListener("click", () => {
				this.close();
				this.onEdit(g);
			});
			const delBtn = ops.createEl("button", { cls: "planboard-icon-btn", attr: { title: "删除", "aria-label": "删除" } });
			delBtn.setText("✕");
			let armed = false;
			delBtn.addEventListener("click", () => {
				if (!armed) {
					armed = true;
					delBtn.setText("确认删除?");
					delBtn.addClass("planboard-chore-del-armed");
					return;
				}
				void this.onDelete(g).then((ok) => {
					if (!ok) return;
					this.goals = this.goals.filter((x) => x.name !== g.name);
					this.renderList();
				});
			});
		}
		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const add = buttons.createEl("button", { cls: "planboard-btn", text: "＋ 新增事项" });
		add.addEventListener("click", () => {
			this.close();
			this.onAdd();
		});
		const close = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "完成" });
		close.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Modal for adding a check-in item (PRD §4). */
class AddCheckItemModal extends Modal {
	private plugin: PlanBoardPlugin;
	private today: string;
	private onSubmit: (line: string) => void;
	private nameEl!: HTMLInputElement;
	private durationEl!: HTMLInputElement;
	private planEl!: HTMLSelectElement;
	private reviewEl!: HTMLInputElement;

	constructor(app: App, plugin: PlanBoardPlugin, today: string, onSubmit: (line: string) => void) {
		super(app);
		this.plugin = plugin;
		this.today = today;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: "添加打卡项" });

		new Setting(contentEl).setName("名称").addText((text) => {
			this.nameEl = text.inputEl;
			text.setPlaceholder("例如：阅读 30 分钟");
		});

		new Setting(contentEl).setName("计划").addDropdown((dropdown) => {
			this.planEl = dropdown.selectEl;
			const options = this.getPlanOptions();
			for (const plan of options) dropdown.addOption(plan, plan);
			dropdown.setValue(options[0]);
		});

		new Setting(contentEl).setName("时长").addText((text) => {
			this.durationEl = text.inputEl;
			text.setPlaceholder("例如：1小时");
		});

		new Setting(contentEl).setName("含复盘链接").addToggle((toggle) => {
			// Obsidian's typings type toggleEl as HTMLElement; at runtime it is an input.
			this.reviewEl = toggle.toggleEl as HTMLInputElement;
		});

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());

		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "添加" });
		ok.addEventListener("click", () => {
			const name = this.nameEl.value.trim();
			if (!name) {
				new Notice("请输入打卡名称");
				return;
			}
			const line = buildCheckLine({
				name,
				duration: this.durationEl.value.trim(),
				plan: this.planEl.value,
				includeReview: this.reviewEl.checked,
				date: this.today,
			});
			this.onSubmit(line);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private getPlanOptions(): string[] {
		const plans = new Set<string>(Object.keys(DEFAULT_PLAN_COLORS));
		return Array.from(plans);
	}
}

/** Modal for creating / editing a pool task (M2). */
class TaskModal extends Modal {
	private plugin: PlanBoardPlugin;
	private existing: PoolTask | null;
	private planOptions: string[];
	private defaults: TaskDefaults;
	private onSubmit: (input: NewTaskInput) => void;
	private textEl!: HTMLTextAreaElement;
	private planEl!: HTMLSelectElement;
	private startEl!: HTMLInputElement;
	private dueEl!: HTMLInputElement;

	constructor(
		app: App,
		plugin: PlanBoardPlugin,
		existing: PoolTask | null,
		planOptions: string[],
		defaults: TaskDefaults,
		onSubmit: (input: NewTaskInput) => void
	) {
		super(app);
		this.plugin = plugin;
		this.existing = existing;
		this.planOptions = planOptions;
		this.defaults = defaults;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: this.existing ? "编辑任务" : "新建任务" });

		new Setting(contentEl).setName("任务内容").addTextArea((ta) => {
			this.textEl = ta.inputEl;
			ta.setPlaceholder("例如：完成《霍去病》文章");
		});

		new Setting(contentEl).setName("关联计划").addDropdown((dropdown) => {
			this.planEl = dropdown.selectEl;
			dropdown.addOption("", "（不关联）");
			for (const plan of this.planOptions) dropdown.addOption(plan, plan);
		});

		new Setting(contentEl).setName("🛫 开始日期").addText((text) => {
			this.startEl = text.inputEl;
			this.startEl.type = "date";
			text.setPlaceholder("2026-08-10");
		});

		new Setting(contentEl).setName("📅 截止日期").addText((text) => {
			this.dueEl = text.inputEl;
			this.dueEl.type = "date";
			text.setPlaceholder("2026-08-16");
		});

		this.textEl.value = this.existing?.text ?? "";
		this.planEl.value = this.existing?.plan ?? this.defaults.plan ?? "";
		this.startEl.value = this.existing?.start ?? this.defaults.start ?? "";
		this.dueEl.value = this.existing?.due ?? this.defaults.due ?? "";

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());

		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		ok.addEventListener("click", () => {
			const text = this.textEl.value.trim();
			if (!text) {
				new Notice("请输入任务内容");
				return;
			}
			this.onSubmit({
				text,
				plan: this.planEl.value || null,
				start: this.startEl.value || null,
				due: this.dueEl.value || null,
			});
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Modal for creating / editing a plan category (v1.2, spec #4). */
class PlanEditModal extends Modal {
	private existing: PlanDef | null;
	private daily: boolean;
	private onSubmit: (input: PlanEditInput) => Promise<boolean>;
	private nameEl!: HTMLInputElement;
	private labelEl!: HTMLInputElement;
	private actionEl!: HTMLInputElement;
	private targetEl!: HTMLTextAreaElement;
	private colorEl!: HTMLSelectElement;

	private dailyVal = true;
	/** 打卡率分母按工作日统计（ADR-0005 v3；复盘不适用——走全局设置）。 */
	private tradingDayVal = false;
	/** emoji 选择浮层的点击外关闭监听与清理（v2.4.1）。 */
	private emojiPopDocDown: ((e: PointerEvent) => void) | null = null;
	private emojiClosePop: (() => void) | null = null;

	constructor(
		app: App,
		existing: PlanDef | null,
		daily: boolean,
		onSubmit: (input: PlanEditInput) => Promise<boolean>
	) {
		super(app);
		this.existing = existing;
		this.daily = daily;
		this.dailyVal = daily;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: this.existing ? "编辑大类" : "新增大类" });
		// ADR-0001: 日定额计划的总量/单位/截止日不进本弹窗（直接编辑 frontmatter）
		if (this.existing?.type === "quota" && this.existing.quota) {
			contentEl.createDiv({
				cls: "planboard-quota-modal-hint",
				text: `日定额计划：总量 ${formatQuotaAmount(this.existing.quota.total)}${this.existing.quota.unit} · 截止 ${this.existing.quota.end}。如需修改总量/单位/截止日，请直接编辑「年度计划.md」frontmatter 的 quota 字段。`,
			});
		}

		new Setting(contentEl).setName("名称").addText((text) => {
			this.nameEl = text.inputEl;
			text.setPlaceholder("例如：写作");
		});
		// v2.4: 图标字段 emoji 选择器（v2.4.1 改浮动弹层——点「选择…」在按钮旁弹出，不占 Modal 空间）
		const EMOJI_GROUPS: [string, string[]][] = [
			["运动", ["🏃", "🚶", "💪", "🏋️", "🧘", "⚽", "🏀", "🚴", "🏊", "🥾", "🎾", "⛰️"]],
			["学习", ["📖", "📚", "✍️", "🖋️", "🎓", "💡", "🧠", "🔬", "📝", "🗣️", "🎵", "📐"]],
			["健康", ["🥗", "🍎", "💊", "🩺", "😴", "🛌", "🌿", "💧", "🏥", "🥦", "🍵", "🧖"]],
			["工作", ["💼", "🖥️", "⌨️", "📈", "🗂️", "📊", "💻", "✉️", "🤝", "📅", "🛠️", "⚙️"]],
			["其他", ["🎯", "⭐", "🔥", "🎨", "📷", "🌱", "✨", "❤️", "🆕", "🌙", "☀️", "🚀"]],
		];
		const closeEmojiPop = (): void => {
			document.querySelector(".planflow-emoji-pop")?.remove();
			document.removeEventListener("pointerdown", this.emojiPopDocDown!, true);
			this.emojiPopDocDown = null;
		};
		this.emojiClosePop = closeEmojiPop;
		const showEmojiPop = (anchor: HTMLElement): void => {
			closeEmojiPop();
			const pop = document.body.createDiv({ cls: "planflow-emoji-pop" });
			for (const [label, emojis] of EMOJI_GROUPS) {
				const group = pop.createDiv({ cls: "planflow-emoji-group" });
				group.createSpan({ cls: "planflow-emoji-group-label", text: label });
				const row = group.createDiv({ cls: "planflow-emoji-row" });
				for (const emoji of emojis) {
					const b = row.createEl("button", { cls: "planflow-emoji-option", attr: { type: "button" } });
					b.setText(emoji);
					b.addEventListener("click", () => {
						this.labelEl.value = emoji;
						closeEmojiPop();
					});
				}
			}
			// 视口定位：按钮下方，左右不越界；下方空间不足则向上弹
			const r = anchor.getBoundingClientRect();
			const W = 340;
			const H = pop.offsetHeight || 340;
			let left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
			let top = r.bottom + 6;
			if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 6);
			pop.style.left = `${left}px`;
			pop.style.top = `${top}px`;
			pop.style.maxHeight = `${Math.min(380, window.innerHeight - 16)}px`;
			// 点击浮层外关闭
			this.emojiPopDocDown = (e: PointerEvent) => {
				if (!pop.contains(e.target as Node)) closeEmojiPop();
			};
			document.addEventListener("pointerdown", this.emojiPopDocDown, true);
		};
		new Setting(contentEl)
			.setName("图标")
			.setDesc("显示在计划名称前，如 ✍️ 📖 🏃")
			.addText((text) => {
				this.labelEl = text.inputEl;
				text.setPlaceholder("✍️");
			})
			.addButton((btn) => {
				btn.setButtonText("选择…").setTooltip("从常用 emoji 中选择").onClick(() => {
					showEmojiPop(btn.buttonEl);
				});
			});
		new Setting(contentEl).setName("动作").setDesc("每日打卡动作，如 1小时").addText((text) => {
			this.actionEl = text.inputEl;
			text.setPlaceholder("1小时");
		});
		new Setting(contentEl).setName("目标描述").addTextArea((ta) => {
			this.targetEl = ta.inputEl;
			ta.setPlaceholder("例如：发布 12 篇公众号文章");
		});
		new Setting(contentEl).setName("颜色").addDropdown((dropdown) => {
			this.colorEl = dropdown.selectEl;
			dropdown.addOption("", "（自动）");
			for (const c of PLAN_COLOR_OPTIONS) dropdown.addOption(c.value, c.label);
		});
		new Setting(contentEl).setName("每日打卡").setDesc("勾选后作为每日例行行动").addToggle((toggle) => {
			toggle.setValue(this.dailyVal);
			toggle.onChange((v) => {
				this.dailyVal = v;
			});
		});
		// ADR-0005 v3: 工作日口径——仅打卡型计划有意义；复盘走全局设置（不提供单计划开关）
		if ((this.existing?.type ?? "check") === "check") {
			if (this.existing?.name === "复盘") {
				new Setting(contentEl).setName("按工作日统计").setDesc("复盘默认按工作日（周一至周五）统计打卡率，可用设置页「复盘按工作日统计」关闭");
			} else {
				new Setting(contentEl).setName("按工作日统计").setDesc("开启后打卡率分母只算周一至周五（适合工作日例行、周末不打卡的计划）").addToggle((toggle) => {
					toggle.setValue(this.tradingDayVal);
					toggle.onChange((v) => {
						this.tradingDayVal = v;
					});
				});
			}
		}

		this.nameEl.value = this.existing?.name ?? "";
		this.labelEl.value = this.existing?.label ?? "";
		this.actionEl.value = this.existing?.action ?? "";
		this.targetEl.value = this.existing?.target ?? "";
		this.tradingDayVal = this.existing?.tradingDay ?? false;
		// 颜色不在色板内（老数据哈希分配/手写 frontmatter）时补一项原样显示，避免选中态丢失
		const existingColor = this.existing?.color ?? "";
		if (existingColor && !PLAN_COLOR_OPTIONS.some((c) => c.value === existingColor)) {
			this.colorEl.add(new Option(existingColor, existingColor));
		}
		this.colorEl.value = existingColor;

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		ok.addEventListener("click", () => {
			void (async () => {
				const name = this.nameEl.value.trim();
				if (!name) {
					new Notice("请输入大类名称");
					return;
				}
				const saved = await this.onSubmit({
					name,
					label: this.labelEl.value.trim(),
					action: this.actionEl.value.trim(),
					target: this.targetEl.value.trim(),
					color: this.colorEl.value,
					daily: this.dailyVal,
					// 复盘的工作日口径由全局设置控制，不落 flag
					tradingDay: name === "复盘" ? false : this.tradingDayVal,
				});
				if (saved) this.close();
			})();
		});
	}

	onClose(): void {
		this.emojiClosePop?.(); // v2.4.1: 关闭 Modal 时清理浮动 emoji 选择层
		this.contentEl.empty();
	}
}

/** ADR-0001: quota 行「实际量」录入弹窗——留空保存 = 清除实际量、仅勾选记满当日配额。 */

class QuotaActualModal extends Modal {
	private item: CheckItem;
	private unit: string;
	private dailyQuota: number;
	private onSubmit: (actual: number) => Promise<void>;

	constructor(
		app: App,
		item: CheckItem,
		unit: string,
		dailyQuota: number,
		onSubmit: (actual: number) => Promise<void>
	) {
		super(app);
		this.item = item;
		this.unit = unit;
		this.dailyQuota = dailyQuota;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: "记录实际完成量" });
		const current = parseQuotaActual(this.item.text);
		contentEl.createDiv({
			cls: "planboard-quota-modal-hint",
			text: `当日配额 ${formatQuotaAmount(this.dailyQuota)}${this.unit}。留空并保存 = 记满配额；填入实际数字则按实际量累计进度。`,
		});
		const inputEl = contentEl.createEl("input", {
			type: "number",
			cls: "planboard-quota-actual-input",
			attr: { min: "0", step: "any", placeholder: `例如：${formatQuotaAmount(this.dailyQuota)}` },
		});
		if (current != null) inputEl.value = String(current);
		setTimeout(() => inputEl.focus(), 50);
		inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void this.submit(inputEl);
		});
		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		ok.addEventListener("click", () => void this.submit(inputEl));
	}

	private async submit(inputEl: HTMLInputElement): Promise<void> {
		const v = inputEl.value.trim();
		let actual = 0;
		if (v !== "") {
			actual = parseFloat(v);
			if (!Number.isFinite(actual) || actual < 0) {
				new Notice("请输入不小于 0 的数字，或留空记满配额");
				return;
			}
		}
		await this.onSubmit(actual);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * ADR-0004 扩展三: 写复盘弹窗——多行输入，确认后写入当天日记「# 当日复盘」。
 * 复盘一天一份，重复写入 = 替换（reviewTransform 语义）。
 * 扩展四：打开时预填（已有当日复盘正文或模板骨架），用户直接在模板里填内容。
 * ADR-0014: 标题/提示/空文案参数化，「次日计划」弹窗复用同一体系（写入目标由回调决定）。
 */
class ReviewModal extends Modal {
	private onSubmit: (text: string) => Promise<void>;
	private prefill: string;
	/** ADR-0014: 标题/提示/空文案参数化——同一弹窗体系复用给「次日计划」入口。 */
	private title: string;
	private hint: string;
	private emptyNotice: string;

	constructor(
		app: App,
		opts: { prefill: string; title?: string; hint?: string; emptyNotice?: string; onSubmit: (text: string) => Promise<void> }
	) {
		super(app);
		this.prefill = opts.prefill;
		this.onSubmit = opts.onSubmit;
		this.title = opts.title ?? "📝 写复盘";
		this.hint = opts.hint ?? "内容将写入当天日记「# 当日复盘」小节（「# 随笔」之后）；再次写入会替换当日复盘内容。";
		this.emptyNotice = opts.emptyNotice ?? "复盘内容为空，先写点什么";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: this.title });
		contentEl.createDiv({
			cls: "planboard-quota-modal-hint",
			text: this.hint,
		});
		const inputEl = contentEl.createEl("textarea", {
			cls: "planboard-review-input",
			attr: { rows: "12" },
		});
		inputEl.value = this.prefill;
		setTimeout(() => {
			inputEl.focus();
			inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
		}, 50);
		inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void this.submit(inputEl);
		});
		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "写入" });
		ok.addEventListener("click", () => void this.submit(inputEl));
	}

	private async submit(inputEl: HTMLTextAreaElement): Promise<void> {
		const v = inputEl.value.trim();
		if (v === "") {
			new Notice(this.emptyNotice);
			return;
		}
		await this.onSubmit(v);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Modal for creating / editing a quantified goal under a plan (v1.2, spec #4). */
/** 结构级数上限（真实需求到不了，防御性上限）。 */
const MAX_STRUCTURE_LEVELS = 8;
/** 向导步骤常量：-1=模式选择；0=书名与时间；1..8=第 N 级；10=选书（ADR-0009）；11=结构确认（ADR-0009）；70=模式表单；80=目录粘贴；90=简单数量；99=确认。 */
const STEP_MODE = -1;
const STEP_INTRO = 0;
const STEP_BOOK = 10;
const STEP_STRUCT = 11;
const STEP_FORM = 70;
const STEP_TOC = 80;
const STEP_SIMPLE = 90;
const STEP_REVIEW = 99;

class GoalEditModal extends Modal {
	private planName: string;
	private existing: PlanGoal | null;
	private onSubmit: (input: GoalInput) => Promise<boolean>;

	// 跨步状态（每步一屏，重渲染时全部从状态恢复）
	private nameValue = "";
	private startValue = "";
	private daysValue = "";
	private endValue = "";
	private simpleCount = 0;
	private simpleUnit = "个";
	/** 结构状态：level0 counts 长度 1；level n counts 长度 = 上级叶子数；0 = 未填。 */
	private levels: { unit: string; counts: number[]; labels?: string[] }[] = [];
	/** 当前步骤。 */
	private step = STEP_INTRO;
	/** 预览行引用（时间字段变化时局部刷新文本）。 */
	private previewEl: HTMLElement | null = null;
	// ADR-0006: 模式状态（目标模式 / 每日量 / 目录粘贴）
	private modeValue: GoalMode | "" = "";
	private floorValue = "";
	private formUnitValue = "";
	private tocValue = "";
	private tocResult: ReturnType<typeof parseToc> = null;
	// ADR-0010 写作模式状态：量化方式（words/chapters）+ 两种口径的字段
	private writingQuant: "words" | "chapters" = "words";
	/** 编辑既有目标时锁死量化方式（跨口径切换 = 删除重建，Q9=A）。 */
	private writingQuantLocked = false;
	private writingTotalValue = "";
	private writingInitialValue = "";
	private writingChaptersValue = "";
	private writingDoneChaptersValue = "";
	/** 写作表单的每日配额预览行（renderModeForm 里赋值）。 */
	private writingHintEl: HTMLElement | null = null;
	// ADR-0009: weave 联动状态（选书步 / 接续阅读预勾）
	private weave: WeaveBridgeApi | null;
	private bookList: WeaveBookSummary[] | null = null;
	private bookLoading = false;
	/** 选书页数据加载只自动发起一次（空/失败不再无限重试，由重试按钮驱动）。 */
	private bookLoadAttempted = false;
	private bookError = "";
	/** 结构确认步：选中的书 + 可编辑的提取目录树（行内调整后确认才落结构）。 */
	private pickedBook: WeaveBookSummary | null = null;
	private bookTree: WeaveTocNode[] | null = null;
	/** 结构确认步文本编辑模式（整段缩进文本改层级，适合成规模的层级修正）。 */
	private structTextMode = false;
	private readerSid = "";
	private readerResume = 0;
	/** 结构确认步推导的每叶锚点快照（确认后随目标落盘，跳转/推进只认它）。 */
	private readerAnchorList: { spine: number; href: string; progress?: number }[] = [];
	/** ADR-0006: 运动单位选择自定义态（选「自定义…」后显示文本框）。 */
	private customUnitMode = false;
	// ADR-0016 生活模式表单状态
	private choreUnitValue: GoalCycle["unit"] = "day";
	private choreWeekDays: number[] = [0];
	private choreMonthDaysValue = "1";
	private choreYearMonthValue = "1";
	private choreYearDayValue = "1";
	private choreOverdueValue: ChoreOverdue = "skip";
	/** BZG 联动状态提示（视图侧按当前设置生成，复习表单展示）。 */
	private bzgHint: string;

	constructor(
		app: App,
		planName: string,
		existing: PlanGoal | null,
		bzgHint: string,
		weave: WeaveBridgeApi | null,
		onSubmit: (input: GoalInput) => Promise<boolean>
	) {
		super(app);
		this.planName = planName;
		this.existing = existing;
		this.bzgHint = bzgHint;
		this.weave = weave;
		this.onSubmit = onSubmit;
	}

	// ---- 结构状态辅助 -------------------------------------------------------

	private levelComplete(li: number): boolean {
		const lv = this.levels[li];
		if (!lv || lv.unit.trim().length === 0 || lv.counts.length === 0) return false;
		// 第 1 级总数 ≥ 1；更深各级允许填 0（无下级内容的节点本身成为勾选单位，如无节的章），但整级至少一项 ≥ 1
		if (li === 0) return Number.isInteger(lv.counts[0]) && lv.counts[0] > 0;
		return lv.counts.every((c) => Number.isInteger(c) && c >= 0) && lv.counts.some((c) => c > 0);
	}

	private validateLevel(li: number): boolean {
		if (this.levelComplete(li)) return true;
		new Notice(`第 ${li + 1} 级还没填完：先选单位，再填每项目数（没有下级内容的项填 0）`);
		return false;
	}

	/** 第 li 级的上级节点显示名（= 前 li 级局部展开的叶标签）。 */
	private parentLabels(li: number): string[] {
		if (li <= 0) return [];
		const prefix: GoalLevel[] = [];
		for (let i = 0; i < li; i++) {
			if (!this.levelComplete(i)) return [];
			prefix.push({ unit: this.levels[i].unit.trim(), counts: [...this.levels[i].counts] });
		}
		return expandGoalStructure("", prefix).map((l) => l.name.slice(1, -1));
	}

	/** 第 li 级应有的输入框数 = 上级叶子数（level 0 = 1 个总数输入）。 */
	private expectedInputs(li: number): number {
		if (li === 0) return 1;
		return this.parentLabels(li).length;
	}

	/** 确保第 li 级存在且输入框数与上级匹配（上游改动 → 裁剪并重建下游）。 */
	private ensureLevel(li: number): void {
		const expected = this.expectedInputs(li);
		const cur = this.levels[li];
		if (!cur || cur.counts.length !== expected) {
			this.levels = this.levels.slice(0, li);
			this.levels.push({ unit: "", counts: new Array(expected).fill(0) });
		}
	}

	private cleanLevels(): GoalLevel[] {
		// 注意 filter 回调第一参是元素、第二参才是下标——levelComplete 需要下标（此前
		// 误用 bind 直接传元素当索引，导致所有级被判未完成、确认页永远弹回第一步）
		// ADR-0009: labels 随级保留（长度由引擎按节点数取用，多截少补生成名）
		return this.levels
			.filter((lv, li) => this.levelComplete(li))
			.map((lv) => ({
				unit: lv.unit.trim(),
				counts: [...lv.counts],
				...(lv.labels?.length ? { labels: [...lv.labels] } : {}),
			}));
	}

	// ---- 派生显示 -----------------------------------------------------------

	private leafUnitOf(levels: GoalLevel[]): string {
		return levels.length > 0 ? levels[levels.length - 1].unit : "";
	}

	private currentLeaves(): { leaves: ReturnType<typeof expandGoalStructure>; levels: GoalLevel[] } | null {
		const levels = this.cleanLevels();
		if (levels.length === 0) return null;
		return { leaves: expandGoalStructure(this.nameValue.trim() || "书", levels), levels };
	}

	/** 叶顺序摘要「1/1 → 3/4」式（首叶 → 末叶的路径后缀）。 */
	private leafRangeText(leaves: { name: string }[]): string {
		const strip = (name: string): string => name.slice(name.indexOf("（") + 1, -1);
		if (leaves.length === 0) return "";
		return `${strip(leaves[0].name)} → ${strip(leaves[leaves.length - 1].name)}`;
	}

	/** 实时预览：共 N 叶 · 顺序首→末 · 按窗口天数均分结果（ADR-0005；接续阅读只摊未读部分，ADR-0009）。 */
	private buildPreview(): string {
		const cur = this.currentLeaves();
		if (!cur || cur.leaves.length === 0) return "";
		const unit = this.leafUnitOf(cur.levels);
		const remaining = this.readerSid ? Math.max(0, cur.leaves.length - this.readerResume) : cur.leaves.length;
		const parts = [
			remaining < cur.leaves.length
				? `共 ${cur.leaves.length} ${unit}（已读 ${cur.leaves.length - remaining}，分配剩余 ${remaining}）`
				: `共 ${cur.leaves.length} ${unit}`,
		];
		const strip = (name: string): string => name.slice(name.indexOf("（") + 1, -1);
		parts.push(`顺序 ${strip(cur.leaves[0].name)} → ${strip(cur.leaves[cur.leaves.length - 1].name)}`);
		if (this.startValue && this.endValue) {
			const days = dayCount(this.startValue, this.endValue);
			if (days > 0 && remaining > 0) {
				const base = Math.floor(remaining / days);
				const rem = remaining % days;
				parts.push(rem === 0 ? `${days} 天 · 每天 ${base} ${unit}` : `${days} 天 · 每天 ${base}~${base + 1} ${unit}`);
			}
		} else {
			parts.push("时间沿用计划周期");
		}
		return parts.join(" · ");
	}

	// ---- 步骤渲染 -----------------------------------------------------------

	private goto(step: number): void {
		this.step = step;
		this.renderWizard();
	}

	private renderWizard(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", {
			text: this.existing ? `编辑量化目标（${this.planName}）` : `新增量化目标（${this.planName}）`,
		});
		// 步骤条只属于阅读/通用结构流；模式选择/模式表单/目录页/选书页/结构确认页是独立单屏
		if (this.step >= STEP_INTRO && this.step !== STEP_TOC && this.step !== STEP_FORM && this.step !== STEP_BOOK && this.step !== STEP_STRUCT) this.renderStepBar(contentEl);
		if (this.step === STEP_MODE) this.renderModeCards(contentEl);
		else if (this.step === STEP_FORM) this.renderModeForm(contentEl);
		else if (this.step === STEP_TOC) this.renderTocStep(contentEl);
		else if (this.step === STEP_BOOK) this.renderBookPicker(contentEl);
		else if (this.step === STEP_STRUCT) this.renderStructConfirm(contentEl);
		else if (this.step === STEP_INTRO) this.renderIntro(contentEl);
		else if (this.step === STEP_SIMPLE) this.renderSimple(contentEl);
		else if (this.step === STEP_REVIEW) this.renderReview(contentEl);
		else this.renderLevelPage(contentEl, this.step - 1);
		this.focusFirstInput(contentEl);
	}

	private focusFirstInput(contentEl: HTMLElement): void {
		window.setTimeout(() => {
			if (!this.contentEl.isConnected) return;
			contentEl.querySelector<HTMLElement>("input:not([disabled]), select")?.focus();
		}, 120);
	}

	/** 顶部步骤条：书名与时间 → 各级 → 确认，当前步高亮。确认项仅在结构完整时出现。 */
	private renderStepBar(contentEl: HTMLElement): void {
		const bar = contentEl.createDiv({ cls: "planboard-wizard-steps" });
		const crumb = (label: string, step: number, link = true): void => {
			const cls = ["planboard-wizard-step"];
			if (this.step === step) cls.push("planboard-wizard-step--current");
			if (!link) cls.push("planboard-wizard-step--disabled");
			const s = bar.createSpan({ cls: cls.join(" "), text: label });
			if (link && step >= 0) {
				s.addEventListener("click", () => this.goto(step));
			}
		};
		crumb("① 书名", STEP_INTRO);
		for (let li = 0; li < this.levels.length; li++) {
			const lv = this.levels[li];
			crumb(`${lv.unit.trim() || `第 ${li + 1} 级`}`, li + 1);
		}
		// 确认入口只在结构链完整时给出——否则点了会被弹回第一步（就是"没有完成按钮"错觉的来源）
		if (this.cleanLevels().length > 0) crumb("✓ 确认", STEP_REVIEW);
	}

	private bindDateInputs(contentEl: HTMLElement): void {
		new Setting(contentEl)
			.setName("开始日期")
			.setDesc("与「天数」配合使用；重新安排阅读计划时，把开始日期改为今天即可——已读的节保留记录，没读的从头重摊")
			.addText((text) => {
				this.startValue = text.inputEl.value;
				text.inputEl.addEventListener("input", () => {
					this.startValue = text.inputEl.value;
					this.applyDays();
				});
				text.setValue(this.startValue);
				text.inputEl.type = "date";
				text.inputEl.addClass("planboard-date-btn");
			});
		new Setting(contentEl).setName("天数").addText((text) => {
			text.setValue(this.daysValue);
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.setPlaceholder("例如：10");
			text.inputEl.addEventListener("input", () => {
				this.daysValue = text.inputEl.value;
				this.applyDays();
			});
		});
		new Setting(contentEl).setName("结束日期").addText((text) => {
			text.setValue(this.endValue);
			text.inputEl.type = "date";
			text.inputEl.addClass("planboard-date-btn");
			text.inputEl.addEventListener("change", () => {
				this.endValue = text.inputEl.value;
				this.syncDaysFromRange();
			});
		});
	}

	private renderPreview(el: HTMLElement): void {
		const preview = el.createDiv({ cls: "planboard-goal-preview" });
		this.previewEl = preview;
		this.refreshPreviewText();
	}

	/** 预览文本刷新（天数/日期变化时由字段回调触发，不整页重渲染以免打断输入）。 */
	private refreshPreviewText(): void {
		if (this.previewEl?.isConnected) {
			this.previewEl.setText(this.buildPreview() || "填好结构与时间后，这里会显示自动安排的预览");
		}
	}

	/** 步骤 1：书名（结构优先——先定义结构看到总节数，再安排阅读时长）。 */
	private renderIntro(contentEl: HTMLElement): void {
		new Setting(contentEl).setName("① 书名").addText((text) => {
			text.setValue(this.nameValue);
			text.setPlaceholder("例如：《量价典型股票盘口分析》");
			text.inputEl.addEventListener("input", () => {
				this.nameValue = text.inputEl.value;
			});
		});
		contentEl.createDiv({
			cls: "planboard-goal-preview",
			text: "先定义书籍结构（章/节…），看到总节数后再安排阅读时长",
		});

		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const next = actions.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "下一步：定义结构 →", attr: { type: "button" } });
		next.addEventListener("click", () => {
			if (!this.nameValue.trim()) {
				new Notice("请先输入书名");
				return;
			}
			// 已填过结构（从确认页/上级退回）时保留现场，不重置
			if (!this.levels[0]) this.levels = [{ unit: "", counts: [0] }];
			this.goto(1);
		});
		if (this.levels.length > 0 && this.cleanLevels().length > 0) {
			contentEl.createDiv({
				cls: "planboard-goal-preview",
				text: "已有结构：点上方「✓ 确认」查看摘要并保存；「下一步」从第 1 级开始逐级修改",
			});
		}
		// ADR-0006: 阅读书籍模式支持粘贴目录自动生成结构（通用模式不提供，避免入口拥挤）
		if (this.modeValue === "reading") {
			const tocBtn = actions.createEl("button", { cls: "planboard-btn", text: "📋 粘贴目录导入", attr: { type: "button" } });
			tocBtn.addEventListener("click", () => this.goto(STEP_TOC));
		}
		const skip = actions.createEl("button", { cls: "planboard-btn", text: "跳过结构（简单数量目标）", attr: { type: "button" } });
		skip.addEventListener("click", () => this.goto(STEP_SIMPLE));
		this.addCancelButton(actions);
	}

	/** ADR-0006 步骤 0：模式选择——不同类型的目标量化方式不同。 */
	private renderModeCards(contentEl: HTMLElement): void {
		contentEl.createDiv({
			cls: "planboard-goal-preview",
			text: "这个目标属于哪一类？不同类型的量化方式和进度口径不同（通用 = 原有流程）",
		});
		const grid = contentEl.createDiv({ cls: "planboard-mode-cards" });
		const pick = (mode: GoalMode | ""): void => {
			this.modeValue = mode;
			if (mode === "review") {
				if (!this.nameValue.trim()) this.nameValue = "文献复习";
				if (!this.formUnitValue) this.formUnitValue = "篇";
			} else if (mode === "diary") {
				if (!this.nameValue.trim()) this.nameValue = "日记";
				this.formUnitValue = "";
				this.floorValue = "";
			} else if (mode === "exercise") {
				if (!this.nameValue.trim()) this.nameValue = "运动";
				if (!this.formUnitValue) this.formUnitValue = "分钟";
				this.customUnitMode = false;
			} else if (mode === "writing") {
				// ADR-0010: 默认按字数；量化方式在表单内下拉切换
				this.writingQuant = "words";
				this.writingQuantLocked = false;
				this.formUnitValue = "字";
			} else if (mode === "chore") {
				// ADR-0016: 生活事项缺省（洗碗=每天），周期与策略在表单内改
				if (!this.nameValue.trim()) this.nameValue = "洗碗";
				this.formUnitValue = "";
				this.floorValue = "";
			}
			// ADR-0009: 阅读模式且桥可用 → 选书步（选中即自动拉目录）；桥缺席/关闭静默走原流程（粘贴兜底）
			if (mode === "reading" && this.weave) {
				this.goto(STEP_BOOK);
				void this.loadBookShelf();
				return;
			}
			this.goto(mode === "reading" || mode === "" ? STEP_INTRO : STEP_FORM);
		};
		for (const mode of ["reading", "writing", "review", "diary", "exercise", "chore"] as GoalMode[]) {
			const meta = GOAL_MODE_META[mode];
			const b = grid.createEl("button", { cls: "planboard-mode-card", attr: { type: "button" } });
			b.createDiv({ cls: "planboard-mode-card-emoji", text: meta.emoji });
			b.createDiv({ cls: "planboard-mode-card-label", text: meta.label });
			b.createDiv({ cls: "planboard-mode-card-desc", text: meta.desc });
			b.addEventListener("click", () => pick(mode));
		}
		{
			const b = grid.createEl("button", { cls: "planboard-mode-card", attr: { type: "button" } });
			b.createDiv({ cls: "planboard-mode-card-emoji", text: "🎯" });
			b.createDiv({ cls: "planboard-mode-card-label", text: "通用" });
			b.createDiv({ cls: "planboard-mode-card-desc", text: "简单数量目标或自定义结构（原有流程，不分类）" });
			b.addEventListener("click", () => pick(""));
		}
		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		this.addCancelButton(actions);
	}

	/**
	 * ADR-0009 步骤 10：从阅读器书架选书——选中即自动拉目录生成结构，直达确认页。
	 * 四态明示（加载/空/失败+重试/列表），粘贴/手动结构入口保留并存（Q5=A）。
	 */
	private renderBookPicker(contentEl: HTMLElement): void {
		contentEl.createDiv({
			cls: "planboard-goal-preview",
			text: "📖 从阅读器书架选书：选中后自动读取该书目录，生成逐节阅读结构",
		});
		const listEl = contentEl.createDiv({ cls: "planboard-struct-box" });
		if (this.bookList) {
			for (const b of this.bookList) {
				const statusMeta = { unread: "未开始", reading: "阅读中", finished: "已读完" }[b.status];
				const row = listEl.createDiv({ cls: "planboard-book-row" });
				const info = row.createDiv({ cls: "planboard-book-row-info" });
				info.createSpan({ cls: "planboard-book-row-title", text: b.title || "（未命名）" });
				info.createSpan({
					cls: "planboard-goal-preview",
					text: `${b.author ? ` · ${b.author}` : ""} · ${statusMeta}${b.percent > 0 ? ` ${Math.round(b.percent)}%` : ""}`,
				});
				row.addEventListener("click", () => void this.pickBook(b));
			}
		} else if (this.bookLoading) {
			listEl.createSpan({ cls: "planboard-goal-preview", text: "正在读取书架…" });
		} else if (this.bookError) {
			listEl.createDiv({ cls: "planboard-goal-preview", text: `书架读取失败：${this.bookError}` });
			const retry = listEl.createEl("button", { cls: "planboard-btn", text: "重试", attr: { type: "button" } });
			retry.addEventListener("click", () => {
				this.bookLoadAttempted = false;
				this.bookError = "";
				void this.loadBookShelf();
			});
		} else if (this.bookLoadAttempted) {
			listEl.createSpan({
				cls: "planboard-goal-preview",
				text: "书架为空（0 本）：先在阅读器书架导入书籍，或改用下方粘贴导入",
			});
		}
		if (!this.bookLoadAttempted && !this.bookLoading) {
			void this.loadBookShelf();
		}
		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const tocBtn = actions.createEl("button", { cls: "planboard-btn", text: "📋 粘贴目录导入", attr: { type: "button" } });
		tocBtn.addEventListener("click", () => this.goto(STEP_TOC));
		const manualBtn = actions.createEl("button", { cls: "planboard-btn", text: "✍️ 手动定义结构", attr: { type: "button" } });
		manualBtn.addEventListener("click", () => this.goto(STEP_INTRO));
		this.addCancelButton(actions);
	}

	/**
	 * 拉取书架快照（选书步数据源）。8 秒超时兜底——桥挂起时给出可判读的失败态，
	 * 绝不无限转圈；结果（含错误）仍在选书页时渲染。
	 */
	private async loadBookShelf(): Promise<void> {
		if (this.bookLoading) return;
		this.bookLoading = true;
		this.bookLoadAttempted = true;
		let list: WeaveBookSummary[] | null = null;
		let error = "";
		try {
			const task = this.weave ? this.weave.getBookshelf() : Promise.resolve(null);
			list = await new Promise<WeaveBookSummary[] | null>((resolve, reject) => {
				const timer = window.setTimeout(() => reject(new Error("读取超时（8 秒无响应），阅读器插件可能未就绪")), 8000);
				task.then(
					(v) => {
						window.clearTimeout(timer);
						resolve(v);
					},
					(e) => {
						window.clearTimeout(timer);
						reject(e);
					}
				);
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			console.warn("[PlanFlow] weave getBookshelf 失败:", e);
		}
		this.bookList = list && list.length > 0 ? list : null;
		this.bookError = error;
		this.bookLoading = false;
		if (this.step === STEP_BOOK && this.contentEl.isConnected) this.renderWizard();
	}

	/**
	 * 选中一本书：拉目录 → 存为可编辑提取树，进结构确认步（用户核对/调整无误后
	 * 才落结构安排阅读——按确认的结构计算量化目标与分配）。
	 */
	private async pickBook(b: WeaveBookSummary): Promise<void> {
		if (!this.weave) return;
		let tree: WeaveTocNode[] | null = null;
		try {
			tree = await this.weave.getToc(b.sid);
		} catch {
			tree = null;
		}
		if (!tree || tree.length === 0) {
			new Notice(`未能读取《${b.title}》的目录：可用粘贴导入或手动定义结构`);
			return;
		}
		this.pickedBook = b;
		// 深拷贝为可编辑树：编辑只动这份拷贝，确认时才转换落结构
		this.bookTree = JSON.parse(JSON.stringify(tree)) as WeaveTocNode[];
		this.structTextMode = false;
		this.goto(STEP_STRUCT);
	}

	/**
	 * ADR-0009 结构确认步：展示提取出的目录树（真实标题 + 层级缩进）。两种编辑形态：
	 * 树形（行内 ✕/✎/↑/↓/＋/⤶，适合零星调整）与文本模式（整段缩进文本，适合
	 * 成规模的层级修正）。确认后按确认的树转换结构进确认页——树→结构的转换与
	 * 锚点推导全部复用 weaveTocToStructure（编辑不引入第二口径）。
	 */
	private renderStructConfirm(contentEl: HTMLElement): void {
		const book = this.pickedBook;
		const tree = this.bookTree;
		if (!book || !tree || tree.length === 0) {
			new Notice("提取结构已失效：请重选书");
			this.goto(STEP_BOOK);
			return;
		}
		// 摘要（每次调整后重算）：层 ×单位链 + 总叶数——与确认页同一转换口径
		const conv = weaveTocToStructure(tree);
		const summary = conv
			? `识别 ${conv.leafSpine.length} 节 · ${conv.levels.map((lv) => `${lv.unit} ×${lv.counts.reduce((a, c) => a + c, 0)}`).join(" → ")}`
			: "（当前结构为空或超过 8 级）";
		contentEl.createDiv({
			cls: "planboard-goal-preview",
			text: `📖《${book.title}》提取结构（共 ${tree.length} 个顶层条目） · ${summary}`,
		});
		const modeBar = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const modeBtn = modeBar.createEl("button", {
			cls: "planboard-btn",
			text: this.structTextMode ? "🌳 返回树形编辑" : "⌨ 文本编辑（整段改层级/删行）",
			attr: { type: "button" },
		});
		modeBtn.addEventListener("click", () => {
			this.structTextMode = !this.structTextMode;
			this.renderWizard();
		});

		if (this.structTextMode) {
			contentEl.createDiv({
				cls: "planboard-goal-preview",
				text: "每行一条目录；行首每 2 个空格（或 1 个 Tab）= 下钻一级。删行 = 删条目，改缩进 = 调层级，可直接重写标题。应用后按行数对齐保留跳转锚点（增删行后锚点丢失，联动停用，可「重新提取」恢复）",
			});
			const taEl = contentEl.createEl("textarea", { cls: "planboard-toc-input" });
			{
				const lines: string[] = [];
				const ser = (nodes: WeaveTocNode[], depth: number): void =>
					nodes.forEach((n) => {
						lines.push("  ".repeat(depth) + (n.label || ""));
						ser(n.children, depth + 1);
					});
				ser(tree, 0);
				taEl.value = lines.join("\n");
			}
			taEl.rows = 14;
			const applyBar = contentEl.createDiv({ cls: "planboard-struct-actions" });
			const applyBtn = applyBar.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "✓ 应用文本修改", attr: { type: "button" } });
			applyBtn.addEventListener("click", () => this.applyStructText(taEl.value));
		} else {
			contentEl.createDiv({
				cls: "planboard-goal-preview",
				text: "核对层级是否与书一致：行尾按钮 ✕删除 / ✎改名 / ↑升级 / ↓降级 / ＋子级 / ＋同级；大规模层级问题用上方「文本编辑」",
			});

			const subtreeMaxDepth = (node: WeaveTocNode): number =>
				node.children.length ? 1 + Math.max(...node.children.map(subtreeMaxDepth)) : 0;
			const scroll = contentEl.createDiv({ cls: "planboard-tree-scroll" });
			const renderRows = (
				nodes: WeaveTocNode[],
				depth: number,
				parentChain: { nodes: WeaveTocNode[]; index: number }[]
			): void => {
				nodes.forEach((n, i) => {
					const row = scroll.createDiv({ cls: "planboard-tree-row", attr: { style: `padding-left:${depth * 18 + 4}px` } });
					const labelSpan = row.createSpan({ cls: "planboard-tree-label", text: n.label || "（未命名）" });
					const ops = row.createDiv({ cls: "planboard-tree-ops" });
					const op = (text: string, title: string, fn: () => void, disabled = false): void => {
						const btn = ops.createEl("button", { cls: "planboard-icon-btn", attr: { title, "aria-label": title } });
						btn.setText(text);
						if (disabled) {
							btn.disabled = true;
							return;
						}
						btn.addEventListener("click", (e) => {
							e.stopPropagation();
							fn();
							this.renderWizard(); // 整树重渲染：调整后摘要与缩进即时更新
						});
					};
					op("✕", "删除该条目（含子级）", () => nodes.splice(i, 1));
					op("✎", "重命名条目（行内输入，Enter 确认）", () => {
						const input = createEl("input", { attr: { type: "text", value: n.label } });
						input.addClass("planboard-tree-rename");
						labelSpan.replaceWith(input);
						input.focus();
						input.select();
						let done = false;
						const commit = (): void => {
							if (done) return;
							done = true;
							const v = input.value.trim();
							if (v) n.label = v;
							this.renderWizard();
						};
						input.addEventListener("keydown", (ev) => {
							if (ev.key === "Enter") commit();
							else if (ev.key === "Escape") {
								done = true;
								this.renderWizard();
							}
						});
						input.addEventListener("blur", commit);
					});
					const grand = parentChain[parentChain.length - 1];
					op(
						"↑",
						"升一级（挂到上级，排在其原上级之后）",
						() => {
							nodes.splice(i, 1);
							grand.nodes.splice(grand.index + 1, 0, n);
						},
						depth === 0
					);
					op(
						"↓",
						"降一级（挂到上一个同级之下）",
						() => {
							const prev = nodes[i - 1];
							nodes.splice(i, 1);
							prev.children.push(n);
						},
						i === 0 || depth + 1 + subtreeMaxDepth(n) > 7
					);
					op(
						"＋",
						"添加子条目",
						() => {
							n.children.push({ label: "（新条目）", href: n.href || "", spineIndex: n.spineIndex ?? -1, children: [] });
						},
						depth + 1 > 7
					);
					op("⤶", "在其后添加同级条目", () => {
						nodes.splice(i + 1, 0, { label: "（新条目）", href: n.href || "", spineIndex: n.spineIndex ?? -1, children: [] });
					});
					if (n.children.length > 0) renderRows(n.children, depth + 1, [...parentChain, { nodes, index: i }]);
				});
			};
			renderRows(tree, 0, []);
		}

		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const ok = actions.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "✓ 结构无误，安排阅读 →", attr: { type: "button" } });
		ok.addEventListener("click", () => void this.confirmStructAndProceed());
		const reextract = actions.createEl("button", { cls: "planboard-btn", text: "↺ 重新提取", attr: { type: "button" } });
		reextract.addEventListener("click", () => void this.pickBook(book));
		const back = actions.createEl("button", { cls: "planboard-btn", text: "← 重选书", attr: { type: "button" } });
		back.addEventListener("click", () => this.goto(STEP_BOOK));
		this.addCancelButton(actions);
	}

	/**
	 * 确认结构 → 安排阅读。确认前先做锚点补遗（ADR-0009）：手动补录/改动的条目
	 * 用实时目录做标题模糊匹配回填锚点（跳转可达），匹配不上的继承前一叶章序
	 * （推进勾选按顺序阅读语义生效）；随后按确认树转换结构进确认页。
	 */
	private async confirmStructAndProceed(): Promise<void> {
		const book = this.pickedBook;
		if (!book || !this.bookTree) {
			new Notice("提取结构已失效：请重选书");
			return;
		}
		if (this.weave) {
			let live: WeaveTocNode[] | null = null;
			try {
				live = await this.weave.getToc(book.sid);
			} catch {
				live = null;
			}
			resolveMissingAnchors(this.bookTree, live);
			inferNeighborSpines(this.bookTree);
		}
		const confirmed = weaveTocToStructure(this.bookTree);
		if (!confirmed) {
			new Notice("调整后的结构为空或非法：至少保留一个条目");
			return;
		}
		this.nameValue = book.title || this.nameValue;
		this.levels = confirmed.levels.map((lv) => ({
			unit: lv.unit,
			counts: [...lv.counts],
			...(lv.labels?.length ? { labels: [...lv.labels] } : {}),
		}));
		this.readerSid = book.sid;
		// ADR-0009: 每叶锚点快照（含补遗回填结果，随目标落盘——跳转/推进只认它）
		this.readerAnchorList = confirmed.leafSpine.map((spine, i) => ({
			spine,
			href: confirmed.leafHref[i],
			progress: confirmed.leafProgress[i],
		}));
		// 接续阅读（Q11=B）：按「章序+文件内进度」细粒度判定已越过叶（与对账同一把尺，
		// 避免创建后对账又把「创建前已读的节」当新账弹出来）
		let resumeChapter = book.chapterIndex;
		let resumeProgress = -1;
		const weave = this.weave as WeaveBridgeApi;
		if (weave.getPosition) {
			try {
				const pos = await weave.getPosition(book.sid);
				if (pos) {
					resumeChapter = pos.chapterIndex;
					resumeProgress = pos.sectionProgress;
				}
			} catch {
				/* 取不到细粒度位置 → 回退章序口径 */
			}
		}
		this.readerResume = passedLeafIndicesFine(
			confirmed.leafSpine,
			confirmed.leafProgress,
			resumeChapter,
			resumeProgress
		).length;
		this.goto(STEP_REVIEW);
	}

	/**
	 * 应用文本编辑：行首缩进（2 空格 / 1 Tab = 一级）重建树。行数与原树一致时
	 * 按 DFS 序对齐迁移跳转锚点（改字/改层级不丢联动）；增删过行则锚点置空
	 * （联动将按 ADR-0009 停用，可重新提取恢复）。
	 */
	private applyStructText(text: string): void {
		const oldTree = this.bookTree;
		if (!oldTree) return;
		const oldDfs: WeaveTocNode[] = [];
		const collect = (nodes: WeaveTocNode[], out: WeaveTocNode[]): void =>
			nodes.forEach((n) => {
				out.push(n);
				collect(n.children, out);
			});
		collect(oldTree, oldDfs);

		const newTree: WeaveTocNode[] = [];
		const stack: { depth: number; node: WeaveTocNode }[] = [];
		for (const raw of text.split(/\r?\n/)) {
			if (!raw.trim()) continue;
			const indentChunk = raw.match(/^[\t ]*/)![0];
			let depth = 0;
			for (const ch of indentChunk) depth += ch === "\t" ? 1 : 0.5;
			depth = Math.floor(depth);
			if (depth > 7) {
				new Notice("层级过深（最多 8 级）：请减少该行的行首缩进");
				return;
			}
			const node: WeaveTocNode = { label: raw.trim(), href: "", spineIndex: -1, children: [] };
			while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
			if (stack.length) stack[stack.length - 1].node.children.push(node);
			else newTree.push(node);
			stack.push({ depth, node });
		}
		if (newTree.length === 0) {
			new Notice("文本为空：至少保留一行目录");
			return;
		}
		const newDfs: WeaveTocNode[] = [];
		collect(newTree, newDfs);
		if (newDfs.length === oldDfs.length) {
			newDfs.forEach((n, i) => {
				n.href = oldDfs[i].href;
				n.spineIndex = oldDfs[i].spineIndex;
			});
		}
		this.bookTree = newTree;
		this.structTextMode = false;
		this.renderWizard();
	}

	/** ADR-0006: 目录粘贴导入页（阅读书籍模式）——解析 → 预览 → 应用为多级结构。 */
	private renderTocStep(contentEl: HTMLElement): void {
		// ADR-0009: 从选书页直接进粘贴时书名可能为空——粘贴不经过选书，需用户补填
		if (!this.nameValue.trim()) {
			new Setting(contentEl).setName("书名").setDesc("书名即目标名；从书架选书会自动带出，粘贴导入请在此填写").addText((text) => {
				text.setValue(this.nameValue);
				text.setPlaceholder("例如：《交易心理分析》");
				text.inputEl.addEventListener("input", () => {
					this.nameValue = text.inputEl.value;
				});
			});
		}
		new Setting(contentEl)
			.setName("📋 粘贴书籍目录")
			.setDesc("每行一条；支持「第X篇/章/节」、1.2 数字编号与缩进层级，可混合")
			.addTextArea((ta) => {
				ta.setPlaceholder("第1章 初见\n  1.1 相遇\n  1.2 离别\n第2章 重逢\n…");
				ta.inputEl.rows = 12;
				ta.inputEl.addClass("planboard-toc-input");
				ta.setValue(this.tocValue);
				ta.inputEl.addEventListener("input", () => {
					this.tocValue = ta.inputEl.value;
					this.tocResult = null;
					const prev = contentEl.querySelector<HTMLElement>(".planboard-toc-preview");
					if (prev) prev.setText("点击「解析预览」查看识别结果");
				});
			});
		const previewEl = contentEl.createDiv({
			cls: "planboard-goal-preview planboard-toc-preview",
			text: "点击「解析预览」查看识别结果（识别不准可回层级页手调）",
		});
		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const parseBtn = actions.createEl("button", { cls: "planboard-btn", text: "解析预览", attr: { type: "button" } });
		parseBtn.addEventListener("click", () => {
			const result = parseToc(this.tocValue);
			this.tocResult = result;
			if (!result) {
				previewEl.setText("未能识别出目录条目：检查每行是否有「第X章」编号、1.2 数字编号或缩进");
				return;
			}
			const leaves = expandGoalStructure(this.nameValue.trim() || "书", result.levels);
			previewEl.setText(`${tocSummary(result)} · 共 ${leaves.length} 节 · 顺序 ${tocLeafRange(this.nameValue, result.levels)}`);
		});
		const applyBtn = actions.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "应用结构 →", attr: { type: "button" } });
		applyBtn.addEventListener("click", () => {
			if (!this.tocResult) {
				new Notice("请先解析预览");
				return;
			}
			this.levels = this.tocResult.levels.map((lv) => ({
				unit: lv.unit,
				counts: [...lv.counts],
				...(lv.labels?.length ? { labels: [...lv.labels] } : {}),
			}));
			this.goto(STEP_REVIEW);
		});
		const back = actions.createEl("button", { cls: "planboard-btn", text: "← 上一步", attr: { type: "button" } });
		back.addEventListener("click", () => this.goto(this.weave && this.modeValue === "reading" ? STEP_BOOK : STEP_INTRO));
		this.addCancelButton(actions);
	}

	/** ADR-0006: 复习/日记/运动模式表单（每日量 + 时间窗）。 */
	private renderModeForm(contentEl: HTMLElement): void {
		const mode = this.modeValue as GoalMode;
		const meta = GOAL_MODE_META[mode];
		contentEl.createDiv({ cls: "planboard-goal-preview", text: `${meta.emoji} ${meta.label}模式 · ${meta.desc}` });
		new Setting(contentEl).setName("目标名称").addText((text) => {
			text.setValue(this.nameValue);
			text.inputEl.addEventListener("input", () => {
				this.nameValue = text.inputEl.value;
			});
		});
		if (mode === "review") {
			new Setting(contentEl)
				.setName("每日下限（每天至少复习）")
				.setDesc(this.bzgHint || "无年度总量与截止日；实际量按天去重（同篇一天内重复复习算 1 篇）")
				.addText((text) => {
					text.setValue(this.floorValue);
					text.inputEl.type = "number";
					text.inputEl.min = "1";
					text.setPlaceholder("例如：5");
					text.inputEl.addEventListener("input", () => {
						this.floorValue = text.inputEl.value;
					});
				});
			new Setting(contentEl).setName("单位").addText((text) => {
				text.setValue(this.formUnitValue || "篇");
				text.inputEl.addEventListener("input", () => {
					this.formUnitValue = text.inputEl.value.trim();
				});
			});
		} else if (mode === "exercise") {
			new Setting(contentEl)
				.setName("每日目标量（可选）")
				.setDesc("留空 = 只打卡不记量；填写后每日行显示目标数量，可随时用「实」记录实际值")
				.addText((text) => {
					text.setValue(this.floorValue);
					text.inputEl.type = "number";
					text.inputEl.min = "1";
					text.setPlaceholder("例如：30");
					text.inputEl.addEventListener("input", () => {
						this.floorValue = text.inputEl.value;
					});
				});
			// ADR-0006: 单位下拉直选（次/组/分钟/小时/公里/千卡），「自定义…」兜底任意单位词
			const knownUnit = EXERCISE_UNITS.includes(this.formUnitValue);
			new Setting(contentEl).setName("单位").addDropdown((drop) => {
				for (const u of EXERCISE_UNITS) drop.addOption(u, u);
				drop.addOption("__custom__", "自定义…");
				drop.setValue(this.customUnitMode || (this.formUnitValue && !knownUnit) ? "__custom__" : this.formUnitValue || "分钟");
				drop.onChange((v) => {
					if (v === "__custom__") {
						this.customUnitMode = true;
						this.formUnitValue = "";
					} else {
						this.customUnitMode = false;
						this.formUnitValue = v;
					}
					this.renderWizard();
				});
			});
			if (this.customUnitMode || (this.formUnitValue && !knownUnit)) {
				new Setting(contentEl).setName("自定义单位").addText((text) => {
					text.setValue(this.formUnitValue);
					text.setPlaceholder("例如：圈 / 千米 / 回合");
					text.inputEl.addEventListener("input", () => {
						this.formUnitValue = text.inputEl.value.trim();
					});
				});
			}
		} else if (mode === "writing") {
			// ADR-0010: 量化方式下拉（按字数/按章节）；编辑既有目标时锁死口径（换口径 = 删除重建）
			new Setting(contentEl).setName("量化方式").setDesc(
				this.writingQuantLocked ? "既有目标不可切换量化方式（两套账互不相通）；想换口径请删除目标重建" : "按字数 = 每日配额推进；按章节 = 逐章任务推进"
			).addDropdown((drop) => {
				drop.addOption("words", "按字数");
				drop.addOption("chapters", "按章节");
				drop.setValue(this.writingQuant);
				drop.onChange((v) => {
					this.writingQuant = v === "chapters" ? "chapters" : "words";
					this.renderWizard();
				});
				if (this.writingQuantLocked) drop.selectEl.toggleAttribute("disabled", true);
			});
			if (this.writingQuant === "words") {
				new Setting(contentEl)
					.setName("总字数")
					.setDesc("例如 100000（10 万字）")
					.addText((text) => {
						text.setValue(this.writingTotalValue);
						text.inputEl.type = "number";
						text.inputEl.min = "1";
						text.setPlaceholder("例如：100000");
						text.inputEl.addEventListener("input", () => {
							this.writingTotalValue = text.inputEl.value;
							this.refreshWritingHint();
						});
					});
				if (!this.writingQuantLocked) {
					// 接续写作：建目标时已累计的字数（编辑模式无此概念——历史行是文件事实，不追溯）
					new Setting(contentEl)
						.setName("已累计字数（可选）")
						.setDesc("写到一半才建计划时填已写总量；进度从这里起步，每日配额按剩余量摊")
						.addText((text) => {
							text.setValue(this.writingInitialValue);
							text.inputEl.type = "number";
							text.inputEl.min = "0";
							text.setPlaceholder("例如：20000");
							text.inputEl.addEventListener("input", () => {
								this.writingInitialValue = text.inputEl.value;
								this.refreshWritingHint();
							});
						});
				}
			} else {
				new Setting(contentEl)
					.setName("总章数")
					.setDesc("展开为「{书名}（第 1 章）…（第 N 章）」逐章任务，均匀分日、逐日勾选")
					.addText((text) => {
						text.setValue(this.writingChaptersValue);
						text.inputEl.type = "number";
						text.inputEl.min = "1";
						text.setPlaceholder("例如：300");
						text.inputEl.addEventListener("input", () => {
							this.writingChaptersValue = text.inputEl.value;
							this.refreshWritingHint();
						});
					});
				if (!this.writingQuantLocked) {
					new Setting(contentEl)
						.setName("已完成章数（可选）")
						.setDesc("接续写作：前 M 章直接记为完成，剩余章从今天起排")
						.addText((text) => {
							text.setValue(this.writingDoneChaptersValue);
							text.inputEl.type = "number";
							text.inputEl.min = "0";
							text.setPlaceholder("例如：45");
							text.inputEl.addEventListener("input", () => {
								this.writingDoneChaptersValue = text.inputEl.value;
								this.refreshWritingHint();
							});
						});
				}
			}
			// 每日配额实时预览（字段/日期变化时刷新；日期输入变化走 renderWizard 重渲染）
			this.writingHintEl = contentEl.createDiv({ cls: "planboard-goal-preview" });
			this.refreshWritingHint();
		} else if (mode === "chore") {
			// ADR-0016: 生活事项——周期（天/周/月/年 + 日子选择）+ 逾期策略
			new Setting(contentEl).setName("重复周期").setDesc("只有轮到的日子，事项才出现在当日清单").addDropdown((drop) => {
				drop.addOption("day", "每天");
				drop.addOption("week", "每周…（选星期）");
				drop.addOption("month", "每月…（选几号）");
				drop.addOption("year", "每年…（选月日）");
				drop.setValue(this.choreUnitValue);
				drop.onChange((v) => {
					this.choreUnitValue = (["day", "week", "month", "year"] as const).includes(v as GoalCycle["unit"])
						? (v as GoalCycle["unit"])
						: "day";
					this.renderWizard();
				});
			});
			if (this.choreUnitValue === "week") {
				const wrap = new Setting(contentEl).setName("每周几（可多选）").controlEl;
				const box = wrap.createDiv({ cls: "planboard-chore-weekdays" });
				for (let d = 0; d < 7; d++) {
					const b = box.createEl("button", {
						cls: "planboard-chore-weekday" + (this.choreWeekDays.includes(d) ? " is-active" : ""),
						text: CHORE_WEEKDAY_LABELS[d],
						attr: { type: "button", title: `星期${CHORE_WEEKDAY_LABELS[d]}` },
					});
					b.addEventListener("click", () => {
						if (this.choreWeekDays.includes(d)) this.choreWeekDays = this.choreWeekDays.filter((x) => x !== d);
						else this.choreWeekDays = [...this.choreWeekDays, d].sort((a, c) => a - c);
						b.toggleClass("is-active", this.choreWeekDays.includes(d));
					});
				}
			} else if (this.choreUnitValue === "month") {
				new Setting(contentEl).setName("每月几号（可多选，逗号分隔）").setDesc("当月没有的号自动落到当月最后一天").addText((text) => {
					text.setValue(this.choreMonthDaysValue);
					text.setPlaceholder("例如：1, 11, 21");
					text.inputEl.addEventListener("input", () => {
						this.choreMonthDaysValue = text.inputEl.value;
					});
				});
			} else if (this.choreUnitValue === "year") {
				new Setting(contentEl).setName("每年几月几日").addText((text) => {
					text.setValue(this.choreYearMonthValue);
					text.inputEl.type = "number";
					text.inputEl.min = "1";
					text.inputEl.max = "12";
					text.setPlaceholder("月");
					text.inputEl.addEventListener("input", () => {
						this.choreYearMonthValue = text.inputEl.value;
					});
				}).addText((text) => {
					text.setValue(this.choreYearDayValue);
					text.inputEl.type = "number";
					text.inputEl.min = "1";
					text.inputEl.max = "31";
					text.setPlaceholder("日");
					text.inputEl.addEventListener("input", () => {
						this.choreYearDayValue = text.inputEl.value;
					});
				});
			}
			new Setting(contentEl).setName("漏了怎么办").setDesc("放弃 = 当天没做该次就消失；往后延 = 每天挂出提醒，补做一次即清账").addDropdown((drop) => {
				drop.addOption("skip", "放弃（漏了就漏了）");
				drop.addOption("postpone", "往后延（挂账到补做）");
				drop.setValue(this.choreOverdueValue);
				drop.onChange((v) => {
					this.choreOverdueValue = v === "postpone" ? "postpone" : "skip";
				});
			});
			contentEl.createDiv({
				cls: "planboard-goal-preview",
				text: "保存后挂到「日常生活」计划下（不存在会自动创建）；之后在该计划大项行上「＋ / ☰」增删改",
			});
		} else if (mode === "diary") {
			contentEl.createDiv({
				cls: "planboard-goal-preview",
				text: this.bzgHint || "完成事实：当天日记有亲手写下的内容（随笔/触动点）；BZG 缺席时手动勾选",
			});
		}
		new Setting(contentEl).setName("开始日期").setDesc("留空 = 沿用计划周期起点").addText((text) => {
			text.setValue(this.startValue);
			text.inputEl.type = "date";
			text.inputEl.addClass("planboard-date-btn");
			text.inputEl.addEventListener("change", () => {
				this.startValue = text.inputEl.value;
				// ADR-0010: 写作表单的配额预览依赖时间窗——重渲染让预览行即时重算
				if (this.modeValue === "writing") this.renderWizard();
			});
		});
		new Setting(contentEl).setName("结束日期").setDesc("留空 = 沿用计划周期终点（复习模式无截止概念，此日期仅作统计窗口）").addText((text) => {
			text.setValue(this.endValue);
			text.inputEl.type = "date";
			text.inputEl.addClass("planboard-date-btn");
			text.inputEl.addEventListener("change", () => {
				this.endValue = text.inputEl.value;
				if (this.modeValue === "writing") this.renderWizard();
			});
		});
		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const back = actions.createEl("button", { cls: "planboard-btn", text: "← 重选模式", attr: { type: "button" } });
		back.addEventListener("click", () => this.goto(STEP_MODE));
		const ok = actions.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存", attr: { type: "button" } });
		ok.addEventListener("click", () => void this.saveFromModeForm());
		this.addCancelButton(actions);
	}

	/** ADR-0010: 写作表单每日配额预览（按字数 = (总量−已写)÷天数；按章节 = 每日约 N 章）。 */
	private refreshWritingHint(): void {
		const el = this.writingHintEl;
		if (!el || !el.isConnected) return;
		if (this.writingQuant === "chapters") {
			const n = parseInt(this.writingChaptersValue, 10) || 0;
			if (n <= 0 || !this.startValue || !this.endValue) {
				el.setText("填总章数与起止日期后，预览每日推进节奏");
				return;
			}
			const days = Math.max(1, dayCount(this.startValue, this.endValue));
			const done = parseInt(this.writingDoneChaptersValue, 10) || 0;
			const remain = Math.max(0, n - done);
			el.setText(`共 ${n} 章（剩余 ${remain} 章）÷ ${days} 天 ≈ 每日 ${(remain / days).toFixed(1)} 章，未写完自然顺延`);
			return;
		}
		const total = parseInt(this.writingTotalValue, 10) || 0;
		if (total <= 0) {
			el.setText("填总字数与起止日期后，这里预览每日配额");
			return;
		}
		const initial = parseInt(this.writingInitialValue, 10) || 0;
		if (!this.startValue || !this.endValue) {
			el.setText(`截止留空 = 沿用计划周期；每日配额 = (总量 − 已写) ÷ 天数（创建时一次算死，落后不自动追赶）`);
			return;
		}
		const days = dayCount(this.startValue, this.endValue);
		if (days <= 0) {
			el.setText("结束日期需晚于开始日期");
			return;
		}
		if (initial >= total) {
			el.setText("已累计字数需小于总字数");
			return;
		}
		el.setText(`(${formatQuotaAmount(total)} − ${formatQuotaAmount(initial)}) ÷ ${days} 天 = 每日约 ${formatQuotaAmount((total - initial) / days)} 字（创建时一次算死，落后不自动追赶）`);
	}

	/** ADR-0006: 模式表单保存。 */
	private async saveFromModeForm(): Promise<void> {
		const mode = this.modeValue as GoalMode;
		const name = this.nameValue.trim();
		if (!name) {
			new Notice("请输入目标名称");
			return;
		}
		const floor = parseInt(this.floorValue, 10);
		if (mode === "review" && (!Number.isFinite(floor) || floor <= 0)) {
			new Notice("请设置每日下限（每天至少复习几篇）");
			return;
		}
		if (this.startValue && this.endValue && this.endValue < this.startValue) {
			new Notice("结束日期早于开始日期");
			return;
		}
		const input: GoalInput = { name, count: 0, unit: this.formUnitValue.trim(), mode };
		if (Number.isFinite(floor) && floor > 0) input.floor = floor;
		if (this.startValue) input.start = this.startValue;
		if (this.endValue) input.end = this.endValue;
		// ADR-0010 写作模式：两种量化口径组装（floor 不在此算——保存链按解析后的窗口一次冻结）
		if (mode === "writing") {
			if (this.writingQuant === "words") {
				const total = parseInt(this.writingTotalValue, 10) || 0;
				const initial = parseInt(this.writingInitialValue, 10) || 0;
				if (total <= 0) {
					new Notice("请输入总字数");
					return;
				}
				if (initial < 0 || initial >= total) {
					new Notice("已累计字数需小于总字数");
					return;
				}
				input.writingQuota = { total, initial };
				input.unit = "字";
			} else {
				const chapters = parseInt(this.writingChaptersValue, 10) || 0;
				const done = parseInt(this.writingDoneChaptersValue, 10) || 0;
				if (chapters <= 0) {
					new Notice("请输入总章数");
					return;
				}
				if (done < 0 || done >= chapters) {
					new Notice("已完成章数需小于总章数（填已完成时另建一本已读完的书亦可）");
					return;
				}
				input.structure = [{ unit: "章", counts: [chapters] }];
				input.count = chapters;
				input.unit = "章";
				if (done > 0) input.resumeLeaves = done;
			}
		}
		// ADR-0016 生活模式：周期 + 逾期策略组装（无总量无单位，count 0）
		if (mode === "chore") {
			let cycle: GoalCycle;
			if (this.choreUnitValue === "day") {
				cycle = { unit: "day", days: [] };
			} else if (this.choreUnitValue === "week") {
				if (this.choreWeekDays.length === 0) {
					new Notice("每周至少选一天");
					return;
				}
				cycle = { unit: "week", days: [...new Set(this.choreWeekDays)].sort((a, b) => a - b) };
			} else if (this.choreUnitValue === "month") {
				const days = [...new Set(
					this.choreMonthDaysValue
						.replace(/[[\]]/g, "")
						.split(/[,，\s]+/)
						.map((s) => parseInt(s, 10))
						.filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
				)].sort((a, b) => a - b);
				if (days.length === 0) {
					new Notice("请填写有效日期（1~31，逗号分隔）");
					return;
				}
				cycle = { unit: "month", days };
			} else {
				const mm = parseInt(this.choreYearMonthValue, 10);
				const dd = parseInt(this.choreYearDayValue, 10);
				if (!Number.isFinite(mm) || mm < 1 || mm > 12 || !Number.isFinite(dd) || dd < 1 || dd > 31) {
					new Notice("请填写有效的月（1~12）与日（1~31）");
					return;
				}
				cycle = { unit: "year", days: [mm, dd] };
			}
			input.cycle = cycle;
			if (this.choreOverdueValue === "postpone") input.overdue = "postpone";
			input.unit = "";
		}
		const saved = await this.onSubmit(input);
		if (saved) this.close();
	}

	/** 步骤 N：定义第 li 级。 */
	private renderLevelPage(contentEl: HTMLElement, li: number): void {
		this.ensureLevel(li);
		const lv = this.levels[li];
		// 智能推荐：新开的级按上一级单位预选接续词（如 篇→章、章→节、单元→课），可随时改
		if (li > 0 && !lv.unit) {
			lv.unit = suggestNextUnit(this.levels[li - 1].unit);
		}
		const parents = this.parentLabels(li);
		const knownUnit = STRUCT_UNITS.some((u) => u.word === lv.unit);

		new Setting(contentEl).setName(`第 ${li + 1} 级单位`).addDropdown((drop) => {
			drop.addOption("", "— 请选择单位 —");
			for (const u of STRUCT_UNITS) drop.addOption(u.word, u.word);
			drop.addOption("__custom__", "自定义…");
			drop.setValue(lv.unit ? (knownUnit ? lv.unit : "__custom__") : "");
			drop.onChange((v) => {
				lv.unit = v === "__custom__" ? "" : v;
				this.renderWizard();
			});
		});
		if (lv.unit && !knownUnit) {
			new Setting(contentEl).setName("自定义单位词").addText((text) => {
				text.setValue(lv.unit);
				text.setPlaceholder("例如：幕");
				text.inputEl.addEventListener("change", () => {
					lv.unit = text.inputEl.value.trim();
					this.renderWizard();
				});
			});
		}
		if (lv.unit) {
			contentEl.createDiv({
				cls: "planboard-goal-preview",
				text: isRestartUnit(lv.unit)
					? `编号方式：每上级从 1 重排（真书惯例：每章的${lv.unit}都从第 1 个起）`
					: `编号方式：全书连续编号（真书惯例：第 2 篇的${lv.unit}接着第 1 篇往下数）`,
			});
		}

		new Setting(contentEl).setName(li === 0 ? `${lv.unit.trim() || "该级"}总数` : `每个上级各有多少 ${lv.unit.trim() || "子单位"}`).setDesc(
			li === 0
				? "输入这一级的总数（如 3 篇）"
				: "按上一级顺序逐项输入；没有下级内容的填 0（该级本身成为一个勾选单位，如第 5 章无节 → 任务「第 5 章」）"
		);
		const wrap = contentEl.createDiv({ cls: "planboard-struct-box" });
		const countsWrap = wrap.createDiv({ cls: "planboard-chapters-box" });
		if (li === 0) {
			const field = countsWrap.createDiv({ cls: "planboard-chapter-field" });
			field.createSpan({ text: "总数" });
			const input = field.createEl("input", { attr: { type: "number", min: "1", placeholder: "例如：3" } });
			if (lv.counts[0] > 0) input.value = String(lv.counts[0]);
			input.addEventListener("change", () => {
				lv.counts[0] = parseInt(input.value, 10) || 0;
			});
		} else if (parents.length > 0) {
			for (let pi = 0; pi < parents.length; pi++) {
				const field = countsWrap.createDiv({ cls: "planboard-chapter-field" });
				field.createSpan({ text: parents[pi] });
				const input = field.createEl("input", { attr: { type: "number", min: "0", placeholder: "0 = 无" } });
				if (lv.counts[pi] > 0) input.value = String(lv.counts[pi]);
				input.addEventListener("change", () => {
					lv.counts[pi] = parseInt(input.value, 10) || 0;
				});
			}
		} else {
			countsWrap.createSpan({ cls: "planboard-goal-preview", text: "先完成上一级" });
		}
		this.renderPreview(contentEl);

		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const back = actions.createEl("button", { cls: "planboard-btn", text: "← 上一步", attr: { type: "button" } });
		back.addEventListener("click", () => this.goto(li === 0 ? STEP_INTRO : li));
		const done = actions.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "✓ 完成（排到这级）", attr: { type: "button" } });
		done.addEventListener("click", () => {
			if (!this.validateLevel(li)) return;
			this.levels = this.levels.slice(0, li + 1);
			this.goto(STEP_REVIEW);
		});
		if (li + 1 < MAX_STRUCTURE_LEVELS) {
			const next = actions.createEl("button", { cls: "planboard-btn", text: "➕ 细分下一级 →", attr: { type: "button" } });
			next.addEventListener("click", () => {
				if (!this.validateLevel(li)) return;
				this.levels = this.levels.slice(0, li + 1);
				this.goto(li + 2); // 下一级页 = step li+2
			});
		}
		this.addCancelButton(actions);
	}

	/** 简单数量目标（跳过结构）。 */
	private renderSimple(contentEl: HTMLElement): void {
		new Setting(contentEl).setName("① 书名").addText((text) => {
			text.setValue(this.nameValue);
			text.setPlaceholder("例如：公众号文章");
			text.inputEl.addEventListener("input", () => {
				this.nameValue = text.inputEl.value;
			});
		});
		new Setting(contentEl).setName("数量").addText((text) => {
			text.setValue(this.simpleCount > 0 ? String(this.simpleCount) : "");
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.setPlaceholder("例如：12");
			text.inputEl.addEventListener("input", () => {
				this.simpleCount = parseInt(text.inputEl.value, 10) || 0;
			});
		});
		new Setting(contentEl).setName("单位").addText((text) => {
			text.setValue(this.simpleUnit);
			text.setPlaceholder("个");
			text.inputEl.addEventListener("input", () => {
				this.simpleUnit = text.inputEl.value.trim() || "个";
			});
		});
		this.bindDateInputs(contentEl);
		this.renderPreview(contentEl);

		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const back = actions.createEl("button", { cls: "planboard-btn", text: "← 返回", attr: { type: "button" } });
		back.addEventListener("click", () => this.goto(STEP_INTRO));
		const done = actions.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "✓ 完成并保存", attr: { type: "button" } });
		done.addEventListener("click", () => void this.saveFromWizard(true));
		this.addCancelButton(actions);
	}

	/** 确认页：结构摘要（含总节数）→ 安排阅读时长 → 预览 + 保存。 */
	private renderReview(contentEl: HTMLElement): void {
		const cur = this.currentLeaves();
		if (!cur || cur.leaves.length === 0) {
			// 防御：结构链不完整时不再无声弹回（历史上这个无声跳转让用户以为没有完成按钮）
			new Notice("结构尚未完成：请回到对应层级继续填写");
			this.goto(STEP_INTRO);
			return;
		}
		const unit = this.leafUnitOf(cur.levels);

		// 结构摘要：总节数放大显示——先看到总量，再决定用多少天读完
		const box = contentEl.createDiv({ cls: "planboard-struct-box" });
		const summary = box.createDiv({ cls: "planboard-struct-level" });
		const totalLine = summary.createDiv({ cls: "planboard-struct-total" });
		totalLine.createSpan({ cls: "planboard-struct-total-num", text: `共 ${cur.leaves.length} ${unit}` });
		totalLine.createSpan({
			cls: "planboard-goal-preview",
			text: ` · ${cur.levels.map((lv) => `${lv.unit} ×${lv.counts.reduce((a, b) => a + b, 0)}`).join(" → ")}`,
		});
		summary.createDiv({
			cls: "planboard-goal-preview",
			text: `书名：${this.nameValue.trim() || "（未填）"} · 顺序 ${this.leafRangeText(cur.leaves)}`,
		});
		// ADR-0009 接续阅读：预勾口径明示在确认页（保存时自动记为完成，分配只覆盖剩余）
		if (this.readerSid && this.readerResume > 0) {
			summary.createDiv({
				cls: "planboard-goal-preview",
				text: `接续阅读：已读的前 ${this.readerResume} ${unit}保存时自动记为完成，每日分配覆盖剩余 ${cur.leaves.length - this.readerResume} ${unit}`,
			});
		}

		new Setting(contentEl)
			.setName("开始日期")
			.setDesc("与「天数」配合使用；重新安排阅读计划时，把开始日期改为今天即可——已读的节保留记录，没读的从头重摊")
			.addText((text) => {
				text.setValue(this.startValue);
				text.inputEl.type = "date";
				text.inputEl.addClass("planboard-date-btn");
				text.inputEl.addEventListener("change", () => {
					this.startValue = text.inputEl.value;
					this.applyDays();
				});
			});
		new Setting(contentEl).setName("天数").addText((text) => {
			text.setValue(this.daysValue);
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			const planN = this.readerSid ? Math.max(1, cur.leaves.length - this.readerResume) : cur.leaves.length;
			text.setPlaceholder(`例如：${Math.max(1, Math.ceil(planN / 3))}（每天约 3 ${unit}）`);
			text.inputEl.addEventListener("input", () => {
				this.daysValue = text.inputEl.value;
				this.applyDays();
			});
		});
		new Setting(contentEl).setName("结束日期").addText((text) => {
			text.setValue(this.endValue);
			text.inputEl.type = "date";
			text.inputEl.addClass("planboard-date-btn");
			text.inputEl.addEventListener("change", () => {
				this.endValue = text.inputEl.value;
				this.syncDaysFromRange();
			});
		});
		this.renderPreview(contentEl);

		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		for (let li = 0; li < cur.levels.length; li++) {
			const edit = actions.createEl("button", { cls: "planboard-btn", text: `← 修改第 ${li + 1} 级`, attr: { type: "button" } });
			edit.addEventListener("click", () => this.goto(li + 1));
		}
		const back = actions.createEl("button", { cls: "planboard-btn", text: "← 上一步", attr: { type: "button" } });
		back.addEventListener("click", () => this.goto(cur.levels.length));
		const ok = actions.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存", attr: { type: "button" } });
		ok.addEventListener("click", () => void this.saveFromWizard(false));
		this.addCancelButton(actions);
	}

	// ---- 保存 ---------------------------------------------------------------

	private addCancelButton(actions: HTMLElement): void {
		const cancel = actions.createEl("button", { cls: "planboard-btn", text: "取消", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
	}

	private applyDays(): void {
		const days = parseInt(this.daysValue, 10);
		if (!Number.isFinite(days) || days <= 0 || !this.startValue) return;
		this.endValue = formatDate(addDays(parseDateString(this.startValue), days - 1));
		this.refreshPreviewText();
	}

	private syncDaysFromRange(): void {
		if (this.startValue && this.endValue) {
			const days = dayCount(this.startValue, this.endValue);
			this.daysValue = days > 0 ? String(days) : "";
		}
		this.refreshPreviewText();
	}

	private async saveFromWizard(simple: boolean): Promise<void> {
		const name = this.nameValue.trim();
		if (!name) {
			new Notice("请先输入书名/目标名称");
			return;
		}
		if (this.startValue && this.endValue && this.endValue < this.startValue) {
			new Notice("结束日期早于开始日期");
			return;
		}
		const input: GoalInput = { name, count: 0, unit: "个" };
		if (this.startValue) input.start = this.startValue;
		if (this.endValue) input.end = this.endValue;
		// ADR-0006: 阅读书籍模式落 mode 标记（通用目标保持无模式）
		if (this.modeValue === "reading") input.mode = "reading";
		// ADR-0009: 阅读器联动（选书步来源）——sid + 接续阅读预勾数 + 每叶锚点快照
		if (this.modeValue === "reading" && this.readerSid) {
			input.reader = { sid: this.readerSid, resumeLeaves: this.readerResume, anchors: this.readerAnchorList };
		}
		if (!simple) {
			const levels = this.cleanLevels();
			const leaves = expandGoalStructure(name, levels);
			if (leaves.length === 0) {
				new Notice("结构不完整：请回到对应步骤补齐");
				return;
			}
			input.structure = levels;
			input.count = leaves.length;
			input.unit = levels[levels.length - 1].unit;
		} else {
			if (this.simpleCount <= 0) {
				new Notice("请输入有效的数量");
				return;
			}
			input.count = this.simpleCount;
			input.unit = this.simpleUnit;
		}
		const saved = await this.onSubmit(input);
		if (saved) this.close();
	}

	onOpen(): void {
		// 回填（编辑既有目标）
		this.nameValue = this.existing?.name ?? "";
		this.startValue = this.existing?.start ?? "";
		this.endValue = this.existing?.end ?? "";
		if (this.startValue && this.endValue) {
			const days = dayCount(this.startValue, this.endValue);
			this.daysValue = days > 0 ? String(days) : "";
		}
		this.simpleCount = this.existing ? this.existing.count : 0;
		this.simpleUnit = this.existing?.unit ?? "个";
		// ADR-0006: 模式目标编辑 → 直接进对应表单/流程；新建 → 模式选择起步
		if (this.existing?.mode && this.existing.mode !== "reading") {
			this.modeValue = this.existing.mode;
			this.floorValue = this.existing.floor ? String(this.existing.floor) : "";
			this.formUnitValue = this.existing.unit ?? "";
			// ADR-0016: 生活事项编辑——周期与策略回填
			if (this.existing.mode === "chore") {
				const c = this.existing.cycle;
				if (c) {
					this.choreUnitValue = c.unit;
					if (c.unit === "week") this.choreWeekDays = c.days.length > 0 ? [...c.days] : [0];
					else if (c.unit === "month") this.choreMonthDaysValue = c.days.join(", ");
					else if (c.unit === "year") {
						this.choreYearMonthValue = String(c.days[0] ?? 1);
						this.choreYearDayValue = String(c.days[1] ?? 1);
					}
				}
				this.choreOverdueValue = this.existing.overdue === "postpone" ? "postpone" : "skip";
			}
			// ADR-0010: 写作模式编辑——量化方式按既有账本推导并锁死（跨口径切换 = 删除重建）
			if (this.existing.mode === "writing") {
				this.writingQuantLocked = true;
				if (this.existing.writingQuota) {
					this.writingQuant = "words";
					this.writingTotalValue = String(this.existing.writingQuota.total);
					this.writingInitialValue = this.existing.writingQuota.initial ? String(this.existing.writingQuota.initial) : "";
				} else {
					this.writingQuant = "chapters";
					const n = this.existing.structure?.[0]?.counts?.[0] ?? this.existing.count ?? 0;
					this.writingChaptersValue = n > 0 ? String(n) : "";
				}
			}
			this.step = STEP_FORM;
			this.renderWizard();
			return;
		}
		if (this.existing?.mode === "reading") this.modeValue = "reading";
		if (this.existing?.structure?.length) {
			this.levels = this.existing.structure.map((lv) => ({ unit: lv.unit, counts: [...lv.counts] }));
		} else if (this.existing?.chapters?.length) {
			this.levels = chaptersToStructure(this.existing.chapters).map((lv) => ({ unit: lv.unit, counts: [...lv.counts] }));
		}
		// 有结构的编辑直接到确认页（可点步骤条返回任意级修改）；新建从模式选择开始
		this.step = this.existing ? (this.levels.length > 0 ? STEP_REVIEW : STEP_INTRO) : STEP_MODE;
		this.renderWizard();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function hexToRgba(hex: string, alpha: number): string {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Parse the raw `plans` frontmatter into name → raw object (all layouts). */
function readRawPlans(content: string): Map<string, Record<string, unknown>> {
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fmMatch) return new Map();
	let data: Record<string, unknown> | null | undefined;
	try {
		const parsed: unknown = parseYaml(fmMatch[1]);
		data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return new Map();
	}
	const raw = data?.plans;
	const map = new Map<string, Record<string, unknown>>();
	if (Array.isArray(raw)) {
		for (const el of raw) {
			if (!el || typeof el !== "object") continue;
			const obj = el as Record<string, unknown>;
			const name = obj.name ?? obj.plan ?? obj["名称"] ?? obj["计划"];
			if (typeof name === "string") {
				map.set(name, obj);
			} else {
				const key = Object.keys(obj)[0];
				if (key) {
					const val = obj[key];
					map.set(key, val && typeof val === "object" ? (val as Record<string, unknown>) : {});
				}
			}
		}
	} else if (raw !== null && typeof raw === "object") {
		for (const key of Object.keys(raw)) {
			const val = (raw as Record<string, unknown>)[key];
			map.set(key, val && typeof val === "object" ? (val as Record<string, unknown>) : {});
		}
	}
	return map;
}

/**
 * Write the `plans` list back into the annual note's frontmatter (spec v1.2 #5).
 * The plans block is re-serialized manually (no js-yaml); every other frontmatter
 * field and the note body are preserved. Callers manage `selfWrite`.
 */
export async function writePlansToFile(
	app: App,
	file: TFile,
	plans: PlanDef[],
	dailyByPlan?: Record<string, boolean>
): Promise<void> {
	await app.vault.process(file, (content) => {
		const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
		if (!fmMatch) return content;
		const inner = fmMatch[1];
		const lines = inner.split("\n");
		const plansIdx = lines.findIndex((l) => /^plans:(\s|$)/.test(l));
		let newInner: string;
		if (plansIdx === -1) {
			// 无 plans 键：插到 frontmatter 顶部。
			const ser = serializePlans(plans, dailyByPlan).replace(/\n$/, "");
			newInner = ser + (inner ? "\n" + inner : "");
		} else {
			// 定位 plans 块结束：下一行非空且不缩进（顶层 key），或 inner 末尾。
			let end = lines.length;
			for (let i = plansIdx + 1; i < lines.length; i++) {
				if (lines[i].length > 0 && !/^\s/.test(lines[i])) {
					end = i;
					break;
				}
			}
			const before = lines.slice(0, plansIdx).join("\n");
			const after = lines.slice(end).join("\n");
			const ser = serializePlans(plans, dailyByPlan).replace(/\n$/, "");
			newInner = (before ? before + "\n" : "") + ser + (after ? "\n" + after : "");
		}
		return content.replace(fmMatch[0], `---\n${newInner}\n---`);
	});
}

/** Manually serialize the `plans:` frontmatter block (2-space indent, spec v1.2 #5). */
function serializePlans(plans: PlanDef[], dailyByPlan?: Record<string, boolean>): string {
	const lines: string[] = ["plans:"];
	for (const p of plans) {
		lines.push(`  ${yamlScalar(p.name)}:`);
		if (p.label) lines.push(`    label: ${yamlScalar(p.label)}`);
		if (p.action) lines.push(`    action: ${yamlScalar(p.action)}`);
		lines.push(`    daily: ${dailyByPlan?.[p.name] ?? (p.type === "check")}`);
		if (p.target) lines.push(`    target: ${yamlScalar(p.target)}`);
		if (p.tradingDay) lines.push("    tradingDay: true");
		if (p.color) lines.push(`    color: ${yamlScalar(p.color)}`);
		// ADR-0001: quota 定义原样写回（编辑弹窗不改 quota 字段——改值直接编辑 frontmatter）
		if (p.type === "quota" && p.quota) {
			lines.push("    type: quota");
			lines.push("    quota:");
			lines.push(`      total: ${p.quota.total}`);
			if (p.quota.unit) lines.push(`      unit: ${yamlScalar(p.quota.unit)}`);
			if (p.quota.start) lines.push(`      start: ${yamlScalar(p.quota.start)}`);
			lines.push(`      end: ${yamlScalar(p.quota.end)}`);
		}
		if (p.goals.length > 0) {
			lines.push("    goals:");
			for (const g of p.goals) {
				lines.push(`      - name: ${yamlScalar(g.name)}`);
				lines.push(`        count: ${g.count}`);
				if (g.unit) lines.push(`        unit: ${yamlScalar(g.unit)}`);
				if (g.start) lines.push(`        start: ${yamlScalar(g.start)}`);
				if (g.end) lines.push(`        end: ${yamlScalar(g.end)}`);
				// ADR-0006: 目标模式与每日量原样写回
				if (g.mode) lines.push(`        mode: ${g.mode}`);
				if (g.floor != null) lines.push(`        floor: ${g.floor}`);
				// ADR-0016 生活模式：固定日子式周期 + 逾期策略原样写回（skip 缺省不落盘）
				if (g.cycle) {
					lines.push("        cycle:");
					lines.push(`          unit: ${g.cycle.unit}`);
					lines.push(`          days: [${g.cycle.days.join(", ")}]`);
				}
				if (g.overdue) lines.push(`        overdue: ${g.overdue}`);
				// ADR-0010 写作按字数：目标级字数配额原样写回
				if (g.writingQuota) {
					lines.push("        writingQuota:");
					lines.push(`          total: ${g.writingQuota.total}`);
					if (g.writingQuota.unit) lines.push(`          unit: ${yamlScalar(g.writingQuota.unit)}`);
					if (g.writingQuota.start) lines.push(`          start: ${yamlScalar(g.writingQuota.start)}`);
					if (g.writingQuota.end) lines.push(`          end: ${yamlScalar(g.writingQuota.end)}`);
					if (g.writingQuota.initial != null && g.writingQuota.initial > 0) lines.push(`          initial: ${g.writingQuota.initial}`);
				}
				// ADR-0005：章节 chapters 与多级 structure 原样写回（flow 序列 / 块序列，yamlScalar 只管标量）
				if (g.chapters && g.chapters.length > 0) lines.push(`        chapters: [${g.chapters.join(", ")}]`);
				// ADR-0009：阅读器来源书稳定标识 + 每叶锚点快照（"spine|href" 紧凑序列）原样写回
				if (g.readerSid) lines.push(`        readerSid: ${yamlScalar(g.readerSid)}`);
				if (g.readerAnchors?.length) {
					lines.push(
						`        readerAnchors: [${g.readerAnchors
							.map((a) => yamlScalar(`${a.spine}|${a.href}${typeof a.progress === "number" ? `|${a.progress}` : ""}`))
							.join(", ")}]`
					);
				}
				if (g.structure && g.structure.length > 0) {
					lines.push("        structure:");
					for (const lv of g.structure) {
						lines.push(`          - unit: ${yamlScalar(lv.unit)}`);
						lines.push(`            counts: [${lv.counts.join(", ")}]`);
						// ADR-0009: 真实标题随结构落盘（占位空串保序，引擎按下标取用）
						if (lv.labels?.length) {
							lines.push("            labels:");
							for (const label of lv.labels) lines.push(`              - ${yamlScalar(label)}`);
						}
					}
				}
			}
		}
	}
	return lines.join("\n") + "\n";
}

/** Quote a YAML scalar only when plain style could be misread (spec: 中文冒号无需引号). */
function yamlScalar(value: string): string {
	const v = value.trim();
	if (v === "") return '""';
	if (
		/^[-?!&*#{[|>'"%@`]/.test(v) || // leading YAML indicator
		/:\s/.test(v) || // "key: value" ambiguity
		/:\s*$/.test(v) || // trailing colon
		/ #/.test(v) || // comment after space
		/[[\]{} ,]/.test(v) // flow indicators / space separators
	) {
		return JSON.stringify(v);
	}
	return v;
}

/** Pick the next free palette color for a new plan (spec v1.2 #4: 轮换默认色). */
function rotatePlanColor(defs: PlanDef[]): string {
	const used = new Set<string>(defs.map((d) => d.color).filter(Boolean));
	for (const c of PLAN_COLOR_OPTIONS) {
		if (!used.has(c.value)) return c.value;
	}
	return PLAN_COLOR_OPTIONS[defs.length % PLAN_COLOR_OPTIONS.length].value;
}

/**
 * 拼打卡行名称：label 为空或纯 emoji（如图标栏填的 🗣️）时拼上计划名，
 * 避免「- [ ] 📊 #计划/xx」这种只有图标没有名称的行；label 含文字则视为完整名称直接用。
 */
function composeCheckItemName(label: string | undefined | null, planName: string): string {
	const l = (label ?? "").trim();
	if (!l) return planName;
	return /[\u4e00-\u9fffA-Za-z0-9]/.test(l) ? l : `${l} ${planName}`;
}

/** Build a PlanDef from a PlanProgress for editing (PlanProgress lacks type/targetCount). */
function toPlanDef(prog: PlanProgress): PlanDef {
	return {
		name: prog.plan,
		type: prog.isQuota ? "quota" : prog.isNumeric ? "numeric" : "check",
		target: prog.target,
		targetCount: prog.targetCount,
		goals: prog.goals.map((g) => ({ name: g.name, count: g.count, unit: g.unit, start: g.start, end: g.end, chapters: g.chapters, structure: g.structure, mode: g.mode, floor: g.floor, readerSid: g.readerSid, readerAnchors: g.readerAnchors, cycle: g.cycle, overdue: g.overdue })),
		quota: prog.quota ? { total: prog.quota.total, unit: prog.quota.unit, start: prog.quota.start, end: prog.quota.end } : null,
		action: prog.action,
		label: prog.label,
		color: prog.color,
		tradingDay: prog.tradingDay,
		daily: true,
	};
}

