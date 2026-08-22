import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PiManifest {
	pi?: { extensions?: string[] };
}

function readManifest(): PiManifest {
	const raw = readFileSync(resolve(repoRoot, "package.json"), "utf8");
	return JSON.parse(raw) as PiManifest;
}

describe("Pi manifest", () => {
	it("declares at least one extension entry point", () => {
		expect(readManifest().pi?.extensions ?? []).not.toHaveLength(0);
	});

	it("points every extension entry at a file that exists", () => {
		const entries = readManifest().pi?.extensions ?? [];
		for (const entry of entries) {
			expect(existsSync(resolve(repoRoot, entry)), entry).toBe(true);
		}
	});
});
