import { IsIn } from 'class-validator';

export const PHOTO_SIZES = ['30x40', '40x60', '60x80'] as const;

export class UpdateAttachmentPhotoSizeDto {
  @IsIn(PHOTO_SIZES)
  photoSize: (typeof PHOTO_SIZES)[number];
}
