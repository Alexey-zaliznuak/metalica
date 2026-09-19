import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

export interface ProductionArticle {
  article: string | null;
  name: string | null;
  quantity: number | null;
  size: string | null;
  comment: string | null;
}

export type ProductionTextSize = '30x40' | '40x60' | '60x80';

export function productionTextScale(size?: string | null): number {
  if (size === '40x60') return 1 / 1.5;
  if (size === '60x80' || size === 'small') return 1 / 2;
  return 1;
}

const MAX_PIXELS = 268402689;

const EXCLUDED_PRODUCTION_ARTICLES = ['работа художника в стиле нейроарт'];
const EXCLUDED_PRODUCTION_ARTICLE_PREFIXES = ['картина на металле'];

function plainText(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeMarkup(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function productionArticleLabel(value: string | null): string {
  return plainText(value ?? '').toLocaleLowerCase('ru-RU');
}

/** Service SKUs stay on the order, but must not be printed on production photos. */
export function isShownOnProductionImage(item: ProductionArticle): boolean {
  const labels = [item.article, item.name].map(productionArticleLabel).filter(Boolean);
  return labels.every((label) => {
    if (EXCLUDED_PRODUCTION_ARTICLES.includes(label)) return false;
    return !EXCLUDED_PRODUCTION_ARTICLE_PREFIXES.some((prefix) => label.startsWith(prefix));
  });
}

export function productionArticleText(item: ProductionArticle): string {
  const title = [item.article, item.name !== item.article ? item.name : null]
    .filter(Boolean).join(' — ');
  return plainText([
    title,
    item.size,
    item.quantity != null ? `×${item.quantity.toLocaleString('ru-RU')}` : null,
    item.comment,
  ].filter(Boolean).join(' · '));
}

/** Mirrors each text block in place: the number stays left, the articles right. */
export async function productionHeader(
  width: number,
  orderNumber: string,
  articles: ProductionArticle[],
  comment?: string | null,
  textScale = 1,
  deliveryService?: string | null,
) {
  const padding = Math.max(1, Math.round(width * 0.02));
  const numberWidth = Math.max(1, Math.round(width * 0.30));
  const numberLeft = Math.round(width * 0.065);
  const articlesLeft = Math.round(width * 0.44);
  const articlesWidth = width - articlesLeft - padding;
  let numberFont = Math.max(1, Math.round(width * 0.045));
  const numberText = escapeMarkup(plainText(orderNumber));
  let number = await sharp({ text: { text: numberText, font: `sans ${numberFont}`, rgba: true, dpi: 72 } })
    .flop().png().toBuffer({ resolveWithObject: true });
  if (number.info.width > numberWidth) {
    numberFont = Math.max(1, Math.floor(numberFont * numberWidth / number.info.width));
    number = await sharp({ text: { text: numberText, font: `sans ${numberFont}`, rgba: true, dpi: 72 } })
      .flop().resize({ width: numberWidth, withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  }
  const scale = Number.isFinite(textScale) && textScale > 0 ? textScale : 1;
  const commentText = escapeMarkup(plainText(comment ?? ''));
  const commentBlock = commentText ? await sharp({ text: {
    text: commentText,
    font: `sans ${Math.max(1, Math.round(width * 0.018 * scale))}`,
    width: numberWidth,
    wrap: 'word-char',
    rgba: true,
    dpi: 72,
  } }).flop().png().toBuffer({ resolveWithObject: true }) : null;
  const commentGap = commentBlock ? Math.max(1, Math.round(width * 0.008 * scale)) : 0;
  const articleText = articles.filter(isShownOnProductionImage)
    .map(productionArticleText).filter(Boolean).map(escapeMarkup).join('\n');
  const bodyFont = Math.max(1, Math.round(width * 0.0144 * scale));
  const list = articleText ? await sharp({ text: {
    text: articleText,
    font: `sans ${bodyFont}`,
    width: articlesWidth,
    wrap: 'word-char',
    spacing: Math.max(1, Math.round(width * 0.007 * scale)),
    rgba: true,
    dpi: 72,
  } }).flop().png().toBuffer({ resolveWithObject: true }) : null;
  const deliveryText = escapeMarkup(plainText(deliveryService ?? ''));
  const deliverySource = deliveryText ? await sharp({ text: {
    text: deliveryText,
    font: `sans ${bodyFont}`,
    rgba: true,
    dpi: 72,
  } }).flop().png().toBuffer({ resolveWithObject: true }) : null;
  const delivery = deliverySource
    ? await sharp(deliverySource.data).rotate(90).png().toBuffer({ resolveWithObject: true })
    : null;
  const arrowHeight = Math.max(2, Math.round(width * 0.035));
  const leftStack = number.info.height + commentGap + (commentBlock?.info.height ?? 0);
  const height = Math.max(leftStack, list?.info.height ?? 0, arrowHeight, delivery?.info.height ?? 0) + 2 * padding;
  const bottom = height - Math.max(1, Math.round(width * 0.006));
  const stroke = Math.max(1, width * 0.002);
  const head = width * 0.006;
  const arrows = [width * 0.035, width * 0.395].map((x) =>
    `<path d="M ${x} ${bottom - arrowHeight} V ${bottom} M ${x - head} ${bottom - head} L ${x} ${bottom} L ${x + head} ${bottom - head}"/>`,
  ).join('');
  const numberTop = height - padding - number.info.height;
  const overlays: sharp.OverlayOptions[] = [
    { input: number.data, left: numberLeft + Math.floor((numberWidth - number.info.width) / 2), top: numberTop },
    { input: Buffer.from(`<svg width="${width}" height="${height}"><g fill="none" stroke="black" stroke-width="${stroke}">${arrows}</g></svg>`), left: 0, top: 0 },
  ];
  if (commentBlock) {
    overlays.push({
      input: commentBlock.data,
      left: numberLeft + Math.floor((numberWidth - commentBlock.info.width) / 2),
      top: numberTop - commentGap - commentBlock.info.height,
    });
  }
  if (delivery) {
    overlays.push({
      input: delivery.data,
      left: Math.round(width * 0.395 - head - delivery.info.width),
      top: height - padding - delivery.info.height,
    });
  }
  if (list) overlays.push({ input: list.data, left: width - padding - list.info.width, top: height - padding - list.info.height });
  const buffer = await sharp({ create: { width, height, channels: 3, background: 'white' } })
    .composite(overlays).png().toBuffer();
  return { buffer, height };
}

/** Lossless PNG with the original photo dimensions and an added header above it. */
export async function productionImage(
  input: string | Buffer,
  orderNumber: string,
  articles: ProductionArticle[],
  comment?: string | null,
  textScale = 1,
  deliveryService?: string | null,
) {
  const photo = sharp(input, { limitInputPixels: MAX_PIXELS });
  const metadata = await photo.metadata();
  if (!['jpeg', 'png', 'webp', 'tiff', 'gif', 'heif'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) {
    throw new BadRequestException('Для производства нужно одно растровое изображение (JPG, PNG, WebP, TIFF или AVIF)');
  }
  const rotated = (metadata.orientation ?? 1) >= 5;
  const width = (rotated ? metadata.height : metadata.width) ?? 0;
  const height = (rotated ? metadata.width : metadata.height) ?? 0;
  if (width < 32 || height < 1) throw new BadRequestException('Изображение слишком маленькое');
  const header = await productionHeader(width, orderNumber, articles, comment, textScale, deliveryService);
  if (width * (height + header.height) > MAX_PIXELS) {
    throw new BadRequestException('Изображение с полем для производства превышает допустимый размер');
  }
  return photo.rotate()
    .extend({ top: header.height, bottom: 0, left: 0, right: 0, background: 'white' })
    .composite([{ input: header.buffer, left: 0, top: 0 }])
    .withMetadata({ orientation: 1, ...(metadata.density ? { density: metadata.density } : {}) })
    .png();
}
