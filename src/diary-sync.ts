import { moment, TFile } from "obsidian";
import type { App } from "obsidian";

/**
 * 日记写入（ADR-0004 → ADR-0018 收窄）：planflow 只写**用户主动触发**的日记内容——
 * 「## 备注」今日总结、「# 当日复盘」、「# 次日计划」。
 *
 * ADR-0018（2026-11-13）：原「## 代办事项」/「## 完成情况跟踪」两处自动投影**已退役**。
 * 日记三节（日常行为记录 / 代办事项 / 完成情况跟踪）由 BZG 的 diary/plan-mirror 单点
 * 依据 PlanFlow 计划事实重建；planflow 再写会与它抢同一节，造成重复行与勾选错位。
 */


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

/** 日记「# 次日计划」标题（ADR-0014：次日计划弹窗的写入目标，与复盘正文分离）。 */
export const DIARY_NEXTDAY_HEADING = "# 次日计划";


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

/**
 * 「# 次日计划」内容变换（纯逻辑，ADR-0014）：次日计划弹窗的写入目标。
 *  - 已有「# 次日计划」小节（任意位置）→ 原位替换其内容（一天一份，与复盘同语义）。
 *  - 没有 → 新建标题，插在「# 当日复盘」小节结束处（顺序约定：… → 随笔 → 当日复盘 → 次日计划）；
 *    无「# 当日复盘」→ 退回「# 随笔」锚点（与复盘同一套插入规则）；两个锚点都缺 → 返回 null。
 *  - 内容多行原样保留；小节前后空行结构规整为各一。
 */
export function nextDayPlanTransform(content: string, text: string): string | null {
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

	const planIdx = lines.findIndex((l) => l.trim() === DIARY_NEXTDAY_HEADING);
	if (planIdx >= 0) {
		// 已有小节 → 原位替换（到下一个一级标题为止）
		const end = nextH1(planIdx + 1);
		lines.splice(planIdx + 1, end - planIdx - 1, "", ...bodyLines, "");
		return lines.join("\n");
	}

	// 无小节 → 锚点定位：当日复盘节尾优先，退回随笔节尾
	const reviewIdx = lines.findIndex((l) => l.trim() === DIARY_REVIEW_HEADING);
	const anchorIdx = reviewIdx >= 0 ? reviewIdx : lines.findIndex((l) => l.trim() === DIARY_ESSAY_HEADING);
	if (anchorIdx === -1) return null;
	lines.splice(nextH1(anchorIdx + 1), 0, DIARY_NEXTDAY_HEADING, "", ...bodyLines, "");
	return lines.join("\n");
}

/**
 * 从日记内容中提取「# 次日计划」小节正文（纯逻辑）。
 * 已有小节 → 返回正文（掐首尾空行）；没有 → 返回 null（供弹窗预填判断与视图侧读）。
 */
export function extractNextDayPlanSection(content: string): string | null {
	const lines = content.split("\n");
	const idx = lines.findIndex((l) => l.trim() === DIARY_NEXTDAY_HEADING);
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
 * 写次日计划到指定日期日记「# 次日计划」（用户主动触发：失败返回状态码供 Notice 提示）。
 * `date` 由调用方给出（今天日记 = 主按钮；昨天日记 = 视图只读块的「去修改」入口）。
 */
export async function writeNextDayPlanToDiary(app: App, diaryDir: string, text: string, date: string): Promise<ReviewWriteResult> {
	const dir = diaryDir.replace(/\/+$/, "").trim();
	if (!dir || text.trim() === "") return "no-diary";
	const path = `${dir}/${date}.md`;
	const f = app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) return "no-diary";
	try {
		let noAnchor = false;
		await app.vault.process(f, (content) => {
			const next = nextDayPlanTransform(content, text);
			if (next === null) {
				noAnchor = true;
				return content;
			}
			return next;
		});
		return noAnchor ? "no-anchor" : "ok";
	} catch (e) {
		console.error("[planflow-diary-sync] 次日计划写入失败:", e);
		return "no-anchor";
	}
}
