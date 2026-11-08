import { App, Notice, TFile, TFolder } from "obsidian";
import { TASK_LINE_RE, dayCount, parseDateString, removeLine, toggleTaskLine, weekRange } from "./daily";
import { yearDirName } from "./paths";

/**
 * Task pool (`{root}/{year}/任务.md`) — PRD §0, DEV.md M2.
 *
 * All plan-decomposed tasks live here in Tasks format:
 *   `- [ ] 完成《霍去病》文章 #计划/写作 🛫 2026-08-10 📅 2026-08-16`
 *
 * Every mutation goes through `vault.process` so unrelated content in the
 * pool file is preserved.
 */

/** A task inside the pool file. */
export interface PoolTask {
	/** Task content (no `- [ ]` marker, no plan tag). */
	text: string;
	/** Plan tag name (without `#计划/`), or null. */
	plan: string | null;
	checked: boolean;
	/** Scheduled date `🛫`, or null. */
	start: string | null;
	/** Due date `📅`, or null. */
	due: string | null;
	/** 0-based line index inside the pool file. */
	line: number;
	/** Full raw line. */
	raw: string;
	/** The pool file this task lives in. */
	file: TFile;
}

/** Input for creating / editing a task (checked state is preserved on edit). */
export interface NewTaskInput {
	text: string;
	plan: string | null;
	start: string | null;
	due: string | null;
}

/** Path of the task pool file for a given year. */
export function poolPath(rootPath: string, year: string): string {
	const root = rootPath.replace(/\/+$/, "");
	return `${root}/${yearDirName(year)}/任务.md`;
}

/** Parse a task pool file's content into tasks. */
export function parseTaskPool(file: TFile, content: string): PoolTask[] {
	const tasks: PoolTask[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = TASK_LINE_RE.exec(lines[i]);
		if (!m) continue;
		tasks.push({
			text: m[2].trim(),
			plan: m[3] ?? null,
			checked: m[1] === "x",
			start: m[4] ?? null,
			due: m[5] ?? null,
			line: i,
			raw: lines[i],
			file,
		});
	}
	return tasks;
}

/** Read all tasks from the pool; returns an empty array when the file doesn't exist. */
export async function listTasks(app: App, rootPath: string, year: string): Promise<PoolTask[]> {
	const f = app.vault.getAbstractFileByPath(poolPath(rootPath, year));
	if (!(f instanceof TFile)) return [];
	const content = await app.vault.cachedRead(f);
	return parseTaskPool(f, content);
}

/** Build a Tasks-format line for the pool. */
export function buildPoolLine({ text, plan, start, due }: NewTaskInput): string {
	let line = `- [ ] ${text.trim()}`;
	if (plan && plan.trim()) line += ` #计划/${plan.trim()}`;
	if (start) line += ` 🛫 ${start}`;
	if (due) line += ` 📅 ${due}`;
	return line;
}

/** Add a task to the pool (creates the pool file / folders if missing). */
export async function addTask(app: App, rootPath: string, year: string, input: NewTaskInput): Promise<void> {
	const path = poolPath(rootPath, year);
	const line = buildPoolLine(input);
	const folder = path.slice(0, path.lastIndexOf("/"));
	if (folder) await ensureFolder(app, folder);

	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.process(existing, (data) => appendLine(data, line));
		return;
	}
	await app.vault.create(path, line + "\n");
}

/** Toggle a task's checkbox and write it back. */
export async function toggleTask(app: App, task: PoolTask, checked: boolean): Promise<void> {
	await app.vault.process(task.file, (data) => {
		const idx = locateTaskLine(data, task);
		if (idx === -1) {
			new Notice("任务已变动，勾选未执行（请刷新视图后重试）");
			return data;
		}
		return toggleTaskLine(data, idx, checked);
	});
}

/** Replace a task's content / plan / dates, keeping its checked state. */
export async function editTask(app: App, task: PoolTask, input: NewTaskInput): Promise<void> {
	await app.vault.process(task.file, (data) => {
		const idx = locateTaskLine(data, task);
		if (idx === -1) {
			new Notice("任务已变动，修改未保存（请刷新视图后重试）");
			return data;
		}
		const lines = data.split("\n");
		// v2.5 (B1): 字段级编辑——只替换插件认识的字段，保留行内其他手动内容（禁止整行重建）
		lines[idx] = editTaskLine(lines[idx], input, task.checked);
		return lines.join("\n");
	});
}

