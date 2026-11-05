// Explicit opt-in: this suite executes SQL only inside the named local Docker container.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

const enabled = process.env.BPT_LOCAL_DOCKER_TEST === '1';
const container = 'supabase_db_bpt-watch-shortcuts';
const player = '90000000-0000-4000-8000-000000000001';
const event = '90000000-0000-4000-8000-000000000010';
const match = '90000000-0000-4000-8000-000000000020';
function sql(text, {allowFailure = false} = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec','-i',container,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres']);
    let out='', err=''; p.stdout.on('data', v=>out+=v); p.stderr.on('data',v=>err+=v);
    p.on('error',reject); p.on('close',code=>code && !allowFailure ? reject(new Error(err)) : resolve({code,out:out.trim(),err}));
    p.stdin.end(text);
  });
}
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const mode = ['watch','player','admin'].includes(process.env.BPT_TEST_MODE) ? process.env.BPT_TEST_MODE : 'watch';
const rpc = `public.finalize_live_match_atomic('${match}',5,'${player}', '${mode}')`;
const insert = `insert into public.live_matches(id,event_id,team_a_player_ids,team_b_player_ids,created_by,games_a,games_b,completed,version) values ('${match}','${event}',array['${player}','90000000-0000-4000-8000-000000000002']::uuid[],array['90000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000004']::uuid[],'${player}',4,2,true,5);`;
const cleanup = `delete from public.match_scores where event_id='${event}'; delete from public.live_matches where event_id='${event}'; delete from public.events where id='${event}'; delete from public.players where id in ('${player}','90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000004');`;

test(`local Postgres serializes ${mode} finalization, undo, duplicate finishes and rollback`, {skip: !enabled, timeout: 30000}, async () => {
  try {
    await sql(`${cleanup}
      insert into public.players(id,name) values ('${player}','Synthetic race A'),('90000000-0000-4000-8000-000000000002','Synthetic race B'),('90000000-0000-4000-8000-000000000003','Synthetic race C'),('90000000-0000-4000-8000-000000000004','Synthetic race D');
      insert into public.events(id,event_date) values ('${event}','2098-02-02');
      insert into public.eois(event_id,player_id,status) values ('${event}','${player}','yes'); ${insert}`);
    // A holds the transaction open after finalizing, so B must wait for its row lock.
    const a=sql(`begin; select ${rpc}->>'status'; select pg_sleep(2); commit;`);
    await delay(500); const started=Date.now();
    const b=await sql(`with changed as (update public.live_matches set version=6 where id='${match}' and version=5 returning id) select count(*) from changed;`);
    assert.ok(Date.now()-started>900,'conditional undo waited for finalization lock');
    assert.equal(b.out,'0'); assert.match((await a).out,/saved/);
    assert.equal((await sql(`select games_a || ':' || games_b from public.match_scores where source_live_match_id='${match}';`)).out,'4:2');
    assert.equal((await sql(`select ${rpc}->>'status';`)).out,'already_saved');

    await sql(`delete from public.match_scores where source_live_match_id='${match}'; ${insert}`);
    const update=sql(`begin; update public.live_matches set version=6 where id='${match}'; select pg_sleep(2); commit;`);
    await delay(500); const conflict=await sql(`select ${rpc}->>'status';`); await update;
    assert.equal(conflict.out,'conflict');
    assert.equal((await sql(`select count(*) from public.match_scores where source_live_match_id='${match}';`)).out,'0');

    await sql(`update public.live_matches set version=5 where id='${match}';`);
    const first=sql(`begin; select ${rpc}->>'status'; select pg_sleep(2); commit;`);
    await delay(500); const second=await sql(`select ${rpc}->>'status';`);
    assert.match((await first).out,/saved/); assert.equal(second.out,'already_saved');
    assert.equal((await sql(`select count(*) from public.match_scores where source_live_match_id='${match}';`)).out,'1');

    await sql(`delete from public.match_scores where source_live_match_id='${match}'; ${insert}`);
    const failed=await sql(`begin; create function pg_temp.fail_delete() returns trigger language plpgsql as $$begin raise exception 'synthetic rollback'; end$$; create trigger fail_delete before delete on public.live_matches for each row execute function pg_temp.fail_delete(); select ${rpc}; commit;`,{allowFailure:true});
    assert.notEqual(failed.code,0); assert.match(failed.err,/synthetic rollback/);
    assert.equal((await sql(`select count(*) from public.match_scores where source_live_match_id='${match}';`)).out,'0');
    assert.equal((await sql(`select count(*) from public.live_matches where id='${match}';`)).out,'1');
  } finally { await sql(cleanup); }
});
