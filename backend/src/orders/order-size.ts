import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const SIZE_ARTICLES: Record<string, string> = {
  '30x40': 'Картина на металле 30*40см',
  '40x60': 'Картина на металле 40*60см',
  '60x80': 'Картина на металле 60*80см',
};

/** Match any selected SKU, with the predicate applied before count and pagination. */
export function orderSizeFilter(sizes?: string[]): Prisma.OrderWhereInput | undefined {
  if (!sizes?.length) return undefined;
  if (sizes.some((size) => !Object.prototype.hasOwnProperty.call(SIZE_ARTICLES, size))) {
    throw new BadRequestException('Неизвестный размер картины');
  }
  return { bluesalesInfo: { is: { OR: [...new Set(sizes)].map((size) => ({
    rawPayload: {
      path: ['goodsPositions'],
      array_contains: [{ goods: { marking: SIZE_ARTICLES[size] } }],
    },
  })) } } };
}
