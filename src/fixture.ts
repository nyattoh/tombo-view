import { TomboError } from './core.js';
import type { GenerationAdapter, GenerationInput, Proposal } from './types.js';

export const FIXTURE_CASES = {
  account: {
    taskId: 'demo-account-close', goal: '架空アカウントの CLOSE 409 の原因を確認し、次の確認を選ぶ。',
    scope: 'synthetic-account-v1', capability: 'read_document', probeId: 'p-account-contract',
    passage: '架空規約 v1: CLOSE 409 は未完了の契約がある場合に返る。契約を完了または解約してから再度閉鎖する。',
    proposedAnswer: '同じ閉鎖手順を再度実行すればよい。',
    conclusion: 'この架空規約では CLOSE 409 の原因は未完了の契約である。',
    question: '実行済みの閉鎖手順で CLOSE 409 が返る条件は何か。',
    method: 'dependency' as const,
  },
  event: {
    taskId: 'demo-event-resend', goal: '架空イベント処理が再送時に重複しないか確認する。',
    scope: 'synthetic-event-v1', capability: 'run_test', probeId: 'p-event-resend',
    passage: '架空テスト v1: 同じイベント evt-1 を2回送信すると処理が2回行われ、重複処理が発生した。',
    proposedAnswer: 'この処理は再送時にも重複しない。',
    conclusion: 'この架空テストではイベント再送によって重複処理が発生する。',
    question: '同じイベントを再送すると重複処理が発生するか。',
    method: 'counterexample' as const,
  },
} as const;

function fixture(input: GenerationInput): Proposal {
  const entry = Object.values(FIXTURE_CASES).find(item => item.taskId === input.task.taskId && item.goal === input.task.goal);
  if (!entry || (input.task.proposedAnswer !== undefined && input.task.proposedAnswer !== entry.proposedAnswer)) {
    throw new TomboError('unsupported_fixture', 'Fixed synthetic replay supports only the documented demo task and draft');
  }
  const suffix = entry === FIXTURE_CASES.account ? 'account' : 'event';
  const claimId = `c-${suffix}-conclusion`;
  const draftId = `c-${suffix}-draft`;
  const gapId = `g-${suffix}-condition`;
  if (input.operation === 'inspect') return {
    claims: [
      { id: claimId, role: 'hypothesis', text: entry.conclusion, scope: entry.scope },
      { id: draftId, role: 'answer_claim', text: entry.proposedAnswer, scope: entry.scope },
    ],
    lenses: [{ id: `l-${suffix}`, label: '架空資料の適用条件', rationale: '固定の再生デモで回答案の前提を確認する。', origin: 'initial', status: 'active' }],
    gaps: [{ id: gapId, kind: 'unsupported_claim', lensId: `l-${suffix}`, question: entry.question,
      triggerRefs: [draftId, 'task:goal'], whyItMatters: '回答案が依存する条件を固定資料で確かめる必要がある。', importance: 'required', claimIds: [claimId], probeIds: [entry.probeId] }],
    probes: [{ id: entry.probeId, gapIds: [gapId], method: entry.method, question: entry.question,
      requiredCapability: entry.capability, sourceGroups: [`fixture-${suffix}-v1`], successCondition: '文書化された固定の資料本文と適用範囲が一致する。',
      refutationCondition: '同じ対象と条件で異なる結果を示す証拠がある。', inconclusiveCondition: '本文、適用範囲、結果が固定資料と一致しない。' }],
  };
  const evidence = input.observations?.filter(observation => observation.probeId === entry.probeId && observation.outcome === 'completed')
    .flatMap(observation => observation.evidence)
    .filter(item => item.validity === 'current' && !item.passageUnavailable && item.scope === entry.scope && item.passage === entry.passage) ?? [];
  if (!evidence.length) return {};
  const evidenceIds = [...new Set(evidence.map(item => item.id))];
  return {
    assessments: [
      { claimId, evidenceIds, verdict: 'supports', scopeMatched: true, reason: '固定の架空本文と適用範囲が完全一致した。' },
      { claimId: draftId, evidenceIds, verdict: 'refutes', scopeMatched: true, reason: '固定資料は、この再生デモの回答案と両立しない条件を示した。' },
    ],
    resolutions: [{ gapId, reason: 'supported', evidenceIds, explanation: '固定の架空資料により、このデモで必要な条件を確認した。' }],
  };
}

export const fixtureAdapter: GenerationAdapter = {
  estimateMaxCostYen: () => 0,
  async generate(input) {
    return { proposal: fixture(input), usage: { totalTokens: 0, outputTokens: 0, costYen: 0 }, model: 'synthetic-fixed-replay-v1' };
  },
};
