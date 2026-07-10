/**
 * Тип сообщения на уровне API-контракта.
 *
 * В БД колонки `kind` больше нет — фактический тип выводится из связей модели
 * Message (revision / revisionClosure). Этот enum используется:
 *  - на входе (CreateMessageDto) как инструкция «что создать»;
 *  - на выходе (serialize) как вычисленное поле для фронтенда.
 */
export enum MessageKind {
  NORMAL = 'NORMAL',
  REVISION_REQUEST = 'REVISION_REQUEST',
  REVISION_ANSWER = 'REVISION_ANSWER',
}
