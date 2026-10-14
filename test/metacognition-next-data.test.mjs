import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeTool, participantPacket, validateDataset } from '../evaluation/metacognition-runner.mjs';

const load = name => JSON.parse(readFileSync(new URL(`../evaluation/metacognition-${name}.json`, import.meta.url), 'utf8'));
const cases = load('next-cases');
const annotations = load('next-annotations');
const previous = [...load('cases'), ...load('fresh-cases')];
const byId = id => cases.find(c => c.id === id);
const record = id => executeTool(byId(id), 'read_record', `${id}-src`).text;
const adjacency = text => Object.fromEntries([...text.matchAll(/\b([A-D])->(?:([A-D])| \(no outgoing edges\))/g)].map(([, from, to]) => [from, to ? [to] : []]));
const reachable = (graph, start) => {
  const visited = new Set([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const to of graph[queue[i]] ?? []) {
      if (!visited.has(to)) {
        visited.add(to);
        queue.push(to);
      }
    }
  }
  return [...visited].filter(v => v !== start).sort();
};

test('next dataset validates and exposes only participant information through the actual packet builder', () => {
  assert.equal(validateDataset(cases, annotations), true);
  assert.equal(cases.length, 6);
  assert.deepEqual(Object.values(annotations).map(a => [a.control, a.mandatoryUnknown, a.counterevidence]), [
    [false, false, true], [true, false, false], [false, false, true],
    [true, false, false], [false, true, false], [true, false, false]
  ]);
  for (const c of cases) {
    assert.equal(previous.some(old => old.id === c.id || old.family === c.family), false);
    const packet = participantPacket(c);
    assert.deepEqual(Object.keys(packet).sort(), ['capabilities', 'context', 'draft', 'task', 'tools']);
    assert.deepEqual(packet.tools, [{id: c.sources[0].id, capability: 'read_record', description: c.sources[0].description}]);
    assert.equal(JSON.stringify(packet).includes(c.sources[0].text), false);
    assert.equal(JSON.stringify(packet).includes(annotations[c.id].correctAnswer), false);
    assert.deepEqual(executeTool(c, 'read_record', c.sources[0].id), {id: c.sources[0].id, status: 'ok', text: c.sources[0].text});
    assert.throws(() => executeTool(c, 'read_record', 'not-declared'), /unknown source/);
    assert.equal(c.split, 'evaluation');
    assert.equal(c.synthetic, true);
    assert.deepEqual(Object.keys(annotations[c.id].criteria), [`crit-${c.id}`]);
  }
  for (const [negative, positive] of [['next-01', 'next-02'], ['next-03', 'next-04'], ['next-05', 'next-06']]) {
    assert.equal(participantPacket(byId(negative)).tools[0].description, participantPacket(byId(positive)).tools[0].description);
  }
});

test('declared production override refutes the default and the complete positive context merges to true', () => {
  const values = text => ({
    defaults: /shipped defaults set (?:feature flag )?'new-ledger' enabled=(true|false)/.exec(text)?.[1] === 'true',
    production: /production override file sets (?:feature flag )?'new-ledger' enabled=(true|false)/i.exec(text)?.[1] === 'true'
  });
  const negative = record('next-01');
  assert.match(negative, /environment-specific override value takes precedence over the shipped default/);
  assert.match(negative, /Production override file sets feature flag 'new-ledger' enabled=false/);
  assert.deepEqual(values(negative), {defaults: true, production: false});
  assert.equal({...{enabled: values(negative).defaults}, ...{enabled: values(negative).production}}.enabled, false);
  const positive = byId('next-02').context;
  assert.match(positive, /environment-specific override value wins over the shipped default/);
  assert.deepEqual(values(positive), {defaults: true, production: true});
  assert.equal({...{enabled: values(positive).defaults}, ...{enabled: values(positive).production}}.enabled, true);
  assert.match(annotations['next-01'].correctAnswer, /is false/);
  assert.match(annotations['next-02'].correctAnswer, /is true/);
});

test('UTF-8 byte measurements distinguish character count from the actual ingress limit', () => {
  const payload = id => /payload under review is (?:the five-character string|the five-character ASCII string) '([^']+)'/.exec(byId(id).context)?.[1];
  const negative = payload('next-03');
  const positive = payload('next-04');
  assert.equal([...negative].length, 5);
  assert.equal(Buffer.byteLength(negative, 'utf8'), 11);
  assert.equal(Buffer.byteLength(negative, 'utf8') <= 8, false);
  assert.equal([...positive].length, 5);
  assert.equal(Buffer.byteLength(positive, 'utf8'), 5);
  assert.equal(Buffer.byteLength(positive, 'utf8') <= 8, true);
  for (const id of ['next-03', 'next-04']) {
    assert.match(record(id), /UTF-8 encoded byte length/);
    assert.match(record(id), /no framing, header, or separator overhead/);
  }
  assert.match(annotations['next-03'].correctAnswer, /11 UTF-8 bytes/);
  assert.match(annotations['next-04'].correctAnswer, /5 UTF-8 bytes/);
});

test('partial outgoing rows permit both a reachable and an unreachable completion', () => {
  const partial = adjacency(record('next-05'));
  assert.deepEqual(partial, {A: ['B'], B: ['C']});
  const reachesD = {...partial, C: ['D'], D: []};
  const missesD = {...partial, C: [], D: []};
  assert.deepEqual(reachable(reachesD, 'A'), ['B', 'C', 'D']);
  assert.deepEqual(reachable(missesD, 'A'), ['B', 'C']);
  for (const completion of [reachesD, missesD]) {
    assert.deepEqual({A: completion.A, B: completion.B}, partial);
  }
  assert.match(record('next-05'), /rows for vertices C and D have not been exported yet/);
  assert.match(annotations['next-05'].correctAnswer, /neither reachable from A nor disconnected from A/);
});

test('complete positive graph context proves reachability without a source read', () => {
  const graph = adjacency(byId('next-06').context);
  assert.deepEqual(graph, {A: ['B'], B: ['C'], C: ['D'], D: []});
  assert.deepEqual(reachable(graph, 'A'), ['B', 'C', 'D']);
  assert.deepEqual(adjacency(record('next-06')), graph);
  assert.match(byId('next-06').context, /final, complete adjacency listing/);
});
