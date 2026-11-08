import type { App } from "obsidian";
import { DEFAULT_UNIT_CHAIN, extractTocUnitWord } from "./toc";
import type { GoalLevel } from "./tasks";

/**
 * weave 阅读器桥接（ADR-0009）。
 *
 * fork weave epub reader（用户自维护插件）暴露 public `planflowBridgeApi` 挂在
 * 插件实例上（Dataview/Templater 惯例），planflow 经 `app.plugins.getPlugin` 消费：
 *
 * - `getBookshelf()`：书架快照（书目 + 阅读状态 + 当前章序）
 * - `getToc(sid)`：目录树（foliate 解析，含叶 → spine 章序锚点）
 * - `openChapter(sid, href)`：在阅读器中打开某书某章（跳转）
 * - 位置推进事件：`WeaveEpubStandalone:epub-position-advanced`（window
 *   CustomEvent，detail = WeaveAdvanceDetail）——推进事实（CONTEXT.md）的来源
 *
 * 桥缺失 / 形状不符 / 设置关闭 → 返回 null，调用方静默降级（粘贴导入照旧，
 * 与 ADR-0007 BZG 联动同一降级纪律）。本模块只做探测与纯转换；Notice 确认、
 * 任务池写回等 App 联动在 PlanBoardView 内。
 */

/** fork 插件 id（manifest.json）。 */
export const WEAVE_PLUGIN_ID = "fork-weave-epub-reader";

/** 位置推进事件名（fork 侧 dispatch，planflow 监听）。 */
export const WEAVE_ADVANCE_EVENT = "WeaveEpubStandalone:epub-position-advanced";

/** 书架快照里的一本书（桥契约，与 fork 侧 PlanflowBookSummary 对齐）。 */
export interface WeaveBookSummary {
	/** 稳定标识 `epubsrc-{fingerprint 前 24 位}`——文件改名/移动不变，目标引用它的唯一键。 */
	sid: string;
	/** 书名（元数据 title）。 */
	title: string;
	/** 作者（可为空）。 */
	author: string;
	/** 阅读状态：未开始 / 阅读中 / 已读完。 */
	status: "unread" | "reading" | "finished";
	/** 章节总数（元数据）。 */
	chapterCount: number;
	/** 当前阅读章序（spine 序号，0-based；未开始为 0）。 */
	chapterIndex: number;
	/** 全书阅读百分比 0~100（读完后冻结 100）。 */
	percent: number;
}

/** 目录树节点（桥契约，形状对齐 foliate TocItem）。 */
export interface WeaveTocNode {
	/** 条目标题（原样，如「第3章 初见」）。 */
	label: string;
	/** 章内锚点 href（openChapter 用）。 */
	href: string;
	/** 本条目所在 spine 章序；解析不出为 -1（联动按「永不越过」处理，绝不误判已读）。 */
	spineIndex: number;
	/** 子条目（层级天然对应多级结构）。 */
	children: WeaveTocNode[];
}

/** 桥 API（fork 插件实例上的 public `planflowBridgeApi` 成员；读取走 Promise——书架/目录均为现解析）。 */
export interface WeaveBridgeApi {
	getBookshelf(): Promise<WeaveBookSummary[]>;
	getToc(sid: string): Promise<WeaveTocNode[] | null>;
	openChapter(sid: string, href: string): void;
	/** 打开整本书（恢复上次阅读位置）；可选——旧版 fork 未提供时不显示书行跳转。 */
	openBook?(sid: string): void;
}

/** 位置推进事件 detail（桥契约）：阅读位置从 fromChapter 推进到 toChapter（spine 序号，向前推进）。 */
export interface WeaveAdvanceDetail {
	sid: string;
	/** 推进前章序（越过的开区间起点）。 */
	fromChapter: number;
	/** 推进后章序（当前正在读的章）。 */
	toChapter: number;
}

/** 探测桥：设置关闭 / fork 缺席 / api 形状不符 → null（调用方静默降级）。 */
export function getWeaveBridge(app: App, enabled: boolean): WeaveBridgeApi | null {
	if (!enabled) return null;
	const plugins = (app as unknown as { plugins?: { getPlugin?: (id: string) => unknown } }).plugins;
	// fork 侧公开字段名：`planflowBridgeApi`（weave-src/src/main.ts，ADR-0009）
	const plugin = plugins?.getPlugin?.(WEAVE_PLUGIN_ID) as { planflowBridgeApi?: unknown } | undefined;
	const api = plugin?.planflowBridgeApi as Partial<WeaveBridgeApi> | undefined;
	if (!api || typeof api !== "object") return null;
	if (typeof api.getBookshelf !== "function" || typeof api.getToc !== "function" || typeof api.openChapter !== "function") {
		return null;
	}
	return api as WeaveBridgeApi;
}

// ---------------------------------------------------------------------------
// 目录树 → 多级结构（纯转换；ADR-0009 桥导入的落点 = GoalLevel[]，下游全复用）
// ---------------------------------------------------------------------------

