import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const baseCommit = 'f2ecc2e4ccbfe109596d9e156095fff7af76ea6a';
export const domains = ['development', 'automation', 'research'];
export const actions = ['proceed', 'check', 'ask', 'reframe', 'blocked'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

let baseline;
export async function oldSdk() {
  if (!baseline) {
    const root = new URL('../../../', import.meta.url);
    const handover = JSON.parse(readFileSync(new URL('docs/ask-policy-work/comparison-main/execution.json', root), 'utf8'));
    assert.equal(handover.baseline.commit, baseCommit, 'Comparison baseline handover is required');
    assert.equal(handover.baseline.compiler.exit_code, 0);
    for (const file of ['core', 'types']) {
      const snapshot = readFileSync(new URL(`evaluation/ask-policy-baseline/f2ecc2e/src/${file}.ts`, root));
      assert.equal(createHash('sha1').update(`blob ${snapshot.length}\0`).update(snapshot).digest('hex'), handover.baseline.sources[file].blobId, 'Comparison snapshot must equal Git blob');
      assert.equal(sha256(snapshot), handover.baseline.sources[file].sha256);
    }
    for (const file of ['core-bridge.js', 'types.js']) {
      assert.equal(sha256(readFileSync(new URL(`evaluation/ask-policy-baseline/f2ecc2e/.generated/${file}`, root))), handover.baseline.bridgeFiles[file]);
    }
    baseline = import(new URL('evaluation/ask-policy-baseline/f2ecc2e/.generated/core-bridge.js', root));
  }
  return baseline;
}

export function projectToOldSchema(state) {
  const copy = structuredClone(state);
  delete copy.policyHistory;
  delete copy.reflectionEffects;
  for (const gap of copy.gaps) delete gap.humanRole;
  return copy;
}

const forbidden = /^(expected.*|intent.*|author.*|groundTruth|targetAction|label|labels|isControl|control.*|family|annotation.*|consensus.*|vendor)$/i;
export function assertInputOnly(value, path = '') {
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const schemaLensLabel = key === 'label' && /^input\.state\.lenses\.\d+$/.test(path);
    assert.ok(schemaLensLabel || !forbidden.test(key), `Input contains isolated metadata field ${key}`);
    assertInputOnly(item, path ? `${path}.${key}` : key);
  }
}

export async function validateCases(cases, domain) {
  assert.ok(Array.isArray(cases));
  assert.equal(cases.length, domain ? 20 : 60);
  assert.equal(new Set(cases.map(item => item.caseId)).size, cases.length);
  const sdk = await oldSdk();
  for (const item of cases) {
    assert.deepEqual(Object.keys(item).sort(), ['caseId', 'domain', 'input']);
    assert.match(item.caseId, /^[a-z0-9-]+$/);
    assert.doesNotMatch(item.caseId, /ask|check|proceed|reframe|blocked|intent|family/i);
    assert.ok(domains.includes(item.domain));
    if (domain) assert.equal(item.domain, domain);
    assert.deepEqual(Object.keys(item.input).sort(), ['packet', 'state']);
    assertInputOnly(item);
    const { packet, state } = item.input;
    assert.deepEqual(packet, state.task, `${item.caseId}: task snapshot`);
    assert.equal(packet.taskId, state.taskId);
    assert.ok(state.evidence.length && state.claims.length && state.lenses.length, `${item.caseId}: substantive state`);
    sdk.validateState(projectToOldSchema(state));
    const hash = sdk.understandingHash(state);
    if (state.policyHistory) {
      const h = state.policyHistory;
      assert.deepEqual(Object.keys(h).sort(), ['consecutiveNoProgressRounds', 'lastProgressAtRevision', 'lastUnderstandingHash', 'recentOutcomes']);
      assert.equal(h.lastUnderstandingHash, hash);
      assert.ok(Number.isInteger(h.lastProgressAtRevision) && h.lastProgressAtRevision >= 0 && h.lastProgressAtRevision <= state.revision);
      assert.ok(Number.isInteger(h.consecutiveNoProgressRounds) && h.consecutiveNoProgressRounds >= 0 && h.consecutiveNoProgressRounds <= state.revision - h.lastProgressAtRevision);
      assert.ok(h.recentOutcomes.length <= 10 && h.recentOutcomes.every(x => ['progress', 'no_result', 'unavailable', 'error', 'deferred', 'invalid_output'].includes(x)));
    }
    for (const gap of state.gaps) if (gap.humanRole !== undefined) {
      assert.equal(gap.kind, 'ambiguous_intent');
      assert.ok(['goal', 'priority', 'value', 'permission'].includes(gap.humanRole));
    }
    if (state.reflection) {
      assert.ok(state.reflection.reviewedClaimIds.every(id => state.claims.some(c => c.id === id)));
    }
    if (state.reflectionEffects) {
      const e = state.reflectionEffects;
      assert.ok(state.reflection);
      assert.deepEqual(e.binding, state.reflection.binding);
      assert.equal(e.appliedRevision, e.binding.basedRevision + 1);
      assert.ok(e.appliedRevision <= state.revision);
      assert.equal(new Set(e.addedGoalGapIds).size, e.addedGoalGapIds.length);
      assert.equal(new Set(e.addedLensIds).size, e.addedLensIds.length);
      assert.ok(e.addedGoalGapIds.every(id => state.gaps.some(g => g.id === id && g.importance === 'required' && g.triggerRefs.includes('task:goal'))));
      assert.ok(e.addedLensIds.every(id => state.lenses.some(l => l.id === id && l.origin === 'proposed')));
    }
  }
}

export function validateIntent(cases, intent) {
  assert.equal(intent.length, cases.length);
  assert.equal(new Set(intent.map(x => x.caseId)).size, cases.length);
  assert.deepEqual(intent.map(x => x.caseId).sort(), cases.map(x => x.caseId).sort());
  for (const row of intent) {
    assert.deepEqual(Object.keys(row).sort(), ['authorIntentAction', 'caseId', 'isControl', 'rationale']);
    assert.ok(actions.includes(row.authorIntentAction));
    assert.equal(typeof row.isControl, 'boolean');
    assert.ok(typeof row.rationale === 'string' && row.rationale.length > 0);
    if (row.isControl) {
      assert.ok(['proceed', 'check', 'reframe'].includes(row.authorIntentAction));
      const { state } = cases.find(x => x.caseId === row.caseId).input;
      assert.ok(state.probes.some(p => ['pending', 'running'].includes(p.status) && state.task.capabilities.includes(p.requiredCapability) && p.gapIds.some(id => state.gaps.some(g => g.id === id && g.kind === 'missing_fact' && g.status !== 'resolved'))), `${row.caseId}: executable objective probe`);
    }
  }
  for (const domain of new Set(cases.map(x => x.domain))) {
    const ids = new Set(cases.filter(x => x.domain === domain).map(x => x.caseId));
    const rows = intent.filter(x => ids.has(x.caseId));
    for (const action of actions) assert.equal(rows.filter(x => x.authorIntentAction === action).length, 4, `${domain}: author distribution ${action}`);
    for (const action of ['proceed', 'check', 'reframe']) assert.ok(rows.some(x => x.authorIntentAction === action && x.isControl), `${domain}: control coverage ${action}`);
  }
}
