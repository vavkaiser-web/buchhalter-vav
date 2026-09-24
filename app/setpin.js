/* Задать ПИН для входа в Buchhalter. Запускать на сервере:  node /opt/buchhalter/setpin.js
   ПИН вводится вслепую и никуда не передаётся — на диск ложится только хеш scrypt. */
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),readline=require('readline');
const ZIEL=path.join(__dirname,'data','pin.json');
function frage(text){
  return new Promise(ok=>{
    const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:true});
    const schreib=rl._writeToOutput; rl._writeToOutput=function(s){ if(s.indexOf(text)>=0) schreib.call(rl,s); };
    rl.question(text,a=>{ rl.close(); process.stdout.write('\n'); ok(a); });
  });
}
(async()=>{
  const a=await frage('Новый ПИН: ');
  if(a.length<5){ console.log('Слишком короткий — нужно минимум 5 знаков. Ничего не изменено.'); process.exit(1); }
  const b=await frage('Ещё раз:   ');
  if(a!==b){ console.log('Не совпало. Ничего не изменено.'); process.exit(1); }
  const salz=crypto.randomBytes(16);
  const hash=crypto.scryptSync(a,salz,32);
  fs.mkdirSync(path.dirname(ZIEL),{recursive:true});
  fs.writeFileSync(ZIEL,JSON.stringify({salz:salz.toString('hex'),hash:hash.toString('hex'),wann:new Date().toISOString()}),{mode:0o600});
  console.log('ПИН сохранён. Старые сессии продолжают действовать — сбросить их можно, удалив data/secret.');
})();