/** 目录树转换结果：结构（含真实标题 labels）+ 与展开叶子序对齐的锚点（同下标即同一叶）。 */
export interface WeaveTocStructure {
	levels: GoalLevel[];
	/** DFS 叶序锚点：leafSpine 章序（推进判定）+ leafHref 章内锚点（跳转）。 */
	leafSpine: number[];
	leafHref: string[];
}

/**
 * 目录树转多级结构。层级形状 = 每层节点子数目（允许 0 = 无下级内容的节点本身
 * 成为叶子，与手填层级同一语义）；单位词 = 该层标签里最高频的单位词
 * （「第3章」→ 章，Q10），提取不到落 toc.ts 默认链；真实标题按层收进 labels
 * （DFS 序，随结构落盘进任务名）。
 * 返回 null = 一级条目都没有（空目录 / 非法树）。
 */
export function weaveTocToStructure(tree: WeaveTocNode[] | null): WeaveTocStructure | null {
	if (!tree || tree.length === 0) return null;

	// 每层单位词频次（该层节点里最高频的命中单位词；缺失用默认链兜底）——与 toc.ts 同口径
	const freq: Map<string, number>[] = [];
	const walkFreq = (nodes: WeaveTocNode[], depth: number): void => {
		for (const n of nodes) {
			while (freq.length <= depth) freq.push(new Map());
			const w = extractTocUnitWord(n.label);
			if (w) freq[depth].set(w, (freq[depth].get(w) ?? 0) + 1);
			walkFreq(n.children, depth + 1);
		}
	};
	walkFreq(tree, 0);

	// 每层真实标题（DFS 先序 = 引擎节点创建序）
	const labelRows: string[][] = [];
	const walkLabels = (nodes: WeaveTocNode[], depth: number): void => {
		for (const n of nodes) {
			while (labelRows.length <= depth) labelRows.push([]);
			labelRows[depth].push(n.label || "");
			walkLabels(n.children, depth + 1);
		}
	};
	walkLabels(tree, 0);

	const depth0 = freq.length;
	if (depth0 === 0 || depth0 > 8) return null;
	const units: string[] = [];
	for (let d = 0; d < depth0; d++) {
		let best = "";
		let bestN = 0;
		for (const [w, n] of freq[d]) {
			if (n > bestN) {
				best = w;
				bestN = n;
			}
		}
		units.push(best || DEFAULT_UNIT_CHAIN[d] || `级${d + 1}`);
	}

	// GoalLevel：level0 = [顶层节点数]；level n = 每个 level-(n-1) 节点（DFS 序）的子数目
	//（0 合法 = 该节点无下级内容，自身升格为叶子——与 toc.ts / expandGoalStructure 同语义）
	const levels: GoalLevel[] = units.map((unit) => ({ unit, counts: [] }));
	levels[0].counts = [tree.length];
	const leafSpine: number[] = [];
	const leafHref: string[] = [];
	{
		let current = tree;
		for (let lv = 1; lv < levels.length; lv++) {
			levels[lv].counts = current.map((n) => n.children.length);
			current = current.flatMap((n) => n.children);
		}
		// 叶收集（DFS）：末层节点是叶；中途无子节点的节点升格为叶——顺序与
		// expandGoalStructure 的 DFS 收集完全一致（对齐进度/跳转/推进映射的前提）
		const visit = (n: WeaveTocNode, depth: number): void => {
			if (depth === levels.length - 1 || n.children.length === 0) {
				leafSpine.push(n.spineIndex);
				leafHref.push(n.href);
				return;
			}
			for (const c of n.children) visit(c, depth + 1);
		};
		for (const n of tree) visit(n, 0);
	}
	// labels 挂到各级（全空层级不挂，序列化保持紧凑）
	for (let lv = 0; lv < levels.length; lv++) {
		if (labelRows[lv]?.some((l) => l.trim() !== "")) levels[lv].labels = labelRows[lv];
	}

	if (levels[0].counts[0] <= 0) return null;
	return { levels, leafSpine, leafHref };
}

/** 接续阅读（Q11=B）：当前章序之前（spine ∈ [0, chapterIndex)）的叶子数 = 建目标时预勾数。 */
export function resumeLeafCount(leafSpine: number[], chapterIndex: number): number {
	return passedLeafIndices(leafSpine, chapterIndex).length;
}

/** 推进事实（Q12）：本次推进 [fromChapter, toChapter) 越过的叶下标（0-based，对齐叶序）。 */
export function crossedLeafIndices(leafSpine: number[], fromChapter: number, toChapter: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < leafSpine.length; i++) {
		const s = leafSpine[i];
		// spine=-1（锚点解析不出）按「永不越过」处理——宁可漏勾（可手动）不可误勾
		if (s >= 0 && s >= fromChapter && s < toChapter) out.push(i);
	}
	return out;
}

/** 位置事实（对账 Q13）：当前章序之前仍未勾的叶下标（全集，不限于某次推进）。 */
export function passedLeafIndices(leafSpine: number[], chapterIndex: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < leafSpine.length; i++) {
		const s = leafSpine[i];
		if (s >= 0 && s < chapterIndex) out.push(i);
	}
	return out;
}