/** Delete a task line from the pool. */
export async function deleteTask(app: App, task: PoolTask): Promise<void> {
	await app.vault.process(task.file, (data) => {
		const idx = locateTaskLine(data, task);
		if (idx === -1) {
			new Notice("任务已变动，删除未执行（请刷新视图后重试）");
			return data;
		}
		return removeLine(data, idx);
	});
}

/**
 * v2.5 (B2): 内容定位（替代解析时行号快照）——文件被外部修改后行号会漂移，
 * 盲按行号写回会作用到错误行。先按 raw 精确匹配，再按 text 前缀兜底，都找不到则 -1（fail-safe）。
 */
function locateTaskLine(data: string, task: PoolTask): number {
	const lines = data.split("\n");
	const byRaw = lines.findIndex((l) => l === task.raw);
	if (byRaw !== -1) return byRaw;
	const prefix = `- [${task.checked ? "x" : " "}] ${task.text}`;
	return lines.findIndex((l) => l.startsWith(prefix));
}

/**
 * v1.0.4 修复：v2.5 的文本区正则 /^[^#🛫📅]+/ 锚定在行首，会把「- [ ]」前缀一起吞掉——
 * 写回后行不再匹配 TASK_LINE_RE，任务在所有视图里"消失"（甘特拖拽 = 编辑，等于误删）。
 * 现在先显式摘出前缀，字段级编辑只作用于正文，最后拼回前缀。
 */
