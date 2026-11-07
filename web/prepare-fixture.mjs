import fs from 'node:fs';
const path=new URL('./public/fixtures/score.musicxml',import.meta.url);
let id=0;
const xml=fs.readFileSync(path,'utf8').replace(/<note\b([^>]*)>([\s\S]*?)<\/note>/g,(full,attrs,body)=>{
 if(/<rest\b/.test(body))return full;
 return `<note${attrs.replace(/\s+id="[^"]*"/g,'')} id="n${++id}">${body}</note>`;
});
fs.writeFileSync(path,xml);
console.log(JSON.stringify({notes:id,measures:(xml.match(/<measure\b/g)||[]).length}));
