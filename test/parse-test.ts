/**
 * Offline verification of M2 parsing logic:
 * - annual plan `plans` frontmatter parsing
 * - task pool line round-trip
 * - date-window filtering for week/month
 */
import { parsePlansFromFrontmatter, filterTasksInRange, summarizeTasks, computeQuotaDaily, computeWritingDaily, quotaExpected } from "../src/stats";
import { parseTaskPool, buildPoolLine, autoWeekContext, autoQuota, autoTaskNumbers, planCounterUnit, isAutoTask, extractGoalName, groupPoolTasksByGoal, diffShareClear, expandGoalStructure, expandGoalLeaves, chaptersToStructure, rescheduleChapterLine, suggestNextUnit, isRestartUnit, type GoalLevel } from "../src/tasks";
import { parseQuotaActual, parseQuotaAmount, buildQuotaCheckLine, missingQuotaLines, setQuotaActual, formatQuotaAmount, buildModeCheckLine, missingModeLines, markTaskLineManual, clearManualMark, matchesModeLine, matchesWritingLine, MANUAL_MARK, toggleTaskLine, parseChoreCycle, parseChoreOverdue, choreCycleLabel, isChoreDueOn, prevChoreOccurrence, nextChoreOccurrence, choreOccurrences, missingChoreLines, scanChoreHit, CHECK_HEADING, type GoalCycle } from "../src/daily";
import { parseToc, parseTocLine, tocSummary } from "../src/toc";
import { parseReviewItems, buildBzgSnapshot, reviewedOn, distinctReviewedInRange, diaryDayWritten, utcToLocalDay } from "../src/bzg";
import { nextDayPlanTransform, extractNextDayPlanSection } from "../src/diary-sync";
import { computeBoardSections } from "../src/board-items";
import { TFile } from "obsidian";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
	if (!cond) failed++;
}

// --- 1. Plan frontmatter: array-of-objects ---------------------------------
const fm1 = `---
type: year
year: 2026
plans:
  - name: 写作
    type: 数量
    target: 12 篇公众号文章
  - name: 健康
    type: 打卡
    target: 每天跑步 1 小时
---
# 年度计划
`;
const defs1 = parsePlansFromFrontmatter(fm1);
console.log("defs1:", JSON.stringify(defs1));
check("array form: 2 plans", defs1.length === 2, defs1.length);
const writing = defs1.find((d) => d.name === "写作");
check("写作 is numeric", writing?.type === "numeric");
check("写作 target", writing?.target === "12 篇公众号文章");
check("写作 targetCount = 12", writing?.targetCount === 12);
const health = defs1.find((d) => d.name === "健康");
check("健康 is check", health?.type === "check", health?.type);
check("健康 targetCount = 0 (check)", health?.targetCount === 0);

// --- 2. Plan frontmatter: map-of-objects -----------------------------------
const fm2 = `---
plans:
  写作:
    type: 数量
    target: 12 篇公众号文章
  复盘:
    type: 打卡
    target: 每天复盘
---
`;
const defs2 = parsePlansFromFrontmatter(fm2);
console.log("defs2:", JSON.stringify(defs2));
check("map form: 2 plans", defs2.length === 2, defs2.length);
check("map form name", defs2.some((d) => d.name === "写作"));
check("map form check type", defs2.find((d) => d.name === "复盘")?.type === "check");

// --- 3. No type field → fallback to number-in-target -----------------------
const fm3 = `---
plans:
  - name: 学习
    target: 50 本书
  - name: 冥想
    target: 坚持每天冥想
---
`;
const defs3 = parsePlansFromFrontmatter(fm3);
console.log("defs3:", JSON.stringify(defs3));
check("fallback numeric (50 本书)", defs3.find((d) => d.name === "学习")?.type === "numeric");
check("fallback check (no number)", defs3.find((d) => d.name === "冥想")?.type === "check");

// --- 4. Task pool line round-trip ------------------------------------------
const file = new TFile() as any;
// A real pool is a flat Tasks-format file. parseTaskPool picks up every
// task line (there is no section structure in the pool file).
const poolContent = [
	"- [ ] 完成《霍去病》文章 #计划/写作 🛫 2026-08-10 📅 2026-08-16",
	"- [x] 整理 AI 画图工作流 #计划/学习 🛫 2026-08-12 📅 2026-08-14",
	"- [ ] 无计划的临时任务 📅 2026-08-11",
].join("\n");
const pool = parseTaskPool(file, poolContent);
console.log("pool:", JSON.stringify(pool.map((t) => ({ text: t.text, plan: t.plan, checked: t.checked, start: t.start, due: t.due, line: t.line }))));
check("pool parses 3 tasks", pool.length === 3, pool.length);
const t0 = pool[0];
check("task0 fields", t0.text === "完成《霍去病》文章" && t0.plan === "写作" && t0.start === "2026-08-10" && t0.due === "2026-08-16" && !t0.checked);
check("task0 line", t0.line === 0);
check("task1 checked", pool[1].checked === true);
check("task2 plan null", pool[2].plan === null && pool[2].due === "2026-08-11");

// buildPoolLine round-trip
const built = buildPoolLine({ text: "新任务", plan: "写作", start: "2026-08-10", due: "2026-08-16" });
check("buildPoolLine", built === "- [ ] 新任务 #计划/写作 🛫 2026-08-10 📅 2026-08-16", built);
const rebuilt = parseTaskPool(file, built);
check("build→parse round-trip", rebuilt.length === 1 && rebuilt[0].text === "新任务" && rebuilt[0].plan === "写作" && rebuilt[0].start === "2026-08-10" && rebuilt[0].due === "2026-08-16");

// buildPoolLine without plan/dates
const built2 = buildPoolLine({ text: "简单任务", plan: null, start: null, due: null });
check("buildPoolLine minimal", built2 === "- [ ] 简单任务", built2);

// --- 5. Window filtering ----------------------------------------------------
const tasks = pool;
// Week 2026-W33: Mon 8/10 – Sun 8/16 → all three tasks overlap (t2 due 8/11).
const week = filterTasksInRange(tasks, "2026-08-10", "2026-08-16");
check("week filter includes all 3", week.length === 3, week.map((t) => t.text));
const month = filterTasksInRange(tasks, "2026-08-01", "2026-08-31");
check("month filter includes all dated", month.length === 3, month.map((t) => t.text));
const none = filterTasksInRange(tasks, "2026-09-01", "2026-09-30");
check("sep filter empty", none.length === 0, none.length);
check("summarize", JSON.stringify(summarizeTasks(tasks)) === '{"total":3,"done":1,"percent":33}', JSON.stringify(summarizeTasks(tasks)));

// --- 6. Tasks without dates are excluded from windows -----------------------
const undated = parseTaskPool(file, "- [ ] 未安排日期\n");
check("undated excluded", filterTasksInRange(undated, "2026-08-10", "2026-08-16").length === 0);

// --- 7. Single-key map form --------------------------------------------------
const fm7 = `---
plans:
  写作: 12 篇公众号文章
  健康: 每天跑步
---
`;
const defs7 = parsePlansFromFrontmatter(fm7);
console.log("defs7:", JSON.stringify(defs7));
check("single-key map 2 plans", defs7.length === 2, defs7.length);
check("single-key 写作 numeric", defs7.find((d) => d.name === "写作")?.type === "numeric");
check("single-key 健康 check", defs7.find((d) => d.name === "健康")?.type === "check");

// --- 8. v1.2 auto-task helpers ---------------------------------------------
check("planCounterUnit 篇", planCounterUnit("12 篇公众号文章") === "篇");
check("planCounterUnit 天", planCounterUnit("144 天") === "天");
check("planCounterUnit default", planCounterUnit("每天跑步") === "篇");

// Cumulative quota (DEV.md v1.2): ceil(N × weekIndex / totalWeeks)
check("autoQuota w1 (12/52)", autoQuota(12, 1, 52) === 1, autoQuota(12, 1, 52));
check("autoQuota w26 (12/52)", autoQuota(12, 26, 52) === 6, autoQuota(12, 26, 52));
check("autoQuota w52 (12/52)", autoQuota(12, 52, 52) === 12, autoQuota(12, 52, 52));
check("autoQuota target 0", autoQuota(0, 5, 52) === 0);
check("autoQuota increments ≤ 2", Array.from({ length: 52 }, (_, i) => autoQuota(12, i + 1, 52) - autoQuota(12, i, 52)).every((d) => d >= 0 && d <= 2));

// ISO week context
const ctx1 = autoWeekContext("2026-01-01", "2026-12-31", "2026-01-05");
console.log("ctx1:", JSON.stringify(ctx1));
check("weekContext full-year totalWeeks = 53 (2026 has 53 ISO weeks)", ctx1?.totalWeeks === 53, ctx1?.totalWeeks);
// Plan starts 2026-01-01 (Thu, ISO week 1). 2026-01-05 is Monday of the next ISO week → index 2.
check("weekContext first week index = 2", ctx1?.weekIndex === 2, ctx1?.weekIndex);
check("weekContext before plan start → null", autoWeekContext("2026-08-10", "2026-12-31", "2026-08-01") === null);
check("weekContext after plan end → null", autoWeekContext("2026-08-10", "2026-12-31", "2027-01-04") === null);
// Plan starts 2026-08-12 (Wed); today 2026-08-10 (Mon, same ISO week but before start) → skip.
check("weekContext same week before start → null", autoWeekContext("2026-08-12", "2026-12-31", "2026-08-10") === null);

const ctx2 = autoWeekContext("2026-08-10", "2026-12-31", "2026-08-10");
check("weekContext mid-plan totalWeeks", ctx2?.totalWeeks === 21, ctx2?.totalWeeks);
check("weekContext mid-plan week1", ctx2?.weekIndex === 1, ctx2?.weekIndex);
const ctx3 = autoWeekContext("2026-08-10", "2026-12-31", "2026-08-17");
check("weekContext mid-plan week2", ctx3?.weekIndex === 2, ctx3?.weekIndex);

// Auto-task detection (name pattern «label（第 N 篇）»; manual tasks ignored)
const autoPool = parseTaskPool(
	file,
	[
		"- [ ] 写作（第 1 篇） #计划/写作 🛫 2026-08-10 📅 2026-08-16",
		"- [x] 写作（第 2 篇） #计划/写作 🛫 2026-08-10 📅 2026-08-16",
		"- [ ] 完成《霍去病》文章 #计划/写作 🛫 2026-08-10 📅 2026-08-16",
		"- [ ] 学习（第 1 本） #计划/学习 🛫 2026-08-10 📅 2026-08-16",
	].join("\n")
);
check("isAutoTask 第1篇", autoPool[0].plan === "写作" && isAutoTask(autoPool[0]));
check("isAutoTask 第2篇 checked", autoPool[1].plan === "写作" && isAutoTask(autoPool[1]));
check("manual task not auto", autoPool[2].plan === "写作" && !isAutoTask(autoPool[2]));
check("isAutoTask 第1本 (book unit)", autoPool[3].plan === "学习" && isAutoTask(autoPool[3]));

// Number selection: continue from highest, skip existing names, cap at target.
const autoWriting = autoPool.filter((t) => t.plan === "写作");
const nums1 = autoTaskNumbers(autoWriting, 1, 12, "写作", "篇");
check("autoTaskNumbers continue from maxN", JSON.stringify(nums1) === "[3]", nums1);
const gapPool = parseTaskPool(
	file,
	["- [ ] 写作（第 1 篇） #计划/写作 🛫 2026-08-10 📅 2026-08-16", "- [ ] 写作（第 3 篇） #计划/写作 🛫 2026-08-10 📅 2026-08-16"].join("\n")
);
const numsGap = autoTaskNumbers(gapPool, 2, 12, "写作", "篇");
check("autoTaskNumbers skip deleted middle", JSON.stringify(numsGap) === "[4,5]", numsGap);
check("autoTaskNumbers need 0", autoTaskNumbers(autoWriting, 0, 12, "写作", "篇").length === 0);
const numsCap = autoTaskNumbers(autoWriting, 5, 2, "写作", "篇");
check("autoTaskNumbers capped at targetCount", JSON.stringify(numsCap) === "[]", numsCap);
const numsEmpty = autoTaskNumbers([], 2, 12, "写作", "篇");
check("autoTaskNumbers from scratch", JSON.stringify(numsEmpty) === "[1,2]", numsEmpty);

// --- 9. ADR-0001: quota plans -----------------------------------------------
const fm9 = `---
plans:
  - name: 小说
    type: quota
    target: 写 10 万字小说
    quota:
      total: 100000
      unit: 字
      start: 2026-09-01
      end: 2026-12-31
  - name: 读书
    quota:
      total: 300
      unit: 页
      end: 2026-12-31
  - name: 坏定义
    type: quota
    quota:
      unit: 字
  - name: 复盘
    type: 打卡
    target: 每日复盘
---
`;
const defs9 = parsePlansFromFrontmatter(fm9);
console.log("defs9:", JSON.stringify(defs9));
check("quota: 4 plans parsed", defs9.length === 4, defs9.length);
const novel = defs9.find((d) => d.name === "小说");
check("小说 type quota", novel?.type === "quota", novel?.type);
check("小说 quota fields", novel?.quota?.total === 100000 && novel?.quota?.unit === "字" && novel?.quota?.start === "2026-09-01" && novel?.quota?.end === "2026-12-31", novel?.quota);
const book = defs9.find((d) => d.name === "读书");
check("读书 quota (no start)", book?.type === "quota" && book?.quota?.total === 300 && book?.quota?.unit === "页" && book?.quota?.start === undefined, book?.quota);
check("坏定义 falls back (no total/end)", defs9.find((d) => d.name === "坏定义")?.type !== "quota", defs9.find((d) => d.name === "坏定义")?.type);
check("复盘 stays check", defs9.find((d) => d.name === "复盘")?.type === "check");

// Daily quota math (1-decimal precision)
check("quotaDaily 100000/122", computeQuotaDaily(100000, "2026-09-01", "2026-12-31") === 819.7, computeQuotaDaily(100000, "2026-09-01", "2026-12-31"));
check("quotaDaily exact 300/122", computeQuotaDaily(300, "2026-09-01", "2026-12-31") === 2.5, computeQuotaDaily(300, "2026-09-01", "2026-12-31"));
check("quotaDaily zero days → total", computeQuotaDaily(100, "2026-10-01", "2026-10-01") === 100);
check("quotaExpected before start", quotaExpected(10, "2026-10-01", "2026-12-31", "2026-09-15") === 0);
check("quotaExpected clamps at end", quotaExpected(10, "2026-10-01", "2026-10-03", "2027-01-01") === 30);
check("quotaExpected mid", quotaExpected(10, "2026-10-01", "2026-12-31", "2026-10-03") === 30);

// Line format round-trip
const ql = buildQuotaCheckLine({ label: "✍️", plan: "小说", quota: 819.7, unit: "字", date: "2026-09-23" });
check("quota line format", ql === "- [ ] ✍️ 小说 819.7字 #计划/小说 🛫 2026-09-23 📅 2026-09-23", ql);
check("quota line no label", buildQuotaCheckLine({ label: "", plan: "读书", quota: 2.5, unit: "页", date: "2026-09-23" }) === "- [ ] 读书 2.5页 #计划/读书 🛫 2026-09-23 📅 2026-09-23");
check("parseQuotaActual none", parseQuotaAmount("✍️ 小说 819.7字") === 819.7);
check("parseQuotaActual with suffix", parseQuotaActual("✍️ 小说 819.7字（实 800字）") === 800);
check("parseQuotaAmount ignores suffix", parseQuotaAmount("✍️ 小说 819.7字（实 800字）") === 819.7);
check("parseQuotaActual absent", parseQuotaActual("✍️ 小说 819.7字") === null);
check("formatQuotaAmount int", formatQuotaAmount(1170) === "1170");
check("formatQuotaAmount trim .0", formatQuotaAmount(2.0) === "2");
check("formatQuotaAmount 1 decimal", formatQuotaAmount(819.7) === "819.7");

// missingQuotaLines: idempotent lazy generation
const dailyContent = `---
date: 2026-09-23
type: daily
---
# 📅 2026-09-23 星期三

## ✅ 今日打卡
- [ ] 📈 复盘+次日计划 #计划/复盘 🛫 2026-09-23 📅 2026-09-23

## 📝 今日总结
`;
const m1 = missingQuotaLines(dailyContent, [{ plan: "小说", label: "✍️", quota: 819.7, unit: "字" }], "2026-09-23");
check("missingQuotaLines adds 1", m1.length === 1 && m1[0] === "- [ ] ✍️ 小说 819.7字 #计划/小说 🛫 2026-09-23 📅 2026-09-23", m1);
const withQuota = dailyContent.replace(
	"## 📝 今日总结",
	"- [ ] ✍️ 小说 819.7字 #计划/小说 🛫 2026-09-23 📅 2026-09-23\n\n## 📝 今日总结"
);
check("missingQuotaLines idempotent", missingQuotaLines(withQuota, [{ plan: "小说", label: "✍️", quota: 819.7, unit: "字" }], "2026-09-23").length === 0);
// quota rows outside the check section are ignored (section-scoped detection)
const outside = dailyContent.replace("# 📅 2026-09-23 星期三", "- [ ] 旧残留 #计划/小说 📅 2026-09-01");
check("missingQuotaLines section-scoped", missingQuotaLines(outside, [{ plan: "小说", label: "", quota: 819.7, unit: "字" }], "2026-09-23").length === 1);

