// test/obsidian-mock.ts
var TFile = class {
  constructor(path) {
    var _a58;
    this.path = path != null ? path : "";
    this.name = (_a58 = this.path.split("/").pop()) != null ? _a58 : "";
    this.basename = this.name.replace(/\.[^.]+$/, "");
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
var SUMMARY_HEADING = "## \u{1F4DD} \u4ECA\u65E5\u603B\u7ED3";
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
function getISOWeek(dateStr) {
  const d = parseDateString(dateStr);
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week2 = Math.ceil(((date.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return { year: date.getUTCFullYear(), week: week2 };
}
function weekRange(dateStr) {
  const d = parseDateString(dateStr);
  const day = d.getDay() || 7;
  const start = addDays(d, 1 - day);
  return { start: formatDate(start), end: formatDate(addDays(start, 6)) };
}
function daysInMonth(year, month2) {
  return new Date(year, month2, 0).getDate();
}
function dayCount(start, end) {
  const s = parseDateString(start);
  const e = parseDateString(end);
  return Math.round((e.getTime() - s.getTime()) / 864e5) + 1;
}
function countWorkdays(start, end) {
  const s = parseDateString(start);
  const e = parseDateString(end);
  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6)
      count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}
function parseTaskLine(line) {
  var _a58, _b31, _c12;
  const m2 = TASK_LINE_RE.exec(line.trim());
  if (!m2)
    return null;
  return {
    text: m2[2].trim(),
    plan: (_a58 = m2[3]) != null ? _a58 : null,
    checked: m2[1] === "x",
    due: (_c12 = (_b31 = m2[5]) != null ? _b31 : m2[4]) != null ? _c12 : null
  };
}
function parseDailyContent(file2, content, date) {
  var _a58, _b31, _c12, _d5, _e4, _f2;
  const lines = content.split("\n");
  const checkItems = [];
  const tempItems = [];
  let inCheckSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inCheckSection = line.startsWith(CHECK_HEADING);
      continue;
    }
    if (!inCheckSection)
      continue;
    const indent = /^([ \t]+)/.exec(line);
    if (indent) {
      const m3 = TASK_LINE_RE.exec(line.slice(indent[1].length));
      if (!(m3 == null ? void 0 : m3[3]))
        continue;
      const tick = parseTickRow(m3[2].trim());
      if (!tick)
        continue;
      checkItems.push({
        text: m3[2].trim(),
        plan: m3[3],
        checked: m3[1] === "x",
        due: (_b31 = (_a58 = m3[5]) != null ? _a58 : m3[4]) != null ? _b31 : null,
        raw: line,
        line: i,
        file: file2,
        indent: indent[1].length,
        tick
      });
      continue;
    }
    const m2 = TASK_LINE_RE.exec(line);
    if (!m2)
      continue;
    const checked = m2[1] === "x";
    const plan = (_c12 = m2[3]) != null ? _c12 : null;
    const base = {
      text: m2[2].trim(),
      plan,
      checked,
      due: (_e4 = (_d5 = m2[5]) != null ? _d5 : m2[4]) != null ? _e4 : null,
      raw: line
    };
    if (plan) {
      checkItems.push({ ...base, line: i, file: file2 });
    } else {
      tempItems.push({
        ...base,
        start: (_f2 = m2[4]) != null ? _f2 : null,
        source: "daily",
        file: file2,
        index: i,
        line: i,
        togglable: true
      });
    }
  }
  return {
    date,
    file: file2,
    content,
    checkItems,
    tempItems,
    summary: extractSummary(content)
  };
}
function extractSummary(content) {
  const idx = content.indexOf(SUMMARY_HEADING);
  if (idx === -1)
    return "";
  const after = content.slice(idx + SUMMARY_HEADING.length);
  let end = after.length;
  const nextHeading = /\n##\s/.exec(after);
  if (nextHeading)
    end = nextHeading.index;
  let region = after.slice(0, end);
  const callout = /\n\n>/.exec(region);
  if (callout)
    region = region.slice(0, callout.index);
  return region.replace(/^\n+/, "").trimEnd();
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
  if (line === void 0)
    return content;
  const m2 = /^([ \t]*)- \[[ x]\]/.exec(line);
  if (!m2)
    return content;
  lines[idx] = line.replace(/^([ \t]*)- \[[ x]\]/, `${m2[1]}- [${checked ? "x" : " "}]`);
  return lines.join("\n");
}
function moveTaskBlock(content, start, end, delta, expectedRaw) {
  var _a58;
  const lines = content.split("\n");
  let s = start;
  if (expectedRaw && lines[s] !== expectedRaw) {
    s = lines.findIndex((l) => l === expectedRaw);
    if (s === -1)
      return content;
  }
  const e = end < s ? s : end;
  if (s < 0 || e >= lines.length)
    return content;
  if (delta === -1) {
    if (s === 0 || !/^- \[[ x]\]/.test(lines[s - 1]))
      return content;
    const [moved] = lines.splice(s - 1, 1);
    lines.splice(e, 0, moved);
    return lines.join("\n");
  }
  if (delta === 1) {
    if (!/^- \[[ x]\]/.test((_a58 = lines[e + 1]) != null ? _a58 : ""))
      return content;
    const [moved] = lines.splice(e + 1, 1);
    lines.splice(s, 0, moved);
    return lines.join("\n");
  }
  return content;
}
function removeLineBlock(content, start, end, expectedRaw) {
  const lines = content.split("\n");
  let s = start;
  if (expectedRaw && lines[s] !== expectedRaw) {
    s = lines.findIndex((l) => l === expectedRaw);
    if (s === -1)
      return content;
  }
  const e = end < s ? s : end;
  if (s < 0 || e >= lines.length)
    return content;
  lines.splice(s, e - s + 1);
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
function setQuotaActual(content, lineIndex, actual, unit, checked, expectedRaw) {
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
  let rebuilt2 = `- [${checked ? "x" : " "}] ${text}${actualPart}`;
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
function clearManualMark(content, lineIndex, expectedRaw) {
  const lines = content.split("\n");
  let idx = lineIndex;
  if (expectedRaw && lines[idx] !== expectedRaw) {
    idx = lines.findIndex((l) => l === expectedRaw);
    if (idx === -1)
      return content;
  }
  const line = lines[idx];
  if (line === void 0 || !line.includes(MANUAL_MARK))
    return content;
  const m2 = TASK_LINE_RE.exec(line.trim());
  if (!m2)
    return content;
  let rebuilt2 = `- [${m2[1]}] ${m2[2].replace(MANUAL_MARK, "").trimEnd()}`;
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
var SPLIT_EXCLUDED_UNITS = ["\u5206\u949F", "\u5C0F\u65F6", "\u516C\u91CC", "\u5343\u5361"];
function splitTickCount(floor, unit) {
  return floor >= 2 && !SPLIT_EXCLUDED_UNITS.includes(unit) ? Math.floor(floor) : 0;
}
function modeLineAmount(mode, floor, unit) {
  return mode === "chore" ? { floor: 0, unit: "" } : { floor: floor != null ? floor : 0, unit: unit != null ? unit : "" };
}
function parseTickRow(text) {
  var _a58;
  const stripped = text.trim().replace(/^[^\w\u4e00-\u9fff]+/, "").trim();
  const m2 = /^(.+?)第(\d+)(\S*)$/.exec(stripped);
  if (!m2)
    return null;
  const k = parseInt(m2[2], 10);
  if (!Number.isFinite(k) || k <= 0)
    return null;
  return { base: m2[1].trim(), k, unit: (_a58 = m2[3]) != null ? _a58 : "" };
}
function buildTickLine(name, k, plan, date, unit = "") {
  return `	- [ ] ${name}\u7B2C${k}${unit} #\u8BA1\u5212/${plan} \u{1F6EB} ${date} \u{1F4C5} ${date}`;
}
function tickAnchorOf(checkItems, tick, isModeLine2) {
  var _a58, _b31;
  const indent = (_a58 = tick.indent) != null ? _a58 : 0;
  if (!tick.plan || indent <= 0)
    return null;
  const at = checkItems.indexOf(tick);
  for (let j = at - 1; j >= 0; j--) {
    const cand = checkItems[j];
    if (!cand.plan || cand.plan !== tick.plan)
      continue;
    if (((_b31 = cand.indent) != null ? _b31 : 0) >= indent)
      continue;
    if (cand.tick)
      return null;
    if (!isModeLine2(cand))
      return null;
    const stripped = cand.text.replace(/^[^\w\u4e00-\u9fff]+/, "").trim();
    if (tick.tick && stripped.startsWith(tick.tick.base))
      return cand;
  }
  return null;
}
function tickChildrenOf(checkItems, anchor, isModeLine2) {
  return checkItems.filter((it) => it.tick && tickAnchorOf(checkItems, it, isModeLine2) === anchor);
}
function renameTickRowBase(content, plan, oldName, newName) {
  let inCheck = false;
  return content.split("\n").map((line) => {
    if (/^##\s/.test(line)) {
      inCheck = line.startsWith(CHECK_HEADING);
      return line;
    }
    if (!inCheck)
      return line;
    const indent = /^([ \t]+)/.exec(line);
    if (!indent)
      return line;
    const m2 = TASK_LINE_RE.exec(line.slice(indent[1].length));
    if (!m2 || m2[3] !== plan)
      return line;
    const text = m2[2].trim();
    const t = parseTickRow(text);
    if (!t || t.base !== oldName)
      return line;
    const idx = line.indexOf(text);
    if (idx === -1)
      return line;
    return line.slice(0, idx) + `${newName}\u7B2C${t.k}${t.unit}` + line.slice(idx + text.length);
  }).join("\n");
}
function choreTickLineIndices(content, plan, name) {
  let inCheck = false;
  const out = [];
  content.split("\n").forEach((line, i) => {
    if (/^##\s/.test(line)) {
      inCheck = line.startsWith(CHECK_HEADING);
      return;
    }
    if (!inCheck)
      return;
    const indent = /^([ \t]+)/.exec(line);
    if (!indent)
      return;
    const m2 = TASK_LINE_RE.exec(line.slice(indent[1].length));
    if (!m2 || m2[3] !== plan)
      return;
    const t = parseTickRow(m2[2].trim());
    if (t && t.base === name)
      out.push(i);
  });
  return out;
}
function reconcileTickRows(content, spec2, n, date) {
  var _a58;
  const lines = content.split("\n");
  let inCheck = false;
  let anchorIdx = -1;
  const ticks = [];
  const removeIdx = /* @__PURE__ */ new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inCheck = line.startsWith(CHECK_HEADING);
      continue;
    }
    if (!inCheck)
      continue;
    const indent = /^([ \t]+)/.exec(line);
    const m2 = TASK_LINE_RE.exec(indent ? line.slice(indent[1].length) : line);
    if (!m2 || !m2[3] || m2[3] !== spec2.plan)
      continue;
    const text = m2[2].trim();
    if (indent) {
      const t = parseTickRow(text);
      if (!t || t.base !== spec2.name)
        continue;
      if (t.unit !== spec2.unit) {
        if (m2[1] === " ")
          removeIdx.add(i);
        continue;
      }
      ticks.push({ idx: i, k: t.k, checked: m2[1] === "x", raw: line });
      continue;
    }
    if (anchorIdx === -1 && matchesModeLine(text, spec2.name, spec2.floor, spec2.unit))
      anchorIdx = i;
  }
  if (anchorIdx === -1)
    return content;
  const keepByK = /* @__PURE__ */ new Map();
  const seenK = /* @__PURE__ */ new Set();
  const ordered = [...ticks].sort((a, b) => a.k - b.k || a.idx - b.idx);
  for (const t of ordered) {
    const dup = seenK.has(t.k);
    seenK.add(t.k);
    if (dup && !t.checked) {
      removeIdx.add(t.idx);
    } else if (t.k > n && !t.checked) {
      removeIdx.add(t.idx);
    } else {
      const arr = (_a58 = keepByK.get(t.k)) != null ? _a58 : [];
      arr.push(t.raw);
      keepByK.set(t.k, arr);
      removeIdx.add(t.idx);
    }
  }
  if (keepByK.size === 0 && removeIdx.size === 0 && n === 0)
    return content;
  const blockLines = [];
  for (let k = 1; k <= n; k++) {
    const arr = keepByK.get(k);
    if (arr)
      blockLines.push(...arr);
    else
      blockLines.push(buildTickLine(spec2.name, k, spec2.plan, date, spec2.unit));
  }
  for (const k of [...keepByK.keys()].sort((a, b) => a - b)) {
    if (k > n)
      blockLines.push(...keepByK.get(k));
  }
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === anchorIdx) {
      result.push(lines[i]);
      result.push(...blockLines);
      continue;
    }
    if (removeIdx.has(i))
      continue;
    result.push(lines[i]);
  }
  return result.join("\n");
}
function subItemMirrorTargets(content, specs) {
  const lines = content.split("\n");
  let inCheck = false;
  const anchorAt = specs.map(() => null);
  const allChecked = specs.map(() => []);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inCheck = line.startsWith(CHECK_HEADING);
      continue;
    }
    if (!inCheck)
      continue;
    const indent = /^([ \t]+)/.exec(line);
    const m2 = TASK_LINE_RE.exec(indent ? line.slice(indent[1].length) : line);
    if (!m2 || !m2[3])
      continue;
    const text = m2[2].trim();
    if (indent) {
      const t = parseTickRow(text);
      if (!t)
        continue;
      const si2 = specs.findIndex(
        (s, si3) => m2[3] === s.plan && t.base === s.name && t.unit === (s.unit || "") && anchorAt[si3] !== null
      );
      if (si2 !== -1)
        allChecked[si2].push(m2[1] === "x");
      continue;
    }
    const si = specs.findIndex((s) => m2[3] === s.plan && matchesModeLine(text, s.name, s.floor, s.unit));
    if (si !== -1 && anchorAt[si] === null) {
      anchorAt[si] = { idx: i, raw: line, checked: m2[1] === "x" };
    }
  }
  const out = [];
  specs.forEach((s, si) => {
    const at = anchorAt[si];
    if (!at || allChecked[si].length === 0)
      return;
    const derived = allChecked[si].every(Boolean);
    if (at.checked !== derived)
      out.push({ line: at.idx, raw: at.raw, checked: derived });
  });
  return out;
}
function splitTicksDone(checkItems, plan, name, unit, n) {
  if (n < 2)
    return false;
  const byK = /* @__PURE__ */ new Map();
  for (const it of checkItems) {
    if (!it.tick || it.plan !== plan)
      continue;
    if (it.tick.base !== name || it.tick.unit !== (unit || ""))
      continue;
    byK.set(it.tick.k, it.checked);
  }
  for (let k = 1; k <= n; k++)
    if (!byK.get(k))
      return false;
  return true;
}
function topLevelCheckRows(checkItems, isModeLine2) {
  var _a58, _b31;
  const childrenOf = /* @__PURE__ */ new Map();
  const ticksByAnchor = /* @__PURE__ */ new Map();
  const isChild = /* @__PURE__ */ new Set();
  for (const item of checkItems) {
    if (!item.plan || !item.tick)
      continue;
    const anchor = tickAnchorOf(checkItems, item, isModeLine2);
    if (!anchor)
      continue;
    isChild.add(item);
    const arr = (_a58 = ticksByAnchor.get(anchor)) != null ? _a58 : [];
    arr.push(item);
    ticksByAnchor.set(anchor, arr);
  }
  for (const item of checkItems) {
    if (!item.plan || item.tick || !isModeLine2(item))
      continue;
    const parent = checkItems.find((it) => it.plan === item.plan && !it.tick && !isModeLine2(it));
    if (!parent)
      continue;
    isChild.add(item);
    const arr = (_b31 = childrenOf.get(parent)) != null ? _b31 : [];
    arr.push(item);
    childrenOf.set(parent, arr);
  }
  const childDone = (c) => {
    var _a59;
    if (c.checked)
      return true;
    const ticks = (_a59 = ticksByAnchor.get(c)) != null ? _a59 : [];
    return ticks.length > 0 && ticks.every((t) => t.checked);
  };
  return checkItems.filter((it) => !isChild.has(it)).map((item) => {
    var _a59;
    const modeChildren = (_a59 = childrenOf.get(item)) != null ? _a59 : [];
    return {
      item,
      modeChildren,
      done: item.checked || modeChildren.length > 0 && modeChildren.every(childDone)
    };
  });
}
function matchesWritingLine(text, name) {
  const stripped = text.trim().replace(/^(?:[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s])+/u, "").trim();
  if (!stripped.startsWith(name))
    return false;
  const rest = stripped.slice(name.length);
  return /\d/.test(rest);
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
    if ((m2 == null ? void 0 : m2[3]) && !parseTickRow(m2[2].trim()))
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
function repointModeLineAmounts(content, specs) {
  const lines = content.split("\n");
  let inCheck = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inCheck = line.startsWith(CHECK_HEADING);
      continue;
    }
    if (!inCheck)
      continue;
    const m2 = TASK_LINE_RE.exec(line);
    if (!m2 || !m2[3])
      continue;
    const text = m2[2].trim();
    const stripped = text.replace(/^[^\w\u4e00-\u9fff]+/, "").trim();
    if (parseTickRow(stripped))
      continue;
    const tailMatch = /(?:（实[^）]*）\s*✋?\s*|✋\s*)$/.exec(text);
    const tail = tailMatch ? tailMatch[0] : "";
    const base = text.slice(0, text.length - tail.length).trimEnd();
    const baseStripped = base.replace(/^[^\w\u4e00-\u9fff]+/, "").trim();
    const prefixLen = base.length - baseStripped.length;
    const prefix = base.slice(0, prefixLen);
    for (const spec2 of specs) {
      if (m2[3] !== spec2.plan)
        continue;
      const nameEsc = spec2.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const shape = new RegExp(`^${nameEsc}(?: (\\d+(?:\\.\\d+)?)(\\S*))?$`).exec(baseStripped);
      if (!shape)
        continue;
      const hasAmount = shape[1] !== void 0;
      const amountOk = hasAmount && Number(shape[1]) === spec2.floor && shape[2] === (spec2.unit || "");
      let newStripped = null;
      if (spec2.floor > 0) {
        if (!amountOk)
          newStripped = `${spec2.name} ${formatQuotaAmount(spec2.floor)}${spec2.unit || ""}`;
      } else if (hasAmount) {
        newStripped = spec2.name;
      }
      if (newStripped === null)
        break;
      let rebuilt2 = `- [${m2[1]}] ${prefix}${newStripped}${tail}`;
      if (m2[3])
        rebuilt2 += ` #\u8BA1\u5212/${m2[3]}`;
      if (m2[4])
        rebuilt2 += ` \u{1F6EB} ${m2[4]}`;
      if (m2[5])
        rebuilt2 += ` \u{1F4C5} ${m2[5]}`;
      lines[i] = rebuilt2;
      break;
    }
  }
  return lines.join("\n");
}
function ensureModeParentLines(content, parents, isModeLineText) {
  if (parents.length === 0)
    return content;
  const lines = content.split("\n");
  let inCheck = false;
  const hasNonMode = /* @__PURE__ */ new Set();
  const strayIdx = /* @__PURE__ */ new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inCheck = line.startsWith(CHECK_HEADING);
      continue;
    }
    if (!inCheck)
      continue;
    const m2 = TASK_LINE_RE.exec(line);
    if (!m2 || !m2[3])
      continue;
    const text = m2[2].trim();
    const stripped = text.replace(/^[^\w\u4e00-\u9fff]+/, "").trim();
    const modeSide = !!parseTickRow(stripped) || isModeLineText(m2[3], text);
    if (!modeSide) {
      hasNonMode.add(m2[3]);
      continue;
    }
    if (strayIdx.has(m2[3]))
      continue;
    const own = parents.find((p) => p.plan === m2[3]);
    if (own && stripped !== own.plan)
      strayIdx.set(m2[3], i);
  }
  const insertions = [];
  for (const p of parents) {
    if (hasNonMode.has(p.plan))
      continue;
    const idx = strayIdx.get(p.plan);
    if (idx === void 0)
      continue;
    insertions.push({ idx, line: p.line });
  }
  insertions.sort((a, b) => b.idx - a.idx);
  for (const ins of insertions)
    lines.splice(ins.idx, 0, ins.line);
  return lines.join("\n");
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
function parentCheckTargets(content, facts, isModeLineText, isTickLineText) {
  var _a58, _b31;
  const factByPlan = new Map(facts.map((f) => [f.plan, f]));
  const modesDone = /* @__PURE__ */ new Map();
  const parentAt = /* @__PURE__ */ new Map();
  const lines = content.split("\n");
  let inCheck = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inCheck = line.startsWith(CHECK_HEADING);
      continue;
    }
    if (!inCheck)
      continue;
    const m2 = TASK_LINE_RE.exec(line);
    if (!m2 || !m2[3])
      continue;
    const plan = m2[3];
    const fact = factByPlan.get(plan);
    if (!fact || !fact.live && !fact.factDone)
      continue;
    const text = m2[2].trim();
    if (isTickLineText == null ? void 0 : isTickLineText(plan, text))
      continue;
    if (isModeLineText(plan, text)) {
      const checked = m2[1] === "x";
      modesDone.set(plan, ((_a58 = modesDone.get(plan)) != null ? _a58 : true) && checked);
      continue;
    }
    if (!parentAt.has(plan))
      parentAt.set(plan, { line: i, raw: line, checked: m2[1] === "x" });
  }
  const out = [];
  for (const [plan, at] of parentAt) {
    const fact = factByPlan.get(plan);
    if (at.checked || at.raw.includes(MANUAL_MARK))
      continue;
    if (fact.factDone) {
      out.push({ line: at.line, raw: at.raw, plan });
      continue;
    }
    if (((_b31 = modesDone.get(plan)) != null ? _b31 : true) && fact.pendingEmpty)
      out.push({ line: at.line, raw: at.raw, plan });
  }
  return out;
}
var CHORE_UNIT_ALIASES = [
  [/^(day|daily|每天|每日|天天)$/, "day"],
  [/^(week|weekly|每周|周)$/, "week"],
  [/^(month|monthly|每月|月)$/, "month"],
  [/^(year|yearly|annual|每年|年)$/, "year"]
];
function parseChoreCycle(raw) {
  var _a58, _b31;
  if (!raw || typeof raw !== "object")
    return void 0;
  const rec = raw;
  const unitRaw = typeof rec.unit === "string" ? rec.unit : typeof rec["\u5355\u4F4D"] === "string" ? String(rec["\u5355\u4F4D"]) : "";
  const v = unitRaw.trim().toLowerCase();
  if (!v)
    return void 0;
  const unit = (_a58 = CHORE_UNIT_ALIASES.find(([re]) => re.test(v))) == null ? void 0 : _a58[1];
  if (!unit)
    return void 0;
  const daysRaw = (_b31 = rec.days) != null ? _b31 : rec["\u65E5\u5B50"];
  const toInt = (x) => typeof x === "number" ? x : parseInt(String(x).trim(), 10);
  const list = (Array.isArray(daysRaw) ? daysRaw : String(daysRaw != null ? daysRaw : "").replace(/[[\]]/g, "").split(/[,，\s]+/)).map(toInt).filter((n) => Number.isFinite(n));
  if (unit === "day")
    return { unit, days: [] };
  if (unit === "week") {
    const days = [...new Set(list.filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b);
    return days.length > 0 ? { unit, days } : void 0;
  }
  if (unit === "month") {
    const days = [...new Set(list.filter((n) => n >= 1 && n <= 31))].sort((a, b) => a - b);
    return days.length > 0 ? { unit, days } : void 0;
  }
  if (list.length !== 2)
    return void 0;
  const [mm, dd] = list;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31)
    return void 0;
  return { unit, days: [mm, dd] };
}
function parseChoreOverdue(raw) {
  const v = String(raw != null ? raw : "").trim().toLowerCase();
  return /^(postpone|defer|往后延|顺延|延后)$/.test(v) ? "postpone" : void 0;
}
var CHORE_WEEKDAY_SHORT = ["\u65E5", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D"];
function choreCycleLabel(cycle, overdue, floor = 0, unit = "") {
  let base;
  if (cycle.unit === "day") {
    const n = splitTickCount(floor, unit);
    base = n > 0 ? `\u6BCF\u5929 ${n}${unit || "\u6B21"}` : "\u6BCF\u5929";
  } else if (cycle.unit === "week") {
    const ds = [...cycle.days].sort((a, b) => a - b);
    base = `\u6BCF${ds.map((d) => {
      var _a58;
      return `\u5468${(_a58 = CHORE_WEEKDAY_SHORT[d]) != null ? _a58 : "?"}`;
    }).join("\u3001")}`;
  } else if (cycle.unit === "month") {
    const ds = [...cycle.days].sort((a, b) => a - b);
    base = `\u6BCF\u6708 ${ds.join("\u3001")} \u53F7`;
  } else {
    const [mm, dd] = cycle.days;
    base = `\u6BCF\u5E74 ${mm} \u6708 ${dd} \u65E5`;
  }
  return overdue === "postpone" ? `${base} \xB7 \u6F0F\u4E86\u5F80\u540E\u5EF6` : base;
}
function isChoreDueOn(cycle, date) {
  const d = parseDateString(date);
  if (cycle.unit === "day")
    return true;
  if (cycle.unit === "week")
    return cycle.days.includes(d.getDay());
  const dim = daysInMonth(d.getFullYear(), d.getMonth() + 1);
  const dayOfMonth = d.getDate();
  if (cycle.unit === "month") {
    return cycle.days.some((x) => x === dayOfMonth || x > dim && dayOfMonth === dim);
  }
  const [mm, dd] = cycle.days;
  return d.getMonth() + 1 === mm && (dd === dayOfMonth || dd > dim && dayOfMonth === dim);
}
function prevChoreOccurrence(cycle, date) {
  if (cycle.unit === "day")
    return date;
  let cur = parseDateString(date);
  for (let i = 0; i < 400; i++) {
    const s = formatDate(cur);
    if (isChoreDueOn(cycle, s))
      return s;
    cur = addDays(cur, -1);
  }
  return date;
}
function nextChoreOccurrence(cycle, date) {
  let cur = addDays(parseDateString(date), 1);
  for (let i = 0; i < 400; i++) {
    const s = formatDate(cur);
    if (isChoreDueOn(cycle, s))
      return s;
    cur = addDays(cur, 1);
  }
  return date;
}
function choreOccurrences(cycle, start, end, cap = 400) {
  const out = [];
  if (start > end)
    return out;
  let cur = parseDateString(start);
  for (let i = 0; i < 800; i++) {
    const s = formatDate(cur);
    if (s > end)
      break;
    if (isChoreDueOn(cycle, s)) {
      out.push(s);
      if (out.length >= cap)
        break;
    }
    cur = addDays(cur, 1);
  }
  return out;
}
function missingChoreLines(content, specs, date) {
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
    if (!(m2 == null ? void 0 : m2[3]))
      continue;
    existing.add(`${m2[3]}|${m2[2].trim()}`);
  }
  const out = [];
  for (const s of specs) {
    let found = false;
    for (const key of existing) {
      const [plan, text] = key.split("|");
      if (plan === s.plan && matchesModeLine(text, s.name, 0, "")) {
        found = true;
        break;
      }
    }
    if (!found)
      out.push(buildModeCheckLine({ plan: s.plan, name: s.name, label: "", floor: 0, unit: "" }, date));
  }
  return out;
}
async function scanChoreHit(app, prefix, plan, name, from, to, backward = false, floor = 0, unit = "") {
  const fmt = (d) => formatDate(d);
  const splitN = splitTickCount(floor, unit);
  let cur = backward ? parseDateString(to) : parseDateString(from);
  const stopAt = backward ? from : to;
  for (let i = 0; i < 800; i++) {
    const ds = fmt(cur);
    if (backward ? ds < stopAt : ds > stopAt)
      return false;
    const f = app.vault.getAbstractFileByPath(`${prefix}${ds}.md`);
    if (f instanceof TFile) {
      const content = await app.vault.cachedRead(f);
      let inCheck = false;
      const ticks = /* @__PURE__ */ new Map();
      for (const line of content.split("\n")) {
        if (/^##\s/.test(line)) {
          inCheck = line.startsWith(CHECK_HEADING);
          continue;
        }
        if (!inCheck)
          continue;
        const indent = /^([ \t]+)/.exec(line);
        const m2 = TASK_LINE_RE.exec(indent ? line.slice(indent[1].length) : line);
        if (!m2 || m2[3] !== plan)
          continue;
        const text = m2[2].trim();
        if (indent) {
          if (splitN === 0)
            continue;
          const t = parseTickRow(text);
          if (t && t.base === name && t.unit === (unit || ""))
            ticks.set(t.k, m2[1] === "x");
          continue;
        }
        if (m2[1] === "x" && matchesModeLine(text, name, 0, ""))
          return true;
      }
      if (splitN > 0) {
        let all = true;
        for (let k = 1; k <= splitN; k++) {
          if (!ticks.get(k)) {
            all = false;
            break;
          }
        }
        if (all)
          return true;
      }
    }
    cur = addDays(cur, backward ? -1 : 1);
  }
  return false;
}
function parseTempTasksFromFrontmatter(content, file2, source) {
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!fmMatch)
    return [];
  let data;
  try {
    const parsed2 = parseYaml(fmMatch[1]);
    data = parsed2 && typeof parsed2 === "object" ? parsed2 : null;
  } catch (e) {
    return [];
  }
  const raw = data == null ? void 0 : data["temp-tasks"];
  if (raw === void 0 || raw === null)
    return [];
  const tasks2 = [];
  if (typeof raw === "string") {
    raw.split("\n").forEach((line, i) => {
      const t = parseTaskLine(line);
      if (!t)
        return;
      tasks2.push({
        text: t.text,
        plan: t.plan,
        checked: t.checked,
        due: t.due,
        start: null,
        source,
        file: file2,
        index: i,
        line: -1,
        raw: line.trim(),
        togglable: true
      });
    });
  } else if (Array.isArray(raw)) {
    raw.forEach((el, i) => {
      var _a58;
      if (typeof el === "string") {
        const t = parseTaskLine(el);
        if (!t)
          return;
        tasks2.push({
          text: t.text,
          plan: t.plan,
          checked: t.checked,
          due: t.due,
          start: null,
          source,
          file: file2,
          index: i,
          line: -1,
          raw: el.trim(),
          togglable: true
        });
      } else if (el && typeof el === "object") {
        const obj = el;
        const start = typeof obj.start === "string" ? obj.start : null;
        const end = typeof obj.end === "string" ? obj.end : null;
        tasks2.push({
          text: typeof obj.name === "string" ? obj.name : JSON.stringify(obj),
          plan: null,
          checked: false,
          due: (_a58 = end != null ? end : start) != null ? _a58 : null,
          start,
          source,
          file: file2,
          index: i,
          line: -1,
          raw: "",
          togglable: false
        });
      }
    });
  }
  return tasks2;
}

