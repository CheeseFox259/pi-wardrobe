import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {foldResources} from '../packages/wardrobe/src/compose.mjs';
import {writeJson} from '../packages/wardrobe/src/native-store.mjs';
import {compileResources} from '../packages/wardrobe/src/workflow-resources.mjs';

function fixture(t,{declared=false}={}){
 const source=mkdtempSync(join(tmpdir(),'wardrobe-resource-retirement-'));
 t.after(()=>rmSync(source,{recursive:true,force:true}));
 const current=[{package:'legacy',kind:'extensions',path:'extensions/index.mjs',enabled:true},{package:'legacy',kind:'themes',path:'themes/dark.json',enabled:true},{package:'legacy',kind:'themes',path:'themes/light.json',enabled:false}];
 const definition={schemaVersion:1,id:'retirement/local',name:'Retirement',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'},...(declared?{legacy:{source:'npm:legacy-footer@1.0.0'}}:{})},resources:[]};
 writeJson(join(source,'preset.json'),definition);writeJson(join(source,'package.json'),{name:'retirement',version:'1.0.0',pi:{}});
 return {source,current,definition,retire:current.map(({package:alias,kind,path})=>({action:'retire',package:alias,kind,path}))};
}

test('explicit retirement removes a deleted package from the compiled declaration and catalog',t=>{
 const {source,current,definition,retire}=fixture(t);
 const resources=compileResources(source,current,retire);
 assert.deepEqual(resources,[]);
 const compiled=JSON.parse(readFileSync(join(source,'preset.json')));
 assert.deepEqual(compiled.resources,[],'removed aliases must not leave even empty selectors');
 assert.doesNotThrow(()=>foldResources([{identity:definition.id,definition:compiled}],Object.keys(compiled.packages).map(alias=>({alias}))));
 assert.deepEqual(JSON.parse(readFileSync(join(source,'package.json'))).wardrobe.resourceCatalog,[]);
});

test('removing a package requires explicit retirement before the compiler writes a dangling selector',t=>{
 const {source,current}=fixture(t),before=['preset.json','package.json'].map(name=>readFileSync(join(source,name),'utf8'));
 assert.throws(()=>compileResources(source,current),error=>error.code==='WORKFLOW_RESOURCE_PACKAGE'&&/legacy/.test(error.message)&&/extensions\/index.mjs/.test(error.message)&&/retire/.test(error.message));
 assert.deepEqual(['preset.json','package.json'].map(name=>readFileSync(join(source,name),'utf8')),before);
});

test('retirement of a declared package retains explicit empty selections to disable discovery',t=>{
 const {source,current,retire}=fixture(t,{declared:true});
 compileResources(source,current,retire);
 assert.deepEqual(JSON.parse(readFileSync(join(source,'preset.json'))).resources,[{package:'legacy',kind:'extensions',include:[]},{package:'legacy',kind:'themes',include:[]}]);
});

test('retirement never permits creating or enabling undeclared package resources',t=>{
 const {source,current,retire}=fixture(t);
 for(const action of ['add','replace','enable','disable'])assert.throws(()=>compileResources(source,current,[{...retire[0],action}]),error=>error.code==='WORKFLOW_RESOURCE_PACKAGE');
 assert.throws(()=>compileResources(source,current,[{...retire[0],path:'missing.mjs'}]),error=>error.code==='WORKFLOW_RESOURCE_PACKAGE'||error.code==='WORKFLOW_RESOURCE_MISSING');
});
