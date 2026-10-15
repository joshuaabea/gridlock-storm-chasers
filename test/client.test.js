import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise actual rendering code with a minimal DOM; this is not visual browser QA.
test('client renders risk/losses and replaces actions with status cards outside active decisions', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url),'utf8');
  const element = () => ({ hidden:false, disabled:false, textContent:'', value:'',
    classList:{toggle(){}}, addEventListener(){}, append(){}, replaceChildren(){} });
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],element()]));
  const handlers = {};
  runInNewContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'), {
    document:{getElementById:id=>nodes.get(id),createElement:element},
    io:()=>({connected:true,on:(event,fn)=>handlers[event]=fn,connect(){}}),
    sessionStorage:{getItem:()=>JSON.stringify({playerId:'a'}),setItem(){}},
    setTimeout, clearTimeout,
  });
  const state = {roomCode:'TEST', phase:'DECISION',stormNumber:1,turnNumber:1,
    cardsRemaining:14,bustRiskPercent:7,stormBusted:false,stormLosses:[],
    players:[{id:'a',name:'Alpha',isHost:true,connected:true,status:'ACTIVE',unbankedScore:20,bankedScore:10,hasLockedChoice:false}],
    currentCard:{type:'HAZARD',title:'Lightning Strike'},activeHazards:['Lightning Strike'],
    hazardWarning:'Watch the storm.',salvageCache:8,timerRemaining:15,lastEventLog:'Test'};
  handlers.state_update(state);
  assert.equal(nodes.get('push-label').textContent,'Push deeper');
  assert.equal(nodes.get('push-risk').textContent,'7% next-draw bust risk');
  assert.equal(nodes.get('deck-label').textContent,'DECK: 14');
  assert.equal(nodes.get('storm-label').textContent,'STORM 1/3');
  assert.equal(nodes.get('turn-label').textContent,'TURN 1');
  assert.match(nodes.get('decision-detail').textContent,/28 total/);
  handlers.state_update({...state, players:[{...state.players[0],unbankedScore:0}]});
  assert.match(nodes.get('decision-detail').textContent,/8 salvage—8 total/);
  assert.equal(nodes.get('decision-buttons').hidden,false);
  assert.equal(nodes.get('push').disabled,false);
  for(const phase of ['TURN_SUMMARY','STORM_END']) {
    handlers.state_update({...state,phase});
    assert.equal(nodes.get('decision-buttons').hidden,true);
    assert.equal(nodes.get('status-summary').hidden,false);
  }
  handlers.state_update({...state,players:[{...state.players[0],status:'EXTRACTED'}]});
  assert.equal(nodes.get('decision-buttons').hidden,true);
  assert.equal(nodes.get('decision-dock').hidden,true);
  handlers.state_update({...state,players:[{...state.players[0],status:'EXTRACTED',extractionReceipt:{turnNumber:4,telemetry:25,salvage:24,total:49,bankedTotal:59}}]});
  assert.equal(nodes.get('receipt').hidden,false);
  assert.equal(nodes.get('receipt-total').textContent,'+49 pts');
  assert.equal(nodes.get('receipt-banked').textContent,'59 pts');
  handlers.state_update(state);
  assert.equal(nodes.get('receipt').hidden,true);
  handlers.state_update({...state,phase:'STORM_END',stormBusted:true,stormLosses:[{id:'a',name:'Alpha',lostPoints:20}]});
  assert.equal(nodes.get('decision-title').textContent,'STORM BUSTED!');
  assert.equal(nodes.get('decision-detail').textContent,'Alpha lost 20 unbanked pts');
  assert.equal(nodes.get('warning').textContent,'Catastrophic failure! Active crews wiped.');
  handlers.state_update({...state,phase:'STORM_END'});
  assert.equal(nodes.get('decision-title').textContent,'Safely extracted.');
  handlers.state_update({...state,mode:'PUBLIC',phase:'LOBBY',queueRemaining:null});
  assert.equal(nodes.get('start').hidden,true);
  assert.equal(nodes.get('wait-practice').hidden,false);
  assert.match(nodes.get('lobby-message').textContent,/No bots/);
  assert.equal(nodes.get('social-panel').hidden,false);
  handlers.state_update({...state,mode:'PUBLIC',phase:'LOBBY',queueRemaining:7});
  assert.match(nodes.get('lobby-message').textContent,/Starting in 7s/);
  handlers.state_update({...state,mode:'PRACTICE'});
  assert.match(nodes.get('mode-label').textContent,/COMPUTER OPPONENTS/);
  assert.equal(nodes.get('social-panel').hidden,true);
  for(const id of ['name','code']) {
    const tag = html.match(new RegExp(`<input id="${id}"[^>]+>`))[0];
    for(const attribute of ['autocomplete="off"','autocorrect="off"','autocapitalize="characters"','spellcheck="false"']) assert.ok(tag.includes(attribute));
  }
});
