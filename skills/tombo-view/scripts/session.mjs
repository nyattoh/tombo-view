import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SessionStore, canonicalPath, findSessionWorkspace, sameDirectoryIdentity, taskDigest } from './session-store.mjs';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuration = resolve(skillRoot, 'references/runtime.json');
const configuredRoot = existsSync(configuration) ? JSON.parse(await readFile(configuration, 'utf8')).repositoryRoot : undefined;
const repositoryRoot = resolve(process.env.TOMBO_ROOT ?? configuredRoot ?? resolve(skillRoot, '../..'));
const sdk = await import(pathToFileURL(resolve(repositoryRoot, 'dist/index.js')).href);
const { createTombo, proposalSchema, reflectionOutputSchema, understandingHash, assessmentReferences, assessmentScopeDiagnostics, taskPacketSchema, observationsSchema, stateSchema, validateState, FileJournal, renderMarkdownReport, TomboError } = sdk;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

async function json(path) {
  if (!path) throw new TomboError('invalid_input', 'A required input file is missing.');
  return JSON.parse(await readFile(path, 'utf8'));
}

function proposalFeedback(state, operation) {
  const rejection = state?.lastProposalRejection;
  if (rejection) {
    const collections = { gap: state.gaps, claim: state.claims, probe: state.probes, lens: state.lenses };
    if (state.stopReason !== 'invalid_model_output' || rejection.operation !== operation || rejection.taskId !== state.taskId || rejection.atRevision !== state.revision || rejection.understandingHash !== understandingHash(state) || rejection.target && !collections[rejection.target.kind].some(item => item.id === rejection.target.id)) return undefined;
    const messages = {
      resolution_not_justified: 'The proposed resolution is not justified by the current evidence.',
      reflection_binding_mismatch: 'The reflection does not match the current understanding binding.',
      reflection_claim_coverage_mismatch: 'The reflection must review the current claims without unknown references.',
      proposal_validation_failed: 'The proposal failed SDK validation. Check the current state and references.',
    };
    const message = messages[rejection.kind] + (rejection.target ? ` Target ${rejection.target.kind}: ${rejection.target.id}.` : '');
    return { code: 'invalid_model_output', message, rejectedAttempt: rejection.rejectedAttempt, maxAttempts: rejection.maxAttempts };
  }
  const previous = state?.modelRepairDiagnostics?.at(-1);
  if (state?.stopReason === 'invalid_model_output' && previous?.operation === operation) {
    const { code, message, rejectedAttempt, maxAttempts } = previous;
    return { code, message, rejectedAttempt, maxAttempts };
  }
  return undefined;
}

