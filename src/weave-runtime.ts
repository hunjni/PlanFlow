import { App, Modal, Notice, Plugin } from "obsidian";
import type PlanFlowPlugin from "../main";
import {
	getWeaveBridge,
	passedLeafIndices,
	passedLeafIndicesFine,
	WEAVE_ADVANCE_EVENT,
	weaveTocToStructure,
	type WeaveAdvanceDetail,
	type WeaveBookSummary,
	type WeaveBridgeApi,
	type WeaveTocNode,
} from "./weave-bridge";
import {
	expandGoalLeaves,
	expandGoalStructure,
	listTasks,
	toggleTask,
	type GoalLevel,
	type PoolTask,
} from "./tasks";
import { MANUAL_MARK, markTaskLineManual, toggleTaskLine } from "./daily";
import { syncPoolTaskToDiary } from "./diary-sync";
import { parsePlansFromFrontmatter, type PlanDef, type PlanGoal } from "./stats";
import { yearDirName } from "./paths";

/**
 * weave 阅读联动运行时（ADR-0009）：插件级控制器——推进事件监听、对账补勾、
 * 锚点自愈迁移、确认门写回。生命周期与应用相同，不依赖任何视图是否打开
 * （此前挂在 PlanBoard 视图上，视图未恢复时全链瘫痪）。
 *
 * 视图侧只消费本模块的导出：getWeaveAlignment（叶 🔗 锚点）、reconcileNow
 * （面板打开时的对账）、leafAnchorsFor。事件监听只有本模块一处，杜绝双弹窗。
 */

/** 视图注入的年度计划写盘器（migrate 用）；main.ts 装配，缺席时迁移只改内存。 */
export interface WeaveRuntimeDeps {
	app: App;
	plugin: PlanFlowPlugin;
	writePlanFile?: (app: App, file: import("obsidian").TFile, plans: PlanDef[], dailyByPlan?: Record<string, boolean>) => Promise<void>;
}

let deps: WeaveRuntimeDeps | null = null;
let listening = false;
let lastReconcile = 0;
let renderQueued = false;
const weaveAlign = new Map<string, { spine: number[]; progress: number[]; hrefs: string[] } | null>();
const weaveAlignPending = new Map<string, Promise<{ spine: number[]; progress: number[]; hrefs: string[] } | null>>();
const weaveAlignWarned = new Set<string>();
const weaveMigrated = new Set<string>();
const weaveNotices = new Map<string, { hide: () => void }>();

/** 视图 🔗 回填探测：sid 是否已有对齐缓存。 */
export function isAlignCached(sid: string): boolean {
	return weaveAlign.has(sid);
}

/** 视图 🔗 回填：确保对齐解析（异步）。 */
export async function ensureWeaveAlignment(sid: string, goal: PlanGoal): Promise<{ spine: number[]; progress: number[]; hrefs: string[] } | null> {
	return resolveWeaveAlignment(sid, goal);
}

export function getWeaveAlignment(goal: PlanGoal): { spine: number[]; progress: number[]; hrefs: string[] } | null {
	if (goal.readerAnchors?.length) {
		return {
			spine: goal.readerAnchors.map((a) => a.spine),
			progress: goal.readerAnchors.map((a) => (typeof a.progress === "number" ? a.progress : -1)),
			hrefs: goal.readerAnchors.map((a) => a.href),
		};
	}
	return goal.readerSid ? (weaveAlign.get(goal.readerSid) ?? null) : null;
}

export function detectBridge(plugin: PlanFlowPlugin): WeaveBridgeApi | null {
	return getWeaveBridge(plugin.app, plugin.settings.weaveEnabled);
}

/** 视图刷新时调用：桥重建 + 今日面板下的对账（节流在内部）。 */
export function reconcileIfOpen(plugin: PlanFlowPlugin): void {
	if (!deps) deps = { app: plugin.app, plugin };
	void reconcileNow(plugin, false);
}

