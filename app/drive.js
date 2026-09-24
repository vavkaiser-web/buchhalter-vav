/* Доступ к оригиналам в Google Drive — тем же токеном владельца, что и MailOps.
   Ничего на диск не кладём: access_token живёт в памяти и обновляется заранее. */
"use strict";
const fs = require("fs");
const MAILOPS_ENV = process.env.BUCH_MAILOPS_ENV || "/opt/mailops/.env";

function umgebung() {
  const o = {};
  try {
    for (const z of fs.readFileSync(MAILOPS_ENV, "utf8").split("\n")) {
      const i = z.indexOf("="); if (i < 1 || z.trim().startsWith("#")) continue;
      o[z.slice(0, i).trim()] = z.slice(i + 1).trim().replace(/^["\x27]|["\x27]$/g, "");
    }
  } catch (e) { /* нет .env */ }
  return o;
}

let zwischen = { token: null, bis: 0 };
async function zugriffsToken() {
  if (zwischen.token && Date.now() < zwischen.bis) return zwischen.token;
  const e = umgebung();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: e.GMAIL_CLIENT_ID,
      client_secret: e.GMAIL_CLIENT_SECRET,
      refresh_token: e.DRIVE_OWNER_TOKEN || e.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  if (!r.ok) throw new Error("OAuth " + r.status);
  const d = await r.json();
  zwischen = { token: d.access_token, bis: Date.now() + (d.expires_in - 60) * 1000 };
  return zwischen.token;
}

async function beschreibung(dateiId) {
  const t = await zugriffsToken();
  const r = await fetch(
    "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(dateiId) +
    "?fields=id,name,mimeType,size&supportsAllDrives=true",
    { headers: { authorization: "Bearer " + t } });
  if (!r.ok) return null;
  return r.json();
}

async function inhalt(dateiId, range) {
  const t = await zugriffsToken();
  const kopf = { authorization: "Bearer " + t };
  if (range) kopf.range = range;
  return fetch(
    "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(dateiId) +
    "?alt=media&supportsAllDrives=true",
    { headers: kopf });
}

module.exports = { beschreibung, inhalt };
