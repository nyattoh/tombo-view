import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const outputDigest = text => createHash('sha256').update(text).digest('hex');
const digest = value => outputDigest(JSON.stringify(value));
const count = z.number().int().nonnegative();
const usage = z.union([z.number().nonnegative(), z.literal('UNKNOWN')]);
export const RunSchema = z.object({
  id:z.string().min(1), caseId:z.string(), arm:z.enum(['baseline','tombo']), repeat:z.number().int().positive(),
  status:z.enum(['success','error','cancelled','not_run']), origin:z.enum(['real-model','fixture']),
  model:z.object({provider:z.string().min(1),name:z.string().min(1),effort:z.string().min(1)}).strict(),
  requested:z.object({capabilities:z.array(z.string()),maxCalls:count,maxOutputChars:count}).strict(),
  observed:z.object({calls:count,modelCalls:count,inputTokens:usage,outputTokens:usage,cost:usage,durationMs:usage}).strict(),
  checks:z.array(z.object({capability:z.string(),sourceId:z.string(),status:z.enum(['ok','unavailable','incomplete','conflict']),responseDigest:z.string()}).strict()),
  output:z.string(), packetDigest:z.string(), protocolDigest:z.string()
}).strict();
const Evidence = z.object({outputExcerpt:z.string().min(12).refine(text=>text.replace(/\s/g,'').length>=12),sourceRefs:z.array(z.string()).min(1)}).strict();
export const JudgementSchema = z.object({
  runId:z.string(),outputDigest:z.string(),
  assessor:z.object({id:z.string().min(1),kind:z.enum(['independent-human','independent-model']),blinded:z.literal(true)}).strict(),
  correctness:z.boolean(),falseClosure:z.boolean(),unnecessaryProbe:z.boolean(),correctionAccurate:z.boolean(),
  findings:z.array(Evidence.extend({id:z.string(),matched:z.boolean()})),evidence:z.array(Evidence).min(1)
}).strict();

export function participantPacket(c) {
  return {task:c.task,context:c.context,draft:c.draft,capabilities:[...c.capabilities],tools:c.sources.map(s=>({id:s.id,capability:s.capability,description:s.description}))};
}
export function participantPrompt(c) {
  const p=participantPacket(c);
  return `${p.task}\n\nContext\n${p.context}\n\nDraft answer\n${p.draft}\n\nAvailable records\n${JSON.stringify(p.tools)}\nUse only the declared capabilities. State the final answer, any remaining uncertainty, and the records supporting it.`;
}
export function executeTool(c, capability, sourceId) {
  if(!c.capabilities.includes(capability)) throw new Error('undeclared capability');
  const s=c.sources.find(s=>s.id===sourceId&&s.capability===capability);
  if(!s) throw new Error('unknown source');
  return {id:s.id,status:s.status,text:s.text};
}
export function blindedPacket(run,c,annotation) {
  return {label:outputDigest(run.id).slice(0,16),output:run.output,outputDigest:outputDigest(run.output),task:participantPacket(c),records:c.sources.map(s=>executeTool(c,s.capability,s.id)),criteria:annotation,performedChecks:run.checks};
}
export function validateDataset(cases,annotations) {
  const ids=new Set(), families=new Map();
  for(const c of cases) {
    if(ids.has(c.id)) throw new Error('duplicate case');
    ids.add(c.id);
    if(families.has(c.family)&&families.get(c.family)!==c.split) throw new Error('family crosses splits');
    families.set(c.family,c.split);
    if(!annotations[c.id]) throw new Error('missing annotation');
    const a=annotations[c.id];
    if(!Array.isArray(a.required)||new Set(a.required).size!==a.required.length) throw new Error('invalid required criteria');
    if(a.required.some(id=>typeof id!=='string'||!Object.hasOwn(a.criteria,id))) throw new Error('unknown required criterion');
    const refs=new Set(c.sources.map(s=>s.id));
    for(const criterion of Object.values(annotations[c.id].criteria)) if(criterion.sourceRefs.some(id=>!refs.has(id))) throw new Error('unknown annotation source');
  }
  return true;
}
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0;
const averageMetrics = rows => Object.fromEntries(['correctness','recall','falseClosure','correctionAccuracy','controlUnnecessaryProbe','performedCheckCount'].map(k=>[k,mean(rows.map(r=>r[k]))]));
function validJudgement(j,r,c,a) {
  if(!JudgementSchema.safeParse(j).success||j.outputDigest!==outputDigest(r.output)) return false;
  const refs=new Set(c.sources.map(s=>s.id));
  const evidenceValid=e=>r.output.includes(e.outputExcerpt)&&e.sourceRefs.every(id=>refs.has(id));
  if(!j.evidence.every(evidenceValid)||new Set(j.findings.map(f=>f.id)).size!==j.findings.length) return false;
  return j.findings.every(f=>a.criteria[f.id]&&evidenceValid(f)&&a.criteria[f.id].sourceRefs.every(id=>f.sourceRefs.includes(id))&&(!f.matched||!a.required.includes(f.id)||a.criteria[f.id].sourceRefs.every(id=>r.checks.some(check=>check.sourceId===id))));
}