// setQuotaActual: record actual + check; preserve tag/dates; clear suffix with 0
const added = missingQuotaLines(dailyContent, [{ plan: "小说", label: "✍️", quota: 819.7, unit: "字" }], "2026-09-23")[0];
const content2 = dailyContent.replace("## 📝 今日总结", `${added}\n\n## 📝 今日总结`);
const line2 = content2.split("\n").findIndex((l) => l.includes("#计划/小说"));
const afterActual = setQuotaActual(content2, line2, 800, "字", true);
const m = afterActual.split("\n")[line2];
check("setQuotaActual writes suffix + check", m === "- [x] ✍️ 小说 819.7字（实 800字） #计划/小说 🛫 2026-09-23 📅 2026-09-23", m);
const afterClear = setQuotaActual(afterActual, line2, 0, "字", false);
check("setQuotaActual 0 clears + unchecks", afterClear.split("\n")[line2] === "- [ ] ✍️ 小说 819.7字 #计划/小说 🛫 2026-09-23 📅 2026-09-23", afterClear.split("\n")[line2]);
const afterReplace = setQuotaActual(afterActual, line2, 650.5, "字", true);
check("setQuotaActual replaces old suffix", afterReplace.split("\n")[line2] === "- [x] ✍️ 小说 819.7字（实 650.5字） #计划/小说 🛫 2026-09-23 📅 2026-09-23", afterReplace.split("\n")[line2]);
check("setQuotaActual bad line no-op", setQuotaActual(content2, 0, 800, "字", true) === content2);

// --- ADR-0005 章节型目标: chapter sequence + naming + even-spread dates -----
// --- ADR-0005 v2 多级结构: expandGoalStructure / expandGoalLeaves -------------
// 两级 章→节（兼容旧 chapters 的命名，逐字一致）
const bookLevels: GoalLevel[] = [
	{ unit: "章", counts: [3] },
	{ unit: "节", counts: [2, 3, 4] },
];
const secs = expandGoalStructure("《认知觉醒》", bookLevels);
check("structure total = Σ", secs.length === 9, secs.length);
check("structure flat order", secs[0].name === "《认知觉醒》（第 1 章第 1 节）" && secs[0].index === 1, secs[0]);
check("structure chapter boundary", secs[1].name.endsWith("第 1 章第 2 节）") && secs[2].name.endsWith("第 2 章第 1 节）"), secs[2]);
check("structure last node", secs[8].name === "《认知觉醒》（第 3 章第 4 节）" && secs[8].index === 9, secs[8]);
check("structure groups per chapter", secs[0].group === "第 1 章" && secs[2].group === "第 2 章" && secs[8].group === "第 3 章", secs[8].group);

// 三级 篇→章→节：章全书连续编号（第2篇的章是第3、4、5章），节每章重排
const threeLevels: GoalLevel[] = [
	{ unit: "篇", counts: [3] },
	{ unit: "章", counts: [2, 3, 2] },
	{ unit: "节", counts: [2, 1, 2, 1, 2, 1, 2] },
];
const t3 = expandGoalStructure("书", threeLevels);
check("3-level total", t3.length === 11, t3.length);
check("3-level chapter numbering continues across 篇", t3[3].name === "书（第 3 章第 1 节）", t3[3].name);
check("3-level section restarts per chapter", t3[4].name === "书（第 3 章第 2 节）", t3[4].name);
check("3-level first leaf", t3[0].name === "书（第 1 章第 1 节）", t3[0].name);
check("3-level last leaf", t3[10].name === "书（第 7 章第 2 节）", t3[10].name);

// 停在篇 / 停在章
const pOnly = expandGoalStructure("书", [{ unit: "篇", counts: [3] }]);
check("stop at 篇", pOnly.length === 3 && pOnly[1].name === "书（第 2 篇）" && pOnly[1].group === "", pOnly[1]);
const pcOnly = expandGoalStructure("书", [
	{ unit: "篇", counts: [3] },
	{ unit: "章", counts: [2, 3, 2] },
]);
check("stop at 章: global chapter numbers", pcOnly.length === 7 && pcOnly[2].name === "书（第 3 章）", pcOnly[2]);
check("stop at 章: rollup = 篇 (倒数第二级)", pcOnly[0].group === "第 1 篇" && pcOnly[2].group === "第 2 篇" && pcOnly[6].group === "第 3 篇", pcOnly[2].group);

// chapters 兼容：命名与结构版逐字一致
const legacy = expandGoalLeaves("《认知觉醒》", { chapters: [2, 3, 4] });
check("chapters compat naming identical", !!legacy && legacy.length === 9 && legacy.every((l, i) => l.name === secs[i].name), legacy?.[8]);
check("expandGoalLeaves flat = null", expandGoalLeaves("书", {}) === null && expandGoalLeaves("书", { chapters: [] }) === null);
check("invalid structure rejected", expandGoalStructure("书", []).length === 0 && expandGoalStructure("书", [{ unit: "章", counts: [0] }]).length === 0);

// --- ADR-0005 v3: 全面词表 / 深层级 / 编号规则 / 接续推荐 ---------------------
// 4 级：部→卷→篇→章（各中间级全书连续编号）
const four = expandGoalStructure("书", [
	{ unit: "部", counts: [1] },
	{ unit: "卷", counts: [2] },
	{ unit: "篇", counts: [1, 2] },
	{ unit: "章", counts: [2, 2, 2] },
]);
check("4-level expansion", four.length === 6 && four[0].name === "书（第 1 章）" && four[3].name === "书（第 4 章）", four[3]);
check("4-level groups = 倒数第二级(篇)", four[0].group === "第 1 篇" && four[2].group === "第 2 篇" && four[4].group === "第 3 篇", four[4].group);
// 讲→节：讲连续、节每讲重排
const lect = expandGoalStructure("书", [
	{ unit: "讲", counts: [2] },
	{ unit: "节", counts: [2, 3] },
]);
check("讲 continuous + 节 restarts per 讲", lect[0].name === "书（第 1 讲第 1 节）" && lect[2].name === "书（第 2 讲第 1 节）" && lect[4].name === "书（第 2 讲第 3 节）", lect[4]);
// 幕→场：场每幕重排（真书惯例：第一幕第一场、第二幕第一场）
const drama = expandGoalStructure("剧本", [
	{ unit: "幕", counts: [2] },
	{ unit: "场", counts: [1, 2] },
]);
check("场 restarts per 幕", drama[1].name === "剧本（第 2 幕第 1 场）", drama[1]);
// 层级接续推荐链
check("suggestNextUnit chains", suggestNextUnit("篇") === "章" && suggestNextUnit("章") === "节" && suggestNextUnit("单元") === "课" && suggestNextUnit("部") === "卷" && suggestNextUnit("幕") === "场", suggestNextUnit("单元"));
check("suggestNextUnit unknown → 节", suggestNextUnit("自定义") === "节");
check("isRestartUnit defaults", isRestartUnit("节") === true && isRestartUnit("场") === true && isRestartUnit("章") === false && isRestartUnit("回") === false && isRestartUnit("自定义") === false);
// 级数上限 8：8 级可用、9 级拒绝
const eight = expandGoalStructure("书", [
	{ unit: "部", counts: [1] },
	{ unit: "卷", counts: [1] },
	{ unit: "篇", counts: [1] },
	{ unit: "章", counts: [1] },
	{ unit: "节", counts: [1] },
	{ unit: "小节", counts: [1] },
	{ unit: "目", counts: [1] },
	{ unit: "条", counts: [1] },
]);
check("8-level ok (叶名=重排链路径)", eight.length === 1 && eight[0].name === "书（第 1 章第 1 节第 1 小节第 1 目第 1 条）", eight[0]);
check("9-level rejected", expandGoalStructure("书", Array.from({ length: 9 }, () => ({ unit: "章", counts: [1] }))).length === 0);

// --- ADR-0005 v4: 变深树——某章无节填 0，该章本身成为勾选单位 -------------------
// 章 [5] → 节 [2,3,0,4,0]：第 3、5 章无节 → 任务「第 3 章」「第 5 章」
const mixed = expandGoalStructure("书", [
	{ unit: "章", counts: [5] },
	{ unit: "节", counts: [2, 3, 0, 4, 0] },
]);
check("zero-section chapter promotes itself", mixed.length === 11, mixed.length);
check("promoted chapter name", mixed[5].name === "书（第 3 章）" && mixed[5].group === "第 3 章", mixed[5]);
check("promoted chapter order (书序)", mixed[4].name === "书（第 2 章第 3 节）" && mixed[6].name === "书（第 4 章第 1 节）", mixed[6]);
check("second promoted chapter at end", mixed[10].name === "书（第 5 章）", mixed[10]);
// 全 0：所有章都无节 → 每章本身是任务
const allZero = expandGoalStructure("书", [
	{ unit: "章", counts: [3] },
	{ unit: "节", counts: [0, 0, 0] },
]);
check("all-zero sections → chapters as leaves", allZero.length === 3 && allZero[1].name === "书（第 2 章）", allZero[1]);
// 深层 0：卷无篇 → 卷升格（书序保持）
const deepZero = expandGoalStructure("书", [
	{ unit: "卷", counts: [3] },
	{ unit: "篇", counts: [1, 0, 2] },
	{ unit: "章", counts: [2, 1, 1] },
]);
check("deep zero promotes 卷", deepZero[2].name === "书（第 2 卷）" && deepZero[2].group === "第 2 卷", deepZero[2]);
check("deep zero keeps book order", deepZero[0].name === "书（第 1 章）" && deepZero[3].name === "书（第 3 章）", deepZero[3]);

// 真实目录 1.1.1/1.1.2/1.2.1/1.2.2/1.2.3/1.3/1.4/2.1.1/…/2.4.2/3.1（深浅不一，16 条）
// 章[3] → 节[4,4,1] → 小节[2,3,0,0, 3,0,0,2, 0]
const toc = expandGoalStructure("书", [
	{ unit: "章", counts: [3] },
	{ unit: "节", counts: [4, 4, 1] },
	{ unit: "小节", counts: [2, 3, 0, 0, 3, 0, 0, 2, 0] },
]);
check("TOC total = 15 leaves", toc.length === 15, toc.length);
check("TOC 1.1.1 → path name", toc[0].name === "书（第 1 章第 1 节第 1 小节）", toc[0]);
check("TOC 1.2.3 → path name", toc[4].name === "书（第 1 章第 2 节第 3 小节）", toc[4]);
check("TOC 1.3 (无小节) → 节升格", toc[5].name === "书（第 1 章第 3 节）", toc[5]);
check("TOC 1.4 → 节升格", toc[6].name === "书（第 1 章第 4 节）", toc[6]);
check("TOC 2.1.1 → path name (跨章重排编号)", toc[7].name === "书（第 2 章第 1 节第 1 小节）", toc[7]);
check("TOC 2.2 → 节升格", toc[10].name === "书（第 2 章第 2 节）", toc[10]);
check("TOC 2.4.2 → path name", toc[13].name === "书（第 2 章第 4 节第 2 小节）", toc[13]);
check("TOC 3.1 → 节升格", toc[14].name === "书（第 3 章第 1 节）", toc[14]);
// 组标签用路径式：不同章的同号节不撞名（第1章第1节 与 第2章第1节 是两组）
check("TOC groups path-based (不跨章撞名)", toc[0].group === "第 1 章第 1 节" && toc[7].group === "第 2 章第 1 节" && toc[5].group === "第 1 章第 3 节" && toc[14].group === "第 3 章第 1 节", toc[7].group);

// isAutoTask: generic suffix (任意单位/路径) tombstone-eligible
const chapterTaskLike = { text: "《认知觉醒》（第 2 章第 3 节）", plan: "阅读", checked: false, start: null, due: null, line: 0, raw: "", file: {} as TFile } as Parameters<typeof isAutoTask>[0];
check("isAutoTask chapter pattern", isAutoTask(chapterTaskLike) === true);
const flatTaskLike = { ...chapterTaskLike, text: "公众号文章（第 2 篇）" } as Parameters<typeof isAutoTask>[0];
check("isAutoTask flat pattern still matches", isAutoTask(flatTaskLike) === true);
const manualTaskLike = { ...chapterTaskLike, text: "手动任务" } as Parameters<typeof isAutoTask>[0];
check("isAutoTask manual task excluded", isAutoTask(manualTaskLike) === false);
// 章/自定义单位（幕）的单段叶名也走通用识别
const chapterUnitFlat = { ...chapterTaskLike, text: "《某书》（第 3 章）" } as Parameters<typeof isAutoTask>[0];
check("isAutoTask 章-unit flat task", isAutoTask(chapterUnitFlat) === true);
const customUnitLeaf = { ...chapterTaskLike, text: "《剧本》（第 2 幕）" } as Parameters<typeof isAutoTask>[0];
check("isAutoTask custom unit leaf", isAutoTask(customUnitLeaf) === true);
const fmChUnit = `---
plans:
  - name: 阅读
    goals:
      - "阅读 10 章"
---
`;
const chUnitGoal = parsePlansFromFrontmatter(fmChUnit)[0]?.goals[0];
check("string-form goal with 章 unit", !!chUnitGoal && chUnitGoal.count === 10 && chUnitGoal.unit === "章", chUnitGoal);

// --- ADR-0005 编辑重排: rescheduleChapterLine ---------------------------------
const buildCtx = (readCount: number, start: string, end: string) => {
	const remaining = new Set(secs.slice(readCount).map((l) => l.name)); // 前 readCount 叶视为已读
	let m = 0;
	return {
		plan: "阅读",
		prefix: "《认知觉醒》（",
		valid: new Set(secs.map((l) => l.name)),
		leafIndexByName: new Map(secs.filter((l) => remaining.has(l.name)).map((l) => [l.name, ++m])),
		total: m,
		start,
		end,
	};
};
const rctx = buildCtx(0, "2026-11-06", "2026-11-12"); // 7 天摊 9 节
// 未勾 3/4：原窗口落在 11-08，重排后应到 11-12（k=9 → 最后一天）
const oldLine = "- [ ] 《认知觉醒》（第 3 章第 4 节） #计划/阅读 🛫 2026-11-08 📅 2026-11-08";
const rescheduled = rescheduleChapterLine(oldLine, rctx);
check("reschedule re-dates unchecked section", rescheduled === "- [ ] 《认知觉醒》（第 3 章第 4 节） #计划/阅读 🛫 2026-11-12 📅 2026-11-12", rescheduled);
// 已勾 3/4：保留原日期（进度记录不重写）
const checkedLine = oldLine.replace("- [ ]", "- [x]");
check("reschedule keeps checked dates", rescheduleChapterLine(checkedLine, rctx) === checkedLine);
// 失效叶子（新序列无第 4 章）→ 删行
check("reschedule drops invalid leaf", rescheduleChapterLine("- [ ] 《认知觉醒》（第 4 章第 1 节） #计划/阅读 🛫 2026-11-08 📅 2026-11-08", rctx) === null);
// 同名但日期已是新值 → 原样返回（幂等无写入）
const sameLine = "- [ ] 《认知觉醒》（第 1 章第 1 节） #计划/阅读 🛫 2026-11-06 📅 2026-11-06";
check("reschedule no-op when dates match", rescheduleChapterLine(sameLine, rctx) === sameLine);
// 其他计划/非任务行不动
const otherLine = "- [ ] 写作任务 #计划/写作 🛫 2026-11-08 📅 2026-11-08";
check("reschedule ignores other plans", rescheduleChapterLine(otherLine, rctx) === otherLine);
check("reschedule ignores non-task lines", rescheduleChapterLine("## 标题", rctx) === "## 标题");

