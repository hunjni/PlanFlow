import { App, ButtonComponent, ItemView, MarkdownView, Menu, Modal, Notice, Setting, TAbstractFile, TFile, TFolder, WorkspaceLeaf, parseYaml } from "obsidian";
import type PlanBoardPlugin from "../main";
import type { CheckItem, DailyData, ModeLineSpec } from "./daily";
import {
	MANUAL_MARK,
	appendCheckItem,
	buildCheckLine,
	CHECK_HEADING,
	buildDailyTemplate,
	buildQuotaCheckLine,
	buildReviewTemplate,
	dayCount,
	addDays,
	formatDate,
	formatQuotaAmount,
	missingModeLines,
	missingQuotaLines,
	markTaskLineManual,
	moveTaskLine,
	parseDailyContent,
	parseDateString,
	parseQuotaActual,
	removeLine,
	replaceSummary,
	setQuotaActual,
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
	filterTasksInRange,
	parsePlansFromFrontmatter,
	readPlanPeriod,
} from "./stats";
import type { AutoTaskPlan, BookGroup, NewTaskInput, PoolTask } from "./tasks";
import { addTask, DAY_MS, deleteTask, editTask, ensureAutoTasks, extractGoalName, groupPoolTasksByGoal, isAutoTask, isRestartUnit, listTasks, planCounterUnit, suggestNextUnit, toggleTask, expandGoalStructure, expandGoalLeaves, chaptersToStructure, rescheduleChapterLine, STRUCT_UNITS, type ChapterRescheduleContext, type GoalLevel } from "./tasks";
import { badgeCounts, computeStreak, readMonthBadges, readPeriodBadges, settleMonth, settleMonthCheckin, settleWeek, settleWeekCheckin, tierFor } from "./achievements";
import { attachGanttDrag } from "./gantt-drag";
import { syncPlanTrackingToDiary, syncPoolTaskToDiary, writeReviewToDiary, writeSummaryToDiary, extractReviewSection, buildReviewPrefill, type TrackingItem } from "./diary-sync";
import { DEFAULT_PLAN_COLORS, type PlanTemplate } from "./settings";
import type { BzgSnapshot } from "./bzg";
import { diaryDayWritten, loadBzgSnapshot, readBzgDiaryText, reviewPoolSize, reviewedOn } from "./bzg";
import { parseToc, tocLeafRange, tocSummary } from "./toc";

/** v1.7.4: 插件改名 PlanFlow——view type 同步改（workspace 布局重新打开一次即可） */
export const VIEW_TYPE_PLANFLOW = "planflow";

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
}

