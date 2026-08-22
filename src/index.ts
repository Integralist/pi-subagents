/**
 * pi-subagents — delegate work to focused subagents that run as nested
 * in-process sessions.
 *
 * Tool and event registration lands in Task 1.7; this entry point exists
 * so the `pi.extensions` manifest resolves and the extension loads.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
	// Registration intentionally empty until Task 1.7.
}
