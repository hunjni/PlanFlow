// test/obsidian-mock.ts
var TFile = class {
  constructor(path) {
    var _a41;
    this.path = path != null ? path : "";
    this.name = (_a41 = this.path.split("/").pop()) != null ? _a41 : "";
  }
};
function parseYaml(src) {
  const lines = src.split("\n");
  let pos = 0;
  const indentOf = (l) => l.search(/\S/);
  const stripComment = (s) => {
    const t = s.trim();
    if (t.length >= 2 && (t.startsWith('"') && t.endsWith('"') || t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return s;
  };
  function parseNode(indent) {
    while (pos < lines.length) {
      const line = lines[pos];
      if (!line.trim() || line.trim().startsWith("#")) {
        pos++;
        continue;
      }
      break;
    }
    if (pos >= lines.length)
      return null;
    const first = lines[pos];
    if (indentOf(first) < indent)
      return null;
    if (first.trim().startsWith("- ")) {
      const arr = [];
      while (pos < lines.length) {
        const line = lines[pos];
        if (indentOf(line) < indent)
          break;
        if (!line.trim() || line.trim().startsWith("#")) {
          pos++;
          continue;
        }
        if (!line.trim().startsWith("- "))
          break;
        const content = stripComment(line.trim().slice(2).trim());
        const lineIndent = indentOf(line);
        if (content === "" || content.endsWith(":")) {
          pos++;
          arr.push(parseNode(lineIndent + 2));
        } else {
          const idx = content.indexOf(":");
          if (idx !== -1) {
            const obj2 = {};
            const key = content.slice(0, idx).trim();
            const val = content.slice(idx + 1).trim();
            obj2[key] = val === "" ? parseNode(lineIndent + 2) : val;
            pos++;
            while (pos < lines.length) {
              const nl = lines[pos];
              if (indentOf(nl) <= lineIndent)
                break;
              const nidx = nl.trim().indexOf(":");
              if (nidx === -1) {
                pos++;
                continue;
              }
              const nkey = nl.trim().slice(0, nidx).trim();
              const nval = stripComment(nl.trim().slice(nidx + 1).trim());
              if (nval === "") {
                pos++;
                obj2[nkey] = parseNode(indentOf(nl) + 2);
              } else {
                obj2[nkey] = nval;
                pos++;
              }
            }
            arr.push(obj2);
          } else {
            arr.push(content);
            pos++;
          }
        }
      }
      return arr;
    }
    const obj = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (indentOf(line) < indent)
        break;
      if (!line.trim() || line.trim().startsWith("#")) {
        pos++;
        continue;
      }
      const idx = line.trim().indexOf(":");
      if (idx === -1) {
        pos++;
        continue;
      }
      const key = line.trim().slice(0, idx).trim();
      const val = stripComment(line.trim().slice(idx + 1).trim());
      if (val === "") {
        pos++;
        obj[key] = parseNode(indentOf(line) + 2);
      } else {
        obj[key] = val;
        pos++;
      }
    }
    return obj;
  }
  return parseNode(0);
}

// src/daily.ts
var CHECK_HEADING = "## \u2705 \u4ECA\u65E5\u6253\u5361";
var TASK_LINE_RE = /^- \[([ x])\] (.+?)(?: #计划\/(\S+))?(?: 🛫 (\d{4}-\d{2}-\d{2}))?(?: 📅 (\d{4}-\d{2}-\d{2}))?$/;
function formatDate(d) {
  const y = d.getFullYear();
  const m2 = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m2}-${day}`;
}
function parseDateString(s) {
  const [y, m2, d] = s.split("-").map(Number);
  return new Date(y, m2 - 1, d);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function weekRange(dateStr) {
  const d = parseDateString(dateStr);
  const day = d.getDay() || 7;
  const start = addDays(d, 1 - day);
  return { start: formatDate(start), end: formatDate(addDays(start, 6)) };
}
function dayCount(start, end) {
  const s = parseDateString(start);
  const e = parseDateString(end);
  return Math.round((e.getTime() - s.getTime()) / 864e5) + 1;
}
function toggleTaskLine(content, lineIndex, checked, expectedRaw) {
  const lines = content.split("\n");
  let idx = lineIndex;
  if (expectedRaw && lines[idx] !== expectedRaw) {
    idx = lines.findIndex((l) => l === expectedRaw);
    if (idx === -1)
      return content;
  }
  const line = lines[idx];
  if (line === void 0 || !/^- \[[ x]\]/.test(line))
    return content;
  lines[idx] = line.replace(/^- \[[ x]\]/, checked ? "- [x]" : "- [ ]");
  return lines.join("\n");
}
var MANUAL_MARK = "\u270B";
var QUOTA_ACTUAL_RE = /（实\s*([\d.]+)\s*[^）]*）\s*(?:✋\s*)?$/;
function parseQuotaActual(text) {
  const m2 = QUOTA_ACTUAL_RE.exec(text);
  if (!m2)
    return null;
  const n = parseFloat(m2[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function parseQuotaAmount(text) {
  const stripped = text.replace(QUOTA_ACTUAL_RE, "");
  const matches = [...stripped.matchAll(/\d+(?:\.\d+)?/g)];
  if (matches.length === 0)
    return null;
  const n = parseFloat(matches[matches.length - 1][0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function formatQuotaAmount(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
function buildQuotaCheckLine({ label, plan, quota, unit, date }) {
  const name = label ? `${label} ${plan}` : plan;
  return `- [ ] ${name} ${formatQuotaAmount(quota)}${unit} #\u8BA1\u5212/${plan} \u{1F6EB} ${date} \u{1F4C5} ${date}`;
}
function setQuotaActual(content, lineIndex, actual, unit, checked, expectedRaw, manual = false) {
  const lines = content.split("\n");
  let idx = lineIndex;
  if (expectedRaw && lines[idx] !== expectedRaw) {
    idx = lines.findIndex((l) => l === expectedRaw);
    if (idx === -1)
      return content;
  }
  const line = lines[idx];
  if (line === void 0)
    return content;
  const m2 = TASK_LINE_RE.exec(line.trim());
  if (!m2)
    return content;
  const text = m2[2].trim().replace(/（实[^）]*）\s*(?:✋\s*)?$/, "").replace(MANUAL_MARK, "").trimEnd();
  const actualPart = actual > 0 ? `\uFF08\u5B9E ${formatQuotaAmount(actual)}${unit}\uFF09` : "";
  let rebuilt2 = `- [${checked ? "x" : " "}] ${text}${actualPart}${manual ? MANUAL_MARK : ""}`;
  if (m2[3])
    rebuilt2 += ` #\u8BA1\u5212/${m2[3]}`;
  if (m2[4])
    rebuilt2 += ` \u{1F6EB} ${m2[4]}`;
  if (m2[5])
    rebuilt2 += ` \u{1F4C5} ${m2[5]}`;
  lines[idx] = rebuilt2;
  return lines.join("\n");
}
function markTaskLineManual(content, lineIndex, expectedRaw) {
  const lines = content.split("\n");
  let idx = lineIndex;
  if (expectedRaw && lines[idx] !== expectedRaw) {
    idx = lines.findIndex((l) => l === expectedRaw);
    if (idx === -1)
      return content;
  }
  const line = lines[idx];
  if (line === void 0 || !/^- \[[ x]\]/.test(line))
    return content;
  if (line.includes(MANUAL_MARK))
    return content;
  const m2 = TASK_LINE_RE.exec(line.trim());
  if (!m2)
    return content;
  let rebuilt2 = `- [${m2[1]}] ${m2[2].trimEnd()}${MANUAL_MARK}`;
  if (m2[3])
    rebuilt2 += ` #\u8BA1\u5212/${m2[3]}`;
  if (m2[4])
    rebuilt2 += ` \u{1F6EB} ${m2[4]}`;
  if (m2[5])
    rebuilt2 += ` \u{1F4C5} ${m2[5]}`;
  lines[idx] = rebuilt2;
  return lines.join("\n");
}
function buildModeCheckLine({ plan, name, label, floor, unit }, date) {
  let content = label ? `${label} ${name}` : name;
  if (floor > 0)
    content += ` ${formatQuotaAmount(floor)}${unit}`;
  return `- [ ] ${content} #\u8BA1\u5212/${plan} \u{1F6EB} ${date} \u{1F4C5} ${date}`;
}
function matchesModeLine(text, name, floor, unit) {
  const stripped = text.trim().replace(/^[^\w\u4e00-\u9fff]+/, "").trim();
  if (floor > 0) {
    return stripped.startsWith(name) && stripped.includes(`${formatQuotaAmount(floor)}${unit || ""}`);
  }
  return stripped === name;
}
function missingModeLines(content, specs, date) {
  const existing = /* @__PURE__ */ new Set();
  const lines = content.split("\n");
  let inCheck = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inCheck = line.startsWith(CHECK_HEADING);
      continue;
    }
    if (!inCheck)
      continue;
    const m2 = TASK_LINE_RE.exec(line);
    if (m2 == null ? void 0 : m2[3])
      existing.add(`${m2[3]}|${m2[2].trim()}`);
  }
  const out = [];
  for (const s of specs) {
    let found = false;
    for (const key of existing) {
      const [plan, text] = key.split("|");
      if (plan === s.plan && text.includes(s.name)) {
        found = true;
        break;
      }
    }
    if (!found)
      out.push(buildModeCheckLine(s, date));
  }
  return out;
}
function missingQuotaLines(content, quotas, date) {
  const existing = /* @__PURE__ */ new Set();
  const lines = content.split("\n");
  let inCheck = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inCheck = line.startsWith(CHECK_HEADING);
      continue;
    }
    if (!inCheck)
      continue;
    const m2 = TASK_LINE_RE.exec(line);
    if (m2 == null ? void 0 : m2[3])
      existing.add(m2[3]);
  }
  const out = [];
  for (const q of quotas) {
    if (existing.has(q.plan))
      continue;
    out.push(buildQuotaCheckLine({ label: q.label, plan: q.plan, quota: q.quota, unit: q.unit, date }));
  }
  return out;
}

