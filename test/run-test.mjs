import esbuild from "esbuild";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

await esbuild.build({
	entryPoints: [path.join(__dirname, "parse-test.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "es2018",
	outfile: path.join(__dirname, "parse-test.cjs"),
	alias: { obsidian: path.join(__dirname, "obsidian-mock.ts") },
	logLevel: "error",
});

const mod = await import(pathToFileURL(path.join(__dirname, "parse-test.cjs")).href);
// 测试文件自带 process.exit 与 ALL PASSED 汇总；bundle 的 CJS default 是 {} 不是数字，
// 直接 process.exit(mod.default) 会抛 ERR_INVALID_ARG_TYPE（Node 22）。只在确为数字时透传。
if (typeof mod.default === "number") process.exit(mod.default);
