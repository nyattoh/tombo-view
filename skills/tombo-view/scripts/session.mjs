import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuration = resolve(skillRoot, 'references/runtime.json');
const configuredRoot = existsSync(configuration) ? JSON.parse(await readFile(configuration, 'utf8')).repositoryRoot : undefined;
const repositoryRoot = resolve(process.env.TOMBO_ROOT ?? configuredRoot ?? resolve(skillRoot, '../..'));
const sdk = await import(pathToFileURL(resolve(repositoryRoot, 'dist/index.js')).href);
const { createTombo, proposalSchema, reflectionOutputSchema, understandingHash, assessmentReferences, taskPacketSchema, observationsSchema, validateState, FileJournal, renderMarkdownReport, TomboError } = sdk;

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

async function main() {
  const { values, positionals } = parseArgs({ options: {
    input: { type: 'string' }, state: { type: 'string' }, observations: { type: 'string' },
    proposal: { type: 'string' }, out: { type: 'string' }, ledger: { type: 'string' }, operation: { type: 'string' },
  }, allowPositionals: true });
  const command = positionals[0];
  if (positionals.length !== 1 || !['prepare', 'inspect', 'update', 'reflect', 'report'].includes(command)) throw new TomboError('invalid_input', 'Use prepare, inspect, update, reflect or report.');
  if (values.operation && (command !== 'prepare' || values.operation !== 'reflect')) throw new TomboError('invalid_input', '--operation reflect is only valid for prepare.');
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
    const state = saved ? validateState(saved.state ?? saved) : null;
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
    if (state?.stopReason === 'invalid_model_output' && lastDiagnostic?.operation === operation) {
      const { code, message, rejectedAttempt, maxAttempts } = lastDiagnostic;
      request.validationFeedback = { code, message, rejectedAttempt, maxAttempts };
    }
    const binding = { schemaVersion: '0.1', operation, taskId: task.taskId, expectedRevision: state?.revision ?? -1, requestHash: digest(request) };
    if (values.ledger) await new FileJournal(values.ledger).assertCurrent(state);
    if (command === 'prepare') {
      output = `${JSON.stringify({ binding, request, instructions: operation === 'reflect' ? sdk.reflectionGuidance : sdk.proposalGuidance, proposalSchema: resolve(repositoryRoot, 'src/types.ts'), hostUsage: { totalTokens: null, costYen: null }, apiCallsMade: 0 }, null, 2)}\n`;
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
      output = `${JSON.stringify({ ...result, mode: 'host-assisted', apiCallsMade: 0, hostUsage: { totalTokens: null, costYen: null } }, null, 2)}\n`;
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