// 场景二（重启）：已读前 4 叶，剩余 5 叶摊新窗口 11-06~11-10（5 天）→ 每天 1 叶从头开始。
// 已读的 2/2（全序列 k=4）不在剩余序列里，不占窗口位置；2/3 重排为新序列 k'=1 → 11-06
const rctxRestart = buildCtx(4, "2026-11-06", "2026-11-10");
const stale22 = "- [ ] 《认知觉醒》（第 2 章第 3 节） #计划/阅读 🛫 2026-11-07 📅 2026-11-07";
check("restart: first remaining section starts day 1", rescheduleChapterLine(stale22, rctxRestart) === "- [ ] 《认知觉醒》（第 2 章第 3 节） #计划/阅读 🛫 2026-11-06 📅 2026-11-06", rescheduleChapterLine(stale22, rctxRestart));
const stale34 = "- [ ] 《认知觉醒》（第 3 章第 4 节） #计划/阅读 🛫 2026-11-08 📅 2026-11-08";
check("restart: last remaining section lands on window end", rescheduleChapterLine(stale34, rctxRestart) === "- [ ] 《认知觉醒》（第 3 章第 4 节） #计划/阅读 🛫 2026-11-10 📅 2026-11-10", rescheduleChapterLine(stale34, rctxRestart));
// 已读的节即使落在新窗口范围内也不改写（保留历史）
const read22 = "- [x] 《认知觉醒》（第 2 章第 2 节） #计划/阅读 🛫 2026-11-07 📅 2026-11-07";
check("restart: checked sections keep original dates", rescheduleChapterLine(read22, rctxRestart) === read22);

// frontmatter round-trip: chapters array parsed into PlanGoal (count = Σ chapters)
const fmChapter = `---
plans:
  - name: 阅读
    type: 数量
    goals:
      - name: 《认知觉醒》
        count: 9
        unit: 节
        chapters: [2, 3, 4]
        start: 2026-11-06
        end: 2026-11-08
---
# 年度计划
`;
const defsChapter = parsePlansFromFrontmatter(fmChapter);
const reading = defsChapter.find((d) => d.name === "阅读");
const chGoal = reading?.goals[0];
check("chapter goal parsed", !!chGoal && Array.isArray(chGoal.chapters) && chGoal.chapters.length === 3, chGoal);
check("chapter goal values", chGoal?.chapters?.join(",") === "2,3,4" && chGoal?.count === 9 && chGoal?.unit === "节", chGoal);
check("chapter goal keeps window", chGoal?.start === "2026-11-06" && chGoal?.end === "2026-11-08");
check("chapter plan targetCount = Σ chapters", reading?.targetCount === 9, reading?.targetCount);

// flat goal without chapters stays untouched (backward compat)
const fmFlat = `---
plans:
  - name: 写作
    goals:
      - name: 公众号文章
        count: 12
        unit: 篇
---
`;
const flatGoal = parsePlansFromFrontmatter(fmFlat)[0]?.goals[0];
check("flat goal has no chapters", flatGoal && !flatGoal.chapters, flatGoal);

// structure frontmatter round-trip（块序列；mock parseYaml 走嵌套列表路径）
const fmStruct = `---
plans:
  - name: 阅读
    goals:
      - name: 《量价典型股票盘口分析》
        count: 7
        unit: 节
        structure:
          - unit: 章
            counts: [3]
          - unit: 节
            counts: [2, 2, 3]
---
`;
const structGoal = parsePlansFromFrontmatter(fmStruct)[0]?.goals[0];
check("structure goal parsed", !!structGoal && Array.isArray(structGoal.structure) && structGoal.structure.length === 2, structGoal);
check("structure goal values", structGoal?.structure?.[0].unit === "章" && structGoal?.structure?.[1].counts.join(",") === "2,2,3", structGoal?.structure);
const structLeaves = structGoal ? expandGoalLeaves(structGoal.name, structGoal) : [];
check("structure goal leaf expansion", !!structLeaves && structLeaves.length === 7 && structLeaves[0].name === "《量价典型股票盘口分析》（第 1 章第 1 节）", structLeaves?.[0]);

// --- N. ADR-0006 目标模式：frontmatter mode/floor 解析 -----------------------
const fmMode = `---
plans:
  - name: 学习
    goals:
      - name: 文献复习
        count: 0
        unit: 篇
        mode: review
        floor: 5
      - name: 日记
        count: 0
        mode: diary
      - name: 《某书》
        count: 3
        unit: 章
        mode: reading
        structure:
          - unit: 章
            counts: [3]
---
`;
const modePlan = parsePlansFromFrontmatter(fmMode)[0];
check("mode plan: 3 goals", modePlan?.goals.length === 3, modePlan?.goals.length);
const reviewGoal = modePlan?.goals.find((g) => g.name === "文献复习");
check("review goal mode+floor", reviewGoal?.mode === "review" && reviewGoal?.floor === 5, reviewGoal);
const diaryGoal = modePlan?.goals.find((g) => g.name === "日记");
check("diary goal mode, default floor absent", diaryGoal?.mode === "diary" && diaryGoal?.floor === undefined, diaryGoal);
const readingGoal = modePlan?.goals.find((g) => g.mode === "reading");
check("reading goal keeps structure", readingGoal?.structure?.length === 1, readingGoal?.structure);
check("legacy goal without mode unaffected", !flatGoal?.mode, flatGoal?.mode);

// --- N. 目录粘贴解析（toc.ts） -----------------------------------------------
check("toc line: unit word", parseTocLine("第1章 开始")?.family === "U", parseTocLine("第1章 开始"));
check("toc line: numeric depth", parseTocLine("1.2 相遇")?.family === "N" && parseTocLine("1.2 相遇")?.level === 1, parseTocLine("1.2 相遇"));
check("toc line: page number stripped", parseTocLine("第1章 开始......12")?.title === "第1章 开始", parseTocLine("第1章 开始......12"));
check("toc line: 目录 skipped", parseTocLine("目录") === null, undefined);
check("toc line: bullet cleaned", parseTocLine("- 第2章 重逢")?.title === "第2章 重逢", parseTocLine("- 第2章 重逢"));

const toc1 = parseToc("目录\n第1章 开始\n1.1 相遇\n1.2 离别\n第2章 重逢\n第3章 终局\n");
check("toc mixed: 2 levels", toc1?.levels.length === 2, toc1?.levels);
check("toc mixed: chapter counts", toc1?.levels[0].counts.join(",") === "3", toc1?.levels[0].counts);
check("toc mixed: section counts", toc1?.levels[1].counts.join(",") === "2,0,0", toc1?.levels[1].counts);
check("toc mixed: units", toc1?.units.join(",") === "章,节", toc1?.units);
check("toc mixed: leaf expansion", toc1 ? expandGoalStructure("书", toc1.levels).length === 4 : false, undefined);
check("toc summary text", !!toc1 && /识别 5 行/.test(tocSummary(toc1)), toc1 ? tocSummary(toc1) : "");

const toc2 = parseToc("第一篇 上部\n第1章 起源\n第一节 缘起\n第2章 分岔\n第二篇 下部\n第3章 汇合\n");
check("toc pure units: 3 levels", toc2?.levels.length === 3, toc2?.levels);
check("toc pure units: counts", toc2?.levels.map((l) => l.counts.join("/")).join("|") === "2|2/1|1/0/0", toc2?.levels.map((l) => l.counts.join("/")));
const toc3 = parseToc("  缩进一章\n    缩进一节\n    缩进二节\n  缩进二章\n");
check("toc indent: counts", toc3?.levels[1].counts.join(",") === "2,0", toc3?.levels[1].counts);
check("toc empty input", parseToc("   \n\n") === null, undefined);

// --- N. BZG 只读联动（bzg.ts 纯函数） ----------------------------------------
// 时间戳用本地 Date 构造 → 本地日判定与时区无关
const dayA = "2026-11-08";
const dayB = "2026-11-09";
const ts = (y: number, mo: number, d: number, h: number): string => new Date(y, mo - 1, d, h).toISOString();
check("utc→local day sanity", utcToLocalDay(ts(2026, 11, 8, 9)) === dayA, utcToLocalDay(ts(2026, 11, 8, 9)));
const reviewRaw = JSON.stringify([
	{
		filePath: "卡片盒/文献/A.md",
		reviewHistory: [
			{ timestamp: ts(2026, 11, 8, 9), rating: "easy" },
			{ timestamp: ts(2026, 11, 8, 21), rating: "again" },
			{ timestamp: ts(2026, 11, 9, 8), rating: "good" },
		],
	},
	{ filePath: "卡片盒/文献/B.md", reviewHistory: [{ timestamp: ts(2026, 11, 8, 12), rating: "hard" }] },
	{ filePath: "卡片盒/文献/C.md", reviewHistory: [] },
	{ filePath: "", reviewHistory: [] },
]);
const items = parseReviewItems(reviewRaw);
check("review items parsed: 3 valid", items.length === 3, items.length);
const snap = buildBzgSnapshot(items, { storagePath: "CONFIG/STORAGE", diaryDirectory: "我的/日记", reviewCountFolder: "卡片盒/文献" });
check("reviewedOn dedupe same-day", reviewedOn(snap, dayA) === 2, reviewedOn(snap, dayA));
check("reviewedOn next day", reviewedOn(snap, dayB) === 1, reviewedOn(snap, dayB));
check("reviewedOn empty day", reviewedOn(snap, "2026-11-10") === 0, undefined);
check("coverage in range", distinctReviewedInRange(snap, dayA, dayB) === 2, undefined);
check("coverage narrow range", distinctReviewedInRange(snap, "2026-11-01", dayA) === 2, undefined);
check("coverage before any", distinctReviewedInRange(snap, "2026-01-01", "2026-02-01") === 0, undefined);
check("review json invalid → empty", parseReviewItems("not json{{").length === 0, undefined);

check("diary null → not written", diaryDayWritten(null) === false, undefined);
check("diary skeleton → not written", diaryDayWritten("# 随笔\n# 当日触动点\n# 日常行为记录\n## 代办事项\n## 完成情况跟踪\n") === false, undefined);
check("diary 随笔 block → written", diaryDayWritten("# 随笔\n\n**📖 09:18**\n\n今天写了。\n") === true, undefined);
check("diary 触动点 → written", diaryDayWritten("# 当日触动点\n某句话触动了我。\n") === true, undefined);
check("diary todo-only → NOT written", diaryDayWritten("# 随笔\n## 代办事项\n- [x] 1. 任务-09:00\n") === false, undefined);
check("diary tracking-only → NOT written", diaryDayWritten("# 随笔\n## 完成情况跟踪\n- [x] 📝 日记\n") === false, undefined);

// --- N. 模式每日行（daily.ts） -----------------------------------------------
const spec = { plan: "学习", name: "文献复习", label: "🗣️", floor: 5, unit: "篇" };
const modeLine = buildModeCheckLine(spec, "2026-11-08");
check("mode line built", modeLine === "- [ ] 🗣️ 文献复习 5篇 #计划/学习 🛫 2026-11-08 📅 2026-11-08", modeLine);
const diaryLine = buildModeCheckLine({ plan: "复盘", name: "日记", label: "📝", floor: 0, unit: "" }, "2026-11-08");
check("diary line built", diaryLine === "- [ ] 📝 日记 #计划/复盘 🛫 2026-11-08 📅 2026-11-08", diaryLine);

const existingDaily = `## ✅ 今日打卡
- [ ] 📖 学习 1小时 #计划/学习 🛫 2026-11-08 📅 2026-11-08
`;
check("missing mode lines: both missing", missingModeLines(existingDaily, [spec, { plan: "复盘", name: "日记", label: "📝", floor: 0, unit: "" }], "2026-11-08").length === 2, undefined);
const withModeLine = existingDaily + "- [ ] 🗣️ 文献复习 5篇 #计划/学习 🛫 2026-11-08 📅 2026-11-08\n";
check("missing mode lines: review exists", missingModeLines(withModeLine, [spec], "2026-11-08").length === 0, undefined);
check("missing mode lines: label prefix tolerated", missingModeLines(existingDaily + "- [ ] 🗣️ 文献复习 5篇（实 3篇）✋ #计划/学习 🛫 2026-11-08 📅 2026-11-08\n", [spec], "2026-11-08").length === 0, undefined);

// 手动标记：勾选 + ✋，重复打标幂等（阅读联动专用——模式行已无 ✋ 豁免，ADR-0011）
const toggled = toggleTaskLine(modeLine, 0, true);
const marked = markTaskLineManual(toggled, 0);
check("manual mark applied", marked.includes(MANUAL_MARK) && marked.startsWith("- [x]"), marked);
check("manual mark idempotent", markTaskLineManual(marked, 0) === marked, undefined);
check("manual actual parsed with ✋", parseQuotaActual(`🗣️ 文献复习 5篇（实 10篇）${MANUAL_MARK}`) === 10, undefined);
const rewritten = setQuotaActual(marked, 0, 10, "篇", true);
check("setQuotaActual drops manual mark (ADR-0011)", !rewritten.includes(MANUAL_MARK) && rewritten.includes("（实 10篇）"), rewritten);
const autoRewrite = setQuotaActual(marked, 0, 3, "篇", false);
check("auto rewrite strips manual mark", !autoRewrite.includes(MANUAL_MARK) && autoRewrite.startsWith("- [ ]"), autoRewrite);
const cleared = clearManualMark(marked, 0);
check("clearManualMark strips ✋ keeps state", !cleared.includes(MANUAL_MARK) && cleared.startsWith("- [x]") && cleared.includes("5篇"), cleared);
check("clearManualMark idempotent", clearManualMark(cleared, 0) === cleared, undefined);
check("clearManualMark no-mark no-op", clearManualMark(toggled, 0) === toggled, undefined);

// --- N+1. ADR-0008 书组：目标名提取 + 今日级联按书分组 -----------------------
check("goal name: multi-level leaf", extractGoalName("认知觉醒（第 5 章第 2 节）") === "认知觉醒");
check("goal name: flat leaf", extractGoalName("公众号文章（第 12 篇）") === "公众号文章");
check("goal name: manual task → null", extractGoalName("读书笔记整理") === null);
check("goal name: bare suffix → null", extractGoalName("（第 3 篇）") === null);

const bookPool = parseTaskPool(
	file,
	[
		// 书 A：今天有到期叶，未读 → scheduled，未完成
		"- [ ] 认知觉醒（第 5 章第 2 节） #计划/阅读 🛫 2026-11-08 📅 2026-11-08",
		// 书 B：今天的叶已勾，无欠账 → scheduled 且今日份额完成（预读同一口径）
		"- [x] 思考快与行为（第 3 章） #计划/阅读 🛫 2026-11-08 📅 2026-11-08",
		// 书 C：只有逾期欠账叶 → scheduled（欠账即今日安排），未完成
		"- [ ] 被讨好的勇气（第 2 节） #计划/阅读 🛫 2026-11-06 📅 2026-11-06",
		// 书 D：窗口未开始 → 不进分母
		"- [ ] 未开始的书（第 1 章） #计划/阅读 🛫 2026-11-20 📅 2026-11-25",
		// 书 E：全部读完（末叶 📅 已过）→ 不进分母
		"- [x] 已读完的书（第 9 节） #计划/阅读 🛫 2026-10-30 📅 2026-11-01",
		// 书 F：今天的叶已勾 + 昨天欠账未清 → scheduled 但未完成（逾期阻塞，D6）
		"- [ ] 逾期欠账书（第 4 节） #计划/阅读 🛫 2026-11-07 📅 2026-11-07",
		"- [x] 逾期欠账书（第 5 节） #计划/阅读 🛫 2026-11-08 📅 2026-11-08",
		// 书 G：跨日窗口叶（🛫=今天、📅=明天）已勾 → 窗口覆盖今天，计今日完成
		"- [x] 跨日窗口书（第 2 节） #计划/阅读 🛫 2026-11-08 📅 2026-11-09",
		// 手动任务无目标名后缀 → ungrouped
		"- [ ] 手动任务无后缀 #计划/阅读 🛫 2026-11-08 📅 2026-11-08",
	].join("\n"),
);
const bookView = groupPoolTasksByGoal(bookPool, "2026-11-08");
const gByName = new Map(bookView.groups.map((g) => [g.name, g]));
console.log("bookView:", JSON.stringify(bookView.groups.map((g) => ({ name: g.name, scheduled: g.scheduled, pending: g.pending.length, todayDone: g.todayDone.length }))));
check("book groups: 7 books", bookView.groups.length === 7, bookView.groups.length);
check("book groups: file order", bookView.groups.map((g) => g.name).join(",") === "认知觉醒,思考快与行为,被讨好的勇气,未开始的书,已读完的书,逾期欠账书,跨日窗口书", bookView.groups.map((g) => g.name).join(","));
check("book groups: manual task ungrouped", bookView.ungrouped.length === 1, bookView.ungrouped.length);

