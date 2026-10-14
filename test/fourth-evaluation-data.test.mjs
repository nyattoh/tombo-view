import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeTool, participantPacket, validateDataset } from '../evaluation/metacognition-runner.mjs';

const load = name => JSON.parse(readFileSync(new URL(`../evaluation/metacognition-${name}.json`, import.meta.url), 'utf8'));
const cases = load('fourth-cases');
const annotations = load('fourth-annotations');
const previous = [...load('cases'), ...load('fresh-cases'), ...load('next-cases')];
const byId = id => cases.find(c => c.id === id);
const record = id => executeTool(byId(id), 'read_record', `${id}-src`).text;
const pairsIn = text => [...text.matchAll(/^row\d+ (P\d)-(P\d)$/gm)].map(([, a, b]) => [a, b].sort().join('-'));
const multiplicities = pairs => pairs.reduce((counts, pair) => counts.set(pair, (counts.get(pair) ?? 0) + 1), new Map());
const chainIn = text => [...text.matchAll(/^seq=(\d+) value=(\d+) check=(\d+)$/gm)].map(([, seq, value, check]) => ({seq:Number(seq), value:Number(value), check:Number(check)}));
const localFailures = rows => rows.filter((row, i) => ((i === 0 ? 0 : rows[i - 1].check) * 31 + row.value) % 251 !== row.check).map(row => row.seq);
const votesIn = text => [...text.matchAll(/^member=(V\d) vote=(yes|no|sealed)$/gm)].map(([, member, vote]) => ({member, vote}));
const voteBounds = rows => {
  const yes = rows.filter(row => row.vote === 'yes').length;
  const no = rows.filter(row => row.vote === 'no').length;
  const sealed = rows.filter(row => row.vote === 'sealed').length;
  return {yes, no, sealed, min:yes, max:yes + sealed};
};

test('fourth dataset validates through the frozen runner and masks annotations and record contents', () => {
  assert.equal(validateDataset(cases, annotations), true);
  assert.equal(cases.length, 6);
  assert.deepEqual(Object.keys(annotations).sort(), cases.map(c => c.id).sort());
  assert.deepEqual(Object.values(annotations).map(a => [a.control, a.mandatoryUnknown, a.counterevidence]), [
    [false, false, true], [true, false, false], [false, false, true],
    [true, false, false], [false, true, false], [true, false, false]
  ]);
  assert.equal(new Set(cases.map(c => c.family)).size, 3);
  for (const c of cases) {
    assert.match(c.id, /^[a-z]\d[a-z]\d$/);
    assert.equal(previous.some(old => old.id === c.id || old.family === c.family), false);
    assert.equal(c.split, 'evaluation');
    assert.equal(c.synthetic, true);
    assert.ok(c.context.length <= 3000);
    assert.ok(c.context.startsWith('This is a fictional exercise record. '));
    assert.equal(c.sources.length, 1);
    const packet = participantPacket(c);
    const encoded = JSON.stringify(packet);
    assert.deepEqual(Object.keys(packet).sort(), ['capabilities', 'context', 'draft', 'task', 'tools']);
    assert.deepEqual(packet.tools, [{id:c.sources[0].id, capability:'read_record', description:c.sources[0].description}]);
    assert.doesNotMatch(encoded, /negative|control|required|correctAnswer|mandatoryUnknown|counterevidence|crit-/i);
    assert.equal(encoded.includes(annotations[c.id].correctAnswer), false);
    if (!annotations[c.id].control) assert.equal(encoded.includes(c.sources[0].text), false);
    assert.deepEqual(executeTool(c, 'read_record', c.sources[0].id), {id:c.sources[0].id, status:'ok', text:c.sources[0].text});
    assert.throws(() => executeTool(c, 'read_record', 'undeclared'), /unknown source/);
    assert.throws(() => executeTool(c, 'network', c.sources[0].id), /undeclared capability/);
    assert.deepEqual(Object.keys(annotations[c.id].criteria), [`crit-${c.id}`]);
    assert.deepEqual(annotations[c.id].required, annotations[c.id].control ? [] : [`crit-${c.id}`]);
    assert.deepEqual(annotations[c.id].criteria[`crit-${c.id}`].sourceRefs, [c.sources[0].id]);
  }
  for (const [a, b] of [['q7m2', 'k4r8'], ['v9c3', 'p6n1'], ['h2w5', 'b8s4']]) {
    assert.equal(byId(a).family, byId(b).family);
    assert.equal(participantPacket(byId(a)).task, participantPacket(byId(b)).task);
    assert.equal(participantPacket(byId(a)).draft, participantPacket(byId(b)).draft);
    assert.equal(participantPacket(byId(a)).tools[0].description, participantPacket(byId(b)).tools[0].description);
  }
  const badSource = structuredClone(annotations);
  badSource.q7m2.criteria['crit-q7m2'].sourceRefs = ['undeclared'];
  assert.throws(() => validateDataset(cases, badSource), /unknown annotation source/);
  const badRequired = structuredClone(annotations);
  badRequired.q7m2.required = ['absent'];
  assert.throws(() => validateDataset(cases, badRequired), /unknown required criterion/);
});