function editTaskLine(line: string, input: NewTaskInput, checked: boolean): string {
	const m = /^- \[([ x])\][ \t]?(.*)$/.exec(line);
	if (!m) return line; // 非标准任务行：不碰，防止破坏手动内容
	const prefix = checked ? "- [x]" : "- [ ]";
	let body = m[2];
	// 1. 文本区：正文行首到第一个字段标记（# / 🛫 / 📅）之间替换为新文本
	body = body.replace(/^[^#🛫📅]*/u, `${input.text.trim()} `);
	// 2. 计划标签：删旧 → 加新（无则不加）
	body = body.replace(/#计划\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
	if (input.plan && input.plan.trim()) body += ` #计划/${input.plan.trim()}`;
	// 3. 开始日期
	body = body.replace(/🛫\s*\S+/g, "").replace(/\s{2,}/g, " ").trim();
	if (input.start) body += ` 🛫 ${input.start}`;
	// 4. 截止日期
	body = body.replace(/📅\s*\S+/g, "").replace(/\s{2,}/g, " ").trim();
	if (input.due) body += ` 📅 ${input.due}`;
	return `${prefix} ${body}`;
}

/** Append a line to content, always terminating it with a single newline. */
function appendLine(content: string, line: string): string {
	if (!content.trim()) return line + "\n";
	return content.replace(/\s+$/, "") + "\n" + line + "\n";
}

/** Create folders along a vault path (no-op for existing ones). */
async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const parts = folderPath.split("/").filter(Boolean);
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(cur);
		if (existing instanceof TFolder) continue;
		if (existing) {
			new Notice(`路径冲突：${cur}`);
			return;
		}
		await app.vault.createFolder(cur);
	}
}

// ---------------------------------------------------------------------------
// v1.2: automatic weekly decomposition for quantity-type plans (DEV.md v1.2)
// ---------------------------------------------------------------------------

/** A quantified goal under a plan (v1.2: plans are categories, goals carry counts). */
export interface AutoGoal {
	/** Goal name shown on tasks: 「{name}（第 N {unit}）」. */
	name: string;
	/** Target quantity. */
	count: number;
	/** Counter noun (篇/本/条/个/…). */
	unit: string;
	/** Optional custom window (defaults to the plan period). */
	start?: string;
	end?: string;
	/**
	 * ADR-0005 章节型（兼容）：逐章节数（下标 0 = 第 1 章）。非空时按章节序列
	 * 「{name}（第 X 章第 Y 节）」分解，count 恒等于 Σ chapters。
	 */
	chapters?: number[];
	/** ADR-0005 v2 多级结构：篇→章→节 等任意 1~3 级单位树（优先于 chapters）。 */
	structure?: GoalLevel[];
}

/** A quantity-type plan eligible for auto task generation. */
export interface AutoTaskPlan {
	/** Plan name / label, e.g. "写作". */
	name: string;
	/** Target description, e.g. "12 篇公众号文章" (legacy unit fallback). */
	target: string;
	/** Numeric target, e.g. 12. */
	targetCount: number;
	/** Quantified goals (v1.2). Empty → legacy plan-level decomposition. */
	goals: AutoGoal[];
}

export const DAY_MS = 86400000;

/** 自动任务名尾部「（第<数字>…）」后缀（分解任务的通配形态，ADR-0005 v2）。 */
const AUTO_TASK_SUFFIX_RE = /（第\s*\d+[^）]*）$/;

/**
 * 通用自动任务名识别：以「（第<数字>…）」后缀结尾即视为分解任务（ADR-0005 v2：
 * 覆盖任意单位词与多级路径，含自定义单位；误判手动任务只会让删除多打一条墓碑，无副作用）。
 */
export function isAutoTask(task: PoolTask): boolean {
	return AUTO_TASK_SUFFIX_RE.test(task.text.trim());
}

/**
 * ADR-0008: 从任务文本提取目标（书）名——剥掉尾部「（第…）」后缀。
 * 无后缀或前缀为空（如裸「（第 3 篇）」）返回 null，即识别不到所属目标；
 * 识别不到的任务不进书组（今日级联里平铺在顶部）。
 */
export function extractGoalName(text: string): string | null {
	const trimmed = text.trim();
	const m = AUTO_TASK_SUFFIX_RE.exec(trimmed);
	if (!m) return null;
	const name = trimmed.slice(0, m.index).trim();
	return name || null;
}

/** ADR-0008: 今日级联按书（目标）分组的一个书组。 */
export interface BookGroup {
	/** 目标（书）名（任务名前缀）。 */
	name: string;
	/** 该书全部任务（含已勾，任务池口径）。 */
	tasks: PoolTask[];
	/** 该做还没做的叶（未勾且 🛫 ≤ today，无 🛫 用 📅 兜底——与 pendingPoolChildren 同口径）。 */
	pending: PoolTask[];
	/** 今日份额中已勾的叶（阅读窗口覆盖今天且已勾）——展开已勾书行逐叶退钩用。 */
	todayDone: PoolTask[];
	/** 今日有安排 = 阅读窗口覆盖今天（🛫 ≤ today ≤ 📅，含预读已勾）或挂逾期欠账（pending 非空）。 */
	scheduled: boolean;
}

/**
 * ADR-0008: 把某计划的今日级联任务按目标（书）分组。分组键 = 任务名前缀
 * （extractGoalName）；识别不到目标名的任务原样返回（ungrouped），由调用方平铺。
 * 书序 = 传入顺序 = 任务池文件顺序（Map 插入序）。
 * 分母口径：scheduled = 阅读窗口覆盖今天（🛫 ≤ today ≤ 📅，跨日窗口起读当天即计入）
 * 或有逾期欠账；窗口未开始、已读完的书 scheduled = false，不进「今日书进度」分母。
 */
export function groupPoolTasksByGoal(tasks: PoolTask[], today: string): { groups: BookGroup[]; ungrouped: PoolTask[] } {
	const byName = new Map<string, PoolTask[]>();
	const ungrouped: PoolTask[] = [];
	for (const t of tasks) {
		const name = extractGoalName(t.text);
		if (!name) {
			ungrouped.push(t);
			continue;
		}
		const bucket = byName.get(name);
		if (bucket) bucket.push(t);
		else byName.set(name, [t]);
	}
	// 「今天的叶」= 窗口 [🛫, 📅] 覆盖今天。只看 📅 = today 会漏掉跨日窗口的叶
	// （🛫 = 今天、📅 = 明天的叶起读当天就勾了，也必须计作今日安排/今日完成）。
	const coversToday = (t: PoolTask): boolean => {
		const s = t.start ?? t.due;
		const d = t.due ?? t.start;
		return !!s && !!d && s <= today && today <= d;
	};
	const groups: BookGroup[] = [];
	for (const [name, groupTasks] of byName) {
		const pending = groupTasks.filter((t) => {
			if (t.checked) return false;
			const effStart = t.start ?? t.due;
			return !!effStart && effStart <= today;
		});
		const todayDone = groupTasks.filter((t) => t.checked && coversToday(t));
		const scheduled = pending.length > 0 || groupTasks.some(coversToday);
		groups.push({ name, tasks: groupTasks, pending, todayDone, scheduled });
	}
	return { groups, ungrouped };
}

/**
 * ADR-0005 v2 多级结构：部→卷→篇→章→节 之类的任意 1~8 级单位树，叶子 = 逐日可勾选任务。
 * 编号按真书惯例：重排型单位（节/讲/课/回）每上级从 1 重新编号；其余单位（篇/卷/部/章…）
 * 全书连续编号（第 2 篇的章是第 3、4、5 章）。
 */

/** 多级结构的一级定义：单位词 + 该级各节点数目。 */
export interface GoalLevel {
	/** 单位词（部/编/卷/辑/篇/单元/模块/章/回/课/讲/集/幕/场/节/小节/目/条…，可自定义任意短词）。 */
	unit: string;
	/**
	 * 该级各节点数目，按全书顺序：level 0 = [总数]；level n = 每个上级节点的子数目
	 * （长度 = 上一级节点总数）。
	 */
	counts: number[];
}

/** 一个分级单位的定义：词 + 默认编号方式。 */
export interface UnitDef {
	/** 单位词。 */
	word: string;
	/** true = 编号每上级从 1 重排（如：节每章重排、场每幕重排）；false = 全书连续（如：章跨篇连续）。 */
	restart: boolean;
}

/**
 * 分级单位词表（ADR-0005 v3，按真实书籍层级从大到小排序）：
 * 现代/学术书 部/编→卷→篇→章→节→小节/目；古籍 篇/卷/回；教材 单元→课/讲；戏剧 幕→场；影音 集；法规 条。
 */
export const STRUCT_UNITS: UnitDef[] = [
	{ word: "部", restart: false },
	{ word: "编", restart: false },
	{ word: "卷", restart: false },
	{ word: "辑", restart: false },
	{ word: "篇", restart: false },
	{ word: "单元", restart: false },
	{ word: "模块", restart: false },
	{ word: "章", restart: false },
	{ word: "回", restart: false },
	{ word: "课", restart: false },
	{ word: "讲", restart: false },
	{ word: "集", restart: false },
	{ word: "幕", restart: false },
	{ word: "场", restart: true },
	{ word: "节", restart: true },
	{ word: "小节", restart: true },
	{ word: "目", restart: true },
	{ word: "条", restart: true },
];

/** 重排型单位集合（编号在每上级内从 1 重新开始）。 */
const RESTART_UNITS = new Set(STRUCT_UNITS.filter((u) => u.restart).map((u) => u.word));

/** 常见层级接续（用于向导里下一级单位的智能推荐，取第一项为默认建议）。 */
const UNIT_SUCCESSORS: Record<string, string[]> = {
	部: ["卷", "篇"],
	编: ["章", "篇"],
	卷: ["篇", "章"],
	辑: ["篇", "章"],
	篇: ["章", "单元"],
	单元: ["课", "讲"],
	模块: ["单元", "课"],
	章: ["节", "讲"],
	回: ["节"],
	课: ["节", "讲"],
	讲: ["节"],
	集: ["讲", "节"],
	幕: ["场"],
	场: ["节"],
	节: ["小节", "目"],
	小节: ["目"],
	目: ["条"],
	条: [],
};

/** 下一级单位推荐：按真实书籍层级惯例给出接续词；未知词默认「节」。 */
export function suggestNextUnit(prevUnit: string): string {
	const list = UNIT_SUCCESSORS[prevUnit.trim()];
	return list?.[0] ?? "节";
}

/** 单位默认编号方式：true = 每上级从 1 重排（节/场/目…）；false = 全书连续（部/卷/篇/章/回/课/讲…）。未知词按连续处理。 */
export function isRestartUnit(word: string): boolean {
	return RESTART_UNITS.has(word.trim());
}

/** 展开后的叶子（= 一个可勾选任务）。 */
export interface GoalLeaf {
	/** 完整任务文本「{goalName}（第 X 章第 Y 节）」等。 */
	name: string;
	/** 全书 1-based 顺序（均匀分日键）。 */
	index: number;
	/** 进度汇总组标签（倒数第二级节点显示名；单级结构为空串）。 */
	group: string;
}

interface StructureNode {
	label: string;
	/** 自身单位词。 */
	unit: string;
	/** 自身单位是否重排型。 */
	restart: boolean;
	/** 上级显示名（level 0 为 null）。 */
	parentLabel: string | null;
	parentRestart: boolean;
	/** 本级全局序号。 */
	global: number;
}

interface StructureWrapper {
	node: StructureNode;
	children: StructureWrapper[];
	/** 上级 wrapper（level 0 为 null）——重排叶名沿链收集用。 */
	parent: StructureWrapper | null;
}

/**
 * 展开多级结构为叶子序列（书序 = DFS 序）。
 * 返回空数组表示结构非法（级数/数目不合法）。
 * 某节点的子数目为 0（如第 5 章没有节）时，该节点本身成为叶子——任务即「第 5 章」
 * （变深树：叶出现在不同层级，勾选粒度逐节点自适应）。
 */
export function expandGoalStructure(goalName: string, levels: GoalLevel[]): GoalLeaf[] {
	const clean = (v: unknown): number => {
		const n = typeof v === "number" ? Math.floor(v) : parseInt(String(v), 10);
		return Number.isFinite(n) && n >= 0 ? n : 0;
	};
	if (!Array.isArray(levels) || levels.length === 0 || levels.length > 8) return [];

	let level: StructureWrapper[] = [];
	let roots: StructureWrapper[] = [];
	for (let li = 0; li < levels.length; li++) {
		const unit = String(levels[li]?.unit ?? "").trim();
		if (!unit) return [];
		const restart = RESTART_UNITS.has(unit);
		const next: StructureWrapper[] = [];
		let g = 0;
		if (li === 0) {
			const n = clean(levels[0].counts?.[0]);
			if (n <= 0) return [];
			for (let i = 1; i <= n; i++) {
				g++;
				next.push({
					node: { label: `第 ${i} ${unit}`, unit, restart, parentLabel: null, parentRestart: false, global: g },
					children: [],
					parent: null,
				});
			}
		} else {
			const counts = levels[li].counts;
			if (!Array.isArray(counts) || counts.length < level.length) return [];
			for (let pi = 0; pi < level.length; pi++) {
				const parent = level[pi].node;
				const n = clean(counts[pi]);
				for (let c = 1; c <= n; c++) {
					g++;
					const num = restart ? c : g;
					next.push({
						node: {
							label: `第 ${num} ${unit}`,
							unit,
							restart,
							parentLabel: parent.label,
							parentRestart: parent.restart,
							global: g,
						},
						children: [],
						parent: level[pi],
					});
					level[pi].children.push(next[next.length - 1]);
				}
			}
			// 某级全为 0 合法：上一级节点全部升格为叶子（DFS 收集时自然处理）
		}
		if (li === 0) roots = next;
		level = next;
	}

	// 叶收集（DFS）：末级节点是叶；中间节点若无任何子节点也升格为叶（如无节的章）
	const leaves: GoalLeaf[] = [];
	const lastIdx = levels.length - 1;
	const rollupIdx = levels.length - 2; // 倒数第二级 = 进度汇总组
	/**
	 * 路径式标签：从 w 沿上级链收集连续重排标签，锚定最近的全书连续级（或根）。
	 * 章→节→小节：第X章第Y节第Z小节，与书内 1.2.1 式目录一致；章→节：第X章第Y节；
	 * 全局型节点：自身全局标签（第X章/第X篇）。
	 */
	const pathSuffix = (w: StructureWrapper): string => {
		if (!w.node.restart) return w.node.label;
		const parts: string[] = [w.node.label];
		let cur = w.parent;
		while (cur) {
			parts.unshift(cur.node.label);
			if (!cur.node.restart) break;
			cur = cur.parent;
		}
		return parts.join("");
	};
	const visit = (w: StructureWrapper, depth: number, rollup: StructureWrapper | null): void => {
		const rollupAncestor = depth === rollupIdx ? w : rollup;
		if (depth === lastIdx || w.children.length === 0) {
			// 组标签用路径式：节的编号每章重排，裸标签「第 1 节」会跨章撞名
			// 升格节点（非末级）无 rollup 祖先时以自身路径为组——进度里能看到「第 2 卷 1/1」这类行
			leaves.push({
				name: `${goalName}（${pathSuffix(w)}）`,
				index: leaves.length + 1,
				group: rollupAncestor ? pathSuffix(rollupAncestor) : depth !== lastIdx ? pathSuffix(w) : "",
			});
			return;
		}
		for (const child of w.children) visit(child, depth + 1, rollupAncestor);
	};
	for (const root of roots) visit(root, 0, null);
	return leaves;
}

/** 旧 chapters: [2,3,4]（逐章节数）→ 等价两级结构（命名与旧版完全一致，兼容存量数据）。 */
export function chaptersToStructure(chapters: number[]): GoalLevel[] {
	return [
		{ unit: "章", counts: [chapters.length] },
		{ unit: "节", counts: chapters.map((c) => Math.max(0, Math.floor(c))) },
	];
}

/** 展开目标的叶子：structure 优先，chapters 兼容转换；两者皆无返回 null（扁平目标）。 */
export function expandGoalLeaves(goalName: string, goal: { chapters?: number[]; structure?: GoalLevel[] }): GoalLeaf[] | null {
	if (goal.structure?.length) return expandGoalStructure(goalName, goal.structure);
	if (goal.chapters?.length) return expandGoalStructure(goalName, chaptersToStructure(goal.chapters));
	return null;
}

/** ADR-0005 编辑重排 context: pure inputs for `rescheduleChapterLine`. */
export interface ChapterRescheduleContext {
	/** Plan tag the goal belongs to. */
	plan: string;
	/** Goal name prefix «{name}（». */
	prefix: string;
	/** Valid leaf-task names; prefix-matching tasks outside this set are deleted. */
	valid: ReadonlySet<string>;
	/**
	 * 叶任务名 → 序号（1-based）within the REMAINING (unchecked) sequence.
	 * 重排 = 剩余序列从头摊：已勾的节不占新窗口位置（它们的原日期保留作记录）。
	 */
	leafIndexByName: ReadonlyMap<string, number>;
	/** Remaining (unchecked) leaf count. */
	total: number;
	/** Reschedule window (ISO dates) — explicit goal window or the plan period. */
	start: string;
	end: string;
}

/**
 * ADR-0005 编辑重排：单行纯变换（编辑目标时对任务池逐行调用）。
 * 返回 null = 删除该行（失效叶子）；返回字符串 = 原行或重排后的行。
 * 规则：非本计划/本目标的行不动；失效叶子删行；已勾的保留原日期（进度记录不重写，
 * 且不占新窗口位置）；未勾的按「剩余序列 × 新窗口」均匀分布重排 🛫/📅（与分解引擎
 * 同一公式，日期无变化则原样返回）。全未读时剩余序列 = 全序列，与初次分解一致。
 */
export function rescheduleChapterLine(line: string, ctx: ChapterRescheduleContext): string | null {
	const m = TASK_LINE_RE.exec(line);
	if (!m) return line;
	const text = m[2].trim();
	if (m[3] !== ctx.plan || !text.startsWith(ctx.prefix)) return line;
	if (!ctx.valid.has(text)) return null;
	if (m[1] === "x") return line;
	const idx = ctx.leafIndexByName.get(text);
	if (idx === undefined) return line;
	const totalDays = Math.max(1, dayCount(ctx.start, ctx.end));
	const ns = addDaysStr(ctx.start, Math.floor(((idx - 1) * totalDays) / ctx.total));
	const nd = idx < ctx.total ? addDaysStr(ctx.start, Math.floor((idx * totalDays) / ctx.total) - 1) : ctx.end;
	const due = nd < ns ? ns : nd;
	if (ns === m[4] && due === m[5]) return line;
	return `- [${m[1]}] ${text} #计划/${m[3]} 🛫 ${ns} 📅 ${due}`;
}

/** ISO-week context for auto-task quotas. */
export interface AutoWeekContext {
	/** 1-based index of the current week within the plan's week sequence. */
	weekIndex: number;
	/** Total number of ISO weeks in the plan period. */
	totalWeeks: number;
	/** This week's Monday (ISO date). */
	weekStart: string;
	/** This week's Sunday (ISO date). */
	weekEnd: string;
}

/**
 * Extract the counter noun from a plan target (篇/本/…/天), defaulting to 篇.
 * Used for auto task names and progress numbers (e.g. "0/144 天").
 */
export function planCounterUnit(target: string): string {
	const m = /(\d+)\s*(篇|本|条|个|部|期|集|次|份|张|幅|门|天|章|节)/.exec(target);
	return m ? m[2] : "篇";
}

/**
 * Compute the ISO-week context for auto-task quotas.
 * Returns null when `today` is outside the plan's week range (before start
 * or after the final week — nothing to generate then).
 */
export function autoWeekContext(planStart: string, planEnd: string, today: string): AutoWeekContext | null {
	// Strict date-level guard: the plan period hasn't started yet (or is over).
	if (today < planStart || today > planEnd) return null;

	const startMon = weekRange(planStart).start;
	const endMon = weekRange(planEnd).start;
	const thisMon = weekRange(today).start;
	if (thisMon < startMon || thisMon > endMon) return null;

	const totalWeeks = Math.round((parseDateString(endMon).getTime() - parseDateString(startMon).getTime()) / (DAY_MS * 7)) + 1;
	const rawIndex = Math.round((parseDateString(thisMon).getTime() - parseDateString(startMon).getTime()) / (DAY_MS * 7)) + 1;
	const weekIndex = Math.max(1, Math.min(rawIndex, Math.max(totalWeeks, 1)));
	return { weekIndex, totalWeeks, weekStart: thisMon, weekEnd: weekRange(today).end };
}

/**
 * Cumulative quota through week N (DEV.md v1.2):
 * `quota_n = ceil(targetCount × n / totalWeeks)`; each week generates
 * `quota_n - quota_{n-1}` tasks (0/1/2).
 */
export function autoQuota(targetCount: number, weekIndex: number, totalWeeks: number): number {
	if (targetCount <= 0 || totalWeeks <= 0) return 0;
	return Math.ceil((targetCount * weekIndex) / totalWeeks);
}

/**
 * Generate this week's auto tasks for quantity-type plans (DEV.md v1.2).
 *
 * Idempotent: a task whose name already matches an existing auto task for the
 * plan is never duplicated (checked or not). Manual tasks — names not matching
 * the auto pattern — are ignored and don't affect the count.
 *
 * Task naming: `{label}（第 N 篇）`, N continuing from the highest existing
 * auto-task number. New tasks are dated to this week's window (🛫 Mon 📅 Sun).
 */
/**
 * Compute the N values of the auto tasks to create this week.
 * Continues from the highest existing auto-task number (avoids re-using a
 * number when a middle task was deleted) and skips names that already exist
 * or that the user deliberately deleted (`skipNames`, v1.0.4 墓碑机制).
 */
export function autoTaskNumbers(
	existingAuto: PoolTask[],
	need: number,
	targetCount: number,
	label: string,
	unit: string,
	skipNames?: ReadonlySet<string>
): number[] {
	let maxN = 0;
	for (const t of existingAuto) {
		const m = /（第\s*(\d+)[^）]*）$/.exec(t.text.trim());
		if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
	}
	const nums: number[] = [];
	let n = maxN + 1;
	while (nums.length < need && n <= targetCount) {
		const name = `${label}（第 ${n} ${unit}）`;
		if (!existingAuto.some((t) => t.text.trim() === name) && !skipNames?.has(name)) nums.push(n);
		n++;
	}
	return nums;
}

/**
 * Generate this week's auto tasks for quantity-type plans (DEV.md v1.2).
 *
 * Idempotent: a task whose name already matches an existing auto task for the
 * plan is never duplicated (checked or not). Manual tasks — names not matching
 * the auto pattern — are ignored and don't affect the count.
 *
 * Task naming: `{label}（第 N 篇）`, N continuing from the highest existing
 * auto-task number. New tasks are dated to this week's window (🛫 Mon 📅 Sun).
 *
 * v1.0.4: `skipNames` = 用户手动删除过的自动任务名（墓碑）。计数与补号都跳过它们，
 * 否则删除配额内最后一个任务会在下次 top-up 时被"复活"（need = count - existing）。
 */
export async function ensureAutoTasks(
	app: App,
	rootPath: string,
	year: string,
	today: string,
	plans: AutoTaskPlan[],
	planStart: string,
	planEnd: string,
	skipNames?: ReadonlySet<string>
): Promise<void> {
	const skip = skipNames ?? new Set<string>();
	if (plans.length === 0) return;
	const ctx = autoWeekContext(planStart, planEnd, today);
	if (!ctx) return;

	const tasks = await listTasks(app, rootPath, year);

	for (const plan of plans) {
		// v1.2: 全量分解——count 个任务一次生成，日期均匀分布在 goal 窗口内
		for (const goal of plan.goals) {
			if (goal.count <= 0) continue;
			const gStart = goal.start ?? planStart;
			const gEnd = goal.end ?? planEnd;
			// v1.5: 未来窗口也全量生成（提前可见规划）；仅跳过已结束窗口
			if (today > gEnd) continue;
			const totalDays = Math.max(1, Math.round((parseDateString(gEnd).getTime() - parseDateString(gStart).getTime()) / DAY_MS) + 1);
			const prefix = `${goal.name}（`;

			// ADR-0005 v2: 结构型目标（structure 或兼容 chapters）——按叶子书序生成任务，
			// 均匀分布公式与扁平分解一致（k 为全书时序下标，总叶数为分母；除不尽时前面几天多一节）
			const leaves = expandGoalLeaves(goal.name, goal);
			if (leaves && leaves.length > 0) {
				const existingNames = new Set(
					tasks
						.filter((t) => t.plan === plan.name && t.text.trim().startsWith(prefix))
						.map((t) => t.text.trim())
				);
				for (const leaf of leaves) {
					// 幂等 + 墓碑按名跳过：用户手动删过的叶子不复活（与扁平 top-up 同语义）
					if (existingNames.has(leaf.name) || skip.has(leaf.name)) continue;
					const startDate = addDaysStr(gStart, Math.floor(((leaf.index - 1) * totalDays) / leaves.length));
					let dueDate: string;
					if (leaf.index < leaves.length) {
						dueDate = addDaysStr(gStart, Math.floor((leaf.index * totalDays) / leaves.length) - 1);
					} else {
						dueDate = gEnd;
					}
					if (dueDate < startDate) dueDate = startDate;
					await addTask(app, rootPath, year, { text: leaf.name, plan: plan.name, start: startDate, due: dueDate });
				}
				continue;
			}

			const existing = tasks.filter(
				(t) => t.plan === plan.name && t.text.trim().startsWith(prefix) && !skip.has(t.text.trim())
			);
			// v1.0.4: 被墓碑标记的名额视为"用户决定不要"，不再补足
			const tombstoned = [...skip].filter((n) => n.startsWith(prefix)).length;
			const need = goal.count - existing.length - tombstoned;
			if (need <= 0) continue;

			const nums = autoTaskNumbers(existing, need, goal.count, goal.name, goal.unit, skip);
			for (const n of nums) {
				const name = `${goal.name}（第 ${n} ${goal.unit}）`;
				// v1.5 跨度任务：任务 n 从分配日到下一个任务分配日前一天（最后一个到窗口末）
				const startDate = addDaysStr(gStart, Math.floor(((n - 1) * totalDays) / goal.count));
				let dueDate: string;
				if (n < goal.count) {
					dueDate = addDaysStr(gStart, Math.floor((n * totalDays) / goal.count) - 1);
				} else {
					dueDate = gEnd;
				}
				if (dueDate < startDate) dueDate = startDate;
				await addTask(app, rootPath, year, { text: name, plan: plan.name, start: startDate, due: dueDate });
			}
		}
		// v1.0.4: 移除计划级遗留分解（v1.2 老格式：plan 无 goals 但 target 文本带数字时按 targetCount 全量生成）。
		// 它会在用户删掉量化目标后继续"凭 target 文本"生成 {plan}（第 N 篇） 任务——
		// 用户视角即"目标已删、任务还在自动补"。分解只认显式 goals 定义；targetCount 仍用于进度展示。
	}
}

/** Add n days to an ISO date string, e.g. addDaysStr("2026-08-12", 3) → "2026-08-15". */
function addDaysStr(date: string, n: number): string {
	const d = new Date(parseDateString(date).getTime() + n * DAY_MS);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${dd}`;
}