check("书A pending today", gByName.get("认知觉醒")?.scheduled === true && gByName.get("认知觉醒")?.pending.length === 1 && gByName.get("认知觉醒")?.todayDone.length === 0);
check("书B done today (pre-read)", gByName.get("思考快与行为")?.scheduled === true && gByName.get("思考快与行为")?.pending.length === 0 && gByName.get("思考快与行为")?.todayDone.length === 1);
check("书C scheduled via overdue", gByName.get("被讨好的勇气")?.scheduled === true && gByName.get("被讨好的勇气")?.pending.length === 1);
check("书D not started → excluded", gByName.get("未开始的书")?.scheduled === false);
check("书E fully read → excluded", gByName.get("已读完的书")?.scheduled === false);
check("书F overdue blocks done (D6)", gByName.get("逾期欠账书")?.scheduled === true && gByName.get("逾期欠账书")?.pending.length === 1 && gByName.get("逾期欠账书")?.todayDone.length === 1);
check("书G cross-day window counts done", gByName.get("跨日窗口书")?.scheduled === true && gByName.get("跨日窗口书")?.pending.length === 0 && gByName.get("跨日窗口书")?.todayDone.length === 1);

// 今日书进度：分母 = scheduled 书数，分子 = pending 清空的书数
const scheduled = bookView.groups.filter((g) => g.scheduled);
const doneToday = scheduled.filter((g) => g.pending.length === 0);
check("fraction denominator = 5", scheduled.length === 5, scheduled.length);
check("fraction numerator = 2", doneToday.length === 2, doneToday.length);

// ADR-0009: knownNames 前缀归属——无编号真实标题后缀（序）不游离书组外
const knownPool = parseTaskPool(
	file,
	[
		"- [ ] 先秦穿越生存手册（序） #计划/阅读 🛫 2026-11-08 📅 2026-11-08",
		"- [ ] 先秦穿越生存手册（第一章　英雄难过语言关·欲闯天下|上古汉语） #计划/阅读 🛫 2026-11-08 📅 2026-11-08",
		"- [ ] 别的书（第 1 节） #计划/阅读 🛫 2026-11-08 📅 2026-11-08",
	].join("\n")
);
const knownView = groupPoolTasksByGoal(knownPool, "2026-11-08", ["先秦穿越生存手册"]);
check("knownNames: 无编号后缀叶归入书组", knownView.groups.map((g) => g.name).join(",") === "先秦穿越生存手册,别的书", JSON.stringify(knownView.groups.map((g) => g.name)));
check("knownNames: 书组含两叶且 scheduled", knownView.groups[0]?.pending.length === 2 && knownView.groups[0]?.scheduled === true);
check("knownNames: 缺省维持原口径", groupPoolTasksByGoal(knownPool, "2026-11-08").ungrouped.length === 1);

// --- N. weave 阅读器桥（ADR-0009）：目录树转换 / 推进事实 / 接续阅读 --------
import { weaveTocToStructure, resumeLeafCount, crossedLeafIndices, passedLeafIndices, type WeaveTocNode } from "../src/weave-bridge";

const bookTree: WeaveTocNode[] = [
	{
		label: "第1章 初见", href: "c1.xhtml", spineIndex: 1,
		children: [
			{ label: "1.1 相遇", href: "c1.xhtml#s1", spineIndex: 1, children: [] },
			{ label: "1.2 离别", href: "c1.xhtml#s2", spineIndex: 1, children: [] },
		],
	},
	{ label: "第2章 独白", href: "c2.xhtml", spineIndex: 2, children: [] },
	{
		label: "第3章 重逢", href: "c3.xhtml", spineIndex: 4,
		children: [{ label: "3.1 重逢", href: "c3.xhtml#s1", spineIndex: 4, children: [] }],
	},
];
const conv = weaveTocToStructure(bookTree);
check("bridge: converts tree", conv !== null);
check("bridge: 2 levels", conv?.levels.length === 2, conv?.levels.length);
check("bridge: level0 章×3", conv?.levels[0].unit === "章" && conv.levels[0].counts[0] === 3);
check("bridge: level1 节 [2,0,1]", conv?.levels[1].unit === "节" && JSON.stringify(conv.levels[1].counts) === "[2,0,1]", JSON.stringify(conv?.levels[1].counts));
// 升格叶（无子的章）参与 DFS 叶序：第1节,第2节,第2章,第3节
check("bridge: leaf count 4", conv?.leafSpine.length === 4, conv?.leafSpine.length);
check("bridge: leafSpine DFS [1,1,2,4]", JSON.stringify(conv?.leafSpine) === "[1,1,2,4]", JSON.stringify(conv?.leafSpine));
check("bridge: leafHref DFS", conv?.leafHref.join("|") === "c1.xhtml#s1|c1.xhtml#s2|c2.xhtml|c3.xhtml#s1");
// 对齐不变式：结构展开叶数 = 桥叶序数（推进/跳转映射前提）
const bridgeLeaves = expandGoalStructure("测试书", conv!.levels);
check("bridge: alignment invariant (leaves match)", bridgeLeaves.length === conv!.leafSpine.length, `${bridgeLeaves.length} vs ${conv!.leafSpine.length}`);
check("bridge: upgrade leaf named as chapter", bridgeLeaves.some((l) => l.name.includes("第2章 独白")));
// 接续阅读：读到第 2 章（index 2）→ spine<2 的叶 = 第1节+第2节 = 2
check("resume: chapter 2 → 2 pre-read", resumeLeafCount(conv!.leafSpine, 2) === 2, resumeLeafCount(conv!.leafSpine, 2));
check("resume: 0 for unread book", resumeLeafCount(conv!.leafSpine, 0) === 0);
check("resume: all for finished book", resumeLeafCount(conv!.leafSpine, 5) === 4);
// 推进事实：从第 1 章进第 3 章 → 越过 [1,4) 的叶下标 {0,1,2}
check("advance: crossed [1,4) → idx 0,1,2", JSON.stringify(crossedLeafIndices(conv!.leafSpine, 1, 4)) === "[0,1,2]", JSON.stringify(crossedLeafIndices(conv!.leafSpine, 1, 4)));
check("advance: backward no crossing", crossedLeafIndices(conv!.leafSpine, 4, 1).length === 0);
check("passed: chapter 4 → 3 leaves (current excluded)", passedLeafIndices(conv!.leafSpine, 4).length === 3);
check("bridge: null for empty tree", weaveTocToStructure(null) === null && weaveTocToStructure([]) === null);
// 超深（>8 级）拒绝：9 层嵌套链
let deep: WeaveTocNode = { label: "第1条", href: "d9", spineIndex: 0, children: [] };
for (let i = 0; i < 8; i++) deep = { label: `第1级${8 - i}`, href: `d${8 - i}`, spineIndex: 0, children: [deep] };
check("bridge: >8 levels rejected", weaveTocToStructure([deep]) === null);
check("bridge: single level ok", weaveTocToStructure([{ label: "第1章", href: "c", spineIndex: 0, children: [] }]) !== null);

// readerSid frontmatter round-trip（ADR-0009）
const fmReader = `---
plans:
  阅读:
    type: 数量
    target: 读书
    goals:
      - name: 交易心理分析
        count: 17
        unit: 节
        structure:
          - unit: 章
            counts: [17]
        readerSid: epubsrc-d3aedbaff902c0fb5db47804
---
`;
const defsReader = parsePlansFromFrontmatter(fmReader);
const readerGoal = defsReader[0]?.goals[0];
check("readerSid: parsed from frontmatter", readerGoal?.readerSid === "epubsrc-d3aedbaff902c0fb5db47804", readerGoal?.readerSid);
check("readerSid: absent → undefined", defs1[0]?.goals?.[0]?.readerSid === undefined);

// --- 真实标题进任务名（ADR-0009 labels） -------------------------------------
const autoOf = (text: string): boolean =>
	isAutoTask({ text, plan: null, checked: false, start: null, due: null, line: 0, raw: "", file: null as unknown as TFile });
const labeled = expandGoalStructure("测试书", [
	{ unit: "章", counts: [2], labels: ["第1章 初见", "第2章 独白"] },
	{ unit: "节", counts: [2, 0], labels: ["1.1 相遇", "1.2 离别"] },
]);
check("labels: 重排叶带章路径前缀", labeled[0]?.name === "测试书（第1章 初见·1.1 相遇）", labeled[0]?.name);
check("labels: 重排叶2", labeled[1]?.name === "测试书（第1章 初见·1.2 离别）", labeled[1]?.name);
check("labels: 无节章升格用真实标题", labeled[2]?.name === "测试书（第2章 独白）", labeled[2]?.name);
check("labels: 组标签用真实标题", labeled[0]?.group === "第1章 初见", labeled[0]?.group);
check("labels: 非重排叶直接用真实标题", expandGoalStructure("书", [{ unit: "章", counts: [1], labels: ["第一回 石归"] }])[0]?.name === "书（第一回 石归）");
check("labels: 中文数字后缀识别为自动任务", autoOf("书（第一回 石归）") === true);
check("labels: 数字后缀识别", autoOf("书（1.1 相遇）") === true);
check("labels: 带路径后缀识别", autoOf(labeled[0]?.name ?? "") === true);
check("labels: 手动任务不误判", autoOf("写文章（草稿）") === false);
check("labels: extractGoalName 剥真实标题后缀", extractGoalName("书（1.1 相遇）") === "书");
check("labels: 缺 labels 落生成名", expandGoalStructure("书", [{ unit: "章", counts: [2] }])[1]?.name === "书（第 2 章）");
const convL = weaveTocToStructure(bookTree);
check("bridge: labels attached per level", convL?.levels[0].labels?.[0] === "第1章 初见" && convL.levels[1].labels?.length === 3, JSON.stringify(convL?.levels[1].labels));
// YAML round-trip
const fmLabels = `---
plans:
  阅读:
    type: 数量
    goals:
      - name: 测试书
        count: 3
        unit: 节
        structure:
          - unit: 章
            counts: [2]
            labels:
              - 第1章 初见
              - 第2章 独白
          - unit: 节
            counts: [2, 0]
            labels:
              - 1.1 相遇
              - 1.2 离别
---
`;
const defsLabels = parsePlansFromFrontmatter(fmLabels);
check("labels: YAML round-trip level0", defsLabels[0]?.goals[0]?.structure?.[0]?.labels?.[0] === "第1章 初见", JSON.stringify(defsLabels[0]?.goals[0]?.structure?.[0]?.labels));
check("labels: YAML round-trip level1 len 2", defsLabels[0]?.goals[0]?.structure?.[1]?.labels?.length === 2);
const rl = expandGoalStructure("测试书", defsLabels[0]!.goals[0]!.structure!);
check("labels: round-trip 命名稳定", rl[0]?.name === "测试书（第1章 初见·1.1 相遇）", rl[0]?.name);


// --- 模式行识别（matchesModeLine：父行不误判 / 无量行须全等） -----------------
check("modeLine: review line matches", matchesModeLine("🗣️ 文献复习 5篇（实 7篇）", "文献复习", 5, "篇"), undefined);
check("modeLine: exercise line matches", matchesModeLine("🏃 拉升 1次", "拉升", 1, "次"), undefined);
check("modeLine: diary exact matches", matchesModeLine("📝 日记", "日记", 0, ""), undefined);
check("modeLine: parent default line NOT matched (floor>0)", !matchesModeLine("🏃 运动 每天半小时", "运动", 30, "分钟"), undefined);
check("modeLine: parent default line NOT matched (floor=0)", !matchesModeLine("📈 日记 复盘+次日计划", "日记", 0, ""), undefined);
check("modeLine: wrong floor amount not matched", !matchesModeLine("🗣️ 文献复习 5篇", "文献复习", 10, "篇"), undefined);


// --- 今日打卡大项口径（topLevelCheckRows：模式子行折叠进父行，ADR-0012） ------
import { topLevelCheckRows, parseDailyContent } from "../src/daily";
import type { CheckItem } from "../src/daily";
// 用户截图场景：6/9（按行）应聚合为 3/5（按大项）
const dailyMd = [
	"# 2026-11-10",
	"## ✅ 今日打卡",
	"- [ ] 📈 复盘 复盘+次日计划 #计划/复盘",
	"- [x] 📖 阅读 #计划/阅读",
	"- [x] 🧠 笔记复习 #计划/笔记复习",
	"- [x] 🗣️ 文献复习 5篇（实 9篇） #计划/笔记复习",
	"- [x] 📝 日记 #计划/日记",
	"- [ ] 🏃 运动 每天半小时 #计划/运动",
	"- [x] 🏃 拉升 1次 #计划/运动",
	"- [ ] 🏃 八段锦 1次 #计划/运动",
	"- [x] 🏃 平板撑 3组 #计划/运动",
].join("\n");
const dailyFile = new TFile();
dailyFile.path = "2025/每日/2026-11-10.md";
dailyFile.name = "2026-11-10.md";
const parsed = parseDailyContent(dailyFile, dailyMd, "2026-11-10");
check("topRows: 解析出 9 行带计划标签行", parsed.checkItems.length === 9, parsed.checkItems.length);
// 模式行谓词：与视图 modeLineMatch 同构（matchesModeLine 逐目标判定）
const modeGoals = [
	{ plan: "笔记复习", name: "文献复习", floor: 5, unit: "篇" },
	{ plan: "运动", name: "拉升", floor: 1, unit: "次" },
	{ plan: "运动", name: "八段锦", floor: 1, unit: "次" },
	{ plan: "运动", name: "平板撑", floor: 3, unit: "组" },
];
const isModeLine = (it: CheckItem) =>
	modeGoals.some((g) => g.plan === it.plan && matchesModeLine(it.text, g.name, g.floor, g.unit));
const rows = topLevelCheckRows(parsed.checkItems, isModeLine);
check("topRows: 大项总数 = 5（4 个模式子行折叠）", rows.length === 5, rows.length);
check("topRows: 完成大项 = 3", rows.filter((r) => r.done).length === 3, rows.filter((r) => r.done).length);
check("topRows: 父行勾选即完成（笔记复习）", rows.find((r) => r.item.plan === "笔记复习")?.done === true);
check("topRows: 子行未全勾父行不算完成（运动）", rows.find((r) => r.item.plan === "运动")?.done === false);
check("topRows: 父行挂到全部模式子行（运动 3 子）", rows.find((r) => r.item.plan === "运动")?.modeChildren.length === 3);
// 回填间隙：父行未勾、子行全勾 → 大项视为完成（与「勾满子 → 父自动勾」同一把尺）
const gapMd = dailyMd
	.replace("- [x] 🧠 笔记复习", "- [ ] 🧠 笔记复习")
	.replace("- [ ] 🏃 运动 每天半小时 #计划/运动", "- [x] 🏃 运动 每天半小时 #计划/运动");
const gapRows = topLevelCheckRows(parseDailyContent(dailyFile, gapMd, "2026-11-10").checkItems, isModeLine);
check("topRows: 父未勾子全勾 = 完成（回填间隙不吞完成度）", gapRows.find((r) => r.item.plan === "笔记复习")?.done === true);
check("topRows: 父勾子未全勾 = 完成（父勾优先）", gapRows.find((r) => r.item.plan === "运动")?.done === true);
// 无父行的模式行保持顶层（渲染同款兜底）
const orphanMd = [
	"## ✅ 今日打卡",
	"- [x] 🗣️ 文献复习 5篇（实 9篇） #计划/笔记复习",
].join("\n");
const orphanRows = topLevelCheckRows(parseDailyContent(dailyFile, orphanMd, "2026-11-10").checkItems, isModeLine);
check("topRows: 无父行模式行保持顶层且计入", orphanRows.length === 1 && orphanRows[0].modeChildren.length === 0 && orphanRows[0].done, JSON.stringify(orphanRows));
// 无模式行时全部平铺（老口径兼容：谓词恒 false）
check("topRows: 无模式行 = 全部独立大项", topLevelCheckRows(parsed.checkItems, () => false).length === 9);


// --- 分次勾选（ADR-0017：量化子项次行——解析/锚定/聚合/生成/镜像） --------------
import {
	parseTickRow,
	buildTickLine,
	tickAnchorOf,
	tickChildrenOf,
	reconcileTickRows,
	subItemMirrorTargets,
	moveTaskBlock,
	removeLineBlock,
	modeLineAmount,
	splitTickCount,
	splitTicksDone,
	renameTickRowBase,
	choreTickLineIndices,
	type ModeLineSpec,
} from "../src/daily";

