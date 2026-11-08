import { moment, TFile } from "obsidian";
import type { App } from "obsidian";

/**
 * ADR-0004: planflow 打卡 → 日记「## 代办事项」投影。
 * 与 bz 待办投影（bz/src/todo/diary-projection.ts）完全同格式：
 *
 *   - [ ] <序号>. <标题>-<HH:mm>      未完成
 *   - [x] <序号>. <标题>-<HH:mm>      已完成
 *
 * 序号接当天小节既有最大号续号（含用户手打编号行，避免撞号）；匹配键 = 标题。
 * 写侧语义：
 *  - checked=true：已有同标题行 → 勾上（幂等）；没有 → 续号新增勾选行（添加并勾选）。
 *  - checked=false：已有同标题勾选行 → 退回 [ ]（同 bz「面板恢复 ↔ 日记退钩」）；没有 → 不动。
 * 日记文件或「## 代办事项」小节不存在 → 静默跳过：日记骨架由 QuickAdd/bz 负责，
 * planflow 不替日记建结构。失败只记 console，绝不阻断打卡主流程。
 */

/** 日记「## 代办事项」小节标题（与 bz TODO_HEADING 同源）。 */
export const DIARY_TODO_HEADING = "## 代办事项";

/** 日记「## 完成情况跟踪」小节标题（ADR-0004 扩展：今日打卡计划项镜像区）。 */
export const DIARY_TRACKING_HEADING = "## 完成情况跟踪";

/** 日记「## 备注」小节标题（ADR-0004 扩展：今日总结写入目标）。 */
export const DIARY_REMARKS_HEADING = "## 备注";

/** 「## 备注」里旧版总结写入块的起止标记（HTML 注释，扩展五已弃用，仅作迁移清除）。 */
export const SUMMARY_BLOCK_START = "<!-- planflow:summary -->";
export const SUMMARY_BLOCK_END = "<!-- /planflow:summary -->";

/** remarksTransform 结果：变换后的全文 + 本次实际写入的块（供调用方记录，下次替换用）。 */
export interface RemarksTransformResult {
	content: string;
	written: string;
}

/** 日记「# 随笔」标题（复盘小节的插入锚点）。 */
export const DIARY_ESSAY_HEADING = "# 随笔";

/** 日记「# 当日复盘」标题（ADR-0004 扩展三：写复盘弹窗的写入目标）。 */
export const DIARY_REVIEW_HEADING = "# 当日复盘";

/** 「## 完成情况跟踪」里的计划项镜像行。 */
export interface TrackingItem {
	title: string;
	checked: boolean;
}

/** 投影行解析结果。 */
interface ProjectionLine {
	checked: boolean;
	seq: number;
	title: string;
	/** 添加时刻 HH:mm。 */
	time: string;
}

/** 投影行解析：`- [x] 3. 标题-08:30` → 结构；非投影行返回 null（与 bz 同正则）。 */
function parseProjectionLine(line: string): ProjectionLine | null {
	const m = line.match(/^- \[([xX ])\] (\d+)\.\s*(.*)$/);
	if (!m) return null;
	const tm = m[3].match(/^(.*)-(\d{2}:\d{2})$/);
	if (!tm) return null;
	return { checked: m[1].toLowerCase() === "x", seq: Number(m[2]), title: tm[1], time: tm[2] };
}

/** 构建投影行。 */
function buildProjectionLine(seq: number, title: string, time: string, checked: boolean): string {
	return `- [${checked ? "x" : " "}] ${seq}. ${title}-${time}`;
}

/**
 * 当天小节里已写下的编号最大值——续号专用。与 bz 同口径：只要是小节里
 * `- [x] N.` 形态的编号行就占号（不要求时间后缀），避免与手打编号撞车。
 */
function maxWrittenSeq(lines: string[]): number {
	let max = 0;
	for (const l of lines) {
		const m = l.match(/^- \[[xX ]\]\s*(\d+)\./);
		if (m) {
			const n = Number(m[1]);
			if (n > max) max = n;
		}
	}
	return max;
}

