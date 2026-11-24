import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workflowView} from '../packages/wardrobe/src/workflow-view.mjs';

test('requested integration and details expose the manager contract needed to implement preset presentation',()=>{
 const presentation={event:'wardrobe:preset',clearDefault:'ui.setWidget("wardrobe", undefined)',nativeStatus:'ui.setStatus(key,text)'};
 const context={pi:{version:'1.3.0'},verification:{cli:'pi'},wardrobe:{docs:'manager/README.md',presentation}};
 const result={status:'REVIEW_REQUIRED',kind:'update',execution:'change-list',focus:{id:'requested'},context};
 const focused=workflowView(result,{action:'focus'});
 assert.deepEqual(focused.context.wardrobe.presentation,presentation,'a requested presentation change must not require searching manager internals');
 const skill={...result,focus:{id:'skill:example'}};
 assert.deepEqual(workflowView(skill,{action:'details'}).context,context,'details must recover the complete integration context');
 assert.equal(workflowView(skill,{action:'focus'}).context.wardrobe,undefined,'unrelated skill reviews keep the smaller context');
 assert.deepEqual(result.context,context);
});

test('routine receipts keep actionable state and recoverable decisions without replaying their narrative',()=>{
 const result={status:'REVIEW_REQUIRED',skills:{shared:{path:'shared.md',body:'METHOD_SENTINEL'},preset:{origin:'preset',path:'policy.md',body:'POLICY_SENTINEL'}},
  saved:{summary:'Integrate export',decisions:[{id:'export',action:'adapt',reason:'DECISION_SENTINEL'}],checks:[{command:'node',args:['export.test.mjs'],reason:'BEHAVIOR_SENTINEL'}],resources:[],migrations:[],obligations:['required-export']},
  nextCall:{action:'verify'},focus:{id:'export'},requiredDecisions:['export']};
 const receipt=workflowView(result,{action:'save'}),full=workflowView(result,{action:'details'});
 assert.doesNotMatch(JSON.stringify(receipt),/METHOD_SENTINEL|POLICY_SENTINEL|DECISION_SENTINEL|BEHAVIOR_SENTINEL/);
 assert.deepEqual(receipt.saved.decisions,[{id:'export',action:'adapt'}]);
 assert.equal(receipt.saved.counts.checks,1);
 assert.deepEqual(receipt.saved.obligations,['required-export']);
 assert.deepEqual(receipt.nextCall,{action:'verify'});
 assert.deepEqual(receipt.requiredDecisions,['export']);
 assert.match(JSON.stringify(full),/METHOD_SENTINEL/);assert.match(JSON.stringify(full),/POLICY_SENTINEL/);
 assert.match(JSON.stringify(full),/DECISION_SENTINEL/);assert.match(JSON.stringify(full),/BEHAVIOR_SENTINEL/);
 assert.equal(result.saved.decisions[0].reason,'DECISION_SENTINEL');
});

test('failed verification shows each diagnostic once while retaining every failing command and log',()=>{
 const failure={command:'node',args:['export.test.mjs'],code:1,reason:'Validate export',log:'export.log',tail:'DIAGNOSTIC_SENTINEL'};
 const result={status:'CHECK_FAILED',checks:[failure],repair:{item:'verification-repair',failures:[{...failure}]},nextCall:{action:'save'}};
 const receipt=workflowView(result,{action:'verify'});
 assert.equal(JSON.stringify(receipt).split('DIAGNOSTIC_SENTINEL').length-1,1);
 assert.deepEqual(receipt.repair.failures,[{command:'node',args:['export.test.mjs'],code:1,log:'export.log'}]);
 assert.equal(receipt.checks[0].tail,'DIAGNOSTIC_SENTINEL');
 assert.equal(workflowView(result,{action:'details'}).repair.failures[0].tail,'DIAGNOSTIC_SENTINEL');
 const different={...result,repair:{item:'verification-repair',failures:[{...failure,tail:'DIFFERENT_DIAGNOSTIC'}]}};
 assert.equal(workflowView(different,{action:'verify'}).repair.failures[0].tail,'DIFFERENT_DIAGNOSTIC','only fully duplicated diagnostic fields may be removed');
});
