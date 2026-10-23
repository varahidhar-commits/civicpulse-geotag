const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

test('government renders both delay types, legacy setup, and escaped worker details', async () => {
  const elements = {'gov-alerts-list': {innerHTML:'',querySelectorAll:()=>[]}, 'gov-alert-count': {}};
  const context = {
    document: {getElementById:id=>elements[id]},
    Api:{govNotifications:async()=>({unreadCount:2,notifications:[
      {id:'1',type:'worker_not_started',workerName:'<Alice>',complaintTitle:'Road',deadlineAt:'2026-10-20T00:00:00Z'},
      {id:'2',type:'worker_resolution_overdue',workerName:'Bob',complaintTitle:'Drain',deadlineAt:'2026-10-21T00:00:00Z'}
    ]})},
    Session:{user:{id:'officerA'}},I18n:{locale:()=> 'en'},
    escapeHtml:value=>String(value??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),
    timeAgo:()=> 'now', alertHtml:String, scoreBadgeHtml:()=>'', statusChip:()=>'',priorityChip:()=>'',weatherChip:()=>'',recurringChip:()=>'',categoryLabel:String,
    Date, console
  };
  vm.createContext(context);
  const code = fs.readFileSync(require.resolve('../../frontend/js/government.js'),'utf8')
    .replace('return { init, switchView, loadOverview };','return { init, switchView, loadOverview, loadAlerts, govComplaintCard };');
  vm.runInContext(code+';globalThis.portal=GovernmentPortal;',context);
  await context.portal.loadAlerts();
  const html = elements['gov-alerts-list'].innerHTML;
  assert.match(html,/Worker not yet started the work/); assert.match(html,/resolution not submitted/);
  assert.match(html,/&lt;Alice&gt;/); assert.doesNotMatch(html,/<Alice>/);
  const legacy = context.portal.govComplaintCard({id:'c',title:'Road',status:'assigned',assignedById:'officerA'},[]);
  assert.match(legacy,/no start deadline is set/); assert.match(legacy,/Set missing deadlines/);
  const started = context.portal.govComplaintCard({id:'c',title:'Road',status:'in_progress',assignedById:'officerA'},[]);
  assert.match(started,/Set missing deadlines/); assert.doesNotMatch(started,/assign-btn/);
});