/**
 * 勾选打卡子任务 → 日记投影（fire-and-forget 语义：文件/小节缺失静默跳过）。
 * `diaryDir` 为空 = 功能禁用。
 */
export async function syncPoolTaskToDiary(app: App, diaryDir: string, taskTitle: string, checked: boolean): Promise<void> {
	const dir = diaryDir.replace(/\/+$/, "").trim();
	const title = taskTitle.trim();
	if (!dir || !title) return;
	const path = `${dir}/${moment().format("YYYY-MM-DD")}.md`;
	const f = app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) return;
	try {
		await app.vault.process(f, (content) => projectTransform(content, title, checked));
	} catch (e) {
		console.error("[planflow-diary-sync] 投影写入失败:", e);
	}
}

/** 内容变换（纯逻辑）：定位「## 代办事项」小节并按 checked 语义改写；无改动原样返回。 */
export function projectTransform(content: string, title: string, checked: boolean): string {
	const lines = content.split("\n");
	const headIdx = lines.findIndex((l) => l.trim() === DIARY_TODO_HEADING);
	if (headIdx === -1) return content;
	// 小节边界：到下一个任意级标题为止
	let end = lines.length;
	for (let i = headIdx + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	const section = lines.slice(headIdx + 1, end);
	let changed = false;

	if (checked) {
		const at = section.findIndex((l) => {
			const p = parseProjectionLine(l);
			return !!p && p.title === title;
		});
		if (at >= 0) {
			// 已有同标题行 → 勾上（保留原序号/时间；幂等）
			const p = parseProjectionLine(section[at])!;
			if (!p.checked) {
				section[at] = buildProjectionLine(p.seq, p.title, p.time, true);
				changed = true;
			}
		} else {
			// 新增勾选行：续号 + 插在最后一个非空行后（收尾空行结构不动）
			const seq = maxWrittenSeq(section) + 1;
			const line = buildProjectionLine(seq, title, moment().format("HH:mm"), true);
			let ins = section.length;
			while (ins > 0 && section[ins - 1].trim() === "") ins--;
			section.splice(ins, 0, line);
			changed = true;
		}
	} else {
		// 退钩：同标题的勾选行退回 [ ]（保留序号/时间；无则不动）
		for (let i = 0; i < section.length; i++) {
			const p = parseProjectionLine(section[i]);
			if (p && p.title === title && p.checked) {
				section[i] = buildProjectionLine(p.seq, p.title, p.time, false);
				changed = true;
			}
		}
	}

	if (!changed) return content;
	lines.splice(headIdx + 1, end - headIdx - 1, ...section);
	return lines.join("\n");
}

/**
 * 「## 完成情况跟踪」内容变换（纯逻辑，ADR-0004 扩展）：
 * 今日打卡的全部计划项镜像为复选框行（含未勾选的——「没完成也要有记录」）。
 *  - 小节标题下、表格上方是我们的专属区；小节里没有表格则放小节末尾。
 *  - 已有同标题行 → 只同步勾选态（幂等）；缺失 → 追加；条目消失（计划删除）→ 旧行保留
 *    不自动清理（防误删手动内容）；小节不存在 → 原样返回（不替日记建结构）。
 *  - 与表格互不干扰：只在表格前活动，表格行原样保留。
 */
export function trackingTransform(content: string, items: TrackingItem[]): string {
	const lines = content.split("\n");
	const headIdx = lines.findIndex((l) => l.trim() === DIARY_TRACKING_HEADING);
	if (headIdx === -1) return content;
	let end = lines.length;
	for (let i = headIdx + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	const section = lines.slice(headIdx + 1, end);

	// 表格起点：小节内第一个以 | 开头的行
	let tableStart = -1;
	for (let i = 0; i < section.length; i++) {
		if (section[i].trimStart().startsWith("|")) {
			tableStart = i;
			break;
		}
	}

	// 专属区 = 表格之前的区域（无表格则整节）。解析已有镜像行。
	const zone = tableStart >= 0 ? section.slice(0, tableStart) : section.slice();
	const rest = tableStart >= 0 ? section.slice(tableStart) : [];
	const proj: { line: string; checked: boolean; title: string }[] = [];
	for (const l of zone) {
		const m = l.match(/^- \[([xX ])\]\s*(.+)$/);
		if (m) proj.push({ line: l, checked: m[1].toLowerCase() === "x", title: m[2].trim() });
	}

	let changed = false;
	for (const it of items) {
		const at = proj.findIndex((p) => p.title === it.title);
		if (at >= 0) {
			if (proj[at].checked !== it.checked) {
				const idx = zone.indexOf(proj[at].line);
				if (idx >= 0) {
					zone[idx] = `- [${it.checked ? "x" : " "}] ${it.title}`;
					proj[at] = { line: zone[idx], checked: it.checked, title: it.title };
					changed = true;
				}
			}
		} else {
			zone.push(`- [${it.checked ? "x" : " "}] ${it.title}`);
			proj.push({ line: zone[zone.length - 1], checked: it.checked, title: it.title });
			changed = true;
		}
	}

	// 规整专属区与表格之间恰好一个空行（表格渲染需要前置空行）
	if (tableStart >= 0) {
		while (zone.length > 0 && zone[zone.length - 1].trim() === "") zone.pop();
		zone.push("");
	} else {
		// 无表格：保留原小节末尾的空行结构
		while (rest.length > 0 && rest[rest.length - 1].trim() === "") zone.push(rest.pop()!);
	}

	if (!changed) return content;
	lines.splice(headIdx + 1, end - headIdx - 1, ...zone, ...rest);
	return lines.join("\n");
}

/** 今日打卡计划项 → 日记「## 完成情况跟踪」镜像（文件/小节缺失静默跳过，失败只记日志）。 */
export async function syncPlanTrackingToDiary(app: App, diaryDir: string, items: TrackingItem[]): Promise<void> {
	const dir = diaryDir.replace(/\/+$/, "").trim();
	if (!dir || items.length === 0) return;
	const path = `${dir}/${moment().format("YYYY-MM-DD")}.md`;
	const f = app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) return;
	try {
		await app.vault.process(f, (content) => trackingTransform(content, items));
	} catch (e) {
		console.error("[planflow-diary-sync] 完成情况跟踪镜像失败:", e);
	}
}

/**
 * 「## 备注」内容变换（纯逻辑，ADR-0004 扩展 / 扩展五改版）：把今日总结写入备注。
 * 写入样式：无编号语境 → 各非空行加 `- ` 列表前缀（用户要求，弃 HTML 注释标记）；
 * 有已填编号行（`N. 内容`）→ 删空占位行、续接编号。空行保留作段落分隔。
 * 替换定位：prevWritten（插件上次写入并记录的块）在备注小节内连续命中 → 原位替换；
 * 未命中/未提供 → 追加。旧版 HTML 注释标记块（planflow:summary）无条件摘除（一次性迁移）。
 * 返回 written = 本次实际写入的块文本（调用方存入设置，供下次替换）。
 * 小节不存在 → 返回 null。
 */
export function remarksTransform(content: string, summary: string, prevWritten?: string): RemarksTransformResult | null {
	const lines = content.split("\n");
	const headIdx = lines.findIndex((l) => l.trim() === DIARY_REMARKS_HEADING);
	if (headIdx === -1) return null;
	let end = lines.length;
	for (let i = headIdx + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	const section = lines.slice(headIdx + 1, end);

	// 摘除旧版 HTML 注释标记块（起止行与其间内容）——一次性迁移
	let blockStart = -1;
	for (let i = 0; i < section.length; i++) {
		if (section[i].trim() === SUMMARY_BLOCK_START) {
			blockStart = i;
			break;
		}
	}
	if (blockStart >= 0) {
		let blockEnd = blockStart;
		for (let i = blockStart + 1; i < section.length; i++) {
			if (section[i].trim() === SUMMARY_BLOCK_END) {
				blockEnd = i;
				break;
			}
		}
		section.splice(blockStart, blockEnd - blockStart + 1);
	}

	// 生成新块：已有编号内容 → 续接编号；否则 `- ` 列表样式
	let base = 0;
	for (const l of section) {
		const m = l.match(/^(\d+)\.\s?(.+)$/);
		if (m && m[2].trim() !== "") base = Math.max(base, Number(m[1]));
	}
	const numbered = base > 0;
	let counter = base;
	const body: string[] = [];
	for (const l of summary.split("\n")) {
		if (l.trim() === "") {
			body.push("");
		} else if (numbered) {
			body.push(`${++counter}. ${l}`);
		} else {
			body.push(`- ${l}`);
		}
	}
	body.length = trimTrailingBlanks(body);
	const written = body.join("\n");

	// 替换：上次写入块在备注小节内连续命中 → 原位替换
	let out: string[] | null = null;
	if (prevWritten && prevWritten.trim() !== "") {
		const prev = prevWritten.split("\n").map((l) => l.trimEnd());
		for (let s = 0; s + prev.length <= section.length; s++) {
			let match = true;
			for (let k = 0; k < prev.length; k++) {
				if (section[s + k].trimEnd() !== prev[k]) {
					match = false;
					break;
				}
			}
			if (match) {
				out = [...section.slice(0, s), ...body, ...section.slice(s + prev.length)];
				break;
			}
		}
	}

	if (out === null) {
		// 追加：删掉空序号占位行，尾部空行收拢后接新块
		const keep: string[] = [];
		for (const l of section) {
			if (/^\d+\.\s?$/.test(l.trim())) continue; // 空序号占位行：丢弃
			keep.push(l);
		}
		keep.length = trimTrailingBlanks(keep);
		if (keep.length > 0) keep.push("");
		// 保留原小节末尾的空行结构
		const trailing: string[] = [];
		while (section.length > 0 && section[section.length - 1].trim() === "") trailing.unshift(section.pop()!);
		out = [...keep, ...body, ...trailing];
	}

	lines.splice(headIdx + 1, end - headIdx - 1, ...out);
	return { content: lines.join("\n"), written };
}

/** 原地截掉数组尾部空行，返回新长度。 */
function trimTrailingBlanks(arr: string[]): number {
	let n = arr.length;
	while (n > 0 && arr[n - 1].trim() === "") n--;
	return n;
}

/** 今日总结 → 日记「## 备注」写入结果。 */
export type SummaryWriteResult = { status: "ok"; written: string } | { status: "no-diary" } | { status: "no-section" };

/**
 * 写入今日总结到当天日记「## 备注」（用户主动触发：失败返回状态码供 Notice 提示）。
 * prevWritten = 插件上次写入的块（设置 summaryDiaryLast），命中则原位替换，否则追加。
 */
export async function writeSummaryToDiary(app: App, diaryDir: string, summary: string, prevWritten?: string): Promise<SummaryWriteResult> {
	const dir = diaryDir.replace(/\/+$/, "").trim();
	if (!dir || summary.trim() === "") return { status: "no-diary" };
	const path = `${dir}/${moment().format("YYYY-MM-DD")}.md`;
	const f = app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) return { status: "no-diary" };
	try {
		let result: SummaryWriteResult = { status: "no-section" };
		await app.vault.process(f, (content) => {
			const next = remarksTransform(content, summary, prevWritten);
			if (next === null) return content;
			result = { status: "ok", written: next.written };
			return next.content;
		});
		return result;
	} catch (e) {
		console.error("[planflow-diary-sync] 备注写入失败:", e);
		return { status: "no-section" };
	}
}

/**
 * 「# 当日复盘」内容变换（纯逻辑，ADR-0004 扩展三）：写复盘弹窗的写入目标。
 *  - 已有「# 当日复盘」小节（任意位置）→ 原位替换其内容（复盘一天一份，Q2a）。
 *  - 没有 → 新建标题，插在「# 随笔」小节结束处（Q1a：睡眠相关 → 随笔 → 当日复盘 → …）。
 *  - 日记无「# 随笔」小节（无法定位锚点）→ 返回 null。
 *  - 内容多行原样保留；小节前后空行结构规整为各一。
 */
export function reviewTransform(content: string, text: string): string | null {
	const lines = content.split("\n");
	// 段落体：掐掉首尾空行
	const body: string[] = [];
	for (const l of text.split("\n")) body.push(l);
	body.length = trimTrailingBlanks(body);
	let start = 0;
	while (start < body.length && body[start].trim() === "") start++;
	const bodyLines = body.slice(start);
	// 小节边界 = 下一个一级标题（`# x`）——正文里的 ## 子标题属于本小节，不能截断
	const nextH1 = (from: number): number => {
		for (let i = from; i < lines.length; i++) {
			if (/^#\s/.test(lines[i])) return i;
		}
		return lines.length;
	};

	const reviewIdx = lines.findIndex((l) => l.trim() === DIARY_REVIEW_HEADING);
	if (reviewIdx >= 0) {
		// 已有小节 → 原位替换（到下一个一级标题为止）
		const end = nextH1(reviewIdx + 1);
		lines.splice(reviewIdx + 1, end - reviewIdx - 1, "", ...bodyLines, "");
		return lines.join("\n");
	}

	// 无小节 → 锚点定位「# 随笔」小节结束处插入
	const essayIdx = lines.findIndex((l) => l.trim() === DIARY_ESSAY_HEADING);
	if (essayIdx === -1) return null;
	lines.splice(nextH1(essayIdx + 1), 0, DIARY_REVIEW_HEADING, "", ...bodyLines, "");
	return lines.join("\n");
}

/**
 * 从日记内容中提取「# 当日复盘」小节正文（纯逻辑）。
 * 已有小节 → 返回正文（掐首尾空行）；没有 → 返回 null（供弹窗预填模板）。
 */
export function extractReviewSection(content: string): string | null {
	const lines = content.split("\n");
	const idx = lines.findIndex((l) => l.trim() === DIARY_REVIEW_HEADING);
	if (idx === -1) return null;
	// 边界 = 下一个一级标题（`# x`）——正文里的 ## 子标题属于本小节
	let end = lines.length;
	for (let i = idx + 1; i < lines.length; i++) {
		if (/^#\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	const body = lines.slice(idx + 1, end);
	let s = 0;
	while (s < body.length && body[s].trim() === "") s++;
	let e = body.length;
	while (e > s && body[e - 1].trim() === "") e--;
	return body.slice(s, e).join("\n");
}

/**
 * 弹窗预填文本：用户模板 → 可填写骨架（纯逻辑）。
 * 剥掉独立复盘文件才需要的 YAML frontmatter 与一级标题（日记里已有「# 当日复盘」承载），
 * `{date}` 占位替换为当天日期。
 */
export function buildReviewPrefill(template: string, date: string): string {
	let t = template.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/\{date\}/g, date);
	const lines = t.split("\n");
	// 去掉开头的一级标题行（如「# 📝 复盘（2026-09-24）」）
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	if (lines.length > 0 && /^#\s/.test(lines[0])) lines.shift();
	t = lines.join("\n");
	let s = 0;
	const arr = t.split("\n");
	while (s < arr.length && arr[s].trim() === "") s++;
	let e = arr.length;
	while (e > s && arr[e - 1].trim() === "") e--;
	return arr.slice(s, e).join("\n");
}

/** 写复盘弹窗写入结果。 */
export type ReviewWriteResult = "ok" | "no-diary" | "no-anchor";

/** 写复盘内容到当天日记「# 当日复盘」（用户主动触发：失败返回状态码供 Notice 提示）。 */
export async function writeReviewToDiary(app: App, diaryDir: string, text: string): Promise<ReviewWriteResult> {
	const dir = diaryDir.replace(/\/+$/, "").trim();
	if (!dir || text.trim() === "") return "no-diary";
	const path = `${dir}/${moment().format("YYYY-MM-DD")}.md`;
	const f = app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) return "no-diary";
	try {
		let noAnchor = false;
		await app.vault.process(f, (content) => {
			const next = reviewTransform(content, text);
			if (next === null) {
				noAnchor = true;
				return content;
			}
			return next;
		});
		return noAnchor ? "no-anchor" : "ok";
	} catch (e) {
		console.error("[planflow-diary-sync] 复盘写入失败:", e);
		return "no-anchor";
	}
}
