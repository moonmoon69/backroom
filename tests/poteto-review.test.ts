import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = process.env.BACKROOM_REVIEW_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const { PotetoPack, POTETO_SETTING_KEY, DAY_MS } = await import(pathToFileURL(join(root, 'src/app/poteto.ts')).href);
const { makePstackFixture } = await import(pathToFileURL(join(root, 'scripts/pstack-fixture.ts')).href);
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();

function setup(t: any) {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-poteto-proof-'));
  t.after(() => rmSync(scratch, {recursive:true, force:true}));
  const up = makePstackFixture(join(scratch, 'upstream'), '1.0.0');
  const dataDir = join(scratch, 'data');
  mkdirSync(dataDir);
  const kv = new Map<string,string>();
  const repos = {getKv:(k:string)=>kv.get(k)??null, setKv:(k:string,v:string)=>void kv.set(k,v), deleteKv:(k:string)=>void kv.delete(k)};
  let now = Date.parse('2026-10-27T00:00:00Z');
  const clock = {now:()=>now, setInterval:()=>1, clearInterval:()=>{}};
  const options = {dataDir, source:up.bare, clock};
  const pack = new PotetoPack(repos, options);
  return {up, pack, repos, options, advance:()=>{now += DAY_MS;}};
}

test('a queued daily update must recheck off before it fetches or moves', async t => {
  const {up, pack, repos, advance} = setup(t);
  await pack.update();
  const before = pack.state().commit;
  up.commit('newer upstream', {version:'1.1.0'});
  advance();
  const queued = pack.tick();
  repos.setKv(POTETO_SETTING_KEY, 'off');
  await queued;
  console.log('after off while daily tick queued:', JSON.stringify(pack.state()));
  assert.equal(pack.state().commit, before, 'off must prevent the queued daily update from fetching and advancing');
});

test('the documented off/delete/on recovery must recreate the missing clone', async t => {
  const {pack, repos} = setup(t);
  await pack.update();
  repos.setKv(POTETO_SETTING_KEY, 'off');
  rmSync(pack.folder(), {recursive:true, force:true});
  repos.deleteKv(POTETO_SETTING_KEY);
  await pack.update();
  console.log('after off/delete/on:', JSON.stringify(pack.state()));
  assert.equal(existsSync(pack.folder()), true, 'turning on must recreate the deleted clone');
  assert.equal(pack.state().error, null);
});

test('startup briefing revision must name the actual checkout after an interrupted update', async t => {
  const {up, pack, repos, options} = setup(t);
  await pack.update();
  const next = up.commit('new revision before service interruption', {version:'1.1.0'});
  // Emulate termination after git moved the checkout, before settle persisted the new record.
  git(pack.folder(), 'fetch', '--quiet', 'origin');
  git(pack.folder(), 'merge', '--ff-only', '--quiet', 'origin/main');
  const restarted = new PotetoPack(repos, options);
  await restarted.tick(); // A recent persisted checkedAt makes this skip Git.
  console.log('startup briefing:', JSON.stringify(restarted.briefing()));
  assert.equal(restarted.briefing()?.commit, next.slice(0,7), 'a briefing must identify the instructions actually checked out');
  assert.equal(restarted.state().commit, next);
});
