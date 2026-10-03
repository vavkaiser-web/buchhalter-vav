# Касса VAV — дизайн и UX

## Источник дизайна
Файл: `/Users/akais/Documents/agents/design/buchhalter-vav/approved-design.html`
Копия: `/Users/akais/.codex/visualizations/2026/09/24/01a0d48b-9fb3-7531-8d53-503929cf1ec9/kasse-preview.html`
CSS MD5: `75cf11c8e42de979bd6ec8c56e660846` — использован дословно.

## Цветовая палитра
| CSS переменная   | Значение   | Применение                |
|-----------------|------------|---------------------------|
| `--bg`          | `#EBE7DF`  | Фон страницы              |
| `--sidebar`     | `#F5F2EC`  | Фон боковой панели        |
| `--header`      | `#14455E`  | Хедер                     |
| `--text`        | `#1A2B35`  | Основной текст            |
| `--muted`       | `#8A9BA8`  | Второстепенный текст      |
| `--accent`      | `#14455E`  | Акцент (кнопки, активный) |
| `--danger`      | `#C0392B`  | Ошибки, отклонение        |
| `--success`     | `#27AE60`  | Успех, выдача             |

## Типографика
- Основной шрифт: Inter (Google Fonts)
- Размер базовый: 14px
- Моноширинный: для сумм и кодов

## Структура layout
### Desktop (≥768px)
```
[Header: logo | компания | время | пользователь]
[Sidebar: nav items]  |  [Main content area]
[Footer: app · роль  |  версия/окружение]
```

### Mobile (<768px)
```
[Header: logo | компания | время | аватар]
[Horizontal nav tabs]
[Main content area]
[Footer]
```

## Иконки
Lucide Icons v1.17.0 (`/vendor/lucide-1.17.0.min.js` → aliased как `lucide.min.js`)

## Навигационные разделы
| Раздел       | Иконка       | Роли                                    |
|-------------|--------------|----------------------------------------|
| Рабочий стол | LayoutGrid   | все                                    |
| Очередь      | Inbox        | gf, buchhaltung, disponent             |
| Касса        | Wallet       | gf, buchhaltung                        |
| Запросы      | MessageSquare| все                                    |

## PWA
- `start_url`: `/kasse/`
- `scope`: `/kasse/`
- `display`: `standalone`
- Иконки: 192×192, 512×512, maskable
- Кэш: stale-while-revalidate для `/kasse/*`, bypass для `/api/*`