/** 启动运行时：注册推进事件监听 + 延迟首跑对账（等 fork 与年度计划就绪）。 */
export function startWeaveRuntime(plugin: PlanFlowPlugin, runtimeDeps?: WeaveRuntimeDeps): void {
	if (runtimeDeps) deps = runtimeDeps;
	deps = deps ?? { app: plugin.app, plugin };
	if (!listening) {
		listening = true;
		const handler = (evt: Event): void => {
			void onWeaveAdvance((evt as CustomEvent<WeaveAdvanceDetail>).detail);
		};
		window.addEventListener(WEAVE_ADVANCE_EVENT, handler);
		plugin.register(() => {
			window.removeEventListener(WEAVE_ADVANCE_EVENT, handler);
			listening = false;
		});
	}
	// 延迟首跑：等 fork 插件与 PlanBoard 自动打开完成（启动时序在探测处已懒重试兜底）
	window.setTimeout(() => {
		void reconcileNow(plugin, true);
	}, 10000);
}

export function stopWeaveRuntime(): void {
	/* 监听器经 plugin.registerUnload 注销；此处保留扩展点 */
}

// -------------------------------------------------------------------------
// 目标 / 任务定位（插件级直读年度计划与任务池，不依赖视图状态）
// -------------------------------------------------------------------------

async function readReaderGoals(): Promise<{ plan: string; goal: PlanGoal }[]> {
	const { app, plugin } = deps!;
	const root = plugin.settings.rootPath.replace(/\/+$/, "");
	const year = new Date().toISOString().slice(0, 4);
	const out: { plan: string; goal: PlanGoal }[] = [];
	for (const path of [`${root}/${yearDirName(year)}/年度计划.md`, `${root}/年度计划.md`]) {
		const f = app.vault.getAbstractFileByPath(path);
		if (f && typeof (f as { stat?: unknown }).stat === "object") {
			const defs = parsePlansFromFrontmatter(await app.vault.cachedRead(f as Parameters<App["vault"]["cachedRead"]>[0]));
			for (const d of defs) {
				for (const g of d.goals) {
					if (g.readerSid) out.push({ plan: d.name, goal: g });
				}
			}
			break;
		}
	}
	return out;
}

async function readPoolTasks(): Promise<PoolTask[]> {
	const { app, plugin } = deps!;
	const root = plugin.settings.rootPath.replace(/\/+$/, "");
	const year = new Date().toISOString().slice(0, 4);
	return listTasks(app, root, year);
}

function findGoalBySid(sid: string): { plan: string; goal: PlanGoal } | null {
	// 同步场景由调用方传入 goals（reconcile/advance 都先读过年度计划）
	return null;
}

/**
 * 叶序锚点解析：桥目录树与目标结构**逐叶名字比对**一致才可用（只比长度抓不住
 * 顺序错位）；不一致 → 缓存 null，联动对该书停用。异步，带 in-flight 去重。
 */
async function resolveWeaveAlignment(sid: string, goal: PlanGoal): Promise<{ spine: number[]; progress: number[]; hrefs: string[] } | null> {
	if (weaveAlign.has(sid)) return weaveAlign.get(sid) ?? null;
	const pending = weaveAlignPending.get(sid);
	if (pending) return pending;
	const task = (async (): Promise<{ spine: number[]; progress: number[]; hrefs: string[] } | null> => {
		let result: { spine: number[]; progress: number[]; hrefs: string[] } | null = null;
		try {
			const tree = await deps!.plugin && detectBridge(deps!.plugin) ? await detectBridge(deps!.plugin)?.getToc(sid) : null;
			const conv = weaveTocToStructure(tree ?? null);
			const goalLeaves = expandGoalLeaves(goal.name, goal);
			const convLeaves = conv ? expandGoalStructure(goal.name, conv.levels) : [];
			if (
				conv &&
				goalLeaves &&
				goalLeaves.length === convLeaves.length &&
				goalLeaves.every((l, i) => l.name === convLeaves[i].name)
			) {
				result = { spine: conv.leafSpine, progress: conv.leafProgress, hrefs: conv.leafHref };
			}
		} catch {
			result = null;
		}
		weaveAlign.set(sid, result);
		weaveAlignPending.delete(sid);
		return result;
	})();
	weaveAlignPending.set(sid, task);
	return task;
}

// -------------------------------------------------------------------------
// 推进事实（确认门）+ 对账兜底 + 自愈迁移
// -------------------------------------------------------------------------

