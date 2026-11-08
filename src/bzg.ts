import type { App } from "obsidian";

/**
 * BZG 只读联动（ADR-0007）。
 *
 * BZG 是用户的复习/日记系统（外部插件，review/diary 域冻结，ADR-0121），
 * 无任何对外 API——纯文件落盘是唯一接口。planflow 只读两类文件：
 *
 * 1. `{storagePath}/review.json`（默认 `CONFIG/STORAGE/review.json`）
 *    每条 ReviewItem 带 `reviewHistory[].timestamp`（UTC ISO）。
 *    「某天复习了几篇」= 当天（本地日）有过复习记录的**不同文档数**（同篇
 *    一天内多次评级只算 1 篇；累计次数与文档数对不上，不作口径——CONTEXT.md「覆盖率」）。
 * 2. `{diaryDirectory}/{YYYY-MM-DD}.md`（默认 `我的/日记`）
 *    日文件打开即预铺骨架，「文件存在 ≠ 写了」。完成事实 = 本人亲手写下的
 *    内容：「# 随笔」或「# 当日触动点」小节里有正文行；投影/勾选不算
 *    （planflow 自己写的是「## 代办事项」「## 完成情况跟踪」，互不重叠，防循环自证）。
 *
 * 路径以 BZG 自己的 `.obsidian/plugins/BZG/data.json` 为准（用户改了设置也跟得上），
 * 读不到按约定路径兜底；BZG 缺席 → 返回 null，调用方静默降级为手动记录。
 */

/** BZG data.json 里 planflow 关心的三个路径设置。 */
export interface BzgConfig {
	/** 共享数据目录（review.json 所在），如 "CONFIG/STORAGE"。 */
	storagePath: string;
	/** 日记目录，如 "我的/日记"。 */
	diaryDirectory: string;
	/** 复习候选文件夹（文献池），如 "卡片盒/文献"；可为空。 */
	reviewCountFolder: string;
}

/** 联动快照：一次解析，多次查询（每次视图刷新构建一份）。 */
export interface BzgSnapshot {
	/** review.json 所在目录（原样来自配置）。 */
	storagePath: string;
	/** 日记目录。 */
	diaryDir: string;
	/** 文献池文件夹（可为空 = 未配置）。 */
	poolFolder: string;
	/** 本地日 → 当天复习过的文档路径集合。 */
	byDay: Map<string, Set<string>>;
	/** 文档路径 → 复习过的本地日集合（覆盖率用）。 */
	byPath: Map<string, Set<string>>;
}

const BZG_DATA_JSON = ".obsidian/plugins/BZG/data.json";
const DEFAULT_STORAGE = "CONFIG/STORAGE";
const DEFAULT_DIARY_DIR = "我的/日记";

/** 读 BZG 的 data.json 取真实路径；BZG 未安装/不可读 → null。 */
export async function readBzgConfig(app: App): Promise<BzgConfig | null> {
	try {
		const raw = await app.vault.adapter.read(BZG_DATA_JSON);
		const data = JSON.parse(raw) as Record<string, unknown>;
		const str = (v: unknown, fallback: string): string =>
			typeof v === "string" && v.trim() !== "" ? v.trim().replace(/\/+$/, "") : fallback;
		return {
			storagePath: str(data.storagePath, DEFAULT_STORAGE),
			diaryDirectory: str(data.diaryDirectory, DEFAULT_DIARY_DIR),
			reviewCountFolder: typeof data.reviewCountFolder === "string" ? data.reviewCountFolder.trim() : "",
		};
	} catch {
		return null;
	}
}

