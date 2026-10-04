/* Пользователи Buchhalter. Запускать на сервере:
     node /opt/buchhalter/benutzer.js liste
     node /opt/buchhalter/benutzer.js add <логин> <роль>     роли: gf | buchhaltung | buero | disponent | mitarbeiter
     node /opt/buchhalter/benutzer.js pin <логин>            сменить ПИН
     node /opt/buchhalter/benutzer.js weg <логин>
   ПИН вводится вслепую и никуда не передаётся — на диск ложится только хеш scrypt. */
'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto'), readline=require('readline');
const ZIEL=path.join(__dirname,'data','benutzer.json');
const ROLLEN={gf:'владелец', buchhaltung:'бухгалтерия', buero:'офис', disponent:'ответственный за наличные', mitarbeiter:'сотрудник'};

const lesen=()=>{ try{return JSON.parse(fs.readFileSync(ZIEL,'utf8'));}catch(e){return [];} };
const schreiben=l=>{ fs.mkdirSync(path.dirname(ZIEL),{recursive:true});
  fs.writeFileSync(ZIEL,JSON.stringify(l,null,1),{mode:0o600}); };

function frage(text){
  return new Promise(ok=>{
    const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:true});
    const schreib=rl._writeToOutput; rl._writeToOutput=function(s){ if(s.indexOf(text)>=0) schreib.call(rl,s); };
    rl.question(text,a=>{ rl.close(); process.stdout.write('\n'); ok(a); });
  });
}
async function neuerPin(){
  const a=await frage('Новый ПИН: ');
  if(a.length<5){ console.log('Слишком короткий — минимум 5 знаков. Ничего не изменено.'); process.exit(1); }
  const b=await frage('Ещё раз:   ');
  if(a!==b){ console.log('Не совпало. Ничего не изменено.'); process.exit(1); }
  const salz=crypto.randomBytes(16);
  return {salz:salz.toString('hex'), hash:crypto.scryptSync(a,salz,32).toString('hex')};
}

(async()=>{
  const [befehl,login,rolle]=process.argv.slice(2);
  const liste=lesen();
  const l=(login||'').trim().toLowerCase();

  if(befehl==='liste'||!befehl){
    if(!liste.length) return console.log('Пользователей нет.');
    for(const n of liste) console.log(`${n.login.padEnd(14)} ${ROLLEN[n.rolle]||n.rolle}   ${n.name||''}`);
    return;
  }
  if(befehl==='add'){
    if(!l||!ROLLEN[rolle]) return console.log('Нужно: add <логин> <'+Object.keys(ROLLEN).join('|')+'>');
    if(liste.some(n=>n.login===l)) return console.log('Такой логин уже есть. Смена ПИНа: pin '+l);
    const name=(await frage('Имя (как показывать в шапке): ')).trim();
    const p=await neuerPin();
    liste.push({login:l,name:name||l,rolle,...p,wann:new Date().toISOString()});
    schreiben(liste);
    return console.log(`Добавлен ${l} — ${ROLLEN[rolle]}.`);
  }
  if(befehl==='pin'){
    const n=liste.find(x=>x.login===l);
    if(!n) return console.log('Нет такого логина.');
    Object.assign(n,await neuerPin(),{wann:new Date().toISOString()});
    schreiben(liste);
    return console.log('ПИН заменён.');
  }
  if(befehl==='weg'){
    const rest=liste.filter(x=>x.login!==l);
    if(rest.length===liste.length) return console.log('Нет такого логина.');
    if(!rest.some(x=>x.rolle==='gf')) return console.log('Нельзя убрать последнего владельца.');
    schreiben(rest);
    return console.log('Удалён '+l+'. Его открытая сессия перестанет работать сразу.');
  }
  if(befehl==='person'){
    // Связь входа с человеком из Учёта часов (vavapp_prod.persons.id) — для кассы и чеков.
    const n=liste.find(x=>x.login===l);
    if(!n) return console.log('Нет такого логина.');
    const ref=String(rolle||'').trim();
    if(!/^[0-9a-f-]{36}$/i.test(ref)) return console.log('Нужно: person <логин> <id человека из Учёта часов>');
    n.person=ref.toLowerCase(); schreiben(liste);
    return console.log('Связан '+l+' с человеком '+n.person+'.');
  }
  console.log('Команды: liste | add <логин> <роль> | pin <логин> | person <логин> <id> | weg <логин>');
})();
