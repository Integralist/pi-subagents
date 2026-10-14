/** Verify all six tools through the host's public loader, with no discovery. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkRoot = process.env.PI_SDK_ROOT
	? resolve(process.env.PI_SDK_ROOT)
	: fileURLToPath(new URL("..", import.meta.url));
const packageDir = join(
	sdkRoot,
	"node_modules/@earendil-works/pi-coding-agent",
);
const metadata = JSON.parse(
	readFileSync(join(packageDir, "package.json"), "utf8"),
);
const entry = metadata.exports?.["."]?.import ?? metadata.main;
const { discoverAndLoadExtensions } = await import(
	pathToFileURL(resolve(packageDir, entry)).href
);
const scratch = mkdtempSync(join(tmpdir(), "pi-subagents-load-"));
try {
	const result = await discoverAndLoadExtensions(
		[fileURLToPath(new URL("../src/index.ts", import.meta.url))],
		scratch,
		scratch,
	);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	assert.deepEqual([...result.extensions[0].tools.keys()].sort(), [
		"get_subagent_result",
		"list_subagents",
		"spawn_inline_subagent",
		"spawn_named_subagent",
		"steer_subagent",
		"stop_subagent",
	]);
	console.log("loaded: six subagent tools through the public host loader");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
