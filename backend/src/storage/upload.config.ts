/**
 * Лимит на один загружаемый файл. Меняется через переменную MAX_UPLOAD_MB.
 *
 * Тот же лимит обязан стоять в nginx (`client_max_body_size`) — и во
 * внутреннем `nginx/nginx.conf`, и во внешнем nginx на хосте. Если там меньше,
 * запрос срежется с 413 ещё до бэкенда, и в логах контейнера ничего не будет.
 */
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 1024;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const power = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** power;
  return `${power === 0 ? value : value.toFixed(1)} ${units[power]}`;
}
