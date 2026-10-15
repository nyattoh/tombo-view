import { writeFile } from 'node:fs/promises';
import { compareHiddenSideMethods } from '../dist/index.js';

const dimension = 512;

function localCharNgramVector(text) {
  const chars = Array.from(text.normalize('NFC').toLowerCase().replace(/[\s、。，！？・「」『』（）()]/gu, ''));
  const vector = Array.from({ length: dimension }, () => 0);
  const features = [];
  for (const size of [1, 2, 3]) for (let index = 0; index <= chars.length - size; index++) features.push(chars.slice(index, index + size).join(''));
  if (features.length === 0) return vector;
  for (const feature of features) {
    let hash = 0x811c9dc5;
    for (const character of feature) {
      for (const byte of Buffer.from(character, 'utf8')) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    }
    const bucket = hash % dimension;
    vector[bucket] += hash & 0x80000000 ? -1 : 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude ? vector.map(value => value / magnitude) : vector;
}

const inputContext = '犬、カレー、夕暮れ、帰宅';
const viewpoint = '家庭での食事';
const concepts = [
  '家族で囲む夕食', 'スパイスカレーの夕食', '犬の散歩から帰宅', '夕暮れの散歩', '帰宅後に犬が迎える',
  'カレーの買い出し', '食卓の準備', '夕方の散歩後にカレーを作る', '外食でカレー', '朝食を作る',
  '食後の片付け', '夕暮れに帰宅', '犬のごはん', '家庭料理', '夜道の帰宅', '香辛料の種類',
  '家族の会話', '猫の夕食', 'カレー皿', '仕事帰りの夕飯', '犬と過ごす休日', '夕食の献立',
  '雨の日の帰宅', '公園の夕焼け', 'スープを温める', '帰宅時の玄関', '辛さを選ぶ', '犬と家族の食卓',
];

const output = compareHiddenSideMethods({
  inputContext,
  viewpoint,
  embeddingModel: 'local-char-ngram-1-3-deterministic-v1',
  contextVectors: inputContext.split('、').map(localCharNgramVector),
  viewpointVector: localCharNgramVector(viewpoint),
  candidates: concepts.map((concept, index) => ({
    id: `candidate-${String(index + 1).padStart(2, '0')}`,
    concept,
    vector: localCharNgramVector(concept),
    source: `synthetic:hidden-side-corpus-v1#${index + 1}`,
  })),
}, { topK: 10, randomSeed: 20261016 });

const result = {
  ...output,
  experiment: {
    kind: 'deterministic local character n-gram feature baseline',
    corpus: 'small synthetic fixed corpus; 28 manually written candidates',
    actualSemanticEmbedding: false,
    paidOrExternalCalls: 0,
  },
};
const path = new URL('../evaluation/hidden-side-example.json', import.meta.url);
await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
for (const method of result.methods) {
  console.log(`\n${method.method}`);
  for (const candidate of method.candidates) console.log(`${candidate.hidden_rank}. ${candidate.concept} (baseline=${candidate.baseline_rank}, score=${candidate.score})`);
}
console.log(`\nresults written: ${path.pathname}`);
