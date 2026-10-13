import { assessmentDigest, TomboError, understandingHash } from './core.js';
import type { InspectionResult, UnderstandingState } from './types.js';

const labels = {
  ready_for_requested_step: '今回の証拠と範囲では、次の段階へ進む材料がある',
  needs_reflection: '現在の理解を再考する必要がある', needs_check: '追加の確認が必要', needs_user_input: '本人の条件の確認が必要', blocked: '必須の確認が残り、停止している',
};
const safe = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]<>#|]/g, '\\$&');
const known = (value: number | null, unit: string) => value === null ? '未取得' : `${value}${unit}`;

export function renderMarkdownReport(input: InspectionResult | UnderstandingState): string {
  const state = 'state' in input ? input.state : input;
  const changes = 'state' in input ? input.changes : [];
  const next = 'state' in input ? input.nextProbeIds : state.decision === 'needs_check' ? state.probes.filter(probe => probe.status === 'pending' && state.task.capabilities.includes(probe.requiredCapability)).slice(0, 3).map(probe => probe.id) : [];
  const lines = ['# TOMBO 検査レポート', '', `目的: ${safe(state.task.goal)}`, '', `判定: ${labels[state.decision]}`, ''];
  if (state.task.taskId === 'demo-account-close' || state.task.taskId === 'demo-event-resend') lines.push('固定の架空資料による再生デモ。検出能力の測定結果ではない。', '');
  if (state.stopReason) lines.push(`停止理由: ${safe(state.stopReason)}`, '');
  if (state.evidence.some(evidence => evidence.validity === 'current' && evidence.passageUnavailable)) lines.push('履歴の証拠本文は未取得。保存時の判定を表示している。再検証には本文の再取得が必要。', '');
  if (state.task.reflectionRequired || state.reflection) {
    const receipt = state.reflection;
    const fresh = receipt?.binding.understandingHash === understandingHash(state);
    const status = !receipt || !fresh ? '現在の理解への再考は未完了。' : receipt.completion === 'completed' ? '現在の理解への再考を完了した。' : '再考の結果は不明。';
    lines.push('## 理解の再考', '', status, '再考の完了は、意味の正しさや未知の不存在を保証しない。');
    for (const limitation of receipt?.limitations ?? []) lines.push(`- ${safe(limitation)}`);
    lines.push('');
  }
  lines.push('## 証拠で確かめたこと', '');
  const claims = state.claims.filter(claim => claim.status === 'supported' || claim.status === 'contradicted' || claim.status === 'disputed');
  for (const claim of claims) lines.push(`- ${safe(claim.text)} (${claim.status === 'supported' ? '支持' : claim.status === 'contradicted' ? '反証' : '証拠が対立'})。範囲: ${safe(claim.scope)}`);
  if (!claims.length) lines.push('現在の範囲で証拠により確かめた主張はまだない。');
  lines.push('', '## 目的に影響する未確認事項', '');
  const gaps = state.gaps.filter(gap => gap.importance === 'required' && gap.status !== 'resolved');
  for (const gap of gaps) lines.push(`- ${safe(gap.question)} ${safe(gap.whyItMatters)}`);
  if (!gaps.length) lines.push('今回取得した証拠と検査範囲では、追加の必須確認を検出しなかった。');
  const inconclusiveReasons: string[] = [];
  for (const claim of state.claims) {
    if (claim.role !== 'answer_claim') continue;
    const assessment = state.assessmentCorrections?.length
      ? claim.assessments.filter(item => !state.assessmentCorrections?.some(correction => correction.targetDigest === assessmentDigest(item))).at(-1)
      : claim.assessments.at(-1);
    if (assessment?.verdict !== 'inconclusive' || !assessment.scopeMatched) continue;
    const evidence = assessment.evidenceIds.map(id => state.evidence.find(item => item.id === id));
    if (!evidence.every(item => item?.validity === 'current' && item.scope === claim.scope)) continue;
    const saved = evidence.some(item => item?.passageUnavailable) ? '保存時の評価。本文未取得・未再検証。' : '';
    inconclusiveReasons.push(`- ${safe(claim.text)}。${saved}理由: ${safe(assessment.reason)}。参照証拠: ${assessment.evidenceIds.map(safe).join('、')}。範囲: ${safe(claim.scope)}`);
  }
  if (inconclusiveReasons.length) {
    lines.push('', '## 証拠評価の理由（不明）', '', '以下は回答の主張を確定できない評価理由であり、検証済みの事実として扱わない。', '', ...inconclusiveReasons);
  }
  if (state.assessmentCorrections?.length) {
    const verdicts = { supports: '支持', refutes: '反証', inconclusive: '不明' };
    lines.push('', '## 証拠の解釈の訂正', '', '以下はモデルの解釈の訂正履歴であり、訂正の意味的な正しさや事実確認を保証しない。証拠本文とその有効性はこの訂正では変更しない。', '');
    for (const correction of state.assessmentCorrections) {
      const claim = state.claims.find(item => item.id === correction.claimId);
      const before = claim?.assessments.find(item => assessmentDigest(item) === correction.targetDigest);
      const after = claim?.assessments.find(item => assessmentDigest(item) === correction.replacementDigest);
      if (!claim || !before || !after) throw new TomboError('invalid_input', 'Assessment correction history contains missing references.');
      const saved = correction.groundingEvidenceIds.some(id => state.evidence.find(item => item.id === id)?.passageUnavailable) ? '保存時の訂正履歴。本文未取得・未再検証。' : '';
      lines.push(`- ${safe(claim.text)}。${saved}訂正前: ${verdicts[before.verdict]}。${safe(before.reason)}。訂正後: ${verdicts[after.verdict]}。${safe(after.reason)}。訂正理由: ${safe(correction.reason)}。参照証拠: ${correction.groundingEvidenceIds.map(safe).join('、')}。`);
    }
  }
  lines.push('', '## 次に行う確認', '');
  for (const id of next) {
    const probe = state.probes.find(item => item.id === id);
    if (probe) lines.push(`- ${safe(probe.question)} 判定条件: ${safe(probe.successCondition)}`);
  }
  const questions = gaps.filter(gap => gap.kind === 'ambiguous_intent');
  for (const gap of questions) lines.push(`- 本人への質問: ${safe(gap.question)}`);
  if (!next.length && !questions.length) lines.push('実行可能な次の検査は選ばれていない。');
  lines.push('', '## 前回から変わった箇所', '');
  for (const change of changes) lines.push(`- ${safe(change.targetId)}: ${safe(change.before)} → ${safe(change.after)}。${safe(change.reason)}`);
  if (!changes.length) lines.push('このレポートに変更差分は渡されていない。');
  const optional = state.gaps.filter(gap => gap.importance === 'optional' && gap.status !== 'resolved');
  if (optional.length) { lines.push('', '## 残った任意の確認', ''); for (const gap of optional) lines.push(`- ${safe(gap.question)}`); }
  if (state.excludedCandidates?.length) {
    lines.push('', '## 上限により採用できなかった確認', '');
    for (const candidate of state.excludedCandidates) lines.push(`- ${safe(candidate.id)} (${candidate.importance === 'required' ? '必須' : '任意'})。${safe(candidate.reason)}`);
  }
  if (state.modelRepairDiagnostics?.length) {
    lines.push('', '## 提案の検証と訂正', '', '以下は提案を拒否した運用記録であり、証拠や未確認事項の解決を表さない。提案の採否は現在の状態で確認する。', '');
    for (const diagnostic of state.modelRepairDiagnostics) {
      lines.push(`- ${safe(diagnostic.operation)} の試行${diagnostic.rejectedAttempt}/${diagnostic.maxAttempts}を拒否。${safe(diagnostic.message)}`);
    }
  }
  lines.push('', '## 適用範囲と利用量', '', '判定は今回の目的、登録された証拠、明示された適用範囲に限る。外部操作の承認を代行しない。', '',
    `- 追加ラウンド: ${state.usage.rounds}`, `- モデル呼出し: ${state.usage.modelCalls}`, `- ツール呼出し: ${state.usage.toolCalls}`,
    `- 経過時間: ${state.usage.elapsedMs}ms`, `- 合計トークン: ${known(state.usage.totalTokens, '')}`, `- 費用: ${known(state.usage.costYen, '円')}`, '');
  return lines.join('\n');
}

export const renderReport = renderMarkdownReport;
