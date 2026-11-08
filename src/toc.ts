import type { GoalLevel } from "./tasks";
import { STRUCT_UNITS, expandGoalStructure } from "./tasks";

/**
 * 书籍目录粘贴解析（阅读书籍模式增强，ADR-0006）。
 *
 * 输入：用户从任意来源复制的目录文本（每行一章/一节）。支持三种层级线索，
 * 可任意混合（真实目录常见「第X章」顶层 + 1.2 数字子级）：
 * 1. 单位词编号（family=U）：`第X编/篇/部/卷/章/回/课/讲/集/幕/场/节/小节/目/条`——
 *    同族内按 STRUCT_UNITS 真书层级序比较（篇 > 章 > 节）。
 * 2. 数字编号（family=N）：`1.` / `1.2` / `1.2.3`（含顿号）——同族内按数字段数比较。
 * 3. 缩进（family=I）：无上述线索时，每 2 空格（或 1 Tab）= 1 级。
 *
 * 归一化用**家族感知栈**：同族按原始刻度进退栈，跨族一律视为「挂到最近浅层节点」
 * ——两套刻度不可直接比大小，这是混合目录唯一可靠的归并规则。
 *
 * 输出：GoalLevel[]（与 ADR-0005 多级结构同一数据）。解析是尽力而为：结果进
 * 确认页摘要预览，用户可回层级页微调后再保存。
 */

/** 无单位词时的默认单位链（数字编号 1 / 1.2 / 1.2.3 逐级取用）。 */
export const DEFAULT_UNIT_CHAIN = ["章", "节", "小节", "目", "条", "细目"];

/** 单位词层级序（由大到小，与 STRUCT_UNITS 词表一致）。 */
const UNIT_ORDER: string[] = STRUCT_UNITS.map((u) => u.word);

const CN_UNIT_RE = /^第\s*[0-9一二三四五六七八九十百千]+\s*(部|编|卷|辑|篇|单元|模块|章|回|课|讲|集|幕|场|节|小节|目|条)/;

/**
 * 从单条目录标签提取单位词（ADR-0009 桥导入用）：「第3章」→「章」，
 * 无命中返回空串（调用方落默认链）。与 parseTocLine 共用词表与正则。
 */
export function extractTocUnitWord(label: string): string {
	const m = CN_UNIT_RE.exec(label.trim());
	return m ? m[1] : "";
}
const CN_ORD_RE = /^[一二三四五六七八九十百]+[、.．]/;

/** 结构级数上限（与向导 MAX_STRUCTURE_LEVELS 对齐）。 */
const MAX_TOC_LEVELS = 8;
/** 目录条目上限（防御性：粘贴了整本书正文也不会卡死向导）。 */
const MAX_TOC_LINES = 500;

/** 层级线索家族：U=单位词序（真书层级），N=数字编号深度，I=缩进。 */
type TocFamily = "U" | "N" | "I";

export interface TocLine {
	/** 清洗后的标题文本。 */
	title: string;
	/** 家族内原始层级刻度（跨族不可比）。 */
	level: number;
	/** 线索家族。 */
	family: TocFamily;
	/** 命中的单位词（可为空）。 */
	unit: string;
}

export interface TocParseResult {
	levels: GoalLevel[];
	/** 识别为目录条目的行数。 */
	lineCount: number;
	/** 被跳过的非空行数（页码/「目录」标题等）。 */
	skipped: number;
	/** 归一化后每层的单位词。 */
	units: string[];
}

interface TocNode {
	depth: number;
	unit: string;
	children: TocNode[];
}

/** 单行解析：清洗 + 层级线索识别。不构成条目的行返回 null。 */
export function parseTocLine(rawLine: string): TocLine | null {
	let line = rawLine.trim();
	// Markdown 列表标记 / 项目符号
	line = line.replace(/^[-*•·]\s*(?:\[[ x]\]\s*)?/, "");
	if (!line) return null;
	// 去掉行尾页码（“……12” / “. 12”）
	line = line.replace(/[.·…\s]{1,}\d{1,4}$/, "").trim();
	if (!line) return null;
	// 纯「目录 / Contents」行不算条目
	if (/^(目录|目錄|contents|table of contents)$/i.test(line)) return null;

	// 1) 中文单位词编号（同族内按真书层级序比较）
	const cn = CN_UNIT_RE.exec(line);
	if (cn) {
		return { title: line, level: UNIT_ORDER.indexOf(cn[1]), family: "U", unit: cn[1] };
	}
	// 2) 数字编号 1 / 1.2 / 1.2.3（1、2 顿号写法归入这里；深度 = 数字段数-1）
	const num = /^(\d+)(?:[.、](\d+))?(?:\.(\d+))?/.exec(line);
	if (num) {
		const depth = num[3] ? 2 : num[2] ? 1 : 0;
		return { title: line, level: depth, family: "N", unit: DEFAULT_UNIT_CHAIN[depth] ?? `级${depth + 1}` };
	}
	// 3) 中文序号（一、二、）→ N 族顶层
	if (CN_ORD_RE.test(line)) {
		return { title: line, level: 0, family: "N", unit: DEFAULT_UNIT_CHAIN[0] };
	}
	// 4) 缩进兜底：每 2 空格或 1 Tab 一级
	const indentChunk = rawLine.match(/^[\t ]*/)![0];
	let indent = 0;
	for (const ch of indentChunk) indent += ch === "\t" ? 1 : 0.5;
	if (indent >= 1) return { title: line, level: Math.floor(indent), family: "I", unit: "" };
	// 无任何线索 → N 族顶层（默认链按顶层取名）
	return { title: line, level: 0, family: "N", unit: DEFAULT_UNIT_CHAIN[0] };
}

