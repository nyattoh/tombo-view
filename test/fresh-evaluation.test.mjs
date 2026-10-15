import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { participantPacket, validateDataset } from '../evaluation/metacognition-runner.mjs';

const cases = JSON.parse(readFileSync(new URL('../evaluation/metacognition-fresh-cases.json', import.meta.url), 'utf8'));
const annotations = JSON.parse(readFileSync(new URL('../evaluation/metacognition-fresh-annotations.json', import.meta.url), 'utf8'));
const original = JSON.parse(readFileSync(new URL('../evaluation/metacognition-cases.json', import.meta.url), 'utf8'));
const caseById = id => cases.find(c => c.id === id);
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(0.95 * values.length) - 1];

test('fresh cases have distinct task families and hidden annotations', () => {
  assert.equal(validateDataset(cases, annotations), true);
  assert.equal(cases.length, 6);
  assert.equal(new Set(cases.map(c => c.family)).size, 3);
  for (const c of cases) {
    assert.equal(c.split, 'evaluation');
    assert.equal(c.synthetic, true);
    assert.equal(original.some(old => old.id === c.id || old.family === c.family), false);
    const packet = JSON.stringify(participantPacket(c));
    assert.equal(packet.includes(annotations[c.id].correctAnswer), false);
    assert.equal(packet.includes(c.sources[0].text), false);
    assert.equal(Object.hasOwn(participantPacket(c), 'criteria'), false);
    assert.deepEqual(Object.keys(participantPacket(c).tools[0]).sort(), ['capability', 'description', 'id']);
    assert.equal(Object.hasOwn(participantPacket(c).tools[0], 'status'), false);
  }
});

test('fresh challenge suite includes concrete counterevidence and unresolved coverage', () => {
  const values = Object.values(annotations);
  assert.equal(values.filter(a => a.control).length, 3);
  assert.equal(values.filter(a => a.counterevidence).length, 2);
  assert.equal(values.filter(a => a.mandatoryUnknown).length, 1);
  for (const a of values) assert.equal(a.required.length, a.control ? 0 : 1);
});

test('unit counterexample uses the record calibration within the exact window', () => {
  const c = caseById('fresh-01');
  const a = Number(c.context.match(/Feed A recorded a steady (\d+) L\/min/)[1]);
  const b = Number(c.sources[0].text.match(/rate was (\d+) pulses\/min/)[1]);
  const perPulse = Number(c.sources[0].text.match(/pulse represents ([\d.]+) litres/)[1]);
  assert.equal((a + b * perPulse) * 60, 3600);
  assert.match(annotations[c.id].correctAnswer, /3,600/);
  assert.match(c.context, /12 February 14:00-15:00/);
  assert.match(c.sources[0].text, /12 February 14:00-15:00/);
});

test('cold-run percentile agrees with all listed samples and the stated method', () => {
  const c = caseById('fresh-03');
  const values = c.sources[0].text.match(/latencies \(ms\): ([\d, ]+)\./)[1].split(',').map(Number);
  assert.equal(values.length, 12);
  assert.equal(p95(values), 2130);
  assert.match(c.sources[0].text, /p95 = 2130 ms/);
  assert.match(annotations[c.id].correctAnswer, /2130 ms/);
  assert.match(c.context, /for both warm and cold starts/);
  assert.ok(p95(values) > 800);
});

test('warm positive control has complete grouped samples and a correct percentile', () => {
  const c = caseById('fresh-04');
  const words = { one: 1, two: 2 };
  const samples = [...c.sources[0].text.matchAll(/(\d+|one|two) (?:runs )?at (\d+) ms/g)]
    .flatMap(match => Array(words[match[1]] ?? Number(match[1])).fill(Number(match[2])));
  assert.equal(samples.length, 40);
  assert.equal(p95(samples), 610);
  assert.ok(p95(samples) <= 800);
  assert.equal(annotations[c.id].control, true);
});

test('inventory unknown does not assert the existence of omitted runtime components', () => {
  const c = caseById('fresh-05');
  assert.match(c.context, /may also load optional native plugins/);
  assert.match(c.sources[0].text, /whether it contains zero plugins or any additional runtime components/);
  assert.equal(annotations[c.id].mandatoryUnknown, true);
  assert.equal(annotations[c.id].counterevidence, false);
  assert.match(annotations[c.id].correctAnswer, /not that a specific runtime component is missing/);
});
