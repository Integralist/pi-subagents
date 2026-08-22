/**
 * Load the extension the way pi loads it.
 *
 * Vitest resolves imports its own way, so a green test suite does not prove pi
 * can load this at all: the `.ts` suffixes on every import and the `src/ui/`
 * directory both have to resolve under pi's bundled jiti loader. That loader is
 * not a dependency of this package — it comes with pi — so it is imported from
 * inside pi's own `node_modules`, which is also why this script has to live in
 * the repository rather than in a temporary directory.
 *
 * Run it with `make load-check`. It prints the extension's default export and
 * exits non-zero if the module cannot be loaded.
 */

import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const extension = await jiti.import("../src/index.ts", { default: true });

if (typeof extension !== "function") {
	console.error(
		`the extension's default export is ${typeof extension}, not a function`,
	);
	process.exit(1);
}

console.log("loaded: the extension resolves under pi's own loader");