// src/tasks.ts
function parseTaskPool(file2, content) {
  var _a41, _b22, _c10;
  const tasks2 = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m2 = TASK_LINE_RE.exec(lines[i]);
    if (!m2)
      continue;
    tasks2.push({
      text: m2[2].trim(),
      plan: (_a41 = m2[3]) != null ? _a41 : null,
      checked: m2[1] === "x",
      start: (_b22 = m2[4]) != null ? _b22 : null,
      due: (_c10 = m2[5]) != null ? _c10 : null,
      line: i,
      raw: lines[i],
      file: file2
    });
  }
  return tasks2;
}
function buildPoolLine({ text, plan, start, due, checked }) {
  let line = `- [${checked ? "x" : " "}] ${text.trim()}`;
  if (plan && plan.trim())
    line += ` #\u8BA1\u5212/${plan.trim()}`;
  if (start)
    line += ` \u{1F6EB} ${start}`;
  if (due)
    line += ` \u{1F4C5} ${due}`;
  return line;
}
var DAY_MS = 864e5;
var AUTO_TASK_SUFFIX_RE = /（(?:第\s*)?[0-9一二三四五六七八九十百千][^）]*）$/;
function isAutoTask(task) {
  return AUTO_TASK_SUFFIX_RE.test(task.text.trim());
}
function extractGoalName(text) {
  const trimmed = text.trim();
  const m2 = AUTO_TASK_SUFFIX_RE.exec(trimmed);
  if (!m2)
    return null;
  const name = trimmed.slice(0, m2.index).trim();
  return name || null;
}
function groupPoolTasksByGoal(tasks2, today, knownNames) {
  const byName = /* @__PURE__ */ new Map();
  const ungrouped = [];
  const known = (knownNames != null ? knownNames : []).filter(Boolean);
  for (const t of tasks2) {
    const text = t.text.trim();
    const knownHit = known.find((n) => text.startsWith(`${n}\uFF08`));
    const name = knownHit != null ? knownHit : extractGoalName(text);
    if (!name) {
      ungrouped.push(t);
      continue;
    }
    const bucket = byName.get(name);
    if (bucket)
      bucket.push(t);
    else
      byName.set(name, [t]);
  }
  const coversToday = (t) => {
    var _a41, _b22;
    const s = (_a41 = t.start) != null ? _a41 : t.due;
    const d = (_b22 = t.due) != null ? _b22 : t.start;
    return !!s && !!d && s <= today && today <= d;
  };
  const groups = [];
  for (const [name, groupTasks] of byName) {
    const pending = groupTasks.filter((t) => {
      var _a41;
      if (t.checked)
        return false;
      const effStart = (_a41 = t.start) != null ? _a41 : t.due;
      return !!effStart && effStart <= today;
    });
    const todayDone = groupTasks.filter((t) => t.checked && coversToday(t));
    const scheduled2 = pending.length > 0 || groupTasks.some(coversToday);
    groups.push({ name, tasks: groupTasks, pending, todayDone, scheduled: scheduled2 });
  }
  return { groups, ungrouped };
}
var STRUCT_UNITS = [
  { word: "\u90E8", restart: false },
  { word: "\u7F16", restart: false },
  { word: "\u5377", restart: false },
  { word: "\u8F91", restart: false },
  { word: "\u7BC7", restart: false },
  { word: "\u5355\u5143", restart: false },
  { word: "\u6A21\u5757", restart: false },
  { word: "\u7AE0", restart: false },
  { word: "\u56DE", restart: false },
  { word: "\u8BFE", restart: false },
  { word: "\u8BB2", restart: false },
  { word: "\u96C6", restart: false },
  { word: "\u5E55", restart: false },
  { word: "\u573A", restart: true },
  { word: "\u8282", restart: true },
  { word: "\u5C0F\u8282", restart: true },
  { word: "\u76EE", restart: true },
  { word: "\u6761", restart: true }
];
var RESTART_UNITS = new Set(STRUCT_UNITS.filter((u) => u.restart).map((u) => u.word));
var UNIT_SUCCESSORS = {
  \u90E8: ["\u5377", "\u7BC7"],
  \u7F16: ["\u7AE0", "\u7BC7"],
  \u5377: ["\u7BC7", "\u7AE0"],
  \u8F91: ["\u7BC7", "\u7AE0"],
  \u7BC7: ["\u7AE0", "\u5355\u5143"],
  \u5355\u5143: ["\u8BFE", "\u8BB2"],
  \u6A21\u5757: ["\u5355\u5143", "\u8BFE"],
  \u7AE0: ["\u8282", "\u8BB2"],
  \u56DE: ["\u8282"],
  \u8BFE: ["\u8282", "\u8BB2"],
  \u8BB2: ["\u8282"],
  \u96C6: ["\u8BB2", "\u8282"],
  \u5E55: ["\u573A"],
  \u573A: ["\u8282"],
  \u8282: ["\u5C0F\u8282", "\u76EE"],
  \u5C0F\u8282: ["\u76EE"],
  \u76EE: ["\u6761"],
  \u6761: []
};
function suggestNextUnit(prevUnit) {
  var _a41;
  const list = UNIT_SUCCESSORS[prevUnit.trim()];
  return (_a41 = list == null ? void 0 : list[0]) != null ? _a41 : "\u8282";
}
function isRestartUnit(word) {
  return RESTART_UNITS.has(word.trim());
}
function expandGoalStructure(goalName, levels) {
  var _a41, _b22, _c10;
  const clean = (v) => {
    const n = typeof v === "number" ? Math.floor(v) : parseInt(String(v), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > 8)
    return [];
  const labelAt = (li, g) => {
    var _a42, _b23, _c11;
    return String((_c11 = (_b23 = (_a42 = levels[li]) == null ? void 0 : _a42.labels) == null ? void 0 : _b23[g - 1]) != null ? _c11 : "").trim();
  };
  let level = [];
  let roots = [];
  for (let li = 0; li < levels.length; li++) {
    const unit = String((_b22 = (_a41 = levels[li]) == null ? void 0 : _a41.unit) != null ? _b22 : "").trim();
    if (!unit)
      return [];
    const restart = RESTART_UNITS.has(unit);
    const next = [];
    let g = 0;
    if (li === 0) {
      const n = clean((_c10 = levels[0].counts) == null ? void 0 : _c10[0]);
      if (n <= 0)
        return [];
      for (let i = 1; i <= n; i++) {
        g++;
        next.push({
          node: { label: labelAt(0, g) || `\u7B2C ${i} ${unit}`, unit, restart, parentLabel: null, parentRestart: false, global: g },
          children: [],
          parent: null
        });
      }
    } else {
      const counts = levels[li].counts;
      if (!Array.isArray(counts) || counts.length < level.length)
        return [];
      for (let pi = 0; pi < level.length; pi++) {
        const parent = level[pi].node;
        const n = clean(counts[pi]);
        for (let c = 1; c <= n; c++) {
          g++;
          const num = restart ? c : g;
          next.push({
            node: {
              label: labelAt(li, g) || `\u7B2C ${num} ${unit}`,
              unit,
              restart,
              parentLabel: parent.label,
              parentRestart: parent.restart,
              global: g
            },
            children: [],
            parent: level[pi]
          });
          level[pi].children.push(next[next.length - 1]);
        }
      }
    }
    if (li === 0)
      roots = next;
    level = next;
  }
  const leaves = [];
  const lastIdx = levels.length - 1;
  const rollupIdx = levels.length - 2;
  const pathSuffix = (w) => {
    if (!w.node.restart)
      return w.node.label;
    const parts = [w.node.label];
    let cur = w.parent;
    while (cur) {
      parts.unshift(cur.node.label);
      if (!cur.node.restart)
        break;
      cur = cur.parent;
    }
    return parts.join("");
  };
  const visit = (w, depth, rollup) => {
    const rollupAncestor = depth === rollupIdx ? w : rollup;
    if (depth === lastIdx || w.children.length === 0) {
      const realLabel = labelAt(depth, w.node.global);
      let suffix;
      if (realLabel) {
        if (!w.node.restart) {
          suffix = realLabel;
        } else {
          const roll = rollupAncestor && rollupAncestor !== w ? pathSuffix(rollupAncestor) : "";
          suffix = roll ? `${roll}\xB7${realLabel}` : realLabel;
        }
      } else {
        suffix = pathSuffix(w);
      }
      leaves.push({
        name: `${goalName}\uFF08${suffix}\uFF09`,
        index: leaves.length + 1,
        group: rollupAncestor ? pathSuffix(rollupAncestor) : depth !== lastIdx ? pathSuffix(w) : ""
      });
      return;
    }
    for (const child of w.children)
      visit(child, depth + 1, rollupAncestor);
  };
  for (const root of roots)
    visit(root, 0, null);
  return leaves;
}
function chaptersToStructure(chapters) {
  return [
    { unit: "\u7AE0", counts: [chapters.length] },
    { unit: "\u8282", counts: chapters.map((c) => Math.max(0, Math.floor(c))) }
  ];
}
function expandGoalLeaves(goalName, goal) {
  var _a41, _b22;
  if ((_a41 = goal.structure) == null ? void 0 : _a41.length)
    return expandGoalStructure(goalName, goal.structure);
  if ((_b22 = goal.chapters) == null ? void 0 : _b22.length)
    return expandGoalStructure(goalName, chaptersToStructure(goal.chapters));
  return null;
}
function rescheduleChapterLine(line, ctx) {
  const m2 = TASK_LINE_RE.exec(line);
  if (!m2)
    return line;
  const text = m2[2].trim();
  if (m2[3] !== ctx.plan || !text.startsWith(ctx.prefix))
    return line;
  if (!ctx.valid.has(text))
    return null;
  if (m2[1] === "x")
    return line;
  const idx = ctx.leafIndexByName.get(text);
  if (idx === void 0)
    return line;
  const totalDays = Math.max(1, dayCount(ctx.start, ctx.end));
  const ns = addDaysStr(ctx.start, Math.floor((idx - 1) * totalDays / ctx.total));
  const nd = idx < ctx.total ? addDaysStr(ctx.start, Math.floor(idx * totalDays / ctx.total) - 1) : ctx.end;
  const due = nd < ns ? ns : nd;
  if (ns === m2[4] && due === m2[5])
    return line;
  return `- [${m2[1]}] ${text} #\u8BA1\u5212/${m2[3]} \u{1F6EB} ${ns} \u{1F4C5} ${due}`;
}
function planCounterUnit(target) {
  const m2 = /(\d+)\s*(篇|本|条|个|部|期|集|次|份|张|幅|门|天|章|节)/.exec(target);
  return m2 ? m2[2] : "\u7BC7";
}
function autoWeekContext(planStart, planEnd, today) {
  if (today < planStart || today > planEnd)
    return null;
  const startMon = weekRange(planStart).start;
  const endMon = weekRange(planEnd).start;
  const thisMon = weekRange(today).start;
  if (thisMon < startMon || thisMon > endMon)
    return null;
  const totalWeeks = Math.round((parseDateString(endMon).getTime() - parseDateString(startMon).getTime()) / (DAY_MS * 7)) + 1;
  const rawIndex = Math.round((parseDateString(thisMon).getTime() - parseDateString(startMon).getTime()) / (DAY_MS * 7)) + 1;
  const weekIndex = Math.max(1, Math.min(rawIndex, Math.max(totalWeeks, 1)));
  return { weekIndex, totalWeeks, weekStart: thisMon, weekEnd: weekRange(today).end };
}
function autoQuota(targetCount, weekIndex, totalWeeks) {
  if (targetCount <= 0 || totalWeeks <= 0)
    return 0;
  return Math.ceil(targetCount * weekIndex / totalWeeks);
}
function autoTaskNumbers(existingAuto, need, targetCount, label, unit, skipNames) {
  let maxN = 0;
  for (const t of existingAuto) {
    const m2 = /（第\s*(\d+)[^）]*）$/.exec(t.text.trim());
    if (m2)
      maxN = Math.max(maxN, parseInt(m2[1], 10));
  }
  const nums = [];
  let n = maxN + 1;
  while (nums.length < need && n <= targetCount) {
    const name = `${label}\uFF08\u7B2C ${n} ${unit}\uFF09`;
    if (!existingAuto.some((t) => t.text.trim() === name) && !(skipNames == null ? void 0 : skipNames.has(name)))
      nums.push(n);
    n++;
  }
  return nums;
}
function addDaysStr(date, n) {
  const d = new Date(parseDateString(date).getTime() + n * DAY_MS);
  const y = d.getFullYear();
  const m2 = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m2}-${dd}`;
}

// src/bzg.ts
function utcToLocalDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "";
  const y = d.getFullYear();
  const m2 = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m2}-${day}`;
}
function parseReviewItems(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(data))
    return [];
  const out = [];
  for (const el of data) {
    if (!el || typeof el !== "object")
      continue;
    const rec = el;
    const filePath = typeof rec.filePath === "string" ? rec.filePath : "";
    if (!filePath)
      continue;
    const history = Array.isArray(rec.reviewHistory) ? rec.reviewHistory : [];
    const timestamps = [];
    for (const h of history) {
      const ts2 = h && typeof h === "object" && typeof h.timestamp === "string" ? h.timestamp : "";
      if (ts2)
        timestamps.push(ts2);
    }
    if (timestamps.length === 0 && typeof rec.lastReviewed === "string") {
      timestamps.push(rec.lastReviewed);
    }
    out.push({ filePath, timestamps });
  }
  return out;
}
function buildBzgSnapshot(items2, cfg) {
  const byDay = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  for (const item of items2) {
    let days = byPath.get(item.filePath);
    if (!days) {
      days = /* @__PURE__ */ new Set();
      byPath.set(item.filePath, days);
    }
    for (const ts2 of item.timestamps) {
      const day = utcToLocalDay(ts2);
      if (!day)
        continue;
      days.add(day);
      let set = byDay.get(day);
      if (!set) {
        set = /* @__PURE__ */ new Set();
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
    byPath
  };
}
function reviewedOn(snap2, localDay) {
  var _a41, _b22;
  return (_b22 = (_a41 = snap2.byDay.get(localDay)) == null ? void 0 : _a41.size) != null ? _b22 : 0;
}
function distinctReviewedInRange(snap2, start, end) {
  let count = 0;
  for (const days of snap2.byPath.values()) {
    for (const d of days) {
      if (d >= start && d <= end) {
        count++;
        break;
      }
    }
  }
  return count;
}
var DIARY_WRITE_SECTIONS = /* @__PURE__ */ new Set(["\u968F\u7B14", "\u5F53\u65E5\u89E6\u52A8\u70B9"]);
function diaryDayWritten(content) {
  if (!content)
    return false;
  const lines = content.split("\n");
  let current = "";
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#+)\s+(.*)$/.exec(line);
    if (heading) {
      current = heading[1].length === 1 ? heading[2].trim() : "";
      continue;
    }
    if (line.trim() === "")
      continue;
    if (DIARY_WRITE_SECTIONS.has(current) && line.trim().length > 0)
      return true;
  }
  return false;
}

// src/stats.ts
function computeQuotaDaily(total, start, end) {
  const days = dayCount(start, end);
  if (days <= 0)
    return total;
  return Math.round(total / days * 10) / 10;
}
function quotaExpected(dailyQuota, start, end, today) {
  if (today < start)
    return 0;
  const until = today > end ? end : today;
  return Math.round(dailyQuota * dayCount(start, until) * 10) / 10;
}
function filterTasksInRange(tasks2, start, end) {
  return tasks2.filter((t) => {
    var _a41, _b22;
    const s = (_a41 = t.start) != null ? _a41 : t.due;
    const e = (_b22 = t.due) != null ? _b22 : t.start;
    if (!s || !e)
      return false;
    return s <= end && e >= start;
  });
}
function summarizeTasks(tasks2) {
  const total = tasks2.length;
  const done = tasks2.filter((t) => t.checked).length;
  return { total, done, percent: total === 0 ? 0 : Math.round(done / total * 100) };
}
function parsePlansFromFrontmatter(content) {
  var _a41, _b22, _c10;
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!fmMatch)
    return [];
  let data;
  try {
    const parsed = parseYaml(fmMatch[1]);
    data = parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    return [];
  }
  const raw = data == null ? void 0 : data.plans;
  if (raw === void 0 || raw === null)
    return [];
  const defs = [];
  const push = (name, obj) => {
    var _a42;
    const trimmed = name.trim();
    if (!trimmed)
      return;
    const target = readPlanTarget(obj);
    const goals = readPlanGoals(obj);
    const quota = readPlanQuota(obj);
    let type = "check";
    let targetCount = 0;
    if (quota) {
      type = "quota";
    } else if (goals.length > 0) {
      type = "numeric";
      targetCount = goals.reduce((acc, g) => acc + g.count, 0);
    } else {
      type = readPlanType(obj, target);
      const m2 = (_a42 = /(\d+)\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门|章|节)/.exec(target)) != null ? _a42 : /(?<![0-9/%])(\d+)(?![0-9/%])/.exec(target);
      targetCount = type === "numeric" && m2 ? parseInt(m2[1], 10) : 0;
    }
    defs.push({
      name: trimmed,
      type,
      target,
      targetCount,
      goals,
      quota,
      action: readPlanString(obj, ["action", "\u52A8\u4F5C", "\u65F6\u957F", "duration"]),
      label: readPlanString(obj, ["label", "icon", "\u56FE\u6807", "emoji"]),
      color: readPlanString(obj, ["color", "colour", "\u989C\u8272"]),
      tradingDay: !!(obj == null ? void 0 : obj.tradingDay) || !!(obj == null ? void 0 : obj.tradingday) || !!(obj == null ? void 0 : obj["\u4EA4\u6613\u65E5"]),
      // v2.7: 每日打卡计划标志（daily: false 显式排除；缺省视为每日打卡）
      daily: (obj == null ? void 0 : obj.daily) !== false
    });
  };
  if (Array.isArray(raw)) {
    for (const el of raw) {
      if (typeof el === "string") {
        const s = el.trim();
        const idx = s.indexOf(":");
        if (idx !== -1)
          push(s.slice(0, idx), { target: s.slice(idx + 1).trim() });
        else {
          const m2 = /^(\S+)\s+(.+)$/.exec(s);
          if (m2)
            push(m2[1], { target: m2[2] });
          else
            push(s, void 0);
        }
      } else if (el && typeof el === "object") {
        const obj = el;
        const name = (_c10 = (_b22 = (_a41 = obj.name) != null ? _a41 : obj.plan) != null ? _b22 : obj["\u540D\u79F0"]) != null ? _c10 : obj["\u8BA1\u5212"];
        if (typeof name === "string") {
          push(name, obj);
        } else {
          const key = Object.keys(obj)[0];
          if (key) {
            const val = obj[key];
            push(
              key,
              val && typeof val === "object" ? val : { target: typeof val === "string" ? val : "" }
            );
          }
        }
      }
    }
  } else if (typeof raw === "object") {
    for (const key of Object.keys(raw)) {
      const val = raw[key];
      if (val && typeof val === "object")
        push(key, val);
      else if (typeof val === "string")
        push(key, { target: val });
      else
        push(key, void 0);
    }
  }
  return defs;
}
function readPlanTarget(obj) {
  if (!obj)
    return "";
  for (const k of ["target", "description", "desc", "\u76EE\u6807", "\u63CF\u8FF0", "goal", "\u503C"]) {
    if (typeof obj[k] === "string")
      return obj[k];
  }
  return "";
}
function readPlanString(obj, keys) {
  if (!obj)
    return "";
  for (const k of keys) {
    if (typeof obj[k] === "string")
      return obj[k];
  }
  return "";
}
function readPlanGoals(obj) {
  var _a41, _b22, _c10, _d4;
  if (!obj || !Array.isArray(obj.goals))
    return [];
  const out = [];
  for (const g of obj.goals) {
    if (typeof g === "string") {
      const m2 = /^(.+?)\s+(\d+)\s*(篇|本|条|个|部|期|集|次|份|张|幅|门|天|章|节)?(?:\s+(\d{4}-\d{2}-\d{2})~\s*(\d{4}-\d{2}-\d{2}))?$/.exec(g.trim());
      if (m2) {
        out.push({ name: m2[1].trim(), count: parseInt(m2[2], 10), unit: (_a41 = m2[3]) != null ? _a41 : "\u4E2A", start: m2[4], end: m2[5] });
      }
      continue;
    }
    if (!g || typeof g !== "object")
      continue;
    const rec = g;
    const name = readPlanString(rec, ["name", "\u540D\u79F0", "goal", "\u4EFB\u52A1"]);
    if (!name)
      continue;
    const mode = parseGoalMode(readPlanString(rec, ["mode", "\u6A21\u5F0F"]));
    const count = typeof rec.count === "number" ? rec.count : typeof rec["\u6570\u91CF"] === "number" ? rec["\u6570\u91CF"] : (() => {
      var _a42;
      const cv = (_a42 = rec.count) != null ? _a42 : rec["\u6570\u91CF"];
      return parseInt(cv == null ? "0" : typeof cv === "string" || typeof cv === "number" ? String(cv) : "0", 10);
    })();
    if (!mode && (!count || Number.isNaN(count) || count <= 0))
      continue;
    const unit = readPlanString(rec, ["unit", "\u5355\u4F4D", "\u91CF\u8BCD"]) || (mode ? "" : "\u4E2A");
    const start = readPlanString(rec, ["start", "\u5F00\u59CB", "\u8D77"]);
    const end = readPlanString(rec, ["end", "\u7ED3\u675F", "\u6B62"]);
    const rawChapters = rec.chapters;
    const toInt = (v) => typeof v === "number" ? v : parseInt(String(v).trim(), 10);
    const validChapters = (arr) => arr.map(toInt).filter((c) => Number.isFinite(c) && c > 0);
    let chapters;
    if (Array.isArray(rawChapters)) {
      chapters = validChapters(rawChapters);
    } else if (typeof rawChapters === "string" && rawChapters.trim()) {
      chapters = validChapters(rawChapters.replace(/[[\]]/g, "").split(/[,，\s]+/));
    }
    const goal = { name: name.trim(), count, unit, start: start || void 0, end: end || void 0 };
    if (mode) {
      goal.mode = mode;
      const rawFloor = (_c10 = (_b22 = rec.floor) != null ? _b22 : rec["\u4E0B\u9650"]) != null ? _c10 : rec["\u6BCF\u65E5"];
      const floorVal = typeof rawFloor === "number" ? rawFloor : parseFloat(String(rawFloor != null ? rawFloor : ""));
      if (Number.isFinite(floorVal) && floorVal > 0)
        goal.floor = floorVal;
      else if (mode === "review")
        goal.floor = 1;
    }
    if (chapters && chapters.length > 0)
      goal.chapters = chapters;
    const readerSid = readPlanString(rec, ["readerSid", "\u9605\u8BFB\u5668\u4E66"]);
    if (readerSid)
      goal.readerSid = readerSid;
    const rawAnchors = rec.readerAnchors;
    if (Array.isArray(rawAnchors)) {
      const anchors = rawAnchors.map((a) => {
        const s = typeof a === "string" ? a : String(a != null ? a : "");
        const sep = s.indexOf("|");
        if (sep === -1)
          return null;
        const spine = parseInt(s.slice(0, sep), 10);
        if (!Number.isFinite(spine) || spine < 0)
          return null;
        return { spine, href: s.slice(sep + 1) };
      }).filter((a) => !!a);
      if (anchors.length > 0)
        goal.readerAnchors = anchors;
    }
    const rawStructure = rec.structure;
    if (Array.isArray(rawStructure)) {
      const levels = [];
      for (const lv of rawStructure.slice(0, 8)) {
        if (!lv || typeof lv !== "object")
          continue;
        const obj2 = lv;
        const unit2 = readPlanString(obj2, ["unit", "\u5355\u4F4D"]);
        const rawCounts = (_d4 = obj2.counts) != null ? _d4 : obj2["\u6570\u76EE"];
        if (!unit2 || (rawCounts === void 0 || rawCounts === null))
          continue;
        const list = (Array.isArray(rawCounts) ? rawCounts : String(rawCounts).replace(/[[\]]/g, "").split(/[,，\s]+/)).map(toInt).filter((c) => Number.isFinite(c) && c >= 0);
        if (list.length > 0) {
          const level = { unit: unit2, counts: list };
          const rawLabels = obj2.labels;
          if (Array.isArray(rawLabels) && rawLabels.length > 0) {
            level.labels = rawLabels.map((s) => typeof s === "string" ? s : String(s != null ? s : ""));
          }
          levels.push(level);
        }
      }
      if (levels.length > 0)
        goal.structure = levels;
    }
    out.push(goal);
  }
  return out;
}
function readPlanQuota(obj) {
  var _a41, _b22, _c10, _d4, _e3;
  if (!obj)
    return null;
  const raw = (_b22 = (_a41 = obj.quota) != null ? _a41 : obj["\u5B9A\u989D"]) != null ? _b22 : obj["\u65E5\u5B9A\u989D"];
  let rec = null;
  if (raw && typeof raw === "object") {
    rec = raw;
  } else if (typeof raw === "string") {
    const m2 = /^([\d.]+)\s*([^0-9~]*)(?:\s+(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2}))?$/.exec(raw.trim());
    if (m2) {
      rec = { total: parseFloat(m2[1]), unit: m2[2].trim(), start: m2[3], end: m2[4] };
    }
  }
  if (!rec)
    return null;
  const totalRaw = (_d4 = (_c10 = rec.total) != null ? _c10 : rec["\u603B\u91CF"]) != null ? _d4 : rec["\u6570\u91CF"];
  const total = typeof totalRaw === "number" ? totalRaw : parseFloat(String(totalRaw != null ? totalRaw : ""));
  if (!Number.isFinite(total) || total <= 0)
    return null;
  const unitRaw = (_e3 = rec.unit) != null ? _e3 : rec["\u5355\u4F4D"];
  const unit = typeof unitRaw === "string" ? unitRaw.trim() : "";
  const start = [rec.start, rec["\u5F00\u59CB"], rec["\u8D77"]].find((v) => typeof v === "string" && !!v.trim());
  const end = [rec.end, rec["\u7ED3\u675F"], rec["\u6B62"], rec["\u622A\u6B62"]].find((v) => typeof v === "string" && !!v.trim());
  if (!end)
    return null;
  return { total, unit, start: (start == null ? void 0 : start.trim()) || void 0, end: end.trim() };
}
function parseGoalMode(raw) {
  const v = raw.trim().toLowerCase();
  if (!v)
    return void 0;
  if (/^(reading|阅读(书籍)?|book)$/.test(v))
    return "reading";
  if (/^(review|复习)$/.test(v))
    return "review";
  if (/^(diary|日记)$/.test(v))
    return "diary";
  if (/^(exercise|运动|锻炼)$/.test(v))
    return "exercise";
  return void 0;
}
function readPlanType(obj, target) {
  let t = "";
  if (obj) {
    for (const k of ["type", "kind", "\u7C7B\u578B", "\u6A21\u5F0F"]) {
      if (typeof obj[k] === "string") {
        t = obj[k];
        break;
      }
    }
  }
  if (t) {
    if (/数量|量化|count|numeric|project|任务|篇|个|次/.test(t))
      return "numeric";
    if (/打卡|习惯|habit|check|daily|复盘/.test(t))
      return "check";
  }
  if (/\d+\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门)/.test(target))
    return "numeric";
  return "check";
}

