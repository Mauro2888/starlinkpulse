/**
 * Marks a string as a translation key without translating it yet (for constant
 * label maps evaluated at module load). Translate at render time with `t(key)`.
 * The extractor (scripts/i18n-extract.mjs) collects `tk("…")` and `t("…")`.
 */
export const tk = <S extends string>(s: S): S => s;
