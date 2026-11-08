/**
 * Offline verification of M2 parsing logic:
 * - annual plan `plans` frontmatter parsing
 * - task pool line round-trip
 * - date-window filtering for week/month
 */
import { parsePlansFromFrontmatter, filterTasksInRange, summarizeTasks, computeQuotaDaily, quotaExpected } from "../src/stats";
import { parseTaskPool, buildPoolLine, autoWeekContext, autoQuota, autoTaskNumbers, planCounterUnit, isAutoTask, extractGoalName, groupPoolTasksByGoal, expandGoalStructure, expandGoalLeaves, chaptersToStructure, rescheduleChapterLine, suggestNextUnit, isRestartUnit, type GoalLevel } from "../src/tasks";
import { parseQuotaActual, parseQuotaAmount, buildQuotaCheckLine, missingQuotaLines, setQuotaActual, formatQuotaAmount, buildModeCheckLine, missingModeLines, markTaskLineManual, MANUAL_MARK, toggleTaskLine } from "../src/daily";
import { parseToc, parseTocLine, tocSummary } from "../src/toc";
import { parseReviewItems, buildBzgSnapshot, reviewedOn, distinctReviewedInRange, diaryDayWritten, utcToLocalDay } from "../src/bzg";
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

// 手动标记：勾选 + ✋，重复打标幂等
const toggled = toggleTaskLine(modeLine, 0, true);
const marked = markTaskLineManual(toggled, 0);
check("manual mark applied", marked.includes(MANUAL_MARK) && marked.startsWith("- [x]"), marked);
check("manual mark idempotent", markTaskLineManual(marked, 0) === marked, undefined);
check("manual actual parsed with ✋", parseQuotaActual(`🗣️ 文献复习 5篇（实 10篇）${MANUAL_MARK}`) === 10, undefined);
const rewritten = setQuotaActual(marked, 0, 10, "篇", true, undefined, true);
check("setQuotaActual keeps manual mark", rewritten.includes(MANUAL_MARK) && rewritten.includes("（实 10篇）"), rewritten);
const autoRewrite = setQuotaActual(marked, 0, 3, "篇", false, undefined, false);
check("auto rewrite strips manual mark", !autoRewrite.includes(MANUAL_MARK) && autoRewrite.startsWith("- [ ]"), autoRewrite);

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

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