// src/toc.ts
var DEFAULT_UNIT_CHAIN = ["\u7AE0", "\u8282", "\u5C0F\u8282", "\u76EE", "\u6761", "\u7EC6\u76EE"];
var UNIT_ORDER = STRUCT_UNITS.map((u) => u.word);
var CN_UNIT_RE = /^第\s*[0-9一二三四五六七八九十百千]+\s*(部|编|卷|辑|篇|单元|模块|章|回|课|讲|集|幕|场|节|小节|目|条)/;
function extractTocUnitWord(label) {
  const m2 = CN_UNIT_RE.exec(label.trim());
  return m2 ? m2[1] : "";
}
var CN_ORD_RE = /^[一二三四五六七八九十百]+[、.．]/;
var MAX_TOC_LEVELS = 8;
var MAX_TOC_LINES = 500;
function parseTocLine(rawLine) {
  var _a41;
  let line = rawLine.trim();
  line = line.replace(/^[-*•·]\s*(?:\[[ x]\]\s*)?/, "");
  if (!line)
    return null;
  line = line.replace(/[.·…\s]{1,}\d{1,4}$/, "").trim();
  if (!line)
    return null;
  if (/^(目录|目錄|contents|table of contents)$/i.test(line))
    return null;
  const cn = CN_UNIT_RE.exec(line);
  if (cn) {
    return { title: line, level: UNIT_ORDER.indexOf(cn[1]), family: "U", unit: cn[1] };
  }
  const num = /^(\d+)(?:[.、](\d+))?(?:\.(\d+))?/.exec(line);
  if (num) {
    const depth = num[3] ? 2 : num[2] ? 1 : 0;
    return { title: line, level: depth, family: "N", unit: (_a41 = DEFAULT_UNIT_CHAIN[depth]) != null ? _a41 : `\u7EA7${depth + 1}` };
  }
  if (CN_ORD_RE.test(line)) {
    return { title: line, level: 0, family: "N", unit: DEFAULT_UNIT_CHAIN[0] };
  }
  const indentChunk = rawLine.match(/^[\t ]*/)[0];
  let indent = 0;
  for (const ch of indentChunk)
    indent += ch === "	" ? 1 : 0.5;
  if (indent >= 1)
    return { title: line, level: Math.floor(indent), family: "I", unit: "" };
  return { title: line, level: 0, family: "N", unit: DEFAULT_UNIT_CHAIN[0] };
}
function parseToc(text) {
  var _a41, _b22, _c10;
  const items2 = [];
  let skipped = 0;
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim())
      continue;
    const item = parseTocLine(l);
    if (!item) {
      skipped++;
      continue;
    }
    items2.push(item);
    if (items2.length >= MAX_TOC_LINES)
      break;
  }
  if (items2.length === 0)
    return null;
  const virtualRoot = { depth: -1, unit: "", children: [] };
  const stack = [];
  for (const item of items2) {
    let anchorIdx = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].family === item.family && stack[i].level <= item.level) {
        anchorIdx = i;
        break;
      }
    }
    let parent = null;
    if (anchorIdx >= 0) {
      if (stack[anchorIdx].level < item.level) {
        stack.length = anchorIdx + 1;
        parent = stack[anchorIdx].node;
      } else {
        stack.length = anchorIdx;
        parent = anchorIdx > 0 ? stack[anchorIdx - 1].node : null;
      }
    } else {
      stack.length = stack.length;
      parent = stack.length > 0 ? stack[stack.length - 1].node : null;
    }
    const depth = parent ? parent.depth + 1 : 0;
    if (depth >= MAX_TOC_LEVELS) {
      const leafParent = (_b22 = (_a41 = stack[stack.length - 1]) == null ? void 0 : _a41.node) != null ? _b22 : virtualRoot;
      leafParent.children.push({ depth: leafParent.depth + 1, unit: item.unit, children: [] });
      continue;
    }
    const node = { depth, unit: item.unit, children: [] };
    (parent != null ? parent : virtualRoot).children.push(node);
    stack.push({ family: item.family, level: item.level, node });
  }
  if (virtualRoot.children.length === 0)
    return null;
  let maxDepth = 0;
  const freq = [];
  {
    const walk = (nodes) => {
      var _a42;
      for (const n of nodes) {
        while (freq.length <= n.depth)
          freq.push(/* @__PURE__ */ new Map());
        if (n.unit)
          freq[n.depth].set(n.unit, ((_a42 = freq[n.depth].get(n.unit)) != null ? _a42 : 0) + 1);
        maxDepth = Math.max(maxDepth, n.depth + 1);
        walk(n.children);
      }
    };
    walk(virtualRoot.children);
  }
  const units = [];
  for (let i = 0; i < maxDepth; i++) {
    let best = "";
    let bestN = 0;
    for (const [w, n] of (_c10 = freq[i]) != null ? _c10 : []) {
      if (n > bestN) {
        best = w;
        bestN = n;
      }
    }
    units.push(best || DEFAULT_UNIT_CHAIN[i] || `\u7EA7${i + 1}`);
  }
  const levels = units.map((unit) => ({ unit, counts: [] }));
  levels[0].counts = [virtualRoot.children.length];
  {
    let current = virtualRoot.children;
    for (let lv = 1; lv < levels.length; lv++) {
      levels[lv].counts = current.map((n) => n.children.length);
      current = current.flatMap((n) => n.children);
    }
  }
  const leaves = expandGoalStructure("\u4E66", levels);
  if (!leaves || leaves.length === 0)
    return null;
  return { levels, lineCount: items2.length, skipped, units };
}
function tocSummary(result) {
  const parts = result.levels.map((lv) => `${lv.unit} \xD7${lv.counts.reduce((a, b) => a + b, 0)}`);
  return `\u8BC6\u522B ${result.lineCount} \u884C${result.skipped ? `\uFF08\u8DF3\u8FC7 ${result.skipped} \u884C\uFF09` : ""} \xB7 ${parts.join(" \u2192 ")}`;
}

// src/weave-bridge.ts
function weaveTocToStructure(tree) {
  var _a41;
  if (!tree || tree.length === 0)
    return null;
  const freq = [];
  const walkFreq = (nodes, depth) => {
    var _a42;
    for (const n of nodes) {
      while (freq.length <= depth)
        freq.push(/* @__PURE__ */ new Map());
      const w = extractTocUnitWord(n.label);
      if (w)
        freq[depth].set(w, ((_a42 = freq[depth].get(w)) != null ? _a42 : 0) + 1);
      walkFreq(n.children, depth + 1);
    }
  };
  walkFreq(tree, 0);
  const labelRows = [];
  const walkLabels = (nodes, depth) => {
    for (const n of nodes) {
      while (labelRows.length <= depth)
        labelRows.push([]);
      labelRows[depth].push(n.label || "");
      walkLabels(n.children, depth + 1);
    }
  };
  walkLabels(tree, 0);
  const depth0 = freq.length;
  if (depth0 === 0 || depth0 > 8)
    return null;
  const units = [];
  for (let d = 0; d < depth0; d++) {
    let best = "";
    let bestN = 0;
    for (const [w, n] of freq[d]) {
      if (n > bestN) {
        best = w;
        bestN = n;
      }
    }
    units.push(best || DEFAULT_UNIT_CHAIN[d] || `\u7EA7${d + 1}`);
  }
  const levels = units.map((unit) => ({ unit, counts: [] }));
  levels[0].counts = [tree.length];
  const leafSpine = [];
  const leafHref = [];
  {
    let current = tree;
    for (let lv = 1; lv < levels.length; lv++) {
      levels[lv].counts = current.map((n) => n.children.length);
      current = current.flatMap((n) => n.children);
    }
    const visit = (n, depth) => {
      if (depth === levels.length - 1 || n.children.length === 0) {
        leafSpine.push(n.spineIndex);
        leafHref.push(n.href);
        return;
      }
      for (const c of n.children)
        visit(c, depth + 1);
    };
    for (const n of tree)
      visit(n, 0);
  }
  for (let lv = 0; lv < levels.length; lv++) {
    if ((_a41 = labelRows[lv]) == null ? void 0 : _a41.some((l) => l.trim() !== ""))
      levels[lv].labels = labelRows[lv];
  }
  if (levels[0].counts[0] <= 0)
    return null;
  return { levels, leafSpine, leafHref };
}
function resumeLeafCount(leafSpine, chapterIndex) {
  return passedLeafIndices(leafSpine, chapterIndex).length;
}
function crossedLeafIndices(leafSpine, fromChapter, toChapter) {
  const out = [];
  for (let i = 0; i < leafSpine.length; i++) {
    const s = leafSpine[i];
    if (s >= 0 && s >= fromChapter && s < toChapter)
      out.push(i);
  }
  return out;
}
function passedLeafIndices(leafSpine, chapterIndex) {
  const out = [];
  for (let i = 0; i < leafSpine.length; i++) {
    const s = leafSpine[i];
    if (s >= 0 && s < chapterIndex)
      out.push(i);
  }
  return out;
}

