// Verified against the production status catalog on 2026-11-04.
export const LIFECYCLE_STATUSES = {
  ready: 174711, sent: 174712, awaitingReceipt: 174764,
  delivering: 178802, delivered: 145342, cancelled: 145343,
} as const;
export const CLEANUP_TAG = 'ATTACHMENT_CLEANUP';
export const COMPLETE_TAG = 'AUTO_COMPLETE';
export const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

export function lifecycleEligible(statusId: number | null, payload: unknown, now = new Date(), completion = false): boolean {
  if (!Object.values(LIFECYCLE_STATUSES).includes(statusId as any)) return false;
  if (completion && (statusId === LIFECYCLE_STATUSES.cancelled || statusId === LIFECYCLE_STATUSES.awaitingReceipt)) return false;
  const fields = (payload as any)?.customFields;
  if (!Array.isArray(fields)) return false;
  // Compare calendar dates in the business timezone; clamp month subtraction at month end.
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(now);
  const [year, month, day] = today.split('-').map(Number);
  const boundary = new Date(Date.UTC(year, month - 3, 1));
  const lastDay = new Date(Date.UTC(boundary.getUTCFullYear(), boundary.getUTCMonth() + 1, 0)).getUTCDate();
  boundary.setUTCDate(Math.min(day, lastDay));
  const cutoff = boundary.toISOString().slice(0, 10);
  return fields.some((field: any) => {
    const name = String(field?.fieldName ?? '').toLowerCase();
    if (!name.includes('дедлайн') || !name.includes('отправ')) return false;
    const value = String(field?.value ?? '').trim();
    const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
    const date = dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date && date < cutoff;
  });
}