export function scoreRuns(cases,annotations,protocol,inputRuns,inputJudgements) {
  validateDataset(cases,annotations);
  if(!protocol.frozenBeforeResults||protocol.minimumRepeats<3) throw new Error('protocol requires at least three frozen repeats');
  if(digest(cases)!==protocol.caseDigest||digest(annotations)!==protocol.annotationDigest) throw new Error('frozen data digest mismatch');
  const runs=new Map(), judgements=new Map();
  for(const r of inputRuns) {
    RunSchema.parse(r);
    const key=`${r.caseId}/${r.repeat}/${r.arm}`;
    if(runs.has(key)||[...runs.values()].some(x=>x.id===r.id)) throw new Error('duplicate run');
    const c=cases.find(c=>c.id===r.caseId);
    if(!c||c.split!=='evaluation'||r.repeat>protocol.minimumRepeats) throw new Error('unexpected run slot');
    runs.set(key,r);
  }
  for(const j of inputJudgements) { if(judgements.has(j.runId)) throw new Error('duplicate judgement'); judgements.set(j.runId,j); }
  const statusCounts={success:0,error:0,cancelled:0,not_run:0,missing:0};
  let invalidJudgements=[...judgements.keys()].filter(id=>![...runs.values()].some(r=>r.id===id)).length, unmatchedPairs=0, invalidTranscripts=0, fixtures=0, unjudged=0;
  const assessorIds=new Set(inputJudgements.filter(j=>j.assessor).map(j=>j.assessor.id));
  const independentAssessorConsistent=assessorIds.size===1;
  const models=[...new Map([...runs.values()].map(r=>[digest(r.model),r.model])).values()];
  const modelIdentityConsistent=models.length===1;
  const caseRows=[], rows={baseline:[],tombo:[]}, evaluation=cases.filter(c=>c.split==='evaluation');
  const threshold=protocol.thresholds;
  for(const c of evaluation) {
    const annotation=annotations[c.id], repeated={baseline:[],tombo:[]};
    for(let repeat=1;repeat<=protocol.minimumRepeats;repeat++) {
      const pair=protocol.arms.map(arm=>runs.get(`${c.id}/${repeat}/${arm}`));
      if(!pair.every(Boolean)||digest(pair[0].model)!==digest(pair[1].model)||digest(pair[0].requested)!==digest(pair[1].requested)) unmatchedPairs++;
      for(const [i,arm] of protocol.arms.entries()) {
        const r=pair[i]; statusCounts[r?.status??'missing']++;
        const j=r&&judgements.get(r.id);
        let transcript=!!r;
        if(r) {
          if(r.origin==='fixture') fixtures++;
          transcript=r.packetDigest===digest(participantPacket(c))&&r.protocolDigest===digest(protocol)&&r.requested.maxCalls===protocol.requested.maxCalls&&r.requested.maxOutputChars===protocol.requested.maxOutputChars&&digest(r.requested.capabilities)===digest(c.capabilities)&&r.observed.calls<=r.requested.maxCalls&&r.observed.calls===r.observed.modelCalls+r.checks.length&&r.output.length<=r.requested.maxOutputChars&&(r.status!=='success'||r.observed.modelCalls>=1);
          transcript=transcript&&r.checks.every(check=>{try{return check.responseDigest===digest(executeTool(c,check.capability,check.sourceId))&&check.status===executeTool(c,check.capability,check.sourceId).status;}catch{return false;}});
          if(!transcript) invalidTranscripts++;
          if(j&&!validJudgement(j,r,c,annotation)) invalidJudgements++;
          if(!j) unjudged++;
        }
        const valid=transcript&&r?.status==='success'&&j&&validJudgement(j,r,c,annotation);
        const matched=valid?new Set(j.findings.filter(f=>f.matched).map(f=>f.id)):new Set();
        repeated[arm].push({correctness:Number(!!valid&&j.correctness),recall:annotation.required.length?annotation.required.filter(id=>matched.has(id)).length/annotation.required.length:Number(!!valid&&j.correctness),falseClosure:Number(!valid||j.falseClosure),correctionAccuracy:Number(!!valid&&j.correctionAccurate),controlUnnecessaryProbe:annotation.control?Number(!valid||j.unnecessaryProbe):0,performedCheckCount:r?.checks.length??0});
      }
    }
    const row={caseId:c.id,control:annotation.control,mandatorySuite:annotation.mandatoryUnknown||annotation.counterevidence};
    for(const arm of protocol.arms) {row[arm]=averageMetrics(repeated[arm]);rows[arm].push(row[arm]);}
    caseRows.push(row);
  }
  const arms=Object.fromEntries(protocol.arms.map(arm=>[arm,averageMetrics(rows[arm])]));
  for(const arm of protocol.arms) {
    arms[arm].recall=mean(caseRows.filter(r=>annotations[r.caseId].required.length).map(r=>r[arm].recall));
    arms[arm].controlUnnecessaryProbe=mean(caseRows.filter(r=>r.control).map(r=>r[arm].controlUnnecessaryProbe));
    arms[arm].falseClosure=mean(caseRows.filter(r=>r.mandatorySuite).map(r=>r[arm].falseClosure));
  }
  const complete=evaluation.length>0&&statusCounts.success===evaluation.length*protocol.minimumRepeats*2&&!invalidJudgements&&!invalidTranscripts&&!fixtures&&!unjudged&&!unmatchedPairs&&independentAssessorConsistent&&modelIdentityConsistent;
  const nonRegression=caseRows.every(r=>r.tombo.correctness>=r.baseline.correctness&&r.tombo.recall>=r.baseline.recall&&r.tombo.falseClosure<=r.baseline.falseClosure&&r.tombo.correctionAccuracy>=r.baseline.correctionAccuracy&&(!r.control||r.tombo.controlUnnecessaryProbe<=r.baseline.controlUnnecessaryProbe));
  const t=arms.tombo;
  const ready=complete&&nonRegression&&t.correctness>=threshold.correctness&&t.correctionAccuracy>=threshold.correctionAccuracy&&t.recall>=threshold.recall&&t.falseClosure===threshold.falseClosure&&t.controlUnnecessaryProbe<=threshold.maxControlUnnecessaryProbe;
  const improved=caseRows.filter(r=>annotations[r.caseId].required.length&&r.tombo.recall>r.baseline.recall).length;
  const superiority=ready&&improved>=threshold.minimumImprovedCases&&t.recall-arms.baseline.recall>=threshold.superiorityRecallGain;
  return {readiness:ready?'PASS':'FAIL',comparison:superiority?'SUPERIOR':'INCONCLUSIVE',independentCases:evaluation.length,repeatPairs:evaluation.length*protocol.minimumRepeats,statusCounts,invalidJudgements,invalidTranscripts,unjudged,fixtures,unmatchedPairs,nonRegression,independentAssessorConsistent,models,modelIdentityConsistent,callsAndOriginAttestationOnly:true,independentAssessorAttestationOnly:true,improvedCases:improved,arms,cases:caseRows,g4CostProven:false,boundary:protocol.boundary,protocolDigest:digest(protocol)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const load=name=>JSON.parse(readFileSync(new URL(`./metacognition-${name}.json`,import.meta.url),'utf8'));
  const cases=load('cases'), annotations=load('annotations'), protocol=load('protocol');
  validateDataset(cases,annotations);
  const [command,a,b]=process.argv.slice(2);
  if(command==='prepare') {
    const selected=cases.filter(c=>c.split===(a??'development'));
    const packets=selected.map(c=>({task:participantPacket(c),prompt:participantPrompt(c),packetDigest:digest(participantPacket(c))}));
    console.log(JSON.stringify(packets,null,2));
  } else if(command==='score'&&a&&b) {
    const report=scoreRuns(cases,annotations,protocol,JSON.parse(readFileSync(a,'utf8')),JSON.parse(readFileSync(b,'utf8')));
    console.log(JSON.stringify(report,null,2));
  } else throw new Error('Use prepare development|evaluation or score RUNS.json JUDGEMENTS.json. No model is called.');
}
