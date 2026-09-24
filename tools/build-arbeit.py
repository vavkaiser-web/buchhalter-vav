#!/usr/bin/env python3
"""Собирает app/public/arbeit.html. CSS утверждённого макета вставляется
ДОСЛОВНО из design/buchhalter-vav/approved-design.html (эталон не меняется),
его SHA-256 записывается в страницу и проверяется тестом."""
import hashlib, pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
QUELLE = pathlib.Path('/Users/akais/Documents/agents/design/buchhalter-vav/approved-design.html')
src = QUELLE.read_text(encoding='utf-8')
css = re.search(r'<style>\n(.*?)\n</style>', src, re.S).group(1)
sha = hashlib.sha256(css.encode()).hexdigest()
HOST = """/* Базовые правила оболочки просмотра эталона (preview.html), которые влияют
   на отрисовку макета: заголовки, strong, hr, иконки 16 px. */
:root{color-scheme:light dark}
html,body{margin:0}
body{box-sizing:border-box;padding:16px;background:light-dark(rgb(255 255 255),rgb(24 24 24));color:light-dark(rgb(26 28 31),rgb(255 255 255));font-family:-apple-system,system-ui,"Segoe UI",sans-serif}
h1,h2,h3,h4,h5,h6,p{margin-block:0}
h1{font-size:24px;font-weight:500;line-height:1.25}
h2{font-size:20px;font-weight:500;line-height:1.25}
h3,h4,h5,h6{font-size:18px;font-weight:500;line-height:1.3}
b,strong,th{font-weight:500}
hr{width:100%;height:1px;margin-block:6px;border:0;background:light-dark(rgb(26 28 31 / 8%),rgb(255 255 255 / 8.2%))}
.cursor-interaction{cursor:pointer}
[data-lucide]{stroke-width:1.6}
svg{display:block;max-width:100%;height:auto}
svg.lucide{display:block;width:16px!important;height:16px!important;flex:none;margin:0!important;stroke-width:1.6}"""
ZUSATZ = """/* Дополнения к макету для реальных данных (описаны в docs/ABWEICHUNGEN.md). */
#vav-design .v-bild{display:block;max-width:100%;max-height:60vh;margin:12px auto;border-radius:8px;border:1px solid var(--v-line)}
#vav-design .v-sidebarfoot a{color:inherit}
#vav-design a{color:var(--v-accent)}
#vav-design .v-event span{min-width:0}"""
html = f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="same-origin">
<meta name="approved-css-sha256" content="{sha}">
<title>Бухгалтер VAV</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon-192.png">
<style>
{HOST}
</style>
</head>
<body>
<div id="vav-design" aria-label="Бухгалтер VAV">
<style>
{css}
</style>
<style>
{ZUSATZ}
</style>
<div id="vav-screen"><p style="padding:20px">Загрузка…</p></div><div id="vav-message" aria-live="polite"></div>
<input type="file" id="vav-datei" hidden>
</div>
<script src="/vendor/lucide-1.17.0.min.js"></script>
<script src="/arbeit.js"></script>
</body>
</html>
"""
(ROOT / 'app/public/arbeit.html').write_text(html, encoding='utf-8')
print('arbeit.html собран, CSS эталона sha256', sha)