// src/paths.ts
var YEAR_DIR_PREFIX = "\u8BA1\u5212";
function yearDirName(year) {
  return `${YEAR_DIR_PREFIX}${year}`;
}
function bareYear(yearDir) {
  return yearDir.startsWith(YEAR_DIR_PREFIX) ? yearDir.slice(YEAR_DIR_PREFIX.length) : yearDir;
}

// src/tasks.ts
function poolPath(rootPath, year) {
  const root = rootPath.replace(/\/+$/, "");
  return `${root}/${yearDirName(year)}/\u4EFB\u52A1.md`;
}
function parseTaskPool(file2, content) {
  var _a58, _b31, _c12;
  const tasks2 = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m2 = TASK_LINE_RE.exec(lines[i]);
    if (!m2)
      continue;
    tasks2.push({
      text: m2[2].trim(),
      plan: (_a58 = m2[3]) != null ? _a58 : null,
      checked: m2[1] === "x",
      start: (_b31 = m2[4]) != null ? _b31 : null,
      due: (_c12 = m2[5]) != null ? _c12 : null,
      line: i,
      raw: lines[i],
      file: file2
    });
  }
  return tasks2;
}
async function listTasks(app, rootPath, year) {
  const f = app.vault.getAbstractFileByPath(poolPath(rootPath, year));
  if (!(f instanceof TFile))
    return [];
  const content = await app.vault.cachedRead(f);
  return parseTaskPool(f, content);
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
    var _a58, _b31;
    const s = (_a58 = t.start) != null ? _a58 : t.due;
    const d = (_b31 = t.due) != null ? _b31 : t.start;
    return !!s && !!d && s <= today && today <= d;
  };
  const groups = [];
  for (const [name, groupTasks] of byName) {
    const pending = groupTasks.filter((t) => {
      var _a58;
      if (t.checked)
        return false;
      const effStart = (_a58 = t.start) != null ? _a58 : t.due;
      return !!effStart && effStart <= today;
    });
    const todayDone = groupTasks.filter((t) => t.checked && coversToday(t));
    const scheduled2 = pending.length > 0 || groupTasks.some(coversToday);
    groups.push({ name, tasks: groupTasks, pending, todayDone, scheduled: scheduled2 });
  }
  return { groups, ungrouped };
}
function diffShareClear(prev, entries) {
  const next = /* @__PURE__ */ new Map();
  const cleared2 = [];
  for (const e of entries) {
    next.set(e.key, e.cleared);
    if ((prev == null ? void 0 : prev.get(e.key)) === false && e.cleared)
      cleared2.push(e.name);
  }
  return { next, cleared: cleared2 };
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
  var _a58;
  const list = UNIT_SUCCESSORS[prevUnit.trim()];
  return (_a58 = list == null ? void 0 : list[0]) != null ? _a58 : "\u8282";
}
function isRestartUnit(word) {
  return RESTART_UNITS.has(word.trim());
}
function expandGoalStructure(goalName, levels) {
  var _a58, _b31, _c12;
  const clean = (v) => {
    const n = typeof v === "number" ? Math.floor(v) : parseInt(String(v), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > 8)
    return [];
  const labelAt = (li, g) => {
    var _a59, _b32, _c13;
    return String((_c13 = (_b32 = (_a59 = levels[li]) == null ? void 0 : _a59.labels) == null ? void 0 : _b32[g - 1]) != null ? _c13 : "").trim();
  };
  let level = [];
  let roots = [];
  for (let li = 0; li < levels.length; li++) {
    const unit = String((_b31 = (_a58 = levels[li]) == null ? void 0 : _a58.unit) != null ? _b31 : "").trim();
    if (!unit)
      return [];
    const restart = RESTART_UNITS.has(unit);
    const next = [];
    let g = 0;
    if (li === 0) {
      const n = clean((_c12 = levels[0].counts) == null ? void 0 : _c12[0]);
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
  var _a58, _b31;
  if ((_a58 = goal.structure) == null ? void 0 : _a58.length)
    return expandGoalStructure(goalName, goal.structure);
  if ((_b31 = goal.chapters) == null ? void 0 : _b31.length)
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
  var _a58, _b31;
  return (_b31 = (_a58 = snap2.byDay.get(localDay)) == null ? void 0 : _a58.size) != null ? _b31 : 0;
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
function reviewPoolSize(app, snap2) {
  if (!snap2.poolFolder)
    return 0;
  const prefix = `${snap2.poolFolder.replace(/\/+$/, "")}/`;
  return app.vault.getFiles().filter((f) => f.path.startsWith(prefix) && f.path.endsWith(".md")).length;
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
async function readBzgDiaryText(app, snap2, date) {
  const path = `${snap2.diaryDir}/${date}.md`;
  try {
    const f = app.vault.getAbstractFileByPath(path);
    if (!f)
      return null;
    return await app.vault.cachedRead(f);
  } catch (e) {
    return null;
  }
}

// src/stats.ts
function computeQuotaDaily(total, start, end) {
  const days = dayCount(start, end);
  if (days <= 0)
    return total;
  return Math.round(total / days * 10) / 10;
}
function computeWritingDaily(total, initial, start, end) {
  return computeQuotaDaily(Math.max(0, total - initial), start, end);
}
function quotaExpected(dailyQuota, start, end, today) {
  if (today < start)
    return 0;
  const until = today > end ? end : today;
  return Math.round(dailyQuota * dayCount(start, until) * 10) / 10;
}
async function readPlanPeriod(app, rootPath, year) {
  var _a58, _b31;
  const root = rootPath.replace(/\/+$/, "");
  for (const path of [`${root}/${yearDirName(year)}/\u5E74\u5EA6\u8BA1\u5212.md`, `${root}/\u5E74\u5EA6\u8BA1\u5212.md`]) {
    const f = app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile))
      continue;
    const fm = parseYaml((_b31 = (_a58 = (await app.vault.cachedRead(f)).match(/^---\n([\s\S]*?)\n---/)) == null ? void 0 : _a58[1]) != null ? _b31 : "");
    if (typeof (fm == null ? void 0 : fm.start) === "string" && typeof (fm == null ? void 0 : fm.end) === "string") {
      return { start: fm.start, end: fm.end };
    }
    return null;
  }
  return null;
}
async function readAnnualDefs(app, rootPath, year) {
  const root = rootPath.replace(/\/+$/, "");
  for (const path of [`${root}/${yearDirName(year)}/\u5E74\u5EA6\u8BA1\u5212.md`, `${root}/\u5E74\u5EA6\u8BA1\u5212.md`]) {
    const f = app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      return parsePlansFromFrontmatter(await app.vault.cachedRead(f));
    }
  }
  return [];
}
async function computePeriodStats(app, rootPath, today, type, reviewWorkdays, bzg) {
  var _a58, _b31, _c12, _d5, _e4, _f2, _g2, _h2, _i2;
  const period = resolvePeriod(today, type);
  let { start, end, label, yearDir } = period;
  const year = bareYear(yearDir);
  if (type === "year") {
    const planPeriod = await readPlanPeriod(app, rootPath, year);
    if (planPeriod) {
      start = planPeriod.start;
      end = planPeriod.end;
    }
  }
  const defs = await readAnnualDefs(app, rootPath, year);
  const quotaDefs = defs.filter((d) => d.type === "quota" && d.quota);
  const quotaPlans = new Set(quotaDefs.map((d) => d.name));
  const choreDefs = defs.filter((d) => hasChoreGoal(d));
  const chorePlanNames = new Set(choreDefs.map((d) => d.name));
  const choreChecks = /* @__PURE__ */ new Set();
  const prefix = `${rootPath}/${yearDir}/\u6BCF\u65E5/`;
  const dailyFiles = app.vault.getFiles().filter((f) => f.path.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name));
  const planDays = /* @__PURE__ */ new Map();
  const planCheckDates = /* @__PURE__ */ new Set();
  const planSeen = /* @__PURE__ */ new Set();
  const quotaActual = /* @__PURE__ */ new Map();
  for (const file2 of dailyFiles) {
    const date = file2.basename;
    if (date < start || date > end)
      continue;
    const content = await app.vault.cachedRead(file2);
    const data = parseDailyContent(file2, content, date);
    const checkedPlans = /* @__PURE__ */ new Set();
    for (const item of data.checkItems) {
      if (!item.plan)
        continue;
      if (item.tick)
        continue;
      if (quotaPlans.has(item.plan)) {
        if (item.checked) {
          const q = (_a58 = quotaDefs.find((d) => d.name === item.plan)) == null ? void 0 : _a58.quota;
          if (!q)
            continue;
          const qStart = (_b31 = q.start) != null ? _b31 : start;
          const actual = (_d5 = (_c12 = parseQuotaActual(item.text)) != null ? _c12 : parseQuotaAmount(item.text)) != null ? _d5 : computeQuotaDaily(q.total, qStart, q.end);
          quotaActual.set(item.plan, ((_e4 = quotaActual.get(item.plan)) != null ? _e4 : 0) + actual);
        }
        continue;
      }
      if (chorePlanNames.has(item.plan)) {
        const def = choreDefs.find((d) => d.name === item.plan);
        const g = def == null ? void 0 : def.goals.find((x) => x.mode === "chore" && matchesModeLine(item.text, x.name, 0, ""));
        if (g) {
          const cycle = (_f2 = g.cycle) != null ? _f2 : { unit: "day", days: [] };
          const n = cycle.unit === "day" ? splitTickCount((_g2 = g.floor) != null ? _g2 : 0, g.unit || "") : 0;
          const hit = item.checked || n > 0 && splitTicksDone(data.checkItems, item.plan, g.name, g.unit || "", n);
          if (hit)
            choreChecks.add(`${item.plan}|${date}|${g.name}`);
        }
        continue;
      }
      planSeen.add(item.plan);
      if (item.checked)
        checkedPlans.add(item.plan);
    }
    for (const plan of checkedPlans) {
      planDays.set(plan, ((_h2 = planDays.get(plan)) != null ? _h2 : 0) + 1);
      planCheckDates.add(`${plan}|${date}`);
    }
  }
  let rateEnd = end;
  if ((type === "week" || type === "month") && today < end)
    rateEnd = today;
  const totalDays = dayCount(start, rateEnd);
  const workdays = countWorkdays(start, rateEnd);
  const workdayPlans = /* @__PURE__ */ new Set();
  for (const d of defs) {
    if (d.name === "\u590D\u76D8") {
      if (reviewWorkdays)
        workdayPlans.add(d.name);
    } else if (d.tradingDay === true) {
      workdayPlans.add(d.name);
    }
  }
  const choreRates = [];
  for (const d of choreDefs) {
    let done = 0;
    let total = 0;
    for (const g of d.goals) {
      if (g.mode !== "chore")
        continue;
      const cycle = (_i2 = g.cycle) != null ? _i2 : { unit: "day", days: [] };
      const gStart = g.start || start;
      const gEnd = g.end || end;
      const dues = choreOccurrences(cycle, gStart, gEnd, 800);
      for (let i = 0; i < dues.length; i++) {
        if (dues[i] > rateEnd)
          break;
        total++;
        const next = i + 1 < dues.length ? dues[i + 1] : nextChoreOccurrence(cycle, dues[i]);
        const winTo = formatDate(addDays(parseDateString(next), -1));
        const scanTo = [winTo, rateEnd, today].reduce((a, b) => b < a ? b : a);
        for (let dd = dues[i]; dd <= scanTo; ) {
          if (choreChecks.has(`${d.name}|${dd}|${g.name}`)) {
            done++;
            break;
          }
          dd = formatDate(addDays(parseDateString(dd), 1));
        }
      }
    }
    choreRates.push({ plan: d.name, done, total, percent: total === 0 ? 0 : Math.round(done / total * 100) });
  }
  const planRates = [
    ...Array.from(planSeen).sort().map((plan) => {
      var _a59;
      const total = workdayPlans.has(plan) ? workdays : totalDays;
      const done = (_a59 = planDays.get(plan)) != null ? _a59 : 0;
      return { plan, done, total, percent: total === 0 ? 0 : Math.round(done / total * 100) };
    }),
    ...choreRates
  ];
  const tempFiles = collectTempTaskFiles(app, rootPath, yearDir, label, type);
  let tempTotal = 0;
  let tempDone = 0;
  for (const file2 of tempFiles) {
    const source = file2.path.includes("/\u5468/") ? "week" : "month";
    const tasks2 = parseTempTasksFromFrontmatter(await app.vault.cachedRead(file2), file2, source);
    for (const t of tasks2) {
      if (!t.text)
        continue;
      tempTotal++;
      if (t.checked)
        tempDone++;
    }
  }
  const quotaProgress = quotaDefs.map((d) => {
    var _a59, _b32;
    const q = d.quota;
    const qStart = (_a59 = q.start) != null ? _a59 : start;
    const dailyQuota = computeQuotaDaily(q.total, qStart, q.end);
    const actual = (_b32 = quotaActual.get(d.name)) != null ? _b32 : 0;
    const expected = quotaExpected(dailyQuota, qStart, q.end, today);
    return {
      plan: d.name,
      unit: q.unit,
      start: qStart,
      end: q.end,
      total: q.total,
      dailyQuota,
      actual,
      expected,
      percent: Math.min(100, Math.round(actual / q.total * 100)),
      behind: actual + 1e-9 < expected
    };
  });
  const poolTasks = await listTasks(app, rootPath, year);
  const windowTasks = filterTasksInRange(poolTasks, start, end);
  const taskSummary = summarizeTasks(windowTasks);
  let planProgress = [];
  if (type === "year") {
    planProgress = await computeAnnualPlanProgress(app, rootPath, today, poolTasks, planRates, quotaProgress, bzg != null ? bzg : null);
  }
  return {
    type,
    label,
    rangeLabel: `${start.slice(5)} ~ ${end.slice(5)}`,
    planRates,
    tempTotal,
    tempDone,
    tempPercent: tempTotal === 0 ? 0 : Math.round(tempDone / tempTotal * 100),
    taskTotal: taskSummary.total,
    taskDone: taskSummary.done,
    taskPercent: taskSummary.percent,
    tasks: windowTasks,
    planProgress,
    quotaProgress,
    planCheckDates,
    choreHitDates: choreChecks
  };
}
function filterTasksInRange(tasks2, start, end) {
  return tasks2.filter((t) => {
    var _a58, _b31;
    const s = (_a58 = t.start) != null ? _a58 : t.due;
    const e = (_b31 = t.due) != null ? _b31 : t.start;
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
  var _a58, _b31, _c12;
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!fmMatch)
    return [];
  let data;
  try {
    const parsed2 = parseYaml(fmMatch[1]);
    data = parsed2 && typeof parsed2 === "object" ? parsed2 : null;
  } catch (e) {
    return [];
  }
  const raw = data == null ? void 0 : data.plans;
  if (raw === void 0 || raw === null)
    return [];
  const defs = [];
  const push = (name, obj) => {
    var _a59;
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
      const m2 = (_a59 = /(\d+)\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门|章|节)/.exec(target)) != null ? _a59 : /(?<![0-9/%])(\d+)(?![0-9/%])/.exec(target);
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
        const name = (_c12 = (_b31 = (_a58 = obj.name) != null ? _a58 : obj.plan) != null ? _b31 : obj["\u540D\u79F0"]) != null ? _c12 : obj["\u8BA1\u5212"];
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
  var _a58, _b31, _c12, _d5, _e4, _f2, _g2, _h2, _i2;
  if (!obj || !Array.isArray(obj.goals))
    return [];
  const out = [];
  for (const g of obj.goals) {
    if (typeof g === "string") {
      const m2 = /^(.+?)\s+(\d+)\s*(篇|本|条|个|部|期|集|次|份|张|幅|门|天|章|节)?(?:\s+(\d{4}-\d{2}-\d{2})~\s*(\d{4}-\d{2}-\d{2}))?$/.exec(g.trim());
      if (m2) {
        out.push({ name: m2[1].trim(), count: parseInt(m2[2], 10), unit: (_a58 = m2[3]) != null ? _a58 : "\u4E2A", start: m2[4], end: m2[5] });
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
      var _a59;
      const cv = (_a59 = rec.count) != null ? _a59 : rec["\u6570\u91CF"];
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
      const rawFloor = (_c12 = (_b31 = rec.floor) != null ? _b31 : rec["\u4E0B\u9650"]) != null ? _c12 : rec["\u6BCF\u65E5"];
      const floorVal = typeof rawFloor === "number" ? rawFloor : parseFloat(String(rawFloor != null ? rawFloor : ""));
      if (Number.isFinite(floorVal) && floorVal > 0)
        goal.floor = floorVal;
      else if (mode === "review")
        goal.floor = 1;
      const cycle = parseChoreCycle((_d5 = rec.cycle) != null ? _d5 : rec["\u5468\u671F"]);
      if (cycle)
        goal.cycle = cycle;
      const overdue = parseChoreOverdue((_e4 = rec.overdue) != null ? _e4 : rec["\u903E\u671F"]);
      if (overdue)
        goal.overdue = overdue;
    }
    if (chapters && chapters.length > 0)
      goal.chapters = chapters;
    const rawGoalQuota = (_f2 = rec.writingQuota) != null ? _f2 : rec["\u5B57\u6570\u914D\u989D"];
    if (rawGoalQuota && typeof rawGoalQuota === "object") {
      const q = rawGoalQuota;
      const qNum = (v) => typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
      const qStr = (keys) => readPlanString(q, keys);
      const qTotal = qNum((_g2 = q.total) != null ? _g2 : q["\u603B\u91CF"]);
      if (Number.isFinite(qTotal) && qTotal > 0) {
        const qStart = qStr(["start", "\u5F00\u59CB", "\u8D77"]).trim() || void 0;
        const qEnd = qStr(["end", "\u7ED3\u675F", "\u6B62", "\u622A\u6B62"]).trim() || void 0;
        const qInitial = qNum((_h2 = q.initial) != null ? _h2 : q["\u521D\u59CB"]);
        goal.writingQuota = {
          total: qTotal,
          unit: qStr(["unit", "\u5355\u4F4D"]) || (mode === "writing" ? "\u5B57" : ""),
          ...qStart ? { start: qStart } : {},
          ...qEnd ? { end: qEnd } : {},
          ...Number.isFinite(qInitial) && qInitial > 0 ? { initial: qInitial } : {}
        };
      }
    }
    const readerSid = readPlanString(rec, ["readerSid", "\u9605\u8BFB\u5668\u4E66"]);
    if (readerSid)
      goal.readerSid = readerSid;
    const rawAnchors = rec.readerAnchors;
    if (Array.isArray(rawAnchors)) {
      const anchors = rawAnchors.map((a) => {
        const str = typeof a === "string" ? a : String(a != null ? a : "");
        const sep = str.indexOf("|");
        if (sep === -1)
          return null;
        const spine = parseInt(str.slice(0, sep), 10);
        if (!Number.isFinite(spine) || spine < 0)
          return null;
        const rest = str.slice(sep + 1);
        const sep2 = rest.indexOf("|");
        const href = sep2 === -1 ? rest : rest.slice(0, sep2);
        const progress = sep2 === -1 ? void 0 : parseFloat(rest.slice(sep2 + 1));
        return {
          spine,
          href,
          ...progress !== void 0 && Number.isFinite(progress) && progress >= 0 ? { progress } : {}
        };
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
        const rawCounts = (_i2 = obj2.counts) != null ? _i2 : obj2["\u6570\u76EE"];
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
  var _a58, _b31, _c12, _d5, _e4;
  if (!obj)
    return null;
  const raw = (_b31 = (_a58 = obj.quota) != null ? _a58 : obj["\u5B9A\u989D"]) != null ? _b31 : obj["\u65E5\u5B9A\u989D"];
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
  const totalRaw = (_d5 = (_c12 = rec.total) != null ? _c12 : rec["\u603B\u91CF"]) != null ? _d5 : rec["\u6570\u91CF"];
  const total = typeof totalRaw === "number" ? totalRaw : parseFloat(String(totalRaw != null ? totalRaw : ""));
  if (!Number.isFinite(total) || total <= 0)
    return null;
  const unitRaw = (_e4 = rec.unit) != null ? _e4 : rec["\u5355\u4F4D"];
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
  if (/^(writing|写作|小说|写小说)$/.test(v))
    return "writing";
  if (/^(chore|生活|日常|家务)$/.test(v))
    return "chore";
  return void 0;
}
async function computeModeGoalStats(app, rootPath, year, planName, goal, today, bzg) {
  var _a58, _b31, _c12, _d5, _e4, _f2, _g2, _h2, _i2, _j;
  const mode = goal.mode;
  const period = (_a58 = await readPlanPeriod(app, rootPath, year)) != null ? _a58 : { start: `${year}-01-01`, end: `${year}-12-31` };
  const start = goal.start || period.start;
  const end = goal.end || period.end;
  const floor = (_b31 = goal.floor) != null ? _b31 : 0;
  const dueEnd = today < end ? today : end;
  const dueDays = today < start ? 0 : Math.max(0, dayCount(start, dueEnd));
  if (mode === "writing" && goal.writingQuota) {
    const q = goal.writingQuota;
    const qStart = (_c12 = q.start) != null ? _c12 : start;
    const qEnd = (_d5 = q.end) != null ? _d5 : end;
    const initial = (_e4 = q.initial) != null ? _e4 : 0;
    const daily = floor > 0 ? floor : computeWritingDaily(q.total, initial, qStart, qEnd);
    const scanEnd = today < qStart ? qStart : today > qEnd ? qEnd : today;
    const prefix2 = `${rootPath.replace(/\/+$/, "")}/${yearDirName(year)}/\u6BCF\u65E5/`;
    let cumulative = initial;
    let hitDays2 = 0;
    const days2 = [];
    const dayStates2 = [];
    for (let d = qStart; d <= scanEnd; ) {
      let hit = false;
      const f = app.vault.getAbstractFileByPath(`${prefix2}${d}.md`);
      if (f instanceof TFile) {
        const content = await app.vault.cachedRead(f);
        let inCheck = false;
        for (const line of content.split("\n")) {
          if (/^##\s/.test(line)) {
            inCheck = line.startsWith(CHECK_HEADING);
            continue;
          }
          if (!inCheck)
            continue;
          const m2 = TASK_LINE_RE.exec(line);
          if (!m2 || m2[3] !== planName)
            continue;
          const text = m2[2].trim();
          if (!matchesWritingLine(text, goal.name))
            continue;
          const actual = parseQuotaActual(text);
          const checked = m2[1] === "x";
          const rowQuota = (_f2 = parseQuotaAmount(text)) != null ? _f2 : daily;
          cumulative += actual != null ? actual : checked ? rowQuota : 0;
          hit = checked || actual != null && actual > 0;
          break;
        }
      }
      if (hit)
        hitDays2++;
      days2.push(hit);
      dayStates2.push({ date: d, hit });
      const [yy, mm, dd] = d.split("-").map(Number);
      const next = new Date(yy, mm - 1, dd + 1);
      d = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
    }
    let streak2 = 0;
    {
      let i = days2.length - 1;
      if (i >= 0 && !days2[i])
        i--;
      while (i >= 0 && days2[i]) {
        streak2++;
        i--;
      }
    }
    const dueWindow = today < qStart ? 0 : Math.max(0, dayCount(qStart, scanEnd));
    const expected = initial + Math.round(daily * dueWindow * 10) / 10;
    const stats2 = {
      mode,
      dueDays: dueWindow,
      hitDays: hitDays2,
      streak: streak2,
      percent: Math.min(100, Math.round(cumulative / q.total * 100)),
      totalAmount: Math.round(cumulative * 10) / 10,
      quotaTotal: q.total,
      quotaUnit: q.unit || "\u5B57",
      ...initial > 0 ? { quotaInitial: initial } : {},
      quotaDaily: daily,
      quotaExpected: expected,
      quotaBehind: cumulative + 1e-9 < expected,
      dayStates: dayStates2
    };
    return stats2;
  }
  if (mode === "chore") {
    const cycle = (_g2 = goal.cycle) != null ? _g2 : { unit: "day", days: [] };
    const prefix2 = `${rootPath.replace(/\/+$/, "")}/${yearDirName(year)}/\u6BCF\u65E5/`;
    const dues = choreOccurrences(cycle, start, dueEnd);
    const hits = [];
    for (let i = 0; i < dues.length; i++) {
      const next = i + 1 < dues.length ? dues[i + 1] : nextChoreOccurrence(cycle, dues[i]);
      const winTo = formatDate(addDays(parseDateString(next), -1));
      const clampTo = winTo < dueEnd ? winTo : dueEnd;
      hits.push(
        await scanChoreHit(app, prefix2, planName, goal.name, dues[i], clampTo, false, (_h2 = goal.floor) != null ? _h2 : 0, goal.unit || "")
      );
    }
    const hitDays2 = hits.filter(Boolean).length;
    let streak2 = 0;
    {
      let i = hits.length - 1;
      if (i >= 0 && !hits[i])
        i--;
      while (i >= 0 && hits[i]) {
        streak2++;
        i--;
      }
    }
    return {
      mode,
      dueDays: dues.length,
      hitDays: hitDays2,
      streak: streak2,
      percent: dues.length > 0 ? Math.min(100, Math.round(hitDays2 / dues.length * 100)) : 0
    };
  }
  const prefix = `${rootPath.replace(/\/+$/, "")}/${yearDirName(year)}/\u6BCF\u65E5/`;
  const lineOfDay = /* @__PURE__ */ new Map();
  const NONE = { checked: false, actual: null, manual: false };
  const readDayLine = async (date) => {
    var _a59;
    const cached = lineOfDay.get(date);
    if (cached)
      return cached;
    const f = app.vault.getAbstractFileByPath(`${prefix}${date}.md`);
    if (!(f instanceof TFile)) {
      lineOfDay.set(date, NONE);
      return NONE;
    }
    const content = await app.vault.cachedRead(f);
    let found = null;
    let inCheck = false;
    for (const line of content.split("\n")) {
      if (/^##\s/.test(line)) {
        inCheck = line.startsWith(CHECK_HEADING);
        continue;
      }
      if (!inCheck)
        continue;
      const m2 = TASK_LINE_RE.exec(line);
      if (!m2 || m2[3] !== planName)
        continue;
      const text = m2[2].trim();
      if (parseTickRow(text))
        continue;
      if (!matchesModeLine(text, goal.name, (_a59 = goal.floor) != null ? _a59 : 0, goal.unit || ""))
        continue;
      found = {
        checked: m2[1] === "x",
        actual: parseQuotaActual(text),
        manual: line.includes(MANUAL_MARK)
      };
      break;
    }
    const result = found != null ? found : NONE;
    lineOfDay.set(date, result);
    return result;
  };
  let hitDays = 0;
  let totalAmount = 0;
  const days = [];
  const dayStates = [];
  for (let d = start; d <= dueEnd; ) {
    const line = await readDayLine(d);
    const bzgCount = bzg ? reviewedOn(bzg, d) : null;
    let hit = false;
    if (mode === "review") {
      const actual = line.manual && line.actual != null ? line.actual : Math.max((_i2 = line.actual) != null ? _i2 : 0, bzgCount != null ? bzgCount : 0);
      hit = line.checked || actual >= floor;
    } else if (mode === "diary") {
      hit = line.checked;
      if (!hit && bzg) {
        const diary = await readBzgDiaryText(app, bzg, d);
        hit = diaryDayWritten(diary);
      }
    } else {
      hit = line.checked;
      const amount = (_j = line.actual) != null ? _j : line.checked ? floor || 0 : 0;
      totalAmount += amount;
    }
    if (hit)
      hitDays++;
    days.push(hit);
    dayStates.push({ date: d, hit });
    const [yy, mm, dd] = d.split("-").map(Number);
    const next = new Date(yy, mm - 1, dd + 1);
    d = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  }
  let streak = 0;
  {
    let i = days.length - 1;
    if (i >= 0 && !days[i])
      i--;
    while (i >= 0 && days[i]) {
      streak++;
      i--;
    }
  }
  const stats = {
    mode,
    dueDays,
    hitDays,
    streak,
    percent: dueDays > 0 ? Math.min(100, Math.round(hitDays / dueDays * 100)) : 0,
    dayStates
  };
  if (mode === "review" && bzg) {
    stats.covered = distinctReviewedInRange(bzg, start, dueEnd);
    stats.pool = reviewPoolSize(app, bzg);
    stats.todayActual = reviewedOn(bzg, today);
  }
  if (mode === "exercise")
    stats.totalAmount = totalAmount;
  return stats;
}
function hasChoreGoal(def) {
  return def.goals.some((g) => g.mode === "chore");
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
async function computeAnnualPlanProgress(app, rootPath, today, tasks2, planRates, quotaProgress = [], bzg = null) {
  const root = rootPath.replace(/\/+$/, "");
  const year = today.slice(0, 4);
  const f = app.vault.getAbstractFileByPath(`${root}/${yearDirName(year)}/\u5E74\u5EA6\u8BA1\u5212.md`);
  if (!(f instanceof TFile))
    return [];
  const content = await app.vault.cachedRead(f);
  const defs = parsePlansFromFrontmatter(content);
  const rateByName = new Map(planRates.map((r) => [r.plan, r]));
  const quotaByName = new Map(quotaProgress.map((r) => [r.plan, r]));
  return Promise.all(
    defs.map(async (def) => {
      var _a58, _b31, _c12, _d5, _e4, _f2;
      const planTasks = tasks2.filter((t) => t.plan === def.name);
      const rate = rateByName.get(def.name);
      const goalProgress = await Promise.all(
        def.goals.map(async (g) => {
          if (g.mode === "writing" ? !!g.writingQuota : g.mode && g.mode !== "reading") {
            const stats = await computeModeGoalStats(app, rootPath, year, def.name, g, today, bzg);
            return { ...g, done: stats.hitDays, total: stats.dueDays, percent: stats.percent, modeStats: stats };
          }
          const prefix = `${g.name}\uFF08`;
          const goalTasks = planTasks.filter((t) => t.text.trim().startsWith(prefix));
          const done = goalTasks.filter((t) => t.checked).length;
          const percent = goalTasks.length > 0 ? Math.round(done / goalTasks.length * 100) : 0;
          return { ...g, done, total: goalTasks.length, percent };
        })
      );
      const base = {
        plan: def.name,
        target: def.target,
        action: def.action,
        label: def.label,
        color: def.color,
        tradingDay: def.tradingDay,
        goals: goalProgress,
        tasks: planTasks
      };
      if (def.type === "quota") {
        const qp = (_a58 = quotaByName.get(def.name)) != null ? _a58 : null;
        return {
          ...base,
          isNumeric: false,
          isQuota: true,
          quota: qp,
          targetCount: 0,
          doneCount: 0,
          checkDone: 0,
          checkTotal: 0,
          checkPercent: 0,
          percent: (_b31 = qp == null ? void 0 : qp.percent) != null ? _b31 : 0
        };
      }
      if (def.type === "numeric") {
        const doneCount = planTasks.filter((t) => t.checked).length;
        const totalCount = planTasks.length;
        let percent = totalCount > 0 ? Math.round(doneCount / totalCount * 100) : 0;
        const modePercents = goalProgress.filter((g) => g.modeStats).map((g) => g.percent);
        if (hasChoreGoal(def) && rate)
          percent = rate.percent;
        else if (totalCount === 0 && modePercents.length > 0) {
          percent = Math.round(modePercents.reduce((a, b) => a + b, 0) / modePercents.length);
        }
        return {
          ...base,
          isNumeric: true,
          isQuota: false,
          quota: null,
          targetCount: totalCount,
          doneCount,
          checkDone: 0,
          checkTotal: 0,
          checkPercent: 0,
          percent
        };
      }
      return {
        ...base,
        isNumeric: false,
        isQuota: false,
        quota: null,
        targetCount: 0,
        doneCount: 0,
        checkDone: (_c12 = rate == null ? void 0 : rate.done) != null ? _c12 : 0,
        checkTotal: (_d5 = rate == null ? void 0 : rate.total) != null ? _d5 : 0,
        checkPercent: (_e4 = rate == null ? void 0 : rate.percent) != null ? _e4 : 0,
        percent: (_f2 = rate == null ? void 0 : rate.percent) != null ? _f2 : 0
      };
    })
  );
}
function resolvePeriod(today, type) {
  if (type === "week") {
    const { year, week: week2 } = getISOWeek(today);
    const { start, end } = weekRange(today);
    return {
      start,
      end,
      label: `${year}-W${String(week2).padStart(2, "0")}`,
      yearDir: yearDirName(String(year))
    };
  }
  if (type === "month") {
    const [y2, m2] = today.split("-").map(Number);
    const mm = String(m2).padStart(2, "0");
    const dd = String(daysInMonth(y2, m2)).padStart(2, "0");
    return { start: `${y2}-${mm}-01`, end: `${y2}-${mm}-${dd}`, label: `${y2}-${mm}`, yearDir: yearDirName(String(y2)) };
  }
  const [y] = today.split("-").map(Number);
  return { start: `${y}-01-01`, end: today, label: String(y), yearDir: yearDirName(String(y)) };
}
function collectTempTaskFiles(app, rootPath, yearDir, label, type) {
  if (type === "week") {
    const f = app.vault.getAbstractFileByPath(`${rootPath}/${yearDir}/\u5468/${label}.md`);
    return f instanceof TFile ? [f] : [];
  }
  if (type === "month") {
    const f = app.vault.getAbstractFileByPath(`${rootPath}/${yearDir}/\u6708/${label}.md`);
    return f instanceof TFile ? [f] : [];
  }
  return app.vault.getFiles().filter(
    (f) => f.name.endsWith(".md") && (f.path.startsWith(`${rootPath}/${yearDir}/\u5468/`) || f.path.startsWith(`${rootPath}/${yearDir}/\u6708/`))
  );
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
  var _a58;
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
    return { title: line, level: depth, family: "N", unit: (_a58 = DEFAULT_UNIT_CHAIN[depth]) != null ? _a58 : `\u7EA7${depth + 1}` };
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
  var _a58, _b31, _c12, _d5;
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
  const virtualRoot = { depth: -1, unit: "", label: "", children: [] };
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
      const leafParent = (_b31 = (_a58 = stack[stack.length - 1]) == null ? void 0 : _a58.node) != null ? _b31 : virtualRoot;
      leafParent.children.push({ depth: leafParent.depth + 1, unit: item.unit, label: item.title, children: [] });
      continue;
    }
    const node = { depth, unit: item.unit, label: item.title, children: [] };
    (parent != null ? parent : virtualRoot).children.push(node);
    stack.push({ family: item.family, level: item.level, node });
  }
  if (virtualRoot.children.length === 0)
    return null;
  let maxDepth = 0;
  const freq = [];
  const depthLabels = [];
  {
    const walk = (nodes) => {
      var _a59;
      for (const n of nodes) {
        while (freq.length <= n.depth)
          freq.push(/* @__PURE__ */ new Map());
        while (depthLabels.length <= n.depth)
          depthLabels.push([]);
        if (n.unit)
          freq[n.depth].set(n.unit, ((_a59 = freq[n.depth].get(n.unit)) != null ? _a59 : 0) + 1);
        depthLabels[n.depth].push(n.label);
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
    for (const [w, n] of (_c12 = freq[i]) != null ? _c12 : []) {
      if (n > bestN) {
        best = w;
        bestN = n;
      }
    }
    units.push(best || DEFAULT_UNIT_CHAIN[i] || `\u7EA7${i + 1}`);
  }
  const levels = units.map((unit) => ({ unit, counts: [] }));
  levels[0].counts = [virtualRoot.children.length];
  for (let d = 0; d < levels.length; d++) {
    if ((_d5 = depthLabels[d]) == null ? void 0 : _d5.some((l) => l.trim() !== ""))
      levels[d].labels = depthLabels[d];
  }
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
  return { levels, lineCount: items2.length, skipped, units, depthLabels };
}
function tocSummary(result) {
  const parts = result.levels.map((lv) => `${lv.unit} \xD7${lv.counts.reduce((a, b) => a + b, 0)}`);
  return `\u8BC6\u522B ${result.lineCount} \u884C${result.skipped ? `\uFF08\u8DF3\u8FC7 ${result.skipped} \u884C\uFF09` : ""} \xB7 ${parts.join(" \u2192 ")}`;
}

// src/diary-sync.ts
var DIARY_ESSAY_HEADING = "# \u968F\u7B14";
var DIARY_REVIEW_HEADING = "# \u5F53\u65E5\u590D\u76D8";
var DIARY_NEXTDAY_HEADING = "# \u6B21\u65E5\u8BA1\u5212";
function trimTrailingBlanks(arr) {
  let n = arr.length;
  while (n > 0 && arr[n - 1].trim() === "")
    n--;
  return n;
}
function nextDayPlanTransform(content, text) {
  const lines = content.split("\n");
  const body = [];
  for (const l of text.split("\n"))
    body.push(l);
  body.length = trimTrailingBlanks(body);
  let start = 0;
  while (start < body.length && body[start].trim() === "")
    start++;
  const bodyLines = body.slice(start);
  const nextH1 = (from) => {
    for (let i = from; i < lines.length; i++) {
      if (/^#\s/.test(lines[i]))
        return i;
    }
    return lines.length;
  };
  const planIdx = lines.findIndex((l) => l.trim() === DIARY_NEXTDAY_HEADING);
  if (planIdx >= 0) {
    const end = nextH1(planIdx + 1);
    lines.splice(planIdx + 1, end - planIdx - 1, "", ...bodyLines, "");
    return lines.join("\n");
  }
  const reviewIdx = lines.findIndex((l) => l.trim() === DIARY_REVIEW_HEADING);
  const anchorIdx = reviewIdx >= 0 ? reviewIdx : lines.findIndex((l) => l.trim() === DIARY_ESSAY_HEADING);
  if (anchorIdx === -1)
    return null;
  lines.splice(nextH1(anchorIdx + 1), 0, DIARY_NEXTDAY_HEADING, "", ...bodyLines, "");
  return lines.join("\n");
}
function extractNextDayPlanSection(content) {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.trim() === DIARY_NEXTDAY_HEADING);
  if (idx === -1)
    return null;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^#\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(idx + 1, end);
  let s = 0;
  while (s < body.length && body[s].trim() === "")
    s++;
  let e = body.length;
  while (e > s && body[e - 1].trim() === "")
    e--;
  return body.slice(s, e).join("\n");
}

// src/board-items.ts
function roundPercent(done, total) {
  return total === 0 ? 0 : Math.round(done / total * 100);
}
function isWeekend(date) {
  const day = parseDateString(date).getDay();
  return day === 0 || day === 6;
}
function eachDay(from, to, fn) {
  if (from > to)
    return;
  let cur = parseDateString(from);
  const end = parseDateString(to);
  while (cur <= end) {
    fn(formatDate(cur));
    cur = addDays(cur, 1);
  }
}
function choreDays(cycle, plan, item, gStart, scanEnd, hitDates) {
  const dues = choreOccurrences(cycle, gStart, scanEnd, 4e3);
  const dueHit = /* @__PURE__ */ new Map();
  for (let i = 0; i < dues.length; i++) {
    const due = dues[i];
    const next = i + 1 < dues.length ? dues[i + 1] : nextChoreOccurrence(cycle, due);
    const winTo = formatDate(addDays(parseDateString(next), -1));
    const scanTo = winTo < scanEnd ? winTo : scanEnd;
    let hit = false;
    for (let d = due; d <= scanTo; ) {
      if (hitDates.has(`${plan}|${d}|${item}`)) {
        hit = true;
        break;
      }
      d = formatDate(addDays(parseDateString(d), 1));
    }
    dueHit.set(due, hit);
  }
  const states = [];
  eachDay(gStart, scanEnd, (d) => {
    const h = dueHit.get(d);
    states.push({ date: d, state: h === void 0 ? "off" : h ? "hit" : "miss" });
  });
  return states;
}
async function computeBoardSections(app, rootPath, today, reviewWorkdays, bzg = null) {
  var _a58, _b31, _c12, _d5, _e4, _f2, _g2;
  const root = rootPath.replace(/\/+$/, "");
  const year = today.slice(0, 4);
  const defs = await readAnnualDefs(app, root, year);
  const period = (_a58 = await readPlanPeriod(app, root, year)) != null ? _a58 : {
    start: `${year}-01-01`,
    end: `${year}-12-31`
  };
  const { start, end } = period;
  const scanEnd = today < start ? start : today > end ? end : today;
  if (today < start)
    return { start, end, scanEnd, sections: [] };
  const stats = await computePeriodStats(app, root, today, "year", reviewWorkdays, bzg);
  const progByName = new Map(stats.planProgress.map((p) => [p.plan, p]));
  const quotaByName = new Map(stats.quotaProgress.map((q) => [q.plan, q]));
  const rateByName = new Map(stats.planRates.map((r) => [r.plan, r]));
  const sections = [];
  for (const def of defs) {
    const items2 = [];
    const prog = progByName.get(def.name);
    const goals = (_b31 = prog == null ? void 0 : prog.goals) != null ? _b31 : [];
    const hasChore = goals.some((g) => g.mode === "chore");
    const workdayOnly = def.tradingDay === true || def.name === "\u590D\u76D8" && reviewWorkdays;
    const planTotalDays = workdayOnly ? countWorkdays(start, scanEnd) : dayCount(start, scanEnd);
    let planCheckDone = 0;
    eachDay(start, scanEnd, (d) => {
      if (stats.planCheckDates.has(`${def.name}|${d}`))
        planCheckDone++;
    });
    if (def.type === "quota") {
      const q = quotaByName.get(def.name);
      if (q) {
        items2.push({
          key: `${def.name}|quota`,
          name: "\u603B\u91CF\u8FDB\u5EA6",
          kind: "quota",
          done: q.actual,
          total: q.total,
          percent: q.percent,
          unit: q.unit || "\u91CF"
        });
      }
    } else {
      if (def.type === "check") {
        if (goals.length === 0) {
          const days = [];
          eachDay(start, scanEnd, (d) => {
            const hit = stats.planCheckDates.has(`${def.name}|${d}`);
            days.push({ date: d, state: hit ? "hit" : workdayOnly && isWeekend(d) ? "off" : "miss" });
          });
          const total = workdayOnly ? countWorkdays(start, scanEnd) : dayCount(start, scanEnd);
          items2.push({
            key: `${def.name}|check`,
            name: "\u6BCF\u65E5\u6253\u5361",
            kind: "plan",
            done: planCheckDone,
            total,
            percent: roundPercent(planCheckDone, total),
            unit: "\u5929",
            days
          });
        } else {
          appendGoalItems(items2, def.name, goals, stats.choreHitDates, start, scanEnd);
        }
      } else if (def.type === "numeric") {
        appendGoalItems(items2, def.name, goals, stats.choreHitDates, start, scanEnd);
        if (goals.length === 0 && prog && prog.targetCount > 0) {
          items2.push({
            key: `${def.name}|task`,
            name: "\u4EFB\u52A1\u5B8C\u6210",
            kind: "goal",
            done: prog.doneCount,
            total: prog.targetCount,
            percent: prog.percent,
            unit: "\u9879"
          });
        }
      }
      if (items2.length === 0 && goals.length > 0) {
        appendGoalItems(items2, def.name, goals, stats.choreHitDates, start, scanEnd);
      }
    }
    if (items2.length === 0)
      continue;
    let percent;
    if (def.type === "quota") {
      percent = (_d5 = (_c12 = quotaByName.get(def.name)) == null ? void 0 : _c12.percent) != null ? _d5 : 0;
    } else if (def.type === "check" && !hasChore) {
      percent = roundPercent(planCheckDone, planTotalDays);
    } else if (items2.every((i) => i.days)) {
      const done = items2.reduce((a, i) => a + i.done, 0);
      const total = items2.reduce((a, i) => a + i.total, 0);
      percent = roundPercent(done, total);
    } else {
      percent = (_g2 = (_f2 = prog == null ? void 0 : prog.percent) != null ? _f2 : (_e4 = rateByName.get(def.name)) == null ? void 0 : _e4.percent) != null ? _g2 : 0;
    }
    sections.push({
      plan: def.name,
      label: def.label,
      percent,
      items: items2
    });
  }
  return { start, end, scanEnd, sections };
}
function appendGoalItems(items2, plan, goals, choreHitDates, start, scanEnd) {
  var _a58, _b31, _c12, _d5, _e4, _f2, _g2, _h2, _i2, _j;
  for (const g of goals) {
    if (g.mode === "chore") {
      const cycle = (_a58 = g.cycle) != null ? _a58 : { unit: "day", days: [] };
      const gStart = g.start || start;
      const gScanEnd = g.end && g.end < scanEnd ? g.end : scanEnd;
      const days = choreDays(cycle, plan, g.name, gStart, gScanEnd, choreHitDates);
      const ms = g.modeStats;
      items2.push({
        key: `${plan}|${g.name}`,
        name: g.name,
        kind: "chore",
        done: (_b31 = ms == null ? void 0 : ms.hitDays) != null ? _b31 : g.done,
        total: (_c12 = ms == null ? void 0 : ms.dueDays) != null ? _c12 : g.total,
        percent: g.percent,
        unit: cycle.unit === "day" ? "\u5929" : "\u6B21",
        days,
        streak: ms == null ? void 0 : ms.streak
      });
      continue;
    }
    if (g.mode === "writing" && g.writingQuota) {
      const ms = g.modeStats;
      items2.push({
        key: `${plan}|${g.name}`,
        name: g.name,
        kind: "mode",
        mode: "writing",
        done: (_d5 = ms == null ? void 0 : ms.totalAmount) != null ? _d5 : 0,
        total: (_e4 = ms == null ? void 0 : ms.quotaTotal) != null ? _e4 : g.writingQuota.total,
        percent: g.percent,
        unit: (_f2 = ms == null ? void 0 : ms.quotaUnit) != null ? _f2 : "\u5B57",
        days: (_g2 = ms == null ? void 0 : ms.dayStates) == null ? void 0 : _g2.map((s) => ({ date: s.date, state: s.hit ? "hit" : "miss" })),
        streak: ms == null ? void 0 : ms.streak
      });
      continue;
    }
    if (g.mode === "review" || g.mode === "diary" || g.mode === "exercise") {
      const ms = g.modeStats;
      items2.push({
        key: `${plan}|${g.name}`,
        name: g.name,
        kind: "mode",
        mode: g.mode,
        done: (_h2 = ms == null ? void 0 : ms.hitDays) != null ? _h2 : g.done,
        total: (_i2 = ms == null ? void 0 : ms.dueDays) != null ? _i2 : g.total,
        percent: g.percent,
        unit: "\u5929",
        days: (_j = ms == null ? void 0 : ms.dayStates) == null ? void 0 : _j.map((s) => ({ date: s.date, state: s.hit ? "hit" : "miss" })),
        streak: ms == null ? void 0 : ms.streak
      });
      continue;
    }
    const unit = g.unit || (g.mode === "writing" ? "\u7AE0" : "\u8282");
    items2.push({
      key: `${plan}|${g.name}`,
      name: g.name,
      kind: "goal",
      mode: g.mode,
      done: g.done,
      total: g.total,
      percent: g.percent,
      unit
    });
  }
}

// src/weave-bridge.ts
function weaveTocToStructure(tree) {
  var _a58;
  if (!tree || tree.length === 0)
    return null;
  const freq = [];
  const walkFreq = (nodes, depth) => {
    var _a59;
    for (const n of nodes) {
      while (freq.length <= depth)
        freq.push(/* @__PURE__ */ new Map());
      const w = extractTocUnitWord(n.label);
      if (w)
        freq[depth].set(w, ((_a59 = freq[depth].get(w)) != null ? _a59 : 0) + 1);
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
  const leafProgress = [];
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
        leafProgress.push(typeof n.progress === "number" ? n.progress : -1);
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
    if ((_a58 = labelRows[lv]) == null ? void 0 : _a58.some((l) => l.trim() !== ""))
      levels[lv].labels = labelRows[lv];
  }
  if (levels[0].counts[0] <= 0)
    return null;
  return { levels, leafSpine, leafProgress, leafHref };
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
function normalizeTocLabel(s) {
  return s.replace(/[\s\u3000]/g, "").replace(/[|｜]/g, "\xB7").replace(/[（）()、，。：:；;·．.\-—_/\\'"“”‘’【】[\]<>《》？！?!~“]/g, "");
}
var TOC_NUM_PREFIX_RE = /^(第?\s*[0-9一二三四五六七八九十百千]+(?:\s*[.．、]\s*\d+)*)/;
function tocNumToken(s) {
  const m2 = TOC_NUM_PREFIX_RE.exec(s.trim());
  return m2 ? m2[1].replace(/\s/g, "") : "";
}
function resolveMissingAnchors(tree, live) {
  if (!live || live.length === 0)
    return;
  const collect = (nodes, out) => nodes.forEach((n) => {
    out.push(n);
    collect(n.children, out);
  });
  const dfs = [];
  collect(tree, dfs);
  const liveDfs = [];
  collect(live, liveDfs);
  const used = /* @__PURE__ */ new Set();
  const missing = dfs.filter((n) => !n.href || n.spineIndex < 0);
  for (const n of missing) {
    const nl = normalizeTocLabel(n.label);
    if (!nl)
      continue;
    for (let i = 0; i < liveDfs.length; i++) {
      if (used.has(i))
        continue;
      if (normalizeTocLabel(liveDfs[i].label) === nl) {
        n.href = liveDfs[i].href;
        n.spineIndex = liveDfs[i].spineIndex;
        used.add(i);
        break;
      }
    }
  }
  for (const n of missing) {
    if (n.href && n.spineIndex >= 0)
      continue;
    const tok = tocNumToken(n.label);
    if (!tok)
      continue;
    for (let i = 0; i < liveDfs.length; i++) {
      if (used.has(i))
        continue;
      if (tocNumToken(liveDfs[i].label) === tok) {
        n.href = liveDfs[i].href;
        n.spineIndex = liveDfs[i].spineIndex;
        used.add(i);
        break;
      }
    }
  }
  for (const n of missing) {
    if (n.href && n.spineIndex >= 0)
      continue;
    const nl = normalizeTocLabel(n.label);
    if (nl.length < 6)
      continue;
    for (let i = 0; i < liveDfs.length; i++) {
      if (used.has(i))
        continue;
      const ml = normalizeTocLabel(liveDfs[i].label);
      if (ml.length < 6)
        continue;
      if (nl.includes(ml) || ml.includes(nl)) {
        n.href = liveDfs[i].href;
        n.spineIndex = liveDfs[i].spineIndex;
        used.add(i);
        break;
      }
    }
  }
}
function inferNeighborSpines(tree) {
  let prev = -1;
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.spineIndex < 0 && prev >= 0)
      n.spineIndex = prev;
    if (n.spineIndex >= 0)
      prev = n.spineIndex;
    walk(n.children);
  });
  walk(tree);
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
var rewritten = setQuotaActual(marked, 0, 10, "\u7BC7", true);
check("setQuotaActual drops manual mark (ADR-0011)", !rewritten.includes(MANUAL_MARK) && rewritten.includes("\uFF08\u5B9E 10\u7BC7\uFF09"), rewritten);
var autoRewrite = setQuotaActual(marked, 0, 3, "\u7BC7", false);
check("auto rewrite strips manual mark", !autoRewrite.includes(MANUAL_MARK) && autoRewrite.startsWith("- [ ]"), autoRewrite);
var cleared = clearManualMark(marked, 0);
check("clearManualMark strips \u270B keeps state", !cleared.includes(MANUAL_MARK) && cleared.startsWith("- [x]") && cleared.includes("5\u7BC7"), cleared);
check("clearManualMark idempotent", clearManualMark(cleared, 0) === cleared, void 0);
check("clearManualMark no-mark no-op", clearManualMark(toggled, 0) === toggled, void 0);
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
var dailyMd = [
  "# 2026-11-10",
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F4C8} \u590D\u76D8 \u590D\u76D8+\u6B21\u65E5\u8BA1\u5212 #\u8BA1\u5212/\u590D\u76D8",
  "- [x] \u{1F4D6} \u9605\u8BFB #\u8BA1\u5212/\u9605\u8BFB",
  "- [x] \u{1F9E0} \u7B14\u8BB0\u590D\u4E60 #\u8BA1\u5212/\u7B14\u8BB0\u590D\u4E60",
  "- [x] \u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7\uFF08\u5B9E 9\u7BC7\uFF09 #\u8BA1\u5212/\u7B14\u8BB0\u590D\u4E60",
  "- [x] \u{1F4DD} \u65E5\u8BB0 #\u8BA1\u5212/\u65E5\u8BB0",
  "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [x] \u{1F3C3} \u62C9\u5347 1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [ ] \u{1F3C3} \u516B\u6BB5\u9526 1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [x] \u{1F3C3} \u5E73\u677F\u6491 3\u7EC4 #\u8BA1\u5212/\u8FD0\u52A8"
].join("\n");
var dailyFile = new TFile();
dailyFile.path = "2025/\u6BCF\u65E5/2026-11-10.md";
dailyFile.name = "2026-11-10.md";
var parsed = parseDailyContent(dailyFile, dailyMd, "2026-11-10");
check("topRows: \u89E3\u6790\u51FA 9 \u884C\u5E26\u8BA1\u5212\u6807\u7B7E\u884C", parsed.checkItems.length === 9, parsed.checkItems.length);
var modeGoals = [
  { plan: "\u7B14\u8BB0\u590D\u4E60", name: "\u6587\u732E\u590D\u4E60", floor: 5, unit: "\u7BC7" },
  { plan: "\u8FD0\u52A8", name: "\u62C9\u5347", floor: 1, unit: "\u6B21" },
  { plan: "\u8FD0\u52A8", name: "\u516B\u6BB5\u9526", floor: 1, unit: "\u6B21" },
  { plan: "\u8FD0\u52A8", name: "\u5E73\u677F\u6491", floor: 3, unit: "\u7EC4" }
];
var isModeLine = (it) => modeGoals.some((g) => g.plan === it.plan && matchesModeLine(it.text, g.name, g.floor, g.unit));
var rows = topLevelCheckRows(parsed.checkItems, isModeLine);
check("topRows: \u5927\u9879\u603B\u6570 = 5\uFF084 \u4E2A\u6A21\u5F0F\u5B50\u884C\u6298\u53E0\uFF09", rows.length === 5, rows.length);
check("topRows: \u5B8C\u6210\u5927\u9879 = 3", rows.filter((r) => r.done).length === 3, rows.filter((r) => r.done).length);
var _a41;
check("topRows: \u7236\u884C\u52FE\u9009\u5373\u5B8C\u6210\uFF08\u7B14\u8BB0\u590D\u4E60\uFF09", ((_a41 = rows.find((r) => r.item.plan === "\u7B14\u8BB0\u590D\u4E60")) == null ? void 0 : _a41.done) === true);
var _a42;
check("topRows: \u5B50\u884C\u672A\u5168\u52FE\u7236\u884C\u4E0D\u7B97\u5B8C\u6210\uFF08\u8FD0\u52A8\uFF09", ((_a42 = rows.find((r) => r.item.plan === "\u8FD0\u52A8")) == null ? void 0 : _a42.done) === false);
var _a43;
check("topRows: \u7236\u884C\u6302\u5230\u5168\u90E8\u6A21\u5F0F\u5B50\u884C\uFF08\u8FD0\u52A8 3 \u5B50\uFF09", ((_a43 = rows.find((r) => r.item.plan === "\u8FD0\u52A8")) == null ? void 0 : _a43.modeChildren.length) === 3);
var gapMd = dailyMd.replace("- [x] \u{1F9E0} \u7B14\u8BB0\u590D\u4E60", "- [ ] \u{1F9E0} \u7B14\u8BB0\u590D\u4E60").replace("- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8", "- [x] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8");
var gapRows = topLevelCheckRows(parseDailyContent(dailyFile, gapMd, "2026-11-10").checkItems, isModeLine);
var _a44;
check("topRows: \u7236\u672A\u52FE\u5B50\u5168\u52FE = \u5B8C\u6210\uFF08\u56DE\u586B\u95F4\u9699\u4E0D\u541E\u5B8C\u6210\u5EA6\uFF09", ((_a44 = gapRows.find((r) => r.item.plan === "\u7B14\u8BB0\u590D\u4E60")) == null ? void 0 : _a44.done) === true);
var _a45;
check("topRows: \u7236\u52FE\u5B50\u672A\u5168\u52FE = \u5B8C\u6210\uFF08\u7236\u52FE\u4F18\u5148\uFF09", ((_a45 = gapRows.find((r) => r.item.plan === "\u8FD0\u52A8")) == null ? void 0 : _a45.done) === true);
var orphanMd = [
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [x] \u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7\uFF08\u5B9E 9\u7BC7\uFF09 #\u8BA1\u5212/\u7B14\u8BB0\u590D\u4E60"
].join("\n");
var orphanRows = topLevelCheckRows(parseDailyContent(dailyFile, orphanMd, "2026-11-10").checkItems, isModeLine);
check("topRows: \u65E0\u7236\u884C\u6A21\u5F0F\u884C\u4FDD\u6301\u9876\u5C42\u4E14\u8BA1\u5165", orphanRows.length === 1 && orphanRows[0].modeChildren.length === 0 && orphanRows[0].done, JSON.stringify(orphanRows));
check("topRows: \u65E0\u6A21\u5F0F\u884C = \u5168\u90E8\u72EC\u7ACB\u5927\u9879", topLevelCheckRows(parsed.checkItems, () => false).length === 9);
check("tick \u6837\u5F0F: \u62C9\u4F38\u7B2C2\u6B21 \u2192 base+2+\u6B21", JSON.stringify(parseTickRow("\u62C9\u4F38\u7B2C2\u6B21")) === JSON.stringify({ base: "\u62C9\u4F38", k: 2, unit: "\u6B21" }), parseTickRow("\u62C9\u4F38\u7B2C2\u6B21"));
check("tick \u6837\u5F0F: \u7EC4\u5355\u4F4D\u540C\u6837\u8BC6\u522B", JSON.stringify(parseTickRow("\u62C9\u4F38\u7B2C2\u7EC4")) === JSON.stringify({ base: "\u62C9\u4F38", k: 2, unit: "\u7EC4" }), parseTickRow("\u62C9\u4F38\u7B2C2\u7EC4"));
check("tick \u6837\u5F0F: \u65E0\u5355\u4F4D\u5C3E\u4E5F\u53EF\uFF08\u7A7A\u5355\u4F4D\u76EE\u6807\uFF09", JSON.stringify(parseTickRow("\u62C9\u4F38\u7B2C2")) === JSON.stringify({ base: "\u62C9\u4F38", k: 2, unit: "" }), parseTickRow("\u62C9\u4F38\u7B2C2"));
var _a46;
check("tick \u6837\u5F0F: emoji \u524D\u7F00\u5BB9\u5FCD", ((_a46 = parseTickRow("\u{1F3C3} \u62C9\u4F38\u7B2C1\u6B21")) == null ? void 0 : _a46.base) === "\u62C9\u4F38", parseTickRow("\u{1F3C3} \u62C9\u4F38\u7B2C1\u6B21"));
check("tick \u6837\u5F0F: \u6A21\u5F0F\u884C\u6587\u672C\u4E0D\u662F\u6B21\u884C", parseTickRow("\u62C9\u4F38 2\u6B21") === null, parseTickRow("\u62C9\u4F38 2\u6B21"));
check("tick \u6837\u5F0F: \u65E0 base \u4E0D\u7B97", parseTickRow("\u7B2C2\u6B21") === null, parseTickRow("\u7B2C2\u6B21"));
check("tick \u6837\u5F0F: \u5176\u4ED6\u91CF\u8BCD\u884C\u4E0D\u7B97", parseTickRow("\u5E73\u677F\u6491 3\u7EC4") === null, parseTickRow("\u5E73\u677F\u6491 3\u7EC4"));
check("tick \u6837\u5F0F: k=0 \u975E\u6CD5", parseTickRow("\u62C9\u4F38\u7B2C0\u6B21") === null, parseTickRow("\u62C9\u4F38\u7B2C0\u6B21"));
check("tick \u6837\u5F0F: buildTickLine \u7F29\u8FDB+\u6807\u7B7E+\u5355\u4F4D+\u65E5\u671F", buildTickLine("\u62C9\u4F38", 2, "\u8FD0\u52A8", "2026-11-12", "\u6B21") === "	- [ ] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12", buildTickLine("\u62C9\u4F38", 2, "\u8FD0\u52A8", "2026-11-12", "\u6B21"));
check("tick \u6837\u5F0F: buildTickLine \u7EC4\u5355\u4F4D", buildTickLine("\u62C9\u4F38", 1, "\u8FD0\u52A8", "2026-11-12", "\u7EC4") === "	- [ ] \u62C9\u4F38\u7B2C1\u7EC4 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12", buildTickLine("\u62C9\u4F38", 1, "\u8FD0\u52A8", "2026-11-12", "\u7EC4"));
var splitMd = [
  "# 2026-11-12",
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [ ] \u{1F3C3} \u62C9\u4F38 2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8",
  "	- [x] \u62C9\u4F38\u7B2C1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8",
  "	- [ ] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8",
  "    - [ ] \u7F29\u8FDB\u7684\u666E\u901A\u884C #\u8BA1\u5212/\u8FD0\u52A8",
  "	\u968F\u4FBF\u5199\u5199",
  "	- [ ] \u65E0\u6807\u7B7E\u6B21\u884C\u6837\u5F0F\u7684\u884C"
].join("\n");
var splitParsed = parseDailyContent(dailyFile, splitMd, "2026-11-12");
check("tick \u89E3\u6790: 4 \u884C checkItems\uFF08\u7236+\u5B50\u9879\u884C+2 \u6B21\u884C\uFF09\uFF0C\u975E\u6B21\u884C\u7F29\u8FDB\u884C\u4E0D\u53EF\u89C1", splitParsed.checkItems.length === 4, splitParsed.checkItems.map((i) => i.text));
var tickItems = splitParsed.checkItems.filter((it) => it.tick);
var _a47, _b22;
check("tick \u89E3\u6790: \u4E24\u6761\u6B21\u884C\u5E26 indent+tick", tickItems.length === 2 && ((_a47 = tickItems[0].tick) == null ? void 0 : _a47.base) === "\u62C9\u4F38" && ((_b22 = tickItems[0].tick) == null ? void 0 : _b22.k) === 1 && tickItems[0].indent === 1, JSON.stringify(tickItems.map((t) => t.tick)));
check("tick \u89E3\u6790: \u6B21\u884C\u52FE\u9009\u6001\u8BFB\u5BF9", tickItems[0].checked === true && tickItems[1].checked === false);
check("tick \u89E3\u6790: \u7F29\u8FDB\u884C\u4E0D\u6F0F\u8FDB tempItems", splitParsed.tempItems.length === 0, splitParsed.tempItems.length);
var splitModeGoals = [{ plan: "\u8FD0\u52A8", name: "\u62C9\u4F38", floor: 2, unit: "\u6B21" }];
var isSplitModeLine = (it) => splitModeGoals.some((g) => g.plan === it.plan && matchesModeLine(it.text, g.name, g.floor, g.unit));
check("tick \u56DE\u5F52: \u6B21\u884C\u6587\u672C\u786E\u5B9E\u4F1A\u649E matchesModeLine\uFF08\u8BB0\u5F55\u672C\u78B0\u649E\uFF09", matchesModeLine("\u62C9\u4F38\u7B2C2\u6B21", "\u62C9\u4F38", 2, "\u6B21") === true);
var viewIsModeLine = (it) => !it.tick && isSplitModeLine(it);
var anchorItem0 = splitParsed.checkItems.find((it) => !it.tick && it.text.includes("\u62C9\u4F38 2\u6B21"));
check("tick \u56DE\u5F52: \u89C6\u56FE\u5B88\u536B\u2014\u2014item.tick \u6052\u975E\u6A21\u5F0F\u884C\u3001\u5B50\u9879\u884C\u4ECD\u662F", viewIsModeLine(tickItems[1]) === false && viewIsModeLine(anchorItem0) === true);
var splitAnchor = splitParsed.checkItems.find((it) => !it.tick && isSplitModeLine(it));
check("tick \u951A: \u6B21\u884C\u951A\u5230\u62C9\u4F38\u884C", tickAnchorOf(splitParsed.checkItems, tickItems[0], isSplitModeLine) === splitAnchor);
check("tick \u951A: tickChildrenOf \u6302 2 \u6761", tickChildrenOf(splitParsed.checkItems, splitAnchor, isSplitModeLine).length === 2);
var splitRows = topLevelCheckRows(splitParsed.checkItems, isSplitModeLine);
check("tick \u805A\u5408: \u6B21\u884C\u4E0D\u843D\u9876\u5C42\uFF08\u5927\u9879 = 1\uFF09", splitRows.length === 1, splitRows.length);
check("tick \u805A\u5408: \u6B21\u884C\u4E0D\u8FDB modeChildren\uFF08\u62C9\u4F38\u884C 1 \u6761\uFF09", splitRows[0].modeChildren.length === 1, splitRows[0].modeChildren.length);
check("tick \u805A\u5408: \u90E8\u5206\u5B8C\u6210 \u2192 \u5927\u9879\u672A\u5B8C\u6210", splitRows[0].done === false, splitRows[0].done);
var allTickRows = topLevelCheckRows(parseDailyContent(dailyFile, splitMd.replace("	- [ ] \u62C9\u4F38\u7B2C2\u6B21", "	- [x] \u62C9\u4F38\u7B2C2\u6B21"), "2026-11-12").checkItems, isSplitModeLine);
check("tick \u805A\u5408: \u6B21\u884C\u5168\u52FE \u2192 \u5B50\u884C\u955C\u50CF\u5B8C\u6210 \u2192 \u5927\u9879\u5B8C\u6210", allTickRows[0].done === true, allTickRows[0].done);
var orphanTickMd = [
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [ ] \u62C9\u4F38\u7B2C1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8"
].join("\n");
var orphanTickRows = topLevelCheckRows(parseDailyContent(dailyFile, orphanTickMd, "2026-11-12").checkItems, isSplitModeLine);
check("tick \u515C\u5E95: \u951A\u884C\u88AB\u5220 \u2192 \u6B21\u884C\u72EC\u7ACB\u9876\u5C42", orphanTickRows.length === 2, orphanTickRows.length);
var toggledIndent = toggleTaskLine(splitMd, 5, true, "	- [ ] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8");
check("tick \u5199\u56DE: \u7F29\u8FDB\u6B21\u884C\u52FE\u9009\u4FDD\u7559\u7F29\u8FDB", toggledIndent.split("\n")[5] === "	- [x] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8", toggledIndent.split("\n")[5]);
var recBase = [
  "# 2026-11-12",
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [ ] \u{1F3C3} \u62C9\u4F38 2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8"
].join("\n");
var splitSpec = { plan: "\u8FD0\u52A8", name: "\u62C9\u4F38", label: "\u{1F3C3}", floor: 2, unit: "\u6B21" };
var rec1 = reconcileTickRows(recBase, splitSpec, 2, "2026-11-12");
check("tick \u751F\u6210: \u8865\u51FA 2 \u6761\u7F29\u8FDB\u6B21\u884C", rec1.split("\n").filter((l) => l.includes("\u62C9\u4F38\u7B2C")).length === 2, rec1);
check("tick \u751F\u6210: \u5E42\u7B49", reconcileTickRows(rec1, splitSpec, 2, "2026-11-12") === rec1);
var rec2 = reconcileTickRows(recBase + "\n	- [ ] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12", splitSpec, 2, "2026-11-12");
check("tick \u751F\u6210: \u8865\u7F3A\u4FDD\u6301 k \u5347\u5E8F", rec2.indexOf("\u62C9\u4F38\u7B2C1\u6B21") !== -1 && rec2.indexOf("\u62C9\u4F38\u7B2C1\u6B21") < rec2.indexOf("\u62C9\u4F38\u7B2C2\u6B21"), rec2);
var rec3 = reconcileTickRows(rec1 + "\n	- [ ] \u62C9\u4F38\u7B2C3\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12", splitSpec, 2, "2026-11-12");
check("tick \u6E05\u7406: \u8D85\u91CF\u672A\u52FE\u6B21\u884C\u5220\u9664", !rec3.includes("\u62C9\u4F38\u7B2C3\u6B21"), rec3);
var rec4 = reconcileTickRows(rec1 + "\n	- [x] \u62C9\u4F38\u7B2C3\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12", splitSpec, 2, "2026-11-12");
check("tick \u6E05\u7406: \u8D85\u91CF\u5DF2\u52FE\u6B21\u884C\u4FDD\u7559\uFF08\u5B8C\u6210\u8BB0\u5F55\uFF09", rec4.includes("\u62C9\u4F38\u7B2C3\u6B21"), rec4);
var rec5 = reconcileTickRows(rec1, splitSpec, 0, "2026-11-12");
check("tick \u6E05\u7406: n=0 \u6E05\u5168\u90E8\u672A\u52FE\u6B21\u884C", !rec5.includes("\u62C9\u4F38\u7B2C"), rec5);
var rec6 = reconcileTickRows("# 2026-11-12\n## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u522B\u7684 #\u8BA1\u5212/\u522B\u7684\n", splitSpec, 2, "2026-11-12");
check("tick \u751F\u6210: \u65E0\u5B50\u9879\u884C\u539F\u6837\u8FD4\u56DE", !rec6.includes("\u62C9\u4F38\u7B2C"), rec6);
var rec7 = reconcileTickRows(rec1 + "\n	- [ ] \u62C9\u4F38\u7B2C1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12", splitSpec, 2, "2026-11-12");
check("tick \u6E05\u7406: \u91CD\u590D\u672A\u52FE\u6B21\u884C\u53BB\u91CD", rec7.split("\n").filter((l) => l.includes("\u62C9\u4F38\u7B2C1\u6B21")).length === 1, rec7);
check("tick \u751F\u6210: \u6B21\u884C\u4E0D\u63A9\u76D6\u771F\u884C\u7F3A\u5931\uFF08missingModeLines \u4ECD\u8865\u5B50\u9879\u884C\uFF09", missingModeLines([
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [ ] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8"
].join("\n"), [splitSpec], "2026-11-12").length === 1);
check("mirror: \u5168\u672A\u52FE\u65E0\u52A8\u4F5C", subItemMirrorTargets(rec1, [splitSpec]).length === 0);
var mir1 = subItemMirrorTargets(
  rec1.replace("	- [ ] \u62C9\u4F38\u7B2C1\u6B21", "	- [x] \u62C9\u4F38\u7B2C1\u6B21").replace("	- [ ] \u62C9\u4F38\u7B2C2\u6B21", "	- [x] \u62C9\u4F38\u7B2C2\u6B21"),
  [splitSpec]
);
check("mirror: \u6B21\u884C\u5168\u52FE \u2192 \u5B50\u9879\u884C\u5F85\u52FE", mir1.length === 1 && mir1[0].checked === true, JSON.stringify(mir1));
var mir2 = subItemMirrorTargets(rec1.replace("- [ ] \u{1F3C3} \u62C9\u4F38 2\u6B21", "- [x] \u{1F3C3} \u62C9\u4F38 2\u6B21"), [splitSpec]);
check("mirror: \u5B50\u9879\u884C\u52FE\u4F46\u6B21\u884C\u672A\u5168\u52FE \u2192 \u5F85\u56DE\u9000", mir2.length === 1 && mir2[0].checked === false, JSON.stringify(mir2));
check("mirror: \u65E0\u6B21\u884C\u4E0D\u52A8", subItemMirrorTargets(recBase, [splitSpec]).length === 0);
var blockStart = rec1.split("\n").findIndex((l) => l.includes("\u62C9\u4F38 2\u6B21"));
check("tick \u5757: \u4E0A\u79FB\u6574\u5757\u8DDF\u624B", moveTaskBlock(rec1, blockStart, blockStart + 2, -1).split("\n")[blockStart - 1].includes("\u62C9\u4F38 2\u6B21"));
var recBlockDown = rec1 + "\n- [ ] \u{1F3C3} \u516B\u6BB5\u9526 1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12";
check("tick \u5757: \u4E0B\u79FB\u6574\u5757\u8DDF\u624B", moveTaskBlock(recBlockDown, blockStart, blockStart + 2, 1).split("\n")[blockStart + 1].includes("\u62C9\u4F38 2\u6B21"));
check("tick \u5757: \u76F8\u90BB\u975E\u4EFB\u52A1\u884C\u4E0D\u8D8A\u754C\uFF08\u6807\u9898\u4E0A\u65B9\u4E0D\u52A8\uFF09", moveTaskBlock(rec1, 2, 2, -1) === rec1);
var removedBlock = removeLineBlock(rec1, blockStart, blockStart + 2);
check("tick \u5757: \u5220\u9664\u6574\u5757\uFF08\u5B50\u9879\u884C+\u6B21\u884C\uFF09", !removedBlock.includes("\u62C9\u4F38") && removedBlock.includes("\u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6"), removedBlock);
var rollTickMd = [
  "# 2026-11-12",
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [x] \u{1F3C3} \u62C9\u4F38 2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8",
  "	- [x] \u62C9\u4F38\u7B2C1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8",
  "	- [x] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8"
].join("\n");
var rollTickFacts = [{ plan: "\u8FD0\u52A8", live: true, pendingEmpty: true }];
var rollTickTargets = parentCheckTargets(
  rollTickMd,
  rollTickFacts,
  (plan, text) => plan === "\u8FD0\u52A8" && matchesModeLine(text, "\u62C9\u4F38", 2, "\u6B21"),
  (plan, text) => {
    var _a58;
    return plan === "\u8FD0\u52A8" && ((_a58 = parseTickRow(text)) == null ? void 0 : _a58.base) === "\u62C9\u4F38";
  }
);
check("tick \u5BF9\u8D26: \u955C\u50CF\u540E\u5B50\u9879\u884C\u52FE \u2192 \u8FD0\u52A8\u7236\u884C\u5165\u8D26", rollTickTargets.length === 1 && rollTickTargets[0].plan === "\u8FD0\u52A8", JSON.stringify(rollTickTargets));
var flatTickMd = rollTickMd.replace("\n	- [x] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8", "\n- [ ] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8");
check("tick \u5BF9\u8D26: \u65E0\u5B88\u536B\u65F6\u72EC\u7ACB\u6B21\u884C\u4F1A\u8BEF\u963B\u585E\u7236\u884C\uFF08\u8BB0\u5F55\u78B0\u649E\uFF09", parentCheckTargets(flatTickMd, rollTickFacts, (plan, text) => plan === "\u8FD0\u52A8" && matchesModeLine(text, "\u62C9\u4F38", 2, "\u6B21")).length === 0);
var flatGuarded = parentCheckTargets(
  flatTickMd,
  rollTickFacts,
  (plan, text) => plan === "\u8FD0\u52A8" && matchesModeLine(text, "\u62C9\u4F38", 2, "\u6B21"),
  (plan, text) => {
    var _a58;
    return plan === "\u8FD0\u52A8" && ((_a58 = parseTickRow(text)) == null ? void 0 : _a58.base) === "\u62C9\u4F38";
  }
);
check("tick \u5BF9\u8D26: isTickLineText \u5B88\u536B\u515C\u4F4F\u72EC\u7ACB\u6B21\u884C", flatGuarded.length === 1 && flatGuarded[0].plan === "\u8FD0\u52A8", JSON.stringify(flatGuarded));
var rep1 = repointModeLineAmounts([
  "# 2026-11-12",
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [x] \u{1F3C3} \u62C9\u4F38 1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12",
  "- [ ] \u{1F3C3} \u5E73\u677F\u6491 3\u7EC4 #\u8BA1\u5212/\u8FD0\u52A8"
].join("\n"), [splitSpec]);
check("repoint: \u65E7\u91CF\u884C\u6539\u5230\u65B0\u53E3\u5F84\uFF08\u52FE\u9009\u6001/\u6807\u7B7E/\u65E5\u671F\u4FDD\u7559\uFF09", rep1.includes("- [x] \u{1F3C3} \u62C9\u4F38 2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12"), rep1);
check("repoint: \u7236\u884C\u4E0E\u4ED6\u91CF\u884C\u4E0D\u52A8", rep1.includes("\u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6") && rep1.includes("\u5E73\u677F\u6491 3\u7EC4"));
check("repoint: \u5E42\u7B49", repointModeLineAmounts(rep1, [splitSpec]) === rep1);
check("repoint: \u5B9E\u91CF\u540E\u7F00\u4FDD\u7559", repointModeLineAmounts("## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7\uFF08\u5B9E 9\u7BC7\uFF09 #\u8BA1\u5212/\u5B66\u4E60", [{ plan: "\u5B66\u4E60", name: "\u6587\u732E\u590D\u4E60", label: "\u{1F5E3}\uFE0F", floor: 3, unit: "\u7BC7" }]) === "## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 3\u7BC7\uFF08\u5B9E 9\u7BC7\uFF09 #\u8BA1\u5212/\u5B66\u4E60");
check("repoint: \u7F3A\u91CF\u884C\u8865\u91CF", repointModeLineAmounts("## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u62C9\u4F38 #\u8BA1\u5212/\u8FD0\u52A8", [splitSpec]) === "## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u62C9\u4F38 2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8");
check("repoint: floor=0 \u5265\u91CF\u56DE\u7EAF\u6253\u5361", repointModeLineAmounts("## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u62C9\u4F38 2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8", [{ plan: "\u8FD0\u52A8", name: "\u62C9\u4F38", label: "", floor: 0, unit: "" }]) === "## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u62C9\u4F38 #\u8BA1\u5212/\u8FD0\u52A8");
check("repoint: \u6B21\u884C\u6837\u5F0F\u884C\u4E0D\u52A8", repointModeLineAmounts("## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8", [splitSpec]) === "## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u62C9\u4F38\u7B2C2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8");
check("repoint: \u540D\u540E\u5E26\u5176\u4ED6\u6587\u672C\u7684\u884C\u4E0D\u52A8", repointModeLineAmounts("## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u62C9\u4F38\u8BA1\u5212\u5F88\u91CD\u8981 #\u8BA1\u5212/\u8FD0\u52A8", [splitSpec]) === "## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u62C9\u4F38\u8BA1\u5212\u5F88\u91CD\u8981 #\u8BA1\u5212/\u8FD0\u52A8");
check("repoint: \u5355\u4F4D\u53D8\u66F4\u8DDF\u968F\uFF08\u6B21\u2192\u7EC4\uFF09", repointModeLineAmounts("## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u{1F3C3} \u62C9\u4F38 2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8", [{ plan: "\u8FD0\u52A8", name: "\u62C9\u4F38", label: "\u{1F3C3}", floor: 2, unit: "\u7EC4" }]) === "## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u{1F3C3} \u62C9\u4F38 2\u7EC4 #\u8BA1\u5212/\u8FD0\u52A8");
var repChain = reconcileTickRows(repointModeLineAmounts([
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [ ] \u{1F3C3} \u62C9\u4F38 1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8"
].join("\n"), [splitSpec]), splitSpec, 2, "2026-11-12");
check("repoint: \u91CD\u6307\u540E\u6B21\u884C\u751F\u6210\u3001\u884C\u6298\u53E0\u56DE\u7236\u9879", repChain.includes("	- [ ] \u62C9\u4F38\u7B2C1\u6B21") && topLevelCheckRows(parseDailyContent(dailyFile, repChain, "2026-11-12").checkItems, isSplitModeLine).length === 1, repChain);
var zuSpec = { plan: "\u8FD0\u52A8", name: "\u62C9\u4F38", label: "\u{1F4AA}", floor: 2, unit: "\u7EC4" };
var zu1 = reconcileTickRows("## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u{1F4AA} \u62C9\u4F38 2\u7EC4 #\u8BA1\u5212/\u8FD0\u52A8", zuSpec, 2, "2026-11-12");
check("tick \u7EC4: \u751F\u6210\u7B2C1\u7EC4/\u7B2C2\u7EC4", zu1.includes("	- [ ] \u62C9\u4F38\u7B2C1\u7EC4 #\u8BA1\u5212/\u8FD0\u52A8") && zu1.includes("	- [ ] \u62C9\u4F38\u7B2C2\u7EC4 #\u8BA1\u5212/\u8FD0\u52A8"), zu1);
check("tick \u7EC4: \u5E42\u7B49", reconcileTickRows(zu1, zuSpec, 2, "2026-11-12") === zu1);
var zuMirror = subItemMirrorTargets(
  zu1.replace("	- [ ] \u62C9\u4F38\u7B2C1\u7EC4", "	- [x] \u62C9\u4F38\u7B2C1\u7EC4").replace("	- [ ] \u62C9\u4F38\u7B2C2\u7EC4", "	- [x] \u62C9\u4F38\u7B2C2\u7EC4"),
  [zuSpec]
);
check("tick \u7EC4: \u5168\u52FE\u955C\u50CF\u5F85\u52FE\u5B50\u9879\u884C", zuMirror.length === 1 && zuMirror[0].checked === true, JSON.stringify(zuMirror));
var switched = reconcileTickRows(repointModeLineAmounts(rec1, [zuSpec]), zuSpec, 2, "2026-11-12");
check("tick \u7EC4: \u5207\u5355\u4F4D\u540E\u65E7\u884C\u91CD\u6307\u3001\u65E7\u672A\u52FE\u6B21\u884C\u6E05\u9664\u3001\u65B0\u5355\u4F4D\u884C\u751F\u6210", switched.includes("\u62C9\u4F38 2\u7EC4") && switched.includes("\u62C9\u4F38\u7B2C1\u7EC4") && !switched.includes("\u62C9\u4F38\u7B2C1\u6B21"), switched);
var switched2 = reconcileTickRows(repointModeLineAmounts(rec1.replace("	- [ ] \u62C9\u4F38\u7B2C1\u6B21", "	- [x] \u62C9\u4F38\u7B2C1\u6B21"), [zuSpec]), zuSpec, 2, "2026-11-12");
check("tick \u7EC4: \u65E7\u5355\u4F4D\u5DF2\u52FE\u6B21\u884C\u4FDD\u7559\uFF08\u5B8C\u6210\u8BB0\u5F55\uFF09", switched2.includes("\u62C9\u4F38 2\u7EC4") && switched2.includes("\u62C9\u4F38\u7B2C1\u6B21") && switched2.includes("\u62C9\u4F38\u7B2C1\u7EC4"), switched2);
check("tick \u7EC4: \u5F02\u5355\u4F4D\u6B21\u884C\u4E0D\u8FDB\u955C\u50CF", subItemMirrorTargets(rec1.replace("	- [ ] \u62C9\u4F38\u7B2C1\u6B21", "	- [x] \u62C9\u4F38\u7B2C1\u6B21").replace("	- [ ] \u62C9\u4F38\u7B2C2\u6B21", "	- [x] \u62C9\u4F38\u7B2C2\u6B21"), [zuSpec]).length === 0);
var healParents = [{ plan: "\u8FD0\u52A8", line: "- [ ] \u{1F4AA} \u8FD0\u52A8 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12" }];
var healIsMode = (plan, text) => plan === "\u8FD0\u52A8" && matchesModeLine(text, "\u62C9\u4F38", 2, "\u6B21");
var healBase = [
  "# 2026-11-12",
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F4C8} \u590D\u76D8 #\u8BA1\u5212/\u590D\u76D8",
  "- [ ] \u{1F3C3} \u62C9\u4F38 2\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12",
  "	- [ ] \u62C9\u4F38\u7B2C1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12"
].join("\n");
var healed = ensureModeParentLines(healBase, healParents, healIsMode);
check("heal: \u7F3A\u7236\u884C \u2192 \u63D2\u5230\u9996\u4E2A\u6A21\u5F0F\u884C\u4E4B\u524D", healed.includes("	- [ ] \u62C9\u4F38\u7B2C1\u6B21") && healed.indexOf("\u{1F4AA} \u8FD0\u52A8") < healed.indexOf("\u62C9\u4F38 2\u6B21") && healed.indexOf("\u62C9\u4F38 2\u6B21") < healed.indexOf("\u62C9\u4F38\u7B2C1\u6B21"), healed);
check("heal: \u5E42\u7B49", ensureModeParentLines(healed, healParents, healIsMode) === healed);
var healed2 = ensureModeParentLines(
  healBase.replace("- [ ] \u{1F3C3} \u62C9\u4F38 2\u6B21", "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8\n- [ ] \u{1F3C3} \u62C9\u4F38 2\u6B21"),
  healParents,
  healIsMode
);
check("heal: \u5DF2\u6709\u975E\u6A21\u5F0F\u7236\u884C\u4E0D\u91CD\u590D\u8865", healed2.split("\n").filter((l) => l.includes("#\u8BA1\u5212/\u8FD0\u52A8") && !l.includes("\u62C9\u4F38")).length === 1, healed2);
var healed3 = ensureModeParentLines(
  "# 2026-11-12\n## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u62C9\u4F38\u7B2C1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8",
  healParents,
  healIsMode
);
check("heal: \u72EC\u7ACB\u6B21\u884C\u4E0D\u7B97\u7236\u884C\u3001\u4ECD\u8865\u7236\u884C", healed3.includes("\u{1F4AA} \u8FD0\u52A8") && healed3.split("\n").filter((l) => l.includes("\u62C9\u4F38\u7B2C1\u6B21")).length === 1, healed3);
check("heal: \u8BA1\u5212\u65E0\u4EFB\u4F55\u6A21\u5F0F\u5185\u5BB9\u4E0D\u51ED\u7A7A\u8865\u5361", ensureModeParentLines(healBase, [{ plan: "\u9605\u8BFB", line: "- [ ] \u{1F4D6} \u9605\u8BFB #\u8BA1\u5212/\u9605\u8BFB" }], healIsMode) === healBase);
var diaryIsMode = (plan, text) => plan === "\u65E5\u8BB0" && matchesModeLine(text, "\u65E5\u8BB0", 0, "");
var diaryContent = "# 2026-11-12\n## \u2705 \u4ECA\u65E5\u6253\u5361\n- [ ] \u{1F4DD} \u65E5\u8BB0 #\u8BA1\u5212/\u65E5\u8BB0 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12";
check("heal: \u8BA1\u5212\u540D\u672C\u8EAB\u884C\u4E0D\u89E6\u53D1\u8865\u5361\uFF08\u65E5\u8BB0\u5F62\u6001\uFF09", ensureModeParentLines(diaryContent, [{ plan: "\u65E5\u8BB0", line: "- [ ] \u{1F4DD} \u65E5\u8BB0 #\u8BA1\u5212/\u65E5\u8BB0 \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12" }], diaryIsMode) === diaryContent);
var rollupMd = [
  "# 2026-11-11",
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F4D6} \u9605\u8BFB #\u8BA1\u5212/\u9605\u8BFB",
  "- [x] \u{1F5E3}\uFE0F \u6587\u732E\u590D\u4E60 5\u7BC7\uFF08\u5B9E 9\u7BC7\uFF09 #\u8BA1\u5212/\u7B14\u8BB0\u590D\u4E60",
  "- [ ] \u{1F9E0} \u7B14\u8BB0\u590D\u4E60 #\u8BA1\u5212/\u7B14\u8BB0\u590D\u4E60",
  "- [ ] \u{1F3C3} \u8FD0\u52A8 \u6BCF\u5929\u534A\u5C0F\u65F6 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [x] \u{1F3C3} \u62C9\u5347 1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [x] \u{1F3C3} \u5E73\u677F\u6491 3\u7EC4 #\u8BA1\u5212/\u8FD0\u52A8",
  "- [ ] \u{1F9D8} \u51A5\u60F3 #\u8BA1\u5212/\u51A5\u60F3"
].join("\n");
var rollupFacts = [
  { plan: "\u9605\u8BFB", live: true, pendingEmpty: true },
  { plan: "\u7B14\u8BB0\u590D\u4E60", live: true, pendingEmpty: true },
  { plan: "\u8FD0\u52A8", live: true, pendingEmpty: true },
  { plan: "\u51A5\u60F3", live: false, pendingEmpty: true }
  // 纯打卡计划：无目标恒不自动勾
];
var rollupModePredicate = (plan, text) => modeGoals.some((g) => g.plan === plan && matchesModeLine(text, g.name, g.floor, g.unit));
var rollupTargets = parentCheckTargets(rollupMd, rollupFacts, rollupModePredicate);
check("rollup: \u5F85\u529E\u6E05\u7A7A \u2192 \u9605\u8BFB\u7236\u884C\u5165\u8D26", rollupTargets.some((t) => t.plan === "\u9605\u8BFB"), rollupTargets);
check("rollup: \u6A21\u5F0F\u884C\u5168\u52FE \u2192 \u7B14\u8BB0\u590D\u4E60\u7236\u884C\u5165\u8D26\uFF08\u6A21\u5F0F\u884C\u5728\u524D\u4E0D\u6321\u7236\u884C\u8BC6\u522B\uFF09", rollupTargets.some((t) => t.plan === "\u7B14\u8BB0\u590D\u4E60"));
check("rollup: \u6A21\u5F0F\u884C\u5168\u52FE \u2192 \u8FD0\u52A8\u7236\u884C\u5165\u8D26", rollupTargets.some((t) => t.plan === "\u8FD0\u52A8"));
check("rollup: \u7EAF\u6253\u5361\u884C\uFF08\u65E0\u76EE\u6807\uFF09\u4E0D\u81EA\u52A8\u52FE", !rollupTargets.some((t) => t.plan === "\u51A5\u60F3"));
var _a48;
check("rollup: \u76EE\u6807\u5E26\u884C\u53F7\u4E0E\u539F\u6587\uFF08\u53EF\u76F4\u843D toggleTaskLine\uFF09", ((_a48 = rollupTargets.find((t) => t.plan === "\u9605\u8BFB")) == null ? void 0 : _a48.line) === 2);
var applied = rollupTargets.reduce((acc, t) => toggleTaskLine(acc, t.line, true, t.raw), rollupMd);
check("rollup: \u843D\u52FE\u540E\u7236\u884C\u4E3A [x]", applied.includes("- [x] \u{1F4D6} \u9605\u8BFB #\u8BA1\u5212/\u9605\u8BFB"), applied.split("\n")[2]);
check("rollup: \u5F85\u529E\u672A\u6E05\u4E0D\u52FE", !parentCheckTargets(rollupMd, rollupFacts.map((f) => f.plan === "\u9605\u8BFB" ? { ...f, pendingEmpty: false } : f), rollupModePredicate).some((t) => t.plan === "\u9605\u8BFB"));
check("rollup: \u7A97\u53E3\u5916\u8BA1\u5212\u4E0D\u52FE", !parentCheckTargets(rollupMd, rollupFacts.map((f) => f.plan === "\u9605\u8BFB" ? { ...f, live: false } : f), rollupModePredicate).some((t) => t.plan === "\u9605\u8BFB"));
check("rollup: \u7236\u884C \u270B \u8C41\u514D", !parentCheckTargets(rollupMd.replace("- [ ] \u{1F4D6} \u9605\u8BFB #\u8BA1\u5212/\u9605\u8BFB", "- [ ] \u{1F4D6} \u9605\u8BFB \u270B #\u8BA1\u5212/\u9605\u8BFB"), rollupFacts, rollupModePredicate).some((t) => t.plan === "\u9605\u8BFB"));
check("rollup: \u5DF2\u52FE\u7236\u884C\u4E0D\u518D\u5165\u8D26\uFF08\u5E42\u7B49\uFF09", !parentCheckTargets(rollupMd.replace("- [ ] \u{1F4D6} \u9605\u8BFB #\u8BA1\u5212/\u9605\u8BFB", "- [x] \u{1F4D6} \u9605\u8BFB #\u8BA1\u5212/\u9605\u8BFB"), rollupFacts, rollupModePredicate).some((t) => t.plan === "\u9605\u8BFB"));
check("rollup: \u6A21\u5F0F\u5B50\u884C\u672A\u5168\u52FE\u4E0D\u52FE\u7236\u884C", !parentCheckTargets(rollupMd.replace("- [x] \u{1F3C3} \u62C9\u5347 1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8", "- [ ] \u{1F3C3} \u62C9\u5347 1\u6B21 #\u8BA1\u5212/\u8FD0\u52A8"), rollupFacts, rollupModePredicate).some((t) => t.plan === "\u8FD0\u52A8"));
var twiceTargets = parentCheckTargets(rollupMd + "\n- [ ] \u{1F4D6} \u53C8\u4E00\u884C #\u8BA1\u5212/\u9605\u8BFB", rollupFacts, rollupModePredicate);
check("rollup: \u540C\u8BA1\u5212\u53EA\u8BA4\u7B2C\u4E00\u4E2A\u975E\u6A21\u5F0F\u884C", twiceTargets.filter((t) => t.plan === "\u9605\u8BFB").length === 1);
check("rollup: \u53EA\u626B\u4ECA\u65E5\u6253\u5361\u533A", parentCheckTargets("## \u{1F4CC} \u5176\u4ED6\n- [ ] \u{1F4D6} \u9605\u8BFB #\u8BA1\u5212/\u9605\u8BFB\n", [{ plan: "\u9605\u8BFB", live: true, pendingEmpty: true }], () => false).length === 0);
var factMd = [
  "# 2026-11-11",
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F4C8} \u590D\u76D8 #\u8BA1\u5212/\u590D\u76D8"
].join("\n");
var factFacts = [{ plan: "\u590D\u76D8", live: false, pendingEmpty: true, factDone: true }];
var factTargets = parentCheckTargets(factMd, factFacts, () => false);
check("fact: \u4E8B\u5B9E\u4E3A\u771F \u2192 \u65E0\u7A97\u53E3/\u65E0\u5F85\u529E\u4E5F\u52FE\u7236\u884C", factTargets.length === 1 && factTargets[0].plan === "\u590D\u76D8", factTargets);
check("fact: \u4E8B\u5B9E\u4E3A\u5047 \u2192 \u7EAF\u6253\u5361\u884C\u4ECD\u4E0D\u52FE", parentCheckTargets(factMd, [{ plan: "\u590D\u76D8", live: false, pendingEmpty: true }], () => false).length === 0);
check("fact: factDone:false \u540C\u4E0D\u52FE", parentCheckTargets(factMd, [{ plan: "\u590D\u76D8", live: false, pendingEmpty: true, factDone: false }], () => false).length === 0);
check("fact: \u270B \u8C41\u514D\u5BF9\u4E8B\u5B9E\u52FE\u540C\u6837\u751F\u6548", parentCheckTargets(factMd.replace("- [ ] \u{1F4C8} \u590D\u76D8 #\u8BA1\u5212/\u590D\u76D8", "- [ ] \u{1F4C8} \u590D\u76D8 \u270B #\u8BA1\u5212/\u590D\u76D8"), factFacts, () => false).length === 0);
check("fact: \u5DF2\u52FE\u5E42\u7B49\u4E0D\u518D\u5165\u8D26", parentCheckTargets(factMd.replace("- [ ] \u{1F4C8} \u590D\u76D8 #\u8BA1\u5212/\u590D\u76D8", "- [x] \u{1F4C8} \u590D\u76D8 #\u8BA1\u5212/\u590D\u76D8"), factFacts, () => false).length === 0);
check("fact: \u4E8B\u5B9E\u52FE\u53EF\u76F4\u843D toggleTaskLine", toggleTaskLine(factMd, factTargets[0].line, true, factTargets[0].raw).includes("- [x] \u{1F4C8} \u590D\u76D8 #\u8BA1\u5212/\u590D\u76D8"));
check("norm: \u6807\u9898\u5F52\u4E00\u5316", normalizeTocLabel("6.27 \u9AD8\u4F4D\u7A84\u5E45\u9707\u8361\u3001\u653E\u91CF\uFF08\u4E8C\uFF09") === "627\u9AD8\u4F4D\u7A84\u5E45\u9707\u8361\u653E\u91CF\u4E8C", normalizeTocLabel("6.27 \u9AD8\u4F4D\u7A84\u5E45\u9707\u8361\u3001\u653E\u91CF\uFF08\u4E8C\uFF09"));
{
  const edited = [
    { label: "\u7B2C6\u7AE0 \u91CF\u4EF7\u5206\u6790", href: "c6.xhtml", spineIndex: 5, children: [
      { label: "6.26 \u7F29\u91CF\u957F\u9634\u7834\u4F4D+\u7F29\u91CF\u957F\u9633\u6536\u590D", href: "c6d.xhtml", spineIndex: 5, children: [] },
      { label: "6.27 \u9AD8\u4F4D\u7A84\u5E45\u9707\u8361\u7684\u653E\u91CF", href: "", spineIndex: -1, children: [] }
    ] },
    { label: "\u7B2C7\u7AE0 \u8D8B\u52BF\u8F6C\u6298", href: "c7.xhtml", spineIndex: 6, children: [] }
  ];
  const live = [
    { label: "\u7B2C6\u7AE0 \u91CF\u4EF7\u5206\u6790", href: "c6.xhtml", spineIndex: 5, children: [] },
    { label: "6.26 \u7F29\u91CF\u957F\u9634\u7834\u4F4D\uFF0B\u7F29\u91CF\u957F\u9633\u6536\u590D", href: "c6d.xhtml", spineIndex: 5, children: [] },
    { label: "6.27 \u9AD8\u4F4D\u7A84\u5E45\u9707\u8361\u7684\u653E\u91CF", href: "c6e.xhtml", spineIndex: 5, children: [] },
    { label: "\u7B2C7\u7AE0 \u8D8B\u52BF\u8F6C\u6298", href: "c7.xhtml", spineIndex: 6, children: [] }
  ];
  resolveMissingAnchors(edited, live);
  check("\u8865\u9057: \u7CBE\u786E\u5F52\u4E00\u5316\u5339\u914D\u56DE\u586B", edited[0].children[1].href === "c6e.xhtml" && edited[0].children[1].spineIndex === 5);
  const added2 = [
    { label: "\u7B2C1\u7AE0 A", href: "a.xhtml", spineIndex: 0, children: [] },
    { label: "\u624B\u5DE5\u8865\u7684\u4E2D\u95F4\u7AE0\uFF08\u4E66\u91CC\u5B9E\u9645\u6709\u4F46\u76EE\u5F55\u7F3A\u5931\uFF09", href: "", spineIndex: -1, children: [] },
    { label: "\u7B2C2\u7AE0 B", href: "b.xhtml", spineIndex: 1, children: [] }
  ];
  resolveMissingAnchors(added2, null);
  inferNeighborSpines(added2);
  check("\u8865\u9057: \u65E0\u5B9E\u65F6\u76EE\u5F55\u65F6\u7EE7\u627F\u524D\u53F6\u7AE0\u5E8F", added2[1].spineIndex === 0, added2[1].spineIndex);
  const leading = [
    { label: "\u624B\u5DE5\u524D\u8A00", href: "", spineIndex: -1, children: [] },
    { label: "\u7B2C1\u7AE0 A", href: "a.xhtml", spineIndex: 0, children: [] }
  ];
  inferNeighborSpines(leading);
  check("\u8865\u9057: \u9996\u4E2A\u951A\u70B9\u4E4B\u524D\u4E0D\u8BEF\u5224", leading[0].spineIndex === -1 && leading[1].spineIndex === 0);
}
var fmAnchor3 = `---
plans:
  \u9605\u8BFB:
    type: \u6570\u91CF
    goals:
      - name: \u6D4B\u8BD5\u4E66
        count: 2
        unit: \u8282
        structure:
          - unit: \u7AE0
            counts: [2]
        readerSid: epubsrc-abc
        readerAnchors:
          - "0|c1.xhtml|0.25"
          - "1|c2.xhtml"
---
`;
var defsA3 = parsePlansFromFrontmatter(fmAnchor3);
var _a49, _b23;
var a3 = (_b23 = (_a49 = defsA3[0]) == null ? void 0 : _a49.goals[0]) == null ? void 0 : _b23.readerAnchors;
var _a50, _b24, _c10, _d4, _e3;
check("anchors3: \u4E09\u6BB5\u89E3\u6790 spine/href/progress", ((_a50 = a3 == null ? void 0 : a3[0]) == null ? void 0 : _a50.spine) === 0 && ((_b24 = a3 == null ? void 0 : a3[0]) == null ? void 0 : _b24.href) === "c1.xhtml" && ((_c10 = a3 == null ? void 0 : a3[0]) == null ? void 0 : _c10.progress) === 0.25, JSON.stringify((_e3 = (_d4 = defsA3[0]) == null ? void 0 : _d4.goals[0]) == null ? void 0 : _e3.readerAnchors));
var _a51, _b25;
check("anchors3: \u4E24\u6BB5\u65E7\u683C\u5F0F\u65E0 progress", ((_a51 = a3 == null ? void 0 : a3[1]) == null ? void 0 : _a51.href) === "c2.xhtml" && ((_b25 = a3 == null ? void 0 : a3[1]) == null ? void 0 : _b25.progress) === void 0);
var convF = weaveTocToStructure(bookTree);
check("anchors3: \u6865\u53F6\u5E8F progress \u6570\u7EC4\u5BF9\u9F50", !!convF && convF.leafProgress.length === convF.leafSpine.length && convF.leafProgress.every((x) => typeof x === "number"));
var pt = parseToc("\u7B2C1\u7AE0 \u521D\u89C1\n  1.1 \u76F8\u9047\n  1.2 \u79BB\u522B\n\u7B2C2\u7AE0 \u72EC\u767D");
var _a52, _b26;
check("paste labels: \u9644\u5E26\u6BCF\u5C42\u6807\u9898", ((_a52 = pt == null ? void 0 : pt.levels[0].labels) == null ? void 0 : _a52[0]) === "\u7B2C1\u7AE0 \u521D\u89C1" && ((_b26 = pt == null ? void 0 : pt.levels[1].labels) == null ? void 0 : _b26[0]) === "1.1 \u76F8\u9047", JSON.stringify(pt == null ? void 0 : pt.levels[1].labels));
var ptLeaves = expandGoalStructure("\u4E66", pt.levels);
var _a53, _b27;
check("paste labels: \u53F6\u540D\u5E26\u771F\u5B9E\u6807\u9898", ((_a53 = ptLeaves[0]) == null ? void 0 : _a53.name) === "\u4E66\uFF08\u7B2C1\u7AE0 \u521D\u89C1\xB71.1 \u76F8\u9047\uFF09", (_b27 = ptLeaves[0]) == null ? void 0 : _b27.name);
var fmWriting = `---
plans:
  - name: \u5C0F\u8BF4
    label: "\u270D\uFE0F"
    goals:
      - name: \u300A\u4E09\u4F53\u300B
        count: 0
        unit: \u5B57
        mode: writing
        floor: 1166.7
        writingQuota:
          total: 100000
          unit: \u5B57
          start: 2026-01-01
          end: 2026-12-31
          initial: 20000
      - name: \u300A\u9ED1\u6697\u68EE\u6797\u300B
        count: 3
        unit: \u7AE0
        mode: writing
        structure:
          - unit: \u7AE0
            counts: [3]
---
`;
var defsW = parsePlansFromFrontmatter(fmWriting);
var wPlan = defsW[0];
check("writing: \u8BA1\u5212\u4E3A\u6570\u91CF\u578B", (wPlan == null ? void 0 : wPlan.type) === "numeric");
var wq = wPlan == null ? void 0 : wPlan.goals[0];
check("writing: mode=writing \u89E3\u6790", (wq == null ? void 0 : wq.mode) === "writing");
var _a54, _b28;
check("writing: \u76EE\u6807\u7EA7\u5B57\u6570\u914D\u989D\u89E3\u6790", ((_a54 = wq == null ? void 0 : wq.writingQuota) == null ? void 0 : _a54.total) === 1e5 && ((_b28 = wq == null ? void 0 : wq.writingQuota) == null ? void 0 : _b28.end) === "2026-12-31", JSON.stringify(wq == null ? void 0 : wq.writingQuota));
var _a55;
check("writing: \u63A5\u7EED\u521D\u59CB\u91CF\u89E3\u6790", ((_a55 = wq == null ? void 0 : wq.writingQuota) == null ? void 0 : _a55.initial) === 2e4);
check("writing: floor \u51BB\u7ED3\u914D\u989D\u539F\u6837\u4FDD\u7559", (wq == null ? void 0 : wq.floor) === 1166.7);
var wc = wPlan == null ? void 0 : wPlan.goals[1];
var _a56, _b29, _c11;
check("writing: \u6309\u7AE0\u8282 = 1 \u7EA7\u7AE0\u7ED3\u6784\u5E73\u94FA", (wc == null ? void 0 : wc.mode) === "writing" && ((_c11 = (_b29 = (_a56 = wc == null ? void 0 : wc.structure) == null ? void 0 : _a56[0]) == null ? void 0 : _b29.counts) == null ? void 0 : _c11[0]) === 3 && !(wc == null ? void 0 : wc.writingQuota));
var wLeaves = expandGoalLeaves("\u300A\u9ED1\u6697\u68EE\u6797\u300B", wc);
var _a57, _b30;
check("writing: \u7AE0\u53F6\u547D\u540D\u300C\u7B2C N \u7AE0\u300D\u5168\u4E66\u8FDE\u7EED", ((_a57 = wLeaves == null ? void 0 : wLeaves[0]) == null ? void 0 : _a57.name) === "\u300A\u9ED1\u6697\u68EE\u6797\u300B\uFF08\u7B2C 1 \u7AE0\uFF09" && ((_b30 = wLeaves == null ? void 0 : wLeaves[2]) == null ? void 0 : _b30.name) === "\u300A\u9ED1\u6697\u68EE\u6797\u300B\uFF08\u7B2C 3 \u7AE0\uFF09", JSON.stringify(wLeaves == null ? void 0 : wLeaves.map((l) => l.name)));
check("writing daily: 8 \u4E07\u5B57 \xF7 365 \u5929", computeWritingDaily(1e5, 2e4, "2026-01-01", "2026-12-31") === Math.round(8e4 / 365 * 10) / 10, computeWritingDaily(1e5, 2e4, "2026-01-01", "2026-12-31"));
check("writing daily: initial=0 \u4E0E quota \u540C\u53E3\u5F84", computeWritingDaily(1e5, 0, "2026-01-01", "2026-01-31") === computeQuotaDaily(1e5, "2026-01-01", "2026-01-31"));
check("writing line: \u8BC6\u522B\u914D\u989D\u884C\u542B\u5B9E\u91CF", matchesWritingLine("\u270D\uFE0F \u300A\u4E09\u4F53\u300B 1166.7\u5B57\uFF08\u5B9E 800\u5B57\uFF09", "\u300A\u4E09\u4F53\u300B"));
check("writing line: \u8BC6\u522B\u5386\u53F2\u65E7\u914D\u989D\u884C", matchesWritingLine("\u270D\uFE0F \u300A\u4E09\u4F53\u300B 999\u5B57", "\u300A\u4E09\u4F53\u300B"));
check("writing line: \u65E0\u6570\u5B57\u4E0D\u8BA4\uFF08\u8BA1\u5212\u9ED8\u8BA4\u884C\u9632\u8BEF\u5224\uFF09", !matchesWritingLine("\u270D\uFE0F \u300A\u4E09\u4F53\u300B \u6BCF\u5929\u5199", "\u300A\u4E09\u4F53\u300B"));
check("writing line: \u4ED6\u4EBA\u540D\u5B57\u4E0D\u8BA4", !matchesWritingLine("\u270D\uFE0F \u300A\u7403\u72B6\u95EA\u7535\u300B 500\u5B57", "\u300A\u4E09\u4F53\u300B"));
{
  const r = diffShareClear(null, [{ key: "\u9605\u8BFB||\u4E09\u4F53", name: "\u4E09\u4F53", cleared: true }]);
  check("shareClear: \u9996\u8F6E\u57FA\u7EBF\u4E0D\u63D0\u9192", r.cleared.length === 0, r.cleared);
  check("shareClear: \u9996\u8F6E\u5FEB\u7167\u843D\u4F4D", r.next.get("\u9605\u8BFB||\u4E09\u4F53") === true);
}
{
  const prev = /* @__PURE__ */ new Map([["\u9605\u8BFB||\u4E09\u4F53", false]]);
  const r = diffShareClear(prev, [{ key: "\u9605\u8BFB||\u4E09\u4F53", name: "\u4E09\u4F53", cleared: true }]);
  check("shareClear: false\u2192true \u8DC3\u8FC1\u63D0\u9192", r.cleared.length === 1 && r.cleared[0] === "\u4E09\u4F53", r.cleared);
}
{
  const prev = /* @__PURE__ */ new Map([["\u9605\u8BFB||\u4E09\u4F53", true]]);
  const r = diffShareClear(prev, [{ key: "\u9605\u8BFB||\u4E09\u4F53", name: "\u4E09\u4F53", cleared: true }]);
  check("shareClear: \u5DF2\u6E05\u7A7A\u4FDD\u6301\u9759\u9ED8", r.cleared.length === 0, r.cleared);
}
{
  const prev = /* @__PURE__ */ new Map([["\u9605\u8BFB||\u4E09\u4F53", false]]);
  const r = diffShareClear(prev, [{ key: "\u9605\u8BFB||\u4E09\u4F53", name: "\u4E09\u4F53", cleared: false }]);
  check("shareClear: \u672A\u6E05\u7A7A\u9759\u9ED8\u4E14\u5FEB\u7167\u8DDF\u968F", r.cleared.length === 0 && r.next.get("\u9605\u8BFB||\u4E09\u4F53") === false);
}
{
  const prev = /* @__PURE__ */ new Map([["\u9605\u8BFB||\u4E09\u4F53", false], ["\u9605\u8BFB||\u7EA2\u697C\u68A6", false]]);
  const r = diffShareClear(prev, [
    { key: "\u9605\u8BFB||\u4E09\u4F53", name: "\u4E09\u4F53", cleared: true },
    { key: "\u9605\u8BFB||\u7EA2\u697C\u68A6", name: "\u7EA2\u697C\u68A6", cleared: true }
  ]);
  check("shareClear: \u540C\u6279\u591A\u4E66\u9F50\u8DC3\u8FC1\uFF08\u5408\u5E76\u4E00\u6761\uFF09", r.cleared.length === 2 && r.next.size === 2, r.cleared);
}
{
  const prev = /* @__PURE__ */ new Map([["\u9605\u8BFB||\u65E7\u4E66", false]]);
  const r = diffShareClear(prev, [
    { key: "\u9605\u8BFB||\u65E7\u4E66", name: "\u65E7\u4E66", cleared: false },
    { key: "\u9605\u8BFB||\u65B0\u4E66", name: "\u65B0\u4E66", cleared: true }
  ]);
  check("shareClear: \u9996\u89C1\u5373\u6E05\u7A7A\u6309\u57FA\u7EBF\u4E0D\u63D0\u9192", r.cleared.length === 0 && r.next.size === 2, r.cleared);
}
{
  const afterUncheck = diffShareClear(/* @__PURE__ */ new Map([["\u9605\u8BFB||\u4E09\u4F53", true]]), [{ key: "\u9605\u8BFB||\u4E09\u4F53", name: "\u4E09\u4F53", cleared: false }]);
  check("shareClear: \u9000\u52FE\u56DE\u843D\u9759\u9ED8", afterUncheck.cleared.length === 0 && afterUncheck.next.get("\u9605\u8BFB||\u4E09\u4F53") === false);
  const afterRecheck = diffShareClear(afterUncheck.next, [{ key: "\u9605\u8BFB||\u4E09\u4F53", name: "\u4E09\u4F53", cleared: true }]);
  check("shareClear: \u91CD\u52FE\u518D\u8DC3\u8FC1\u518D\u63D0\u9192", afterRecheck.cleared.length === 1, afterRecheck.cleared);
}
{
  const diary = ["# \u7761\u7720\u76F8\u5173", "23:30-07:00", "", "# \u968F\u7B14", "\u60F3\u5230\u4EC0\u4E48\u5199\u4EC0\u4E48\u3002", "", "# \u65B0\u95FB\u8054\u64AD", ""].join("\n");
  const out = nextDayPlanTransform(diary, "\u660E\u65E5\u5F85\u529E\u4E00");
  const expected = ["# \u7761\u7720\u76F8\u5173", "23:30-07:00", "", "# \u968F\u7B14", "\u60F3\u5230\u4EC0\u4E48\u5199\u4EC0\u4E48\u3002", "", "# \u6B21\u65E5\u8BA1\u5212", "", "\u660E\u65E5\u5F85\u529E\u4E00", "", "# \u65B0\u95FB\u8054\u64AD", ""].join("\n");
  check("nextDay: \u9996\u5199\u63D2\u5728\u968F\u7B14\u8282\u5C3E", out === expected, out);
}
{
  const diary = ["# \u968F\u7B14", "\u968F\u7B14\u5185\u5BB9", "", "# \u5F53\u65E5\u590D\u76D8", "\u590D\u76D8\u5185\u5BB9", "", "## \u660E\u65E5\u8BA1\u5212", "- \u65E7\u5185\u5BB9", "", "# \u65B0\u95FB\u8054\u64AD", ""].join("\n");
  const out = nextDayPlanTransform(diary, "\u65B0\u8BA1\u5212");
  const expected = ["# \u968F\u7B14", "\u968F\u7B14\u5185\u5BB9", "", "# \u5F53\u65E5\u590D\u76D8", "\u590D\u76D8\u5185\u5BB9", "", "## \u660E\u65E5\u8BA1\u5212", "- \u65E7\u5185\u5BB9", "", "# \u6B21\u65E5\u8BA1\u5212", "", "\u65B0\u8BA1\u5212", "", "# \u65B0\u95FB\u8054\u64AD", ""].join("\n");
  check("nextDay: \u951A\u70B9\u5F53\u65E5\u590D\u76D8\u8282\u5C3E\uFF0C## \u5B50\u8282\u4E0D\u88AB\u622A\u65AD", out === expected, out);
}
{
  const diary = ["# \u968F\u7B14", "", "# \u65B0\u95FB\u8054\u64AD", ""].join("\n");
  const once = nextDayPlanTransform(diary, "\u8BA1\u5212\u5185\u5BB9");
  const twice = nextDayPlanTransform(once, "\u8BA1\u5212\u5185\u5BB9");
  check("nextDay: \u91CD\u590D\u5199\u5165\u5E42\u7B49", twice === once, twice);
  check("nextDay: \u6807\u9898\u552F\u4E00", once.split("# \u6B21\u65E5\u8BA1\u5212").length === 2, once);
}
{
  const diary = ["# \u968F\u7B14", "\u5185\u5BB9", "", "# \u65B0\u95FB\u8054\u64AD", ""].join("\n");
  const out = nextDayPlanTransform(diary, "\n\u7B2C\u4E00\u884C\n\n## \u5206\u8282\n\u7B2C\u4E8C\u884C\n\n");
  const expected = ["# \u968F\u7B14", "\u5185\u5BB9", "", "# \u6B21\u65E5\u8BA1\u5212", "", "\u7B2C\u4E00\u884C", "", "## \u5206\u8282", "\u7B2C\u4E8C\u884C", "", "# \u65B0\u95FB\u8054\u64AD", ""].join("\n");
  check("nextDay: \u6B63\u6587\u7A7A\u884C/\u5B50\u6807\u9898\u539F\u6837\uFF0C\u9996\u5C3E\u7A7A\u884C\u89C4\u6574", out === expected, out);
}
{
  check("nextDay: \u53CC\u951A\u70B9\u7F3A\u5931\u8FD4\u56DE null", nextDayPlanTransform("# \u65E5\u8BB0\n\u6B63\u6587\n", "x") === null, void 0);
  const moved = ["# \u6B21\u65E5\u8BA1\u5212", "", "\u65E7\u8BA1\u5212", "", "# \u968F\u7B14", "\u5185\u5BB9", ""].join("\n");
  const out = nextDayPlanTransform(moved, "\u65B0\u8BA1\u5212");
  const expectedMoved = ["# \u6B21\u65E5\u8BA1\u5212", "", "\u65B0\u8BA1\u5212", "", "# \u968F\u7B14", "\u5185\u5BB9", ""].join("\n");
  check("nextDay: \u5DF2\u6709\u5C0F\u8282\u539F\u4F4D\u66FF\u6362\u4E0D\u642C\u5BB6", out === expectedMoved, out);
}
{
  const diary = ["# \u968F\u7B14", "\u5185\u5BB9", "", "# \u6B21\u65E5\u8BA1\u5212", "", "\u7B2C\u4E00\u884C", "", "## \u5206\u8282", "\u7B2C\u4E8C\u884C", "", "# \u65B0\u95FB\u8054\u64AD", ""].join("\n");
  check("extract nextDay: \u6B63\u6587\u542B\u5B50\u6807\u9898", extractNextDayPlanSection(diary) === ["\u7B2C\u4E00\u884C", "", "## \u5206\u8282", "\u7B2C\u4E8C\u884C"].join("\n"), extractNextDayPlanSection(diary));
  check("extract nextDay: \u65E0\u5C0F\u8282\u8FD4\u56DE null", extractNextDayPlanSection("# \u968F\u7B14\n\u5185\u5BB9\n") === null, void 0);
}
{
  const c = parseChoreCycle({ unit: "week", days: [0] });
  check("cycle: week \u5355\u4F4D\u76F4\u8BA4", (c == null ? void 0 : c.unit) === "week" && c.days.length === 1 && c.days[0] === 0, c);
  const d = parseChoreCycle({ unit: "\u6BCF\u5929", days: [1, 2] });
  check("cycle: \u4E2D\u6587\u5355\u4F4D\u6BCF\u5929\uFF08days \u5FFD\u7565\u5F52\u7A7A\uFF09", (d == null ? void 0 : d.unit) === "day" && d.days.length === 0, d);
  const m2 = parseChoreCycle({ unit: "month", days: "21, 1, 11" });
  check("cycle: \u5B57\u7B26\u4E32 days \u89E3\u6790\u5E76\u6392\u5E8F\u53BB\u91CD", !!m2 && m2.unit === "month" && m2.days.join(",") === "1,11,21", m2);
  const y = parseChoreCycle({ unit: "year", days: [3, 1] });
  check("cycle: year \u4E8C\u5143\u7EC4 [\u6708, \u65E5]", (y == null ? void 0 : y.unit) === "year" && y.days[0] === 3 && y.days[1] === 1, y);
  check("cycle: \u975E\u5BF9\u8C61 \u2192 undefined", parseChoreCycle("week") === void 0, void 0);
  check("cycle: week \u7A7A days \u2192 undefined", parseChoreCycle({ unit: "week", days: [] }) === void 0, void 0);
  check("cycle: week \u8D8A\u754C \u2192 undefined", parseChoreCycle({ unit: "week", days: [7] }) === void 0, void 0);
  check("cycle: month \u8D8A\u754C \u2192 undefined", parseChoreCycle({ unit: "month", days: [0, 32] }) === void 0, void 0);
  check("cycle: year \u7F3A\u65E5\u5B50 \u2192 undefined", parseChoreCycle({ unit: "year", days: [3] }) === void 0, void 0);
  check("cycle: \u672A\u77E5\u5355\u4F4D \u2192 undefined", parseChoreCycle({ unit: "hour", days: [1] }) === void 0, void 0);
  check("overdue: postpone \u76F4\u8BA4", parseChoreOverdue("postpone") === "postpone", void 0);
  check("overdue: \u4E2D\u6587\u5F80\u540E\u5EF6", parseChoreOverdue("\u5F80\u540E\u5EF6") === "postpone", void 0);
  check("overdue: \u653E\u5F03/skip \u2192 undefined\uFF08\u7F3A\u7701\u5373\u653E\u5F03\uFF0C\u4E0D\u843D\u76D8\uFF09", parseChoreOverdue("\u653E\u5F03") === void 0 && parseChoreOverdue("skip") === void 0, void 0);
  check("label: \u6BCF\u5929", choreCycleLabel({ unit: "day", days: [] }) === "\u6BCF\u5929", void 0);
  check("label: \u6BCF\u5468\u5355\u65E5", choreCycleLabel({ unit: "week", days: [0] }) === "\u6BCF\u5468\u65E5", void 0);
  check("label: \u6BCF\u5468\u591A\u65E5", choreCycleLabel({ unit: "week", days: [4, 1] }) === "\u6BCF\u5468\u4E00\u3001\u5468\u56DB", void 0);
  check("label: \u6BCF\u6708\u591A\u53F7", choreCycleLabel({ unit: "month", days: [21, 1, 11] }) === "\u6BCF\u6708 1\u300111\u300121 \u53F7", void 0);
  check("label: \u6BCF\u5E74", choreCycleLabel({ unit: "year", days: [3, 1] }) === "\u6BCF\u5E74 3 \u6708 1 \u65E5", void 0);
  check("label: \u987A\u5EF6\u540E\u7F00", choreCycleLabel({ unit: "day", days: [] }, "postpone") === "\u6BCF\u5929 \xB7 \u6F0F\u4E86\u5F80\u540E\u5EF6", void 0);
}
{
  const daily = { unit: "day", days: [] };
  check("due: \u6BCF\u5929\u6052\u771F", isChoreDueOn(daily, "2026-11-11") && isChoreDueOn(daily, "2027-01-01"), void 0);
  const sunday = { unit: "week", days: [0] };
  check("due: \u6BCF\u5468\u65E5\u2014\u2014\u5468\u65E5\u771F\u5468\u4E00\u5047", isChoreDueOn(sunday, "2026-11-15") && !isChoreDueOn(sunday, "2026-11-16"), void 0);
  const monThu = { unit: "week", days: [1, 4] };
  check("due: \u6BCF\u5468\u4E00/\u56DB\u2014\u2014\u4E24\u5929\u771F\u5176\u4F59\u5047", isChoreDueOn(monThu, "2026-11-09") && isChoreDueOn(monThu, "2026-11-12") && !isChoreDueOn(monThu, "2026-11-10"), void 0);
  const month31 = { unit: "month", days: [31] };
  check("due: \u6BCF\u670831\u53F7\u2014\u2014\u5927\u6708\u771F\u5C0F\u6708\u843D\u6708\u672B", isChoreDueOn(month31, "2026-01-31") && !isChoreDueOn(month31, "2026-04-29") && isChoreDueOn(month31, "2026-04-30"), void 0);
  const year229 = { unit: "year", days: [2, 29] };
  check("due: \u6BCF\u5E742/29\u2014\u2014\u95F0\u5E74\u771F\u5E73\u5E74\u843D2/28", isChoreDueOn(year229, "2024-02-29") && isChoreDueOn(year229, "2023-02-28") && !isChoreDueOn(year229, "2023-03-01"), void 0);
  check("prev: \u5468\u4E00\u5F80\u56DE\u627E\u4E0A\u5468\u65E5", prevChoreOccurrence(sunday, "2026-11-16") === "2026-11-15", prevChoreOccurrence(sunday, "2026-11-16"));
  check("prev: \u8BE5\u505A\u65E5\u5F53\u5929\u8FD4\u56DE\u5F53\u5929", prevChoreOccurrence(sunday, "2026-11-15") === "2026-11-15", void 0);
  check("prev: \u6BCF\u670831\u53F7\u4ECE4/10\u56DE\u9000\u52303/31", prevChoreOccurrence(month31, "2026-04-10") === "2026-03-31", prevChoreOccurrence(month31, "2026-04-10"));
  check("prev: \u5E74\u5EA6\u4ECE2/20\u56DE\u9000\u5230\u53BB\u5E743/1", prevChoreOccurrence({ unit: "year", days: [3, 1] }, "2026-02-20") === "2025-03-01", void 0);
  check("next: \u5468\u65E5\u7684\u4E0B\u4E00\u4E2A\u662F\u4E0B\u5468\u65E5", nextChoreOccurrence(sunday, "2026-11-15") === "2026-11-22", void 0);
  check("next: 4/30\uFF08\u6708\u672B\u56DE\u843D\uFF09\u7684\u4E0B\u4E00\u4E2A\u662F5/31", nextChoreOccurrence(month31, "2026-04-30") === "2026-05-31", nextChoreOccurrence(month31, "2026-04-30"));
  check("next: \u5E74\u5EA63/2\u7684\u4E0B\u4E00\u4E2A\u662F\u660E\u5E743/1", nextChoreOccurrence({ unit: "year", days: [3, 1] }, "2026-03-02") === "2027-03-01", void 0);
  const occ = choreOccurrences(monThu, "2026-11-09", "2026-11-22");
  check("occ: \u6BCF\u5468\u4E00/\u56DB\u4E24\u5468\u679A\u4E3E 4 \u6B21", occ.join(",") === "2026-11-09,2026-11-12,2026-11-16,2026-11-19", occ);
  check("occ: \u8D77\u70B9=\u8BE5\u505A\u65E5\u542B\u9996\u4E0D\u542B\u5C3E\u540E", choreOccurrences(sunday, "2026-11-15", "2026-11-15").join(",") === "2026-11-15", void 0);
  check("occ: \u8D77\u70B9\u665A\u4E8E\u7EC8\u70B9 \u2192 \u7A7A", choreOccurrences(sunday, "2026-11-20", "2026-11-15").length === 0, void 0);
  check("occ: cap \u622A\u65AD", choreOccurrences(daily, "2026-01-01", "2026-12-31", 10).length === 10, void 0);
  check("occ: \u6BCF\u5E74\u7A97\u53E3\u5185\u81F3\u591A\u4E00\u6B21", choreOccurrences({ unit: "year", days: [3, 1] }, "2026-01-01", "2026-12-31").join(",") === "2026-03-01", void 0);
}
{
  const content = [
    "---",
    "date: 2026-11-11",
    "---",
    "# \u{1F4C5} 2026-11-11 \u661F\u671F\u4E09",
    "",
    CHECK_HEADING,
    "- [ ] \u{1F3E0} \u65E5\u5E38\u751F\u6D3B #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-11 \u{1F4C5} 2026-11-11",
    "- [x] \u6D17\u7897 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-11 \u{1F4C5} 2026-11-11",
    "",
    "## \u{1F4DD} \u4ECA\u65E5\u603B\u7ED3",
    ""
  ].join("\n");
  const out = missingChoreLines(content, [
    { plan: "\u65E5\u5E38\u751F\u6D3B", name: "\u6D17\u7897" },
    { plan: "\u65E5\u5E38\u751F\u6D3B", name: "\u505A\u536B\u751F" }
  ], "2026-11-11");
  check(
    "choreLines: \u5DF2\u5B58\u5728\uFF08\u542B\u5DF2\u52FE\uFF09\u4E0D\u91CD\u5EFA\uFF0C\u7F3A\u5931\u8865\u4E00\u884C",
    out.length === 1 && out[0] === "- [ ] \u505A\u536B\u751F #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-11 \u{1F4C5} 2026-11-11",
    out
  );
}
{
  const content = [
    CHECK_HEADING,
    "- [ ] \u6D17\u7897\u673A #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-11 \u{1F4C5} 2026-11-11",
    "- [ ] \u6D17\u7897 #\u8BA1\u5212/\u5BB6\u52A1 \u{1F6EB} 2026-11-11 \u{1F4C5} 2026-11-11",
    "- [ ] \u4E70\u83DC\uFF08\u7B2C 2 \u6B21\uFF09 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-11 \u{1F4C5} 2026-11-11"
  ].join("\n");
  const out = missingChoreLines(content, [
    { plan: "\u65E5\u5E38\u751F\u6D3B", name: "\u6D17\u7897" },
    { plan: "\u65E5\u5E38\u751F\u6D3B", name: "\u4E70\u83DC" }
  ], "2026-11-11");
  check("choreLines: \u7CBE\u786E\u5339\u914D\u2014\u2014\u8FD1\u540D/\u5F02\u8BA1\u5212/\u5E26\u540E\u7F00\u90FD\u4E0D\u9876\u66FF", out.length === 2, out);
}
check("split: \u6BCF\u5929 3 \u9910 \u2192 3", splitTickCount(3, "\u9910") === 3);
check("split: \u6BCF\u5929 2 \u9910 \u2192 2", splitTickCount(2, "\u9910") === 2);
check("split: \u8FDE\u7EED\u91CF\u5355\u4F4D\u4E0D\u62C6\uFF082 \u5206\u949F\uFF09", splitTickCount(2, "\u5206\u949F") === 0);
check("split: 1 \u6B21\u4E0D\u62C6", splitTickCount(1, "\u6B21") === 0);
check(
  "split: \u751F\u6D3B\u4E8B\u9879\u884C\u8BC6\u522B\u91CF\u8BB0\u53F7\u6052 0\uFF08\u88F8\u540D\uFF09",
  modeLineAmount("chore", 3, "\u9910").floor === 0 && modeLineAmount("chore", 3, "\u9910").unit === "",
  modeLineAmount("chore", 3, "\u9910")
);
check(
  "split: \u8FD0\u52A8\u884C\u8BC6\u522B\u6CBF\u7528 floor/unit",
  modeLineAmount("exercise", 2, "\u6B21").floor === 2 && modeLineAmount("exercise", 2, "\u6B21").unit === "\u6B21"
);
check("split: \u5468\u671F\u6587\u6848\u5E26\u6B21\u6570\uFF08\u6BCF\u5929 3\u9910\uFF09", choreCycleLabel({ unit: "day", days: [] }, void 0, 3, "\u9910") === "\u6BCF\u5929 3\u9910", choreCycleLabel({ unit: "day", days: [] }, void 0, 3, "\u9910"));
var choreSplitMd = [
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F3E0} \u65E5\u5E38\u751F\u6D3B #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-13 \u{1F4C5} 2026-11-13",
  "- [ ] \u4E09\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-13 \u{1F4C5} 2026-11-13",
  "	- [x] \u4E09\u9910\u7B2C1\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-13 \u{1F4C5} 2026-11-13",
  "	- [ ] \u4E09\u9910\u7B2C2\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-13 \u{1F4C5} 2026-11-13",
  "	- [ ] \u4E09\u9910\u7B2C3\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-13 \u{1F4C5} 2026-11-13"
].join("\n");
var choreSplitGoals = [{ plan: "\u65E5\u5E38\u751F\u6D3B", name: "\u4E09\u9910", floor: 3, unit: "\u9910", mode: "chore" }];
var isChoreSplitModeLine = (it) => !it.tick && choreSplitGoals.some((g) => {
  const amt = modeLineAmount(g.mode, g.floor, g.unit);
  return g.plan === it.plan && matchesModeLine(it.text, g.name, amt.floor, amt.unit);
});
var choreSplitParsed = parseDailyContent(dailyFile, choreSplitMd, "2026-11-13");
var choreSplitRows = topLevelCheckRows(choreSplitParsed.checkItems, isChoreSplitModeLine);
check("chore split: \u5927\u9879\u4ECD 1\uFF08\u6B21\u884C\u4E0D\u843D\u9876\u5C42\uFF09", choreSplitRows.length === 1, choreSplitRows.length);
check("chore split: \u4E8B\u9879\u884C\u6302\u5728\u7236\u884C\u4E0B", choreSplitRows[0].modeChildren.length === 1, choreSplitRows[0].modeChildren.length);
check("chore split: 2/3 \u9910 \u2192 \u5927\u9879\u672A\u5B8C\u6210", choreSplitRows[0].done === false, choreSplitRows[0].done);
var choreAllMd = choreSplitMd.replace("	- [ ] \u4E09\u9910\u7B2C2\u9910", "	- [x] \u4E09\u9910\u7B2C2\u9910").replace("	- [ ] \u4E09\u9910\u7B2C3\u9910", "	- [x] \u4E09\u9910\u7B2C3\u9910");
var choreAllRows = topLevelCheckRows(parseDailyContent(dailyFile, choreAllMd, "2026-11-13").checkItems, isChoreSplitModeLine);
check("chore split: 3/3 \u9910 \u2192 \u4E8B\u9879\u884C\u5B8C\u6210 \u2192 \u5927\u9879\u5B8C\u6210", choreAllRows[0].done === true, choreAllRows[0].done);
var choreTickSpec = { plan: "\u65E5\u5E38\u751F\u6D3B", name: "\u4E09\u9910", label: "\u{1F3E0}", floor: 0, unit: "\u9910" };
var choreRecBase = [
  "## \u2705 \u4ECA\u65E5\u6253\u5361",
  "- [ ] \u{1F3E0} \u65E5\u5E38\u751F\u6D3B #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-13 \u{1F4C5} 2026-11-13",
  "- [ ] \u4E09\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-13 \u{1F4C5} 2026-11-13"
].join("\n");
var choreRec1 = reconcileTickRows(choreRecBase, choreTickSpec, 3, "2026-11-13");
check("chore split \u751F\u6210: \u8865\u51FA\u4E09\u6761\u300C\u7B2Ck\u9910\u300D\u6B21\u884C", choreRec1.split("\n").filter((l) => l.includes("\u4E09\u9910\u7B2C")).length === 3, choreRec1);
check("chore split \u751F\u6210: \u4E8B\u9879\u884C\u4FDD\u6301\u88F8\u540D\uFF08\u4E0D\u5D4C 3\u9910\uFF09", choreRec1.includes("- [ ] \u4E09\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B"), choreRec1);
check("chore split \u751F\u6210: \u5E42\u7B49", reconcileTickRows(choreRec1, choreTickSpec, 3, "2026-11-13") === choreRec1);
check("chore split mirror: \u5168\u672A\u52FE\u65E0\u52A8\u4F5C", subItemMirrorTargets(choreRec1, [choreTickSpec]).length === 0);
var choreMir = subItemMirrorTargets(
  choreRec1.replace(/\[ \] 三餐第/g, "[x] \u4E09\u9910\u7B2C"),
  [choreTickSpec]
);
check("chore split mirror: \u4E09\u6761\u5168\u52FE \u2192 \u4E8B\u9879\u884C\u5F85\u52FE", choreMir.length === 1 && choreMir[0].checked === true, choreMir);
var choreMirBack = subItemMirrorTargets(
  choreRec1.replace("	- [ ] \u4E09\u9910\u7B2C1\u9910", "	- [x] \u4E09\u9910\u7B2C1\u9910").replace("- [ ] \u4E09\u9910 #", "- [x] \u4E09\u9910 #"),
  [choreTickSpec]
);
check("chore split mirror: \u4E8B\u9879\u884C\u52FE\u7740\u4F46\u6B21\u884C\u672A\u52FE \u2192 \u5F85\u9000", choreMirBack.length === 1 && choreMirBack[0].checked === false, choreMirBack);
check("chore split done: 2/3 \u4E0D\u7B97", splitTicksDone(choreSplitParsed.checkItems, "\u65E5\u5E38\u751F\u6D3B", "\u4E09\u9910", "\u9910", 3) === false);
check(
  "chore split done: 3/3 \u7B97",
  splitTicksDone(parseDailyContent(dailyFile, choreAllMd, "2026-11-13").checkItems, "\u65E5\u5E38\u751F\u6D3B", "\u4E09\u9910", "\u9910", 3) === true
);
check("chore split done: \u5355\u4F4D\u4E0D\u5339\u914D\u4E0D\u7B97", splitTicksDone(choreAllRows ? parseDailyContent(dailyFile, choreAllMd, "2026-11-13").checkItems : [], "\u65E5\u5E38\u751F\u6D3B", "\u4E09\u9910", "\u6B21", 3) === false);
var choreRenamed = renameTickRowBase(choreRec1, "\u65E5\u5E38\u751F\u6D3B", "\u4E09\u9910", "\u6B63\u9910");
check("chore split \u6539\u540D: \u4E09\u6761\u6B21\u884C base \u5168\u6539", choreRenamed.split("\n").filter((l) => l.includes("\u6B63\u9910\u7B2C")).length === 3, choreRenamed);
check("chore split \u6539\u540D: \u5E8F\u53F7/\u5355\u4F4D/\u7F29\u8FDB\u4FDD\u7559", choreRenamed.includes("	- [ ] \u6B63\u9910\u7B2C3\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B"), choreRenamed);
check("chore split \u6539\u540D: \u5E42\u7B49\uFF08\u65E7\u540D\u4E0D\u518D\u51FA\u73B0\uFF09", !choreRenamed.includes("\u4E09\u9910\u7B2C"), choreRenamed);
var choreRenamedChecked = renameTickRowBase(
  choreRec1.replace(/\[ \] 三餐第/g, "[x] \u4E09\u9910\u7B2C"),
  "\u65E5\u5E38\u751F\u6D3B",
  "\u4E09\u9910",
  "\u6B63\u9910"
);
check("chore split \u6539\u540D: \u5DF2\u52FE\u6001\u4FDD\u7559", choreRenamedChecked.split("\n").filter((l) => l.includes("[x] \u6B63\u9910\u7B2C")).length === 3, choreRenamedChecked);
var otherPlanTicks = choreRec1.split("\n").map((l) => l.startsWith("	") ? l.replace("#\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B", "#\u8BA1\u5212/\u522B\u7684") : l).join("\n");
check("chore split \u6539\u540D: \u5F02\u8BA1\u5212\u6B21\u884C\u4E0D\u52A8", renameTickRowBase(otherPlanTicks, "\u65E5\u5E38\u751F\u6D3B", "\u4E09\u9910", "\u6B63\u9910").includes("\u4E09\u9910\u7B2C1\u9910"));
var choreTickIdx = choreTickLineIndices(choreRec1, "\u65E5\u5E38\u751F\u6D3B", "\u4E09\u9910");
check("chore split \u884C\u53F7: \u6536\u6EE1\u4E09\u6761\u6B21\u884C", choreTickIdx.length === 3, choreTickIdx);
check("chore split \u884C\u53F7: \u4E0D\u542B\u951A\u70B9\u884C", !choreTickIdx.includes(2), choreTickIdx);
check("chore split \u884C\u53F7: \u5F02\u540D\u4E0D\u6536", choreTickLineIndices(choreRec1, "\u65E5\u5E38\u751F\u6D3B", "\u6D17\u7897").length === 0);
void (async () => {
  var _a58, _b31, _c12, _d5, _e4, _f2, _g2, _h2, _i2, _j, _k, _l, _m;
  const day = (name, lines) => {
    const f = new TFile();
    f.path = `\u8BA1\u52122026/\u6BCF\u65E5/${name}.md`;
    contents.set(f.path, [CHECK_HEADING, ...lines].join("\n"));
    return f;
  };
  const contents = /* @__PURE__ */ new Map();
  const files = [
    day("2026-11-09", ["- [x] \u6D17\u7897 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-09 \u{1F4C5} 2026-11-09"]),
    day("2026-11-10", ["- [ ] \u6D17\u7897 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-10 \u{1F4C5} 2026-11-10"]),
    day("2026-11-11", ["- [x] \u6D17\u7897\u673A #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-11 \u{1F4C5} 2026-11-11", "- [ ] \u6D17\u7897 #\u8BA1\u5212/\u5BB6\u52A1 \u{1F6EB} 2026-11-11 \u{1F4C5} 2026-11-11"]),
    // ADR-0019: 锚点行未勾（镜像未回写）但三条次行全勾——文件事实仍算当日完成
    day("2026-11-12", [
      "- [ ] \u4E09\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12",
      "	- [x] \u4E09\u9910\u7B2C1\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12",
      "	- [x] \u4E09\u9910\u7B2C2\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12",
      "	- [x] \u4E09\u9910\u7B2C3\u9910 #\u8BA1\u5212/\u65E5\u5E38\u751F\u6D3B \u{1F6EB} 2026-11-12 \u{1F4C5} 2026-11-12"
    ])
  ];
  const app = {
    vault: {
      getAbstractFileByPath: (p) => {
        var _a59;
        return (_a59 = files.find((f) => f.path === p)) != null ? _a59 : null;
      },
      cachedRead: async (f) => {
        var _a59;
        return (_a59 = contents.get(f.path)) != null ? _a59 : "";
      }
    }
  };
  const prefix = "\u8BA1\u52122026/\u6BCF\u65E5/";
  check(
    "scanHit: \u547D\u4E2D\u5DF2\u52FE\u884C\uFF08\u6B63\u5411\uFF09",
    await scanChoreHit(app, prefix, "\u65E5\u5E38\u751F\u6D3B", "\u6D17\u7897", "2026-11-09", "2026-11-09"),
    void 0
  );
  check(
    "scanHit: \u672A\u52FE\u4E0D\u7B97\u547D\u4E2D",
    !await scanChoreHit(app, prefix, "\u65E5\u5E38\u751F\u6D3B", "\u6D17\u7897", "2026-11-10", "2026-11-10"),
    void 0
  );
  check(
    "scanHit: \u8FD1\u540D/\u5F02\u8BA1\u5212\u4E0D\u9876\u66FF\uFF08\u6D17\u7897\u673A/\u5BB6\u52A1\u884C\u4E0D\u7B97\uFF09",
    !await scanChoreHit(app, prefix, "\u65E5\u5E38\u751F\u6D3B", "\u6D17\u7897", "2026-11-11", "2026-11-11"),
    void 0
  );
  check(
    "scanHit: \u7A97\u53E3\u5185\u4EFB\u4E00\u5929\u547D\u4E2D\u5373\u771F\uFF0811-09 \u5DF2\u52FE\uFF09",
    await scanChoreHit(app, prefix, "\u65E5\u5E38\u751F\u6D3B", "\u6D17\u7897", "2026-11-09", "2026-11-10"),
    void 0
  );
  check(
    "scanHit: backward \u4ECE to \u7AEF\u56DE\u626B\u547D\u4E2D\uFF08\u8D8A\u8FC7 11-10 \u672A\u52FE\uFF0C\u547D\u4E2D 11-09\uFF09",
    await scanChoreHit(app, prefix, "\u65E5\u5E38\u751F\u6D3B", "\u6D17\u7897", "2026-11-09", "2026-11-10", true),
    void 0
  );
  check(
    "scanHit split: \u951A\u70B9\u672A\u52FE\u4F46\u6B21\u884C\u5168\u52FE \u2192 \u547D\u4E2D\uFF08floor/unit \u53E3\u5F84\uFF09",
    await scanChoreHit(app, prefix, "\u65E5\u5E38\u751F\u6D3B", "\u4E09\u9910", "2026-11-12", "2026-11-12", false, 3, "\u9910"),
    void 0
  );
  check(
    "scanHit split: \u4E0D\u7ED9\u5206\u6B21\u53E3\u5F84\u65F6\u53EA\u770B\u951A\u70B9\u884C\uFF08\u672A\u52FE = \u672A\u547D\u4E2D\uFF09",
    !await scanChoreHit(app, prefix, "\u65E5\u5E38\u751F\u6D3B", "\u4E09\u9910", "2026-11-12", "2026-11-12"),
    void 0
  );
  {
    const files2 = [];
    const contents2 = /* @__PURE__ */ new Map();
    const mk = (path, text) => {
      var _a59;
      const f = new TFile();
      f.path = path;
      f.name = (_a59 = path.split("/").pop()) != null ? _a59 : "";
      f.basename = f.name.replace(/\.[^.]+$/, "");
      files2.push(f);
      contents2.set(path, text);
      return f;
    };
    const boardApp = {
      vault: {
        getFiles: () => files2,
        getAbstractFileByPath: (p) => {
          var _a59;
          return (_a59 = files2.find((f) => f.path === p)) != null ? _a59 : null;
        },
        cachedRead: async (f) => {
          var _a59;
          return (_a59 = contents2.get(f.path)) != null ? _a59 : "";
        }
      }
    };
    const annual = `---
start: 2026-11-09
end: 2026-11-20
plans:
  - name: \u65E5\u5E38\u751F\u6D3B
    type: \u6253\u5361
    target: \u5BB6\u52A1
    goals:
      - name: \u4E09\u9910
        mode: chore
        floor: 3
        unit: \u9910
      - name: \u6D17\u7897
        mode: chore
        cycle:
          unit: week
          days: [1]
      - name: \u62C9\u4F38
        mode: chore
  - name: \u9605\u8BFB
    type: \u6253\u5361
    target: \u6BCF\u5929\u8BFB\u4E66
  - name: \u5199\u4F5C
    type: \u6570\u91CF
    target: 2 \u8282
    goals:
      - name: \u300A\u4E66\u300B
        count: 2
        unit: \u8282
        mode: reading
  - name: \u7A7A\u8BA1\u5212
    type: \u6570\u91CF
    target: 0
---
`;
    mk("root/\u8BA1\u52122026/\u5E74\u5EA6\u8BA1\u5212.md", annual);
    mk(
      "root/\u8BA1\u52122026/\u4EFB\u52A1.md",
      [
        "- [x] \u300A\u4E66\u300B\uFF08\u7B2C 1 \u7AE0\u7B2C 1 \u8282\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-11-10 \u{1F4C5} 2026-11-10",
        "- [ ] \u300A\u4E66\u300B\uFF08\u7B2C 1 \u7AE0\u7B2C 2 \u8282\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-11-11 \u{1F4C5} 2026-11-11"
      ].join("\n")
    );
    const row = (text, plan, checked, date, indent = false) => `${indent ? "	" : ""}- [${checked ? "x" : " "}] ${text} #\u8BA1\u5212/${plan} \u{1F6EB} ${date} \u{1F4C5} ${date}`;
    const day2 = (date, lines) => {
      mk(`root/\u8BA1\u52122026/\u6BCF\u65E5/${date}.md`, [CHECK_HEADING, ...lines].join("\n"));
    };
    day2("2026-11-09", [
      // ADR-0019: 三餐锚点未勾但三条次行全勾 → 当日命中
      row("\u4E09\u9910", "\u65E5\u5E38\u751F\u6D3B", false, "2026-11-09"),
      row("\u4E09\u9910\u7B2C1\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-09", true),
      row("\u4E09\u9910\u7B2C2\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-09", true),
      row("\u4E09\u9910\u7B2C3\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-09", true),
      row("\u62C9\u4F38", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-09"),
      row("\u6D17\u7897", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-09"),
      row("\u9605\u8BFB", "\u9605\u8BFB", true, "2026-11-09")
    ]);
    day2("2026-11-10", [
      // 只勾 2/3 次 → 三餐当日不算完成
      row("\u4E09\u9910", "\u65E5\u5E38\u751F\u6D3B", false, "2026-11-10"),
      row("\u4E09\u9910\u7B2C1\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-10", true),
      row("\u4E09\u9910\u7B2C2\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-10", true)
    ]);
    day2("2026-11-11", [
      row("\u4E09\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-11"),
      row("\u62C9\u4F38", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-11"),
      row("\u9605\u8BFB", "\u9605\u8BFB", true, "2026-11-11")
    ]);
    day2("2026-11-12", [
      row("\u4E09\u9910", "\u65E5\u5E38\u751F\u6D3B", false, "2026-11-12"),
      row("\u4E09\u9910\u7B2C1\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-12", true),
      row("\u4E09\u9910\u7B2C2\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-12", true),
      row("\u4E09\u9910\u7B2C3\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-12", true),
      row("\u62C9\u4F38", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-12")
    ]);
    day2("2026-11-15", [
      row("\u4E09\u9910", "\u65E5\u5E38\u751F\u6D3B", true, "2026-11-15"),
      row("\u62C9\u4F38", "\u65E5\u5E38\u751F\u6D3B", false, "2026-11-15"),
      row("\u9605\u8BFB", "\u9605\u8BFB", true, "2026-11-15")
    ]);
    const board = await computeBoardSections(boardApp, "root", "2026-11-15", true, null);
    const sec = (name) => board.sections.find((s) => s.plan === name);
    const item = (plan, name) => {
      var _a59;
      return (_a59 = sec(plan)) == null ? void 0 : _a59.items.find((i) => i.name === name);
    };
    check(
      "board: \u8BA1\u5212\u671F\u95F4\u53D6\u5E74\u5EA6 frontmatter \u5E76\u622A\u81F3\u4ECA\u5929",
      board.start === "2026-11-09" && board.scanEnd === "2026-11-15",
      { start: board.start, scanEnd: board.scanEnd }
    );
    check("board: \u65E0\u5B50\u9879\u4E14\u65E0\u4E8B\u5B9E\u7684\u8BA1\u5212\u533A\u88AB\u9690\u85CF", !sec("\u7A7A\u8BA1\u5212"));
    const san = item("\u65E5\u5E38\u751F\u6D3B", "\u4E09\u9910");
    check("board: \u4E09\u9910 \u547D\u4E2D 4/7 \u5929\uFF08\u6B21\u884C\u5168\u52FE\u7B97\u547D\u4E2D\u30012/3 \u4E0D\u7B97\uFF09", (san == null ? void 0 : san.done) === 4 && (san == null ? void 0 : san.total) === 7, {
      done: san == null ? void 0 : san.done,
      total: san == null ? void 0 : san.total
    });
    check(
      "board: \u4E09\u9910\u65E5\u683C 11-09 \u547D\u4E2D / 11-10 \u672A\u5B8C\u6210 / 11-13 \u672A\u5B8C\u6210",
      ((_b31 = (_a58 = san == null ? void 0 : san.days) == null ? void 0 : _a58.find((d) => d.date === "2026-11-09")) == null ? void 0 : _b31.state) === "hit" && ((_d5 = (_c12 = san == null ? void 0 : san.days) == null ? void 0 : _c12.find((d) => d.date === "2026-11-10")) == null ? void 0 : _d5.state) === "miss" && ((_f2 = (_e4 = san == null ? void 0 : san.days) == null ? void 0 : _e4.find((d) => d.date === "2026-11-13")) == null ? void 0 : _f2.state) === "miss"
    );
    const wan = item("\u65E5\u5E38\u751F\u6D3B", "\u6D17\u7897");
    check("board: \u6BCF\u5468\u4E00\u4E8B\u9879 \u547D\u4E2D 1/1 \u6B21\u3001\u91CF\u8BCD\u4E3A\u6B21", (wan == null ? void 0 : wan.done) === 1 && (wan == null ? void 0 : wan.total) === 1 && (wan == null ? void 0 : wan.unit) === "\u6B21", {
      done: wan == null ? void 0 : wan.done,
      total: wan == null ? void 0 : wan.total,
      unit: wan == null ? void 0 : wan.unit
    });
    check(
      "board: \u6BCF\u5468\u4E00\u4E8B\u9879\u975E\u8BE5\u505A\u65E5 = off\uFF087 \u683C\u91CC 6 \u4E2A off\uFF09",
      ((_g2 = wan == null ? void 0 : wan.days) == null ? void 0 : _g2.filter((d) => d.state === "off").length) === 6,
      wan == null ? void 0 : wan.days
    );
    check("board: \u751F\u6D3B\u8BA1\u5212\u805A\u5408\u7387\u6309\u5E94\u505A\u91CF\u52A0\u6743\uFF088/15 = 53%\uFF09", ((_h2 = sec("\u65E5\u5E38\u751F\u6D3B")) == null ? void 0 : _h2.percent) === 53, (_i2 = sec("\u65E5\u5E38\u751F\u6D3B")) == null ? void 0 : _i2.percent);
    const read = sec("\u9605\u8BFB");
    check(
      "board: \u6253\u5361\u578B\u8BA1\u5212\u6309\u5929\u7EDF\u8BA1 3/7",
      ((_j = read == null ? void 0 : read.items[0]) == null ? void 0 : _j.done) === 3 && ((_k = read == null ? void 0 : read.items[0]) == null ? void 0 : _k.total) === 7 && (read == null ? void 0 : read.percent) === 43,
      { item: read == null ? void 0 : read.items[0], percent: read == null ? void 0 : read.percent }
    );
    const book2 = item("\u5199\u4F5C", "\u300A\u4E66\u300B");
    check(
      "board: \u91CF\u5316\u76EE\u6807\u53EA\u6709\u4EFB\u52A1\u8FDB\u5EA6\u3001\u65E0\u65E5\u683C\u5E26",
      (book2 == null ? void 0 : book2.done) === 1 && (book2 == null ? void 0 : book2.total) === 2 && (book2 == null ? void 0 : book2.unit) === "\u8282" && (book2 == null ? void 0 : book2.days) === void 0,
      { done: book2 == null ? void 0 : book2.done, total: book2 == null ? void 0 : book2.total, unit: book2 == null ? void 0 : book2.unit, days: book2 == null ? void 0 : book2.days }
    );
    check("board: \u91CF\u5316\u8BA1\u5212\u533A\u767E\u5206\u6BD4\u6CBF\u7528\u8BA1\u5212\u8FDB\u5EA6", ((_l = sec("\u5199\u4F5C")) == null ? void 0 : _l.percent) === 50, (_m = sec("\u5199\u4F5C")) == null ? void 0 : _m.percent);
  }
  console.log(failed === 0 ? "\nALL PASSED" : `
${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
