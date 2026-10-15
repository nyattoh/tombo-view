import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { participantPacket, blindedPacket, outputDigest, scoreRuns, executeTool, validateDataset } from '../evaluation/metacognition-runner.mjs';
const read = name => JSON.parse(readFileSync(new URL(`../evaluation/metacognition-${name}.json`, import.meta.url)));
const cases = read('cases'), annotations = read('annotations'), protocol = read('protocol');
const makeRun = (c, arm, repeat = 1) => ({ id: `${c.id}-${arm}-${repeat}`, caseId:c.id, arm, repeat, status:'success', origin:'real-model', model:{provider:'local', name:'same', effort:'high'}, requested:{capabilities:c.capabilities, maxCalls:6, maxOutputChars:4000}, observed:{calls:2, modelCalls:1, inputTokens:'UNKNOWN', outputTokens:'UNKNOWN', cost:'UNKNOWN', durationMs:10}, checks:c.sources.map(s=>({capability:s.capability,sourceId:s.id,status:s.status,responseDigest:outputDigest(JSON.stringify(executeTool(c,s.capability,s.id)))})), output:'Source-grounded answer.', packetDigest:outputDigest(JSON.stringify(participantPacket(c))), protocolDigest:outputDigest(JSON.stringify(protocol)) });
const rating = (r, c, correct = true) => ({ runId:r.id, outputDigest:outputDigest(r.output), assessor:{id:'separate-reader', kind:'independent-human', blinded:true}, correctness:correct, falseClosure:false, unnecessaryProbe:false, findings:annotations[c.id].required.map(id => ({id, matched:true, outputExcerpt:r.output, sourceRefs:annotations[c.id].criteria[id].sourceRefs})), correctionAccurate:correct, evidence:[{outputExcerpt:r.output, sourceRefs:c.sources.map(s=>s.id)}] });
const suite = () => { const runs=[], ratings=[]; for(const c of cases.filter(c=>c.split==='evaluation')) for(let repeat=1;repeat<=3;repeat++) for(const arm of ['baseline','tombo']) { const r=makeRun(c,arm,repeat); runs.push(r); ratings.push(rating(r,c)); } return {runs,ratings}; };
test('participants see organic tasks and capability names, not annotations or scripted answers', () => { const p=participantPacket(cases[0]); assert.equal(p.task,cases[0].task); assert.deepEqual(Object.keys(p).sort(),['capabilities','context','draft','task','tools']); assert.ok(!JSON.stringify(p).includes(annotations[cases[0].id].required[0])); assert.equal(p.tools[0].response,undefined); });
test('families never cross splits and duplicate identifiers fail', () => { assert.equal(validateDataset(cases,annotations),true); assert.throws(()=>validateDataset([...cases,{...cases[0],id:'extra',split:'evaluation'}],annotations),/family/); assert.throws(()=>validateDataset([...cases,cases[0]],annotations),/duplicate/); });
test('scripted tools enforce capabilities and return the specified source', () => { const c=cases[0]; assert.throws(()=>executeTool(c,'unavailable-capability',c.sources[0].id),/capability/); assert.equal(executeTool(c,c.capabilities[0],c.sources[0].id).id,c.sources[0].id); });
test('missing pairs and cancellations count as failure', () => { const s=suite(); s.runs[0].status='cancelled'; s.runs.pop(); const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings); assert.equal(report.statusCounts.cancelled,1); assert.equal(report.statusCounts.missing,1); assert.equal(report.readiness,'FAIL'); assert.equal(report.comparison,'INCONCLUSIVE'); });
test('output changes invalidate judgements and blinded packets omit model and arm', () => { const c=cases.find(c=>c.split==='evaluation'), r=makeRun(c,'tombo'); const b=blindedPacket(r,c,annotations[c.id]); assert.equal(b.outputDigest,outputDigest(r.output)); assert.equal(b.arm,undefined); assert.equal(b.model,undefined); const j=rating(r,c); r.output='Changed answer'; const report=scoreRuns(cases,annotations,protocol,[r],[j]); assert.equal(report.invalidJudgements,1); assert.equal(report.readiness,'FAIL'); });
test('all unknown strategy fails positive controls', () => { const s=suite(); for(const r of s.runs) { r.output='Everything is unknown.'; const c=cases.find(c=>c.id===r.caseId); const j=rating(r,c,!annotations[c.id].control); j.findings=[]; s.ratings[s.runs.indexOf(r)]=j; } const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings); assert.equal(report.readiness,'FAIL'); assert.ok(report.arms.tombo.correctness<0.9); });
test('repeats are summarised per case and equivalent sides never establish superiority', () => { const s=suite(), report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings); assert.equal(report.independentCases,cases.filter(c=>c.split==='evaluation').length); assert.equal(report.comparison,'INCONCLUSIVE'); assert.equal(report.readiness,'PASS'); assert.equal(report.g4CostProven,false); });
test('unmatched model and budgets refuse comparison', () => { const s=suite(); s.runs[1].model.name='other'; s.runs[3].requested.maxCalls=3; const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings); assert.equal(report.comparison,'INCONCLUSIVE'); assert.ok(report.unmatchedPairs>=2); });
test('fixtures and absent independent judges cannot prove behavioural readiness', () => { const s=suite(); s.runs.forEach(r=>r.origin='fixture'); assert.equal(scoreRuns(cases,annotations,protocol,s.runs,s.ratings).readiness,'FAIL'); assert.equal(scoreRuns(cases,annotations,protocol,s.runs,[]).readiness,'FAIL'); });
test('forged source transcripts and changed frozen cases fail', () => { const s=suite(), c=cases.find(c=>c.split==='evaluation'); s.runs[0].checks=[{capability:'read_record',sourceId:c.sources[0].id,status:'ok',responseDigest:'forged'}]; s.runs[0].observed.calls=2; const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings); assert.equal(report.invalidTranscripts,1); assert.equal(report.readiness,'FAIL'); const altered=structuredClone(cases); altered[0].context='changed'; assert.throws(()=>scoreRuns(altered,annotations,protocol,[],[]),/digest/); });
test('unknown evidence references and inconsistent assessors cannot pass', () => { const s=suite(); s.ratings[0].evidence[0].sourceRefs=['nonexistent']; s.ratings[1].assessor.id='another-person'; const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings); assert.equal(report.invalidJudgements,1); assert.equal(report.independentAssessorConsistent,false); assert.equal(report.readiness,'FAIL'); });
test('undeclared calls and output budget overflow invalidate captured runs', () => { const s=suite(); s.runs[0].output='x'.repeat(4001); s.runs[1].observed.calls=7; const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings); assert.equal(report.invalidTranscripts,2); assert.equal(report.comparison,'INCONCLUSIVE'); });
test('findings cannot claim unseen tool evidence', () => { const s=suite(); s.runs[0].checks=[]; s.runs[0].observed.calls=1; const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings); assert.equal(report.invalidJudgements,1); assert.equal(report.readiness,'FAIL'); });
test('dataset rejects dangling, duplicate and non-array required criteria before scoring', () => {
  for (const required of [['missing-criterion'], [annotations[cases[0].id].required[0], annotations[cases[0].id].required[0]], 'invalid']) {
    const altered=structuredClone(annotations); altered[cases[0].id].required=required;
    assert.throws(()=>validateDataset(cases,altered),/required/);
    assert.throws(()=>scoreRuns(cases,altered,protocol,[],[]),/required/);
  }
});
test('one-character assessor excerpts cannot establish readiness', () => {
  const s=suite();
  for (const j of s.ratings) { j.evidence[0].outputExcerpt='e'; j.findings.forEach(f=>f.outputExcerpt='e'); }
  const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings);
  assert.equal(report.invalidJudgements,36); assert.equal(report.readiness,'FAIL');
});
test('whitespace padding cannot give excerpts meaningful length', () => {
  const s=suite(); s.runs[0].output='e           '; s.ratings[0].outputDigest=outputDigest(s.runs[0].output);
  s.ratings[0].evidence[0].outputExcerpt=s.runs[0].output; s.ratings[0].findings.forEach(f=>f.outputExcerpt=s.runs[0].output);
  assert.equal(scoreRuns(cases,annotations,protocol,s.runs,s.ratings).invalidJudgements,1);
});
test('matching pairs from different case models cannot pass pooled readiness', () => {
  const s=suite(), otherCase=s.runs[6].caseId;
  s.runs.filter(r=>r.caseId===otherCase).forEach(r=>r.model={provider:'other-provider',name:'other-model',effort:'low'});
  const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings);
  assert.equal(report.unmatchedPairs,0); assert.equal(report.modelIdentityConsistent,false);
  assert.deepEqual(report.models,[{provider:'local',name:'same',effort:'high'},{provider:'other-provider',name:'other-model',effort:'low'}]);
  assert.equal(report.readiness,'FAIL'); assert.equal(report.comparison,'INCONCLUSIVE');
});
test('control correctness improvement does not count as required-finding breadth', () => {
  const s=suite(), requiredCase=cases.find(c=>c.split==='evaluation'&&annotations[c.id].required.length), control=cases.find(c=>c.split==='evaluation'&&annotations[c.id].control);
  for(const r of s.runs.filter(r=>r.arm==='baseline')) {
    const j=s.ratings.find(j=>j.runId===r.id);
    if(r.caseId===requiredCase.id) j.findings=[];
    if(r.caseId===control.id) {j.correctness=false;j.correctionAccurate=false;}
  }
  const report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings);
  assert.equal(report.improvedCases,1); assert.equal(report.readiness,'PASS'); assert.equal(report.comparison,'INCONCLUSIVE');
});
test('perfect synthetic ratings explicitly remain attestations, not capability evidence', () => {
  const s=suite(), report=scoreRuns(cases,annotations,protocol,s.runs,s.ratings);
  assert.equal(report.callsAndOriginAttestationOnly,true); assert.equal(report.independentAssessorAttestationOnly,true);
  assert.equal(report.modelIdentityConsistent,true); assert.deepEqual(report.models,[{provider:'local',name:'same',effort:'high'}]);
  assert.equal(report.g4CostProven,false); assert.equal(report.readiness,'PASS'); assert.equal(report.comparison,'INCONCLUSIVE');
});
