# Металлика — заказы и правки

Веб-платформа для студии портретов на металле. Заменяет хаос из двух чатов ВК
(«заявки» и «правки») структурированными тредами по заказам — как мессенджер,
где переписываются менеджеры и художники эскизов и правок. Вся переписка хранится, поэтому метрики
(сколько правок в заказе и сколько времени они занимали) считаются автоматически.

## Стек

- **Бэкенд:** NestJS + Prisma + PostgreSQL
- **Фронтенд:** Vite + React + TypeScript + MUI (Material UI)
- **Хранилище файлов:** MinIO (S3-совместимое)
- **Инфраструктура:** docker-compose + nginx (внутренний reverse-proxy)

## Архитектура

```
браузер → HTTPS → [внешний nginx] → [docker nginx :3000] ┬→ /          → frontend
                                                         ├→ /api       → backend → PostgreSQL
                                                         ├→ /socket.io → backend
                                                         └→ /files     → MinIO
```

Файлы читаются без presigned-подписи по постоянным URL вида
`https://metallity-crm.ru/files/<s3-key>`. Бакет разрешает анонимный
`s3:GetObject`, но загрузка и удаление по-прежнему выполняются только backend с
учётными данными MinIO.

## Модель данных и метрики

Вся переписка — это `Message` в треде заказа. У сообщения есть тип `kind`:

- `NORMAL` — обычное сообщение
- `REVISION_REQUEST` — запрос на правку (старт таймера)
- `REVISION_ANSWER` — исправленный вариант (стоп таймера)

Ответ автоматически привязывается к последнему открытому запросу правки
(`answerToId`, self-relation). Отсюда метрики:

- **правок на заказ** = число `REVISION_REQUEST`
- **время правки** = `answer.createdAt − request.createdAt`
- **открытые/зависшие правки** = запросы без ответа (дольше N часов)

## Запуск

1. Скопируйте переменные окружения и при желании поправьте:

   ```bash
   cp .env.example .env
   ```

   Для продакшена обязательно смените `JWT_SECRET`, пароли и задайте:

   ```env
   APP_DOMAIN=metallity-crm.ru
   APP_PROTOCOL=https
   APP_PORT=3000
   ```

   `APP_DOMAIN` указывается без протокола. Backend использует его во всех
   публичных ссылках на файлы. Для локального HTTP-запуска задайте
   `APP_DOMAIN=localhost:8080` и `APP_PROTOCOL=http`.

2. Поднимите всё:

   ```bash
   docker compose up -d --build
   ```

   При старте бэкенд сам накатит схему БД (`prisma db push`) и заполнит
   демо-пользователей и демо-заказ.

3. Откройте приложение: <http://localhost:3000>
   - Консоль MinIO: <http://localhost:9001>

## Внешний HTTPS nginx

TLS завершается только во внешнем nginx. Он должен проксировать весь домен на
docker nginx и передавать WebSocket и исходный протокол.
Порты приложения и MinIO в `docker-compose.yml` привязаны к `127.0.0.1`, поэтому
обойти HTTPS прямым запросом к серверу снаружи нельзя.

Пример внешнего конфига:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name metallity-crm.ru;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name metallity-crm.ru;

    ssl_certificate /etc/letsencrypt/live/metallity-crm.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/metallity-crm.ru/privkey.pem;

    client_max_body_size 1100m;
    client_body_timeout 3600s;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

Не добавляйте HTTPS-редирект во внутренний docker nginx: upstream-соединение
между двумя nginx остаётся HTTP. После изменения конфигурации проверьте её через
`nginx -t` и перезагрузите внешний nginx.

## Демо-доступы (создаются автоматически)

| Логин      | Пароль        | Роль      |
| ---------- | ------------- | --------- |
| `admin`    | `admin123`    | Админ     |
| `manager`  | `manager123`  | Менеджер  |
| `designer` | `designer123` | Художник эскиза |

## Локальная разработка (без Docker)

Бэкенд:

```bash
cd backend
npm install
npx prisma generate
# поднимите Postgres и MinIO (можно через docker compose up postgres minio)
npx prisma db push
npm run seed
npm run start:dev
```

Фронтенд:

```bash
cd frontend
npm install
npm run dev   # dev-сервер проксирует /api на http://localhost:3000
```

## Дальнейшие шаги

- Заменить `prisma db push` на полноценные миграции (`prisma migrate`).
- Интеграция с CRM **Bluesales**: автоподтягивание списка заказов (когда будет
  доступ к API), чтобы не вводить номер заказа руками.
- Realtime-обновление тредов (WebSocket) вместо опроса.
