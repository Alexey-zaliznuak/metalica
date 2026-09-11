import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

export interface ProductionArticle {
  article: string | null;
  name: string | null;
  quantity: number | null;
  size: string | null;
  comment: string | null;
}

const MAX_PIXELS = 268402689;

function plainText(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeMarkup(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function productionArticleText(item: ProductionArticle): string {
  const title = [item.article, item.name !== item.article ? item.name : null]
    .filter(Boolean).join(' — ');
  return plainText([
    title,
    item.quantity != null ? `×${item.quantity.toLocaleString('ru-RU')}` : null,
    item.comment,
  ].filter(Boolean).join(' · '));
}

/** Mirrors each text block in place: the number stays left, the articles right. */
export async function productionHeader(width: number, orderNumber: string, articles: ProductionArticle[]) {
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
  const articleText = articles.map(productionArticleText).filter(Boolean).map(escapeMarkup).join('\n');
  const list = articleText ? await sharp({ text: {
    text: articleText,
    font: `sans ${Math.max(1, Math.round(width * 0.0144))}`,
    width: articlesWidth,
    wrap: 'word-char',
    spacing: Math.max(1, Math.round(width * 0.007)),
    rgba: true,
    dpi: 72,
  } }).flop().png().toBuffer({ resolveWithObject: true }) : null;
  const arrowHeight = Math.max(2, Math.round(width * 0.035));
  const height = Math.max(number.info.height, list?.info.height ?? 0, arrowHeight) + 2 * padding;
  const bottom = height - Math.max(1, Math.round(width * 0.006));
  const stroke = Math.max(1, width * 0.002);
  const head = width * 0.006;
  const arrows = [width * 0.035, width * 0.395].map((x) =>
    `<path d="M ${x} ${bottom - arrowHeight} V ${bottom} M ${x - head} ${bottom - head} L ${x} ${bottom} L ${x + head} ${bottom - head}"/>`,
  ).join('');
  const overlays: sharp.OverlayOptions[] = [
    { input: number.data, left: numberLeft + Math.floor((numberWidth - number.info.width) / 2), top: height - padding - number.info.height },
    { input: Buffer.from(`<svg width="${width}" height="${height}"><g fill="none" stroke="black" stroke-width="${stroke}">${arrows}</g></svg>`), left: 0, top: 0 },
  ];
  if (list) overlays.push({ input: list.data, left: articlesLeft, top: height - padding - list.info.height });
  const buffer = await sharp({ create: { width, height, channels: 3, background: 'white' } })
    .composite(overlays).png().toBuffer();
  return { buffer, height };
}

/** Lossless PNG with the original photo dimensions and an added header above it. */
export async function productionImage(input: string | Buffer, orderNumber: string, articles: ProductionArticle[]) {
  const photo = sharp(input, { limitInputPixels: MAX_PIXELS });
  const metadata = await photo.metadata();
  if (!['jpeg', 'png', 'webp', 'tiff', 'gif', 'heif'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) {
    throw new BadRequestException('Для производства нужно одно растровое изображение (JPG, PNG, WebP, TIFF или AVIF)');
  }
  const rotated = (metadata.orientation ?? 1) >= 5;
  const width = (rotated ? metadata.height : metadata.width) ?? 0;
  const height = (rotated ? metadata.width : metadata.height) ?? 0;
  if (width < 32 || height < 1) throw new BadRequestException('Изображение слишком маленькое');
  const header = await productionHeader(width, orderNumber, articles);
  if (width * (height + header.height) > MAX_PIXELS) {
    throw new BadRequestException('Изображение с полем для производства превышает допустимый размер');
  }
  return photo.rotate()
    .extend({ top: header.height, bottom: 0, left: 0, right: 0, background: 'white' })
    .composite([{ input: header.buffer, left: 0, top: 0 }])
    .withMetadata({ orientation: 1, ...(metadata.density ? { density: metadata.density } : {}) })
    .png();
}