test('fifteen schedule rows hide a multiset defect while complete context proves the paired schedule', () => {
  const canonical = [];
  for (let a = 1; a <= 6; a++) for (let b = a + 1; b <= 6; b++) canonical.push(`P${a}-P${b}`);
  assert.equal(canonical.length, 15);
  const rows = pairsIn(record('q7m2'));
  assert.equal(rows.length, 15);
  const counts = multiplicities(rows);
  assert.deepEqual([...counts].filter(([, count]) => count > 1), [['P2-P5', 2]]);
  assert.deepEqual(canonical.filter(pair => !counts.has(pair)), ['P3-P6']);
  assert.equal(counts.size, 14);
  assert.equal(pairsIn(participantPacket(byId('q7m2')).context).length, 0);
  const complete = pairsIn(participantPacket(byId('k4r8')).context);
  assert.deepEqual(complete.slice().sort(), canonical.slice().sort());
  assert.equal(multiplicities(complete).size, 15);
  assert.ok([...multiplicities(complete).values()].every(count => count === 1));
  assert.deepEqual(pairsIn(record('k4r8')), complete);
  for (const id of ['q7m2', 'k4r8']) {
    assert.match(record(id), /exactly the six teams \{P1, P2, P3, P4, P5, P6\}/);
    assert.match(record(id), /final and complete for this cycle\. No other rows exist/);
  }
  assert.match(participantPacket(byId('k4r8')).context, /Each unordered pair must occur exactly once/);
});

test('twelve checks use previous stored checks and isolate the changed row without cascading local failures', () => {
  const changed = chainIn(record('v9c3'));
  const complete = chainIn(participantPacket(byId('p6n1')).context);
  for (const rows of [changed, complete]) {
    assert.deepEqual(rows.map(row => row.seq), Array.from({length:12}, (_, i) => i + 1));
    assert.ok(rows.every(row => Number.isInteger(row.value) && row.value >= 0 && row.check >= 0 && row.check < 251));
  }
  assert.deepEqual(localFailures(changed), [7]);
  assert.deepEqual(localFailures(complete), []);
  assert.equal(changed[5].check, 181);
  assert.equal((changed[5].check * 31 + changed[6].value) % 251, 125);
  assert.equal(changed[6].check, 124);
  assert.deepEqual(changed.map(row => row.check), complete.map(row => row.check));
  assert.deepEqual(changed.filter((row, i) => row.value !== complete[i].value).map(row => row.seq), [7]);
  assert.equal(changed[6].value - complete[6].value, 1);
  let recomputed = 0;
  const downstreamDifferences = changed.filter(row => {
    recomputed = (recomputed * 31 + row.value) % 251;
    return recomputed !== row.check;
  }).map(row => row.seq);
  assert.deepEqual(downstreamDifferences, [7, 8, 9, 10, 11, 12]);
  assert.equal(chainIn(participantPacket(byId('v9c3')).context).length, 0);
  assert.deepEqual(chainIn(record('p6n1')), complete);
  for (const text of [record('v9c3'), participantPacket(byId('p6n1')).context]) {
    assert.match(text, /Genesis check_0=0/);
    assert.match(text, /check_i=\(previousStoredCheck\*31\+value_i\)%251/);
    assert.match(text, /previousStoredCheck is the check saved in row i-1/);
    assert.match(text, /listing is final and complete/);
  }
  for (const id of ['v9c3', 'p6n1']) assert.doesNotMatch(participantPacket(byId(id)).draft, /authentic|tamper|cryptograph|forged|severity/i);
});

test('sealed votes permit both outcomes while all nine disclosed context votes establish approval', () => {
  const partial = votesIn(record('h2w5'));
  assert.deepEqual(partial.map(row => row.member), Array.from({length:9}, (_, i) => `V${i + 1}`));
  assert.deepEqual(voteBounds(partial), {yes:4, no:3, sealed:2, min:4, max:6});
  assert.deepEqual(partial.filter(row => row.vote === 'sealed').map(row => row.member), ['V8', 'V9']);
  const outcomes = ['no', 'yes'].map(choice => {
    const completion = partial.map(row => ({...row, vote:row.vote === 'sealed' ? choice : row.vote}));
    assert.deepEqual(completion.filter((row, i) => partial[i].vote !== 'sealed'), partial.filter(row => row.vote !== 'sealed'));
    return voteBounds(completion).yes >= 5;
  });
  assert.deepEqual(outcomes, [false, true]);
  assert.equal(votesIn(participantPacket(byId('h2w5')).context).length, 0);
  assert.doesNotMatch(participantPacket(byId('h2w5')).context, /sealed|disclosed|four yes|three no/i);
  const complete = votesIn(participantPacket(byId('b8s4')).context);
  assert.deepEqual(complete.map(row => row.member), Array.from({length:9}, (_, i) => `V${i + 1}`));
  assert.deepEqual(voteBounds(complete), {yes:6, no:3, sealed:0, min:6, max:6});
  assert.equal(voteBounds(complete).min >= 5, true);
  assert.deepEqual(votesIn(record('b8s4')), complete);
  for (const text of [record('h2w5'), participantPacket(byId('b8s4')).context]) {
    assert.match(text, /Approval requires at least 5 yes votes out of these nine/);
    assert.match(text, /Each voter casts exactly one vote, yes or no; there are no abstentions/);
    assert.match(text, /one row for every voter/);
    assert.match(text, /captured immutable fixture/);
    assert.match(text, /fixture supplies no later disclosure/);
  }
  assert.equal(executeTool(byId('h2w5'), 'read_record', 'h2w5-src').status, 'ok');
});
