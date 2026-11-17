/**
 * Host half of the tool-call leak auto-repair feature in dsh-wdx-relief.
 *
 * Derived from the MIT-licensed `dsh-tool-call-leak-fix` bundle (plugin/index.js).
 * The mechanisms are unchanged; only the config source differs: dsh-wdx-relief is
 * a volatile-config plugin, so every handler re-reads its slice of the live config
 * through `readConfig()` instead of capturing one plain object at apply time.
 *
 * Mechanisms:
 *   M2  tools/pre-execute  waterfall       deny a damaged / emptied call
 *   M3  tools/post-execute waterfall       add a no-op correction context
 *   M4  session/event + agent/turn-stopping silent no-op self-heal (inject + retry)
 *   M7  agent/pre-step                     one fork brief for inherited damage
 *   M9  session surface replace           shadow damaged steps on the model-visible surface
 *
 * Hard rule: never break the host. Every listener is wrapped in try/catch and every
 * registration goes through Cordis effect semantics, so an unload removes everything.
 * When a seam does not exist, or a value is not certain, the mechanism does nothing.
 */

import {
  buildCorrectionMessage,
  buildDenyReason,
  mergeConfig,
  scanAssistantText,
  scanToolArguments,
  scanToolResult,
} from './toolCallDetect.js'

/** Must stay identical to `name` in the repo-root package.json. */
export const TOOLCALL_PACKAGE_NAME = 'dsh-wdx-relief'

const SOURCE_RUNTIME_CONTEXT = 'runtime-context'
const SOURCE_PLUGIN = 'plugin:' + TOOLCALL_PACKAGE_NAME

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function newMessageId() {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* fall through to the manual generator */
  }
  let out = '';
  for (let i = 0; i < 32; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return (
    out.slice(0, 8) + '-' + out.slice(8, 12) + '-4' + out.slice(13, 16) + '-a' + out.slice(17, 20) + '-' + out.slice(20)
  );
}

/**
 * Build a producer-owned user message. The harness' v4 session format refuses
 * `source.kind === 'plugin'` ("format v4 message requires a producer-owned source
 * kind"), so M4/M9 corrections use `runtime-context` and M3's note uses this
 * plugin's own `plugin:<package>` kind.
 */
function pluginMessage(text, sourceKind) {
  const block = Object.freeze({ type: 'text', text: String(text) });
  return Object.freeze({
    id: newMessageId(),
    role: 'user',
    content: Object.freeze([block]),
    source: Object.freeze({ kind: sourceKind }),
  });
}

/** Merge the live config slice; any failure degrades to defaults. */
function currentConfig(readConfig) {
  try {
    return mergeConfig(typeof readConfig === 'function' ? readConfig() : {});
  } catch {
    return mergeConfig({});
  }
}

/**
 * Register one resource with Cordis effect semantics. A single failed
 * registration must not stop the other mechanisms.
 */
function install(ctx, register) {
  try {
    const factory = () => {
      const dispose = register();
      return typeof dispose === 'function' ? dispose : () => {};
    };
    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(factory);
    } else {
      factory();
    }
  } catch {
    /* degrade: keep the remaining mechanisms */
  }
}

/* ------------------------------------------------------------------ */
/* M2 helper: arguments silently emptied by a lenient JSON repair      */
/* ------------------------------------------------------------------ */

function requiredParameters(exec, runtime) {
  try {
    const parameters = exec && exec.schema && exec.schema.parameters;
    if (parameters && typeof parameters === 'object') return parameters;
  } catch {
    /* fall through to the registry */
  }
  try {
    if (runtime && typeof runtime.get === 'function') {
      const definition = runtime.get(exec.name);
      const parameters = definition && definition.parameters;
      if (parameters && typeof parameters === 'object') return parameters;
    }
  } catch {
    /* registry lookup is best-effort */
  }
  return null;
}

