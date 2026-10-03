# Касса VAV — релиз

## Текущая версия: 0.1.0-dev (feature/kasse-vav)

## Checklist перед продакшн-релизом (НЕ выполнять без разрешения Андрея)

### Сервер
- [ ] Получить разрешение Андрея на изменение продакшн-сервера
- [ ] Создать `/opt/kasse-vav` на Hetzner 178.105.169.97
- [ ] Скопировать: `app/`, `public/`, `package.json`
- [ ] Создать `.env` с `KASSE_PORT`, `KASSE_DATA`, `KASSE_INTEGRATION_TOKEN`, `DATABASE_URL`
- [ ] Применить миграцию 002 к продакшн БД

### nginx
```nginx
server {
    listen 443 ssl;
    server_name kasse-178-105-169-97.sslip.io;
    # SSL сертификат от certbot
    location / {
        proxy_pass http://127.0.0.1:3127;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
    }
}
```

### pm2
```bash
pm2 start /opt/kasse-vav/app/kasse-server.js \
  --name kasse-vav \
  --env production \
  --restart-delay 3000
pm2 save
```

### Checklist безопасности
- [ ] `KASSE_INTEGRATION_TOKEN` — только в .env файле, не в коде
- [ ] `benutzer.json` — только prod пользователи (не demo)
- [ ] Демо-логины проверены: НЕ работают в продакшне
- [ ] PATH: `/opt/kasse-vav/.env` имеет права 600

### После деплоя
- [ ] Проверить `https://kasse-178-105-169-97.sslip.io/kasse/`
- [ ] Проверить SW регистрацию (работает только по HTTPS)
- [ ] Проверить PWA установку на iPhone/Android
- [ ] Уведомить Андрея о готовности
- [ ] Добавить реальных пользователей (только по разрешению Андрея)
