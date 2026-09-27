const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {editFile}=require('../dist/tools/fs-tools');
const {Agent}=require('../dist/agent');
const {ContextManager}=require('../dist/context');
const {EventBus}=require('../dist/events');
const {Plan}=require('../dist/plan');
const {TaskManager}=require('../dist/tools/tasks');
test('a failed edit points to a bounded source range without changing the file',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'smol-edit-feedback-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=Array.from({length:140},(_,i)=>`// line ${i+1}`).join('\n')+'\n}\n\nfunction actualTarget() {\n  return 42;\n}\n';
 fs.writeFileSync(path.join(root,'module.js'),source);
 const result=editFile(root,{path:'module.js',old_text:'}\n\nfunction actualTarget() {\n  return 41;\n}',new_text:'replacement'});
 assert.match(result,/^Error: old_text was not found/);
 assert.match(result,/"offset":141/);
 assert.match(result,/location hint, not the whole block/);
 assert.equal(fs.readFileSync(path.join(root,'module.js'),'utf8'),source);
});

// H07 (#19) — retours d'échec de modification exploitables : la cause précise
// et l'extrait actuel pertinent, de quoi corriger au tour suivant sans relire
// le fichier entier.

function workspace(t,prefix){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
}

/** Les extraits que rend un échec, délimités par des lignes « --- ». */
function excerpts(text){
 const blocks=[];let cur=null;
 for(const line of String(text).split('\n')){
  if(line==='---'){if(cur){blocks.push(cur.join('\n'));cur=null;}else cur=[];continue;}
  if(cur)cur.push(line);
 }
 return blocks;
}

/** Un fournisseur simulé qui ne connaît du fichier que ce que les outils lui
 * rendent : au premier pas l'appel donné, ensuite `next(dernier résultat)`,
 * qui rend un appel d'outil ou null pour conclure. */
function simulated(first,next){
 const calls=[];let step=0;
 return {
  calls,
  label:'fake',modelId:'fake',contextWindow:32000,maxOutputTokens:2000,setEffort(){},effortLabel(){return null;},
  async chat(messages){
   step++;
   const call=step===1?first:next(messages.at(-1));
   if(!call)return {content:'Done',toolCalls:[]};
   const tc={id:`c${step}`,...call};calls.push(tc);
   return {content:'',toolCalls:[tc]};
  },
 };
}

function agentIn(ws,provider){
 const ui={token(){},thinking(){},toolCall(){},toolResult(){},println(){},status(){},warn(){},error(){},startSpinner(){},stopSpinner(){},turnEnd(){},planUpdated(){},async confirmCommand(){return 'yes';}};
 const ctx={workspace:ws,plan:new Plan(),taskManager:new TaskManager(ws),filesTouched:new Set(),commandsRun:[]};
 return new Agent(provider,'edit','sys',ctx,new ContextManager(32000,2000),new EventBus(),ui,false,10);
}

