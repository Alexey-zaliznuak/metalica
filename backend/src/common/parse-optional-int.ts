/**
 * Safely parse an optional integer coming from a query string.
 *
 * Query params are typed as `string` on purpose: the global `ValidationPipe`
 * with `transform: true` coerces a missing `number`-typed param to `NaN`
 * (`+undefined`), which `ParseIntPipe` then rejects with a 400. Keeping the
 * raw string and parsing here avoids that pitfall.
 */
export function parseOptionalInt(value?: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
