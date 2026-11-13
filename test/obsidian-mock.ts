/**
 * Minimal mock of the Obsidian module for offline parsing tests.
 * Only implements what src/daily.ts, src/tasks.ts, src/stats.ts import.
 */
export class App {}
export class TFile {
	/** 复现脚本构造 TFile 时需要 path/name/basename（真实 Obsidian 的 TFile 都有）。 */
	path: string;
	name: string;
	basename: string;
	constructor(path?: string) {
		this.path = path ?? "";
		this.name = this.path.split("/").pop() ?? "";
		this.basename = this.name.replace(/\.[^.]+$/, "");
	}
}
export class TFolder {}
export class Notice {}

/** Tiny YAML subset parser covering the frontmatter shapes PlanBoard reads. */
export function parseYaml(src: string): any {
	const lines = src.split("\n");
	let pos = 0;

	const indentOf = (l: string): number => l.search(/\S/);
	// 整体被引号包裹的标量去引号（js-yaml 行为；仅处理完整包裹，不动 "key: value" 内部的值）
	const stripComment = (s: string): string => {
		const t = s.trim();
		if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
			return t.slice(1, -1);
		}
		return s;
	};

	function parseNode(indent: number): any {
		while (pos < lines.length) {
			const line = lines[pos];
			if (!line.trim() || line.trim().startsWith("#")) {
				pos++;
				continue;
			}
			break;
		}
		if (pos >= lines.length) return null;
		const first = lines[pos];
		if (indentOf(first) < indent) return null;

		if (first.trim().startsWith("- ")) {
			const arr: any[] = [];
			while (pos < lines.length) {
				const line = lines[pos];
				if (indentOf(line) < indent) break;
				if (!line.trim() || line.trim().startsWith("#")) {
					pos++;
					continue;
				}
				if (!line.trim().startsWith("- ")) break;
				const content = stripComment(line.trim().slice(2).trim());
				const lineIndent = indentOf(line);
				if (content === "" || content.endsWith(":")) {
					pos++;
					arr.push(parseNode(lineIndent + 2));
				} else {
					const idx = content.indexOf(":");
					if (idx !== -1) {
						const obj: Record<string, unknown> = {};
						const key = content.slice(0, idx).trim();
						const val = content.slice(idx + 1).trim();
						obj[key] = val === "" ? parseNode(lineIndent + 2) : val;
						pos++;
						while (pos < lines.length) {
							const nl = lines[pos];
							if (indentOf(nl) <= lineIndent) break;
							const nidx = nl.trim().indexOf(":");
							if (nidx === -1) {
								pos++;
								continue;
							}
							const nkey = nl.trim().slice(0, nidx).trim();
							const nval = stripComment(nl.trim().slice(nidx + 1).trim());
							if (nval === "") {
								// 先 pos++ 再递归：parseNode 期望 pos 指向第一条子行
								// （与上方 object 分支一致；此前先递归后 pos++ 导致
								//   数组项内嵌套对象解析为 null 并把子键拍平——quota 用例复现）
								pos++;
								obj[nkey] = parseNode(indentOf(nl) + 2);
							} else {
								obj[nkey] = nval;
								pos++;
							}
						}
						arr.push(obj);
					} else {
						arr.push(content);
						pos++;
					}
				}
			}
			return arr;
		}

		const obj: Record<string, unknown> = {};
		while (pos < lines.length) {
			const line = lines[pos];
			if (indentOf(line) < indent) break;
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

export function stringifyYaml(value: any): string {
	return JSON.stringify(value, null, 2);
}

/** src/diary-sync.ts 的 moment().format() 用到的两个格式；离线测试不触达写入口，够用即可。 */
export function moment(): { format: (fmt: string) => string } {
	const d = new Date();
	const p = (n: number): string => String(n).padStart(2, "0");
	return {
		format: (fmt: string) =>
			fmt === "YYYY-MM-DD" ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` : `${p(d.getHours())}:${p(d.getMinutes())}`,
	};
}
