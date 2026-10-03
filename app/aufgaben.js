/* ---------------------------------------------------------------
   Задачи (этап 2, ядро) — назначение → в работе → сдача → приёмка,
   с возвратом на доработку и эскалацией. Хранилище — JSON рядом с
   остальными данными пилота (BUCH_DATA). Боевую базу не трогает.
   ---------------------------------------------------------------- */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA = process.env.BUCH_DATA || path.join(__dirname, 'data');
const DATEI = path.join(DATA, 'aufgaben.json');

const STATUS = ['neu', 'in_arbeit', 'eingereicht', 'angenommen', 'eskaliert'];
const STATUS_TEXT = {
  neu: 'назначена', in_arbeit: 'в работе', eingereicht: 'сдана — ждёт приёмки',
  angenommen: 'принята', eskaliert: 'эскалация',
};
// кто принимает/раздаёт задачи
const LEITUNG = ['gf', 'buchhaltung'];

function lesen() {
  try { return JSON.parse(fs.readFileSync(DATEI, 'utf8')); } catch (e) { return []; }
}
let plan = null;
function schreiben(liste) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = DATEI + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(liste, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, DATEI);
}

function id() {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function jetzt() {
  return process.env.BUCH_JETZT ? new Date(process.env.BUCH_JETZT).toISOString() : new Date().toISOString();
}

// видит ли пользователь задачу
function sichtbar(a, n) {
  if (LEITUNG.includes(n.rolle)) return true;         // руководство видит всё
  if (a.von === n.login) return true;                 // свои созданные
  if (a.ziel_person) return a.ziel_person === n.login;
  return a.ziel_rolle === n.rolle;                    // назначена на роль
}
// назначена ли задача именно этому человеку (он её исполнитель)
function meins(a, n) {
  if (a.ziel_person) return a.ziel_person === n.login;
  return a.ziel_rolle === n.rolle && !LEITUNG.includes(n.rolle);
}

// какие действия доступны пользователю над задачей (для кнопок в UI)
function aktionen(a, n) {
  const akt = [];
  const chef = LEITUNG.includes(n.rolle);
  const ich = meins(a, n);
  if (ich) {
    if (a.status === 'neu') akt.push('annehmen');            // взять в работу
    if (a.status === 'in_arbeit') akt.push('einreichen');    // сдать
    if (a.status !== 'angenommen' && a.status !== 'eskaliert') akt.push('eskalieren'); // передать выше
  }
  if (chef) {
    if (a.status === 'eingereicht') { akt.push('abnehmen'); akt.push('zurueck'); } // принять / вернуть
    if (a.status !== 'angenommen') akt.push('eskalieren');
    if (a.status === 'eskaliert') akt.push('wieder');        // вернуть в работу
    akt.push('bearbeiten'); // изменить/переназначить
  }
  return akt;
}

function name(login, benutzer) {
  const u = (benutzer || []).find(x => x.login === login);
  return u ? (u.name || u.login) : (login || '');
}
const ROLLE_TEXT = {
  gf: 'Владелец', buchhaltung: 'Бухгалтер', disponent: 'Ответственный', mitarbeiter: 'Сотрудник', buero: 'Офис',
};
function zielName(a, benutzer) {
  if (a.ziel_person) return name(a.ziel_person, benutzer);
  return ROLLE_TEXT[a.ziel_rolle] || a.ziel_rolle || '—';
}

// ---------- публичное ----------
function liste(n, benutzer, filter) {
  const alle = lesen()
    .filter(a => sichtbar(a, n))
    .map(a => ({
      ...a,
      status_text: STATUS_TEXT[a.status] || a.status,
      ziel_name: zielName(a, benutzer),
      von_name: name(a.von, benutzer),
      meins: meins(a, n),
      aktionen: aktionen(a, n),
    }));
  let sel = alle;
  if (filter && filter.rolle) sel = sel.filter(a => a.ziel_rolle === filter.rolle);
  if (filter && filter.person) sel = sel.filter(a => a.ziel_person === filter.person);
  // порядок: неготовые сверху, внутри — по сроку и дате
  const rang = { eskaliert: 0, eingereicht: 1, in_arbeit: 2, neu: 3, angenommen: 9 };
  sel.sort((x, y) => (rang[x.status] - rang[y.status])
    || String(x.frist || '9999').localeCompare(String(y.frist || '9999'))
    || String(y.angelegt).localeCompare(String(x.angelegt)));
  return sel;
}

function anlegen(b, n, benutzer) {
  if (!LEITUNG.includes(n.rolle)) throw new Error('создавать задачи может владелец или бухгалтерия');
  const titel = String(b.titel || '').trim();
  if (!titel) throw new Error('нужен заголовок задачи');
  const rollen = ['buchhaltung', 'disponent', 'mitarbeiter', 'gf', 'buero'];
  let ziel_rolle = b.ziel_rolle, ziel_person = b.ziel_person || null;
  if (ziel_person) {
    const u = (benutzer || []).find(x => x.login === ziel_person);
    if (!u) throw new Error('нет такого человека: ' + ziel_person);
    ziel_rolle = u.rolle;
  }
  if (!rollen.includes(ziel_rolle)) throw new Error('не указана роль-получатель');
  const a = {
    id: id(), titel, text: String(b.text || '').trim(),
    ziel_rolle, ziel_person,
    von: n.login, status: 'neu',
    art: b.art ? String(b.art).slice(0, 40) : 'aufgabe',
    posten: Array.isArray(b.posten) ? b.posten.slice(0, 100) : undefined,
    frist: /^\d{4}-\d{2}-\d{2}$/.test(String(b.frist || '')) ? b.frist : null,
    bezug: b.bezug ? String(b.bezug).slice(0, 120) : null,
    angelegt: jetzt(), geaendert: jetzt(),
    verlauf: [{ wann: jetzt(), wer: n.login, was: 'создана', status: 'neu' }],
  };
  const liste0 = lesen(); liste0.push(a); schreiben(liste0);
  return { ok: true, id: a.id };
}

const UEBERGANG = {
  annehmen: 'in_arbeit', einreichen: 'eingereicht', abnehmen: 'angenommen',
  zurueck: 'in_arbeit', eskalieren: 'eskaliert', wieder: 'in_arbeit',
};
const AKT_TEXT = {
  annehmen: 'взял в работу', einreichen: 'сдал на приёмку', abnehmen: 'принял',
  zurueck: 'вернул на доработку', eskalieren: 'эскалировал', wieder: 'вернул в работу',
};

function status(b, n, benutzer) {
  const alle = lesen();
  const a = alle.find(x => x.id === b.id);
  if (!a) throw new Error('задача не найдена');
  const erlaubt = aktionen(a, n);
  const akt = String(b.aktion || '');
  if (!(akt in UEBERGANG)) throw new Error('неизвестное действие');
  if (!erlaubt.includes(akt)) throw new Error('это действие вам сейчас недоступно');
  a.status = UEBERGANG[akt];
  a.geaendert = jetzt();
  a.verlauf = a.verlauf || [];
  a.verlauf.push({ wann: jetzt(), wer: n.login, was: AKT_TEXT[akt] || akt, status: a.status,
    notiz: b.notiz ? String(b.notiz).slice(0, 400) : undefined });
  schreiben(alle);
  return { ok: true, status: a.status, art: a.art || 'aufgabe' };
}

// задачи заданного типа, ещё не принятые (для очереди партий)
function offeneNachArt(art) {
  return lesen().filter(a => a.art === art && a.status !== 'angenommen');
}
// системная заметка в задачу (например «соединение восстановлено»); задачу не закрывает
function notiz(id, text, wer) {
  const alle = lesen();
  const a = alle.find(x => x.id === id);
  if (!a) return { ok: false };
  (a.verlauf = a.verlauf || []).push({ wann: jetzt(), wer: wer || 'system', was: String(text || '').slice(0, 400), status: a.status });
  a.geaendert = jetzt();
  schreiben(alle);
  return { ok: true };
}
// системная задача (не через роль-руководство) — для автосигналов интеграций/эскалаций
function systemAufgabe(b) {
  const a = {
    id: id(), titel: String(b.titel || 'Задача').slice(0, 200), text: String(b.text || '').trim(),
    ziel_rolle: b.ziel_rolle || 'buchhaltung', ziel_person: b.ziel_person || null,
    von: 'system', status: 'neu', art: b.art ? String(b.art).slice(0, 40) : 'system',
    frist: /^\d{4}-\d{2}-\d{2}$/.test(String(b.frist || '')) ? b.frist : null,
    bezug: b.bezug ? String(b.bezug).slice(0, 120) : null,
    angelegt: jetzt(), geaendert: jetzt(),
    verlauf: [{ wann: jetzt(), wer: 'system', was: 'создана системой', status: 'neu' }],
  };
  const l = lesen(); l.push(a); schreiben(l);
  return { ok: true, id: a.id };
}
function zaehleNachArt(art) {
  return lesen().filter(a => a.art === art).length;
}

function bearbeiten(b, n, benutzer) {
  if (!LEITUNG.includes(n.rolle)) throw new Error('менять задачу может владелец или бухгалтерия');
  const alle = lesen();
  const a = alle.find(x => x.id === b.id);
  if (!a) throw new Error('задача не найдена');
  if (b.titel != null) a.titel = String(b.titel).trim() || a.titel;
  if (b.text != null) a.text = String(b.text).trim();
  if (b.frist !== undefined) a.frist = /^\d{4}-\d{2}-\d{2}$/.test(String(b.frist || '')) ? b.frist : null;
  if (b.ziel_person !== undefined) {
    a.ziel_person = b.ziel_person || null;
    if (a.ziel_person) {
      const u = (benutzer || []).find(x => x.login === a.ziel_person);
      if (!u) throw new Error('нет такого человека');
      a.ziel_rolle = u.rolle;
    }
  }
  if (b.ziel_rolle && !a.ziel_person) a.ziel_rolle = b.ziel_rolle;
  a.geaendert = jetzt();
  (a.verlauf = a.verlauf || []).push({ wann: jetzt(), wer: n.login, was: 'изменил', status: a.status });
  schreiben(alle);
  return { ok: true };
}

// сводка по людям/ролям для центра владельца
function uebersicht(n, benutzer) {
  if (!LEITUNG.includes(n.rolle)) return null;
  const alle = lesen();
  const offen = alle.filter(a => a.status !== 'angenommen');
  const perZiel = {};
  for (const a of offen) {
    const k = a.ziel_person || a.ziel_rolle;
    const nm = zielName(a, benutzer);
    (perZiel[k] = perZiel[k] || { name: nm, neu: 0, in_arbeit: 0, eingereicht: 0, eskaliert: 0 });
    perZiel[k][a.status] = (perZiel[k][a.status] || 0) + 1;
  }
  return {
    offen: offen.length,
    wartet_abnahme: offen.filter(a => a.status === 'eingereicht').length,
    eskaliert: offen.filter(a => a.status === 'eskaliert').length,
    ziele: Object.values(perZiel),
  };
}

module.exports = { liste, anlegen, status, bearbeiten, uebersicht, offeneNachArt, zaehleNachArt, notiz, systemAufgabe, STATUS, STATUS_TEXT };
