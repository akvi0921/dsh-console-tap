/**
 * console-tap —— 宿主侧:把"助手执行的命令 + 它的控制台输出"完整采集并实时推送。
 * ---------------------------------------------------------------------------
 * 需求(逐条对应实现):
 *   ① 命令本身      → 从 tool/call 事件拿 sessionId/callId/命令原文,与 spawn 的 argv 精确匹配
 *   ② 输出了什么    → stdout / stderr 两条流分开采集
 *   ③ 完整          → 增量读 + 溢出时用 spill 文件(官方保证含从第 0 字节起的全量)补缺口
 *   ④ 收集并推送    → 自建 WebSocket 端点(官方 registerUpgrade,与 /api/events.mux 同一套 API)
 *
 * 设计原则(为什么这样做):
 *   - **不替换任何官方组合行**:官方 provider 原样保留,我们只是给**活的服务实例**的
 *     `spawn` 包一层(原型方法 → 可逆打补丁)。包装失败/插件卸载都能还原,官方行为不变。
 *   - **不抢输出**:用的读取接口是 `handle.collected.stdout.readFrom(offset)`,官方注释明确
 *     "independent readers cannot consume one another's output" → 模型/工具看到的输出一个字节不变。
 *   - **不改上限**:`maxOutputBytes`(模型可见的 64KB)故意不动;全量靠 spill 文件拿。
 *   - 一切都在 try/catch 里:任何异常只记日志,绝不影响 harness 执行命令。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, openSync, readSync, closeSync, writeSync, writeFileSync, appendFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { Context } from '@deepseek-ai/cordis';

export const name = 'console-tap';

/**
 * 声明式 inject(必须声明):
 *   ① `webServer` / `subprocess` 是挂载所必需的服务 —— 声明后 Cordis 会**等到服务就位**再调 apply;
 *      不声明就会在全新启动的进程里"服务还没注册就被 apply"(实测:探针显示两个服务都是 undefined,
 *      且读 `ctx.config` 直接抛 `cannot get property "config" without inject`)。
 *   ② `ctx.config` 的读取同样以 inject 为前提,所以 config 也必须走声明式。
 * 热插入路径下 apply 不会被调用,由文件末尾的自举兜底(自举会重试到服务就位再挂)。
 */
export const inject = ['webServer', 'subprocess'];

// 单实例保护:同一进程内,本模块可能被两条组合行(相对文件路径 + 裸包名)各求值一次,
// 或 HMR 重载时重复实例化。用 realm 级 Symbol 保证只有第一个实例真正打补丁。
const CONSOLE_TAP_SINGLETON = Symbol.for('dsh.console-tap.instance');

/** 实现版本号:同进程内被 import 到更高版本时,会把**运行中的实例**就地升级(见文件末尾)。 */
const REV = 12;

/** 进程级注册表键(挂在 process 上:同一进程里所有模块实例都能看到)。 */
const REGISTRY_KEY = Symbol.for('dsh.console-tap.registry');

/**
 * 进程级注册表。为什么需要:补丁层热插入的行会被 DSH **重新 import**(改一次补丁就求值一次),
 * 每求值一次就多一个"实现版本";没有注册表就会重复打 spawn 补丁、重复注册路由
 * (官方 webServer 对重复路由是**抛错**的:webserver: duplicate upgrade route)。
 */
function registry() {
  const holder = typeof process !== 'undefined' ? process : globalThis;
  if (holder[REGISTRY_KEY] === undefined) {
    holder[REGISTRY_KEY] = { instance: null, ok: false, rev: 0, upgrades: 0, at: 0, via: '' };
  }
  return holder[REGISTRY_KEY];
}

/**
 * 同进程热升级:已有实例在跑且版本不同 → **就地**把运行中的实例升到新实现
 * (重绑原型方法 + 合并配置),不新挂一份。这样"改一次补丁就多一份实现"不会累积。
 * @returns 是否完成升级。
 */
function tryHotUpgrade() {
  const reg = registry();
  if (reg.ok !== true || reg.instance === null || reg.instance === undefined) return false;
  if (reg.rev === REV) return false;
  const proto = Object.getPrototypeOf(reg.instance);
  for (const key of Object.getOwnPropertyNames(ConsoleTap.prototype)) {
    if (key === 'constructor') continue;
    proto[key] = ConsoleTap.prototype[key];
  }
  reg.instance.cfg = { ...reg.instance.cfg, ...DEFAULTS };
  reg.rev = REV;
  reg.upgrades += 1;
  reg.upgradedAt = new Date().toISOString();
  return true;
}

