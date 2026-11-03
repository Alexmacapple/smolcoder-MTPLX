const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {runCommand,runCommandResult,renderCommandResult,commandPassed,pickShell,killTree}=require('../dist/tools/shell');
const {TaskManager}=require('../dist/tools/tasks');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

for(const background of [false,true])test(`${background?'task stop':'command cancellation'} closes background descendants and inherited pipes`,async t=>{
  if(!/bash/.test(pickShell().exe)){t.skip('This regression uses bash background syntax');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'smol-process-'));
  let pid;
  t.after(()=>{if(pid&&alive(pid))killTree(pid);fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,'worker.cjs'),"require('fs').writeFileSync('worker.pid',String(process.pid)); setInterval(()=>{},1000);");
  const abort=new AbortController(),tasks=new TaskManager(root);
  const running=background?tasks.start('node worker.cjs &'):runCommand('node worker.cjs &',root,abort.signal);
  for(let i=0;i<100&&!fs.existsSync(path.join(root,'worker.pid'));i++)await delay(30);
  pid=Number(fs.readFileSync(path.join(root,'worker.pid'),'utf8'));
  await delay(250); // the original shell would have exited, leaving the pipe open
  if(background)tasks.stop(running);else {abort.abort();assert.match(await running,/cancelled/);}
  for(let i=0;i<50&&alive(pid);i++)await delay(30);
  assert.equal(alive(pid),false,'background child must terminate with its owner');
});

test('managed commands preserve the foreground exit code',async()=>{
  const result=await runCommand('node -e "process.exit(7)"',process.cwd());
  assert.match(result,/\[exit code 7 in /);
});

const shape=r=>({started:r.started,status:r.status,exitCode:r.exitCode,signal:r.signal});

test('the executor returns the real exit code, never one printed by the command',async()=>{
  const r=await runCommandResult(`node -e "console.log('[exit code 0 in 1s]');process.exit(3)"`,process.cwd());
  assert.deepEqual(shape(r),{started:true,status:'exited',exitCode:3,signal:null});
  assert.ok(Number.isFinite(r.durationMs)&&r.durationMs>=0);
  assert.match(r.output,/\[exit code 0 in 1s\]/);
  assert.equal(commandPassed(r),false);
  assert.match(renderCommandResult(r),/^Error: command exited with code 3\n\[exit code 0 in 1s\]\n\n\[exit code 3 in \d+\.\ds\]$/);
  const ok=await runCommandResult('node -e "0"',process.cwd());
  assert.deepEqual(shape(ok),{started:true,status:'exited',exitCode:0,signal:null});
  assert.equal(commandPassed(ok),true);
  assert.match(renderCommandResult(ok),/^\(no output\)\n\[exit code 0 in \d+\.\ds\]$/);
});

test('cancellation, a missing directory and a timeout are typed outcomes that never pass',async t=>{
  const before=new AbortController();before.abort();
  const early=await runCommandResult('node -e "0"',process.cwd(),before.signal);
  assert.deepEqual(shape(early),{started:false,status:'cancelled',exitCode:null,signal:null});
  assert.equal(renderCommandResult(early),'Error: command cancelled before starting');
  const missing=await runCommandResult('node -e "0"',path.join(os.tmpdir(),`smol-missing-${process.pid}-${Date.now()}`));
  assert.deepEqual(shape(missing),{started:false,status:'spawn_error',exitCode:null,signal:null});
  assert.match(renderCommandResult(missing),/^Error: could not start command: .*ENOENT/);
  const abort=new AbortController();
  const running=runCommandResult(`node -e "console.log('partial');setInterval(()=>{},1000)"`,process.cwd(),abort.signal);
  setTimeout(()=>abort.abort(),400);
  const cancelled=await running;
  assert.deepEqual(shape(cancelled),{started:true,status:'cancelled',exitCode:null,signal:null});
  assert.match(renderCommandResult(cancelled),/^(?:partial\n\n)?\[command cancelled by the user before it finished\]$/);
  const slow=await runCommandResult(`node -e "console.log('slow');setInterval(()=>{},1000)"`,process.cwd(),undefined,400);
  assert.deepEqual(shape(slow),{started:true,status:'timeout',exitCode:null,signal:null});
  assert.match(renderCommandResult(slow),/^Error: slow\n\n\[command timed out after 0\.4s and was killed\. /);
  for(const r of [early,missing,cancelled,slow])assert.equal(commandPassed(r),false);
});

test('a command killed by a signal is non-successful whether the host reports a signal or an exit code',async t=>{
  if(!/bash/.test(pickShell().exe)){t.skip('This check uses bash to signal its own shell');return;}
  const r=await runCommandResult('kill -9 $$',process.cwd());
  if(process.platform==='win32'){
    assert.equal(r.started,true);
    assert.equal(r.status,'exited');
    assert.equal(r.signal,null);
    assert.ok(Number.isInteger(r.exitCode)&&r.exitCode!==0);
    assert.match(renderCommandResult(r),new RegExp(`^Error: command exited with code ${r.exitCode}\\n\\(no output\\)\\n\\[exit code ${r.exitCode} in \\d+\\.\\ds\\]$`));
  }else{
    assert.deepEqual(shape(r),{started:true,status:'signaled',exitCode:null,signal:'SIGKILL'});
    assert.match(renderCommandResult(r),/^Error: command exited with code \?\n\(no output\)\n\[exit code \? in \d+\.\ds\]$/);
  }
  assert.equal(commandPassed(r),false);
});