/**
 * 解析整段目录文本。返回 null = 一条有效条目都没有（或结构非法）。
 */
export function parseToc(text: string): TocParseResult | null {
	const items: TocLine[] = [];
	let skipped = 0;
	for (const l of text.split(/\r?\n/)) {
		if (!l.trim()) continue;
		const item = parseTocLine(l);
		if (!item) {
			skipped++;
			continue;
		}
		items.push(item);
		if (items.length >= MAX_TOC_LINES) break;
	}
	if (items.length === 0) return null;

	// 家族感知栈归一化（锚点规则）：单位词序（U）与数字深度（N）是两套不可直接
	// 比大小的刻度，混排时只能「同族找锚、跨族挂顶」：
	//   1. 从栈顶向下找最近的同族条目（level ≤ 当前）作锚点；
	//   2. 锚点更深 → 当前是锚点的孩子；锚点同级 → 当前是锚点的兄弟（挂锚点的父）；
	//   3. 无同族锚点 → 挂栈顶（最近的跨族外层），栈空挂根。
	// 例：第1章(U) → 1.1(N, 挂章下) → 1.2(N, 与 1.1 同级) → 第2章(U, 与第1章同级)。
	const virtualRoot: TocNode = { depth: -1, unit: "", children: [] };
	const stack: { family: TocFamily; level: number; node: TocNode }[] = [];
	for (const item of items) {
		let anchorIdx = -1;
		for (let i = stack.length - 1; i >= 0; i--) {
			if (stack[i].family === item.family && stack[i].level <= item.level) {
				anchorIdx = i;
				break;
			}
		}
		let parent: TocNode | null = null;
		if (anchorIdx >= 0) {
			if (stack[anchorIdx].level < item.level) {
				// 孩子锚点：保留锚点及其外层
				stack.length = anchorIdx + 1;
				parent = stack[anchorIdx].node;
			} else {
				// 同级锚点：退到锚点的父
				stack.length = anchorIdx;
				parent = anchorIdx > 0 ? stack[anchorIdx - 1].node : null;
			}
		} else {
			// 无同族锚点：挂最近的跨族外层（栈顶）
			stack.length = stack.length; // 不弹——跨族条目仍是合法外层
			parent = stack.length > 0 ? stack[stack.length - 1].node : null;
		}
		const depth = parent ? parent.depth + 1 : 0;
		if (depth >= MAX_TOC_LEVELS) {
			// 超深：并到最深层（防御性，正常目录不会触发）
			const leafParent = stack[stack.length - 1]?.node ?? virtualRoot;
			leafParent.children.push({ depth: leafParent.depth + 1, unit: item.unit, children: [] });
			continue;
		}
		const node: TocNode = { depth, unit: item.unit, children: [] };
		(parent ?? virtualRoot).children.push(node);
		stack.push({ family: item.family, level: item.level, node });
	}
	if (virtualRoot.children.length === 0) return null;

	// 每层单位词：该层节点里最高频的命中单位词；缺失用默认链兜底
	let maxDepth = 0;
	const freq: Map<string, number>[] = [];
	{
		const walk = (nodes: TocNode[]): void => {
			for (const n of nodes) {
				while (freq.length <= n.depth) freq.push(new Map());
				if (n.unit) freq[n.depth].set(n.unit, (freq[n.depth].get(n.unit) ?? 0) + 1);
				maxDepth = Math.max(maxDepth, n.depth + 1);
				walk(n.children);
			}
		};
		walk(virtualRoot.children);
	}
	const units: string[] = [];
	for (let i = 0; i < maxDepth; i++) {
		let best = "";
		let bestN = 0;
		for (const [w, n] of freq[i] ?? []) {
			if (n > bestN) {
				best = w;
				bestN = n;
			}
		}
		units.push(best || DEFAULT_UNIT_CHAIN[i] || `级${i + 1}`);
	}

	// GoalLevel：level0 = [顶层节点数]；level n = 每个 level-(n-1) 节点（DFS 序）的子数目
	const levels: GoalLevel[] = units.map((unit) => ({ unit, counts: [] }));
	levels[0].counts = [virtualRoot.children.length];
	{
		let current = virtualRoot.children;
		for (let lv = 1; lv < levels.length; lv++) {
			levels[lv].counts = current.map((n) => n.children.length);
			current = current.flatMap((n) => n.children);
		}
	}

	// 合法性：用展开引擎验证（非法返回 null，让用户走手填层级）
	const leaves = expandGoalStructure("书", levels);
	if (!leaves || leaves.length === 0) return null;
	return { levels, lineCount: items.length, skipped, units };
}

/** 摘要文本：「识别 42 行（跳过 3 行） · 章 ×3 → 节 ×12」。 */
export function tocSummary(result: TocParseResult): string {
	const parts = result.levels.map((lv) => `${lv.unit} ×${lv.counts.reduce((a, b) => a + b, 0)}`);
	return `识别 ${result.lineCount} 行${result.skipped ? `（跳过 ${result.skipped} 行）` : ""} · ${parts.join(" → ")}`;
}

/** 预览展开后的叶子顺序（首 → 末路径）。 */
export function tocLeafRange(bookName: string, levels: GoalLevel[]): string {
	const leaves = expandGoalStructure(bookName || "书", levels);
	if (leaves.length === 0) return "";
	const strip = (name: string): string => name.slice(name.indexOf("（") + 1, -1);
	return `${strip(leaves[0].name)} → ${strip(leaves[leaves.length - 1].name)}`;
}
