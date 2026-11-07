/** src/admin/ui/console/script/overview.ts — 앱 스크립트 조각: 조직 개요 · 7일 통계(E10) · 최근 활동(발신·수신을 섞은 몇 줄 — 조직·에이전트 개요 공용). */

export const OVERVIEW_JS = String.raw`
/* ---------- overview ---------- */
function renderOverview(){
  var n=S.agents.length,lim=agentLim(),tok=0;
  S.agents.forEach(function(a){tok+=num(a.activeTokens);});
  txt('st-agents',S.agentsLoaded?String(n):'');txt('st-agents-sub','/ '+lim);
  var over=S.agentsLoaded&&typeof lim==='number'&&n>lim;$('st-agents-over').hidden=!over;overLock(over);
  renderOrgStats();
  var first=S.agents[0];
  $('ov-s1').className=n?'done':'';$('ov-s2').className=(n&&tok)?'done':'';
  var allowed=first&&S.pol[first.id]?S.pol[first.id].out.allow.length>0||S.pol[first.id].out.mode==='all':false;$('ov-s3').className=allowed?'done':'';
  /* "get started" is derived: it waits for the agents (never a false "nothing done yet" while loading). With no agents the page is
     just this list — the agents and activity blocks would only be two more empty boxes (critique R7-08). */
  $('ov-start').hidden=!S.agentsLoaded||!!(n&&tok&&allowed);$('ov-agents-b').hidden=S.agentsLoaded&&n===0;$('ov-log-b').hidden=S.agentsLoaded&&n===0;
  $('ov-s2-a').href=first?agentHref(first,'connect'):'#/agents';$('ov-s3-a').href=first?routeHref({view:'agent',agent:first.id,tab:'email',sub:'outbound'}):'#/agents';
  var tb=$('ov-agents-body');clear(tb);$('ov-agents-empty').hidden=n>0||!S.agentsLoaded;$('ov-agents-tbl').hidden=n===0;
  S.agents.slice(0,8).forEach(function(a){tb.appendChild(agentRow(a));});
}
/* 7-day numbers (GET /api/stats, E10). Org line: sent · received (delivered + quarantined) · blocked or quarantined (denied + quarantined).
   Until the numbers arrive the cells show an en dash; if the call fails they show an em dash and one line says why. */
function statN(v){return typeof v==='number'&&isFinite(v)?grp(v):'—';}
function statsOf(j){var o=obj(j)&&obj(j.outbound)?j.outbound:null,i=obj(j)&&obj(j.inbound)?j.inbound:null;
  return {sent:o?o.sent:null,denied:o?o.denied:null,recv:i?num(i.delivered)+num(i.quarantined):null,q:i?i.quarantined:null,bad:o&&i?num(o.denied)+num(i.quarantined):null};}
function loadStats(agent,msg){var k=agent||'';say(msg,'');
  return api('GET','/api/stats?days=7'+(agent?'&agent='+enc(agent):'')).then(function(j){S.stats[k]=obj(j)?j:{};},function(e){S.stats[k]=false;partErr(msg,e,true);});} /* the cells already show a dash */
/* not known yet = empty (CSS draws a skeleton bar); failed = em dash + the section line (critique R7-01). */
function statCells(ids,vals){ids.forEach(function(id,i){txt(id,vals===null?'':statN(vals[i]));});}
function renderOrgStats(){var x=S.stats[''];statCells(['st-out','st-in','st-bad'],x===undefined?null:x===false?[null,null,null]:(function(s){return [s.sent,s.recv,s.bad];})(statsOf(x)));}

/* recent activity: newest rows of outbound + inbound merged (two small log calls), one line each. */
var DIRNAME={outbound:'발신',inbound:'수신'};
function recentItems(agent,limit){var q=function(t){return api('GET','/api/logs?type='+t+'&limit='+limit+(agent?'&agent='+enc(agent):'')).then(function(j){
    return arr(j&&j.items).filter(function(x){return obj(x)&&x.id!==undefined&&x.id!==null;}).map(function(x){return {t:t,x:x};});});};
  return Promise.all([q('outbound'),q('inbound')]).then(function(r){var all=r[0].concat(r[1]);
    all.sort(function(p,q2){return (new Date(q2.x.at).getTime()||0)-(new Date(p.x.at).getTime()||0);});return all.slice(0,limit);});}
function counterpart(node,e){var x=e.x;if(e.t==='outbound')recips(node,x.recipients,x.recipientCount);else if(x.from)node.appendChild(addrNode(x.from,false));else node.textContent='—';}
function activityRow(e,agent){var tr=el('tr','rl'),x=e.x,href=agent?routeHref({view:'agent',agent:agent,tab:'logs',log:e.t,entry:String(x.id)}):routeHref({view:'logs',log:e.t,entry:String(x.id)});
  var a=link(kstShort(x.at),href,'tlink');a.title=kst(x.at);a.addEventListener('click',function(){S.entryFromList=true;});cell(tr,'시각','time').appendChild(a);
  var dc=cell(tr,'방향','dir');dc.appendChild(ico(e.t==='outbound'?'upRight':'downLeft'));dc.appendChild(d.createTextNode(DIRNAME[e.t]||''));
  if(!agent)cell(tr,'에이전트 이름','agent').textContent=str(x.agentName,60)||agentName(x.agentId);
  var cp=cell(tr,'상대','peer');counterpart(cp,e);cp.title=cp.textContent;
  if(agent){var sj=cell(tr,'제목','subj');sj.className='cv subj';sj.textContent=e.t==='inbound'&&x.verdict==='rejected'&&!x.subject?'—':(str(x.subject,140)||'(제목 없음)');}
  cell(tr,'결과','result').appendChild(outcomePill(e.t==='outbound'?x.decision:x.verdict));
  tr.addEventListener('click',function(ev){if(ev&&ev.target&&ev.target.tagName==='A')return;S.entryFromList=true;location.hash=href;});
  return tr;}
function renderActivity(pre,agent,items){var tb=$(pre+'-log-body');clear(tb);$(pre+'-log-empty').hidden=items.length>0;$(pre+'-log-tbl').hidden=items.length===0;
  items.forEach(function(e){tb.appendChild(activityRow(e,agent));});}
function loadRecent(){say('ov-log-msg','');return recentItems('',6).then(function(items){renderActivity('ov','',items);})
  .catch(function(e){$('ov-log-tbl').hidden=true;partErr('ov-log-msg',e);});}
function showOverview(){renderOverview();loadRecent();loadStats('','ov-stats-msg').then(renderOrgStats);
  var f=S.agents[0];if(f&&!S.pol[f.id])loadPolicy(f.id).then(renderOverview,function(){});}
`;