// 1. 次行文本样式（次行带单位：第k{unit}）
check("tick 样式: 拉伸第2次 → base+2+次", JSON.stringify(parseTickRow("拉伸第2次")) === JSON.stringify({ base: "拉伸", k: 2, unit: "次" }), parseTickRow("拉伸第2次"));
check("tick 样式: 组单位同样识别", JSON.stringify(parseTickRow("拉伸第2组")) === JSON.stringify({ base: "拉伸", k: 2, unit: "组" }), parseTickRow("拉伸第2组"));
check("tick 样式: 无单位尾也可（空单位目标）", JSON.stringify(parseTickRow("拉伸第2")) === JSON.stringify({ base: "拉伸", k: 2, unit: "" }), parseTickRow("拉伸第2"));
check("tick 样式: emoji 前缀容忍", parseTickRow("🏃 拉伸第1次")?.base === "拉伸", parseTickRow("🏃 拉伸第1次"));
check("tick 样式: 模式行文本不是次行", parseTickRow("拉伸 2次") === null, parseTickRow("拉伸 2次"));
check("tick 样式: 无 base 不算", parseTickRow("第2次") === null, parseTickRow("第2次"));
check("tick 样式: 其他量词行不算", parseTickRow("平板撑 3组") === null, parseTickRow("平板撑 3组"));
check("tick 样式: k=0 非法", parseTickRow("拉伸第0次") === null, parseTickRow("拉伸第0次"));
check("tick 样式: buildTickLine 缩进+标签+单位+日期", buildTickLine("拉伸", 2, "运动", "2026-11-12", "次") === "\t- [ ] 拉伸第2次 #计划/运动 🛫 2026-11-12 📅 2026-11-12", buildTickLine("拉伸", 2, "运动", "2026-11-12", "次"));
check("tick 样式: buildTickLine 组单位", buildTickLine("拉伸", 1, "运动", "2026-11-12", "组") === "\t- [ ] 拉伸第1组 #计划/运动 🛫 2026-11-12 📅 2026-11-12", buildTickLine("拉伸", 1, "运动", "2026-11-12", "组"));

// 2. 解析：缩进次行进 checkItems（indent + tick），其余缩进行保持不可见
const splitMd = [
	"# 2026-11-12",
	"## ✅ 今日打卡",
	"- [ ] 🏃 运动 每天半小时 #计划/运动",
	"- [ ] 🏃 拉伸 2次 #计划/运动",
	"\t- [x] 拉伸第1次 #计划/运动",
	"\t- [ ] 拉伸第2次 #计划/运动",
	"    - [ ] 缩进的普通行 #计划/运动",
	"	随便写写",
	"	- [ ] 无标签次行样式的行",
].join("\n");
const splitParsed = parseDailyContent(dailyFile, splitMd, "2026-11-12");
check("tick 解析: 4 行 checkItems（父+子项行+2 次行），非次行缩进行不可见", splitParsed.checkItems.length === 4, splitParsed.checkItems.map((i) => i.text));
const tickItems = splitParsed.checkItems.filter((it) => it.tick);
check("tick 解析: 两条次行带 indent+tick", tickItems.length === 2 && tickItems[0].tick?.base === "拉伸" && tickItems[0].tick?.k === 1 && tickItems[0].indent === 1, JSON.stringify(tickItems.map((t) => t.tick)));
check("tick 解析: 次行勾选态读对", tickItems[0].checked === true && tickItems[1].checked === false);
check("tick 解析: 缩进行不漏进 tempItems", splitParsed.tempItems.length === 0, splitParsed.tempItems.length);

// 3. matchesModeLine 碰撞记录：「拉伸第2次」includes("2次") 会误中 floor=2 的拉伸——上层须先守卫
const splitModeGoals = [{ plan: "运动", name: "拉伸", floor: 2, unit: "次" }];
const isSplitModeLine = (it: CheckItem) =>
	splitModeGoals.some((g) => g.plan === it.plan && matchesModeLine(it.text, g.name, g.floor, g.unit));
check("tick 回归: 次行文本确实会撞 matchesModeLine（记录本碰撞）", matchesModeLine("拉伸第2次", "拉伸", 2, "次") === true);
// 视图守卫口径（modeLineMatch 对 item.tick 恒 null）
const viewIsModeLine = (it: CheckItem) => !it.tick && isSplitModeLine(it);
const anchorItem0 = splitParsed.checkItems.find((it) => !it.tick && it.text.includes("拉伸 2次"))!;
check("tick 回归: 视图守卫——item.tick 恒非模式行、子项行仍是", viewIsModeLine(tickItems[1]) === false && viewIsModeLine(anchorItem0) === true);

// 4. 锚定与三层聚合
const splitAnchor = splitParsed.checkItems.find((it) => !it.tick && isSplitModeLine(it))!;
check("tick 锚: 次行锚到拉伸行", tickAnchorOf(splitParsed.checkItems, tickItems[0], isSplitModeLine) === splitAnchor);
check("tick 锚: tickChildrenOf 挂 2 条", tickChildrenOf(splitParsed.checkItems, splitAnchor, isSplitModeLine).length === 2);
const splitRows = topLevelCheckRows(splitParsed.checkItems, isSplitModeLine);
check("tick 聚合: 次行不落顶层（大项 = 1）", splitRows.length === 1, splitRows.length);
check("tick 聚合: 次行不进 modeChildren（拉伸行 1 条）", splitRows[0].modeChildren.length === 1, splitRows[0].modeChildren.length);
check("tick 聚合: 部分完成 → 大项未完成", splitRows[0].done === false, splitRows[0].done);
const allTickRows = topLevelCheckRows(parseDailyContent(dailyFile, splitMd.replace("\t- [ ] 拉伸第2次", "\t- [x] 拉伸第2次"), "2026-11-12").checkItems, isSplitModeLine);
check("tick 聚合: 次行全勾 → 子行镜像完成 → 大项完成", allTickRows[0].done === true, allTickRows[0].done);
// 次行缩进丢失 → 独立行兜底（不被吞）
const orphanTickMd = [
	"## ✅ 今日打卡",
	"- [ ] 🏃 运动 每天半小时 #计划/运动",
	"- [ ] 拉伸第1次 #计划/运动",
].join("\n");
const orphanTickRows = topLevelCheckRows(parseDailyContent(dailyFile, orphanTickMd, "2026-11-12").checkItems, isSplitModeLine);
check("tick 兜底: 锚行被删 → 次行独立顶层", orphanTickRows.length === 2, orphanTickRows.length);
// toggleTaskLine 容忍缩进（次行写回不丢缩进）
const toggledIndent = toggleTaskLine(splitMd, 5, true, "\t- [ ] 拉伸第2次 #计划/运动");
check("tick 写回: 缩进次行勾选保留缩进", toggledIndent.split("\n")[5] === "\t- [x] 拉伸第2次 #计划/运动", toggledIndent.split("\n")[5]);

// 5. reconcileTickRows：补缺/清理/幂等
const recBase = [
	"# 2026-11-12",
	"## ✅ 今日打卡",
	"- [ ] 🏃 运动 每天半小时 #计划/运动",
	"- [ ] 🏃 拉伸 2次 #计划/运动",
].join("\n");
const splitSpec: ModeLineSpec = { plan: "运动", name: "拉伸", label: "🏃", floor: 2, unit: "次" };
const rec1 = reconcileTickRows(recBase, splitSpec, 2, "2026-11-12");
check("tick 生成: 补出 2 条缩进次行", rec1.split("\n").filter((l) => l.includes("拉伸第")).length === 2, rec1);
check("tick 生成: 幂等", reconcileTickRows(rec1, splitSpec, 2, "2026-11-12") === rec1);
const rec2 = reconcileTickRows(recBase + "\n\t- [ ] 拉伸第2次 #计划/运动 🛫 2026-11-12 📅 2026-11-12", splitSpec, 2, "2026-11-12");
check("tick 生成: 补缺保持 k 升序", rec2.indexOf("拉伸第1次") !== -1 && rec2.indexOf("拉伸第1次") < rec2.indexOf("拉伸第2次"), rec2);
const rec3 = reconcileTickRows(rec1 + "\n\t- [ ] 拉伸第3次 #计划/运动 🛫 2026-11-12 📅 2026-11-12", splitSpec, 2, "2026-11-12");
check("tick 清理: 超量未勾次行删除", !rec3.includes("拉伸第3次"), rec3);
const rec4 = reconcileTickRows(rec1 + "\n\t- [x] 拉伸第3次 #计划/运动 🛫 2026-11-12 📅 2026-11-12", splitSpec, 2, "2026-11-12");
check("tick 清理: 超量已勾次行保留（完成记录）", rec4.includes("拉伸第3次"), rec4);
const rec5 = reconcileTickRows(rec1, splitSpec, 0, "2026-11-12");
check("tick 清理: n=0 清全部未勾次行", !rec5.includes("拉伸第"), rec5);
const rec6 = reconcileTickRows("# 2026-11-12\n## ✅ 今日打卡\n- [ ] 别的 #计划/别的\n", splitSpec, 2, "2026-11-12");
check("tick 生成: 无子项行原样返回", !rec6.includes("拉伸第"), rec6);
const rec7 = reconcileTickRows(rec1 + "\n\t- [ ] 拉伸第1次 #计划/运动 🛫 2026-11-12 📅 2026-11-12", splitSpec, 2, "2026-11-12");
check("tick 清理: 重复未勾次行去重", rec7.split("\n").filter((l) => l.includes("拉伸第1次")).length === 1, rec7);
check("tick 生成: 次行不掩盖真行缺失（missingModeLines 仍补子项行）", missingModeLines([
	"## ✅ 今日打卡",
	"- [ ] 🏃 运动 每天半小时 #计划/运动",
	"- [ ] 拉伸第2次 #计划/运动",
].join("\n"), [splitSpec], "2026-11-12").length === 1);

// 6. subItemMirrorTargets：次行全勾 ⇔ 子项行勾（双向）
check("mirror: 全未勾无动作", subItemMirrorTargets(rec1, [splitSpec]).length === 0);
const mir1 = subItemMirrorTargets(
	rec1.replace("\t- [ ] 拉伸第1次", "\t- [x] 拉伸第1次").replace("\t- [ ] 拉伸第2次", "\t- [x] 拉伸第2次"),
	[splitSpec]
);
check("mirror: 次行全勾 → 子项行待勾", mir1.length === 1 && mir1[0].checked === true, JSON.stringify(mir1));
const mir2 = subItemMirrorTargets(rec1.replace("- [ ] 🏃 拉伸 2次", "- [x] 🏃 拉伸 2次"), [splitSpec]);
check("mirror: 子项行勾但次行未全勾 → 待回退", mir2.length === 1 && mir2[0].checked === false, JSON.stringify(mir2));
check("mirror: 无次行不动", subItemMirrorTargets(recBase, [splitSpec]).length === 0);

// 7. 块移动/块删除
const blockStart = rec1.split("\n").findIndex((l) => l.includes("拉伸 2次"));
check("tick 块: 上移整块跟手", moveTaskBlock(rec1, blockStart, blockStart + 2, -1).split("\n")[blockStart - 1].includes("拉伸 2次"));
const recBlockDown = rec1 + "\n- [ ] 🏃 八段锦 1次 #计划/运动 🛫 2026-11-12 📅 2026-11-12";
check("tick 块: 下移整块跟手", moveTaskBlock(recBlockDown, blockStart, blockStart + 2, 1).split("\n")[blockStart + 1].includes("拉伸 2次"));
check("tick 块: 相邻非任务行不越界（标题上方不动）", moveTaskBlock(rec1, 2, 2, -1) === rec1);
const removedBlock = removeLineBlock(rec1, blockStart, blockStart + 2);
check("tick 块: 删除整块（子项行+次行）", !removedBlock.includes("拉伸") && removedBlock.includes("运动 每天半小时"), removedBlock);

// 8. parentCheckTargets：次行跳过（缩进行本就 invisible；守卫兜独立次行）
const rollTickMd = [
	"# 2026-11-12",
	"## ✅ 今日打卡",
	"- [ ] 🏃 运动 每天半小时 #计划/运动",
	"- [x] 🏃 拉伸 2次 #计划/运动",
	"\t- [x] 拉伸第1次 #计划/运动",
	"\t- [x] 拉伸第2次 #计划/运动",
].join("\n");
const rollTickFacts: ParentRollupFact[] = [{ plan: "运动", live: true, pendingEmpty: true }];
const rollTickTargets = parentCheckTargets(
	rollTickMd,
	rollTickFacts,
	(plan, text) => plan === "运动" && matchesModeLine(text, "拉伸", 2, "次"),
	(plan, text) => plan === "运动" && parseTickRow(text)?.base === "拉伸"
);
check("tick 对账: 镜像后子项行勾 → 运动父行入账", rollTickTargets.length === 1 && rollTickTargets[0].plan === "运动", JSON.stringify(rollTickTargets));
const flatTickMd = rollTickMd.replace("\n\t- [x] 拉伸第2次 #计划/运动", "\n- [ ] 拉伸第2次 #计划/运动");
check("tick 对账: 无守卫时独立次行会误阻塞父行（记录碰撞）", parentCheckTargets(flatTickMd, rollTickFacts, (plan, text) => plan === "运动" && matchesModeLine(text, "拉伸", 2, "次")).length === 0);
const flatGuarded = parentCheckTargets(
	flatTickMd,
	rollTickFacts,
	(plan, text) => plan === "运动" && matchesModeLine(text, "拉伸", 2, "次"),
	(plan, text) => plan === "运动" && parseTickRow(text)?.base === "拉伸"
);
check("tick 对账: isTickLineText 守卫兜住独立次行", flatGuarded.length === 1 && flatGuarded[0].plan === "运动", JSON.stringify(flatGuarded));

// 9. repointModeLineAmounts：目标量/单位编辑后旧行重指（用户实测踩坑：拉升 1次 对 floor=2 顶层化）
import { repointModeLineAmounts } from "../src/daily";
const rep1 = repointModeLineAmounts([
	"# 2026-11-12",
	"## ✅ 今日打卡",
	"- [ ] 🏃 运动 每天半小时 #计划/运动",
	"- [x] 🏃 拉伸 1次 #计划/运动 🛫 2026-11-12 📅 2026-11-12",
	"- [ ] 🏃 平板撑 3组 #计划/运动",
].join("\n"), [splitSpec]);
check("repoint: 旧量行改到新口径（勾选态/标签/日期保留）", rep1.includes("- [x] 🏃 拉伸 2次 #计划/运动 🛫 2026-11-12 📅 2026-11-12"), rep1);
check("repoint: 父行与他量行不动", rep1.includes("运动 每天半小时") && rep1.includes("平板撑 3组"));
check("repoint: 幂等", repointModeLineAmounts(rep1, [splitSpec]) === rep1);
check("repoint: 实量后缀保留", repointModeLineAmounts("## ✅ 今日打卡\n- [ ] 🗣️ 文献复习 5篇（实 9篇） #计划/学习", [{ plan: "学习", name: "文献复习", label: "🗣️", floor: 3, unit: "篇" }]) === "## ✅ 今日打卡\n- [ ] 🗣️ 文献复习 3篇（实 9篇） #计划/学习");
check("repoint: 缺量行补量", repointModeLineAmounts("## ✅ 今日打卡\n- [ ] 拉伸 #计划/运动", [splitSpec]) === "## ✅ 今日打卡\n- [ ] 拉伸 2次 #计划/运动");
check("repoint: floor=0 剥量回纯打卡", repointModeLineAmounts("## ✅ 今日打卡\n- [ ] 拉伸 2次 #计划/运动", [{ plan: "运动", name: "拉伸", label: "", floor: 0, unit: "" }]) === "## ✅ 今日打卡\n- [ ] 拉伸 #计划/运动");
check("repoint: 次行样式行不动", repointModeLineAmounts("## ✅ 今日打卡\n- [ ] 拉伸第2次 #计划/运动", [splitSpec]) === "## ✅ 今日打卡\n- [ ] 拉伸第2次 #计划/运动");
check("repoint: 名后带其他文本的行不动", repointModeLineAmounts("## ✅ 今日打卡\n- [ ] 拉伸计划很重要 #计划/运动", [splitSpec]) === "## ✅ 今日打卡\n- [ ] 拉伸计划很重要 #计划/运动");
check("repoint: 单位变更跟随（次→组）", repointModeLineAmounts("## ✅ 今日打卡\n- [ ] 🏃 拉伸 2次 #计划/运动", [{ plan: "运动", name: "拉伸", label: "🏃", floor: 2, unit: "组" }]) === "## ✅ 今日打卡\n- [ ] 🏃 拉伸 2组 #计划/运动");
// 重指后整链贯通：重指 → 次行可锚定生成 → 子项行回到模式行折叠
const repChain = reconcileTickRows(repointModeLineAmounts([
	"## ✅ 今日打卡",
	"- [ ] 🏃 运动 每天半小时 #计划/运动",
	"- [ ] 🏃 拉伸 1次 #计划/运动",
].join("\n"), [splitSpec]), splitSpec, 2, "2026-11-12");
check("repoint: 重指后次行生成、行折叠回父项", repChain.includes("\t- [ ] 拉伸第1次") && topLevelCheckRows(parseDailyContent(dailyFile, repChain, "2026-11-12").checkItems, isSplitModeLine).length === 1, repChain);