function emptyArgumentsDenial(exec, runtime, config) {
  const args = exec ? exec.arguments : undefined;
  if (args !== null && args !== undefined && (typeof args !== 'object' || Array.isArray(args))) return '';

  let keys;
  try {
    keys = args === null || args === undefined ? [] : Object.keys(args);
  } catch {
    return '';
  }
  if (keys.length > 0) return '';

  const parameters = requiredParameters(exec, runtime);
  const required = parameters && Array.isArray(parameters.required) ? parameters.required : null;
  if (!required || required.length === 0) return '';

  const missing = required.filter((key) => typeof key === 'string' && !(args && key in args));
  if (missing.length === 0) return '';

  const finding = {
    code: 'TRUNCATED_PAYLOAD',
    severity: 'error',
    detail: 'arguments arrived as an empty object although the tool declares required parameters',
  };
  const base = buildDenyReason([finding], config);
  const extra =
    config.lang === 'en'
      ? ' Arguments arrived as an empty object although this tool requires: ' +
        missing.join(', ') +
        '; a lenient JSON repair most likely emptied them.'
      : ' 参数疑似被容错解析器清空为 {}（本工具必填：' + missing.join('、') + '）。';
  return (base || '') + extra;
}

/* ------------------------------------------------------------------ */
/* install                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => object} readConfig live partial config (volatile refs resolved)
 * @param {(message: string) => void} [log]
 * @returns {() => void} disposer removing every registered listener
 */