/** 本插件当前使用的行名(其它同前缀的名字一律视为本插件的历史遗留)。 */
const OWN_ROW_NAMES = new Set(['@local/dsh-console-tap-ui', './plugins/console-tap/lib/host.js']);
/** 判断某个行名是否属于本插件(含历史版本用过的名字)。 */
function isOwnRowName(name) {
  if (typeof name !== 'string') return false;
  if (OWN_ROW_NAMES.has(name)) return true;
  if (name.includes('plugins/console-tap')) return true;
  return /^@local\/dsh-console-tap(\d+|-\w+)?$/.test(name);
}

/**
 * 清掉本插件**旧名字**在 dsh-client-modules 里残留的行。
 *
 * 为什么必须清:浏览器侧模块系统对 boot 清单里每一行都要求
 * `bundle <url> 必须注册 id`(见 dsh-client-modules 客户端 loadRow),
 * 旧名字的行指向同一个 bundle 却要求不同的 id → **页面启动直接报错**。
 * 开发期我们换过几次包名,残留行就属于这种情况(进程重启后不会有)。
 * 做法:把"本插件名字但已不在 loader 里"的项标脏,再让官方 registry 自己重扫删除。
 */
function dropStaleClientRows(ctx, status) {
  try {
    const registry = ctx.get('clientModules');
    if (registry === undefined || registry.table === undefined || typeof registry.flush !== 'function') return;
    const loader = ctx.get('loader');
    const live = new Set();
    let raw = typeof loader?.entries === 'function' ? loader.entries() : [];
    if (raw !== null && typeof raw.slice !== 'function') raw = typeof raw?.values === 'function' ? [...raw.values()] : [...raw];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry?.options?.name === 'string') live.add(entry.options.name);
    }
    let dropped = 0;
    for (const name of [...registry.table.keys()]) {
      if (!isOwnRowName(name) || live.has(name)) continue;
      registry.dirty.add(name);
      dropped += 1;
    }
    if (dropped > 0) {
      registry.flush((error) => status.mark('client-rows:flush-warning', msg(error)));
      status.mark('client-rows:dropped-stale', `清理旧名字的 boot 行 ${dropped} 条`);
    }
  } catch (error) {
    status.mark('client-rows:failed', msg(error));
  }
}

/**
 * 回收本插件上一实例遗留的同名路由。
 *
 * 只在"上一实例已失联"(拿不到它的 disposer)时才需要:官方 webServer 对重复路由直接抛错,
 * 不回收就会导致新实例挂载失败。这里删除的路径**只可能是本插件自己的固定路径**。
 */
function reclaimOwnRoutes(ctx, status) {
  try {
    const webServer = ctx.get('webServer');
    if (webServer === undefined) return;
    for (const [table, path, label] of [
      [webServer.upgrades, DEFAULTS.path, 'WS'],
      [webServer.exact, '/api/console/status', 'status'],
    ]) {
      if (table !== undefined && typeof table.delete === 'function' && table.has(path)) {
        table.delete(path);
        status.mark('route:reclaimed', `清掉上一实例遗留的 ${label} 路由 ${path}`);
      }
    }
  } catch (error) {
    status.mark('route:reclaim-failed', msg(error));
  }
}

/** 默认配置(可在 cordis.patch.yml 的该行 config: 里覆盖)。 */
const DEFAULTS = {
  /** WS 路径(与 /api/events.mux 同级,同源、只监听回环)。 */
  path: '/api/console',
  /** 采集轮询间隔(ms)。越小越实时,越大越省电。 */
  pollMs: 150,
  /** 每条流在内存里保留的最近字节数(订阅者中途接入时用它做快照)。 */
  memoryBytes: 256 * 1024,
  /** 单条流写盘上限(字节);0 = 不写盘。 */
  fileLogBytes: 64 * 1024 * 1024,
  /** 写盘目录(null = $DSH_HOME/console-logs)。 */
  logDir: null,
  /** true = 把每次 readFrom 的真实返回追加到 <traceDir>/console-tap-drain.jsonl(排查完整性用)。 */
  trace: false,
  /** 诊断落盘目录(null = $DSH_HOME)。 */
  traceDir: null,
  /** 只推送这些工具的进程(null = 全部进程都推)。 */
  tools: null,
  /** tool/call 与 spawn 的最大匹配窗口(ms),超出只能标低置信。 */
  matchWindowMs: 15_000,
};

/** 是否已挂载(模块级;apply 与自举共用一个标记,保证只挂一次)。 */
let mounted = false;

/** 挂载入口:Cordis 正常调用 apply 时走这里。 */
export function apply(ctx) {
  mount(ctx, 'apply');
}

/**
 * 真正挂载。`apply()`(开机路径)与"自举"(热插入兜底路径)都调它,只生效一次。
 *
 * 为什么需要"自举":组合补丁**热插入**的行,DSH 会 import 本模块,但父 include 的
 * 事务不会 settle → Cordis 永远不调 apply(实测:import 阶段能写盘、apply 阶段零调用;
 * 官方 file-output-format 正常是因为它在开机时插入,走正常启动路径)。
 * 具体见文件末尾 bootstrapSelfMount()。
 */
