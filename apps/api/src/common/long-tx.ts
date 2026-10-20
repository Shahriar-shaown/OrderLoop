/** Transaction options for work that legitimately outlasts Prisma's 5 second default (imports, exports, bulk rechecks). */
export const LONG_TX = { timeout: 60_000 } as const;
