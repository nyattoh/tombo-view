export async function runGuardedHostSession({ tools, coordinateDispatch, createT3Transport, config, onEvent = () => {} }) {
  const root = config.repositoryRoot ?? 'D:\\develop\\works\\tombo-view';
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  if (!/^[a-z0-9-]+$/.test(config.caseId) || !['baseline', 'tombo'].includes(config.arm) || !Number.isInteger(config.repeat) || config.repeat < 1) throw new Error('Invalid trial identity.');
  const out = `${root}\\${config.directory}\\${config.caseId}\\${config.arm}-r${config.repeat}`;
  if (!/^[a-zA-Z0-9_\\/-]+$/.test(config.directory) || !config.directory.startsWith('results/')) throw new Error('Invalid output directory.');
  const execute = async (cmd, options = {}) => {
    const r = await tools.exec_command({cmd, workdir:root, sandbox_permissions:'require_escalated', max_output_tokens:30000, yield_time_ms:1000, ...options});
    if (r.exit_code !== undefined && r.exit_code !== 0) throw new Error(r.output);
    return r;
  };
  const read = async script => {
    const result = await execute(`node --input-type=module -e ${quote(script)}`);
    try { return JSON.parse(result.output); }
    catch {
      let value = '', length;
      do {
        const capture = `const captured=[]; console.log=value=>captured.push(String(value)); ${script}; const value=captured.join('\\n'); process.stdout.write(JSON.stringify({part:value.slice(${value.length},${value.length + 4000}),length:value.length}));`;
        const chunk = JSON.parse((await execute(`node --input-type=module -e ${quote(capture)}`)).output);
        if (!Number.isSafeInteger(chunk.length) || chunk.length > 200000 || typeof chunk.part !== 'string' || !chunk.part.length || (length !== undefined && length !== chunk.length)) throw new Error('Incomplete or changing machine file observation.');
        length = chunk.length;
        value += chunk.part;
      } while (value.length < length);
      return JSON.parse(value);
    }
  };
  const exists = await read(`import {existsSync} from 'node:fs'; console.log(JSON.stringify(existsSync(${JSON.stringify(out)})));`);
  if (exists) throw new Error('A retained trial directory must not be reused.');
  const dispatches = [];
  let expectedSequence = 1, terminal = false, sessionId;
  const receive = chunk => { if (chunk.exit_code !== undefined) terminal = true; };
  const start = await execute(`node scripts/metacognition-host-trial.mjs --case ${quote(config.caseId)} --arm ${quote(config.arm)} --repeat ${config.repeat} --out ${quote(out)} --cases ${quote(config.casesPath)} --protocol ${quote(config.protocolPath)} --origin ${quote(config.origin ?? 'real-model')}`, {tty:true});
  sessionId = start.session_id;
  onEvent({kind:'producer-start',sessionId:sessionId ?? null,exitCode:start.exit_code ?? null,output:start.output});
  receive(start);
  const ready = async () => {
    if (terminal) return {terminal:true};
    const ended = await read(`import {existsSync} from 'node:fs'; console.log(JSON.stringify(existsSync(${JSON.stringify(out + '\\run.json')})));`);
    terminal ||= ended;
    return {terminal};
  };
  const persist = async () => {
    const json = JSON.stringify(dispatches);
    await execute(`node --input-type=module -e ${quote(`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(out + '\\dispatch-events.json')}, ${JSON.stringify(json)} + '\\n', {flag:'wx'});`)}`);
  };
  try { while (!terminal) {
    if ((await ready()).terminal) break;
    let loaded;
    try {
      loaded = await read(`import {readFileSync, existsSync} from 'node:fs'; const requestPath=${JSON.stringify(out + `\\request-${expectedSequence}.json`)}; const bridgePath=${JSON.stringify(out + `\\bridge-${expectedSequence}.json`)}; console.log(JSON.stringify(existsSync(requestPath)&&existsSync(bridgePath)?{request:JSON.parse(readFileSync(requestPath,'utf8')),bridge:JSON.parse(readFileSync(bridgePath,'utf8'))}:null));`);
    } catch (error) {
      onEvent({kind:'observation-error',message:String(error.message ?? error).slice(0,512),taskId:null});
    }
    if (!loaded) {
      if (!sessionId) throw new Error('Producer has no active session.');
      receive(await tools.write_stdin({session_id:sessionId,chars:'',yield_time_ms:1000,max_output_tokens:3000}));
      continue;
    }
    if (loaded.request.sequence !== expectedSequence || loaded.bridge.sequence !== expectedSequence) throw new Error('Request file sequence does not match the expected sequence.');
    const frame = {sequence:expectedSequence}, state = {};
    const transport = createT3Transport({
      state, target:config.target, clientRequestId:config.clientRequestId,
      tools:config.delegationTools ?? {delegate_task:tools.mcp__t3_code__delegate_task,task_status:tools.mcp__t3_code__task_status,task_cancel:tools.mcp__t3_code__task_cancel},
      ready,
      load:() => loaded,
      deliver:async reply => { receive(await tools.write_stdin({session_id:sessionId,chars:JSON.stringify(reply)+'\n',yield_time_ms:1000,max_output_tokens:3000})); },
    });
    dispatches.push({sequence:frame.sequence,state,events:transport.events});
    const record = transport.callbacks.record;
    transport.callbacks.record = event => {
      record(event);
      config.onState?.({out,sessionId,sequence:frame.sequence,state,events:transport.events});
    };
    onEvent({kind:'request',caseId:config.caseId,arm:config.arm,repeat:config.repeat,sequence:frame.sequence});
    do {
      try { await coordinateDispatch(state,transport.callbacks); }
      catch (error) {
        if (!['new', 'active'].includes(state.phase)) throw error;
        onEvent({kind:'observation-error',message:String(error.message ?? error).slice(0,512),taskId:state.taskId ?? null});
        await new Promise(resolve => setTimeout(resolve,2000));
      }
      if (state.phase === 'active') await new Promise(resolve => setTimeout(resolve,2000));
    } while (['new', 'active'].includes(state.phase));
    onEvent({kind:'dispatch-ended',phase:state.phase,taskId:state.taskId ?? null});
    expectedSequence++;
    if (state.phase === 'stopped') {
      receive(await tools.write_stdin({session_id:sessionId,chars:'',yield_time_ms:1000,max_output_tokens:3000}));
    }
  } } finally { await persist(); }
  return read(`import {readFileSync} from 'node:fs'; console.log(readFileSync(${JSON.stringify(out + '\\run.json')}, 'utf8'));`);
}