test('H07 AC1 (ambiguous): the simulated provider fixes the right occurrence from the returned excerpts, without rereading',async t=>{
 const ws=workspace(t,'smol-h07-ambiguous-');
 const source=['function first(items) {','  let total = 0;','  for (const i of items) total += i;','  return total;','}','','function second(items) {','  let total = 1;','  for (const i of items) total *= i;','  return total;','}',''].join('\n');
 fs.writeFileSync(path.join(ws,'app.js'),source);
 let excerptSeen=false;
 const provider=simulated({name:'edit_file',args:{path:'app.js',old_text:'  return total;',new_text:'  return total || 0;'}},last=>{
  if(last.role!=='tool')return null;
  if(!last.content.startsWith('Error'))return null;
  // Seule source : les extraits du retour. Sans extrait, relire le fichier.
  const block=excerpts(last.content).find(b=>b.includes('function second'));
  if(!block)return {name:'read_file',args:{path:'app.js'}};
  excerptSeen=true;
  const lines=block.split('\n');
  const from=lines.findIndex(l=>l.includes('function second'));
  const to=lines.findIndex((l,i)=>i>from&&l.includes('return total;'));
  const old_text=lines.slice(from,to+1).join('\n');
  return {name:'edit_file',args:{path:'app.js',old_text,new_text:old_text.replace('return total;','return total || 0;')}};
 });
 const agent=agentIn(ws,provider);
 await agent.runTurn('In second(), return 0 instead of a falsy total.');
 assert.equal(agent.outcome,'completed');
 const first=agent.messages.find(m=>m.role==='tool');
 assert.match(first.content,/^Error: old_text appears 2 times/);
 assert.match(first.content,/lines? 4\b/,'the first occurrence is located');
 assert.match(first.content,/lines? 10\b/,'the second occurrence is located');
 assert.match(first.content,/No file was changed/);
 assert.ok(excerptSeen,'the correction came from the returned excerpts');
 assert.deepEqual(provider.calls.map(c=>c.name),['edit_file','edit_file'],'no read_file between the failure and the fix');
 const after=fs.readFileSync(path.join(ws,'app.js'),'utf8');
 assert.equal(after,source.replace('  let total = 1;\n  for (const i of items) total *= i;\n  return total;','  let total = 1;\n  for (const i of items) total *= i;\n  return total || 0;'));
});

test('H07 AC1 (not found, short file): the current content comes back instead of a bare error',async t=>{
 const ws=workspace(t,'smol-h07-short-');
 fs.writeFileSync(path.join(ws,'config.js'),'let x = 1;\nlet y = 2;\n');
 const provider=simulated({name:'edit_file',args:{path:'config.js',old_text:'x=1;',new_text:'x = 3;'}},last=>{
  if(last.role!=='tool'||!last.content.startsWith('Error'))return null;
  const line=excerpts(last.content).join('\n').split('\n').find(l=>/\bx\s*=\s*1\b/.test(l));
  if(!line)return {name:'read_file',args:{path:'config.js'}};
  return {name:'edit_file',args:{path:'config.js',old_text:line,new_text:line.replace('1','3')}};
 });
 const agent=agentIn(ws,provider);
 await agent.runTurn('Set x to 3.');
 assert.equal(agent.outcome,'completed');
 assert.deepEqual(provider.calls.map(c=>c.name),['edit_file','edit_file'],'no read_file between the failure and the fix');
 assert.equal(fs.readFileSync(path.join(ws,'config.js'),'utf8'),'let x = 3;\nlet y = 2;\n');
});

test('H07 AC1 (cause): a not-found edit names the first diverging line of old_text and its current text',t=>{
 const ws=workspace(t,'smol-h07-cause-');
 const source=Array.from({length:30},(_,i)=>`// filler ${i+1}`).join('\n')+'\nfunction price(item) {\n  const base = item.cost;\n  return base * 1.2; // TVA\n}\n';
 fs.writeFileSync(path.join(ws,'price.js'),source);
 const result=editFile(ws,{path:'price.js',old_text:'function price(item) {\n  const base = item.cost;\n  return base * 1.2;\n}',new_text:'x'});
 assert.match(result,/^Error: old_text was not found in price\.js/);
 assert.match(result,/old_text lines 1-2 match lines 31-32/);
 assert.match(result,/line 3 of old_text/);
 assert.ok(result.includes('return base * 1.2; // TVA'),'the current text of the diverging line is quoted');
 assert.match(result,/No file was changed/);
 assert.equal(fs.readFileSync(path.join(ws,'price.js'),'utf8'),source);
});

test('H07 AC1 (missing file): the files that do exist next to it are listed',t=>{
 const ws=workspace(t,'smol-h07-missing-');
 fs.mkdirSync(path.join(ws,'src'));
 fs.writeFileSync(path.join(ws,'src','app.js'),'x');
 fs.writeFileSync(path.join(ws,'src','util.js'),'y');
 const result=editFile(ws,{path:'src/ap.js',old_text:'x',new_text:'z'});
 assert.match(result,/^Error: file "src\/ap\.js" does not exist/);
 assert.match(result,/app\.js/);
 assert.match(result,/util\.js/);
});
