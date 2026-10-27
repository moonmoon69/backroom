import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
const root=process.env.BACKROOM_REVIEW_ROOT ?? join(dirname(fileURLToPath(import.meta.url)),'..');
const {PotetoPack}=await import(pathToFileURL(join(root,'src/app/poteto.ts')).href);
const {makePstackFixture}=await import(pathToFileURL(join(root,'scripts/pstack-fixture.ts')).href);
const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

for (const warmed of [false,true]) test(`a ${warmed?'warm':'cold-start'} reader during a real checkout must retain the prior version and commit`,async t=>{
  const scratch=mkdtempSync(join(tmpdir(),'sol-cold-update-'));
  t.after(()=>rmSync(scratch,{recursive:true,force:true}));
  const up=makePstackFixture(join(scratch,'upstream'),'1.0.0');
  const dataDir=join(scratch,'data');
  mkdirSync(dataDir);
  const kv=new Map<string,string>();
  const repos={getKv:(k:string)=>kv.get(k)??null,setKv:(k:string,v:string)=>void kv.set(k,v),deleteKv:(k:string)=>void kv.delete(k)};
  const options={dataDir,source:up.bare};
  const first=new PotetoPack(repos,options);
  await first.update();
  const before=first.briefing();
  const folder=first.folder();
  const entered=join(scratch,'entered');
  const release=join(scratch,'release');
  const filter=join(scratch,'filter.sh');
  writeFileSync(filter,`#!/bin/sh\n: > '${entered}'\nwhile [ ! -e '${release}' ]; do sleep 0.01; done\ncat\n`,{mode:0o755});
  // Pause Git's real checkout at a skill after plugin.json, before HEAD advances.
  writeFileSync(join(folder,'.git/info/attributes'),'pstack/skills/tdd/SKILL.md filter=review\n');
  git(folder,'config','filter.review.smudge',filter);
  git(folder,'config','filter.review.clean','cat');
  up.commit('update version and skill',{version:'1.1.0',files:{'pstack/skills/tdd/SKILL.md':'# changed tdd\n'}});
  const cold=new PotetoPack(repos,options);
  if(warmed) cold.briefing();
  const updating=cold.update();
  try {
    const deadline=Date.now()+5000;
    while(!existsSync(entered)&&Date.now()<deadline) await setTimeout(10);
    assert.ok(existsSync(entered),'Git reached the paused checkout');
    const actual=cold.briefing();
    console.log(JSON.stringify({before,actual,versionOnDisk:JSON.parse(readFileSync(join(folder,'pstack/plugin.json'),'utf8')).version,head:git(folder,'rev-parse','HEAD')}));
    assert.deepEqual(actual,before,'the reader must see the prior checkout while the updater is moving files');
  } finally {
    writeFileSync(release,'go\n');
    await updating;
  }
});
