/**
 * Year data directory naming (ADR-0002).
 *
 * The year folder under the plan root is `计划{year}` (e.g. `计划2026`),
 * NOT a bare `{year}`. A bare year name collides with vault-wide
 * `.stignore` patterns (Syncthing ignores any path segment named like a
 * year), which silently excluded all plan data from mobile sync.
 * The `计划` prefix never matches a bare-year ignore pattern.
 *
 * All year-scoped path construction MUST go through this helper.
 * Callers that receive an ALREADY-prefixed directory name and forward it to
 * functions that apply the prefix themselves (listTasks / readPlanPeriod /
 * readAnnualDefs / poolPath …) MUST strip the prefix first — double
 * prefixing (`计划计划2026`) silently reads a non-existent folder and was
 * the root cause of the year-view all-zero progress bug.
 */
export const YEAR_DIR_PREFIX = "计划";

export function yearDirName(year: string): string {
	return `${YEAR_DIR_PREFIX}${year}`;
}

/** Strip the `计划` prefix from an already-prefixed year dir name (idempotent-safe). */
export function bareYear(yearDir: string): string {
	return yearDir.startsWith(YEAR_DIR_PREFIX) ? yearDir.slice(YEAR_DIR_PREFIX.length) : yearDir;
}
