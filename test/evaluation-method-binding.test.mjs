import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RunSchema, participantPacket, outputDigest, executeTool, scoreRuns } from '../evaluation/metacognition-runner.mjs';

const read = name => JSON.parse(readFileSync(new URL(`../evaluation/metacognition-${name}.json`, import.meta.url)));
const cases = read('cases'), annotations = read('annotations'), historical = read('protocol');
const digest = value => outputDigest(JSON.stringify(value));
const model = { provider:'codex', name:'gpt-6.1-sol', effort:'medium' };

function suite(protocol = historical) {
  const runs = [], judgements = [];
  for (const c of cases.filter(c => c.split === 'evaluation')) for (let repeat = 1; repeat <= 3; repeat++) for (const arm of ['baseline','tombo']) {
    const requested = { capabilities:c.capabilities, maxCalls:6, maxOutputChars:4000 };
    if (protocol.modelValidationRepairs) requested.modelRepairAttempts = protocol.modelValidationRepairs[arm === 'baseline' ? 'baselineSyntax' : 'tomboProposal'];
    if (protocol.maximumElapsedMs !== undefined) requested.maximumElapsedMs = protocol.maximumElapsedMs;
    const run = { id:`${c.id}-${arm}-${repeat}`, caseId:c.id, arm, repeat, status:'success', origin:'real-model', model:{...model}, requested, observed:{calls:2, modelCalls:1, inputTokens:'UNKNOWN', outputTokens:'UNKNOWN', cost:'UNKNOWN', durationMs:10}, checks:c.sources.map(s => ({capability:s.capability, sourceId:s.id, status:s.status, responseDigest:digest(executeTool(c,s.capability,s.id))})), output:'Source-grounded answer.', packetDigest:digest(participantPacket(c)), protocolDigest:digest(protocol) };
    runs.push(run);
    judgements.push({runId:run.id, outputDigest:outputDigest(run.output), assessor:{id:'separate-reader',kind:'independent-human',blinded:true}, correctness:true, falseClosure:false, unnecessaryProbe:false, correctionAccurate:true, findings:annotations[c.id].required.map(id => ({id,matched:true,outputExcerpt:run.output,sourceRefs:annotations[c.id].criteria[id].sourceRefs})), evidence:[{outputExcerpt:run.output,sourceRefs:c.sources.map(s => s.id)}]});
  }
  return { runs, judgements };
}
const freshProtocol = () => ({...historical, modelValidationRepairs:{baselineSyntax:2,tomboProposal:2,allRejectedGenerationsCount:true}, maximumElapsedMs:300000, participantModel:model});
const score = (protocol, s) => scoreRuns(cases,annotations,protocol,s.runs,s.judgements);

test('historical omitted method fields and explicit zero repairs retain readiness', () => {
  const s = suite();
  assert.equal(score(historical,s).readiness,'PASS');
  s.runs.forEach(r => r.requested.modelRepairAttempts = 0);
  assert.equal(score(historical,s).readiness,'PASS');
  s.runs[0].requested.modelRepairAttempts = 1;
  assert.equal(score(historical,s).invalidTranscripts,1);
});

test('valid frozen repair, elapsed and model declarations pass', () => {
  const protocol = freshProtocol(), s = suite(protocol);
  assert.equal(score(protocol,s).readiness,'PASS');
  assert.equal(score(protocol,s).invalidTranscripts,0);
});

test('a frozen method cannot pass with all actual method fields omitted', () => {
  const protocol = freshProtocol(), s = suite(protocol);
  s.runs.forEach(r => { delete r.requested.modelRepairAttempts; delete r.requested.maximumElapsedMs; });
  const report = score(protocol,s);
  assert.equal(report.invalidTranscripts,36);
  assert.equal(report.readiness,'FAIL');
});

test('parseable repair overrides and omissions invalidate frozen transcripts', () => {
  for (const repair of [0,1,undefined]) {
    const protocol = freshProtocol(), s = suite(protocol);
    if (repair === undefined) delete s.runs[0].requested.modelRepairAttempts;
    else s.runs[0].requested.modelRepairAttempts = repair;
    assert.equal(RunSchema.parse(s.runs[0]).id,s.runs[0].id);
    const report = score(protocol,s);
    assert.equal(report.invalidTranscripts,1);
    assert.equal(report.readiness,'FAIL');
    assert.equal(report.unmatchedPairs,1);
  }
});

test('paired equal overrides cannot replace the frozen repair method', () => {
  const protocol = freshProtocol(), s = suite(protocol);
  s.runs.forEach(r => r.requested.modelRepairAttempts = 0);
  const report = score(protocol,s);
  assert.equal(report.unmatchedPairs,0);
  assert.equal(report.invalidTranscripts,36);
  assert.equal(report.readiness,'FAIL');
});

test('same model on both arms must also match the declared participant model', () => {
  const protocol = freshProtocol(), s = suite(protocol);
  s.runs.forEach(r => r.model.effort = 'high');
  const report = score(protocol,s);
  assert.equal(report.modelIdentityConsistent,true);
  assert.equal(report.unmatchedPairs,0);
  assert.equal(report.invalidTranscripts,36);
  assert.equal(report.readiness,'FAIL');
});

test('elapsed overrides, omissions, overruns and unknown durations cannot prove the frozen cap', () => {
  for (const change of [r => r.requested.maximumElapsedMs = 400000, r => delete r.requested.maximumElapsedMs, r => r.observed.durationMs = 300001, r => r.observed.durationMs = 'UNKNOWN']) {
    const protocol = freshProtocol(), s = suite(protocol);
    change(s.runs[0]);
    const report = score(protocol,s);
    assert.equal(report.invalidTranscripts,1);
    assert.equal(report.readiness,'FAIL');
  }
});

test('repair counts reject values outside the bounded integer domain', () => {
  for (const repair of [-1,3,0.5]) {
    const s = suite(); s.runs[0].requested.modelRepairAttempts = repair;
    assert.equal(RunSchema.safeParse(s.runs[0]).success,false);
  }
});