function mount(ctx, via, overrideConfig) {
  if (mounted) return;
  if (tryHotUpgrade()) {
    mounted = true;
    return;
  }
  const reg = registry();
  if (reg.ok === true && reg.rev === REV) {
    mounted = true;
    return;
  }
  reg.at = Date.now();
  reg.via = via;
  reg.rev = REV;
  reg.ok = false;
  mounted = true;

  const log = makeLogger(ctx);
  const status = createStatus(ctx);
  status.mark(`mount:${via}`);
  let probeWebServer = 'n/a';
  let probeSubprocess = 'n/a';
  try {
    probeWebServer = typeof ctx.get('webServer');
    probeSubprocess = typeof ctx.get('subprocess');
  } catch (error) {
    status.mark('mount:probe-failed', msg(error));
  }
  status.setProbe({ via, webServer: probeWebServer, subprocess: probeSubprocess });

  let tap;
  try {
    let entryConfig = {};
    try {
      entryConfig = ctx.config ?? {};
    } catch {
      entryConfig = {}; // 声明式 inject 缺失时读 config 会抛;此处只降级为默认配置
    }
    tap = new ConsoleTap(ctx, { ...DEFAULTS, ...(overrideConfig ?? {}), ...entryConfig }, log, status);
  } catch (error) {
    status.mark('mount:init-failed', msg(error));
    log.warn(`console-tap: 初始化失败,已停用(${msg(error)})`);
    return;
  }

  // 上一实例若已失联,它注册的路由还占着路径 → 先回收,否则官方会以"重复路由"抛错
  reclaimOwnRoutes(ctx, status);
  // 旧名字的 boot 行会让浏览器模块系统报错 → 清掉
  dropStaleClientRows(ctx, status);

  // 诊断端点:HTTP GET /api/console/status(纯只读,便于不开浏览器就能自查挂载情况)
  try {
    const webServer = ctx.get('webServer');
    if (webServer !== undefined && typeof webServer.register === 'function') {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/console/status',
        handler: (req, res) => {
          if (!isTrustedRequest(req)) {
            res.writeHead(403);
            res.end('forbidden');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(status.snapshot(), null, 2));
        },
      }), 'console-tap: 诊断路由');
      status.mark('route:status-registered');
    } else {
      status.mark('route:status-skipped', 'webServer.register 不可用');
    }
  } catch (error) {
    status.mark('route:status-failed', msg(error));
  }

  // ① 给子进程服务的实例方法打补丁(可逆)
  ctx.effect(() => tap.attachSubprocess(), 'console-tap: subprocess.spawn 包装');

  // ② 会话事件:tool/call 提供"这是哪次调用、命令原文是什么"
  ctx.effect(
    () => ctx.on('session/event', (session, event) => tap.onSessionEvent(session, event)),
    'console-tap: tool/call 关联',
  );

  // ③ 自建 WebSocket 下行(官方同一套 registerUpgrade API)
  ctx.effect(() => tap.registerRoute(), 'console-tap: WS 路由');

  // ④ 采集循环
  ctx.effect(() => tap.startPolling(), 'console-tap: 采集循环');

  if (reg.instance === null || reg.instance === undefined) reg.instance = tap;
  reg.ok = true; // 只有挂载**成功**才置位:中途失败的实例不会挡住后来者
  status.mark('mount:done', `path=${tap.cfg.path} pollMs=${tap.cfg.pollMs} via=${via} rev=${REV}`);
  log.info(`console-tap: 已挂载(via=${via}, path=${tap.cfg.path}, pollMs=${tap.cfg.pollMs})`);
}

// ===========================================================================