async function onWeaveAdvance(d: WeaveAdvanceDetail): Promise<void> {
	if (!deps) return;
	const { app, plugin } = deps;
	const bridge = detectBridge(plugin);
	if (!bridge || !d?.sid || !Number.isFinite(d.chapterIndex)) return;
	console.info("[PlanFlow] 收到阅读推进事件:", d);
	logDebug(app, `advance received: sid=${d.sid} ch=${d.chapterIndex} prog=${d.sectionProgress}`);
	const goals = await readReaderGoals();
	const hit = goals.find((x) => x.goal.readerSid === d.sid);
	if (!hit) {
		logDebug(app, `advance: 无对应联动目标（sid 未绑定）: ${d.sid}`);
		return;
	}
	if (!hit.goal.readerAnchors?.every((a) => typeof a.progress === "number")) {
		await migrateAnchorProgress(hit.plan, hit.goal);
	}
	const align = getWeaveAlignment(hit.goal) ?? (await resolveWeaveAlignment(d.sid, hit.goal));
	if (!align) {
		warnMisaligned(d.sid, hit.goal.name);
		return;
	}
	const sectionProgress = Number.isFinite(d.sectionProgress) ? d.sectionProgress : -1;
	const crossed = passedLeafIndicesFine(align.spine, align.progress, d.chapterIndex, sectionProgress);
	const pool = await readPoolTasks();
	await confirmLeaves(hit, crossed, pool);
}

/** 对账兜底（Q13=B）：打开今日面板按书架当前位置批量确认（重启/跨设备最终一致）。 */
export async function reconcileNow(plugin: PlanFlowPlugin, initial: boolean): Promise<void> {
	if (!deps) deps = { app: plugin.app, plugin };
	const bridge = detectBridge(plugin);
	if (!bridge) return;
	const now = Date.now();
	if (!initial && now - lastReconcile < 60000) return; // 1 分钟节流：兜底不是追问
	lastReconcile = now;
	let shelf: WeaveBookSummary[] | null = null;
	try {
		shelf = await bridge.getBookshelf();
	} catch (e) {
		logDebug(plugin.app, `对账取书架失败: ${e}`);
		return;
	}
	if (!shelf?.length) return;
	const goals = await readReaderGoals();
	const pool = await readPoolTasks();
	for (const hit of goals) {
		const sid = hit.goal.readerSid!;
		await migrateAnchorProgress(hit.plan, hit.goal);
		const align = getWeaveAlignment(hit.goal) ?? (await resolveWeaveAlignment(sid, hit.goal));
		if (!align) {
			warnMisaligned(sid, hit.goal.name);
			continue;
		}
		let crossed: number[];
		if (bridge.getPosition) {
			const pos = await bridge.getPosition(sid);
			crossed = passedLeafIndicesFine(align.spine, align.progress, pos?.chapterIndex ?? -1, pos?.sectionProgress ?? -1);
		} else {
			const book = shelf.find((b) => b.sid === sid);
			crossed = passedLeafIndices(align.spine, book?.chapterIndex ?? -1);
		}
		logDebug(deps.app, `reconcile: ${hit.goal.name} crossed=${crossed.length}`);
		await confirmLeaves(hit, crossed, pool);
	}
}

/** 对齐失效的一次性提示（无落盘锚点的旧目标实时对齐失败 → 联动停用）。 */
function warnMisaligned(sid: string, goalName: string): void {
	if (weaveAlignWarned.has(sid)) return;
	weaveAlignWarned.add(sid);
	new Notice(`📖《${goalName}》：无法与阅读器目录对齐，叶跳转/推进勾选停用；删除该目标后从书架重建一次即可（重建会落盘每叶锚点，此后改结构也不失效）`);
}

/**
 * 自愈迁移：进度字段（progress）上线前的两段式锚点按叶名比对从实时目录补齐
 * 并写回年度计划 frontmatter（每 sid 一次；成功后该书即享逐节触发，无需重建）。
 */