export function installToolCallRepair(ctx, readConfig, log = () => {}) {
  const cfgNow = () => currentConfig(readConfig);
  const debug = (line) => {
    try {
      if (cfgNow().debugLog !== true) return;
      log('tool-repair ' + JSON.stringify(line));
    } catch {
      /* diagnostics must never change behaviour */
    }
  };

  const pending = new Map(); // sessionId -> last damaged step in this turn
  const corrections = new Map(); // sessionId -> { turn, count }

  /* M9 state */
  const damagedSeqs = new Map(); // sessionId -> Set<seq>
  const repairState = new Map(); // sessionId -> { tested, ok, scanned }
  let hasTargetsNow = false;

  /** One assistant event judged: text, tool-call count, damage verdict. */
  function judgeAssistantEvent(event) {
    if (!event || event.type !== 'assistant/message') return null;
    const data = event.data;
    const message = data && data.message;
    if (!message || message.role !== 'assistant') return null;
    const blocks = Array.isArray(message.content) ? message.content : [];
    let text = '';
    let toolCallCount = 0;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block.type === 'tool-call') toolCallCount += 1;
    }
    return {
      data,
      blocks,
      text,
      toolCallCount,
      scan: scanAssistantText(text, cfgNow(), { hasToolCalls: toolCallCount > 0, toolCallCount }),
    };
  }

  function noteDamaged(sessionId, seq) {
    if (!sessionId || typeof seq !== 'number') return;
    let set = damagedSeqs.get(sessionId);
    if (!set) {
      set = new Set();
      damagedSeqs.set(sessionId, set);
    }
    set.add(seq);
  }

  function repairNoteText(config) {
    return config.lang === 'en'
      ? '[Context repair] This step used to hold DAMAGED model output (call markup leaked into the text with no tool call). It is void: do not imitate it, and re-issue the call in small chunks when needed.'
      : '【上下文修复】此处原本是一步**损坏的模型输出**（调用标记泄漏到正文、且没有任何工具调用），现已作废。请不要模仿它；需要时用小块重新发起调用。';
  }

  /**
   * Verify `surfaceOp.replace` on our OWN probe node before touching real history.
   * With debugLog on the self-test also runs with nothing to repair, so its result
   * can never be confused with "no damage found".
   */
  function selfTestSurface(session, config) {
    const note =
      config.debugLog === true && !hasTargetsNow
        ? '（插件自检：surface replace 语义已确认；未修改任何历史）'
        : repairNoteText(config);
    const probe = session.append('user/message', pluginMessage('（surface replace 自检）', SOURCE_RUNTIME_CONTEXT), {
      surfaceOp: 'append',
    });
    const swap = session.append('user/message', pluginMessage(note, SOURCE_RUNTIME_CONTEXT), {
      surfaceOp: { op: 'replace', startSeq: probe.seq, endSeq: probe.seq },
      sourceEventSeqs: [probe.seq],
    });
    const nodes = session.surface.nodes;
    return { ok: !nodes.includes(probe.seq) && nodes.includes(swap.seq), probe: probe.seq, swap: swap.seq };
  }

  /** Shadow one damaged node; verify it left the surface. False ⇒ fail closed. */
  function repairNode(session, seq, config) {
    const note = repairNoteText(config);
    const appended = session.append('user/message', pluginMessage(note, SOURCE_RUNTIME_CONTEXT), {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    });
    const nodes = session.surface.nodes;
    const ok = !nodes.includes(seq) && nodes.includes(appended.seq);
    debug({ where: ok ? 'repair.applied' : 'repair.unverified', seq, appendedSeq: appended.seq });
    return ok;
  }

  function repairSession(agent, sessionId, config) {
    const session = agent && agent.session;
    if (!session || typeof session.append !== 'function' || !session.surface) return;
    let state = repairState.get(sessionId);
    if (!state) {
      state = { tested: false, ok: false, scanned: false };
      repairState.set(sessionId, state);
    }

    // Once per session, scan the whole surface (own nodes included): inherited
    // steps never reach the event feed, and own damage can predate this plugin.
    if (!state.scanned) {
      state.scanned = true;
      try {
        const nodes = session.surface.nodes;
        const cap = 5000;
        let inherited = 0;
        let own = 0;
        for (let i = Math.max(0, nodes.length - cap); i < nodes.length; i += 1) {
          const seq = nodes[i];
          if (session.isOwnSeq(seq)) own += 1;
          else inherited += 1;
          const judge = judgeAssistantEvent(session.eventAt(seq));
          if (judge && judge.scan.damaged === true && judge.toolCallCount === 0) noteDamaged(sessionId, seq);
        }
        debug({ where: 'repair.scanned', sessionId, surfaceNodes: nodes.length, inherited, own, capped: nodes.length > cap });
      } catch {
        /* observation only */
      }
    }

    const targets = damagedSeqs.get(sessionId);
    hasTargetsNow = Boolean(targets) && targets.size > 0;
    if (!hasTargetsNow && (config.debugLog !== true || state.tested)) return;

    if (!state.tested) {
      state.tested = true;
      let result = { ok: false };
      try {
        result = selfTestSurface(session, config);
      } catch (error) {
        debug({ where: 'repair.selfTest.error', sessionId, message: String((error && error.message) || error) });
      }
      state.ok = result.ok === true;
      debug({ where: 'repair.selfTest', sessionId, ok: state.ok, probe: result.probe, swap: result.swap });
      if (!state.ok) return;
    }
    if (state.ok !== true) return;
    if (!hasTargetsNow) return;

    for (const seq of Array.from(targets).slice(0, 20)) {
      try {
        if (!repairNode(session, seq, config)) {
          state.ok = false;
          return;
        }
        targets.delete(seq);
      } catch (error) {
        debug({ where: 'repair.error', sessionId, seq, message: String((error && error.message) || error) });
        state.ok = false;
        return;
      }
    }
  }

  /* M2 — scan parsed arguments before dispatch. */
  install(ctx, () =>
    ctx.on('tools/pre-execute', function preExecute(exec, next) {
      try {
        const config = cfgNow();
        if (config.enabled !== true) return next();
        const runtime = this && typeof this.get === 'function' ? this : ctx.tools || undefined;

        const scanned = scanToolArguments(exec && exec.name, exec && exec.arguments, config);
        if (scanned && scanned.action === 'deny' && typeof scanned.reason === 'string' && scanned.reason) {
          return { kind: 'deny', reason: scanned.reason };
        }

        const emptied = emptyArgumentsDenial(exec, runtime, config);
        if (emptied) return { kind: 'deny', reason: emptied };
      } catch {
        /* degrade: fall through and let the call proceed */
      }
      return next();
    }),
  );

  /* M3 — enrich the normalized result of a suspected no-op write. */
  install(ctx, () =>
    ctx.on('tools/post-execute', async function postExecute(exec, result, next) {
      const decision = await next();
      try {
        const config = cfgNow();
        if (config.enabled !== true || config.noopCheck !== true) return decision;
        const scanned = scanToolResult(exec && exec.name, exec && exec.arguments, result, config);
        if (!scanned || scanned.suspicious !== true) return decision;
        if (!decision || (decision.kind !== 'accept' && decision.kind !== 'block')) return decision;
        const text = typeof scanned.reason === 'string' ? scanned.reason : '';
        if (!text) return decision;
        const existing = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : [];
        return {
          ...decision,
          additionalContexts: [...existing, pluginMessage(text, SOURCE_PLUGIN)],
        };
      } catch {
        return decision;
      }
    }),
  );

  /* M4 observer — remember a silent no-op step in this turn. */
  install(ctx, () =>
    ctx.on('session/event', (...args) => {
      const session = args[0];
      const event = args[1];
      try {
        const config = cfgNow();
        if (config.enabled !== true) return;
        const judge = judgeAssistantEvent(event);
        if (!judge) return;
        const { data, blocks, text, toolCallCount, scan } = judge;

        const sessionId = session && typeof session.id === 'string' ? session.id : '';
        if (!sessionId) return;
        const turn = typeof data.turn === 'number' ? data.turn : -1;

        debug({
          where: 'session/event.scan',
          sessionId,
          turn,
          step: typeof data.step === 'number' ? data.step : null,
          blockTypes: blocks.map((block) => (block && block.type) || null),
          textLength: text.length,
          toolCallCount,
          damaged: scan.damaged,
          silentFailure: scan.silentFailure,
          codes: scan.findings.map((finding) => finding && finding.code),
        });

        if (scan.silentFailure === true) {
          pending.set(sessionId, {
            turn,
            step: typeof data.step === 'number' ? data.step : -1,
            findings: scan.findings,
            codes: scan.findings.map((finding) => finding && finding.code).filter(Boolean),
          });
          if (typeof event.seq === 'number') noteDamaged(sessionId, event.seq);
        } else {
          const previous = pending.get(sessionId);
          if (previous && previous.turn === turn) pending.delete(sessionId);
        }
      } catch {
        /* observer only: a committed append must never be disturbed */
      }
    }),
  );

  /* M4 self-heal + M9 surface repair at turn close. */
  install(ctx, () =>
    ctx.on('agent/turn-stopping', async function turnStopping(payload) {
      try {
        const config = cfgNow();
        if (config.enabled !== true) return;
        const agent = (payload && payload.agent) || this || null;
        if (!agent) {
          debug({ where: 'turn-stopping', reason: 'no-agent', hasPayload: Boolean(payload) });
          return;
        }
        const sessionId = typeof agent.id === 'string' ? agent.id : '';
        const record = sessionId ? pending.get(sessionId) : null;
        const used = sessionId ? corrections.get(sessionId) : null;
        const count = used && used.turn === payload.turn ? used.count : 0;

        debug({
          where: 'turn-stopping',
          sessionId,
          turn: payload.turn,
          hasRecord: Boolean(record),
          pendingSessions: pending.size,
          recordTurn: record ? record.turn : null,
          correctionsUsed: count,
          maxCorrectionsPerTurn: config.maxCorrectionsPerTurn,
          injectType: typeof agent.inject,
        });

        if (!sessionId) return;

        if (config.repairContext === true) repairSession(agent, sessionId, config);

        if (!record || record.turn !== payload.turn) return;
        if (count >= config.maxCorrectionsPerTurn) return;
        if (typeof agent.inject !== 'function') return;

        const tier = count + 1;
        const correction = buildCorrectionMessage(record.findings, config);
        let body = '';
        if (count === 0) {
          body = correction
            ? '【立即执行】上一步想做的工具调用没有被执行。不要解释、不要复述上一段内容，' +
              '直接用更小的分块重新发起那个调用。\n\n' + correction
            : '';
        } else {
          body =
            '【第二次尝试仍失败】你上一步依然没有产生任何工具调用，而是又把内容写成了正文。' +
            '换做法：**这一步只发一个调用**，单个参数**不超过 40 行**；' +
            '不要输出任何解释，也不要把要写的内容直接打在正文里。' +
            (Array.isArray(record.codes) && record.codes.length > 0
              ? '（判定：' + record.codes.join('、') + '）'
              : '');
        }
        if (!body) return;

        const injected = pluginMessage(body, SOURCE_RUNTIME_CONTEXT);
        agent.inject(injected);
        debug({
          where: 'turn-stopping.injected',
          sessionId,
          turn: payload.turn,
          tier,
          textLength: body.length,
        });

        corrections.set(sessionId, { turn: payload.turn, count: tier });
        pending.delete(sessionId);
      } catch {
        /* serial dispatch propagates listener errors into the turn: swallow */
      }
    }),
  );

  /* M7 — fork brief, once per forked session. */
  const briefed = new Set();

  function forkHeadline(agent) {
    try {
      const header = agent && agent.session && agent.session.header;
      if (!header || typeof header !== 'object') return null;
      const parent = typeof header.parentSession === 'string' ? header.parentSession : '';
      if (!parent && header.isSeeded !== true) return null;
      return { parent, seeded: header.isSeeded === true };
    } catch {
      return null;
    }
  }

  function forkBriefText(config) {
    if (config.lang === 'en') {
      return (
        '[Session brief] This session continues from a previous one. If the history ' +
        'contains stray call markup — a `' + '<' + '/` closing prefix, or a parameter ' +
        'opening marker — with no matching tool card, those outputs were DAMAGED and ' +
        'never executed. Ignore them, do not imitate them, and when you need to make a ' +
        'call again, do it in small chunks (<= 100 lines, ideally <= 40).'
      );
    }
    return (
      '【会话简报】本会话继承自上一个会话。若历史里出现**孤立的调用标记**' +
      '（以 `' + '<' + '/` 开头的闭合标记、或参数开场标记）却**没有对应的工具调用卡**，' +
      '那些都是**损坏输出、未执行** —— 请忽略它们、不要模仿，' +
      '需要时用**小块**（≤100 行，必要时 ≤40 行）重新发起调用。'
    );
  }

  install(ctx, () =>
    ctx.on('agent/pre-step', async function preStep(payload, next) {
      const decision = await next();
      try {
        const config = cfgNow();
        if (config.enabled !== true || config.forkBrief !== true) return decision;
        if (!decision || decision.kind !== 'enter') return decision;
        const agent = (payload && payload.agent) || this || null;
        const sessionId = agent && typeof agent.id === 'string' ? agent.id : '';
        if (!sessionId || briefed.has(sessionId)) return decision;
        const head = forkHeadline(agent);
        if (!head) return decision;
        briefed.add(sessionId);
        const noteText = forkBriefText(config);
        const note = pluginMessage(noteText, SOURCE_RUNTIME_CONTEXT);
        debug({
          where: 'pre-step.forkBrief',
          sessionId,
          turn: payload.turn,
          step: payload.step,
          parent: head.parent,
          seeded: head.seeded,
          textLength: noteText.length,
        });
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        return { ...decision, messages: [note, ...messages] };
      } catch {
        return decision;
      }
    }),
  );

  return () => {
    for (const [sessionId] of pending) pending.delete(sessionId);
    for (const [sessionId] of corrections) corrections.delete(sessionId);
    for (const [sessionId] of damagedSeqs) damagedSeqs.delete(sessionId);
    for (const [sessionId] of repairState) repairState.delete(sessionId);
    for (const sessionId of briefed) briefed.delete(sessionId);
  };
}
