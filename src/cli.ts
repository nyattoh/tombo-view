#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createTombo, fixtureAdapter, renderMarkdownReport, TomboError, validateState, stateSchema } from './index.js';
import type { CriticAdapter, GenerationAdapter } from './index.js';
import { FileJournal, replayJournal } from './journal.js';

const help = `TOMBO v0.1
tombo inspect --input task.json --adapter fixture --out state.json [--ledger events.jsonl] [--model-repair-attempts 0|1|2]
tombo update --state state.json --observations observations.json --adapter fixture --out next.json [--ledger events.jsonl] [--model-repair-attempts 0|1|2]
tombo reflect --state state.json --critic file:/absolute/path/critic.mjs --out next.json [--ledger events.jsonl] [--model-repair-attempts 0|1|2]
tombo invalidate --state state.json --input invalidation.json --out next.json [--ledger events.jsonl]
tombo report --state state.json --format markdown --out report.md
tombo replay --ledger events.jsonl --out restored-state.json
Generation adapters must be explicitly selected: fixture or file:/absolute/path/adapter.mjs.
Reflection requires an explicit critic module exporting default or critic with reflect().
Model repair defaults to 0; 1 or 2 permits additional validation corrections within the original budget.
fixture is synthetic replay, not an evaluation of detection ability.
`;

async function readJson(path: string | undefined): Promise<unknown> {
  if (!path) throw new TomboError('invalid_input', 'A required file option is missing.');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new TomboError('invalid_input', `Cannot read JSON from ${path}.`);
  }
}

async function loadAdapter(name: string | undefined): Promise<GenerationAdapter> {
  if (name === 'fixture') return fixtureAdapter;
  if (name?.startsWith('file:')) {
    const module = await import(pathToFileURL(resolve(name.slice(5))).href);
    const adapter: GenerationAdapter = module.default ?? module.adapter;
    if (!adapter || typeof adapter.generate !== 'function') throw new TomboError('invalid_input', 'The module must export an adapter with generate().');
    return adapter;
  }
  throw new TomboError('invalid_input', 'Select --adapter fixture or --adapter file:/path/adapter.mjs explicitly.');
}

async function loadCritic(name: string | undefined): Promise<CriticAdapter> {
  if (!name?.startsWith('file:') || !name.slice(5)) throw new TomboError('invalid_input', 'Select --critic file:/path/critic.mjs explicitly.');
  const module = await import(pathToFileURL(resolve(name.slice(5))).href);
  const critic: CriticAdapter = module.default ?? module.critic;
  if (!critic || typeof critic.reflect !== 'function') throw new TomboError('invalid_input', 'The module must export a critic with reflect().');
  return critic;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    input: { type: 'string' }, state: { type: 'string' }, observations: { type: 'string' },
    adapter: { type: 'string' }, critic: { type: 'string' }, out: { type: 'string' }, ledger: { type: 'string' },
    'model-repair-attempts': { type: 'string' }, format: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  }, allowPositionals: true });
  if (values.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  if (positionals.length !== 1) throw new TomboError('invalid_input', 'Specify one command.');
  if (values.out && values.ledger) new FileJournal(values.ledger, values.out);
  const command = positionals[0];
  const repairOption = values['model-repair-attempts'];
  if (repairOption !== undefined && (!['inspect', 'update', 'reflect'].includes(command) || !/^[012]$/.test(repairOption))) {
    throw new TomboError('invalid_input', '--model-repair-attempts must be 0, 1 or 2 and is only valid for inspect, update or reflect.');
  }
  const maxModelRepairAttempts = repairOption === undefined ? 0 : Number(repairOption);
  if (values.critic && command !== 'reflect') throw new TomboError('invalid_input', '--critic is only valid for reflect.');
  if (command === 'reflect' && values.adapter) throw new TomboError('invalid_input', 'Reflect uses --critic; --adapter is not used.');
  let output: string;
  if (command === 'inspect' || command === 'update' || command === 'invalidate' || command === 'reflect') {
    const shaped = command === 'inspect' ? null : stateSchema.safeParse(await readJson(values.state));
    if (shaped && !shaped.success) throw new TomboError('invalid_input', 'Invalid state shape.');
    const prior = shaped?.data ?? null;
    const expectedRevision = prior?.revision ?? -1;
    if (values.ledger) await new FileJournal(values.ledger).assertCurrent(prior);
    if (prior) validateState(prior);
    const tombo = createTombo({ maxModelRepairAttempts, adapter: command === 'invalidate' || command === 'reflect' ? fixtureAdapter : await loadAdapter(values.adapter) });
    const result = command === 'inspect'
      ? await tombo.inspect(await readJson(values.input))
      : command === 'update'
        ? await tombo.update(prior, await readJson(values.observations))
        : command === 'reflect'
          ? await tombo.reflect(prior, await loadCritic(values.critic))
          : tombo.invalidate(prior, await readJson(values.input) as { evidenceIds: string[]; reason: string });
    if (values.ledger && result.state.revision !== expectedRevision) {
      await new FileJournal(values.ledger).commit(expectedRevision, result.state);
    }
    output = `${JSON.stringify(result.state, null, 2)}\n`;
    if (result.state.stopReason && ['invalid_input', 'input_too_large', 'invalid_model_output', 'model_error', 'model_timeout', 'passage_unavailable', 'unsupported_fixture', 'budget_accounting_unavailable', 'execution_error'].includes(result.state.stopReason)) process.exitCode = 1;
  } else if (command === 'report') {
    if (values.format && values.format !== 'markdown' && values.format !== 'json') throw new TomboError('invalid_input', 'The format must be markdown or json.');
    const state = await readJson(values.state);
    const parsed = validateState(state);
    output = values.format === 'json' ? `${JSON.stringify(parsed, null, 2)}\n` : renderMarkdownReport(parsed);
  } else if (command === 'replay') {
    if (!values.ledger) throw new TomboError('invalid_input', 'Specify --ledger.');
    output = `${JSON.stringify(await replayJournal(values.ledger), null, 2)}\n`;
  } else {
    throw new TomboError('invalid_input', `Unknown command ${command}.`);
  }
  if (values.out) {
    await mkdir(dirname(values.out), { recursive: true });
    await writeFile(values.out, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: { code: error instanceof TomboError ? error.code : error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_') ? 'invalid_input' : 'execution_error', message: error instanceof Error ? error.message : String(error) } })}\n`);
  process.exitCode = 1;
});