async function migrateAnchorProgress(planName: string, goal: PlanGoal): Promise<void> {
	const sid = goal.readerSid;
	if (!sid || weaveMigrated.has(sid)) return;
	const anchors = goal.readerAnchors;
	if (!anchors?.length || anchors.every((a) => typeof a.progress === "number")) {
		weaveMigrated.add(sid);
		return;
	}
	weaveMigrated.add(sid);
	if (!deps) return;
	const { app, plugin } = deps;
	const bridge = detectBridge(plugin);
	if (!bridge?.getProgressByHref) {
		logDebug(app, `migration skip(${goal.name}): bridge/getProgressByHref 不可用`);
		return;
	}
	logDebug(app, `migration start(${goal.name}): hrefs=${anchors.filter((a) => a.href).length}/${anchors.length}`);
	try {
		// 按 href 逐条解析文件内进度（不依赖实时目录形状——结构被手工修正过也能迁移）
		const fractions = await bridge.getProgressByHref(
			sid,
			anchors.map((a) => a.href)
		);
		for (let i = 0; i < anchors.length; i++) {
			if (typeof fractions[i] === "number") {
				anchors[i].progress = fractions[i] as number;
			}
		}
		// 邻叶继承：仍无进度的叶（手工补录、href 空缺）按「与前一个叶同章同进度段」
		// 处理——顺序阅读语义下，读到前一个叶越过时它们一并越过
		let prevSpine = -1;
		let prevProgress = -1;
		for (const a of anchors) {
			if (typeof a.progress !== "number") {
				if (a.spine === prevSpine && prevProgress >= 0) a.progress = prevProgress;
			}
			if (typeof a.progress === "number") {
				prevSpine = a.spine;
				prevProgress = a.progress;
			}
		}
		const filled = anchors.filter((a) => typeof a.progress === "number").length;
		if (filled === 0) {
			logDebug(app, `migration skip(${goal.name}): 无一 href 可解析进度`);
			return;
		}
		weaveAlign.set(sid, {
			spine: anchors.map((a) => a.spine),
			progress: anchors.map((a) => (typeof a.progress === "number" ? a.progress : -1)),
			hrefs: anchors.map((a) => a.href),
		});
		// 落盘：年度计划文件就地改写 readerAnchors（流式单行 → 正则定位）
		const root = plugin.settings.rootPath.replace(/\/+$/, "");
		const year = new Date().toISOString().slice(0, 4);
		const path = `${root}/${yearDirName(year)}/年度计划.md`;
		const f = app.vault.getAbstractFileByPath(path);
		if (f && typeof (f as { stat?: unknown }).stat === "object") {
			await app.vault.process(f as Parameters<App["vault"]["process"]>[0], (data) => {
				const lines = data.split("\n");
				let inGoal = false;
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (/^\s{6,}- name: /.test(line)) inGoal = line.includes(`- name: ${goal.name}`);
					if (inGoal && /^\s*readerAnchors: \[/.test(line)) {
						lines[i] = `        readerAnchors: [${goal
							.readerAnchors!.map((a) =>
								`${a.spine}|${a.href}${typeof a.progress === "number" ? `|${a.progress}` : ""}`
							)
							.map((v) => JSON.stringify(v))
							.join(", ")}]`;
						inGoal = false;
					}
				}
				return lines.join("\n");
			});
			logDebug(app, `migration OK(${goal.name}): ${filled}/${anchors.length} 叶已带文件内进度`);
			new Notice(`📖《${goal.name}》阅读联动锚点已自动升级（${filled}/${anchors.length} 叶逐节触发）`);
		}
	} catch (e) {
		logDebug(app, `migration ERROR(${goal.name}): ${e}`);
	}
}

async function confirmLeaves(
	hit: { plan: string; goal: PlanGoal },
	leafIdxs: number[],
	pool: PoolTask[]
): Promise<void> {
	const sid = hit.goal.readerSid;
	if (!sid || !deps || leafIdxs.length === 0) return;
	if (weaveNotices.has(sid)) {
		logDebug(deps.app, `confirm skip(${hit.goal.name}): 确认窗已打开`);
		return;
	}
	const { app, plugin } = deps;
	const leaves = expandGoalLeaves(hit.goal.name, hit.goal);
	if (!leaves) return;
	const prefix = `${hit.goal.name}（`;
	const candidates = pool.filter(
		(t) => t.plan === hit.plan && t.text.trim().startsWith(prefix) && !t.checked && !t.raw.includes(MANUAL_MARK)
	);
	const todo = leaves
		.filter((_l, i) => leafIdxs.includes(i))
		.map((l) => candidates.find((t) => t.text.trim() === l.name))
		.filter((t): t is PoolTask => !!t);
	if (todo.length === 0) {
		logDebug(deps.app, `confirm silent(${hit.goal.name}): crossed=${leafIdxs.length} 但可勾候选=0（已勾/已✋）`);
		return;
	}
	const unit = hit.goal.unit || "节";
	if (todo.length === 1) {
		const notice = new Notice(`📖《${hit.goal.name}》阅读位置已越过 1 ${unit}`, 0);
		weaveNotices.set(sid, notice);
		const done = (): void => {
			weaveNotices.delete(sid);
			notice.hide();
		};
		const bar = notice.noticeEl.createDiv({ cls: "planboard-notice-actions" });
		const okBtn = bar.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "✓ 勾选" });
		okBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			done();
			void applyWeaveCheck(hit, todo, true);
		});
		const skipBtn = bar.createEl("button", { cls: "planboard-btn", text: "忽略" });
		skipBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			done();
			void applyWeaveCheck(hit, todo, false);
		});
		notice.noticeEl.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("button")) return;
			done();
		});
		return;
	}
	const modal = new WeaveConfirmModal(
		app,
		hit.goal.name,
		unit,
		todo,
		(picked) => applyWeaveCheck(hit, picked, true),
		() => applyWeaveCheck(hit, todo, false)
	);
	weaveNotices.set(sid, { hide: () => modal.close() });
	modal.open();
}

