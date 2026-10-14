/** Offline checks against an explicitly supplied, already installed host. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sdkRoot = resolve(process.env.PI_SDK_ROOT ?? root);
function resolvePackage(name) {
	const dir = join(sdkRoot, "node_modules", name);
	const metadata = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const entry =
		metadata.exports?.["."]?.import ?? metadata.module ?? metadata.main;
	if (typeof entry !== "string")
		throw new Error(`No public import entry for ${name}`);
	return resolve(dir, entry);
}
const packages = ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(
	(name) => `@earendil-works/${name}`,
);
const aliases = Object.fromEntries(
	[...packages, "typebox"].map((name) => [name, resolvePackage(name)]),
);
const paths = Object.fromEntries(
	Object.entries(aliases).map(([name, entry]) => [
		name,
		[entry.replace(/\.js$/, ".d.ts").replace(/\.mjs$/, ".d.mts")],
	]),
);
const version = JSON.parse(
	readFileSync(join(dirname(aliases[packages[0]]), "../package.json"), "utf8"),
).version;
const scratch = mkdtempSync(join(tmpdir(), "pi-subagents-host-"));
const env = {
	...process.env,
	PI_SDK_ROOT: sdkRoot,
	PI_CODING_AGENT_DIR: scratch,
	JITI_FS_CACHE: "false",
	JITI_MODULE_CACHE: "false",
};
function run(name, args) {
	console.log(`host ${version}: ${name} ${args.join(" ")}`);
	const result = spawnSync(name, args, { cwd: root, env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${name} exited ${result.status}`);
}
try {
	const config = join(scratch, "vitest.config.mjs");
	writeFileSync(
		config,
		`export default ${JSON.stringify({
			root,
			resolve: { alias: aliases },
			test: {
				environment: "node",
				include: ["test/**/*.test.ts", "test/native-compatibility.test.mjs"],
			},
		})};\n`,
	);
	const tsconfig = join(scratch, "tsconfig.json");
	writeFileSync(
		tsconfig,
		JSON.stringify({
			extends: join(root, "tsconfig.json"),
			compilerOptions: {
				paths,
				typeRoots: [join(root, "node_modules/@types")],
			},
		}),
	);
	run(join(root, "node_modules/.bin/tsc"), ["--noEmit", "-p", tsconfig]);
	run(join(root, "node_modules/.bin/vitest"), [
		"--run",
		"--no-cache",
		"--configLoader",
		"runner",
		"--config",
		config,
		...process.argv.slice(2),
	]);
	run(join(root, "node_modules/.bin/biome"), ["check", "src", "test"]);
	run(process.execPath, [join(root, "scripts/load-check.mjs")]);
	console.log(`host ${version}: typecheck, tests, lint and public load passed`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