/** UTC ISO 时间戳 → 本地日 YYYY-MM-DD（BZG 存 UTC，按天聚合必须换算）。 */
export function utcToLocalDay(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** review.json 的一条最小记录：文档路径 + 全部复习时间戳。 */
export interface BzgReviewItem {
	filePath: string;
	timestamps: string[];
}

/**
 * 解析 review.json 原文为最小记录集。
 * 容错：非法 JSON / 缺字段返回空数组——联动是锦上添花，绝不因外部文件异常炸掉视图。
 */
export function parseReviewItems(raw: string): BzgReviewItem[] {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	const out: BzgReviewItem[] = [];
	for (const el of data) {
		if (!el || typeof el !== "object") continue;
		const rec = el as Record<string, unknown>;
		const filePath = typeof rec.filePath === "string" ? rec.filePath : "";
		if (!filePath) continue;
		const history = Array.isArray(rec.reviewHistory) ? rec.reviewHistory : [];
		const timestamps: string[] = [];
		for (const h of history) {
			const ts = h && typeof h === "object" && typeof (h as Record<string, unknown>).timestamp === "string"
				? ((h as Record<string, unknown>).timestamp as string)
				: "";
			if (ts) timestamps.push(ts);
		}
		// 历史为空但 lastReviewed 存在（理论上不该出现）也收进来，保底计数
		if (timestamps.length === 0 && typeof rec.lastReviewed === "string") {
			timestamps.push(rec.lastReviewed as string);
		}
		out.push({ filePath, timestamps });
	}
	return out;
}

/** 从记录集构建快照（本地日聚合 + 去重）。 */
export function buildBzgSnapshot(items: BzgReviewItem[], cfg: BzgConfig): BzgSnapshot {
	const byDay = new Map<string, Set<string>>();
	const byPath = new Map<string, Set<string>>();
	for (const item of items) {
		let days = byPath.get(item.filePath);
		if (!days) {
			days = new Set<string>();
			byPath.set(item.filePath, days);
		}
		for (const ts of item.timestamps) {
			const day = utcToLocalDay(ts);
			if (!day) continue;
			days.add(day);
			let set = byDay.get(day);
			if (!set) {
				set = new Set<string>();
				byDay.set(day, set);
			}
			set.add(item.filePath);
		}
	}
	return {
		storagePath: cfg.storagePath,
		diaryDir: cfg.diaryDirectory,
		poolFolder: cfg.reviewCountFolder,
		byDay,
		byPath,
	};
}

/** 某本地日复习过的不同文档数（同篇多次评级算 1）。 */
export function reviewedOn(snap: BzgSnapshot, localDay: string): number {
	return snap.byDay.get(localDay)?.size ?? 0;
}

/** [start, end] 窗口内复习过的不同文档总数（覆盖率分子）。 */
export function distinctReviewedInRange(snap: BzgSnapshot, start: string, end: string): number {
	let count = 0;
	for (const days of snap.byPath.values()) {
		for (const d of days) {
			if (d >= start && d <= end) {
				count++;
				break;
			}
		}
	}
	return count;
}

/** 文献池文档数（BZG 复习候选文件夹下的 md 文件数，递归）。 */
export function reviewPoolSize(app: App, snap: BzgSnapshot): number {
	if (!snap.poolFolder) return 0;
	const prefix = `${snap.poolFolder.replace(/\/+$/, "")}/`;
	return app.vault.getFiles().filter((f) => f.path.startsWith(prefix) && f.path.endsWith(".md")).length;
}

// ---------------------------------------------------------------------------
// 日记「写了没」判定（ADR-0007：只认本人亲手写下的内容）
// ---------------------------------------------------------------------------

/** 日文件的两大写作小节（BZG 落笔/触动点写入；planflow 投影从不写这两节）。 */
const DIARY_WRITE_SECTIONS = new Set(["随笔", "当日触动点"]);

/**
 * 判定当天日记是否「真写了」：
 * `# 随笔` 或 `# 当日触动点` 小节下存在非空正文行（`**📖 09:18**` 落笔块或任何文字）。
 * 传 null（文件不存在）→ false。骨架各小节为空标题 → false。
 * 任何标题（含 `##` 子标题）都会终止小节归属——「# 随笔」后紧跟「## 代办事项」时，
 * 代办行绝不计入随笔（防投影内容循环自证）。
 */
export function diaryDayWritten(content: string | null): boolean {
	if (!content) return false;
	const lines = content.split("\n");
	let current = "";
	for (const raw of lines) {
		const line = raw.trimEnd();
		const heading = /^(#+)\s+(.*)$/.exec(line);
		if (heading) {
			// 一级标题切换小节；更深层标题终止归属（子小节内容不属于任何写作小节）
			current = heading[1].length === 1 ? heading[2].trim() : "";
			continue;
		}
		if (line.trim() === "") continue;
		if (DIARY_WRITE_SECTIONS.has(current) && line.trim().length > 0) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// App 包装（读写走 vault；隐藏目录 adapter 兜底）
// ---------------------------------------------------------------------------

/** 加载联动快照；联动关闭 / BZG 缺席 / review.json 不可读 → null（调用方静默降级）。 */
export async function loadBzgSnapshot(app: App, enabled: boolean): Promise<BzgSnapshot | null> {
	if (!enabled) return null;
	const cfg = await readBzgConfig(app);
	if (!cfg) return null;
	const path = `${cfg.storagePath}/review.json`;
	let raw = "";
	try {
		const f = app.vault.getAbstractFileByPath(path);
		if (f && typeof (f as { stat?: unknown }).stat === "object") {
			raw = await app.vault.cachedRead(f as Parameters<App["vault"]["cachedRead"]>[0]);
		} else {
			raw = await app.vault.adapter.read(path);
		}
	} catch {
		return null;
	}
	return buildBzgSnapshot(parseReviewItems(raw), cfg);
}

/** 读某天 BZG 日记日文件内容；不存在 → null。 */
export async function readBzgDiaryText(app: App, snap: BzgSnapshot, date: string): Promise<string | null> {
	const path = `${snap.diaryDir}/${date}.md`;
	try {
		const f = app.vault.getAbstractFileByPath(path);
		if (!f) return null;
		return await app.vault.cachedRead(f as Parameters<App["vault"]["cachedRead"]>[0]);
	} catch {
		return null;
	}
}