async function managed(command, values, workspace) {
  const store = new SessionStore(workspace, sdk);
  const cwdMatchesWorkspace = process.platform === 'win32'
    ? await sameDirectoryIdentity(process.cwd(), store.workspace)
    : await canonicalPath(process.cwd()) === store.workspace;
  if (!cwdMatchesWorkspace) throw new TomboError('revision_conflict', 'Return to the fixed activated workspace. A child directory cannot create another binding.');
  await store.withLock(async () => {
    await store.load();
    if (command === 'activate') {
      await store.activate(await json(values.input), values.ledger, values.out, values['task-clock'] !== undefined ? await json(values['task-clock']) : undefined);
      await store.checkpoint('reflect');
      process.stdout.write(`${JSON.stringify(managedResult(store), null, 2)}\n`);
      return;
    }
    if (!store.snapshot) throw new TomboError('invalid_input', 'Activate this workspace before status, receive or transition.');
    await store.reconcile();
    if (['status', 'receive'].includes(command)) {
      if (values.ledger || values.out) await store.guard({ ...values, ledger: values.ledger ?? store.snapshot.binding.ledger });
      if (command === 'receive') await store.receive(await json(values.input));
      await loadManagedState(store);
      await store.checkpoint(store.view().pendingUpdates.length ? 'update' : 'reflect');
      const result = managedResult(store);
      if (store.state) await store.writeCache(store.snapshot.binding.statePath, result);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (command === 'transition') {
      await store.checkpoint('reflect');
      await store.transition(await json(values.input), values.ledger, values.out, values['task-clock'] !== undefined ? await json(values['task-clock']) : undefined);
      process.stdout.write(`${JSON.stringify(managedResult(store), null, 2)}\n`);
      return;
    }
    if (command === 'invalidate') {
      await store.guard(values, { existing: true });
      if (values.proposal || values.observations || values.receipt) throw new TomboError('invalid_input', 'Managed invalidate uses only --input, --state, --ledger and --out.');
      await loadManagedState(store, values.state);
      const invalidation = store.invalidation(await json(values.input));
      const checkpoint = await store.checkpoint('reflect');
      if (store.snapshot.taskClockStop || checkpoint?.budgetCheckpoint.exhausted || checkpoint?.budgetCheckpoint.accountingUnavailable || store.snapshot.accountingUncertain) return pendingInvalidation(store, invalidation);
      const before = store.state;
      const result = createTombo({ adapter: { async generate() { throw new TomboError('invalid_input', 'Invalidate never generates a proposal.'); } } }).invalidate(before, invalidation);
      const finalCheckpoint = await store.checkpoint('reflect');
      if (store.snapshot.taskClockStop || finalCheckpoint?.budgetCheckpoint.exhausted || finalCheckpoint?.budgetCheckpoint.accountingUnavailable || store.snapshot.accountingUncertain) return pendingInvalidation(store, invalidation);
      await store.begin('invalidate', { invalidation, previousStopReason: before.stopReason, discardedExecutionIds: (before.pendingAssessmentExecutionIds ?? []).filter(id => !result.state.pendingAssessmentExecutionIds?.includes(id)) });
      await store.commit(result.state);
      const output = { ...result, ...(store.state.stopReason ? { nextProbeIds: [], userQuestions: [] } : {}), ...managedResult(store) };
      await store.writeCache(store.snapshot.binding.statePath, output);
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    const operation = command === 'reflect' || values.operation === 'reflect' ? 'reflect' : command === 'inspect' ? 'inspect' : command === 'update' || values.state || store.state ? 'update' : 'inspect';
    if (command !== 'prepare' && command !== 'report' && command !== operation) throw new TomboError('invalid_input', 'Command and input kind do not match.');
    await store.guard(values, { existing: command !== 'report' && operation !== 'inspect', inspect: operation === 'inspect' && command !== 'report' });
    if (['prepare', 'report'].includes(command) && values.out) throw new TomboError('invalid_input', 'Managed prepare/report write to stdout. Preserve the bound SDK state cache.');
    if (command === 'report') {
      await loadManagedState(store, values.state);
      await store.checkpoint(store.view().pendingUpdates.length ? 'update' : 'reflect');
      const result = managedResult(store);
      await store.writeCache(store.snapshot.binding.statePath, result);
      process.stdout.write(managedReport(result));
      return;
    }
    if (operation !== 'inspect' && values.input) throw new TomboError('invalid_input', 'Use either --input or --state, not both.');
    if (operation === 'reflect' && values.observations) throw new TomboError('invalid_input', 'Reflection accepts no observations.');
    if (store.state) await loadManagedState(store, values.state);
    const task = store.state?.task ?? taskPacketSchema.parse(await json(values.input));
    if (taskDigest(task) !== store.snapshot.binding.taskHash) throw new TomboError('revision_conflict', 'The TaskPacket does not match the activated goal and budget.');
    const observations = operation === 'update' ? observationsSchema.parse(await json(values.observations)) : undefined;
    const receiptIds = values.receipt ?? [];
    if (receiptIds.length && operation !== 'update') throw new TomboError('invalid_input', '--receipt is only valid for update or its prepare.');
    if (observations) {
      const executions = store.executionMap();
      for (const observation of observations) if (executions.has(observation.executionId) && executions.get(observation.executionId) !== digest(observation)) throw new TomboError('invalid_input', `Execution payload collision ${observation.executionId}`);
      store.validateReceipts(receiptIds, observations);
    }
    const checkpoint = await store.checkpoint(operation === 'inspect' ? 'reflect' : operation);
    if (store.snapshot.taskClockStop || checkpoint?.budgetCheckpoint.exhausted || checkpoint?.budgetCheckpoint.accountingUnavailable) {
      await retainExpiredObservations(store, observations);
      const result = managedResult(store);
      if (store.state) await store.writeCache(store.snapshot.binding.statePath, result);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (store.snapshot.accountingUncertain) throw new TomboError('revision_conflict', 'Interrupted generation or clock regression has uncertain consumption. Preserve the session and recover explicitly.');
    const state = store.state;
    const lastDiagnostic = state?.modelRepairDiagnostics?.at(-1);
    if (operation === 'update' && state?.revision === 1 && state.stopReason === 'invalid_model_output' && lastDiagnostic?.operation === 'inspect' && !state.pendingAssessmentExecutionIds?.length && !state.claims.length && !state.probes.length) throw new TomboError('invalid_input', 'Failed inspect resume is unsupported. Preserve its state and usage.');
    if (state?.pendingAssessmentExecutionIds?.length && operation === 'update') {
      const pending = state.pendingAssessmentExecutionIds;
      const supplied = new Map(observations.map(item => [item.executionId, item]));
      const executions = new Map(state.appliedExecutions.map(item => [item.executionId, item.payloadHash]));
      if (supplied.size !== pending.length || !pending.every(id => supplied.has(id) && digest(supplied.get(id)) === executions.get(id))) throw new TomboError('invalid_input', 'Redeliver the exact pending assessment batch with unchanged execution IDs and payloads.');
    }
    const request = operation === 'reflect' ? { operation, task, state, binding: { taskId: task.taskId, basedRevision: state.revision, understandingHash: understandingHash(state) }, maxOutputTokens: task.budget.maxOutputTokensPerCall } : state ? { state, observations } : { task };
    if (state) request.assessmentReferences = assessmentReferences(state);
    const feedback = proposalFeedback(state, operation);
    if (feedback) request.validationFeedback = feedback;
    const binding = { schemaVersion: '0.1', operation, taskId: task.taskId, expectedRevision: state?.revision ?? -1, requestHash: digest(request), sessionId: store.snapshot.binding.sessionId };
    if (command === 'prepare') {
      const reminder = '\n\n実回答・新情報を既存gapと対象claimへ結び付け、十分な根拠だけでassessment・resolutionを提案し、不十分なら残る確認を保持する。結論を左右する引用が確立する範囲と追加の仮定を分け、引用した事実が全て真でも結論が偽になる条件がないか再考する。過去の過剰なsupportsはlimitationsだけで済ませず、既存assessmentCorrections・inconclusive・gapや条件付き説明へ根拠に応じて反映する。重要な変更後はneeds_user_inputでも許可・予算・評価待ちが許す範囲で現在の理解を再考する。条件付き応答・意味の確実性・SDK段階完了を区別する。同goalのSDK予算・封印済み期限を延長する機能はない。';
      process.stdout.write(`${JSON.stringify({ binding, request, assessmentScopeDiagnostics: state ? assessmentScopeDiagnostics(state) : [], instructions: (operation === 'reflect' ? sdk.reflectionGuidance : sdk.proposalGuidance) + reminder, proposalSchema: resolve(repositoryRoot, 'src/types.ts'), ...managedResult(store) }, null, 2)}\n`);
      return;
    }
    const envelope = await json(values.proposal);
    if (!envelope.binding || canonical(envelope.binding) !== canonical(binding)) throw new TomboError('revision_conflict', 'Prepare the proposal against this exact activated session, task, state and observations.');
    const proposal = operation === 'reflect' ? undefined : proposalSchema.parse(envelope.proposal);
    const reflection = operation === 'reflect' ? reflectionOutputSchema.parse(envelope.reflection) : undefined;
    if (reflection && canonical(reflection.binding) !== canonical(request.binding)) throw new TomboError('revision_conflict', 'The reflection binding does not match the current understanding.');
    const finalCheckpoint = await store.checkpoint(operation);
    if (store.snapshot.taskClockStop || finalCheckpoint?.budgetCheckpoint.exhausted || finalCheckpoint?.budgetCheckpoint.accountingUnavailable || store.snapshot.accountingUncertain) {
      await retainExpiredObservations(store, observations);
      const stopped = managedResult(store);
      if (store.state) await store.writeCache(store.snapshot.binding.statePath, stopped);
      process.stdout.write(`${JSON.stringify(stopped, null, 2)}\n`);
      return;
    }
    const tombo = createTombo({ captureProposalRejection: true, adapter: { async generate() { return { proposal, usage: { totalTokens: null, outputTokens: 0, costYen: null }, model: 'host-authored-proposal' }; } } });
    await store.begin(operation, null, receiptIds);
    const result = operation === 'reflect' ? await tombo.reflect(state, { async reflect(input) {
      if (canonical(input.binding) !== canonical(reflection.binding)) throw new TomboError('revision_conflict', 'Reflection operation mismatch.');
      return { ...reflection, usage: { totalTokens: null, outputTokens: 0, costYen: null }, model: reflection.model ?? 'host-authored-reflection' };
    } }) : operation === 'update' ? await tombo.update(state, observations) : await tombo.inspect(task);
    await store.commit(result.state);
    const output = { ...result, ...managedResult(store) };
    await store.writeCache(store.snapshot.binding.statePath, output);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (result.state.stopReason && ['invalid_input', 'invalid_model_output', 'budget_accounting_unavailable', 'passage_unavailable', 'input_too_large', 'model_error', 'model_timeout'].includes(result.state.stopReason)) process.exitCode = 1;
  });
}

async function loadManagedState(store, explicitPath) {
  if (!store.state) return;
  const path = explicitPath ?? store.snapshot.binding.statePath;
  try {
    const saved = await json(path), state = stateSchema.parse(saved.state ?? saved);
    await new FileJournal(store.snapshot.binding.ledger).assertCurrent(state);
    store.state = state;
  } catch (error) { if (explicitPath) throw error; }
}

async function retainExpiredObservations(store, observations) {
  if (!observations?.length) return;
  const id = `unassessed-apply-${digest(observations)}`;
  const receivedAt = store.snapshot.updates.find(item => item.id === id)?.source.receivedAt ?? new Date().toISOString();
  await store.receive({ id, source: { kind: 'tool', locator: 'helper:update', receivedAt }, text: 'Observations were supplied but evaluation was not performed.', observations });
}

async function pendingInvalidation(store, invalidation) {
  const id = `unassessed-invalidate-${digest(invalidation)}`;
  const receivedAt = store.snapshot.updates.find(item => item.id === id)?.source.receivedAt ?? new Date().toISOString();
  await store.receive({ id, source: { kind: 'tool', locator: 'helper:invalidate', receivedAt }, text: `撤回申告は未適用: ${invalidation.reason}。対象: ${invalidation.evidenceIds.join('、')}`, references: [...new Set(invalidation.evidenceIds.map(id => store.state.evidence.find(item => item.id === id).locator))], observations: [], invalidation });
  const output = managedResult(store);
  await store.writeCache(store.snapshot.binding.statePath, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function managedResult(store) {
  const session = store.view(), state = store.state;
  const taskClockStatus = store.clockStatus(), sessionStopReason = session.taskClockStop ?? null;
  const effectiveDecision = taskClockStatus.expired || session.accountingUncertain || store.budgetCheckpoint?.exhausted || store.budgetCheckpoint?.accountingUnavailable || (state?.decision === 'blocked' && state.stopReason) ? 'blocked' : session.pendingUpdates.length ? 'needs_check' : state?.decision ?? 'blocked';
  const requiredGapIds = state?.gaps.filter(gap => gap.importance === 'required' && gap.status !== 'resolved').map(gap => gap.id) ?? [];
  const reflection = state?.reflection;
  const currentReflection = reflection && reflection.binding.taskId === state.taskId && reflection.binding.understandingHash === understandingHash(state) && reflection.reviewedClaimIds.length === state.claims.length && state.claims.every(claim => reflection.reviewedClaimIds.includes(claim.id));
  const reflectionStatus = !state ? 'unavailable' : !state.task.reflectionRequired ? 'not_required' : !reflection ? 'missing' : !currentReflection ? 'stale' : reflection.completion;
  const canReportCompletion = !!state && effectiveDecision === 'ready_for_requested_step' && !requiredGapIds.length && !state.pendingAssessmentExecutionIds?.length && !session.pendingUpdates.length && !session.accountingUncertain && ['completed', 'not_required'].includes(reflectionStatus);
  return { mode: 'activated-session', state, session, effectiveDecision, taskClockStatus, sessionStopReason, understandingStatus: { requiredGapIds, reflectionStatus, canReportCompletion }, budgetCheckpoint: store.budgetCheckpoint ?? null, assessmentScopeDiagnostics: state ? assessmentScopeDiagnostics(state) : [], apiCallsMade: 0, hostUsage: { totalTokens: null, costYen: null } };
}

function managedReport(result) {
  const safe = value => String(value).replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]<>#|]/g, '\\$&');
  const lines = ['# TOMBO activated session', '', `session: ${safe(result.session.binding.sessionId)}`, `今回の継続判定: ${safe(result.effectiveDecision)}`, `未解決の必須確認: ${result.understandingStatus.requiredGapIds.map(safe).join('、') || 'なし'}`, `現在の理解への再考: ${result.understandingStatus.reflectionStatus}`, `SDKの今回の段階の完了を報告可能: ${result.understandingStatus.canReportCompletion ? 'はい' : 'いいえ'}`, 'これは意味の正しさ・外部操作の許可・利用者の目的全体の完了を保証しない。', '', '## Task clock', '', `計時範囲: ${safe(result.taskClockStatus.coverage)}。開始: ${safe(result.taskClockStatus.startedAt ?? 'unknown')}。期限: ${safe(result.taskClockStatus.deadlineAt ?? 'unknown')}。観測: ${safe(result.taskClockStatus.observedAt)}。期限超過: ${result.taskClockStatus.expired ?? 'unknown'}。`, `出典: ${safe(result.session.taskClock?.sourceRef ?? 'unknown')}。session停止: ${safe(result.sessionStopReason?.reason ?? 'なし')}。SDK停止: ${safe(result.state?.stopReason ?? 'なし')}。`, 'helper呼出し境界での計測・停止であり、未知の原開始、host処理の即時中断やOS期限を保証しない。同goalの予算・期限延長機能はない。', '', '## 旧理解のスナップショット', '', '以下はSDKに評価済みの範囲であり、最新追補の評価完了を表さない。', '', result.state ? renderMarkdownReport(result.state) : 'SDK理解スナップショットは未生成（初回検査前）。', '', '## 受領済み・未評価', ''];
  for (const update of result.session.pendingUpdates) lines.push(`- ${safe(update.id)}: ${safe(update.text ?? update.references.join('、'))}。出典: ${safe(update.source.locator)}。評価は未実施。`);
  if (!result.session.pendingUpdates.length) lines.push('未評価の追補はない。');
  if (result.session.discardedUpdates.length) {
    lines.push('', '## 評価せず破棄した観測', '', '以下は実評価済みではない。撤回で評価待ちが破棄された履歴であり、現在の理解の支持根拠へ昇格しない。');
    for (const update of result.session.discardedUpdates) lines.push(`- ${safe(update.id)}。execution: ${update.discardedAssessment.executionIds.map(safe).join('、')}。破棄revision: ${update.discardedAssessment.atRevision}。appliedRevision: null。`);
  }
  if (result.session.updates.length) {
    lines.push('', '## 受領時刻と出典日時', '', 'helper実受領時刻はローカルOS時計で観測した受理時刻。host配達時刻や単調な予算時計ではない。caller申告時刻は未検証。証拠取得日時は証拠の出典情報である。');
    for (const update of result.session.updates) {
      lines.push(`- ${safe(update.id)}。helper実受領時刻: ${safe(update.helperReceivedAt ?? 'unknown')}。caller申告時刻: ${safe(update.source.receivedAt ?? 'unknown')}。`);
      if (!update.helperReceivedAt) lines.push('  - helper時刻が不明のためcaller日時との比較はunknown。');
      else if (update.source.receivedAt !== undefined && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(update.source.receivedAt)) lines.push('  - caller日時のtimezoneが不明のため比較はunknown。');
      else if (Date.parse(update.source.receivedAt) > Date.parse(update.helperReceivedAt) + 5000) lines.push('  - 保存済みhelper実受領時刻との不整合: caller日時が5000msの許容幅を超えて未来を指す。原記録は変更しない。');
      for (const observation of update.observations) for (const evidence of observation.evidence) lines.push(`  - ${safe(evidence.id)}。Evidence.retrievedAt: ${safe(evidence.retrievedAt)}。`);
    }
  }
  lines.push('', `SDK未計上の実ツール呼出し: ${result.session.pendingUsage.toolCalls}`, `未計上費用: ${result.session.pendingUsage.costYen ?? 'unknown'}`, '会話側の費用・tokenはunknown。受領は証拠評価や外部操作の許可を意味しない。');
  if (result.session.accountingUncertain) lines.push('中断または時刻逆行により消費は未確定。再生成・再初期化を行わず、明示的な復旧が必要。');
  for (const transition of result.session.transitions) lines.push('', `旧task: ${safe(transition.previous.taskId)}。旧停止: ${safe(transition.previous.stopReason ?? 'なし')}。旧利用量: ${safe(JSON.stringify(transition.previous.usage))}。未知: ${safe(transition.previous.unknowns.join('、'))}。未評価破棄の履歴: ${transition.previous.discardedUpdates?.length ?? 0}件。新taskの予算は旧taskの継続予算ではない。`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    input: { type: 'string' }, state: { type: 'string' }, observations: { type: 'string' },
    proposal: { type: 'string' }, out: { type: 'string' }, ledger: { type: 'string' }, operation: { type: 'string' }, receipt: { type: 'string', multiple: true },
    'task-clock': { type: 'string' },
  }, allowPositionals: true });
  const command = positionals[0];
  if (positionals.length !== 1 || !['activate', 'status', 'receive', 'transition', 'invalidate', 'prepare', 'inspect', 'update', 'reflect', 'report'].includes(command)) throw new TomboError('invalid_input', 'Use activate, status, receive, transition, invalidate, prepare, inspect, update, reflect or report.');
  if (values.operation && (command !== 'prepare' || values.operation !== 'reflect')) throw new TomboError('invalid_input', '--operation reflect is only valid for prepare.');
  if (values['task-clock'] !== undefined && !['activate', 'transition'].includes(command)) throw new TomboError('invalid_input', '--task-clock is only valid for activate or a legitimate transition.');
  const workspace = findSessionWorkspace(process.cwd());
  if (workspace || ['activate', 'status', 'receive', 'transition'].includes(command)) return managed(command, values, workspace ?? process.cwd());
  if (command === 'invalidate') throw new TomboError('invalid_input', 'invalidate requires an activated session.');
  if (values.receipt) throw new TomboError('invalid_input', '--receipt requires an activated session.');
  if (values.ledger && values.out) new FileJournal(values.ledger, values.out);
  let output;
  if (command === 'report') {
    const saved = await json(values.state);
    const state = validateState(saved.state ?? saved);
    const result = sdk.inspectionResultSchema.parse({ state, changes: saved.changes ?? [], nextProbeIds: saved.nextProbeIds ?? [], userQuestions: saved.userQuestions ?? [] });
    output = renderMarkdownReport(result) + '\n会話内モード。ヘルパーによる追加API呼出しは0件。SDKのモデル呼出し数はローカル提案適用回数で、会話側の生成トークン数・費用・生成時間は別途不明である。\n';
  } else {
    const operation = command === 'reflect' || values.operation === 'reflect' ? 'reflect' : values.state ? 'update' : 'inspect';
    if (command !== 'prepare' && command !== operation) throw new TomboError('invalid_input', 'Command and input kind do not match.');
    if (operation !== 'inspect' && values.input) throw new TomboError('invalid_input', 'Use either --input or --state, not both.');
    if (operation === 'reflect' && (!values.state || values.observations)) throw new TomboError('invalid_input', 'Reflection requires --state and accepts no --observations.');
    const saved = operation !== 'inspect' ? await json(values.state) : null;
    const shaped = operation !== 'inspect' ? stateSchema.safeParse(saved?.state ?? saved) : null;
    if (shaped && !shaped.success) throw new TomboError('invalid_input', 'Invalid state shape.');
    const state = shaped?.data ?? null;
    if (values.ledger) await new FileJournal(values.ledger).assertCurrent(state);
    if (state) {
      if (command === 'prepare' && !values.ledger) {
        // Preparation binds the supplied snapshot; execution validates policy metadata after journal authority.
        const structural = { ...state };
        delete structural.policyHistory;
        delete structural.reflectionEffects;
        validateState(structural);
      } else validateState(state);
    }
    const task = state?.task ?? taskPacketSchema.parse(await json(values.input));
    const lastDiagnostic = state?.modelRepairDiagnostics?.at(-1);
    if (operation === 'update' && state?.revision === 1 && state.stopReason === 'invalid_model_output' && lastDiagnostic?.operation === 'inspect' && !state.pendingAssessmentExecutionIds?.length && !state.claims.length && !state.probes.length) {
      throw new TomboError('invalid_input', 'Failed inspect resume is unsupported. Preserve its state and usage; do not reset it into a new inspect.');
    }
    const observations = operation === 'update' ? observationsSchema.parse(await json(values.observations)) : undefined;
    if (operation === 'update' && state.pendingAssessmentExecutionIds?.length) {
      const pending = state.pendingAssessmentExecutionIds;
      const supplied = new Map(observations.map(observation => [observation.executionId, observation]));
      const applied = new Map(state.appliedExecutions.map(execution => [execution.executionId, execution.payloadHash]));
      if (supplied.size !== pending.length || !pending.every(id => supplied.has(id) && digest(supplied.get(id)) === applied.get(id))) {
        throw new TomboError('invalid_input', 'Redeliver the exact pending assessment batch with unchanged execution IDs and payloads.');
      }
    }
    const request = operation === 'reflect' ? { operation, task, state, binding: { taskId: task.taskId, basedRevision: state.revision, understandingHash: understandingHash(state) }, maxOutputTokens: task.budget.maxOutputTokensPerCall } : state ? { state, observations } : { task };
    if (state) request.assessmentReferences = assessmentReferences(state);
    const feedback = proposalFeedback(state, operation);
    if (feedback) request.validationFeedback = feedback;
    const binding = { schemaVersion: '0.1', operation, taskId: task.taskId, expectedRevision: state?.revision ?? -1, requestHash: digest(request) };
    if (command === 'prepare') {
      output = `${JSON.stringify({ binding, request, assessmentScopeDiagnostics: state ? assessmentScopeDiagnostics(state) : [], instructions: operation === 'reflect' ? sdk.reflectionGuidance : sdk.proposalGuidance, proposalSchema: resolve(repositoryRoot, 'src/types.ts'), hostUsage: { totalTokens: null, costYen: null }, apiCallsMade: 0 }, null, 2)}\n`;
    } else {
      const envelope = await json(values.proposal);
      if (!envelope.binding || canonical(envelope.binding) !== canonical(binding)) throw new TomboError('revision_conflict', 'The proposal does not match this exact task, state and observations. Prepare it again.');
      const proposal = operation === 'reflect' ? undefined : proposalSchema.parse(envelope.proposal);
      const reflection = operation === 'reflect' ? reflectionOutputSchema.parse(envelope.reflection) : undefined;
      if (reflection && canonical(reflection.binding) !== canonical(request.binding)) throw new TomboError('revision_conflict', 'The reflection does not match the exact understanding revision and hash.');
      const tombo = createTombo({ adapter: {
        async generate(input) {
          if (input.operation !== operation || input.task.taskId !== task.taskId) throw new TomboError('invalid_input', 'Proposal operation mismatch.');
          return { proposal, usage: { totalTokens: null, outputTokens: 0, costYen: null }, model: 'host-authored-proposal' };
        },
      } });
      const result = operation === 'reflect' ? await tombo.reflect(state, { async reflect(input) {
        if (canonical(input.binding) !== canonical(reflection.binding)) throw new TomboError('revision_conflict', 'Reflection operation mismatch.');
        return { ...reflection, usage: { totalTokens: null, outputTokens: 0, costYen: null }, model: reflection.model ?? 'host-authored-reflection' };
      } }) : state ? await tombo.update(state, observations) : await tombo.inspect(task);
      if (values.ledger && result.state.revision !== binding.expectedRevision) await new FileJournal(values.ledger).commit(binding.expectedRevision, result.state);
      output = `${JSON.stringify({ ...result, assessmentScopeDiagnostics: assessmentScopeDiagnostics(result.state), mode: 'host-assisted', apiCallsMade: 0, hostUsage: { totalTokens: null, costYen: null } }, null, 2)}\n`;
      if (result.state.stopReason && ['invalid_input', 'invalid_model_output', 'budget_accounting_unavailable', 'passage_unavailable', 'input_too_large', 'model_error', 'model_timeout'].includes(result.state.stopReason)) process.exitCode = 1;
    }
  }
  if (values.out) {
    await mkdir(dirname(values.out), { recursive: true });
    await writeFile(values.out, output, 'utf8');
  } else process.stdout.write(output);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: { code: error instanceof TomboError ? error.code : 'invalid_input', message: error.message } })}\n`);
  process.exitCode = 1;
});
