import { Prisma } from '@prisma/client';

// Тот же приоритет названий и кодов, что у resolveDeliveryType в карточке.
// Алиас info принадлежит BluesalesOrderInfo в запросах фильтра и его опций.
export const deliveryTypeSql = Prisma.sql`
  COALESCE(
    NULLIF(BTRIM(info."rawPayload"->'delivery'->>'deliveryTypeName'), ''),
    NULLIF(BTRIM(info."rawPayload"->'delivery'->>'typeName'), ''),
    CASE COALESCE(
      NULLIF(BTRIM(info."rawPayload"->'delivery'->>'deliveryType'), ''),
      NULLIF(BTRIM(info."rawPayload"->'delivery'->>'type'), '')
    )
      WHEN '0' THEN 'Курьер'
      WHEN '1' THEN 'Самовывоз'
      WHEN '2' THEN 'Почта'
      WHEN '3' THEN 'Другой'
      ELSE NULL
    END
  )
`;