/** 确认结果写回：勾选（任务池 + 日记投影）或忽略（落 ✋，自动逻辑不再碰）。 */
async function applyWeaveCheck(hit: { plan: string; goal: PlanGoal }, tasks: PoolTask[], check: boolean): Promise<void> {
	if (!deps) return;
	const { app, plugin } = deps;
	try {
		for (const t of tasks) {
			if (check) {
				await toggleTask(app, t, true);
				await syncPoolTaskToDiary(app, plugin.settings.diaryDir, t.text, true);
			} else {
				await app.vault.process(t.file, (data) => markTaskLineManual(data, t.line, t.raw));
			}
		}
	} catch (e) {
		logDebug(app, `apply ERROR: ${e}`);
		return;
	}
	new Notice(check ? `已勾选 ${tasks.length} ${hit.goal.unit || "节"}` : `已忽略 ${tasks.length} ${hit.goal.unit || "节"}（此后不再自动勾选，可手动勾）`);
	plugin.refreshView();
}

function logDebug(app: App, line: string): void {
	try {
		const path = `${app.vault.configDir}/plugins/planflow/weave-debug.log`;
		void app.vault.adapter.append(path, `[${new Date().toISOString()}] ${line}\n`).catch(() => undefined);
	} catch {
		/* 排障日志绝不炸功能 */
	}
}

/**
 * ADR-0009 推进确认（多叶形态）：大文件书一次跨章越过一批叶时，逐叶勾选
 * 「哪些真的看完了」——勾选所选；未选中的不落 ✋，下次推进/对账再问。
 */
class WeaveConfirmModal extends Modal {
	private readonly items: { task: PoolTask; picked: boolean }[];
	constructor(
		app: App,
		private readonly goalName: string,
		private readonly unit: string,
		tasks: PoolTask[],
		private readonly onCheck: (picked: PoolTask[]) => Promise<void>,
		private readonly onIgnoreAll: () => Promise<void>
	) {
		super(app);
		this.items = tasks.map((task) => ({ task, picked: true }));
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h3", { text: `📖《${this.goalName}》阅读位置已越过 ${this.items.length} ${this.unit}` });
		contentEl.createDiv({
			cls: "planboard-goal-preview",
			text: "勾选真正看完的（这本书的章节文件较大，一次越过的部分可自行甄别）；未勾的下次再问",
		});
		const list = contentEl.createDiv({ cls: "planboard-struct-box" });
		for (const it of this.items) {
			const row = list.createDiv({ cls: "planboard-tree-row" });
			const cb = row.createEl("input", { type: "checkbox", cls: "planboard-checkbox" });
			cb.checked = true;
			cb.addEventListener("change", () => {
				it.picked = cb.checked;
			});
			row.createSpan({ cls: "planboard-tree-label", text: it.task.text });
		}
		const actions = contentEl.createDiv({ cls: "planboard-struct-actions" });
		const ok = actions.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "✓ 勾选所选", attr: { type: "button" } });
		ok.addEventListener("click", () => {
			this.close();
			void this.onCheck(this.items.filter((i) => i.picked).map((i) => i.task));
		});
		const ignoreAll = actions.createEl("button", { cls: "planboard-btn", text: "全部忽略 ✋", attr: { type: "button" } });
		ignoreAll.addEventListener("click", () => {
			this.close();
			void this.onIgnoreAll();
		});
		const cancel = actions.createEl("button", { cls: "planboard-btn", text: "取消", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