class ConsoleTap {
  constructor(ctx, cfg, log, status) {
    this.ctx = ctx;
    this.cfg = cfg;
    if (this.cfg.traceDir === null) this.cfg.traceDir = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    this.log = log;
    this.status = status ?? createStatus(ctx);
    /** 活着的/已结束但仍在保留期内的流。 */
    this.streams = new Map();
    /** 订阅者(WebSocket)。 */
    this.clients = new Set();
    /** 待匹配的工具调用:命令原文 → 身份(tool/call 先到,spawn 随后)。 */
    this.pendingCalls = [];
    this.seq = 0;
    this.pollTimer = null;
    this.logDir = cfg.logDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'console-logs');
    if (cfg.fileLogBytes > 0) {
      try {
        mkdirSync(this.logDir, { recursive: true });
      } catch (error) {
        this.log.warn(`console-tap: 日志目录不可用(${msg(error)}),改为只保留内存`);
        this.cfg.fileLogBytes = 0;
      }
    }
  }

  // ---------------------------------------------------------------- 包装

  /**
   * 给 `ctx.subprocess.spawn` 包一层:原始方法照常调用、返回值原样透传,
   * 只额外登记 handle。返回还原函数(卸载/热重载时恢复原方法)。
   */
  attachSubprocess() {
    const rt = this.ctx.get('subprocess');
    if (rt === undefined || typeof rt.spawn !== 'function') {
      this.status.mark('subprocess:missing', '拿不到 subprocess.spawn');
      this.log.warn('console-tap: 拿不到 subprocess.spawn,本次不采集');
      return () => {};
    }
    const tap = this;
    const original = rt.spawn;
    const patched = function patchedSpawn(spec) {
      const handle = original.apply(this, arguments);
      try {
        tap.track(handle, spec);
      } catch (error) {
        tap.log.warn(`console-tap: 登记进程失败(${msg(error)})`);
      }
      return handle;
    };
    rt.spawn = patched;
    this.wrapped = true;
    this.status.mark('subprocess:patched');
    this.log.info('console-tap: subprocess.spawn 已包装');
    return () => {
      if (rt.spawn === patched) rt.spawn = original;
    };
  }

  /** 登记一条新进程:建立两条流的记录,并在进程结束时收尾。 */
  track(handle, spec) {
    if (handle === null || typeof handle !== 'object') return;
    const collected = handle.collected ?? {};
    if (collected.stdout === undefined && collected.stderr === undefined) return; // 非 collect 模式:没有可读输出

    const id = `c${++this.seq}`;
    const identity = this.matchIdentity(spec);
    const rec = {
      id,
      at: Date.now(),
      argv: Array.isArray(spec?.argv) ? spec.argv.map(String) : [],
      command: commandOf(spec),
      cwd: typeof spec?.cwd === 'string' ? spec.cwd : '',
      identity,
      done: false,
      exitCode: null,
      signal: null,
      readers: { stdout: collected.stdout, stderr: collected.stderr },
      offset: { stdout: 0, stderr: 0 }, // 已投递到订阅者的字节数(我们的游标)
      spill: { stdout: undefined, stderr: undefined },
      spillFrom: { stdout: 0, stderr: 0 }, // spill 文件里的读取游标(null = 与已投递字节不再对齐)
      spillFd: { stdout: null, stderr: null },
      bytes: { stdout: 0, stderr: 0 },
      head: { stdout: '', stderr: '' }, // 内存里保留的最近一段
      logFd: null,
    };
    this.streams.set(id, rec);

    if (this.cfg.fileLogBytes > 0) {
      try {
        const safe = `${new Date(rec.at).toISOString().replace(/[:.]/g, '-')}-${id}.log`;
        rec.logPath = join(this.logDir, safe);
        rec.logFd = openSync(rec.logPath, 'a');
      } catch (error) {
        this.log.warn(`console-tap: 建日志文件失败(${msg(error)})`);
        rec.logFd = null;
      }
    }

    this.broadcast({ type: 'command-start', ...this.publicView(rec) });

    if (handle.done !== undefined && typeof handle.done.then === 'function') {
      handle.done.then(
        (outcome) => this.finish(rec, outcome),
        (error) => this.finish(rec, { exitCode: null, signal: null, error: msg(error) }),
      );
    }
  }

  /** 进程结束:把剩余输出读干,再广播 command-end。 */
  finish(rec, outcome) {
    if (rec.done) return;
    rec.done = true;
    try {
      // 收尾必须"读干":spill 模式下每轮 64KiB,一轮不够 —— 这里会一直读到追平为止。
      this.drain(rec, 'stdout');
      this.drain(rec, 'stderr');
    } catch (error) {
      this.log.warn(`console-tap: 收尾读取失败(${msg(error)})`);
    }
    rec.exitCode = outcome?.exitCode ?? null;
    rec.signal = outcome?.signal ?? null;
    rec.ms = Date.now() - rec.at;
    for (const which of ['stdout', 'stderr']) {
      if (rec.logFd !== null) {
        try {
          writeSync(rec.logFd, `\n--- ${which} end ---\n`);
        } catch {}
      }
    }
    if (rec.logFd !== null) {
      try {
        closeSync(rec.logFd);
      } catch {}
      rec.logFd = null;
    }
    for (const which of ['stdout', 'stderr']) {
      if (rec.spillFd[which] !== null) {
        try {
          closeSync(rec.spillFd[which]);
        } catch {}
        rec.spillFd[which] = null;
      }
    }
    this.broadcast({
      type: 'command-end',
      id: rec.id,
      at: Date.now(),
      exitCode: rec.exitCode,
      signal: rec.signal,
      ms: rec.ms ?? 0,
      bytes: { ...rec.bytes },
      logPath: rec.logPath ?? null,
    });
    this.forget(rec);
  }

  /** 保留一小段时间后回收(让中途接入的订阅者还能拿到尾部快照)。 */
  forget(rec) {
    this.streams.set(rec.id, rec); // 仍在表里,但已 done
    const timer = setTimeout(() => {
      if (this.streams.get(rec.id) === rec && rec.done) this.streams.delete(rec.id);
    }, 60_000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // ---------------------------------------------------------------- 采集

  startPolling() {
    const tick = () => {
      for (const rec of this.streams.values()) {
        if (rec.done) continue;
        try {
          this.drain(rec, 'stdout');
          this.drain(rec, 'stderr');
        } catch (error) {
          this.log.warn(`console-tap: 采集异常(${msg(error)})`);
        }
      }
    };
    this.pollTimer = setInterval(tick, Math.max(20, this.cfg.pollMs));
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    return () => {
      if (this.pollTimer !== null) clearInterval(this.pollTimer);
      this.pollTimer = null;
    };
  }

  /**
   * 读一条流的增量并投递。
   *
   * 两条路径:
   *   - 平常:`readFrom(offset)` 增量(游标无关,非消费);
   *   - 一旦出现 spill 文件:**改从 spill 文件按我们自己的字节游标读** ——
   *     官方保证 spill 含"从第 0 字节起"的全量(含已进内存的那些),
   *     所以它是唯一能保证"完整"的来源(内存只保留尾部 64KB,窗口会滑走)。
   */
  drain(rec, which) {
    // 循环读直到"追平":spill 模式下每次最多 64KiB,只读一次会丢尾巴。
    // 上限 512 次(≈32MiB/流)只用于防御病态情况,正常一两次就追平。
    for (let i = 0; i < 512; i += 1) {
      let progressed = false;
      try {
        progressed = this.drainOnce(rec, which);
      } catch (error) {
        this.log.warn(`console-tap: 采集异常(${msg(error)})`);
        return;
      }
      if (!progressed) return;
    }
  }

  /** 读一轮。@returns 是否有进展(投递了字节,或刚切到 spill 模式)。 */
  drainOnce(rec, which) {
    const reader = rec.readers[which];
    if (reader === undefined || reader === null) return false;

    // spill 可用 → 优先按文件游标读(完整且单调)
    const spillPath = rec.spill[which] ?? undefined;
    if (spillPath !== undefined && rec.spillFd[which] !== null) {
      return this.drainFromSpill(rec, which, rec.spillFd[which]);
    }

    const read = reader.readFrom(rec.offset[which]);
    if (read === undefined || read === null) return false;
    this.trace(rec, which, read);
    if (read.spillPath !== undefined && read.spillPath !== null) {
      rec.spill[which] = read.spillPath;
      try {
        rec.spillFd[which] = openSync(read.spillPath, 'r');
        // 切到 spill 模式:完整流以文件为准(文件含从第 0 字节起的全量),
        // read.text 是"内存尾窗"(可能已经缺头),此时**不能**直接投递它,否则顺序就乱了。
        const delivered = this.drainFromSpill(rec, which, rec.spillFd[which]);
        rec.offset[which] = rec.bytes[which];
        void delivered;
        return true;
      } catch (error) {
        this.log.warn(`console-tap: 打不开 spill 文件(${msg(error)}),退回内存增量`);
        rec.spillFd[which] = null;
      }
    }
    if (read.lossy === true) {
      // 内存窗口滑走且没有 spill:如实告知缺口,不假装完整
      this.broadcast({
        type: 'gap',
        id: rec.id,
        stream: which,
        fromByte: rec.offset[which],
        toByte: rec.offset[which] + 1,
        source: 'memory',
        note: '内存窗口已滑走且无 spill 文件,这段字节无法恢复',
      });
    }
    if (typeof read.text === 'string' && read.text.length > 0) {
      this.deliver(rec, which, read.text);
      if (read.lossy === true) rec.spillFrom[which] = null; // 已投递的尾部不再与文件起点对齐
    }
    rec.offset[which] = read.nextOffset;
    return typeof read.text === 'string' && read.text.length > 0;
  }

  /** 临时诊断:把每次 readFrom 的真实返回落盘(开发期定位"完整性"问题用)。 */
  trace(rec, which, read) {
    if (this.cfg.trace !== true) return;
    try {
      appendFileSync(
        join(this.cfg.traceDir, 'console-tap-drain.jsonl'),
        `${JSON.stringify({
          at: Date.now(), id: rec.id, which,
          ourOffset: rec.offset[which], ourBytes: rec.bytes[which],
          nextOffset: read.nextOffset, lossy: read.lossy === true,
          textLen: typeof read.text === 'string' ? Buffer.byteLength(read.text) : -1,
          spillPath: read.spillPath ?? null,
        })}\n`,
      );
    } catch {}
  }

  /**
   * 从 spill 文件按**文件字节游标**继续读。
   *
   * 为什么以文件为准:官方 spill 文件里是"从流第 0 字节开始的全量"(见
   * dsh-subprocess-local 的 OutputCollector.push/spillAll),而内存只保留尾部窗口
   * (readFrom 在窗口滑走时只回尾窗,并置 lossy)。所以一旦有 spill,就以文件为唯一来源,
   * 按我们自己的游标一段段读,保证**不丢、不重、顺序正确**。
   * @returns 是否读到新字节。
   */
  drainFromSpill(rec, which, fd) {
    const cursor = rec.spillFrom[which];
    const from = cursor ?? 0;
    const chunk = readUpTo(fd, from, 64 * 1024);
    if (chunk.length === 0) return false;
    if (cursor === null) {
      // 之前只拿到过"内存尾窗"(与文件起点不对齐):现在改用文件全量重放,如实标注
      this.broadcast({
        type: 'gap',
        id: rec.id,
        stream: which,
        fromByte: 0,
        toByte: from,
        source: 'spill',
        note: '已改用 spill 文件全量重放(此前的内存尾窗可能与之重叠)',
      });
      rec.spillFrom[which] = 0;
    }
    this.deliver(rec, which, chunk);
    rec.spillFrom[which] = from + Buffer.byteLength(chunk);
    rec.offset[which] = rec.bytes[which];
    return true;
  }

  /** 真正把一段文本推给订阅者 + 写盘 + 更新内存尾窗。 */
  deliver(rec, which, text) {
    rec.bytes[which] += Buffer.byteLength(text);
    // 内存尾窗
    const head = rec.head[which] + text;
    rec.head[which] = head.length > this.cfg.memoryBytes ? head.slice(head.length - this.cfg.memoryBytes) : head;
    // 写盘
    if (rec.logFd !== null) {
      try {
        writeSync(rec.logFd, text);
      } catch (error) {
        this.log.warn(`console-tap: 写日志失败(${msg(error)})`);
      }
    }
    this.broadcast({
      type: 'chunk',
      id: rec.id,
      stream: which,
      seq: rec.bytes[which],
      text,
    });
  }

  // ---------------------------------------------------------------- 身份

  /** tool/call 事件:记下"哪次调用、什么命令"。 */
  onSessionEvent(session, event) {
    try {
      if (event?.type !== 'tool/call') return;
      const data = event.data ?? {};
      const args = parseArgs(data.arguments);
      const command = typeof args?.command === 'string' ? args.command : '';
      this.pendingCalls.push({
        sessionId: session?.id ?? data.sessionId ?? '',
        callId: data.callId ?? '',
        tool: data.name ?? '',
        command,
        at: Date.now(),
      });
      const cutoff = Date.now() - this.cfg.matchWindowMs;
      this.pendingCalls = this.pendingCalls.filter((c) => c.at >= cutoff);
    } catch (error) {
      this.log.warn(`console-tap: 解析 tool/call 失败(${msg(error)})`);
    }
  }

  /** 用命令原文做**等值匹配**(bash 工具把命令原样交给 `bash -c`,argv 里就带着它)。 */
  matchIdentity(spec) {
    const now = Date.now();
    this.pendingCalls = this.pendingCalls.filter((c) => now - c.at <= this.cfg.matchWindowMs);
    const command = commandOf(spec);
    let hit = null;
    if (command !== '') {
      const index = this.pendingCalls.findIndex((c) => c.command === command);
      if (index !== -1) {
        hit = this.pendingCalls.splice(index, 1)[0];
        return { ...pickIdentity(hit), confidence: 'exact' };
      }
    }
    // 非 bash 工具起的进程 / 命令串对不上:拿最近一次未被认领的调用标注,并如实标低置信
    const near = this.pendingCalls.find((c) => now - c.at <= 3_000);
    if (near !== undefined) return { ...pickIdentity(near), confidence: 'nearby' };
    return { sessionId: '', callId: '', tool: '', confidence: 'none' };
  }

  // ---------------------------------------------------------------- 推送

  registerRoute() {
    const wss = new WebSocketServer({ noServer: true });
    const path = this.cfg.path;
    // 用 ctx.get 显式取服务(比属性访问更稳:测试替身与 isolate 场景都成立)
    const webServer = this.ctx.get('webServer') ?? this.ctx.webServer;
    if (webServer === undefined || typeof webServer.registerUpgrade !== 'function') {
      this.status.mark('route:ws-missing', '拿不到 webServer.registerUpgrade');
      this.log.warn('console-tap: 拿不到 webServer.registerUpgrade,推送通道未建立');
      return () => {};
    }
    const dispose = webServer.registerUpgrade({
      path,
      handler: (req, socket, head) => {
        if (!isTrustedRequest(req)) {
          this.log.warn(`console-tap: 拒绝非回环请求(${req.headers?.host ?? '?'})`);
          try {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          } catch {}
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.clients.add(ws);
          try {
            ws.send(JSON.stringify({
              type: 'hello',
              version: 1,
              pollMs: this.cfg.pollMs,
              live: [...this.streams.values()].filter((r) => !r.done).map((r) => this.publicView(r)),
            }));
          } catch {}
          ws.on('message', (raw) => this.onClientMessage(ws, raw));
          ws.on('close', () => this.clients.delete(ws));
          ws.on('error', () => this.clients.delete(ws));
        });
      },
    });
    this.status.mark('route:ws-registered', path);
    return () => {
      dispose();
      for (const ws of this.clients) {
        try {
          ws.close();
        } catch {}
      }
      this.clients.clear();
      try {
        wss.close();
      } catch {}
    };
  }

  onClientMessage(ws, raw) {
    try {
      const frame = JSON.parse(String(raw));
      if (frame?.type === 'snapshot-request' && typeof frame.id === 'string') {
        const rec = this.streams.get(frame.id);
        if (rec === undefined) return;
        const which = frame.stream === 'stderr' ? 'stderr' : 'stdout';
        const head = rec.head[which];
        ws.send(JSON.stringify({
          type: 'snapshot',
          id: rec.id,
          stream: which,
          bytes: rec.bytes[which],
          truncated: rec.bytes[which] > Buffer.byteLength(head),
          text: head,
        }));
        return;
      }
      if (frame?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    } catch {
      /* 忽略坏帧 */
    }
  }

  publicView(rec) {
    return {
      id: rec.id,
      at: rec.at,
      command: rec.command,
      argv: rec.argv,
      cwd: rec.cwd,
      sessionId: rec.identity.sessionId,
      callId: rec.identity.callId,
      tool: rec.identity.tool,
      confidence: rec.identity.confidence,
      logPath: rec.logPath ?? null,
    };
  }

  broadcast(frame) {
    if (this.clients.size === 0) return;
    const text = JSON.stringify(frame);
    for (const ws of this.clients) {
      try {
        if (ws.readyState === 1) ws.send(text);
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}

// ============================== 工具函数 =================================

/** 从 spawn spec 还原"命令原文":bash 工具是 `bash -c <命令>`,所以末位参数就是它。 */
function commandOf(spec) {
  const argv = Array.isArray(spec?.argv) ? spec.argv : [];
  if (argv.length === 0) return '';
  return String(argv[argv.length - 1]);
}

function pickIdentity(call) {
  return { sessionId: call.sessionId, callId: call.callId, tool: call.tool };
}

function parseArgs(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 从 fd 的绝对偏移 from 读一段(最多 max 字节),返回 utf8 文本。
 *
 * <p>用 `readSync` 的 position 参数做"按绝对偏移读"——不改变 fd 的共享游标,
 * 所以 spill 文件边写边读也安全;越界(还没写到那么远)时返回空串。
 */
function readUpTo(fd, from, max) {
  const buffer = Buffer.allocUnsafe(max);
  let total = 0;
  try {
    total = readSync(fd, buffer, 0, max, from);
  } catch {
    return '';
  }
  if (total <= 0) return '';
  return buffer.subarray(0, total).toString('utf8');
}

/** 只信任本机回环请求(Host 头必须是回环地址;有 Origin 时必须与 Host 同源)。 */
function isTrustedRequest(req) {
  const host = String(req?.headers?.host ?? '');
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!loopback) return false;
  if (String(req?.headers?.['sec-fetch-site'] ?? '') === 'cross-site') return false;
  const origin = req?.headers?.origin;
  if (origin === undefined) return true;
  try {
    return new URL(String(origin)).host === host;
  } catch {
    return false;
  }
}

/** 挂载诊断:阶段打点 + 可选落盘(host stdout 看不到时,靠它排查)。 */
function createStatus(ctx) {
  const marks = [];
  const startedAt = Date.now();
  let wrapped = null;
  let probe = null;
  return {
    mark(phase, detail) {
      marks.push({ at: Date.now() - startedAt, phase, ...(detail === undefined ? {} : { detail }) });
      this.persist();
    },
    setWrapped(value) {
      wrapped = value;
      this.persist();
    },
    setProbe(value) {
      probe = value;
      this.persist();
    },
    snapshot() {
      return {
        plugin: 'console-tap',
        startedAt,
        uptimeMs: Date.now() - startedAt,
        marks,
        wrapped,
        probe,
      };
    },
    persist() {
      try {
        const dir = process.env.DSH_HOME ?? join(homedir(), '.dsh');
        writeFileSync(join(dir, 'console-tap-status.json'), JSON.stringify(this.snapshot(), null, 2));
      } catch {
        /* 打点失败不影响主流程 */
      }
    },
  };
}

function makeLogger(ctx) {
  const logger = ctx?.logger;
  const wrap = (fn, fallback) => (typeof fn === 'function' ? fn.bind(logger) : fallback);
  return {
    info: wrap(logger?.info, () => {}),
    warn: wrap(logger?.warn, () => {}),
  };
}

function msg(error) {
  return error instanceof Error ? error.message : String(error);
}

// ===========================================================================
// 自举挂载(bootstrapSelfMount)—— 热插入兜底路径
// ---------------------------------------------------------------------------
// 事实(本机实测,Node 26.4.0 + 本机 DSH):
//   · 补丁层热插入的行:模块会被 import(import 阶段的副作用能落盘),
//     但父 include 的事务不 settle → Cordis 不调用 apply。
//   · 同一个文件若在**开机时**插入,则一切正常。
// 因此本插件在 import 时就自己找 ctx:Context.prototype.extend/isolate/intercept
// 是 cordis 里稳定可达的原型方法(其余 get/on/effect 都是服务注入的、不在原型上),
// 挂一个一次性钩子,拿到 root ctx 后立刻还原原型,再调 mount()。
// 开机路径下 Cordis 会先调 apply(mounted 已置位),自举直接退出,互不干扰。
// ===========================================================================
function mountViaBootstrap() {
  if (mounted) return;
  const deadline = Date.now() + 60_000;
  const names = ['extend', 'isolate', 'intercept'];
  const originals = new Map();
  let candidate = null;
  let settled = false;
  let timer = null;

  const restore = () => {
    for (const [key, fn] of originals) {
      if (Context.prototype[key]?.__consoleTapHook) Context.prototype[key] = fn;
    }
    originals.clear();
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    restore();
  };
  /** 服务是否已经就位(挂载需要 webServer + subprocess 两个服务)。 */
  const servicesReady = (ctx) => {
    try {
      return ctx.get('webServer') !== undefined && ctx.get('subprocess') !== undefined;
    } catch {
      return false;
    }
  };
  /**
   * 尝试挂载。**必须重试**:本模块是在启动过程中被 import 的,
   * 第一次拿到的 ctx 往往**早于服务注册**(此时 get('webServer') 还是 undefined),
   * 只试一次就会"挂上一个没有服务的空壳"(实测在全新启动的进程里正是如此)。
   */
  const attempt = () => {
    if (mounted) { finish(); return; }
    if (candidate === null) return;
    if (Date.now() > deadline) {
      finish();
      reportSelfMount(`ctx 一直拿不到服务(webServer/subprocess),已放弃自举`);
      return;
    }
    if (!servicesReady(candidate)) return;
    finish();
    try {
      mount(candidate, 'self-mount');
    } catch (error) {
      reportSelfMount(msg(error));
    }
  };

  for (const key of names) {
    const original = Context.prototype[key];
    if (typeof original !== 'function') continue;
    originals.set(key, original);
    const patched = function (...args) {
      try {
        if (!mounted && !settled) {
          const ctx = candidate ?? (this?.root ?? this);
          if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') {
            candidate = ctx;
            attempt();
          }
        }
      } catch {}
      return original.apply(this, args);
    };
    patched.__consoleTapHook = true;
    Context.prototype[key] = patched;
  }
  timer = setInterval(attempt, 200);
  timer.unref?.();
}

/** 自举失败时留一条落盘痕迹(host 的 stdout 看不到,只能靠文件)。 */
function reportSelfMount(detail) {
  try {
    writeFileSync(
      join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'console-tap-selfmount-error.json'),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, detail }, null, 2),
    );
  } catch {}
}

// 同进程热升级:补丁层热插入的模块,模块级 import 是可靠的(apply 才不可靠)。
// 所以新版本代码被 import 时,直接把**运行中的实例**升级到新实现 —— 无需重启进程。
let upgraded = false;
try {
  upgraded = tryHotUpgrade();
  if (upgraded) {
    mounted = true;
    // 热升级路径同样要清掉旧名字的行(此时用运行中实例的 ctx)
    try {
      const live = registry().instance;
      if (live?.status !== undefined) dropStaleClientRows(live.ctx, live.status);
    } catch {}
  }
} catch {}

// 让 Cordis 的 apply 先有机会跑(开机路径);热插入路径下 apply 不会来,则由自举接管。
// 注意:这里**同步**装钩子 —— 实测热插入的模块所在 realm 里 setTimeout 可能不可用。
if (!upgraded) try { mountViaBootstrap(); } catch (error) {
}