// 10. 组单位（用户裁决：组次一样，可数单位都拆）+ 单位切换清理
const zuSpec: ModeLineSpec = { plan: "运动", name: "拉伸", label: "💪", floor: 2, unit: "组" };
const zu1 = reconcileTickRows("## ✅ 今日打卡\n- [ ] 💪 拉伸 2组 #计划/运动", zuSpec, 2, "2026-11-12");
check("tick 组: 生成第1组/第2组", zu1.includes("\t- [ ] 拉伸第1组 #计划/运动") && zu1.includes("\t- [ ] 拉伸第2组 #计划/运动"), zu1);
check("tick 组: 幂等", reconcileTickRows(zu1, zuSpec, 2, "2026-11-12") === zu1);
const zuMirror = subItemMirrorTargets(
	zu1.replace("\t- [ ] 拉伸第1组", "\t- [x] 拉伸第1组").replace("\t- [ ] 拉伸第2组", "\t- [x] 拉伸第2组"),
	[zuSpec]
);
check("tick 组: 全勾镜像待勾子项行", zuMirror.length === 1 && zuMirror[0].checked === true, JSON.stringify(zuMirror));
// 单位切换（次 → 组）：真实刷新链 = 先重指子项行（2次→2组），再清理旧单位未勾次行 + 生成新单位行
const switched = reconcileTickRows(repointModeLineAmounts(rec1, [zuSpec]), zuSpec, 2, "2026-11-12");
check("tick 组: 切单位后旧行重指、旧未勾次行清除、新单位行生成", switched.includes("拉伸 2组") && switched.includes("拉伸第1组") && !switched.includes("拉伸第1次"), switched);
const switched2 = reconcileTickRows(repointModeLineAmounts(rec1.replace("\t- [ ] 拉伸第1次", "\t- [x] 拉伸第1次"), [zuSpec]), zuSpec, 2, "2026-11-12");
check("tick 组: 旧单位已勾次行保留（完成记录）", switched2.includes("拉伸 2组") && switched2.includes("拉伸第1次") && switched2.includes("拉伸第1组"), switched2);
check("tick 组: 异单位次行不进镜像", subItemMirrorTargets(rec1.replace("\t- [ ] 拉伸第1次", "\t- [x] 拉伸第1次").replace("\t- [ ] 拉伸第2次", "\t- [x] 拉伸第2次"), [zuSpec]).length === 0);

// 11. 父行自愈（ensureModeParentLines）：模式行计划缺父行时补模板行（用户实测踩坑：
//     目标晚于笔记创建 → 父行缺失 → 模式行+次行整组顶层化）
import { ensureModeParentLines } from "../src/daily";
const healParents = [{ plan: "运动", line: "- [ ] 💪 运动 #计划/运动 🛫 2026-11-12 📅 2026-11-12" }];
const healIsMode = (plan: string, text: string): boolean => plan === "运动" && matchesModeLine(text, "拉伸", 2, "次");
const healBase = [
	"# 2026-11-12",
	"## ✅ 今日打卡",
	"- [ ] 📈 复盘 #计划/复盘",
	"- [ ] 🏃 拉伸 2次 #计划/运动 🛫 2026-11-12 📅 2026-11-12",
	"\t- [ ] 拉伸第1次 #计划/运动 🛫 2026-11-12 📅 2026-11-12",
].join("\n");
const healed = ensureModeParentLines(healBase, healParents, healIsMode);
check("heal: 缺父行 → 插到首个模式行之前", healed.includes("\t- [ ] 拉伸第1次") && healed.indexOf("💪 运动") < healed.indexOf("拉伸 2次") && healed.indexOf("拉伸 2次") < healed.indexOf("拉伸第1次"), healed);
check("heal: 幂等", ensureModeParentLines(healed, healParents, healIsMode) === healed);
const healed2 = ensureModeParentLines(
	healBase.replace("- [ ] 🏃 拉伸 2次", "- [ ] 🏃 运动 每天半小时 #计划/运动\n- [ ] 🏃 拉伸 2次"),
	healParents,
	healIsMode
);
check("heal: 已有非模式父行不重复补", healed2.split("\n").filter((l) => l.includes("#计划/运动") && !l.includes("拉伸")).length === 1, healed2);
const healed3 = ensureModeParentLines(
	"# 2026-11-12\n## ✅ 今日打卡\n- [ ] 拉伸第1次 #计划/运动",
	healParents,
	healIsMode
);
check("heal: 独立次行不算父行、仍补父行", healed3.includes("💪 运动") && healed3.split("\n").filter((l) => l.includes("拉伸第1次")).length === 1, healed3);
check("heal: 计划无任何模式内容不凭空补卡", ensureModeParentLines(healBase, [{ plan: "阅读", line: "- [ ] 📖 阅读 #计划/阅读" }], healIsMode) === healBase);
// 日记形态：目标名=计划名的行可兼任大项，永远顶层——不触发补卡（防重复补行）
const diaryIsMode = (plan: string, text: string): boolean => plan === "日记" && matchesModeLine(text, "日记", 0, "");
const diaryContent = "# 2026-11-12\n## ✅ 今日打卡\n- [ ] 📝 日记 #计划/日记 🛫 2026-11-12 📅 2026-11-12";
check("heal: 计划名本身行不触发补卡（日记形态）", ensureModeParentLines(diaryContent, [{ plan: "日记", line: "- [ ] 📝 日记 #计划/日记 🛫 2026-11-12 📅 2026-11-12" }], diaryIsMode) === diaryContent);



// --- 刷新期父行对账（parentCheckTargets：待办清空 → 勾父，ADR-0013） ----------
import { parentCheckTargets, type ParentRollupFact } from "../src/daily";
// 用户截图场景：阅读 3/3 本叶子勾满（weave 自动勾），父行未勾 → 对账入账
const rollupMd = [
	"# 2026-11-11",
	"## ✅ 今日打卡",
	"- [ ] 📖 阅读 #计划/阅读",
	"- [x] 🗣️ 文献复习 5篇（实 9篇） #计划/笔记复习",
	"- [ ] 🧠 笔记复习 #计划/笔记复习",
	"- [ ] 🏃 运动 每天半小时 #计划/运动",
	"- [x] 🏃 拉升 1次 #计划/运动",
	"- [x] 🏃 平板撑 3组 #计划/运动",
	"- [ ] 🧘 冥想 #计划/冥想",
].join("\n");
const rollupFacts: ParentRollupFact[] = [
	{ plan: "阅读", live: true, pendingEmpty: true },
	{ plan: "笔记复习", live: true, pendingEmpty: true },
	{ plan: "运动", live: true, pendingEmpty: true },
	{ plan: "冥想", live: false, pendingEmpty: true }, // 纯打卡计划：无目标恒不自动勾
];
const rollupModePredicate = (plan: string, text: string): boolean =>
	modeGoals.some((g) => g.plan === plan && matchesModeLine(text, g.name, g.floor, g.unit));
const rollupTargets = parentCheckTargets(rollupMd, rollupFacts, rollupModePredicate);
check("rollup: 待办清空 → 阅读父行入账", rollupTargets.some((t) => t.plan === "阅读"), rollupTargets);
check("rollup: 模式行全勾 → 笔记复习父行入账（模式行在前不挡父行识别）", rollupTargets.some((t) => t.plan === "笔记复习"));
check("rollup: 模式行全勾 → 运动父行入账", rollupTargets.some((t) => t.plan === "运动"));
check("rollup: 纯打卡行（无目标）不自动勾", !rollupTargets.some((t) => t.plan === "冥想"));
check("rollup: 目标带行号与原文（可直落 toggleTaskLine）", rollupTargets.find((t) => t.plan === "阅读")?.line === 2);
const applied = rollupTargets.reduce((acc, t) => toggleTaskLine(acc, t.line, true, t.raw), rollupMd);
check("rollup: 落勾后父行为 [x]", applied.includes("- [x] 📖 阅读 #计划/阅读"), applied.split("\n")[2]);
check("rollup: 待办未清不勾", !parentCheckTargets(rollupMd, rollupFacts.map((f) => (f.plan === "阅读" ? { ...f, pendingEmpty: false } : f)), rollupModePredicate).some((t) => t.plan === "阅读"));
check("rollup: 窗口外计划不勾", !parentCheckTargets(rollupMd, rollupFacts.map((f) => (f.plan === "阅读" ? { ...f, live: false } : f)), rollupModePredicate).some((t) => t.plan === "阅读"));
check("rollup: 父行 ✋ 豁免", !parentCheckTargets(rollupMd.replace("- [ ] 📖 阅读 #计划/阅读", "- [ ] 📖 阅读 ✋ #计划/阅读"), rollupFacts, rollupModePredicate).some((t) => t.plan === "阅读"));
check("rollup: 已勾父行不再入账（幂等）", !parentCheckTargets(rollupMd.replace("- [ ] 📖 阅读 #计划/阅读", "- [x] 📖 阅读 #计划/阅读"), rollupFacts, rollupModePredicate).some((t) => t.plan === "阅读"));
check("rollup: 模式子行未全勾不勾父行", !parentCheckTargets(rollupMd.replace("- [x] 🏃 拉升 1次 #计划/运动", "- [ ] 🏃 拉升 1次 #计划/运动"), rollupFacts, rollupModePredicate).some((t) => t.plan === "运动"));
const twiceTargets = parentCheckTargets(rollupMd + "\n- [ ] 📖 又一行 #计划/阅读", rollupFacts, rollupModePredicate);
check("rollup: 同计划只认第一个非模式行", twiceTargets.filter((t) => t.plan === "阅读").length === 1);
check("rollup: 只扫今日打卡区", parentCheckTargets("## 📌 其他\n- [ ] 📖 阅读 #计划/阅读\n", [{ plan: "阅读", live: true, pendingEmpty: true }], () => false).length === 0);

// --- ADR-0015 独立完成事实（复盘 = 日记当日复盘小节非空 → factDone 直通勾父行） ----------
const factMd = [
	"# 2026-11-11",
	"## ✅ 今日打卡",
	"- [ ] 📈 复盘 #计划/复盘",
].join("\n");
const factFacts: ParentRollupFact[] = [{ plan: "复盘", live: false, pendingEmpty: true, factDone: true }];
const factTargets = parentCheckTargets(factMd, factFacts, () => false);
check("fact: 事实为真 → 无窗口/无待办也勾父行", factTargets.length === 1 && factTargets[0].plan === "复盘", factTargets);
check("fact: 事实为假 → 纯打卡行仍不勾", parentCheckTargets(factMd, [{ plan: "复盘", live: false, pendingEmpty: true }], () => false).length === 0);
check("fact: factDone:false 同不勾", parentCheckTargets(factMd, [{ plan: "复盘", live: false, pendingEmpty: true, factDone: false }], () => false).length === 0);
check("fact: ✋ 豁免对事实勾同样生效", parentCheckTargets(factMd.replace("- [ ] 📈 复盘 #计划/复盘", "- [ ] 📈 复盘 ✋ #计划/复盘"), factFacts, () => false).length === 0);
check("fact: 已勾幂等不再入账", parentCheckTargets(factMd.replace("- [ ] 📈 复盘 #计划/复盘", "- [x] 📈 复盘 #计划/复盘"), factFacts, () => false).length === 0);
check("fact: 事实勾可直落 toggleTaskLine", toggleTaskLine(factMd, factTargets[0].line, true, factTargets[0].raw).includes("- [x] 📈 复盘 #计划/复盘"));


// --- 手工补录条目的锚点回填（ADR-0009 补遗） --------------------------------
import { normalizeTocLabel, resolveMissingAnchors, inferNeighborSpines } from "../src/weave-bridge";
check("norm: 标题归一化", normalizeTocLabel("6.27 高位窄幅震荡、放量（二）") === "627高位窄幅震荡放量二", normalizeTocLabel("6.27 高位窄幅震荡、放量（二）"));
{
	const edited: WeaveTocNode[] = [
		{ label: "第6章 量价分析", href: "c6.xhtml", spineIndex: 5, children: [
			{ label: "6.26 缩量长阴破位+缩量长阳收复", href: "c6d.xhtml", spineIndex: 5, children: [] },
			{ label: "6.27 高位窄幅震荡的放量", href: "", spineIndex: -1, children: [] },
		] },
		{ label: "第7章 趋势转折", href: "c7.xhtml", spineIndex: 6, children: [] },
	];
	const live: WeaveTocNode[] = [
		{ label: "第6章 量价分析", href: "c6.xhtml", spineIndex: 5, children: [] },
		{ label: "6.26 缩量长阴破位＋缩量长阳收复", href: "c6d.xhtml", spineIndex: 5, children: [] },
		{ label: "6.27 高位窄幅震荡的放量", href: "c6e.xhtml", spineIndex: 5, children: [] },
		{ label: "第7章 趋势转折", href: "c7.xhtml", spineIndex: 6, children: [] },
	];
	resolveMissingAnchors(edited, live);
	check("补遗: 精确归一化匹配回填", edited[0].children[1].href === "c6e.xhtml" && edited[0].children[1].spineIndex === 5);
	const added2: WeaveTocNode[] = [
		{ label: "第1章 A", href: "a.xhtml", spineIndex: 0, children: [] },
		{ label: "手工补的中间章（书里实际有但目录缺失）", href: "", spineIndex: -1, children: [] },
		{ label: "第2章 B", href: "b.xhtml", spineIndex: 1, children: [] },
	];
	resolveMissingAnchors(added2, null);
	inferNeighborSpines(added2);
	check("补遗: 无实时目录时继承前叶章序", added2[1].spineIndex === 0, added2[1].spineIndex);
	const leading: WeaveTocNode[] = [
		{ label: "手工前言", href: "", spineIndex: -1, children: [] },
		{ label: "第1章 A", href: "a.xhtml", spineIndex: 0, children: [] },
	];
	inferNeighborSpines(leading);
	check("补遗: 首个锚点之前不误判", leading[0].spineIndex === -1 && leading[1].spineIndex === 0);
}


// --- 锚点快照第三字段（文件内进度） ------------------------------------------
const fmAnchor3 = `---
plans:
  阅读:
    type: 数量
    goals:
      - name: 测试书
        count: 2
        unit: 节
        structure:
          - unit: 章
            counts: [2]
        readerSid: epubsrc-abc
        readerAnchors:
          - "0|c1.xhtml|0.25"
          - "1|c2.xhtml"
---
`;
const defsA3 = parsePlansFromFrontmatter(fmAnchor3);
const a3 = defsA3[0]?.goals[0]?.readerAnchors;
check("anchors3: 三段解析 spine/href/progress", a3?.[0]?.spine === 0 && a3?.[0]?.href === "c1.xhtml" && a3?.[0]?.progress === 0.25, JSON.stringify(defsA3[0]?.goals[0]?.readerAnchors));
check("anchors3: 两段旧格式无 progress", a3?.[1]?.href === "c2.xhtml" && a3?.[1]?.progress === undefined);
const convF = weaveTocToStructure(bookTree);
check("anchors3: 桥叶序 progress 数组对齐", !!convF && convF.leafProgress.length === convF.leafSpine.length && convF.leafProgress.every((x) => typeof x === "number"));


// --- 粘贴导入真实标题（ADR-0009 depthLabels） --------------------------------
const pt = parseToc("第1章 初见\n  1.1 相遇\n  1.2 离别\n第2章 独白");
check("paste labels: 附带每层标题", pt?.levels[0].labels?.[0] === "第1章 初见" && pt?.levels[1].labels?.[0] === "1.1 相遇", JSON.stringify(pt?.levels[1].labels));
const ptLeaves = expandGoalStructure("书", pt!.levels);
check("paste labels: 叶名带真实标题", ptLeaves[0]?.name === "书（第1章 初见·1.1 相遇）", ptLeaves[0]?.name);

// --- ADR-0010 写作模式：按字数配额 / 按章节平铺 ------------------------------
const fmWriting = `---
plans:
  - name: 小说
    label: "✍️"
    goals:
      - name: 《三体》
        count: 0
        unit: 字
        mode: writing
        floor: 1166.7
        writingQuota:
          total: 100000
          unit: 字
          start: 2026-01-01
          end: 2026-12-31
          initial: 20000
      - name: 《黑暗森林》
        count: 3
        unit: 章
        mode: writing
        structure:
          - unit: 章
            counts: [3]
---
`;
const defsW = parsePlansFromFrontmatter(fmWriting);
const wPlan = defsW[0];
check("writing: 计划为数量型", wPlan?.type === "numeric");
const wq = wPlan?.goals[0];
check("writing: mode=writing 解析", wq?.mode === "writing");
check("writing: 目标级字数配额解析", wq?.writingQuota?.total === 100000 && wq?.writingQuota?.end === "2026-12-31", JSON.stringify(wq?.writingQuota));
check("writing: 接续初始量解析", wq?.writingQuota?.initial === 20000);
check("writing: floor 冻结配额原样保留", wq?.floor === 1166.7);
const wc = wPlan?.goals[1];
check("writing: 按章节 = 1 级章结构平铺", wc?.mode === "writing" && wc?.structure?.[0]?.counts?.[0] === 3 && !wc?.writingQuota);
const wLeaves = expandGoalLeaves("《黑暗森林》", wc!);
check("writing: 章叶命名「第 N 章」全书连续", wLeaves?.[0]?.name === "《黑暗森林》（第 1 章）" && wLeaves?.[2]?.name === "《黑暗森林》（第 3 章）", JSON.stringify(wLeaves?.map((l) => l.name)));