// test/parse-test.ts
var failed = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== void 0 ? " | " + JSON.stringify(detail) : ""));
  if (!cond)
    failed++;
}
var fm1 = `---
type: year
year: 2026
plans:
  - name: \u5199\u4F5C
    type: \u6570\u91CF
    target: 12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0
  - name: \u5065\u5EB7
    type: \u6253\u5361
    target: \u6BCF\u5929\u8DD1\u6B65 1 \u5C0F\u65F6
---
# \u5E74\u5EA6\u8BA1\u5212
`;
var defs1 = parsePlansFromFrontmatter(fm1);
console.log("defs1:", JSON.stringify(defs1));
check("array form: 2 plans", defs1.length === 2, defs1.length);
var writing = defs1.find((d) => d.name === "\u5199\u4F5C");
check("\u5199\u4F5C is numeric", (writing == null ? void 0 : writing.type) === "numeric");
check("\u5199\u4F5C target", (writing == null ? void 0 : writing.target) === "12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0");
check("\u5199\u4F5C targetCount = 12", (writing == null ? void 0 : writing.targetCount) === 12);
var health = defs1.find((d) => d.name === "\u5065\u5EB7");
check("\u5065\u5EB7 is check", (health == null ? void 0 : health.type) === "check", health == null ? void 0 : health.type);
check("\u5065\u5EB7 targetCount = 0 (check)", (health == null ? void 0 : health.targetCount) === 0);
var fm2 = `---
plans:
  \u5199\u4F5C:
    type: \u6570\u91CF
    target: 12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0
  \u590D\u76D8:
    type: \u6253\u5361
    target: \u6BCF\u5929\u590D\u76D8
---
`;
var defs2 = parsePlansFromFrontmatter(fm2);
console.log("defs2:", JSON.stringify(defs2));
check("map form: 2 plans", defs2.length === 2, defs2.length);
check("map form name", defs2.some((d) => d.name === "\u5199\u4F5C"));
var _a;
check("map form check type", ((_a = defs2.find((d) => d.name === "\u590D\u76D8")) == null ? void 0 : _a.type) === "check");
var fm3 = `---
plans:
  - name: \u5B66\u4E60
    target: 50 \u672C\u4E66
  - name: \u51A5\u60F3
    target: \u575A\u6301\u6BCF\u5929\u51A5\u60F3
---
`;
var defs3 = parsePlansFromFrontmatter(fm3);
console.log("defs3:", JSON.stringify(defs3));
var _a2;
check("fallback numeric (50 \u672C\u4E66)", ((_a2 = defs3.find((d) => d.name === "\u5B66\u4E60")) == null ? void 0 : _a2.type) === "numeric");
var _a3;
check("fallback check (no number)", ((_a3 = defs3.find((d) => d.name === "\u51A5\u60F3")) == null ? void 0 : _a3.type) === "check");
var file = new TFile();
var poolContent = [
  "- [ ] \u5B8C\u6210\u300A\u970D\u53BB\u75C5\u300B\u6587\u7AE0 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16",
  "- [x] \u6574\u7406 AI \u753B\u56FE\u5DE5\u4F5C\u6D41 #\u8BA1\u5212/\u5B66\u4E60 \u{1F6EB} 2026-08-12 \u{1F4C5} 2026-08-14",
  "- [ ] \u65E0\u8BA1\u5212\u7684\u4E34\u65F6\u4EFB\u52A1 \u{1F4C5} 2026-08-11"
].join("\n");
var pool = parseTaskPool(file, poolContent);
console.log("pool:", JSON.stringify(pool.map((t) => ({ text: t.text, plan: t.plan, checked: t.checked, start: t.start, due: t.due, line: t.line }))));
check("pool parses 3 tasks", pool.length === 3, pool.length);
var t0 = pool[0];
check("task0 fields", t0.text === "\u5B8C\u6210\u300A\u970D\u53BB\u75C5\u300B\u6587\u7AE0" && t0.plan === "\u5199\u4F5C" && t0.start === "2026-08-10" && t0.due === "2026-08-16" && !t0.checked);
check("task0 line", t0.line === 0);
check("task1 checked", pool[1].checked === true);
check("task2 plan null", pool[2].plan === null && pool[2].due === "2026-08-11");
var built = buildPoolLine({ text: "\u65B0\u4EFB\u52A1", plan: "\u5199\u4F5C", start: "2026-08-10", due: "2026-08-16" });
check("buildPoolLine", built === "- [ ] \u65B0\u4EFB\u52A1 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16", built);
var rebuilt = parseTaskPool(file, built);
check("build\u2192parse round-trip", rebuilt.length === 1 && rebuilt[0].text === "\u65B0\u4EFB\u52A1" && rebuilt[0].plan === "\u5199\u4F5C" && rebuilt[0].start === "2026-08-10" && rebuilt[0].due === "2026-08-16");
var built2 = buildPoolLine({ text: "\u7B80\u5355\u4EFB\u52A1", plan: null, start: null, due: null });
check("buildPoolLine minimal", built2 === "- [ ] \u7B80\u5355\u4EFB\u52A1", built2);
var tasks = pool;
var week = filterTasksInRange(tasks, "2026-08-10", "2026-08-16");
check("week filter includes all 3", week.length === 3, week.map((t) => t.text));
var month = filterTasksInRange(tasks, "2026-08-01", "2026-08-31");
check("month filter includes all dated", month.length === 3, month.map((t) => t.text));
var none = filterTasksInRange(tasks, "2026-09-01", "2026-09-30");
check("sep filter empty", none.length === 0, none.length);
check("summarize", JSON.stringify(summarizeTasks(tasks)) === '{"total":3,"done":1,"percent":33}', JSON.stringify(summarizeTasks(tasks)));
var undated = parseTaskPool(file, "- [ ] \u672A\u5B89\u6392\u65E5\u671F\n");
check("undated excluded", filterTasksInRange(undated, "2026-08-10", "2026-08-16").length === 0);
var fm7 = `---
plans:
  \u5199\u4F5C: 12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0
  \u5065\u5EB7: \u6BCF\u5929\u8DD1\u6B65
---
`;
var defs7 = parsePlansFromFrontmatter(fm7);
console.log("defs7:", JSON.stringify(defs7));
check("single-key map 2 plans", defs7.length === 2, defs7.length);
var _a4;
check("single-key \u5199\u4F5C numeric", ((_a4 = defs7.find((d) => d.name === "\u5199\u4F5C")) == null ? void 0 : _a4.type) === "numeric");
var _a5;
check("single-key \u5065\u5EB7 check", ((_a5 = defs7.find((d) => d.name === "\u5065\u5EB7")) == null ? void 0 : _a5.type) === "check");
check("planCounterUnit \u7BC7", planCounterUnit("12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0") === "\u7BC7");
check("planCounterUnit \u5929", planCounterUnit("144 \u5929") === "\u5929");
check("planCounterUnit default", planCounterUnit("\u6BCF\u5929\u8DD1\u6B65") === "\u7BC7");
check("autoQuota w1 (12/52)", autoQuota(12, 1, 52) === 1, autoQuota(12, 1, 52));
check("autoQuota w26 (12/52)", autoQuota(12, 26, 52) === 6, autoQuota(12, 26, 52));
check("autoQuota w52 (12/52)", autoQuota(12, 52, 52) === 12, autoQuota(12, 52, 52));
check("autoQuota target 0", autoQuota(0, 5, 52) === 0);
check("autoQuota increments \u2264 2", Array.from({ length: 52 }, (_, i) => autoQuota(12, i + 1, 52) - autoQuota(12, i, 52)).every((d) => d >= 0 && d <= 2));
var ctx1 = autoWeekContext("2026-01-01", "2026-12-31", "2026-01-05");
console.log("ctx1:", JSON.stringify(ctx1));
check("weekContext full-year totalWeeks = 53 (2026 has 53 ISO weeks)", (ctx1 == null ? void 0 : ctx1.totalWeeks) === 53, ctx1 == null ? void 0 : ctx1.totalWeeks);
check("weekContext first week index = 2", (ctx1 == null ? void 0 : ctx1.weekIndex) === 2, ctx1 == null ? void 0 : ctx1.weekIndex);
check("weekContext before plan start \u2192 null", autoWeekContext("2026-08-10", "2026-12-31", "2026-08-01") === null);
check("weekContext after plan end \u2192 null", autoWeekContext("2026-08-10", "2026-12-31", "2027-01-04") === null);
check("weekContext same week before start \u2192 null", autoWeekContext("2026-08-12", "2026-12-31", "2026-08-10") === null);
var ctx2 = autoWeekContext("2026-08-10", "2026-12-31", "2026-08-10");
check("weekContext mid-plan totalWeeks", (ctx2 == null ? void 0 : ctx2.totalWeeks) === 21, ctx2 == null ? void 0 : ctx2.totalWeeks);
check("weekContext mid-plan week1", (ctx2 == null ? void 0 : ctx2.weekIndex) === 1, ctx2 == null ? void 0 : ctx2.weekIndex);
var ctx3 = autoWeekContext("2026-08-10", "2026-12-31", "2026-08-17");
check("weekContext mid-plan week2", (ctx3 == null ? void 0 : ctx3.weekIndex) === 2, ctx3 == null ? void 0 : ctx3.weekIndex);
var autoPool = parseTaskPool(
  file,
  [
    "- [ ] \u5199\u4F5C\uFF08\u7B2C 1 \u7BC7\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16",
    "- [x] \u5199\u4F5C\uFF08\u7B2C 2 \u7BC7\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16",
    "- [ ] \u5B8C\u6210\u300A\u970D\u53BB\u75C5\u300B\u6587\u7AE0 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16",
    "- [ ] \u5B66\u4E60\uFF08\u7B2C 1 \u672C\uFF09 #\u8BA1\u5212/\u5B66\u4E60 \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16"
  ].join("\n")
);
check("isAutoTask \u7B2C1\u7BC7", autoPool[0].plan === "\u5199\u4F5C" && isAutoTask(autoPool[0]));
check("isAutoTask \u7B2C2\u7BC7 checked", autoPool[1].plan === "\u5199\u4F5C" && isAutoTask(autoPool[1]));
check("manual task not auto", autoPool[2].plan === "\u5199\u4F5C" && !isAutoTask(autoPool[2]));
check("isAutoTask \u7B2C1\u672C (book unit)", autoPool[3].plan === "\u5B66\u4E60" && isAutoTask(autoPool[3]));
var autoWriting = autoPool.filter((t) => t.plan === "\u5199\u4F5C");
var nums1 = autoTaskNumbers(autoWriting, 1, 12, "\u5199\u4F5C", "\u7BC7");
check("autoTaskNumbers continue from maxN", JSON.stringify(nums1) === "[3]", nums1);
var gapPool = parseTaskPool(
  file,
  ["- [ ] \u5199\u4F5C\uFF08\u7B2C 1 \u7BC7\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16", "- [ ] \u5199\u4F5C\uFF08\u7B2C 3 \u7BC7\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16"].join("\n")
);
var numsGap = autoTaskNumbers(gapPool, 2, 12, "\u5199\u4F5C", "\u7BC7");
check("autoTaskNumbers skip deleted middle", JSON.stringify(numsGap) === "[4,5]", numsGap);
check("autoTaskNumbers need 0", autoTaskNumbers(autoWriting, 0, 12, "\u5199\u4F5C", "\u7BC7").length === 0);
var numsCap = autoTaskNumbers(autoWriting, 5, 2, "\u5199\u4F5C", "\u7BC7");
check("autoTaskNumbers capped at targetCount", JSON.stringify(numsCap) === "[]", numsCap);
var numsEmpty = autoTaskNumbers([], 2, 12, "\u5199\u4F5C", "\u7BC7");
check("autoTaskNumbers from scratch", JSON.stringify(numsEmpty) === "[1,2]", numsEmpty);
var fm9 = `---
plans:
  - name: \u5C0F\u8BF4
    type: quota
    target: \u5199 10 \u4E07\u5B57\u5C0F\u8BF4
    quota:
      total: 100000
      unit: \u5B57
      start: 2026-09-01
      end: 2026-12-31
  - name: \u8BFB\u4E66
    quota:
      total: 300
      unit: \u9875
      end: 2026-12-31
  - name: \u574F\u5B9A\u4E49
    type: quota
    quota:
      unit: \u5B57
  - name: \u590D\u76D8
    type: \u6253\u5361
    target: \u6BCF\u65E5\u590D\u76D8
---
`;
var defs9 = parsePlansFromFrontmatter(fm9);
console.log("defs9:", JSON.stringify(defs9));
check("quota: 4 plans parsed", defs9.length === 4, defs9.length);
var novel = defs9.find((d) => d.name === "\u5C0F\u8BF4");
check("\u5C0F\u8BF4 type quota", (novel == null ? void 0 : novel.type) === "quota", novel == null ? void 0 : novel.type);
var _a6, _b, _c, _d;
check("\u5C0F\u8BF4 quota fields", ((_a6 = novel == null ? void 0 : novel.quota) == null ? void 0 : _a6.total) === 1e5 && ((_b = novel == null ? void 0 : novel.quota) == null ? void 0 : _b.unit) === "\u5B57" && ((_c = novel == null ? void 0 : novel.quota) == null ? void 0 : _c.start) === "2026-09-01" && ((_d = novel == null ? void 0 : novel.quota) == null ? void 0 : _d.end) === "2026-12-31", novel == null ? void 0 : novel.quota);
var book = defs9.find((d) => d.name === "\u8BFB\u4E66");
var _a7, _b2, _c2;
check("\u8BFB\u4E66 quota (no start)", (book == null ? void 0 : book.type) === "quota" && ((_a7 = book == null ? void 0 : book.quota) == null ? void 0 : _a7.total) === 300 && ((_b2 = book == null ? void 0 : book.quota) == null ? void 0 : _b2.unit) === "\u9875" && ((_c2 = book == null ? void 0 : book.quota) == null ? void 0 : _c2.start) === void 0, book == null ? void 0 : book.quota);
var _a8, _b3;
check("\u574F\u5B9A\u4E49 falls back (no total/end)", ((_a8 = defs9.find((d) => d.name === "\u574F\u5B9A\u4E49")) == null ? void 0 : _a8.type) !== "quota", (_b3 = defs9.find((d) => d.name === "\u574F\u5B9A\u4E49")) == null ? void 0 : _b3.type);
var _a9;
check("\u590D\u76D8 stays check", ((_a9 = defs9.find((d) => d.name === "\u590D\u76D8")) == null ? void 0 : _a9.type) === "check");
check("quotaDaily 100000/122", computeQuotaDaily(1e5, "2026-09-01", "2026-12-31") === 819.7, computeQuotaDaily(1e5, "2026-09-01", "2026-12-31"));
check("quotaDaily exact 300/122", computeQuotaDaily(300, "2026-09-01", "2026-12-31") === 2.5, computeQuotaDaily(300, "2026-09-01", "2026-12-31"));
check("quotaDaily zero days \u2192 total", computeQuotaDaily(100, "2026-10-01", "2026-10-01") === 100);
check("quotaExpected before start", quotaExpected(10, "2026-10-01", "2026-12-31", "2026-09-15") === 0);
check("quotaExpected clamps at end", quotaExpected(10, "2026-10-01", "2026-10-03", "2027-01-01") === 30);
check("quotaExpected mid", quotaExpected(10, "2026-10-01", "2026-12-31", "2026-10-03") === 30);
var ql = buildQuotaCheckLine({ label: "\u270D\uFE0F", plan: "\u5C0F\u8BF4", quota: 819.7, unit: "\u5B57", date: "2026-09-23" });
check("quota line format", ql === "- [ ] \u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57 #\u8BA1\u5212/\u5C0F\u8BF4 \u{1F6EB} 2026-09-23 \u{1F4C5} 2026-09-23", ql);
check("quota line no label", buildQuotaCheckLine({ label: "", plan: "\u8BFB\u4E66", quota: 2.5, unit: "\u9875", date: "2026-09-23" }) === "- [ ] \u8BFB\u4E66 2.5\u9875 #\u8BA1\u5212/\u8BFB\u4E66 \u{1F6EB} 2026-09-23 \u{1F4C5} 2026-09-23");
check("parseQuotaActual none", parseQuotaAmount("\u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57") === 819.7);
check("parseQuotaActual with suffix", parseQuotaActual("\u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57\uFF08\u5B9E 800\u5B57\uFF09") === 800);
check("parseQuotaAmount ignores suffix", parseQuotaAmount("\u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57\uFF08\u5B9E 800\u5B57\uFF09") === 819.7);
check("parseQuotaActual absent", parseQuotaActual("\u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57") === null);
check("formatQuotaAmount int", formatQuotaAmount(1170) === "1170");
check("formatQuotaAmount trim .0", formatQuotaAmount(2) === "2");
check("formatQuotaAmount 1 decimal", formatQuotaAmount(819.7) === "819.7");
var dailyContent = `---
date: 2026-09-23
type: daily
---
# \u{1F4C5} 2026-09-23 \u661F\u671F\u4E09

## \u2705 \u4ECA\u65E5\u6253\u5361
- [ ] \u{1F4C8} \u590D\u76D8+\u6B21\u65E5\u8BA1\u5212 #\u8BA1\u5212/\u590D\u76D8 \u{1F6EB} 2026-09-23 \u{1F4C5} 2026-09-23

## \u{1F4DD} \u4ECA\u65E5\u603B\u7ED3
`;
var m1 = missingQuotaLines(dailyContent, [{ plan: "\u5C0F\u8BF4", label: "\u270D\uFE0F", quota: 819.7, unit: "\u5B57" }], "2026-09-23");
check("missingQuotaLines adds 1", m1.length === 1 && m1[0] === "- [ ] \u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57 #\u8BA1\u5212/\u5C0F\u8BF4 \u{1F6EB} 2026-09-23 \u{1F4C5} 2026-09-23", m1);
var withQuota = dailyContent.replace(
  "## \u{1F4DD} \u4ECA\u65E5\u603B\u7ED3",
  "- [ ] \u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57 #\u8BA1\u5212/\u5C0F\u8BF4 \u{1F6EB} 2026-09-23 \u{1F4C5} 2026-09-23\n\n## \u{1F4DD} \u4ECA\u65E5\u603B\u7ED3"
);
check("missingQuotaLines idempotent", missingQuotaLines(withQuota, [{ plan: "\u5C0F\u8BF4", label: "\u270D\uFE0F", quota: 819.7, unit: "\u5B57" }], "2026-09-23").length === 0);
var outside = dailyContent.replace("# \u{1F4C5} 2026-09-23 \u661F\u671F\u4E09", "- [ ] \u65E7\u6B8B\u7559 #\u8BA1\u5212/\u5C0F\u8BF4 \u{1F4C5} 2026-09-01");
check("missingQuotaLines section-scoped", missingQuotaLines(outside, [{ plan: "\u5C0F\u8BF4", label: "", quota: 819.7, unit: "\u5B57" }], "2026-09-23").length === 1);
var added = missingQuotaLines(dailyContent, [{ plan: "\u5C0F\u8BF4", label: "\u270D\uFE0F", quota: 819.7, unit: "\u5B57" }], "2026-09-23")[0];
var content2 = dailyContent.replace("## \u{1F4DD} \u4ECA\u65E5\u603B\u7ED3", `${added}

## \u{1F4DD} \u4ECA\u65E5\u603B\u7ED3`);
var line2 = content2.split("\n").findIndex((l) => l.includes("#\u8BA1\u5212/\u5C0F\u8BF4"));
var afterActual = setQuotaActual(content2, line2, 800, "\u5B57", true);
var m = afterActual.split("\n")[line2];
check("setQuotaActual writes suffix + check", m === "- [x] \u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57\uFF08\u5B9E 800\u5B57\uFF09 #\u8BA1\u5212/\u5C0F\u8BF4 \u{1F6EB} 2026-09-23 \u{1F4C5} 2026-09-23", m);
var afterClear = setQuotaActual(afterActual, line2, 0, "\u5B57", false);
check("setQuotaActual 0 clears + unchecks", afterClear.split("\n")[line2] === "- [ ] \u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57 #\u8BA1\u5212/\u5C0F\u8BF4 \u{1F6EB} 2026-09-23 \u{1F4C5} 2026-09-23", afterClear.split("\n")[line2]);
var afterReplace = setQuotaActual(afterActual, line2, 650.5, "\u5B57", true);
check("setQuotaActual replaces old suffix", afterReplace.split("\n")[line2] === "- [x] \u270D\uFE0F \u5C0F\u8BF4 819.7\u5B57\uFF08\u5B9E 650.5\u5B57\uFF09 #\u8BA1\u5212/\u5C0F\u8BF4 \u{1F6EB} 2026-09-23 \u{1F4C5} 2026-09-23", afterReplace.split("\n")[line2]);
check("setQuotaActual bad line no-op", setQuotaActual(content2, 0, 800, "\u5B57", true) === content2);
var bookLevels = [
  { unit: "\u7AE0", counts: [3] },
  { unit: "\u8282", counts: [2, 3, 4] }
];
var secs = expandGoalStructure("\u300A\u8BA4\u77E5\u89C9\u9192\u300B", bookLevels);
check("structure total = \u03A3", secs.length === 9, secs.length);
check("structure flat order", secs[0].name === "\u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 1 \u7AE0\u7B2C 1 \u8282\uFF09" && secs[0].index === 1, secs[0]);
check("structure chapter boundary", secs[1].name.endsWith("\u7B2C 1 \u7AE0\u7B2C 2 \u8282\uFF09") && secs[2].name.endsWith("\u7B2C 2 \u7AE0\u7B2C 1 \u8282\uFF09"), secs[2]);
check("structure last node", secs[8].name === "\u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 3 \u7AE0\u7B2C 4 \u8282\uFF09" && secs[8].index === 9, secs[8]);
check("structure groups per chapter", secs[0].group === "\u7B2C 1 \u7AE0" && secs[2].group === "\u7B2C 2 \u7AE0" && secs[8].group === "\u7B2C 3 \u7AE0", secs[8].group);
var threeLevels = [
  { unit: "\u7BC7", counts: [3] },
  { unit: "\u7AE0", counts: [2, 3, 2] },
  { unit: "\u8282", counts: [2, 1, 2, 1, 2, 1, 2] }
];
var t3 = expandGoalStructure("\u4E66", threeLevels);
check("3-level total", t3.length === 11, t3.length);
check("3-level chapter numbering continues across \u7BC7", t3[3].name === "\u4E66\uFF08\u7B2C 3 \u7AE0\u7B2C 1 \u8282\uFF09", t3[3].name);
check("3-level section restarts per chapter", t3[4].name === "\u4E66\uFF08\u7B2C 3 \u7AE0\u7B2C 2 \u8282\uFF09", t3[4].name);
check("3-level first leaf", t3[0].name === "\u4E66\uFF08\u7B2C 1 \u7AE0\u7B2C 1 \u8282\uFF09", t3[0].name);
check("3-level last leaf", t3[10].name === "\u4E66\uFF08\u7B2C 7 \u7AE0\u7B2C 2 \u8282\uFF09", t3[10].name);
var pOnly = expandGoalStructure("\u4E66", [{ unit: "\u7BC7", counts: [3] }]);
check("stop at \u7BC7", pOnly.length === 3 && pOnly[1].name === "\u4E66\uFF08\u7B2C 2 \u7BC7\uFF09" && pOnly[1].group === "", pOnly[1]);
var pcOnly = expandGoalStructure("\u4E66", [
  { unit: "\u7BC7", counts: [3] },
  { unit: "\u7AE0", counts: [2, 3, 2] }
]);
check("stop at \u7AE0: global chapter numbers", pcOnly.length === 7 && pcOnly[2].name === "\u4E66\uFF08\u7B2C 3 \u7AE0\uFF09", pcOnly[2]);
check("stop at \u7AE0: rollup = \u7BC7 (\u5012\u6570\u7B2C\u4E8C\u7EA7)", pcOnly[0].group === "\u7B2C 1 \u7BC7" && pcOnly[2].group === "\u7B2C 2 \u7BC7" && pcOnly[6].group === "\u7B2C 3 \u7BC7", pcOnly[2].group);
var legacy = expandGoalLeaves("\u300A\u8BA4\u77E5\u89C9\u9192\u300B", { chapters: [2, 3, 4] });
check("chapters compat naming identical", !!legacy && legacy.length === 9 && legacy.every((l, i) => l.name === secs[i].name), legacy == null ? void 0 : legacy[8]);
check("expandGoalLeaves flat = null", expandGoalLeaves("\u4E66", {}) === null && expandGoalLeaves("\u4E66", { chapters: [] }) === null);
check("invalid structure rejected", expandGoalStructure("\u4E66", []).length === 0 && expandGoalStructure("\u4E66", [{ unit: "\u7AE0", counts: [0] }]).length === 0);
var four = expandGoalStructure("\u4E66", [
  { unit: "\u90E8", counts: [1] },
  { unit: "\u5377", counts: [2] },
  { unit: "\u7BC7", counts: [1, 2] },
  { unit: "\u7AE0", counts: [2, 2, 2] }
]);
check("4-level expansion", four.length === 6 && four[0].name === "\u4E66\uFF08\u7B2C 1 \u7AE0\uFF09" && four[3].name === "\u4E66\uFF08\u7B2C 4 \u7AE0\uFF09", four[3]);
check("4-level groups = \u5012\u6570\u7B2C\u4E8C\u7EA7(\u7BC7)", four[0].group === "\u7B2C 1 \u7BC7" && four[2].group === "\u7B2C 2 \u7BC7" && four[4].group === "\u7B2C 3 \u7BC7", four[4].group);
var lect = expandGoalStructure("\u4E66", [
  { unit: "\u8BB2", counts: [2] },
  { unit: "\u8282", counts: [2, 3] }
]);
check("\u8BB2 continuous + \u8282 restarts per \u8BB2", lect[0].name === "\u4E66\uFF08\u7B2C 1 \u8BB2\u7B2C 1 \u8282\uFF09" && lect[2].name === "\u4E66\uFF08\u7B2C 2 \u8BB2\u7B2C 1 \u8282\uFF09" && lect[4].name === "\u4E66\uFF08\u7B2C 2 \u8BB2\u7B2C 3 \u8282\uFF09", lect[4]);
var drama = expandGoalStructure("\u5267\u672C", [
  { unit: "\u5E55", counts: [2] },
  { unit: "\u573A", counts: [1, 2] }
]);
check("\u573A restarts per \u5E55", drama[1].name === "\u5267\u672C\uFF08\u7B2C 2 \u5E55\u7B2C 1 \u573A\uFF09", drama[1]);
check("suggestNextUnit chains", suggestNextUnit("\u7BC7") === "\u7AE0" && suggestNextUnit("\u7AE0") === "\u8282" && suggestNextUnit("\u5355\u5143") === "\u8BFE" && suggestNextUnit("\u90E8") === "\u5377" && suggestNextUnit("\u5E55") === "\u573A", suggestNextUnit("\u5355\u5143"));
check("suggestNextUnit unknown \u2192 \u8282", suggestNextUnit("\u81EA\u5B9A\u4E49") === "\u8282");
check("isRestartUnit defaults", isRestartUnit("\u8282") === true && isRestartUnit("\u573A") === true && isRestartUnit("\u7AE0") === false && isRestartUnit("\u56DE") === false && isRestartUnit("\u81EA\u5B9A\u4E49") === false);
var eight = expandGoalStructure("\u4E66", [
  { unit: "\u90E8", counts: [1] },
  { unit: "\u5377", counts: [1] },
  { unit: "\u7BC7", counts: [1] },
  { unit: "\u7AE0", counts: [1] },
  { unit: "\u8282", counts: [1] },
  { unit: "\u5C0F\u8282", counts: [1] },
  { unit: "\u76EE", counts: [1] },
  { unit: "\u6761", counts: [1] }
]);
check("8-level ok (\u53F6\u540D=\u91CD\u6392\u94FE\u8DEF\u5F84)", eight.length === 1 && eight[0].name === "\u4E66\uFF08\u7B2C 1 \u7AE0\u7B2C 1 \u8282\u7B2C 1 \u5C0F\u8282\u7B2C 1 \u76EE\u7B2C 1 \u6761\uFF09", eight[0]);
check("9-level rejected", expandGoalStructure("\u4E66", Array.from({ length: 9 }, () => ({ unit: "\u7AE0", counts: [1] }))).length === 0);
var mixed = expandGoalStructure("\u4E66", [
  { unit: "\u7AE0", counts: [5] },
  { unit: "\u8282", counts: [2, 3, 0, 4, 0] }
]);
check("zero-section chapter promotes itself", mixed.length === 11, mixed.length);
check("promoted chapter name", mixed[5].name === "\u4E66\uFF08\u7B2C 3 \u7AE0\uFF09" && mixed[5].group === "\u7B2C 3 \u7AE0", mixed[5]);
check("promoted chapter order (\u4E66\u5E8F)", mixed[4].name === "\u4E66\uFF08\u7B2C 2 \u7AE0\u7B2C 3 \u8282\uFF09" && mixed[6].name === "\u4E66\uFF08\u7B2C 4 \u7AE0\u7B2C 1 \u8282\uFF09", mixed[6]);
check("second promoted chapter at end", mixed[10].name === "\u4E66\uFF08\u7B2C 5 \u7AE0\uFF09", mixed[10]);
var allZero = expandGoalStructure("\u4E66", [
  { unit: "\u7AE0", counts: [3] },
  { unit: "\u8282", counts: [0, 0, 0] }
]);
check("all-zero sections \u2192 chapters as leaves", allZero.length === 3 && allZero[1].name === "\u4E66\uFF08\u7B2C 2 \u7AE0\uFF09", allZero[1]);
var deepZero = expandGoalStructure("\u4E66", [
  { unit: "\u5377", counts: [3] },
  { unit: "\u7BC7", counts: [1, 0, 2] },
  { unit: "\u7AE0", counts: [2, 1, 1] }
]);
check("deep zero promotes \u5377", deepZero[2].name === "\u4E66\uFF08\u7B2C 2 \u5377\uFF09" && deepZero[2].group === "\u7B2C 2 \u5377", deepZero[2]);
check("deep zero keeps book order", deepZero[0].name === "\u4E66\uFF08\u7B2C 1 \u7AE0\uFF09" && deepZero[3].name === "\u4E66\uFF08\u7B2C 3 \u7AE0\uFF09", deepZero[3]);
var toc = expandGoalStructure("\u4E66", [
  { unit: "\u7AE0", counts: [3] },
  { unit: "\u8282", counts: [4, 4, 1] },
  { unit: "\u5C0F\u8282", counts: [2, 3, 0, 0, 3, 0, 0, 2, 0] }
]);
check("TOC total = 15 leaves", toc.length === 15, toc.length);
check("TOC 1.1.1 \u2192 path name", toc[0].name === "\u4E66\uFF08\u7B2C 1 \u7AE0\u7B2C 1 \u8282\u7B2C 1 \u5C0F\u8282\uFF09", toc[0]);
check("TOC 1.2.3 \u2192 path name", toc[4].name === "\u4E66\uFF08\u7B2C 1 \u7AE0\u7B2C 2 \u8282\u7B2C 3 \u5C0F\u8282\uFF09", toc[4]);
check("TOC 1.3 (\u65E0\u5C0F\u8282) \u2192 \u8282\u5347\u683C", toc[5].name === "\u4E66\uFF08\u7B2C 1 \u7AE0\u7B2C 3 \u8282\uFF09", toc[5]);
check("TOC 1.4 \u2192 \u8282\u5347\u683C", toc[6].name === "\u4E66\uFF08\u7B2C 1 \u7AE0\u7B2C 4 \u8282\uFF09", toc[6]);
check("TOC 2.1.1 \u2192 path name (\u8DE8\u7AE0\u91CD\u6392\u7F16\u53F7)", toc[7].name === "\u4E66\uFF08\u7B2C 2 \u7AE0\u7B2C 1 \u8282\u7B2C 1 \u5C0F\u8282\uFF09", toc[7]);
check("TOC 2.2 \u2192 \u8282\u5347\u683C", toc[10].name === "\u4E66\uFF08\u7B2C 2 \u7AE0\u7B2C 2 \u8282\uFF09", toc[10]);
check("TOC 2.4.2 \u2192 path name", toc[13].name === "\u4E66\uFF08\u7B2C 2 \u7AE0\u7B2C 4 \u8282\u7B2C 2 \u5C0F\u8282\uFF09", toc[13]);
check("TOC 3.1 \u2192 \u8282\u5347\u683C", toc[14].name === "\u4E66\uFF08\u7B2C 3 \u7AE0\u7B2C 1 \u8282\uFF09", toc[14]);
check("TOC groups path-based (\u4E0D\u8DE8\u7AE0\u649E\u540D)", toc[0].group === "\u7B2C 1 \u7AE0\u7B2C 1 \u8282" && toc[7].group === "\u7B2C 2 \u7AE0\u7B2C 1 \u8282" && toc[5].group === "\u7B2C 1 \u7AE0\u7B2C 3 \u8282" && toc[14].group === "\u7B2C 3 \u7AE0\u7B2C 1 \u8282", toc[7].group);
var chapterTaskLike = { text: "\u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 2 \u7AE0\u7B2C 3 \u8282\uFF09", plan: "\u9605\u8BFB", checked: false, start: null, due: null, line: 0, raw: "", file: {} };
check("isAutoTask chapter pattern", isAutoTask(chapterTaskLike) === true);
var flatTaskLike = { ...chapterTaskLike, text: "\u516C\u4F17\u53F7\u6587\u7AE0\uFF08\u7B2C 2 \u7BC7\uFF09" };
check("isAutoTask flat pattern still matches", isAutoTask(flatTaskLike) === true);
var manualTaskLike = { ...chapterTaskLike, text: "\u624B\u52A8\u4EFB\u52A1" };
check("isAutoTask manual task excluded", isAutoTask(manualTaskLike) === false);
var chapterUnitFlat = { ...chapterTaskLike, text: "\u300A\u67D0\u4E66\u300B\uFF08\u7B2C 3 \u7AE0\uFF09" };
check("isAutoTask \u7AE0-unit flat task", isAutoTask(chapterUnitFlat) === true);
var customUnitLeaf = { ...chapterTaskLike, text: "\u300A\u5267\u672C\u300B\uFF08\u7B2C 2 \u5E55\uFF09" };
check("isAutoTask custom unit leaf", isAutoTask(customUnitLeaf) === true);
var fmChUnit = `---
plans:
  - name: \u9605\u8BFB
    goals:
      - "\u9605\u8BFB 10 \u7AE0"
---
`;
var _a10;
var chUnitGoal = (_a10 = parsePlansFromFrontmatter(fmChUnit)[0]) == null ? void 0 : _a10.goals[0];
check("string-form goal with \u7AE0 unit", !!chUnitGoal && chUnitGoal.count === 10 && chUnitGoal.unit === "\u7AE0", chUnitGoal);
var buildCtx = (readCount, start, end) => {
  const remaining = new Set(secs.slice(readCount).map((l) => l.name));
  let m2 = 0;
  return {
    plan: "\u9605\u8BFB",
    prefix: "\u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08",
    valid: new Set(secs.map((l) => l.name)),
    leafIndexByName: new Map(secs.filter((l) => remaining.has(l.name)).map((l) => [l.name, ++m2])),
    total: m2,
    start,
    end
  };
};
var rctx = buildCtx(0, "2026-11-06", "2026-11-12");
var oldLine = "- [ ] \u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 3 \u7AE0\u7B2C 4 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08";
var rescheduled = rescheduleChapterLine(oldLine, rctx);
check("reschedule re-dates unchecked section", rescheduled === "- [ ] \u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 3 \u7AE0\u7B2C 4 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12", rescheduled);
var checkedLine = oldLine.replace("- [ ]", "- [x]");
check("reschedule keeps checked dates", rescheduleChapterLine(checkedLine, rctx) === checkedLine);
check("reschedule drops invalid leaf", rescheduleChapterLine("- [ ] \u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 4 \u7AE0\u7B2C 1 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08", rctx) === null);
var sameLine = "- [ ] \u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 1 \u7AE0\u7B2C 1 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-06 \u{1F4C5} 2026-11-06";
check("reschedule no-op when dates match", rescheduleChapterLine(sameLine, rctx) === sameLine);
var otherLine = "- [ ] \u5199\u4F5C\u4EFB\u52A1 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08";
check("reschedule ignores other plans", rescheduleChapterLine(otherLine, rctx) === otherLine);
check("reschedule ignores non-task lines", rescheduleChapterLine("## \u6807\u9898", rctx) === "## \u6807\u9898");
var rctxRestart = buildCtx(4, "2026-11-06", "2026-11-10");
var stale22 = "- [ ] \u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 2 \u7AE0\u7B2C 3 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-07 \u{1F4C5} 2026-11-07";
check("restart: first remaining section starts day 1", rescheduleChapterLine(stale22, rctxRestart) === "- [ ] \u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 2 \u7AE0\u7B2C 3 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-06 \u{1F4C5} 2026-11-06", rescheduleChapterLine(stale22, rctxRestart));
var stale34 = "- [ ] \u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 3 \u7AE0\u7B2C 4 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08";
check("restart: last remaining section lands on window end", rescheduleChapterLine(stale34, rctxRestart) === "- [ ] \u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 3 \u7AE0\u7B2C 4 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-10 \u{1F4C5} 2026-11-10", rescheduleChapterLine(stale34, rctxRestart));
var read22 = "- [x] \u300A\u8BA4\u77E5\u89C9\u9192\u300B\uFF08\u7B2C 2 \u7AE0\u7B2C 2 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-07 \u{1F4C5} 2026-11-07";
check("restart: checked sections keep original dates", rescheduleChapterLine(read22, rctxRestart) === read22);
var fmChapter = `---
plans:
  - name: \u9605\u8BFB
    type: \u6570\u91CF
    goals:
      - name: \u300A\u8BA4\u77E5\u89C9\u9192\u300B
        count: 9
        unit: \u8282
        chapters: [2, 3, 4]
        start: 2026-11-06
        end: 2026-11-08
---
# \u5E74\u5EA6\u8BA1\u5212
`;
var defsChapter = parsePlansFromFrontmatter(fmChapter);
var reading = defsChapter.find((d) => d.name === "\u9605\u8BFB");
var chGoal = reading == null ? void 0 : reading.goals[0];
check("chapter goal parsed", !!chGoal && Array.isArray(chGoal.chapters) && chGoal.chapters.length === 3, chGoal);
var _a11;
check("chapter goal values", ((_a11 = chGoal == null ? void 0 : chGoal.chapters) == null ? void 0 : _a11.join(",")) === "2,3,4" && (chGoal == null ? void 0 : chGoal.count) === 9 && (chGoal == null ? void 0 : chGoal.unit) === "\u8282", chGoal);
check("chapter goal keeps window", (chGoal == null ? void 0 : chGoal.start) === "2026-11-06" && (chGoal == null ? void 0 : chGoal.end) === "2026-11-08");
check("chapter plan targetCount = \u03A3 chapters", (reading == null ? void 0 : reading.targetCount) === 9, reading == null ? void 0 : reading.targetCount);
var fmFlat = `---
plans:
  - name: \u5199\u4F5C
    goals:
      - name: \u516C\u4F17\u53F7\u6587\u7AE0
        count: 12
        unit: \u7BC7
---
`;
var _a12;
var flatGoal = (_a12 = parsePlansFromFrontmatter(fmFlat)[0]) == null ? void 0 : _a12.goals[0];
check("flat goal has no chapters", flatGoal && !flatGoal.chapters, flatGoal);
var fmStruct = `---
plans:
  - name: \u9605\u8BFB
    goals:
      - name: \u300A\u91CF\u4EF7\u5178\u578B\u80A1\u7968\u76D8\u53E3\u5206\u6790\u300B
        count: 7
        unit: \u8282
        structure:
          - unit: \u7AE0
            counts: [3]
          - unit: \u8282
            counts: [2, 2, 3]
---
`;
var _a13;
var structGoal = (_a13 = parsePlansFromFrontmatter(fmStruct)[0]) == null ? void 0 : _a13.goals[0];
check("structure goal parsed", !!structGoal && Array.isArray(structGoal.structure) && structGoal.structure.length === 2, structGoal);
var _a14, _b4;
check("structure goal values", ((_a14 = structGoal == null ? void 0 : structGoal.structure) == null ? void 0 : _a14[0].unit) === "\u7AE0" && ((_b4 = structGoal == null ? void 0 : structGoal.structure) == null ? void 0 : _b4[1].counts.join(",")) === "2,2,3", structGoal == null ? void 0 : structGoal.structure);
var structLeaves = structGoal ? expandGoalLeaves(structGoal.name, structGoal) : [];
check("structure goal leaf expansion", !!structLeaves && structLeaves.length === 7 && structLeaves[0].name === "\u300A\u91CF\u4EF7\u5178\u578B\u80A1\u7968\u76D8\u53E3\u5206\u6790\u300B\uFF08\u7B2C 1 \u7AE0\u7B2C 1 \u8282\uFF09", structLeaves == null ? void 0 : structLeaves[0]);
var fmMode = `---
plans:
  - name: \u5B66\u4E60
    goals:
      - name: \u6587\u732E\u590D\u4E60
        count: 0
        unit: \u7BC7
        mode: review
        floor: 5
      - name: \u65E5\u8BB0
        count: 0
        mode: diary
      - name: \u300A\u67D0\u4E66\u300B
        count: 3
        unit: \u7AE0
        mode: reading
        structure:
          - unit: \u7AE0
            counts: [3]
---
`;
var modePlan = parsePlansFromFrontmatter(fmMode)[0];
check("mode plan: 3 goals", (modePlan == null ? void 0 : modePlan.goals.length) === 3, modePlan == null ? void 0 : modePlan.goals.length);
var reviewGoal = modePlan == null ? void 0 : modePlan.goals.find((g) => g.name === "\u6587\u732E\u590D\u4E60");
check("review goal mode+floor", (reviewGoal == null ? void 0 : reviewGoal.mode) === "review" && (reviewGoal == null ? void 0 : reviewGoal.floor) === 5, reviewGoal);
var diaryGoal = modePlan == null ? void 0 : modePlan.goals.find((g) => g.name === "\u65E5\u8BB0");
check("diary goal mode, default floor absent", (diaryGoal == null ? void 0 : diaryGoal.mode) === "diary" && (diaryGoal == null ? void 0 : diaryGoal.floor) === void 0, diaryGoal);
var readingGoal = modePlan == null ? void 0 : modePlan.goals.find((g) => g.mode === "reading");
var _a15;
check("reading goal keeps structure", ((_a15 = readingGoal == null ? void 0 : readingGoal.structure) == null ? void 0 : _a15.length) === 1, readingGoal == null ? void 0 : readingGoal.structure);
check("legacy goal without mode unaffected", !(flatGoal == null ? void 0 : flatGoal.mode), flatGoal == null ? void 0 : flatGoal.mode);
var _a16;
check("toc line: unit word", ((_a16 = parseTocLine("\u7B2C1\u7AE0 \u5F00\u59CB")) == null ? void 0 : _a16.family) === "U", parseTocLine("\u7B2C1\u7AE0 \u5F00\u59CB"));
var _a17, _b5;
check("toc line: numeric depth", ((_a17 = parseTocLine("1.2 \u76F8\u9047")) == null ? void 0 : _a17.family) === "N" && ((_b5 = parseTocLine("1.2 \u76F8\u9047")) == null ? void 0 : _b5.level) === 1, parseTocLine("1.2 \u76F8\u9047"));
var _a18;
check("toc line: page number stripped", ((_a18 = parseTocLine("\u7B2C1\u7AE0 \u5F00\u59CB......12")) == null ? void 0 : _a18.title) === "\u7B2C1\u7AE0 \u5F00\u59CB", parseTocLine("\u7B2C1\u7AE0 \u5F00\u59CB......12"));
check("toc line: \u76EE\u5F55 skipped", parseTocLine("\u76EE\u5F55") === null, void 0);
var _a19;
check("toc line: bullet cleaned", ((_a19 = parseTocLine("- \u7B2C2\u7AE0 \u91CD\u9022")) == null ? void 0 : _a19.title) === "\u7B2C2\u7AE0 \u91CD\u9022", parseTocLine("- \u7B2C2\u7AE0 \u91CD\u9022"));
var toc1 = parseToc("\u76EE\u5F55\n\u7B2C1\u7AE0 \u5F00\u59CB\n1.1 \u76F8\u9047\n1.2 \u79BB\u522B\n\u7B2C2\u7AE0 \u91CD\u9022\n\u7B2C3\u7AE0 \u7EC8\u5C40\n");
check("toc mixed: 2 levels", (toc1 == null ? void 0 : toc1.levels.length) === 2, toc1 == null ? void 0 : toc1.levels);
check("toc mixed: chapter counts", (toc1 == null ? void 0 : toc1.levels[0].counts.join(",")) === "3", toc1 == null ? void 0 : toc1.levels[0].counts);
check("toc mixed: section counts", (toc1 == null ? void 0 : toc1.levels[1].counts.join(",")) === "2,0,0", toc1 == null ? void 0 : toc1.levels[1].counts);
check("toc mixed: units", (toc1 == null ? void 0 : toc1.units.join(",")) === "\u7AE0,\u8282", toc1 == null ? void 0 : toc1.units);
check("toc mixed: leaf expansion", toc1 ? expandGoalStructure("\u4E66", toc1.levels).length === 4 : false, void 0);
check("toc summary text", !!toc1 && /识别 5 行/.test(tocSummary(toc1)), toc1 ? tocSummary(toc1) : "");
var toc2 = parseToc("\u7B2C\u4E00\u7BC7 \u4E0A\u90E8\n\u7B2C1\u7AE0 \u8D77\u6E90\n\u7B2C\u4E00\u8282 \u7F18\u8D77\n\u7B2C2\u7AE0 \u5206\u5C94\n\u7B2C\u4E8C\u7BC7 \u4E0B\u90E8\n\u7B2C3\u7AE0 \u6C47\u5408\n");
check("toc pure units: 3 levels", (toc2 == null ? void 0 : toc2.levels.length) === 3, toc2 == null ? void 0 : toc2.levels);
check("toc pure units: counts", (toc2 == null ? void 0 : toc2.levels.map((l) => l.counts.join("/")).join("|")) === "2|2/1|1/0/0", toc2 == null ? void 0 : toc2.levels.map((l) => l.counts.join("/")));
var toc3 = parseToc("  \u7F29\u8FDB\u4E00\u7AE0\n    \u7F29\u8FDB\u4E00\u8282\n    \u7F29\u8FDB\u4E8C\u8282\n  \u7F29\u8FDB\u4E8C\u7AE0\n");
check("toc indent: counts", (toc3 == null ? void 0 : toc3.levels[1].counts.join(",")) === "2,0", toc3 == null ? void 0 : toc3.levels[1].counts);
check("toc empty input", parseToc("   \n\n") === null, void 0);
var dayA = "2026-11-08";
var dayB = "2026-11-09";
var ts = (y, mo, d, h) => new Date(y, mo - 1, d, h).toISOString();
check("utc\u2192local day sanity", utcToLocalDay(ts(2026, 11, 8, 9)) === dayA, utcToLocalDay(ts(2026, 11, 8, 9)));
var reviewRaw = JSON.stringify([
  {
    filePath: "\u5361\u7247\u76D2/\u6587\u732E/A.md",
    reviewHistory: [
      { timestamp: ts(2026, 11, 8, 9), rating: "easy" },
      { timestamp: ts(2026, 11, 8, 21), rating: "again" },
      { timestamp: ts(2026, 11, 9, 8), rating: "good" }
    ]
  },
  { filePath: "\u5361\u7247\u76D2/\u6587\u732E/B.md", reviewHistory: [{ timestamp: ts(2026, 11, 8, 12), rating: "hard" }] },
  { filePath: "\u5361\u7247\u76D2/\u6587\u732E/C.md", reviewHistory: [] },
  { filePath: "", reviewHistory: [] }
]);
var items = parseReviewItems(reviewRaw);
check("review items parsed: 3 valid", items.length === 3, items.length);
var snap = buildBzgSnapshot(items, { storagePath: "CONFIG/STORAGE", diaryDirectory: "\u6211\u7684/\u65E5\u8BB0", reviewCountFolder: "\u5361\u7247\u76D2/\u6587\u732E" });
check("reviewedOn dedupe same-day", reviewedOn(snap, dayA) === 2, reviewedOn(snap, dayA));
check("reviewedOn next day", reviewedOn(snap, dayB) === 1, reviewedOn(snap, dayB));
check("reviewedOn empty day", reviewedOn(snap, "2026-11-10") === 0, void 0);
check("coverage in range", distinctReviewedInRange(snap, dayA, dayB) === 2, void 0);
check("coverage narrow range", distinctReviewedInRange(snap, "2026-11-01", dayA) === 2, void 0);
check("coverage before any", distinctReviewedInRange(snap, "2026-01-01", "2026-02-01") === 0, void 0);
check("review json invalid \u2192 empty", parseReviewItems("not json{{").length === 0, void 0);
check("diary null \u2192 not written", diaryDayWritten(null) === false, void 0);
check("diary skeleton \u2192 not written", diaryDayWritten("# \u968F\u7B14\n# \u5F53\u65E5\u89E6\u52A8\u70B9\n# \u65E5\u5E38\u884C\u4E3A\u8BB0\u5F55\n## \u4EE3\u529E\u4E8B\u9879\n## \u5B8C\u6210\u60C5\u51B5\u8DDF\u8E2A\n") === false, void 0);
check("diary \u968F\u7B14 block \u2192 written", diaryDayWritten("# \u968F\u7B14\n\n**\u{1F4D6} 09:18**\n\n\u4ECA\u5929\u5199\u4E86\u3002\n") === true, void 0);
check("diary \u89E6\u52A8\u70B9 \u2192 written", diaryDayWritten("# \u5F53\u65E5\u89E6\u52A8\u70B9\n\u67D0\u53E5\u8BDD\u89E6\u52A8\u4E86\u6211\u3002\n") === true, void 0);
check("diary todo-only \u2192 NOT written", diaryDayWritten("# \u968F\u7B14\n## \u4EE3\u529E\u4E8B\u9879\n- [x] 1. \u4EFB\u52A1-09:00\n") === false, void 0);
check("diary tracking-only \u2192 NOT written", diaryDayWritten("# \u968F\u7B14\n## \u5B8C\u6210\u60C5\u51B5\u8DDF\u8E2A\n- [x] \u{1F4DD} \u65E5\u8BB0\n") === false, void 0);
var spec = { plan: "\u5B66\u4E60", name: "\u6587\u732E\u590D\u4E60", label: "\u{1F5E3}\uFE0F", floor: 5, unit: "\u7BC7" };
var modeLine = buildModeCheckLine(spec, "2026-11-08");
check("mode line built", modeLine === "- [ ] \u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7 #\u8BA1\u5212/\u5B66\u4E60 \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08", modeLine);
var diaryLine = buildModeCheckLine({ plan: "\u590D\u76D8", name: "\u65E5\u8BB0", label: "\u{1F4DD}", floor: 0, unit: "" }, "2026-11-08");
check("diary line built", diaryLine === "- [ ] \u{1F4DD} \u65E5\u8BB0 #\u8BA1\u5212/\u590D\u76D8 \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08", diaryLine);
var existingDaily = `## \u2705 \u4ECA\u65E5\u6253\u5361
- [ ] \u{1F4D6} \u5B66\u4E60 1\u5C0F\u65F6 #\u8BA1\u5212/\u5B66\u4E60 \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08
`;
check("missing mode lines: both missing", missingModeLines(existingDaily, [spec, { plan: "\u590D\u76D8", name: "\u65E5\u8BB0", label: "\u{1F4DD}", floor: 0, unit: "" }], "2026-11-08").length === 2, void 0);
var withModeLine = existingDaily + "- [ ] \u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7 #\u8BA1\u5212/\u5B66\u4E60 \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08\n";
check("missing mode lines: review exists", missingModeLines(withModeLine, [spec], "2026-11-08").length === 0, void 0);
check("missing mode lines: label prefix tolerated", missingModeLines(existingDaily + "- [ ] \u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7\uFF08\u5B9E 3\u7BC7\uFF09\u270B #\u8BA1\u5212/\u5B66\u4E60 \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08\n", [spec], "2026-11-08").length === 0, void 0);
var toggled = toggleTaskLine(modeLine, 0, true);
var marked = markTaskLineManual(toggled, 0);
check("manual mark applied", marked.includes(MANUAL_MARK) && marked.startsWith("- [x]"), marked);
check("manual mark idempotent", markTaskLineManual(marked, 0) === marked, void 0);
check("manual actual parsed with \u270B", parseQuotaActual(`\u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7\uFF08\u5B9E 10\u7BC7\uFF09${MANUAL_MARK}`) === 10, void 0);
var rewritten = setQuotaActual(marked, 0, 10, "\u7BC7", true, void 0, true);
check("setQuotaActual keeps manual mark", rewritten.includes(MANUAL_MARK) && rewritten.includes("\uFF08\u5B9E 10\u7BC7\uFF09"), rewritten);
var autoRewrite = setQuotaActual(marked, 0, 3, "\u7BC7", false, void 0, false);
check("auto rewrite strips manual mark", !autoRewrite.includes(MANUAL_MARK) && autoRewrite.startsWith("- [ ]"), autoRewrite);
check("goal name: multi-level leaf", extractGoalName("\u8BA4\u77E5\u89C9\u9192\uFF08\u7B2C 5 \u7AE0\u7B2C 2 \u8282\uFF09") === "\u8BA4\u77E5\u89C9\u9192");
check("goal name: flat leaf", extractGoalName("\u516C\u4F17\u53F7\u6587\u7AE0\uFF08\u7B2C 12 \u7BC7\uFF09") === "\u516C\u4F17\u53F7\u6587\u7AE0");
check("goal name: manual task \u2192 null", extractGoalName("\u8BFB\u4E66\u7B14\u8BB0\u6574\u7406") === null);
check("goal name: bare suffix \u2192 null", extractGoalName("\uFF08\u7B2C 3 \u7BC7\uFF09") === null);
var bookPool = parseTaskPool(
  file,
  [
    // 书 A：今天有到期叶，未读 → scheduled，未完成
    "- [ ] \u8BA4\u77E5\u89C9\u9192\uFF08\u7B2C 5 \u7AE0\u7B2C 2 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08",
    // 书 B：今天的叶已勾，无欠账 → scheduled 且今日份额完成（预读同一口径）
    "- [x] \u601D\u8003\u5FEB\u4E0E\u884C\u4E3A\uFF08\u7B2C 3 \u7AE0\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08",
    // 书 C：只有逾期欠账叶 → scheduled（欠账即今日安排），未完成
    "- [ ] \u88AB\u8BA8\u597D\u7684\u52C7\u6C14\uFF08\u7B2C 2 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-06 \u{1F4C5} 2026-11-06",
    // 书 D：窗口未开始 → 不进分母
    "- [ ] \u672A\u5F00\u59CB\u7684\u4E66\uFF08\u7B2C 1 \u7AE0\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-20 \u{1F4C5} 2026-11-25",
    // 书 E：全部读完（末叶 📅 已过）→ 不进分母
    "- [x] \u5DF2\u8BFB\u5B8C\u7684\u4E66\uFF08\u7B2C 9 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-10-30 \u{1F4C5} 2026-11-01",
    // 书 F：今天的叶已勾 + 昨天欠账未清 → scheduled 但未完成（逾期阻塞，D6）
    "- [ ] \u903E\u671F\u6B20\u8D26\u4E66\uFF08\u7B2C 4 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-07 \u{1F4C5} 2026-11-07",
    "- [x] \u903E\u671F\u6B20\u8D26\u4E66\uFF08\u7B2C 5 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08",
    // 书 G：跨日窗口叶（🛫=今天、📅=明天）已勾 → 窗口覆盖今天，计今日完成
    "- [x] \u8DE8\u65E5\u7A97\u53E3\u4E66\uFF08\u7B2C 2 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-09",
    // 手动任务无目标名后缀 → ungrouped
    "- [ ] \u624B\u52A8\u4EFB\u52A1\u65E0\u540E\u7F00 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08"
  ].join("\n")
);
var bookView = groupPoolTasksByGoal(bookPool, "2026-11-08");
var gByName = new Map(bookView.groups.map((g) => [g.name, g]));
console.log("bookView:", JSON.stringify(bookView.groups.map((g) => ({ name: g.name, scheduled: g.scheduled, pending: g.pending.length, todayDone: g.todayDone.length }))));
check("book groups: 7 books", bookView.groups.length === 7, bookView.groups.length);
check("book groups: file order", bookView.groups.map((g) => g.name).join(",") === "\u8BA4\u77E5\u89C9\u9192,\u601D\u8003\u5FEB\u4E0E\u884C\u4E3A,\u88AB\u8BA8\u597D\u7684\u52C7\u6C14,\u672A\u5F00\u59CB\u7684\u4E66,\u5DF2\u8BFB\u5B8C\u7684\u4E66,\u903E\u671F\u6B20\u8D26\u4E66,\u8DE8\u65E5\u7A97\u53E3\u4E66", bookView.groups.map((g) => g.name).join(","));
check("book groups: manual task ungrouped", bookView.ungrouped.length === 1, bookView.ungrouped.length);
var _a20, _b6, _c3;
check("\u4E66A pending today", ((_a20 = gByName.get("\u8BA4\u77E5\u89C9\u9192")) == null ? void 0 : _a20.scheduled) === true && ((_b6 = gByName.get("\u8BA4\u77E5\u89C9\u9192")) == null ? void 0 : _b6.pending.length) === 1 && ((_c3 = gByName.get("\u8BA4\u77E5\u89C9\u9192")) == null ? void 0 : _c3.todayDone.length) === 0);
var _a21, _b7, _c4;
check("\u4E66B done today (pre-read)", ((_a21 = gByName.get("\u601D\u8003\u5FEB\u4E0E\u884C\u4E3A")) == null ? void 0 : _a21.scheduled) === true && ((_b7 = gByName.get("\u601D\u8003\u5FEB\u4E0E\u884C\u4E3A")) == null ? void 0 : _b7.pending.length) === 0 && ((_c4 = gByName.get("\u601D\u8003\u5FEB\u4E0E\u884C\u4E3A")) == null ? void 0 : _c4.todayDone.length) === 1);
var _a22, _b8;
check("\u4E66C scheduled via overdue", ((_a22 = gByName.get("\u88AB\u8BA8\u597D\u7684\u52C7\u6C14")) == null ? void 0 : _a22.scheduled) === true && ((_b8 = gByName.get("\u88AB\u8BA8\u597D\u7684\u52C7\u6C14")) == null ? void 0 : _b8.pending.length) === 1);
var _a23;
check("\u4E66D not started \u2192 excluded", ((_a23 = gByName.get("\u672A\u5F00\u59CB\u7684\u4E66")) == null ? void 0 : _a23.scheduled) === false);
var _a24;
check("\u4E66E fully read \u2192 excluded", ((_a24 = gByName.get("\u5DF2\u8BFB\u5B8C\u7684\u4E66")) == null ? void 0 : _a24.scheduled) === false);
var _a25, _b9, _c5;
check("\u4E66F overdue blocks done (D6)", ((_a25 = gByName.get("\u903E\u671F\u6B20\u8D26\u4E66")) == null ? void 0 : _a25.scheduled) === true && ((_b9 = gByName.get("\u903E\u671F\u6B20\u8D26\u4E66")) == null ? void 0 : _b9.pending.length) === 1 && ((_c5 = gByName.get("\u903E\u671F\u6B20\u8D26\u4E66")) == null ? void 0 : _c5.todayDone.length) === 1);
var _a26, _b10, _c6;
check("\u4E66G cross-day window counts done", ((_a26 = gByName.get("\u8DE8\u65E5\u7A97\u53E3\u4E66")) == null ? void 0 : _a26.scheduled) === true && ((_b10 = gByName.get("\u8DE8\u65E5\u7A97\u53E3\u4E66")) == null ? void 0 : _b10.pending.length) === 0 && ((_c6 = gByName.get("\u8DE8\u65E5\u7A97\u53E3\u4E66")) == null ? void 0 : _c6.todayDone.length) === 1);
var scheduled = bookView.groups.filter((g) => g.scheduled);
var doneToday = scheduled.filter((g) => g.pending.length === 0);
check("fraction denominator = 5", scheduled.length === 5, scheduled.length);
check("fraction numerator = 2", doneToday.length === 2, doneToday.length);
var knownPool = parseTaskPool(
  file,
  [
    "- [ ] \u5148\u79E6\u7A7F\u8D8A\u751F\u5B58\u624B\u518C\uFF08\u5E8F\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08",
    "- [ ] \u5148\u79E6\u7A7F\u8D8A\u751F\u5B58\u624B\u518C\uFF08\u7B2C\u4E00\u7AE0\u3000\u82F1\u96C4\u96BE\u8FC7\u8BED\u8A00\u5173\xB7\u6B32\u95EF\u5929\u4E0B|\u4E0A\u53E4\u6C49\u8BED\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08",
    "- [ ] \u522B\u7684\u4E66\uFF08\u7B2C 1 \u8282\uFF09 #\u8BA1\u5212/\u9605\u8BFB \u{1F6EB} 2026-11-08 \u{1F4C5} 2026-11-08"
  ].join("\n")
);
var knownView = groupPoolTasksByGoal(knownPool, "2026-11-08", ["\u5148\u79E6\u7A7F\u8D8A\u751F\u5B58\u624B\u518C"]);
check("knownNames: \u65E0\u7F16\u53F7\u540E\u7F00\u53F6\u5F52\u5165\u4E66\u7EC4", knownView.groups.map((g) => g.name).join(",") === "\u5148\u79E6\u7A7F\u8D8A\u751F\u5B58\u624B\u518C,\u522B\u7684\u4E66", JSON.stringify(knownView.groups.map((g) => g.name)));
var _a27, _b11;
check("knownNames: \u4E66\u7EC4\u542B\u4E24\u53F6\u4E14 scheduled", ((_a27 = knownView.groups[0]) == null ? void 0 : _a27.pending.length) === 2 && ((_b11 = knownView.groups[0]) == null ? void 0 : _b11.scheduled) === true);
check("knownNames: \u7F3A\u7701\u7EF4\u6301\u539F\u53E3\u5F84", groupPoolTasksByGoal(knownPool, "2026-11-08").ungrouped.length === 1);
var bookTree = [
  {
    label: "\u7B2C1\u7AE0 \u521D\u89C1",
    href: "c1.xhtml",
    spineIndex: 1,
    children: [
      { label: "1.1 \u76F8\u9047", href: "c1.xhtml#s1", spineIndex: 1, children: [] },
      { label: "1.2 \u79BB\u522B", href: "c1.xhtml#s2", spineIndex: 1, children: [] }
    ]
  },
  { label: "\u7B2C2\u7AE0 \u72EC\u767D", href: "c2.xhtml", spineIndex: 2, children: [] },
  {
    label: "\u7B2C3\u7AE0 \u91CD\u9022",
    href: "c3.xhtml",
    spineIndex: 4,
    children: [{ label: "3.1 \u91CD\u9022", href: "c3.xhtml#s1", spineIndex: 4, children: [] }]
  }
];
var conv = weaveTocToStructure(bookTree);
check("bridge: converts tree", conv !== null);
check("bridge: 2 levels", (conv == null ? void 0 : conv.levels.length) === 2, conv == null ? void 0 : conv.levels.length);
check("bridge: level0 \u7AE0\xD73", (conv == null ? void 0 : conv.levels[0].unit) === "\u7AE0" && conv.levels[0].counts[0] === 3);
check("bridge: level1 \u8282 [2,0,1]", (conv == null ? void 0 : conv.levels[1].unit) === "\u8282" && JSON.stringify(conv.levels[1].counts) === "[2,0,1]", JSON.stringify(conv == null ? void 0 : conv.levels[1].counts));
check("bridge: leaf count 4", (conv == null ? void 0 : conv.leafSpine.length) === 4, conv == null ? void 0 : conv.leafSpine.length);
check("bridge: leafSpine DFS [1,1,2,4]", JSON.stringify(conv == null ? void 0 : conv.leafSpine) === "[1,1,2,4]", JSON.stringify(conv == null ? void 0 : conv.leafSpine));
check("bridge: leafHref DFS", (conv == null ? void 0 : conv.leafHref.join("|")) === "c1.xhtml#s1|c1.xhtml#s2|c2.xhtml|c3.xhtml#s1");
var bridgeLeaves = expandGoalStructure("\u6D4B\u8BD5\u4E66", conv.levels);
check("bridge: alignment invariant (leaves match)", bridgeLeaves.length === conv.leafSpine.length, `${bridgeLeaves.length} vs ${conv.leafSpine.length}`);
check("bridge: upgrade leaf named as chapter", bridgeLeaves.some((l) => l.name.includes("\u7B2C2\u7AE0 \u72EC\u767D")));
check("resume: chapter 2 \u2192 2 pre-read", resumeLeafCount(conv.leafSpine, 2) === 2, resumeLeafCount(conv.leafSpine, 2));
check("resume: 0 for unread book", resumeLeafCount(conv.leafSpine, 0) === 0);
check("resume: all for finished book", resumeLeafCount(conv.leafSpine, 5) === 4);
check("advance: crossed [1,4) \u2192 idx 0,1,2", JSON.stringify(crossedLeafIndices(conv.leafSpine, 1, 4)) === "[0,1,2]", JSON.stringify(crossedLeafIndices(conv.leafSpine, 1, 4)));
check("advance: backward no crossing", crossedLeafIndices(conv.leafSpine, 4, 1).length === 0);
check("passed: chapter 4 \u2192 3 leaves (current excluded)", passedLeafIndices(conv.leafSpine, 4).length === 3);
check("bridge: null for empty tree", weaveTocToStructure(null) === null && weaveTocToStructure([]) === null);
var deep = { label: "\u7B2C1\u6761", href: "d9", spineIndex: 0, children: [] };
for (let i = 0; i < 8; i++)
  deep = { label: `\u7B2C1\u7EA7${8 - i}`, href: `d${8 - i}`, spineIndex: 0, children: [deep] };