/** 目标模式展示元数据（ADR-0006）。 */
const GOAL_MODE_META: Record<GoalMode, { emoji: string; label: string; desc: string }> = {
	reading: { emoji: "📖", label: "阅读书籍", desc: "按书籍结构逐节拆解，自动安排阅读时长" },
	review: { emoji: "🔁", label: "复习", desc: "每天至少复习 N 篇文献，实际量自动来自 BZG" },
	diary: { emoji: "📝", label: "日记", desc: "每天至少一篇日记，检测到当天有亲手写下的内容即自动打钩" },
	exercise: { emoji: "🏃", label: "运动", desc: "每日运动打卡，可附记时长或次数" },
};

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
		if (this.tab === "today") {
			await this.refreshToday();
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
				.filter((g) => g.mode && g.mode !== "reading")
				.map((g) => ({ plan: p.plan, goal: g, label: p.label }))
		);
	}

	/** ADR-0006: 按计划标签 + 行文本识别行所属的模式目标。 */
	private findModeGoal(plan: string | null, text: string): { plan: string; goal: PlanGoal; label: string } | null {
		if (!plan) return null;
		return this.modeGoals.find((mg) => mg.plan === plan && text.includes(mg.goal.name)) ?? null;
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
	 * name = "{label} {计划名}"、duration = action、复盘计划自动带复盘链接。
	 */
	private async buildDefaultCheckItems(): Promise<PlanTemplate[]> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const defs = await this.readAnnualPlanDefs(root, this.today.slice(0, 4));
		if (!defs) return [];
		return defs
			.filter((d) => d.daily && d.type !== "quota") // ADR-0001: quota 计划的每日行由配额惰性生成，不进模板推导
			.map((d) => ({
				name: composeCheckItemName(d.label, d.name),
				duration: d.action ?? "",
				plan: d.name,
				// tradingDay 现在只表示「打卡率按工作日统计」（ADR-0005 v3），不再附带复盘链接
				includeReview: d.name === "复盘",
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
				// ADR-0006: 模式目标（复习/日记/运动）不进任务池分解引擎，只有阅读/通用目标分解
				goals: d.goals
					.filter((g) => !g.mode || g.mode === "reading")
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
	 * 手动优先（`✋` 标记行一律跳过；未达下限也照实记录实际量）。
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
					const op = autos.find((a) => m[3] === a.spec.plan && text.includes(a.spec.name));
					if (!op) continue;
					if (line.includes(MANUAL_MARK)) continue; // 手动优先：✋ 行自动逻辑绝不碰
					const checkedNow = m[1] === "x";
					if (op.mode === "review" && bzg) {
						const count = reviewedOn(bzg, today);
						const cur = parseQuotaActual(text);
						const shouldCheck = count >= op.floor;
						if (cur !== count) {
							const raw = line;
							const idx = i;
							ops.push((acc) => setQuotaActual(acc, idx, count, op.spec.unit, shouldCheck, raw));
						} else if (shouldCheck && !checkedNow) {
							const raw = line;
							const idx = i;
							ops.push((acc) => toggleTaskLine(acc, idx, true, raw));
						}
					} else if (op.mode === "diary" && diaryWrittenToday && !checkedNow) {
						const raw = line;
						const idx = i;
						ops.push((acc) => toggleTaskLine(acc, idx, true, raw));
					}
				}
				return ops.reduce((acc, fn) => fn(acc), out);
			});
		} finally {
			this.selfWrite = false;
		}
	}

	private async refreshToday(): Promise<void> {
		await this.buildHomeData();
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
		// v1.7.5: 底部按钮排——「写入备注」+「写复盘」并排（flex 行，各占一半）
		const summaryActions = summaryCard.createDiv({ cls: "planboard-summary-actions" });
		const writeBtn = summaryActions.createEl("button", { cls: "planboard-btn planboard-btn-outline planboard-review-btn", text: "📥 写入备注" });
		writeBtn.addEventListener("click", () => void this.writeSummaryToDiary());
		const reviewBtn = summaryActions.createEl("button", { cls: "planboard-btn planboard-btn-outline planboard-review-btn planboard-review-bottom", text: "📝 写复盘 →" });
		reviewBtn.addEventListener("click", () => this.openReviewModal());
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

	/** 🔥 连续打卡天数：从昨天往前数，每天全部打卡勾选才计一天。X=0 不显示。 */
	private async updateStreak(): Promise<void> {
		if (!this.streakEl) return;
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const streak = await computeStreak(this.app, root, year, this.today);
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
				if (this.plugin.settings.achievementSound) playAchievementSound();
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

	private updateProgress(): void {
		const checks = this.dailyData?.checkItems ?? [];
		const done = checks.filter((c) => c.checked).length;
		const total = checks.length;
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
					if (this.plugin.settings.achievementSound) playAchievementSound();
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

	private updateChecklist(): void {
		if (!this.dailyData || !this.checklistEl) return;
		this.checklistEl.empty();
		for (const item of this.dailyData.checkItems) {
			this.checklistEl.appendChild(this.renderCheckItem(item));
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
		const { groups, ungrouped } = groupPoolTasksByGoal(planTasks, this.today);
		return {
			scheduled: groups.filter((g) => g.scheduled),
			ungroupedPending: ungrouped.filter((t) => this.isPendingPoolChild(t)),
		};
	}

	private renderCheckItem(item: CheckItem): HTMLElement {
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

		const actions = li.createDiv({ cls: "planboard-item-actions" });
		// ADR-0001: quota 行追加「实际量」录入按钮（勾选 = 记满配额；填数 = 按实际累计）
		// ADR-0006: 复习/运动模式行同样提供「实」按钮（复习下限/运动每日量语境）
		const modeHit = this.findModeGoal(item.plan, item.text);
		if (item.plan && (this.quotaPlanSet.has(item.plan) || (modeHit && modeHit.goal.mode !== "diary"))) {
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
		if (item.plan && bookView) {
			if (bookView.scheduled.length >= 2) {
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

		return li;
	}

	/** ADR-0003: 单片待办叶（勾选写回任务池；点行打开任务详情）。 */
	private renderPoolLeaf(item: CheckItem, t: PoolTask): HTMLElement {
		const sli = createEl("li", { cls: "planboard-subitem" });
		const slabel = sli.createEl("label", { cls: "planboard-check-label" });
		const scb = slabel.createEl("input", { type: "checkbox", cls: "planboard-checkbox planboard-subcheckbox" });
		scb.addEventListener("change", () => void this.togglePoolChild(item, t, scb.checked));
		slabel.createSpan({ cls: "planboard-check-text", text: t.text });
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
		// ADR-0006/0007: 模式行手动勾/退勾 → 打 `✋` 标记（此后自动逻辑不再覆盖）
		const modeHit = this.findModeGoal(item.plan, item.text);
		this.selfWrite = true;
		try {
			if (modeHit) {
				await this.app.vault.process(item.file, (data) =>
					markTaskLineManual(toggleTaskLine(data, item.line, checked, item.raw), item.line, undefined));
			} else {
				await this.app.vault.process(item.file, (data) => toggleTaskLine(data, item.line, checked, item.raw));
			}
			// ADR-0003: 勾父行 → 连带勾掉该计划全部待办子任务（Q3a）；
			// 取消父行不回退子任务——防误触清掉任务池里的进度记录。
			if (checked && item.plan) {
				for (const t of this.pendingPoolChildren(item.plan)) {
					await toggleTask(this.app, t, true);
					// ADR-0004: 级联勾掉的子任务同步投影到当天日记「## 代办事项」
					await syncPoolTaskToDiary(this.app, this.plugin.settings.diaryDir, t.text, true);
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
			await toggleTask(this.app, task, checked);
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
		const modeHit = this.findModeGoal(item.plan, item.text);
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
	 * ADR-0006: 模式行实际量写回（手动 → 打 `✋`，此后自动逻辑不再覆盖该行）。
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
				setQuotaActual(data, item.line, actual, unit, checked, item.raw, true));
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
		const checks = this.dailyData.checkItems;
		const done = checks.filter((c) => c.checked);
		const pending = checks.filter((c) => !c.checked);
		this.summaryAutoEl.empty();

		const total = checks.length;
		const doneLine = this.summaryAutoEl.createDiv({ cls: "planboard-summary-auto-line is-done" });
		doneLine.createSpan({ cls: "planboard-summary-auto-label", text: "✅ 已完成" });
		doneLine.createSpan({ cls: "planboard-summary-auto-text", text: `${done.length}/${total}` });

		const pendLine = this.summaryAutoEl.createDiv({ cls: "planboard-summary-auto-line is-pending" });
		pendLine.createSpan({ cls: "planboard-summary-auto-label", text: "⬜ 未完成" });
		pendLine.createSpan({ cls: "planboard-summary-auto-text", text: `${pending.length}/${total}` });

		const pct = total === 0 ? 0 : Math.round((done.length / total) * 100);
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
		new ReviewModal(this.app, prefill, async (text) => {
			const r = await writeReviewToDiary(this.app, this.plugin.settings.diaryDir, text);
			if (r === "no-diary") {
				new Notice(`未找到今日日记：${this.plugin.settings.diaryDir}/${this.today}.md`);
			} else if (r === "no-anchor") {
				new Notice("日记中未找到「# 随笔」小节，无法定位写入位置");
			} else {
				new Notice("复盘已写入日记「# 当日复盘」");
			}
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
			if (saved > 0) card.style.height = `${saved}px`;
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
		// ADR-0006: 模式目标的计数文本走专属口径；阅读/通用沿用任务池口径
		let countText = `${goal.done}/${goal.total} ${goal.unit || "个"}`;
		if (goal.modeStats) {
			const s = goal.modeStats;
			if (s.mode === "review") countText = `达标 ${s.hitDays}/${s.dueDays} 天`;
			else if (s.mode === "diary") countText = `完成 ${s.hitDays}/${s.dueDays} 天`;
			else countText = `打卡 ${s.hitDays}/${s.dueDays} 天`;
		}
		row.createDiv({ cls: "planboard-goal-count", text: countText });
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
		new GoalEditModal(this.app, planName, goal, bzgHint, (input) => this.saveGoal(planName, goal, input)).open();
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
		const goal: PlanGoal = { name: input.name, count: input.count, unit: input.unit || "个" };
		if (input.start) goal.start = input.start;
		if (input.end) goal.end = input.end;
		// ADR-0006: 目标模式与每日量（review 下限必填；exercise 可选）
		const isModeGoal = !!input.mode && input.mode !== "reading";
		if (input.mode) goal.mode = input.mode;
		if (typeof input.floor === "number" && input.floor > 0) goal.floor = input.floor;
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
					// ADR-0006: 模式目标无任务池任务——改今日打卡行的目标名即可
					const todayFile = this.getTodayFile();
					if (todayFile) {
						const oldName = existing.name;
						const newName = input.name;
						await this.app.vault.process(todayFile, (data) => {
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
				const valid = new Set(leaves.map((l) => l.name));
				// 剩余序列 = 任务池事实中未勾的有效叶子（按书序重新编号 1..m）
				const poolTasks = pool instanceof TFile ? await listTasks(this.app, root, year) : [];
				const remaining = new Set(
					poolTasks.filter((t) => !t.checked && valid.has(t.text.trim())).map((t) => t.text.trim())
				);
				const leafIndexByName = new Map<string, number>();
				let m = 0;
				for (const l of leaves) {
					if (remaining.has(l.name)) leafIndexByName.set(l.name, ++m);
				}
				// 重排基准窗口：显式 start/end，缺省回退年度计划周期，再缺省自然年（与分解引擎同一口径）
				const { start: gStart, end: gEnd } = await this.resolveGoalWindow(input, root, year);
				if (pool instanceof TFile) {
					const prefix = `${input.name}（`;
					const ctx: ChapterRescheduleContext = {
						plan: planName,
						prefix,
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
				// 时间窗已结束 → 分解被窗口守卫跳过，显式提示避免静默 0 任务
				if (gEnd < this.today) {
					new Notice(`注意：目标时间窗已于 ${gEnd} 结束，未生成分解任务；重新安排请编辑时间窗`);
				}
				// 墓碑语义：新序列里仍存在的名字保留墓碑（用户手动删过的节编辑后不复活），
				// 其余（含改名后的旧前缀残留、已消失的章节名）一律清除
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
			await this.ensureAutoTasksForToday(root, year);
			new Notice("目标已保存，分解任务已生成");
		}
		await this.refresh();
		return true;
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
 */
class ReviewModal extends Modal {
	private onSubmit: (text: string) => Promise<void>;
	private prefill: string;

	constructor(app: App, prefill: string, onSubmit: (text: string) => Promise<void>) {
		super(app);
		this.prefill = prefill;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: "📝 写复盘" });
		contentEl.createDiv({
			cls: "planboard-quota-modal-hint",
			text: "内容将写入当天日记「# 当日复盘」小节（「# 随笔」之后）；再次写入会替换当日复盘内容。",
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
			new Notice("复盘内容为空，先写点什么");
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
/** 向导步骤常量：-1=模式选择；0=书名与时间；1..8=第 N 级；70=模式表单；80=目录粘贴；90=简单数量；99=确认。 */
const STEP_MODE = -1;
const STEP_INTRO = 0;
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
	private levels: { unit: string; counts: number[] }[] = [];
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
	/** ADR-0006: 运动单位选择自定义态（选「自定义…」后显示文本框）。 */
	private customUnitMode = false;
	/** BZG 联动状态提示（视图侧按当前设置生成，复习表单展示）。 */
	private bzgHint: string;

	constructor(
		app: App,
		planName: string,
		existing: PlanGoal | null,
		bzgHint: string,
		onSubmit: (input: GoalInput) => Promise<boolean>
	) {
		super(app);
		this.planName = planName;
		this.existing = existing;
		this.bzgHint = bzgHint;
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
		return this.levels
			.filter((lv, li) => this.levelComplete(li))
			.map((lv) => ({ unit: lv.unit.trim(), counts: [...lv.counts] }));
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

	/** 实时预览：共 N 叶 · 顺序首→末 · 按窗口天数均分结果（ADR-0005）。 */
	private buildPreview(): string {
		const cur = this.currentLeaves();
		if (!cur || cur.leaves.length === 0) return "";
		const unit = this.leafUnitOf(cur.levels);
		const parts = [`共 ${cur.leaves.length} ${unit}`];
		const strip = (name: string): string => name.slice(name.indexOf("（") + 1, -1);
		parts.push(`顺序 ${strip(cur.leaves[0].name)} → ${strip(cur.leaves[cur.leaves.length - 1].name)}`);
		if (this.startValue && this.endValue) {
			const days = dayCount(this.startValue, this.endValue);
			if (days > 0) {
				const base = Math.floor(cur.leaves.length / days);
				const rem = cur.leaves.length % days;
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
		// 步骤条只属于阅读/通用结构流；模式选择/模式表单/目录页是独立单屏
		if (this.step >= STEP_INTRO && this.step !== STEP_TOC && this.step !== STEP_FORM) this.renderStepBar(contentEl);
		if (this.step === STEP_MODE) this.renderModeCards(contentEl);
		else if (this.step === STEP_FORM) this.renderModeForm(contentEl);
		else if (this.step === STEP_TOC) this.renderTocStep(contentEl);
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
			}
			this.goto(mode === "reading" || mode === "" ? STEP_INTRO : STEP_FORM);
		};
		for (const mode of ["reading", "review", "diary", "exercise"] as GoalMode[]) {
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

	/** ADR-0006: 目录粘贴导入页（阅读书籍模式）——解析 → 预览 → 应用为多级结构。 */
	private renderTocStep(contentEl: HTMLElement): void {
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
			this.levels = this.tocResult.levels.map((lv) => ({ unit: lv.unit, counts: [...lv.counts] }));
			this.goto(STEP_REVIEW);
		});
		const back = actions.createEl("button", { cls: "planboard-btn", text: "← 上一步", attr: { type: "button" } });
		back.addEventListener("click", () => this.goto(STEP_INTRO));
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
			});
		});
		new Setting(contentEl).setName("结束日期").setDesc("留空 = 沿用计划周期终点（复习模式无截止概念，此日期仅作统计窗口）").addText((text) => {
			text.setValue(this.endValue);
			text.inputEl.type = "date";
			text.inputEl.addClass("planboard-date-btn");
			text.inputEl.addEventListener("change", () => {
				this.endValue = text.inputEl.value;
			});
		});
		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const back = actions.createEl("button", { cls: "planboard-btn", text: "← 重选模式", attr: { type: "button" } });
		back.addEventListener("click", () => this.goto(STEP_MODE));
		const ok = actions.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存", attr: { type: "button" } });
		ok.addEventListener("click", () => void this.saveFromModeForm());
		this.addCancelButton(actions);
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
			text.setPlaceholder(`例如：${Math.max(1, Math.ceil(cur.leaves.length / 3))}（每天约 3 ${unit}）`);
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
async function writePlansToFile(
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
				// ADR-0005：章节 chapters 与多级 structure 原样写回（flow 序列 / 块序列，yamlScalar 只管标量）
				if (g.chapters && g.chapters.length > 0) lines.push(`        chapters: [${g.chapters.join(", ")}]`);
				if (g.structure && g.structure.length > 0) {
					lines.push("        structure:");
					for (const lv of g.structure) {
						lines.push(`          - unit: ${yamlScalar(lv.unit)}`);
						lines.push(`            counts: [${lv.counts.join(", ")}]`);
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
		goals: prog.goals.map((g) => ({ name: g.name, count: g.count, unit: g.unit, start: g.start, end: g.end, chapters: g.chapters, structure: g.structure, mode: g.mode, floor: g.floor })),
		quota: prog.quota ? { total: prog.quota.total, unit: prog.quota.unit, start: prog.quota.start, end: prog.quota.end } : null,
		action: prog.action,
		label: prog.label,
		color: prog.color,
		tradingDay: prog.tradingDay,
		daily: true,
	};
}