// 每日配额：(总量 − 接续初始量) ÷ 天数，1 位小数（创建时一次算死）
check("writing daily: 8 万字 ÷ 365 天", computeWritingDaily(100000, 20000, "2026-01-01", "2026-12-31") === Math.round((80000 / 365) * 10) / 10, computeWritingDaily(100000, 20000, "2026-01-01", "2026-12-31"));
check("writing daily: initial=0 与 quota 同口径", computeWritingDaily(100000, 0, "2026-01-01", "2026-01-31") === computeQuotaDaily(100000, "2026-01-01", "2026-01-31"));

// 写作行识别：放宽匹配（目标名开头 + 名后带数字），配额编辑后旧行数字过期仍认（跨变更累计）
check("writing line: 识别配额行含实量", matchesWritingLine("✍️ 《三体》 1166.7字（实 800字）", "《三体》"));
check("writing line: 识别历史旧配额行", matchesWritingLine("✍️ 《三体》 999字", "《三体》"));
check("writing line: 无数字不认（计划默认行防误判）", !matchesWritingLine("✍️ 《三体》 每天写", "《三体》"));
check("writing line: 他人名字不认", !matchesWritingLine("✍️ 《球状闪电》 500字", "《三体》"));

// --- 份额清空提醒 diffShareClear：只认 false → true 跃迁 ---------------------
{
	const r = diffShareClear(null, [{ key: "阅读||三体", name: "三体", cleared: true }]);
	check("shareClear: 首轮基线不提醒", r.cleared.length === 0, r.cleared);
	check("shareClear: 首轮快照落位", r.next.get("阅读||三体") === true);
}
{
	const prev = new Map([["阅读||三体", false]]);
	const r = diffShareClear(prev, [{ key: "阅读||三体", name: "三体", cleared: true }]);
	check("shareClear: false→true 跃迁提醒", r.cleared.length === 1 && r.cleared[0] === "三体", r.cleared);
}
{
	const prev = new Map([["阅读||三体", true]]);
	const r = diffShareClear(prev, [{ key: "阅读||三体", name: "三体", cleared: true }]);
	check("shareClear: 已清空保持静默", r.cleared.length === 0, r.cleared);
}
{
	const prev = new Map([["阅读||三体", false]]);
	const r = diffShareClear(prev, [{ key: "阅读||三体", name: "三体", cleared: false }]);
	check("shareClear: 未清空静默且快照跟随", r.cleared.length === 0 && r.next.get("阅读||三体") === false);
}
{
	const prev = new Map([["阅读||三体", false], ["阅读||红楼梦", false]]);
	const r = diffShareClear(prev, [
		{ key: "阅读||三体", name: "三体", cleared: true },
		{ key: "阅读||红楼梦", name: "红楼梦", cleared: true },
	]);
	check("shareClear: 同批多书齐跃迁（合并一条）", r.cleared.length === 2 && r.next.size === 2, r.cleared);
}
{
	// 新进分母的书（首见即 cleared，如打开视图时早已勾完）按基线处理，不触发
	const prev = new Map([["阅读||旧书", false]]);
	const r = diffShareClear(prev, [
		{ key: "阅读||旧书", name: "旧书", cleared: false },
		{ key: "阅读||新书", name: "新书", cleared: true },
	]);
	check("shareClear: 首见即清空按基线不提醒", r.cleared.length === 0 && r.next.size === 2, r.cleared);
}
{
	// 退勾再勾满：true→false→true 每次跃迁都提醒（不做当日去重）
	const afterUncheck = diffShareClear(new Map([["阅读||三体", true]]), [{ key: "阅读||三体", name: "三体", cleared: false }]);
	check("shareClear: 退勾回落静默", afterUncheck.cleared.length === 0 && afterUncheck.next.get("阅读||三体") === false);
	const afterRecheck = diffShareClear(afterUncheck.next, [{ key: "阅读||三体", name: "三体", cleared: true }]);
	check("shareClear: 重勾再跃迁再提醒", afterRecheck.cleared.length === 1, afterRecheck.cleared);
}

// --- ADR-0014: 次日计划（日记「# 次日计划」）写入/提取 ---------------------------------------
{
	// 首写・无当日复盘：插在「# 随笔」小节结束处（与复盘同一套锚点规则；标题后空行同构）
	const diary = ["# 睡眠相关", "23:30-07:00", "", "# 随笔", "想到什么写什么。", "", "# 新闻联播", ""].join("\n");
	const out = nextDayPlanTransform(diary, "明日待办一");
	const expected = ["# 睡眠相关", "23:30-07:00", "", "# 随笔", "想到什么写什么。", "", "# 次日计划", "", "明日待办一", "", "# 新闻联播", ""].join("\n");
	check("nextDay: 首写插在随笔节尾", out === expected, out);
}
{
	// 首写・有当日复盘：插在「# 当日复盘」节尾（旧「## 明日计划」子节是复盘正文，不截断不挪动）
	const diary = ["# 随笔", "随笔内容", "", "# 当日复盘", "复盘内容", "", "## 明日计划", "- 旧内容", "", "# 新闻联播", ""].join("\n");
	const out = nextDayPlanTransform(diary, "新计划");
	const expected = ["# 随笔", "随笔内容", "", "# 当日复盘", "复盘内容", "", "## 明日计划", "- 旧内容", "", "# 次日计划", "", "新计划", "", "# 新闻联播", ""].join("\n");
	check("nextDay: 锚点当日复盘节尾，## 子节不被截断", out === expected, out);
}
{
	// 幂等：同一内容重复写入，全文不变且标题唯一
	const diary = ["# 随笔", "", "# 新闻联播", ""].join("\n");
	const once = nextDayPlanTransform(diary, "计划内容")!;
	const twice = nextDayPlanTransform(once, "计划内容")!;
	check("nextDay: 重复写入幂等", twice === once, twice);
	check("nextDay: 标题唯一", once.split("# 次日计划").length === 2, once);
}
{
	// 首尾空行掐掉、正文中间空行与 ## 子标题原样保留
	const diary = ["# 随笔", "内容", "", "# 新闻联播", ""].join("\n");
	const out = nextDayPlanTransform(diary, "\n第一行\n\n## 分节\n第二行\n\n")!;
	const expected = ["# 随笔", "内容", "", "# 次日计划", "", "第一行", "", "## 分节", "第二行", "", "# 新闻联播", ""].join("\n");
	check("nextDay: 正文空行/子标题原样，首尾空行规整", out === expected, out);
}
{
	// 无「# 当日复盘」也无「# 随笔」→ 无锚点返回 null
	check("nextDay: 双锚点缺失返回 null", nextDayPlanTransform("# 日记\n正文\n", "x") === null, undefined);
	// 已有小节但位置任意（用户手动挪过）→ 原位替换，不搬回锚点处
	const moved = ["# 次日计划", "", "旧计划", "", "# 随笔", "内容", ""].join("\n");
	const out = nextDayPlanTransform(moved, "新计划");
	const expectedMoved = ["# 次日计划", "", "新计划", "", "# 随笔", "内容", ""].join("\n");
	check("nextDay: 已有小节原位替换不搬家", out === expectedMoved, out);
}
{
	// 提取：掐首尾空行，## 子标题属本小节；无小节返回 null
	const diary = ["# 随笔", "内容", "", "# 次日计划", "", "第一行", "", "## 分节", "第二行", "", "# 新闻联播", ""].join("\n");
	check("extract nextDay: 正文含子标题", extractNextDayPlanSection(diary) === ["第一行", "", "## 分节", "第二行"].join("\n"), extractNextDayPlanSection(diary));
	check("extract nextDay: 无小节返回 null", extractNextDayPlanSection("# 随笔\n内容\n") === null, undefined);
}

// --- ADR-0016: 生活事项固定日子式周期——解析与文案 --------------------------------------------
{
	const c = parseChoreCycle({ unit: "week", days: [0] });
	check("cycle: week 单位直认", c?.unit === "week" && c.days.length === 1 && c.days[0] === 0, c);
	const d = parseChoreCycle({ unit: "每天", days: [1, 2] });
	check("cycle: 中文单位每天（days 忽略归空）", d?.unit === "day" && d.days.length === 0, d);
	const m = parseChoreCycle({ unit: "month", days: "21, 1, 11" });
	check("cycle: 字符串 days 解析并排序去重", !!m && m.unit === "month" && m.days.join(",") === "1,11,21", m);
	const y = parseChoreCycle({ unit: "year", days: [3, 1] });
	check("cycle: year 二元组 [月, 日]", y?.unit === "year" && y.days[0] === 3 && y.days[1] === 1, y);
	check("cycle: 非对象 → undefined", parseChoreCycle("week") === undefined, undefined);
	check("cycle: week 空 days → undefined", parseChoreCycle({ unit: "week", days: [] }) === undefined, undefined);
	check("cycle: week 越界 → undefined", parseChoreCycle({ unit: "week", days: [7] }) === undefined, undefined);
	check("cycle: month 越界 → undefined", parseChoreCycle({ unit: "month", days: [0, 32] }) === undefined, undefined);
	check("cycle: year 缺日子 → undefined", parseChoreCycle({ unit: "year", days: [3] }) === undefined, undefined);
	check("cycle: 未知单位 → undefined", parseChoreCycle({ unit: "hour", days: [1] }) === undefined, undefined);
	check("overdue: postpone 直认", parseChoreOverdue("postpone") === "postpone", undefined);
	check("overdue: 中文往后延", parseChoreOverdue("往后延") === "postpone", undefined);
	check("overdue: 放弃/skip → undefined（缺省即放弃，不落盘）", parseChoreOverdue("放弃") === undefined && parseChoreOverdue("skip") === undefined, undefined);
	check("label: 每天", choreCycleLabel({ unit: "day", days: [] }) === "每天", undefined);
	check("label: 每周单日", choreCycleLabel({ unit: "week", days: [0] }) === "每周日", undefined);
	check("label: 每周多日", choreCycleLabel({ unit: "week", days: [4, 1] }) === "每周一、周四", undefined);
	check("label: 每月多号", choreCycleLabel({ unit: "month", days: [21, 1, 11] }) === "每月 1、11、21 号", undefined);
	check("label: 每年", choreCycleLabel({ unit: "year", days: [3, 1] }) === "每年 3 月 1 日", undefined);
	check("label: 顺延后缀", choreCycleLabel({ unit: "day", days: [] }, "postpone") === "每天 · 漏了往后延", undefined);
}

// --- ADR-0016: 该做日判定 / 相邻该做日 / 窗口枚举 --------------------------------------------
{
	const daily: GoalCycle = { unit: "day", days: [] };
	check("due: 每天恒真", isChoreDueOn(daily, "2026-11-11") && isChoreDueOn(daily, "2027-01-01"), undefined);
	const sunday: GoalCycle = { unit: "week", days: [0] };
	// 2026-11-15 = 周日、11-16 = 周一（已核对日历）
	check("due: 每周日——周日真周一假", isChoreDueOn(sunday, "2026-11-15") && !isChoreDueOn(sunday, "2026-11-16"), undefined);
	const monThu: GoalCycle = { unit: "week", days: [1, 4] };
	check("due: 每周一/四——两天真其余假", isChoreDueOn(monThu, "2026-11-09") && isChoreDueOn(monThu, "2026-11-12") && !isChoreDueOn(monThu, "2026-11-10"), undefined);
	const month31: GoalCycle = { unit: "month", days: [31] };
	check("due: 每月31号——大月真小月落月末", isChoreDueOn(month31, "2026-01-31") && !isChoreDueOn(month31, "2026-04-29") && isChoreDueOn(month31, "2026-04-30"), undefined);
	const year229: GoalCycle = { unit: "year", days: [2, 29] };
	check("due: 每年2/29——闰年真平年落2/28", isChoreDueOn(year229, "2024-02-29") && isChoreDueOn(year229, "2023-02-28") && !isChoreDueOn(year229, "2023-03-01"), undefined);
	check("prev: 周一往回找上周日", prevChoreOccurrence(sunday, "2026-11-16") === "2026-11-15", prevChoreOccurrence(sunday, "2026-11-16"));
	check("prev: 该做日当天返回当天", prevChoreOccurrence(sunday, "2026-11-15") === "2026-11-15", undefined);
	check("prev: 每月31号从4/10回退到3/31", prevChoreOccurrence(month31, "2026-04-10") === "2026-03-31", prevChoreOccurrence(month31, "2026-04-10"));
	check("prev: 年度从2/20回退到去年3/1", prevChoreOccurrence({ unit: "year", days: [3, 1] }, "2026-02-20") === "2025-03-01", undefined);
	check("next: 周日的下一个是下周日", nextChoreOccurrence(sunday, "2026-11-15") === "2026-11-22", undefined);
	check("next: 4/30（月末回落）的下一个是5/31", nextChoreOccurrence(month31, "2026-04-30") === "2026-05-31", nextChoreOccurrence(month31, "2026-04-30"));
	check("next: 年度3/2的下一个是明年3/1", nextChoreOccurrence({ unit: "year", days: [3, 1] }, "2026-03-02") === "2027-03-01", undefined);
	const occ = choreOccurrences(monThu, "2026-11-09", "2026-11-22");
	check("occ: 每周一/四两周枚举 4 次", occ.join(",") === "2026-11-09,2026-11-12,2026-11-16,2026-11-19", occ);
	check("occ: 起点=该做日含首不含尾后", choreOccurrences(sunday, "2026-11-15", "2026-11-15").join(",") === "2026-11-15", undefined);
	check("occ: 起点晚于终点 → 空", choreOccurrences(sunday, "2026-11-20", "2026-11-15").length === 0, undefined);
	check("occ: cap 截断", choreOccurrences(daily, "2026-01-01", "2026-12-31", 10).length === 10, undefined);
	check("occ: 每年窗口内至多一次", choreOccurrences({ unit: "year", days: [3, 1] }, "2026-01-01", "2026-12-31").join(",") === "2026-03-01", undefined);
}

// --- ADR-0016: 生活事项行惰性补写（精确匹配幂等） --------------------------------------------
{
	const content = [
		"---", "date: 2026-11-11", "---",
		"# 📅 2026-11-11 星期三", "",
		CHECK_HEADING,
		"- [ ] 🏠 日常生活 #计划/日常生活 🛫 2026-11-11 📅 2026-11-11",
		"- [x] 洗碗 #计划/日常生活 🛫 2026-11-11 📅 2026-11-11",
		"", "## 📝 今日总结", "",
	].join("\n");
	const out = missingChoreLines(content, [
		{ plan: "日常生活", name: "洗碗" },
		{ plan: "日常生活", name: "做卫生" },
	], "2026-11-11");
	check(
		"choreLines: 已存在（含已勾）不重建，缺失补一行",
		out.length === 1 && out[0] === "- [ ] 做卫生 #计划/日常生活 🛫 2026-11-11 📅 2026-11-11",
		out
	);
}
{
	// 精确匹配：近名不顶替、异计划不算数、带后缀的行不算数
	const content = [
		CHECK_HEADING,
		"- [ ] 洗碗机 #计划/日常生活 🛫 2026-11-11 📅 2026-11-11",
		"- [ ] 洗碗 #计划/家务 🛫 2026-11-11 📅 2026-11-11",
		"- [ ] 买菜（第 2 次） #计划/日常生活 🛫 2026-11-11 📅 2026-11-11",
	].join("\n");
	const out = missingChoreLines(content, [
		{ plan: "日常生活", name: "洗碗" },
		{ plan: "日常生活", name: "买菜" },
	], "2026-11-11");
	check("choreLines: 精确匹配——近名/异计划/带后缀都不顶替", out.length === 2, out);
}

// --- ADR-0019: 生活事项每日分次（三餐 = 每天 3 餐） --------------------------------------------

// 1. 分次判定与量记号口径
check("split: 每天 3 餐 → 3", splitTickCount(3, "餐") === 3);
check("split: 每天 2 餐 → 2", splitTickCount(2, "餐") === 2);
check("split: 连续量单位不拆（2 分钟）", splitTickCount(2, "分钟") === 0);
check("split: 1 次不拆", splitTickCount(1, "次") === 0);
check(
	"split: 生活事项行识别量记号恒 0（裸名）",
	modeLineAmount("chore", 3, "餐").floor === 0 && modeLineAmount("chore", 3, "餐").unit === "",
	modeLineAmount("chore", 3, "餐")
);
check(
	"split: 运动行识别沿用 floor/unit",
	modeLineAmount("exercise", 2, "次").floor === 2 && modeLineAmount("exercise", 2, "次").unit === "次"
);
check("split: 周期文案带次数（每天 3餐）", choreCycleLabel({ unit: "day", days: [] }, undefined, 3, "餐") === "每天 3餐", choreCycleLabel({ unit: "day", days: [] }, undefined, 3, "餐"));