check("bridge: >8 levels rejected", weaveTocToStructure([deep]) === null);
check("bridge: single level ok", weaveTocToStructure([{ label: "\u7B2C1\u7AE0", href: "c", spineIndex: 0, children: [] }]) !== null);
var fmReader = `---
plans:
  \u9605\u8BFB:
    type: \u6570\u91CF
    target: \u8BFB\u4E66
    goals:
      - name: \u4EA4\u6613\u5FC3\u7406\u5206\u6790
        count: 17
        unit: \u8282
        structure:
          - unit: \u7AE0
            counts: [17]
        readerSid: epubsrc-d3aedbaff902c0fb5db47804
---
`;
var defsReader = parsePlansFromFrontmatter(fmReader);
var _a28;
var readerGoal = (_a28 = defsReader[0]) == null ? void 0 : _a28.goals[0];
check("readerSid: parsed from frontmatter", (readerGoal == null ? void 0 : readerGoal.readerSid) === "epubsrc-d3aedbaff902c0fb5db47804", readerGoal == null ? void 0 : readerGoal.readerSid);
var _a29, _b12, _c7;
check("readerSid: absent \u2192 undefined", ((_c7 = (_b12 = (_a29 = defs1[0]) == null ? void 0 : _a29.goals) == null ? void 0 : _b12[0]) == null ? void 0 : _c7.readerSid) === void 0);
var autoOf = (text) => isAutoTask({ text, plan: null, checked: false, start: null, due: null, line: 0, raw: "", file: null });
var labeled = expandGoalStructure("\u6D4B\u8BD5\u4E66", [
  { unit: "\u7AE0", counts: [2], labels: ["\u7B2C1\u7AE0 \u521D\u89C1", "\u7B2C2\u7AE0 \u72EC\u767D"] },
  { unit: "\u8282", counts: [2, 0], labels: ["1.1 \u76F8\u9047", "1.2 \u79BB\u522B"] }
]);
var _a30, _b13;
check("labels: \u91CD\u6392\u53F6\u5E26\u7AE0\u8DEF\u5F84\u524D\u7F00", ((_a30 = labeled[0]) == null ? void 0 : _a30.name) === "\u6D4B\u8BD5\u4E66\uFF08\u7B2C1\u7AE0 \u521D\u89C1\xB71.1 \u76F8\u9047\uFF09", (_b13 = labeled[0]) == null ? void 0 : _b13.name);
var _a31, _b14;
check("labels: \u91CD\u6392\u53F62", ((_a31 = labeled[1]) == null ? void 0 : _a31.name) === "\u6D4B\u8BD5\u4E66\uFF08\u7B2C1\u7AE0 \u521D\u89C1\xB71.2 \u79BB\u522B\uFF09", (_b14 = labeled[1]) == null ? void 0 : _b14.name);
var _a32, _b15;
check("labels: \u65E0\u8282\u7AE0\u5347\u683C\u7528\u771F\u5B9E\u6807\u9898", ((_a32 = labeled[2]) == null ? void 0 : _a32.name) === "\u6D4B\u8BD5\u4E66\uFF08\u7B2C2\u7AE0 \u72EC\u767D\uFF09", (_b15 = labeled[2]) == null ? void 0 : _b15.name);
var _a33, _b16;
check("labels: \u7EC4\u6807\u7B7E\u7528\u771F\u5B9E\u6807\u9898", ((_a33 = labeled[0]) == null ? void 0 : _a33.group) === "\u7B2C1\u7AE0 \u521D\u89C1", (_b16 = labeled[0]) == null ? void 0 : _b16.group);
var _a34;
check("labels: \u975E\u91CD\u6392\u53F6\u76F4\u63A5\u7528\u771F\u5B9E\u6807\u9898", ((_a34 = expandGoalStructure("\u4E66", [{ unit: "\u7AE0", counts: [1], labels: ["\u7B2C\u4E00\u56DE \u77F3\u5F52"] }])[0]) == null ? void 0 : _a34.name) === "\u4E66\uFF08\u7B2C\u4E00\u56DE \u77F3\u5F52\uFF09");
check("labels: \u4E2D\u6587\u6570\u5B57\u540E\u7F00\u8BC6\u522B\u4E3A\u81EA\u52A8\u4EFB\u52A1", autoOf("\u4E66\uFF08\u7B2C\u4E00\u56DE \u77F3\u5F52\uFF09") === true);
check("labels: \u6570\u5B57\u540E\u7F00\u8BC6\u522B", autoOf("\u4E66\uFF081.1 \u76F8\u9047\uFF09") === true);
var _a35, _b17;
check("labels: \u5E26\u8DEF\u5F84\u540E\u7F00\u8BC6\u522B", autoOf((_b17 = (_a35 = labeled[0]) == null ? void 0 : _a35.name) != null ? _b17 : "") === true);
check("labels: \u624B\u52A8\u4EFB\u52A1\u4E0D\u8BEF\u5224", autoOf("\u5199\u6587\u7AE0\uFF08\u8349\u7A3F\uFF09") === false);
check("labels: extractGoalName \u5265\u771F\u5B9E\u6807\u9898\u540E\u7F00", extractGoalName("\u4E66\uFF081.1 \u76F8\u9047\uFF09") === "\u4E66");
var _a36;
check("labels: \u7F3A labels \u843D\u751F\u6210\u540D", ((_a36 = expandGoalStructure("\u4E66", [{ unit: "\u7AE0", counts: [2] }])[1]) == null ? void 0 : _a36.name) === "\u4E66\uFF08\u7B2C 2 \u7AE0\uFF09");
var convL = weaveTocToStructure(bookTree);
var _a37, _b18;
check("bridge: labels attached per level", ((_a37 = convL == null ? void 0 : convL.levels[0].labels) == null ? void 0 : _a37[0]) === "\u7B2C1\u7AE0 \u521D\u89C1" && ((_b18 = convL.levels[1].labels) == null ? void 0 : _b18.length) === 3, JSON.stringify(convL == null ? void 0 : convL.levels[1].labels));
var fmLabels = `---
plans:
  \u9605\u8BFB:
    type: \u6570\u91CF
    goals:
      - name: \u6D4B\u8BD5\u4E66
        count: 3
        unit: \u8282
        structure:
          - unit: \u7AE0
            counts: [2]
            labels:
              - \u7B2C1\u7AE0 \u521D\u89C1
              - \u7B2C2\u7AE0 \u72EC\u767D
          - unit: \u8282
            counts: [2, 0]
            labels:
              - 1.1 \u76F8\u9047
              - 1.2 \u79BB\u522B
---
`;
var defsLabels = parsePlansFromFrontmatter(fmLabels);
var _a38, _b19, _c8, _d2, _e, _f, _g, _h, _i;
check("labels: YAML round-trip level0", ((_e = (_d2 = (_c8 = (_b19 = (_a38 = defsLabels[0]) == null ? void 0 : _a38.goals[0]) == null ? void 0 : _b19.structure) == null ? void 0 : _c8[0]) == null ? void 0 : _d2.labels) == null ? void 0 : _e[0]) === "\u7B2C1\u7AE0 \u521D\u89C1", JSON.stringify((_i = (_h = (_g = (_f = defsLabels[0]) == null ? void 0 : _f.goals[0]) == null ? void 0 : _g.structure) == null ? void 0 : _h[0]) == null ? void 0 : _i.labels));
var _a39, _b20, _c9, _d3, _e2;
check("labels: YAML round-trip level1 len 2", ((_e2 = (_d3 = (_c9 = (_b20 = (_a39 = defsLabels[0]) == null ? void 0 : _a39.goals[0]) == null ? void 0 : _b20.structure) == null ? void 0 : _c9[1]) == null ? void 0 : _d3.labels) == null ? void 0 : _e2.length) === 2);
var rl = expandGoalStructure("\u6D4B\u8BD5\u4E66", defsLabels[0].goals[0].structure);
var _a40, _b21;
check("labels: round-trip \u547D\u540D\u7A33\u5B9A", ((_a40 = rl[0]) == null ? void 0 : _a40.name) === "\u6D4B\u8BD5\u4E66\uFF08\u7B2C1\u7AE0 \u521D\u89C1\xB71.1 \u76F8\u9047\uFF09", (_b21 = rl[0]) == null ? void 0 : _b21.name);
check("modeLine: review line matches", matchesModeLine("\u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7\uFF08\u5B9E 7\u7BC7\uFF09", "\u6587\u732E\u590D\u4E60", 5, "\u7BC7"), void 0);
check("modeLine: exercise line matches", matchesModeLine("\u{1F3C3} \u62C9\u5347 1\u6B21", "\u62C9\u5347", 1, "\u6B21"), void 0);
check("modeLine: diary exact matches", matchesModeLine("\u{1F4DD} \u65E5\u8BB0", "\u65E5\u8BB0", 0, ""), void 0);
check("modeLine: parent default line NOT matched (floor>0)", !matchesModeLine("\u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6", "\u8FD0\u52A8", 30, "\u5206\u949F"), void 0);
check("modeLine: parent default line NOT matched (floor=0)", !matchesModeLine("\u{1F4C8} \u65E5\u8BB0 \u590D\u76D8+\u6B21\u65E5\u8BA1\u5212", "\u65E5\u8BB0", 0, ""), void 0);
check("modeLine: wrong floor amount not matched", !matchesModeLine("\u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7", "\u6587\u732E\u590D\u4E60", 10, "\u7BC7"), void 0);
console.log(failed === 0 ? "\nALL PASSED" : `
${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