// 2. 分次生活事项的解析 / 三层聚合（父行 > 事项行 > 次行）
const choreSplitMd = [
	"## ✅ 今日打卡",
	"- [ ] 🏠 日常生活 #计划/日常生活 🛫 2026-11-13 📅 2026-11-13",
	"- [ ] 三餐 #计划/日常生活 🛫 2026-11-13 📅 2026-11-13",
	"\t- [x] 三餐第1餐 #计划/日常生活 🛫 2026-11-13 📅 2026-11-13",
	"\t- [ ] 三餐第2餐 #计划/日常生活 🛫 2026-11-13 📅 2026-11-13",
	"\t- [ ] 三餐第3餐 #计划/日常生活 🛫 2026-11-13 📅 2026-11-13",
].join("\n");
const choreSplitGoals = [{ plan: "日常生活", name: "三餐", floor: 3, unit: "餐", mode: "chore" as const }];
const isChoreSplitModeLine = (it: CheckItem) =>
	!it.tick &&
	choreSplitGoals.some((g) => {
		const amt = modeLineAmount(g.mode, g.floor, g.unit);
		return g.plan === it.plan && matchesModeLine(it.text, g.name, amt.floor, amt.unit);
	});
const choreSplitParsed = parseDailyContent(dailyFile, choreSplitMd, "2026-11-13");
const choreSplitRows = topLevelCheckRows(choreSplitParsed.checkItems, isChoreSplitModeLine);
check("chore split: 大项仍 1（次行不落顶层）", choreSplitRows.length === 1, choreSplitRows.length);
check("chore split: 事项行挂在父行下", choreSplitRows[0].modeChildren.length === 1, choreSplitRows[0].modeChildren.length);
check("chore split: 2/3 餐 → 大项未完成", choreSplitRows[0].done === false, choreSplitRows[0].done);
const choreAllMd = choreSplitMd
	.replace("\t- [ ] 三餐第2餐", "\t- [x] 三餐第2餐")
	.replace("\t- [ ] 三餐第3餐", "\t- [x] 三餐第3餐");
const choreAllRows = topLevelCheckRows(parseDailyContent(dailyFile, choreAllMd, "2026-11-13").checkItems, isChoreSplitModeLine);
check("chore split: 3/3 餐 → 事项行完成 → 大项完成", choreAllRows[0].done === true, choreAllRows[0].done);

// 3. 生成：锚点行保持裸名，次行按 餐 单位补写
const choreTickSpec: ModeLineSpec = { plan: "日常生活", name: "三餐", label: "🏠", floor: 0, unit: "餐" };
const choreRecBase = [
	"## ✅ 今日打卡",
	"- [ ] 🏠 日常生活 #计划/日常生活 🛫 2026-11-13 📅 2026-11-13",
	"- [ ] 三餐 #计划/日常生活 🛫 2026-11-13 📅 2026-11-13",
].join("\n");
const choreRec1 = reconcileTickRows(choreRecBase, choreTickSpec, 3, "2026-11-13");
check("chore split 生成: 补出三条「第k餐」次行", choreRec1.split("\n").filter((l) => l.includes("三餐第")).length === 3, choreRec1);
check("chore split 生成: 事项行保持裸名（不嵌 3餐）", choreRec1.includes("- [ ] 三餐 #计划/日常生活"), choreRec1);
check("chore split 生成: 幂等", reconcileTickRows(choreRec1, choreTickSpec, 3, "2026-11-13") === choreRec1);

// 4. 镜像：次行全勾 ⇔ 事项行勾（双向，生活事项同样适用）
check("chore split mirror: 全未勾无动作", subItemMirrorTargets(choreRec1, [choreTickSpec]).length === 0);
const choreMir = subItemMirrorTargets(
	choreRec1.replace(/\[ \] 三餐第/g, "[x] 三餐第"),
	[choreTickSpec]
);
check("chore split mirror: 三条全勾 → 事项行待勾", choreMir.length === 1 && choreMir[0].checked === true, choreMir);
const choreMirBack = subItemMirrorTargets(
	choreRec1.replace("\t- [ ] 三餐第1餐", "\t- [x] 三餐第1餐").replace("- [ ] 三餐 #", "- [x] 三餐 #"),
	[choreTickSpec]
);
check("chore split mirror: 事项行勾着但次行未勾 → 待退", choreMirBack.length === 1 && choreMirBack[0].checked === false, choreMirBack);

// 5. splitTicksDone：k=1..n 全勾才算（锚点镜像未回写时的统计兜底）
check("chore split done: 2/3 不算", splitTicksDone(choreSplitParsed.checkItems, "日常生活", "三餐", "餐", 3) === false);
check(
	"chore split done: 3/3 算",
	splitTicksDone(parseDailyContent(dailyFile, choreAllMd, "2026-11-13").checkItems, "日常生活", "三餐", "餐", 3) === true
);
check("chore split done: 单位不匹配不算", splitTicksDone(choreAllRows ? parseDailyContent(dailyFile, choreAllMd, "2026-11-13").checkItems : [], "日常生活", "三餐", "次", 3) === false);

// 6. 改名联动：锚点与次行 base 同步改，勾选态/序号/单位/缩进原样保留
const choreRenamed = renameTickRowBase(choreRec1, "日常生活", "三餐", "正餐");
check("chore split 改名: 三条次行 base 全改", choreRenamed.split("\n").filter((l) => l.includes("正餐第")).length === 3, choreRenamed);
check("chore split 改名: 序号/单位/缩进保留", choreRenamed.includes("\t- [ ] 正餐第3餐 #计划/日常生活"), choreRenamed);
check("chore split 改名: 幂等（旧名不再出现）", !choreRenamed.includes("三餐第"), choreRenamed);
const choreRenamedChecked = renameTickRowBase(
	choreRec1.replace(/\[ \] 三餐第/g, "[x] 三餐第"),
	"日常生活",
	"三餐",
	"正餐"
);
check("chore split 改名: 已勾态保留", choreRenamedChecked.split("\n").filter((l) => l.includes("[x] 正餐第")).length === 3, choreRenamedChecked);
const otherPlanTicks = choreRec1
	.split("\n")
	.map((l) => (l.startsWith("\t") ? l.replace("#计划/日常生活", "#计划/别的") : l))
	.join("\n");
check("chore split 改名: 异计划次行不动", renameTickRowBase(otherPlanTicks, "日常生活", "三餐", "正餐").includes("三餐第1餐"));

// 7. 次行行号收集（删除/陈旧清理共用）
const choreTickIdx = choreTickLineIndices(choreRec1, "日常生活", "三餐");
check("chore split 行号: 收满三条次行", choreTickIdx.length === 3, choreTickIdx);
check("chore split 行号: 不含锚点行", !choreTickIdx.includes(2), choreTickIdx);
check("chore split 行号: 异名不收", choreTickLineIndices(choreRec1, "日常生活", "洗碗").length === 0);

// --- ADR-0016: scanChoreHit——挂账清账的文件事实回扫 --------------------------------------------
void (async () => {
	// 最小 app stub：vault.getAbstractFileByPath + cachedRead（文件须是 mock TFile 实例——实现里有 instanceof 守卫）
	const day = (name: string, lines: string[]): TFile => {
		const f = new TFile();
		f.path = `计划2026/每日/${name}.md`;
		contents.set(f.path, [CHECK_HEADING, ...lines].join("\n"));
		return f;
	};
	const contents = new Map<string, string>();
	const files = [
		day("2026-11-09", ["- [x] 洗碗 #计划/日常生活 🛫 2026-11-09 📅 2026-11-09"]),
		day("2026-11-10", ["- [ ] 洗碗 #计划/日常生活 🛫 2026-11-10 📅 2026-11-10"]),
		day("2026-11-11", ["- [x] 洗碗机 #计划/日常生活 🛫 2026-11-11 📅 2026-11-11", "- [ ] 洗碗 #计划/家务 🛫 2026-11-11 📅 2026-11-11"]),
		// ADR-0019: 锚点行未勾（镜像未回写）但三条次行全勾——文件事实仍算当日完成
		day("2026-11-12", [
			"- [ ] 三餐 #计划/日常生活 🛫 2026-11-12 📅 2026-11-12",
			"\t- [x] 三餐第1餐 #计划/日常生活 🛫 2026-11-12 📅 2026-11-12",
			"\t- [x] 三餐第2餐 #计划/日常生活 🛫 2026-11-12 📅 2026-11-12",
			"\t- [x] 三餐第3餐 #计划/日常生活 🛫 2026-11-12 📅 2026-11-12",
		]),
	];
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
			cachedRead: async (f: { path: string }) => contents.get(f.path) ?? "",
		},
	};
	const prefix = "计划2026/每日/";
	check(
		"scanHit: 命中已勾行（正向）",
		await scanChoreHit(app as never, prefix, "日常生活", "洗碗", "2026-11-09", "2026-11-09"),
		undefined
	);
	check(
		"scanHit: 未勾不算命中",
		!(await scanChoreHit(app as never, prefix, "日常生活", "洗碗", "2026-11-10", "2026-11-10")),
		undefined
	);
	check(
		"scanHit: 近名/异计划不顶替（洗碗机/家务行不算）",
		!(await scanChoreHit(app as never, prefix, "日常生活", "洗碗", "2026-11-11", "2026-11-11")),
		undefined
	);
	check(
		"scanHit: 窗口内任一天命中即真（11-09 已勾）",
		await scanChoreHit(app as never, prefix, "日常生活", "洗碗", "2026-11-09", "2026-11-10"),
		undefined
	);
	check(
		"scanHit: backward 从 to 端回扫命中（越过 11-10 未勾，命中 11-09）",
		await scanChoreHit(app as never, prefix, "日常生活", "洗碗", "2026-11-09", "2026-11-10", true),
		undefined
	);
	check(
		"scanHit split: 锚点未勾但次行全勾 → 命中（floor/unit 口径）",
		await scanChoreHit(app as never, prefix, "日常生活", "三餐", "2026-11-12", "2026-11-12", false, 3, "餐"),
		undefined
	);
	check(
		"scanHit split: 不给分次口径时只看锚点行（未勾 = 未命中）",
		!(await scanChoreHit(app as never, prefix, "日常生活", "三餐", "2026-11-12", "2026-11-12")),
		undefined
	);

	// --- v1.8 完成情况看板：computeBoardSections ---------------------------------
	{
		const files: TFile[] = [];
		const contents = new Map<string, string>();
		const mk = (path: string, text: string): TFile => {
			const f = new TFile();
			f.path = path;
			f.name = path.split("/").pop() ?? "";
			f.basename = f.name.replace(/\.[^.]+$/, "");
			files.push(f);
			contents.set(path, text);
			return f;
		};
		const boardApp = {
			vault: {
				getFiles: () => files,
				getAbstractFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
				cachedRead: async (f: { path: string }) => contents.get(f.path) ?? "",
			},
		};
		const annual = `---
start: 2026-11-09
end: 2026-11-20
plans:
  - name: 日常生活
    type: 打卡
    target: 家务
    goals:
      - name: 三餐
        mode: chore
        floor: 3
        unit: 餐
      - name: 洗碗
        mode: chore
        cycle:
          unit: week
          days: [1]
      - name: 拉伸
        mode: chore
  - name: 阅读
    type: 打卡
    target: 每天读书
  - name: 写作
    type: 数量
    target: 2 节
    goals:
      - name: 《书》
        count: 2
        unit: 节
        mode: reading
  - name: 空计划
    type: 数量
    target: 0
---
`;
		mk("root/计划2026/年度计划.md", annual);
		mk(
			"root/计划2026/任务.md",
			[
				"- [x] 《书》（第 1 章第 1 节） #计划/写作 🛫 2026-11-10 📅 2026-11-10",
				"- [ ] 《书》（第 1 章第 2 节） #计划/写作 🛫 2026-11-11 📅 2026-11-11",
			].join("\n")
		);
		const row = (text: string, plan: string, checked: boolean, date: string, indent = false): string =>
			`${indent ? "\t" : ""}- [${checked ? "x" : " "}] ${text} #计划/${plan} 🛫 ${date} 📅 ${date}`;
		const day = (date: string, lines: string[]): void => {
			mk(`root/计划2026/每日/${date}.md`, [CHECK_HEADING, ...lines].join("\n"));
		};
		day("2026-11-09", [
			// ADR-0019: 三餐锚点未勾但三条次行全勾 → 当日命中
			row("三餐", "日常生活", false, "2026-11-09"),
			row("三餐第1餐", "日常生活", true, "2026-11-09", true),
			row("三餐第2餐", "日常生活", true, "2026-11-09", true),
			row("三餐第3餐", "日常生活", true, "2026-11-09", true),
			row("拉伸", "日常生活", true, "2026-11-09"),
			row("洗碗", "日常生活", true, "2026-11-09"),
			row("阅读", "阅读", true, "2026-11-09"),
		]);
		day("2026-11-10", [
			// 只勾 2/3 次 → 三餐当日不算完成
			row("三餐", "日常生活", false, "2026-11-10"),
			row("三餐第1餐", "日常生活", true, "2026-11-10", true),
			row("三餐第2餐", "日常生活", true, "2026-11-10", true),
		]);
		day("2026-11-11", [
			row("三餐", "日常生活", true, "2026-11-11"),
			row("拉伸", "日常生活", true, "2026-11-11"),
			row("阅读", "阅读", true, "2026-11-11"),
		]);
		day("2026-11-12", [
			row("三餐", "日常生活", false, "2026-11-12"),
			row("三餐第1餐", "日常生活", true, "2026-11-12", true),
			row("三餐第2餐", "日常生活", true, "2026-11-12", true),
			row("三餐第3餐", "日常生活", true, "2026-11-12", true),
			row("拉伸", "日常生活", true, "2026-11-12"),
		]);
		day("2026-11-15", [
			row("三餐", "日常生活", true, "2026-11-15"),
			row("拉伸", "日常生活", false, "2026-11-15"),
			row("阅读", "阅读", true, "2026-11-15"),
		]);

		const board = await computeBoardSections(boardApp as never, "root", "2026-11-15", true, null);
		const sec = (name: string) => board.sections.find((s) => s.plan === name);
		const item = (plan: string, name: string) => sec(plan)?.items.find((i) => i.name === name);

		check(
			"board: 计划期间取年度 frontmatter 并截至今天",
			board.start === "2026-11-09" && board.scanEnd === "2026-11-15",
			{ start: board.start, scanEnd: board.scanEnd }
		);
		check("board: 无子项且无事实的计划区被隐藏", !sec("空计划"));

		const san = item("日常生活", "三餐");
		check("board: 三餐 命中 4/7 天（次行全勾算命中、2/3 不算）", san?.done === 4 && san?.total === 7, {
			done: san?.done,
			total: san?.total,
		});
		check(
			"board: 三餐日格 11-09 命中 / 11-10 未完成 / 11-13 未完成",
			san?.days?.find((d) => d.date === "2026-11-09")?.state === "hit" &&
				san?.days?.find((d) => d.date === "2026-11-10")?.state === "miss" &&
				san?.days?.find((d) => d.date === "2026-11-13")?.state === "miss"
		);
		const wan = item("日常生活", "洗碗");
		check("board: 每周一事项 命中 1/1 次、量词为次", wan?.done === 1 && wan?.total === 1 && wan?.unit === "次", {
			done: wan?.done,
			total: wan?.total,
			unit: wan?.unit,
		});
		check(
			"board: 每周一事项非该做日 = off（7 格里 6 个 off）",
			wan?.days?.filter((d) => d.state === "off").length === 6,
			wan?.days
		);
		check("board: 生活计划聚合率按应做量加权（8/15 = 53%）", sec("日常生活")?.percent === 53, sec("日常生活")?.percent);

		const read = sec("阅读");
		check(
			"board: 打卡型计划按天统计 3/7",
			read?.items[0]?.done === 3 && read?.items[0]?.total === 7 && read?.percent === 43,
			{ item: read?.items[0], percent: read?.percent }
		);

		const book = item("写作", "《书》");
		check(
			"board: 量化目标只有任务进度、无日格带",
			book?.done === 1 && book?.total === 2 && book?.unit === "节" && book?.days === undefined,
			{ done: book?.done, total: book?.total, unit: book?.unit, days: book?.days }
		);
		check("board: 量化计划区百分比沿用计划进度", sec("写作")?.percent === 50, sec("写作")?.percent);
	}

	console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
})();
