/**
 * SpecRune — Pi Agent 扩展
 *
 * 职责边界（有意做窄）：这个文件不做任何领域逻辑。
 * 会话上下文编译、任务状态推导、注入快照留存，全部在 Go 侧；子代理的运输层
 * 可插拔（SubagentTransport 接口，req:injection-chain#subagent-dispatch / req:subagents#subagent-transport-compat）：GG 与 NB 双适配器，每次派发
 * 现场探测、探测到哪个用哪个。扩展只做四件事：
 *   1. 解析项目根；
 *   2. 按 Pi 的事件契约转发；
 *   3. 把结果摆到 Pi 能消费的位置；
 *   4. 派发子代理：先异步调 `context compile` 拿编译产物与快照 id，
 *      再交给所选适配器起子会话，经通用等待编排收敛终态。
 *
 * 上游 Trellis 的等价扩展有 2100 余行，因为它在扩展进程内重新实现了一遍
 * 上下文编译（YAML 解析、JSONL 读取、路径归一化）。那份实现与它命令行侧的
 * 版本是两套代码，长期必然漂移——同一个字段在两处被解释成不同含义时，
 * 没有任何测试会失败，只会有一个用户报告「注入的内容不对」。
 *
 * 三个必须遵守的契约：
 *
 * 1. 逐轮上下文走 per-call stdio 桥：每次请求 spawn 一个 `specrune hook-serve`
 *    子进程，发一帧、读一帧、随即终止（req:architecture#injection-bridge-process-shape）。
 *    req:injection-chain#injection-pipeline-hard-constraints 的意图是「注入不阻塞推理循环」，它的实现形态是 per-call：宿主永远
 *    只等 BRIDGE_FALLBACK_MS，超时即降级，绝不把进程留在后台。
 *    稳定段进 pi 的结构化 prompt 段（systemPromptOptions.sections，pi 负责
 *    逐字节稳定与 delta 追补）；易变段与面包屑走 append-only 消息。
 *    只有子代理的 context compile（非逐轮）仍走异步 execFile。
 *
 * 2. CLI 调用全部异步。
 *    曾经 `specrune_subagent` 同步等待子代理跑完（阻塞 pi 主进程事件循环，
 *    上限 30 分钟，派发期间 TUI 完全卡死）。
 *    现在扩展内禁止任何同步 exec：编译走 execFile 异步（毫秒级），
 *    等待子代理走事件订阅 + 轮询，主进程始终可响应。
 *
 * 3. 子会话里不激活工作流（递归闸门）。
 *    进程内子会话与父会话共享进程环境，环境变量闸门因此失效。替代判据：
 *    pi-subagents（以及 /fork、/clone）创建的子会话经 newSession({parentSession})
 *    产生，会话头首行含 parentSession 字段——扩展在 session_start 读该字段，
 *    是子会话就摘除 specrune_subagent、不做工作流注入。判定宁漏关不误关：
 *    读失败按主会话处理并告警，误关会让主会话失去派发能力。
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BIN = (process.env.SPECRUNE_BIN || "").trim() || "specrune";
// BRIDGE_FALLBACK_MS 是「等不到响应就降级」的兜底，**不是**决定成败的预算。
//
// 预算档位表只在 Go 侧（`cli/hookserve.go` 按方法查表，req:architecture#bridge-budget-tiers）：两个宿主
// 共用同一座桥，预算只能有一个来源。这里曾是一个对所有方法统一使用的 200ms，
// 于是 Pi 的 `session.context`（实测净成本 372ms）**至今每轮静默超时**——稳定段
// 与易变段一直在丢，只有不跑 git 的面包屑能到，症状是「注入只有一点引导」且零
// 报错（req:injection-chain#budget-tier-background）。
//
// 它必须大于桥的最高档（800ms），否则兜底会抢在档位之前掐掉请求，那等于把预算
// 又搬回 TS 侧。它只负责「桥已经没了 / 卡住了」这两种情况。
const BRIDGE_FALLBACK_MS = 1_500;
// 子代理 context compile 不是逐轮调用，给进程启动留更宽裕的余量；
// 逐轮路径由 BRIDGE_FALLBACK_MS 兜底，这个上限不落在每一轮的关键路径上。
const CLI_TIMEOUT_MS = 20000;
const RUNTIME_CONTEXT_TYPE = "specrune-runtime-context";
const TOOL_NAME = "specrune_subagent";

// ── 子代理运输层接缝字面量（req:subagents#subagent-transport-compat） ──────────────────────────────────
//
// 这些裸字符串是各 subagent 扩展的跨扩展接缝，没有 import 可依赖：上游改名
// 只会静默失联——服务取不到还有「未安装」兜底，事件名变了则事件路径死、轮询
// 路径活，半失效更难察觉（D1/D9/D11 教训）。它们全部集中在这里，每个字面量
// 在本源里恰好出现一次（定义处），其余位置一律引用常量；守卫测试按此钉住。

// GG（@gotgenes/pi-subagents）：Symbol 服务 + 复数前缀生命周期事件。
const GG_SERVICE_KEY = "@gotgenes/pi-subagents:service";
const GG_EVENT_COMPLETED = "subagents:completed";
const GG_EVENT_FAILED = "subagents:failed";
const GG_EVENT_STARTED = "subagents:started";
const GG_INSTALL_CMD = "pi install npm:@gotgenes/pi-subagents";

// NB（pi-subagents，nicobailon）：版本化事件 RPC + 单数前缀生命周期事件
// （与 GG 的复数前缀相向，别混）。
const NB_RPC_READY = "subagents:rpc:v1:ready";
const NB_RPC_REQUEST = "subagents:rpc:v1:request";
const NB_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const NB_EVENT_ASYNC_COMPLETE = "subagent:async-complete";
const NB_EVENT_ASYNC_STARTED = "subagent:async-started";
const NB_INSTALL_CMD = "pi install npm:pi-subagents";

// 与守护进程侧 trellis.InjectionSentinel 同值：编译产物不含哨兵，由扩展
// 置于 prompt 之首，保持「上下文块可被识别去重」的约定（req:injection-chain#injection-pipeline-hard-constraints）。
const INJECTION_SENTINEL = "<!-- trellis-hook-injected -->";

// SPECRUNE_PLUGIN_DEBUG 打开后，注入的关键节点各打一行到 stderr，格式与
// `ocplatform/plugin.ts` 逐字对齐。
//
// 为什么 Pi 侧也需要：Pi 曾经每轮静默丢掉稳定段与易变段（单一 200ms 预算对
// 372ms 实测成本，req:injection-chain#budget-tier-background），而**外部看不出任何异常**——「没注入」和「注入了
// 但内容为空」在宿主日志里是同一件事。修好之后如果仍然没有观测口，下一次
// 静默退化又会无人察觉。req:architecture#bridge-budget-tiers 的验收口径「Pi 侧首次出现这两行」依赖它。
const DEBUG = process.env["SPECRUNE_PLUGIN_DEBUG"] === "1";

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[specrune] ${msg}\n`);
}


// ── per-call 注入桥（req:injection-chain#injection-pipeline-hard-constraints / req:architecture#injection-bridge-process-shape） ──────────────────────────────────
//
// 逐轮上下文获取走「每次调用 spawn 一个 `specrune hook-serve` 子进程，发一帧、
// 读一帧、随即终止」。宿主只等 BRIDGE_FALLBACK_MS，超时即降级，绝不阻塞推理循环。
//
// 为什么不是直连守护进程套接字：Pi 由 Node 启动，而 Node 在 Windows 上不
// 支持 AF_UNIX（Node v26 实测连自己建的 .sock 都 EACCES）；OpenCode 能直连
// 是因为它跑在 Bun 上。于是改由本扩展 spawn `hook-serve` 子进程，用它的
// stdin/stdout 帧管道——跨平台可行，领域逻辑仍全在 Go 一处（req:injection-chain#injection-pipeline-hard-constraints）。

const MAX_SPAWN_FAILURES = 3;
const RETRY_COOLDOWN_MS = 30_000;
const HEADER_END = "\r\n\r\n";

function locateSpecruneBinary(): string {
  const fromEnv = (process.env["SPECRUNE_BIN"] || "").trim();
  if (fromEnv) return fromEnv;
  return process.platform === "win32" ? "specrune.exe" : "specrune";
}

function encodeFrame(obj: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}${HEADER_END}`, "utf8"), payload]);
}

// decodeFrame 从缓冲里解出**一帧**。
//
// 返回 undefined 表示半截帧（等更多字节），null 表示头坏了（整条流已废）。
// per-call 下只读一帧，所以解出即返回，不扫「缓冲里剩下的所有帧」。
function decodeFrame(buf: Buffer): Record<string, unknown> | undefined | null {
  const headerEnd = buf.indexOf(HEADER_END);
  if (headerEnd < 0) return undefined;
  const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString("utf8"));
  if (!m) return null;
  const length = parseInt(m[1], 10);
  const start = headerEnd + HEADER_END.length;
  if (buf.length < start + length) return undefined;
  try {
    return JSON.parse(buf.subarray(start, start + length).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface CallResult<T> {
  ok: boolean;
  value?: T;
  reason?: "dead" | "timeout" | "error";
  message?: string;
}

// HookBridge 是一次性的注入桥：**每次调用 spawn 一个 `specrune hook-serve`
// 子进程，发一帧、读一帧、随即终止**（req:architecture#injection-bridge-process-shape）。
//
// 为什么不常驻：常驻唯一的收益是省掉重复的 `BuildSessionContext`（实测净成本
// 372ms），而那个节省**从不发生**——缓存 TTL 1s，而 `session.context` 每轮只调
// 一次、轮次间隔秒到分钟，缓存永远命中不了（req:architecture#bridge-no-cache 的实测：睡 1.5s 后的第三次
// 调用 367ms ≈ 首次 378ms）。于是常驻每轮都在白养一个进程，只多付约 18ms 的
// 启动成本，换来的却是一整类「长命进程里的状态需要保持新鲜」的 bug。
// per-call 之后新进程没有状态，也就不需要新鲜。
//
// 一句话推论，也是这套实现比常驻版简单得多的原因：**一次调用只发一帧、只读
// 一帧，所以响应错配在结构上不可能发生**。child 引用、请求表、按 id 配对、
// 存活探测、跨调用的缓冲累积全都不需要——它们都是为常驻服务的。
class HookBridge {
  private failures = 0;
  private cooldownUntil = 0;

  call<T>(method: string, params: unknown, root: string): Promise<CallResult<T>> {
    if (Date.now() < this.cooldownUntil) {
      return Promise.resolve({ ok: false, reason: "dead" } as CallResult<T>);
    }
    return this.exchange<T>(method, params, root);
  }

  // exchange 完成一次「spawn → 发一帧 → 读一帧 → 终止」。
  private exchange<T>(method: string, params: unknown, root: string): Promise<CallResult<T>> {
    return new Promise<CallResult<T>>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        // detached: false —— 父子同生共死，不做后台进程（req:architecture#injection-bridge-process-shape）。
        child = spawn(locateSpecruneBinary(), ["hook-serve"], {
          cwd: root,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          detached: false,
          env: { ...process.env, SPECRUNE_REPO: root },
        });
      } catch {
        this.noteFailure();
        resolve({ ok: false, reason: "dead" } as CallResult<T>);
        return;
      }

      // buf 是**这一次调用**的局部累积，不跨调用：进程随调用而生灭。
      let buf = Buffer.alloc(0);
      let settled = false;
      const finish = (result: CallResult<T>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 读完即毁：关 stdin 让 Go 侧读到 EOF 正常退出，再 kill 兜底。
        // 不留活进程是 per-call 的硬要求（req:architecture#injection-bridge-process-shape）。
        try {
          child.stdin?.end();
        } catch {
          /* 已关闭 */
        }
        try {
          if (child.exitCode === null) child.kill();
        } catch {
          /* 已经死了 */
        }
        resolve(result);
      };
      // 超时**必须**计入熔断（req:architecture#bridge-degradation-contract）：这段预算防的是「桥还在但不回话」——卡死、
      // 死锁、git 探测挂起。只计 spawn 失败的话，这类卡死每轮都重试、永不冷却，
      // 症状恰好是熔断当初要消灭的「注入时灵时不灵且零报错」。
      const timer = setTimeout(() => {
        this.noteFailure();
        finish({ ok: false, reason: "timeout" } as CallResult<T>);
      }, BRIDGE_FALLBACK_MS);

      // spawn 失败是异步的：二进制不在 PATH 时若没有 'error' 监听者会变成
      // 未捕获异常。收到即判本轮失败（下一轮是另一个全新进程）。
      child.on("error", () => {
        this.noteFailure();
        finish({ ok: false, reason: "dead" } as CallResult<T>);
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const frame = decodeFrame(buf);
        if (frame === undefined) return; // 半截帧，等下一块
        if (frame === null) {
          // 头解不出来：整条流已废，丢弃它。
          finish({ ok: false, reason: "dead" } as CallResult<T>);
          return;
        }
        // 桥的 error 是**裸字符串**（不是 JSON-RPC 的那个对象）：hook-serve
        // 刻意不走守护进程那套带 jsonrpc 字段与令牌的自研协议（req:architecture#injection-bridge-process-shape 无鉴权面）。
        const err = frame["error"];
        if (typeof err === "string" && err.length > 0) {
          finish({ ok: false, reason: "error", message: err } as CallResult<T>);
          return;
        }
        // 一次成功往返清零连续失败计数（req:architecture#bridge-degradation-contract）。缺了它，偶发超时会在长会话里
        // 攒满三次、把一条基本健康的桥打进 30 秒冷却，而告警写的是「连续 3 次」
        // ——与事实相反（对齐 ocplatform/plugin.ts 的同名调用）。
        this.noteSuccess();
        finish({ ok: true, value: frame as unknown as T });
      });

      // 桥没给出任何帧就收流了（超预算退出、崩溃、半截帧）——立刻判本轮失败，
      // 不让宿主干等 BRIDGE_FALLBACK_MS 走完。
      //
      // 为什么监听 stdout 的 'close' 而不是子进程的 'exit'：'exit' 可能早于
      // stdout 排空触发（进程已经死了，管道里的字节还没被父进程读走），那一刻
      // 判失败会把**已经写完、正在路上的**应答丢掉。'close' 保证排在所有
      // 'data' 之后，于是顺序是确定的：先 data（拿到应答或拿到 error），
      // 后 close（什么都没拿到）。settled 标志让两者只有一次生效。
      child.stdout?.on("close", () => finish({ ok: false, reason: "dead" }));

      try {
        // 刻意不带 jsonrpc / token 字段：hook-serve 协议不含这两样。
        // id 恒为 1 —— 它只是协议要求的字段，不用于配对（每进程只有一个请求）。
        child.stdin?.write(encodeFrame({ id: 1, method, params }));
      } catch {
        this.noteFailure();
        finish({ ok: false, reason: "dead" } as CallResult<T>);
      }
    });
  }

  // noteFailure 累计 spawn 失败并决定是否进入冷却。
  //
  // 熔断在 per-call 下**比常驻版更要紧**：常驻版一次会话只 spawn 一次，
  // per-call 每轮都 spawn——二进制缺失会让每轮都失败，熔断是唯一的止血手段
  // （req:architecture#bridge-degradation-contract）。
  //
  // 冷却要**显式告警**而不静默失败：降级还在跑（保留上一轮的块），用户看到的
  // 现象只是「规范好像没生效」，没人知道原因（req:architecture#daemon-lifecycle-retired / req:architecture#bridge-degradation-contract）。
  //
  // 告警措辞必须覆盖两类失败：spawn 失败（桥起不来）与超时（桥起来了但不回话）。
  // 只写「无法启动」的话，超时熔断会打出一条与真实故障相反的日志——排障第一步
  // 就是错的（与 ocplatform/plugin.ts 的 noteFailure 对齐）。
  private noteFailure(): void {
    this.failures += 1;
    if (this.failures < MAX_SPAWN_FAILURES) return;
    this.cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
    this.failures = 0;
    const binary = locateSpecruneBinary();
    process.stderr.write(
      `[specrune] 警告：已连续 ${MAX_SPAWN_FAILURES} 次没能应答（启动失败或超时未回），接下来 ` +
        `${Math.round(RETRY_COOLDOWN_MS / 1000)} 秒内不再重试，规范注入降级为「跳过/微缓存」。\n` +
        `  排查：① 确认 \`${binary}\` 在 PATH 上（可用 SPECRUNE_BIN 指定绝对路径）；\n` +
        `        ② 手动执行 \`${binary} hook-serve\` 看前台报错；\n` +
        `        ③ 若能启动但经常超时，多半是仓库过大或 git 探测挂起，先复现本条告警再调预算。\n`,
    );
  }

  // noteSuccess 清零连续失败计数。
  //
  // 为什么必须有：熔断要判的是「**连续**失败」。超时是瞬时故障（机器某刻繁忙、
  // git 探测偶尔挂起），若成功不重置，插件进程活得越久、偶发超时攒得越多，总有
  // 一天凑满三次就把一条基本健康的桥打进 30 秒冷却——而告警里写的却是
  // 「连续 3 次」，与事实相反。成功后清零让「连续」名副其实，也让真正卡死的桥
  // （每轮都超时，没有成功可清）照样在三次后冷却。
  private noteSuccess(): void {
    this.failures = 0;
  }
}

const bridge = new HookBridge();

// ── 子代理运输层（req:injection-chain#subagent-dispatch / req:subagents#subagent-transport-compat：可插拔，GG+NB 双适配器） ──────────────────

// GG 的七值状态词表（req:subagents#transport-adapter-seam）。steered 是终态但非错误：事件路径它走完成通道；
// 事件丢失退化为纯轮询时，终态集合若漏了它，等待会悬挂到 timeout。
type GotgenesStatus = "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";

// GG 终态集合（七值全收，缺一个就是一种悬挂路径）；归一映射在适配器内。
const GG_TERMINAL_STATES = new Set<GotgenesStatus>(["completed", "steered", "aborted", "stopped", "error"]);
const POLL_INTERVAL_MS = 500;

interface SubagentRecord {
  id: string;
  type: string;
  status: GotgenesStatus;
  result?: string;
  error?: string;
}

// GG 服务接口：本扩展只声明结构化子集，真服务实现更多方法即可。
interface SubagentsService {
  spawn(type: string, prompt: string, options?: { description?: string; foreground?: boolean }): string;
  getRecord(id: string): SubagentRecord | undefined;
  abort(id: string): boolean;
}

// 服务经 Symbol.for 发布在 globalThis（GG 的跨扩展公共接缝）。不走动态 import：
// 扩展落在项目目录里，模块解析看不到 agent 级 npm 树，而发布路径对「装没装、
// 开没开」的判定语义完全一致。
const SUBAGENTS_SERVICE_KEY = Symbol.for(GG_SERVICE_KEY);

// 返回值**禁止缓存**（req:subagents#transport-probe-order）：GG 在任一 in-process 子会话关停时会 unpublish
// 共享服务且无再发布路径（2026-09-30 实测，接缝在本进程内永久失效直至重启
// pi），服务可在会话中途消失——每次派发现查。
function getGotgenesService(): SubagentsService | undefined {
  return (globalThis as Record<symbol, unknown>)[SUBAGENTS_SERVICE_KEY] as
    | SubagentsService
    | undefined;
}

// 扩展自有四值词表（req:injection-chain#subagent-dispatch / req:subagents#transport-state-normalization）：接口只出口这四个，各包词表（GG 七值、
// NB run 工件 outcome 体系）关进各自适配器内部。
type SubagentState = "completed" | "failed" | "aborted" | "timeout";

// 归一后的终态（不含 timeout——它由通用编排的计时器产生，适配器不感知）。
interface TransportTerminal {
  state: "completed" | "failed" | "aborted";
  result?: string;
  error?: string;
}

// 状态查询的一次回读。terminal=false 表示「记录在、但还没到终态」：编排层据此
// 继续等（不能据此收敛），只在超时/中止的抓取里取它的 result 当部分产出。
// 保留这条是为了不丢「跑到一半的产出」——改造前超时路径直接回传 getRecord
// 记录，无论是否终态，模型拿得到半截结果。
interface TransportProbe {
  terminal: boolean;
  state?: "completed" | "failed" | "aborted";
  result?: string;
  error?: string;
}

/**
 * 可插拔运输层接缝（req:subagents#subagent-transport-compat）。一个实现 = 一种 subagent 扩展的进程内接缝。
 *
 * 前提（递归闸门，req:subagents#transport-adapter-seam）：实现创建的子会话必须能被 session_start 的
 * parentSession 判据识别（GG 与 NB 的进程内子会话都经 newSession({parentSession})）；
 * 做不到的实现必须自行承担递归风险并在适配器内另设闸门。
 *
 * 完成通知由实现收敛为一次性 onTerminal，不得重复打扰父会话；终态事件订阅
 * 必须先于实际 spawn 完成（同一轮事件循环内同步完成，事件派发不能插进订阅
 * 与 spawn 之间）——这是 GG 现路径的竞态约束，NB 同构遵守。
 */
interface SubagentTransport {
  readonly name: "gotgenes" | "nicobailon";
  /**
   * 派发并注册终态/进度回调。GG 同步返回 id；NB 经 RPC 往返，返回 Promise
   * （回信失败或超时则 reject，编排层把它呈现为 failed）。dispose 退订 spawn
   * 内部注册的全部监听，由编排层在收敛时调用，不让监听器跨派发泄漏。
   */
  spawn(
    agentType: string,
    prompt: string,
    opts: {
      description?: string;
      onTerminal: (t: TransportTerminal) => void;
      onStarted?: () => void;
    },
  ): { id: string; dispose: () => void } | Promise<{ id: string; dispose: () => void }>;
  /**
   * 状态查询兜底：查不到（id 不存在/无回信）返回 null。查得到但未终态时返回
   * `{terminal: false, result?, error?}`——编排层不据此收敛，只在超时/中止的
   * 抓取里取部分产出。NB 走 RPC，故为异步。
   */
  pollOnce(id: string): Promise<TransportProbe | null>;
  abort(id: string): boolean;
}

// ── GG 适配器（现状下沉，行为不变，req:subagents#transport-adapter-seam） ──────────────────────────

function createGotgenesTransport(pi: PiApi, svc: SubagentsService): SubagentTransport {
  return {
    name: "gotgenes",
    spawn(agentType, prompt, opts) {
      let agentId: string | null = null;
      const matches = (data: unknown): data is SubagentRecord =>
        !!data && typeof data === "object" && agentId !== null && (data as { id?: unknown }).id === agentId;
      const offs: Array<() => void> = [];
      const subscribe = (channel: string, handler: (data: unknown) => void) => {
        const off = pi.events?.on?.(channel, handler);
        if (typeof off === "function") offs.push(off);
      };

      // 先订阅后 spawn：两者在同一轮事件循环里同步完成，事件派发不可能插进中间。
      // GG 的完成事件对 steered 一并发出（非错误终态都走它），这里一律按成功收敛。
      subscribe(GG_EVENT_COMPLETED, (data) => {
        if (matches(data)) opts.onTerminal({ state: "completed", result: data.result, error: data.error });
      });
      subscribe(GG_EVENT_FAILED, (data) => {
        if (!matches(data)) return;
        opts.onTerminal({
          state: data.status === "error" ? "failed" : "aborted",
          result: data.result,
          error: data.error,
        });
      });
      subscribe(GG_EVENT_STARTED, (data) => {
        if (matches(data)) opts.onStarted?.();
      });

      // foreground: true 绕过并发队列、让 GG 内联渲染进度；服务本身仍立即返回
      // id，等待逻辑在通用编排这边。
      const id = svc.spawn(agentType, prompt, { foreground: true, description: opts.description });
      agentId = id;
      return {
        id,
        dispose: () => {
          for (const off of offs) {
            try {
              off();
            } catch {
              // 退订失败不影响结果交付。
            }
          }
        },
      };
    },
    async pollOnce(id) {
      const rec = svc.getRecord(id);
      if (!rec) return null;
      // 记录在但未终态（queued/running）也要回传：超时/中止的抓取要拿它的
      // result 保住「跑到一半的产出」。编排层看 terminal 决定是否收敛。
      const terminal = GG_TERMINAL_STATES.has(rec.status);
      return {
        terminal,
        state: terminal
          ? rec.status === "completed" || rec.status === "steered"
            ? "completed"
            : rec.status === "error"
              ? "failed"
              : "aborted"
          : undefined,
        result: rec.result,
        error: rec.error,
      };
    },
    abort(id) {
      return svc.abort(id);
    },
  };
}

// ── NB 适配器（新增，req:subagents#transport-adapter-seam） ──────────────────────────────────────

// NB 没有同步服务对象，事件总线 RPC 是它唯一的程序化调用形态。这些超时只覆盖
// 一次事件总线往返：ping 探测在派发关键路径上，必须远小于用户可感知；spawn/status
// 已经在等待编排内部，宽一些不阻塞主进程。
const NB_PING_TIMEOUT_MS = 2_000;
const NB_RPC_TIMEOUT_MS = 10_000;

// NB 正探测结果的会话内缓存：宿主介导接缝不会被模块状态拆除（req:subagents#transport-probe-order），ping
// 往返没必要每次派发都付。负结果不缓存（NB 可能稍后才加载完）。
let nbAvailable = false;
// ping 广告的 capabilities.status：NB 明确说它支不支持 status RPC。false 时
// pollOnce 直接省掉那次必无回应的往返（实测广告形状：{status:true,
// statusProjection, asyncSpawn, steer, stop, resume, processTerminalProof…}）。
let nbStatusSupported: boolean | undefined;

interface NbRpcReply {
  version?: number;
  requestId?: string;
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

function nbRequestId(): string {
  return `specrune-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 单次 RPC 往返：发请求信封，等按 requestId 定址的回信。onReply 在回信处理内
// **同步**回调：spawn 的 runId 必须在事件循环继续之前就位，否则紧随回信到达的
// 终态事件会因 id 未填而漏配。
function nbRpc(
  pi: PiApi,
  method: string,
  params: unknown,
  timeoutMs: number,
  onReply?: (reply: NbRpcReply) => void,
): Promise<NbRpcReply> {
  return new Promise<NbRpcReply>((resolveRpc, rejectRpc) => {
    const requestId = nbRequestId();
    const on = pi.events?.on;
    const emit = pi.events?.emit;
    if (typeof on !== "function" || typeof emit !== "function") {
      rejectRpc(new Error("pi.events bus is unavailable"));
      return;
    }
    let settled = false;
    const off = on(`${NB_RPC_REPLY_PREFIX}${requestId}`, (data: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof off === "function") off();
      const reply = (data || {}) as NbRpcReply;
      onReply?.(reply);
      resolveRpc(reply);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (typeof off === "function") off();
      rejectRpc(new Error(`pi-subagents RPC ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    emit.call(pi.events, NB_RPC_REQUEST, { version: 1, requestId, method, params });
  });
}

// NB 的终态证据与形状全部来自 2026-09-30 实机探测（research/nb-real-shapes.md，
// 抓 ping/spawn/status 回信与 async 事件原始载荷）。终态事件（NB_EVENT_ASYNC_COMPLETE
// 通道）的载荷顶层是 `state`（实测 "complete"）与 `success`，
// **没有** outcome 字段——初版按 outcome/status 解析，实机全部落空：run 照样跑完，
// 但同步抛了「spawn reply carried no run id」把成功误报成失败。故词源含 state。
// 判定不了返回 null 交给下一条路径，只在有确凿终态证据时才收敛。
const NB_OUTCOME_OK = new Set(["ok", "success", "succeeded", "completed", "complete", "done", "finished"]);
const NB_OUTCOME_FAILED = new Set(["error", "failed", "failure", "timeout", "timed-out"]);
const NB_OUTCOME_ABORTED = new Set(["aborted", "abort", "cancelled", "canceled", "stopped", "stop"]);

function nbText(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function nbRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function nbRecords(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(nbRecord).filter((r): r is Record<string, unknown> => r !== null) : [];
}

// 产出口径：results[].output 最干净（实测顶层 summary 带 "agent:\\n" 前缀）。
// 多结果按空行拼接；空则退回 output/result/summary。
function nbOutputs(o: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const r of nbRecords(o["results"])) {
    const out = nbText(r["output"]) ?? nbText(r["summary"]);
    if (out) parts.push(out);
  }
  if (parts.length > 0) return parts.join("\n\n");
  return nbText(o["output"]) ?? nbText(o["result"]) ?? nbText(o["summary"]);
}

function nbErrorText(o: Record<string, unknown>): string | undefined {
  return (
    nbText(o["error"]) ??
    nbText(o["reason"]) ??
    nbText(nbRecords(o["results"]).find((r) => r["success"] === false)?.["error"]) ??
    nbText(o["summary"])
  );
}

function parseNbTerminal(data: unknown): TransportTerminal | null {
  const o = nbRecord(data);
  if (!o) return null;
  const words =
    `${String(o["outcome"] ?? "")} ${String(o["status"] ?? "")} ${String(o["state"] ?? "")}`.toLowerCase();
  // 只信 success:false（run 级失败标志），不信 success:true——它也可能是
  // 「这次调用成功」而不是「这个 run 成功」，误判成功比多等一轮轮询危险。
  if (o["success"] === false) {
    return { state: "failed", error: nbErrorText(o) ?? "subagent run failed" };
  }
  if (o["timedOut"] === true) {
    return {
      state: "failed",
      error: nbText(o["error"]) ?? "subagent run hit its time/turn limit",
    };
  }
  const has = (set: Set<string>): boolean => words.split(/[^a-z]+/).some((w) => set.has(w));
  if (has(NB_OUTCOME_OK)) {
    return { state: "completed", result: nbOutputs(o), error: nbText(o["error"]) };
  }
  if (has(NB_OUTCOME_FAILED)) {
    return { state: "failed", error: nbErrorText(o) ?? "subagent run failed" };
  }
  if (has(NB_OUTCOME_ABORTED)) {
    return { state: "aborted", error: nbErrorText(o) };
  }
  return null;
}

// status DTO 与终态事件是两种形状（实测）：status 的 data 是
// {text, details:{results, lifecycleStatus:{processTerminal:{state}}},
//  asyncSnapshot:{runs:[{id, state}]}}。终态判定顺序：run 快照的 state 词 →
// details.results[].success/output → 进程退出证明 processTerminal.state
// （pending|observed|unknown|not-started）。三者都读不出成败词时，只在
// observed（进程确已退出）时收敛，且按「不误判成功」报 failed 并注明结果不可读——
// 不无限等，也不谎报成功。
function parseNbStatus(data: unknown, id: string): TransportProbe {
  const o = nbRecord(data) ?? {};
  const details = nbRecord(o["details"]) ?? {};
  const results = nbRecords(details["results"]);
  const run = nbRecords(nbRecord(o["asyncSnapshot"])?.["runs"]).find((r) => r["id"] === id);
  if (run) {
    const t = parseNbTerminal({ state: run["state"], success: run["success"], results });
    if (t) return { terminal: true, ...t };
  }
  if (results.length > 0) {
    const failed = results.find((r) => r["success"] === false);
    if (failed) {
      return { terminal: true, state: "failed", error: nbErrorText(failed) ?? "subagent run failed" };
    }
    return { terminal: true, state: "completed", result: nbOutputs({ results }) };
  }
  const ptState = String(nbRecord(nbRecord(details["lifecycleStatus"])?.["processTerminal"])?.["state"] ?? "");
  if (ptState === "observed") {
    return {
      terminal: true,
      state: "failed",
      error: "subagent run ended without a readable outcome (NB process terminal observed)",
    };
  }
  return { terminal: false };
}

// RPC 回信信封是 {version, requestId, method, success, data:{text, details}}——
// run id 在 data.details.runId（实测；顶层 runId/id 与 asyncId 只作防御性退回项）。
function nbRunIdFromReply(data: unknown): string | null {
  const o = nbRecord(data) ?? {};
  const details = nbRecord(o["details"]) ?? {};
  for (const v of [details["runId"], details["asyncId"], o["runId"], o["id"]]) {
    const s = nbText(v);
    if (s) return s;
  }
  return null;
}

function createNicobailonTransport(pi: PiApi): SubagentTransport {
  const subscribe = (channel: string, handler: (data: unknown) => void): (() => void) => {
    const off = pi.events?.on?.(channel, handler);
    return typeof off === "function" ? off : () => {};
  };
  return {
    name: "nicobailon",
    spawn(agentType, prompt, opts) {
      // 先订阅终态/进度事件，后发 spawn 请求：runId 在回信里才知道，闭包先拿
      // null，事件到达时 runId 已由回信的同步钩子填上——与 GG 的「订阅先于
      // spawn」竞态约束同构。
      let runId: string | null = null;
      let done = false;
      const offs: Array<() => void> = [];
      const matches = (data: unknown): boolean => {
        if (!data || typeof data !== "object" || runId === null) return false;
        const o = data as Record<string, unknown>;
        return o["runId"] === runId || o["id"] === runId;
      };
      const finishOnce = (t: TransportTerminal): void => {
        if (done) return;
        done = true;
        for (const off of offs) off();
        opts.onTerminal(t);
      };
      offs.push(
        subscribe(NB_EVENT_ASYNC_COMPLETE, (data) => {
          if (!matches(data)) return;
          const t = parseNbTerminal(data);
          // payload 判定不了终态就不判（不 finishOnce），留给轮询路径收敛。
          if (t) finishOnce(t);
        }),
      );
      offs.push(
        subscribe(NB_EVENT_ASYNC_STARTED, (data) => {
          if (matches(data)) opts.onStarted?.();
        }),
      );

      // spawn 仅异步：前台语义由通用编排的等待达成，与现有异步等待模型天然
      // 吻合，不阻塞主进程。async:true 显式声明我们要的是后台运行 + 自管等待。
      return nbRpc(
        pi,
        "spawn",
        { agent: agentType, task: prompt, description: opts.description, async: true },
        NB_RPC_TIMEOUT_MS,
        (reply) => {
          runId = nbRunIdFromReply(reply.data);
        },
      ).then((reply) => {
        if (reply.success !== true) {
          throw new Error(nbText(reply.error?.message) ?? "pi-subagents RPC spawn failed");
        }
        if (runId === null) throw new Error("pi-subagents RPC spawn reply carried no run id");
        return {
          id: runId,
          dispose: () => {
            for (const off of offs) off();
          },
        };
      })
      .catch((err) => {
        // 派发失败也要退订：否则每次失败的派发都漏两个事件监听器。
        // 成功路径不走这里（dispose 交给编排层在收敛时调用）；finishOnce
        // 已退订过的 off 重复调用无害（退订是幂等的）。
        for (const off of offs) off();
        throw err;
      });
    },
    async pollOnce(id) {
      // status DTO 与 GG record 完全不同（req:subagents#transport-adapter-seam 实测）：终态证据在
      // details.lifecycleStatus / asyncSnapshot.runs[]，产出在 details.results。
      // ping 广告说没有 status 能力时省掉这次必无回应的往返。
      if (nbStatusSupported === false) return null;
      try {
        const reply = await nbRpc(pi, "status", { runId: id }, NB_RPC_TIMEOUT_MS);
        if (reply.success !== true) return null;
        return parseNbStatus(reply.data, id);
      } catch {
        return null;
      }
    },
    abort(id) {
      // stop 即发即忘：接口要求同步返回，而回信异步到达，无从对应这次调用。
      // 请求发出即视为已受理，真正的收敛由终态事件或轮询完成。
      try {
        pi.events?.emit?.(NB_RPC_REQUEST, {
          version: 1,
          requestId: nbRequestId(),
          method: "stop",
          params: { runId: id },
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ── 运输层探测与降级（req:subagents#transport-probe-order，每次派发现场执行） ────────────────────

async function detectNicobailon(pi: PiApi): Promise<boolean> {
  if (nbAvailable) return true;
  try {
    const reply = await nbRpc(pi, "ping", {}, NB_PING_TIMEOUT_MS);
    // 探测只回答「接缝在不在」；能力广告只取 status 一项（决定要不要做轮询兜底），
    // 其余能力位（steer/resume/cost…）本版不消费。
    if (reply.success === true) {
      nbAvailable = true;
      const caps = nbRecord(nbRecord(reply.data)?.["capabilities"]);
      if (caps && typeof caps["status"] === "boolean") nbStatusSupported = caps["status"];
    }
  } catch {
    // 超时或无回信 = 未安装或未就绪；负结果不缓存。
  }
  return nbAvailable;
}

type TransportResolution = { transport: SubagentTransport } | { error: string };

/**
 * 每次派发现场选择运输层（req:subagents#transport-probe-order）。顺序是契约：GG 服务符号 → NB ping/ready。
 * GG 结果不缓存（服务可在会话中途被任一子会话关停拆除）；NB 正结果按会话缓存。
 */
async function resolveTransport(pi: PiApi): Promise<TransportResolution> {
  const svc = getGotgenesService();
  if (svc && typeof svc.spawn === "function") {
    return { transport: createGotgenesTransport(pi, svc) };
  }
  if (await detectNicobailon(pi)) {
    return { transport: createNicobailonTransport(pi) };
  }
  return { error: transportDegradeMessage(pi) };
}

// 降级文案必须能归因（req:subagents#transport-probe-order 三态）：GG 装了但服务被撤销 ≠ 没装 ≠ Lite。
// 工具面只用于文案归因，不参与运输层选择——「探测看接缝，不看工具名」。
function transportDegradeMessage(pi: PiApi): string {
  const tools = new Set<string>();
  try {
    for (const t of pi.getActiveTools?.() || []) tools.add(t);
  } catch {
    // 工具面拿不到就按最普通情况处理。
  }
  if (tools.has("get_subagent_result") || tools.has("steer_subagent")) {
    return (
      "@gotgenes/pi-subagents is installed but its service has been unpublished " +
      "(known flaw: any finished in-process subagent tears the shared service down).\n" +
      "  Restart pi to restore it, or switch to the nicobailon package:\n" +
      `  ${NB_INSTALL_CMD}\n` +
      '  Then add "npm:pi-subagents" to the packages list in your global pi settings and restart pi.'
    );
  }
  if (tools.has("Agent")) {
    return (
      "pi-subagents-lite is detected, but it exposes no programmatic seam (no events, no service); " +
      "specrune_subagent cannot drive it.\n" +
      `  Install a supported transport instead: ${GG_INSTALL_CMD} or ${NB_INSTALL_CMD}\n` +
      "  (add the package to the packages list in your global pi settings and restart pi)."
    );
  }
  return (
    "No compatible subagent extension is installed or enabled; specrune_subagent cannot dispatch.\n" +
    `  Install one of: ${GG_INSTALL_CMD}\n` +
    `                  ${NB_INSTALL_CMD}\n` +
    "  Then add the package to the packages list in your global pi settings and restart pi."
  );
}

interface PiContext {
  cwd?: string;
  sessionId?: string;
  ui?: { notify?: (message: string, level?: string) => void };
  sessionManager?: {
    getHeader?: () => { parentSession?: string } | null | undefined;
  };
}

interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface SubagentInput {
  agent?: string;
  prompt?: string;
  task?: string;
  timeout?: number;
}

interface PiApi {
  registerTool?: (tool: Record<string, unknown>) => void;
  on?: (
    event: string,
    handler: (event: unknown, ctx?: PiContext) => unknown,
  ) => void;
  getActiveTools?: () => string[];
  setActiveTools?: (names: string[]) => void;
  events?: {
    on?: (
      channel: string,
      handler: (data: unknown) => void,
    ) => void | (() => void);
    emit?: (channel: string, payload: unknown) => void;
  };
}

// ── 项目根解析 ────────────────────────────────────────────────────────

/**
 * 从起始目录向上找到第一个含 `.specrune/` 的目录。
 *
 * `.specrune` 必须是**目录**才认。同名文件不是项目标记；接受它会让解析
 * 停在一个并不含任何工作流的位置，之后所有路径都偏。
 */
function findRoot(start: string): string {
  const origin = resolve(start);
  let cur = origin;
  for (;;) {
    const marker = join(cur, ".specrune");
    try {
      if (existsSync(marker) && statSync(marker).isDirectory()) return cur;
    } catch {
      // 权限问题按「这里没有标记」处理，继续向上找。
    }
    const parent = dirname(cur);
    if (parent === cur) return origin;
    cur = parent;
  }
}

/**
 * 用会话工作目录解析根，而不是进程启动目录。
 *
 * 在 pi-web / RPC / 多项目宿主里，两者并不相同——用进程 cwd 会让
 * `.pi/agents/` 的查找落到错误的项目上，或者干脆找不到。
 */
function resolveRoot(ctx?: PiContext): string {
  return findRoot(ctx?.cwd || process.cwd());
}

function isSpecruneProject(root: string): boolean {
  try {
    const marker = join(root, ".specrune");
    return existsSync(marker) && statSync(marker).isDirectory();
  } catch {
    return false;
  }
}

// ── 会话标识 ──────────────────────────────────────────────────────────

const KEY_FIELDS = [
  "sessionId",
  "session_id",
  "sessionID",
  "contextId",
  "context_id",
  "conversationId",
];

/** 在嵌套对象里按字段名捞出第一个非空字符串。 */
function lookup(value: unknown, depth = 0): string | null {
  if (depth > 3 || !value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const k of KEY_FIELDS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const nested of ["session", "context", "input", "properties", "event"]) {
    const found = lookup(obj[nested], depth + 1);
    if (found) return found;
  }
  return null;
}

let fallbackKey: string | null = null;

/**
 * 解析会话标识。
 *
 * 拿不到就退化成一个进程级标识，并且**明确知道这是退化的**：多窗口并行时
 * 进程级标识会把两个会话认成同一个。上游用 #549 / #608 / #511 / #415 四个
 * 缺陷证明了按「候选文件数量」猜会话是有害的，所以这里不猜，只记录。
 */
function getKey(event: unknown, ctx?: PiContext): string {
  const fromEvent = lookup(event);
  if (fromEvent) return fromEvent;
  const fromCtx = lookup(ctx);
  if (fromCtx) return fromCtx;
  // 变量名必须与 Go 侧权威名一致（trellis.EnvContextID，req:cli-contract#env-contract-table 契约表）。
  // 曾写成 SPECRUNE_CONTEXT_ID，CLI 从不读这个名字——注入了也等于没注入，
  // task start/finish 全部降级。改名时同步守护测试 TestPiExtensionSessionBridge。
  const fromEnv = (process.env.TRELLIS_CONTEXT_ID || "").trim();
  if (fromEnv) return fromEnv;
  if (!fallbackKey) fallbackKey = `pi_process_${process.pid}`;
  return fallbackKey;
}

/**
 * 递归闸门判定：本会话是否为子会话。
 *
 * 判据是会话头的 parentSession 字段（pi-subagents 与 /fork /clone 同一
 * 机制产生）。读失败一律按主会话处理并留下警告——闸门宁可漏关不可误关。
 */
function isChildSession(ctx?: PiContext): boolean {
  try {
    const header = ctx?.sessionManager?.getHeader?.();
    return typeof header?.parentSession === "string" && header.parentSession.length > 0;
  } catch (err) {
    console.warn(
      "[specrune] 读取会话头失败，按主会话处理（递归闸门未关闭）:",
      err,
    );
    return false;
  }
}

// ── CLI 调用（全部异步） ─────────────────────────────────────────────

async function runCli(args: string[], root: string, timeout: number): Promise<string> {
  const { stdout } = await execFileAsync(BIN, args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    // windowsHide：钩子在无控制台可继承的宿主（RPC/GUI 集成）里跑时，
    // 每次派生 console 程序都会让系统分配一个新控制台——用户看到
    // 的就是闪黑框。CREATE_NO_WINDOW 等价物让子进程根本不分配控制台。
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, SPECRUNE_REPO: root },
  });
  return stdout;
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function psQuote(v: string): string {
  // PowerShell 单引号字面量：内部单引号只能双写转义，不支持 POSIX 的
  // 跨引号拼接。会话 id 通常不含单引号，但桥接代码不能赌这一点。
  return `'${v.replace(/'/g, "''")}'`;
}

function hasContextExport(cmd: string): boolean {
  // 整串匹配，而不是只看行首：`cd x && export TRELLIS_CONTEXT_ID=…` 这类写法
  // 也要认出来，否则会被再前缀一层（会话标识被覆盖是本函数要防的唯一后果）。
  // 单条正则同时覆盖 POSIX（`export X=` / `X=` / `env … X=`）与 PowerShell
  // （`$env:X =`，等号前可有空白）。TRELLIS_CONTEXT_ID 是 Go 侧权威名（req:cli-contract#env-contract-table）。
  return /TRELLIS_CONTEXT_ID\s*=/.test(cmd);
}

// ── 子代理定义 ────────────────────────────────────────────────────────

const AGENT_ROLES: Record<string, string> = {
  "specrune-implement": "implement",
  implement: "implement",
  "specrune-check": "check",
  check: "check",
  "specrune-research": "research",
  research: "research",
};

function normalizeAgent(name: string): string {
  return name.trim().toLowerCase();
}

function roleOf(agent: string): string | null {
  return AGENT_ROLES[agent] || null;
}

/** 只有 `.pi/agents/<name>.md` 存在的名字才是工作流代理。 */
function hasDefinition(root: string, agent: string): boolean {
  try {
    return existsSync(join(root, ".pi", "agents", `${agent}.md`));
  } catch {
    return false;
  }
}

// ── 会话内缓存（有界） ────────────────────────────────────────────────

// 按「会话 + 项目根」做键。一个会话的生命周期里 cwd 可能变化（项目切换、
// 多项目宿主），只按会话键会让 A 项目的上下文泄进 B 项目。
// 上限是硬性的：未发 session_shutdown 的宿主（RPC / 长期进程）否则会无界增长。
const CACHE_LIMIT = 16;
const stableCache = new Map<string, string>(); // scopedKey -> stable 文本
const lastTurn = new Map<string, string>(); // scopedKey -> 上次送达的易变文本

function boundedSet(map: Map<string, string>, key: string, value: string): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function scopedKey(key: string, root: string): string {
  return `${key}::${root}`;
}

/** 取指定模式的会话上下文；守护进程不可用时返回 null（调用方降级）。 */
async function fetchContext(root: string, key: string, mode: string): Promise<string | null> {
  const res = await bridge.call<{ text?: string }>(
    "session.context",
    { repoRoot: root, mode, contextKey: key },
    root,
  );
  if (res.ok && typeof res.value?.text === "string") return res.value.text;
  return null;
}

/**
 * 取本轮用户 prompt —— `prompt_injection.skip_keyword` 逃生口的数据来源。
 *
 * 取值来源是 `before_agent_start` 事件载荷自带的 `prompt` 字段，与 OpenCode 侧
 * 另开 `session/prompt` 钩子缓存 `lastPrompt`（`ocplatform/plugin.ts` 的
 * `stashPrompt`）不同：那边注入发生在 `session/context` 钩子里、而 prompt 由另一个
 * 事件送达，两处不同源才需要缓存；Pi 的逐轮注入就发生在带 prompt 的这个事件内，
 * 当场取当场用，少一份状态也少一份上限。
 *
 * **不得传空串充数**：`ShouldSkipBreadcrumb("", kw)` 恒为 false（`workflow.go` 的
 * `strings.Index("", kw)` = -1），传 "" 等于把「逃生口静默失效」换一种写法继续留着。
 * 宿主确实没给 prompt 时返回 `undefined`，让该键不进 JSON——此时不跳过是正确默认
 * （没有 prompt 可匹配），而 Go 侧对缺失与空串的处理本就一致。
 */
function currentPrompt(event: unknown): string | undefined {
  const raw = (event as { prompt?: unknown } | undefined)?.prompt;
  if (typeof raw === "string") return raw;
  const text = (raw as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

/** 取逐轮面包屑；桥不可用时返回 null（调用方降级）。空块（skipped）返回 ""。 */
async function fetchBreadcrumb(root: string, key: string, prompt?: string): Promise<string | null> {
  const res = await bridge.call<{ block?: string }>(
    "workflow.state",
    // prompt 为 undefined 时 JSON.stringify 直接丢掉该键，Go 侧零值 ""——
    // 与「宿主没给 prompt」这一事实一致，不用哨兵值冒充。
    { repoRoot: root, contextKey: key, prompt },
    root,
  );
  if (res.ok) return res.value?.block ?? "";
  return null;
}

// ── 子代理派发编排（编译—派发两步模型的第②③步，req:injection-chain#subagent-dispatch） ────────────────

interface WaitOutcome {
  state: SubagentState;
  subagentId?: string;
  result?: string;
  error?: string;
}

/**
 * 经所选运输层派发一个子代理并等待终态。
 *
 * 等待编排运输无关（req:subagents#subagent-transport-compat：订阅/轮询/超时/中止四路收敛，settled 一次性）：
 *   1. 终态事件订阅先于 spawn（由 SubagentTransport 契约约束在实现内部完成）；
 *   2. pollOnce 每 500ms 轮询兜底——事件丢失（宿主不发、订阅失败）
 *      也不能让等待悬挂；回读出 terminal=false 只当「还在跑」，不据此收敛
 *      （但超时/中止的抓取会取它的 result 保住部分产出）；
 *   3. timeoutMs > 0 时到点 abort，外层信号中止同样映射为 aborted。
 */
async function dispatchSubagent(
  pi: PiApi,
  transport: SubagentTransport,
  agentType: string,
  prompt: string,
  description: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onUpdate?: (r: PiToolResult) => void,
): Promise<WaitOutcome> {
  let agentId: string | null = null;
  let dispose: (() => void) | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const offs: Array<() => void> = [];

  return new Promise<WaitOutcome>((resolveWait) => {
    const finish = (outcome: WaitOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      for (const off of offs) {
        try {
          off();
        } catch {
          // 取消订阅失败不影响结果交付。
        }
      }
      try {
        dispose?.();
      } catch {
        // 同上：实现内部的退订失败不影响结果交付。
      }
      resolveWait(outcome);
    };

    // 超时/中止路径的收尾：先 abort，再尽力抓一次状态保留部分产出
    //（与改造前行为一致：当时直接回传 getRecord 记录，无论是否终态，半截产出
    // 也要交给模型）。抓取限时 250ms——中止的交付及时性优先于部分产出的
    // 完整性（NB 的 status 是真 RPC，总线卡住时不能让它拖住中止）。
    const settleWith = (state: "timeout" | "aborted") => {
      const id = agentId;
      if (id === null) {
        finish({ state });
        return;
      }
      transport.abort(id);
      const grab = transport.pollOnce(id).then(
        (t) => ({ result: t?.result, error: t?.error }),
        () => ({ result: undefined, error: undefined }),
      );
      const cap = new Promise<{ result?: string; error?: string }>((done) =>
        setTimeout(() => done({}), 250),
      );
      void Promise.race([grab, cap]).then((partial) =>
        finish({ state, subagentId: id, result: partial.result, error: partial.error }),
      );
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        settleWith("timeout");
      }, timeoutMs);
    }

    if (signal) {
      const abortNow = () => {
        settleWith("aborted");
      };
      if (signal.aborted) {
        abortNow();
        return;
      }
      signal.addEventListener("abort", abortNow, { once: true });
      offs.push(() => signal.removeEventListener("abort", abortNow));
    }

    // 单飞标志：上一轮查询还没回来就跳过本轮，不让未完成的 RPC 堆积。
    poll = setInterval(() => {
      if (agentId === null || polling) return;
      polling = true;
      transport
        .pollOnce(agentId)
        .then((probe) => {
          // terminal=false 只是「还在跑」，不能据此收敛（否则半个 run 被当终态）。
          if (!probe?.terminal) return;
          finish({
            state: probe.state ?? "failed",
            subagentId: agentId ?? undefined,
            result: probe.result,
            error: probe.error,
          });
        })
        .catch(() => {
          // 单轮查询失败不致命，下一轮再试。
        })
        .finally(() => {
          polling = false;
        });
    }, POLL_INTERVAL_MS);

    // spawn 内部完成「先订阅后派发」；GG 同步返回 id，NB 等一跳 RPC 回信。
    // spawn 失败（同步抛出、回信 success:false / 超时）呈现为 failed，绝不静默。
    try {
      const spawned = transport.spawn(agentType, prompt, {
        description,
        onStarted: () => onUpdate?.({ content: [{ type: "text", text: `${agentType} started.` }] }),
        onTerminal: (t) =>
          finish({ state: t.state, subagentId: agentId ?? undefined, result: t.result, error: t.error }),
      });
      void Promise.resolve(spawned)
        .then((s) => {
          if (settled) {
            // 收敛已先行（超时/中止早于 spawn 回信，NB 的 RPC 往返可达 10s）：
            // 此刻才拿到的 dispose 必须就地调用，否则实现内部的终态/进度
            // 监听跨派发泄漏（编排层 finish 里的 dispose 还是 undefined）。
            try {
              s.dispose();
            } catch {
              // 退订失败无补于事，不影响已交付的结果。
            }
            return;
          }
          agentId = s.id;
          dispose = s.dispose;
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          finish({ state: "failed", subagentId: agentId ?? undefined, error: message });
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish({ state: "failed", subagentId: agentId ?? undefined, error: message });
    }
  });
}

// ── 扩展主体 ──────────────────────────────────────────────────────────

export default function specruneExtension(pi: PiApi): void {
  // 递归闸门的运行时标记：工厂注册发生在拿到会话身份之前（Pi 的扩展
  // API 在工厂阶段不给 ctx），所以工具先注册、session_start 判定后撤销。
  // 缺省 false＝闸门开：session_start 不触发（极少数宿主）时按主会话
  // 处理，宁可漏关不误关。
  let childSession = false;

  // NB 就绪广播的早到监听（req:subagents#transport-probe-order）：扩展加载顺序不定（NB 可能在本项目扩展之后
  // 才加载），就绪广播一旦出现就记下，首次派发可省一次 ping 往返。只加速探测，
  // 不替代探测——接缝在不在仍以派发时的 ping/缓存为准。
  pi.events?.on?.(NB_RPC_READY, () => {
    nbAvailable = true;
  });

  pi.on?.("session_start", (_event, ctx) => {
    childSession = isChildSession(ctx);
    if (childSession) {
      // 从活动工具集摘除派发工具：这是能感知会话身份的最早时机。
      try {
        const active = pi.getActiveTools?.() || [];
        pi.setActiveTools?.(active.filter((n) => n !== TOOL_NAME));
      } catch (err) {
        console.warn("[specrune] 子会话中摘除 specrune_subagent 失败:", err);
      }
      return undefined;
    }
    const root = resolveRoot(ctx);
    if (!isSpecruneProject(root)) return undefined;
    ctx?.ui?.notify?.(
      "SpecRune project context is available. Use specrune_subagent to dispatch implement / check / research agents.",
      "info",
    );
    return undefined;
  });

  pi.on?.("session_shutdown", () => {
    stableCache.clear();
    lastTurn.clear();
    childSession = false;
    // NB 探测缓存按会话生效：新会话重新 ping，不把上一会话的结论带过去。
    nbAvailable = false;
    nbStatusSupported = undefined;
  });

  /**
   * 逐轮注入。
   *
   * 稳定内容写进 pi 的结构化 prompt 段（systemPromptOptions.sections）：pi 会
   * 按段名包标签、只在变化时向 transcript 追补 delta，前缀缓存因此天然安全
   * （req:injection-chain#injection-pipeline-hard-constraints）。返回 systemPrompt 是「整体替换该 run 的 prompt」的重手段，
   * 只在老宿主没有 sections 时才退化为它。
   * 逐轮变化的易变项与面包屑走 append-only 消息，变化时才追加（req:injection-chain#injection-pipeline-hard-constraints）。
   */
  pi.on?.("before_agent_start", async (event, ctx) => {
    if (childSession) return undefined;
    const root = resolveRoot(ctx);
    if (!isSpecruneProject(root)) return undefined;

    const key = getKey(event, ctx);
    const scoped = scopedKey(key, root);

    // ① 稳定段：每「会话 + 根」只算一次，进结构化 prompt 段。
    let stable = stableCache.get(scoped);
    if (stable === undefined) {
      const fetched = await fetchContext(root, key, "stable");
      if (fetched !== null) {
        stable = fetched;
        boundedSet(stableCache, scoped, stable);
        debug(`注入 STABLE ${Buffer.byteLength(stable, "utf8")} 字节 session=${key}`);
      } else {
        // stable 为 undefined 即微缓存本就没命中，没有可回退的东西——如实记跳过。
        // 「没注入」与「注入了但内容为空」在宿主日志里必须能被区分（req:architecture#daemon-lifecycle-retired）。
        debug("跳过 STABLE：桥不可用（本轮无微缓存）");
      }
    } else {
      // 缓存命中是逐轮注入的**常态**（第一轮之后每轮都走这里）。不打这行的话，
      // 开了 SPECRUNE_PLUGIN_DEBUG 的第二轮起日志里只有易变段——外部会读成
      // 「稳定段没注入」，正是本次补观测口要消除的那类歧义（与 OpenCode 侧
      // plugin.ts 的「注入 STABLE 微缓存」对齐）。
      debug(`注入 STABLE 微缓存 ${Buffer.byteLength(stable, "utf8")} 字节 session=${key}`);
    }

    // ② 易变段 + 面包屑：逐轮取，变化时才作为 append-only 消息送达。
    let message:
      | { customType: string; content: string; display: boolean }
      | undefined;
    const volatile = await fetchContext(root, key, "volatile");
    const breadcrumb = await fetchBreadcrumb(root, key, currentPrompt(event));
    // 两者都为 null 表示桥不可用：保留上一次的块，本轮不追加、不阻塞（req:architecture#daemon-process-retired
    // 降级）。per-call 之下没有「重起」这个动作——下一次调用本来就是另一个
    // 全新子进程（冷却期内除外，见 req:architecture#bridge-degradation-contract）。
    if (volatile !== null || breadcrumb !== null) {
      const combined = [breadcrumb, volatile]
        .filter((s): s is string => !!s && s.trim().length > 0)
        .join("\n\n");
      if (combined && combined !== lastTurn.get(scoped)) {
        boundedSet(lastTurn, scoped, combined);
        message = {
          customType: RUNTIME_CONTEXT_TYPE,
          content: `${INJECTION_SENTINEL}\n${combined}`,
          display: false,
        };
        const hasCrumb = !!breadcrumb && breadcrumb.trim().length > 0;
        debug(`注入易变段 ${Buffer.byteLength(combined, "utf8")} 字节（面包屑 ${hasCrumb ? "有" : "无"}）`);
      } else if (combined) {
        // append-only 的正常结果：与上一轮逐字节相同就不重复送达（req:injection-chain#injection-pipeline-hard-constraints）。
        // 这不是降级，如实记成「未变化」而不是「跳过」，免得被误读成故障。
        debug("易变段未变化：与上一轮逐字节相同，按 append-only 不重复送达");
      } else {
        debug("跳过易变段：桥返回空段");
      }
    } else {
      debug("跳过易变段：桥不可用（保留上一轮的块，不阻塞本轮）");
    }

    if (!stable) return message ? { message } : undefined;

    const options = (
      event as
        | { systemPromptOptions?: { sections?: Record<string, string> } }
        | undefined
    )?.systemPromptOptions;
    if (options?.sections) {
      options.sections["specrune-context"] = `${INJECTION_SENTINEL}\n${stable}`;
      return message ? { message } : undefined;
    }

    // 老宿主没有 systemPromptOptions：退化为整体替换该 run 的 prompt。
    const current = String(
      (event as { systemPrompt?: string } | undefined)?.systemPrompt || "",
    );
    return {
      message,
      systemPrompt: [current, `${INJECTION_SENTINEL}\n${stable}`]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  /**
   * 给 shell 命令带上会话标识。
   *
   * 宿主把会话 id 交给钩子，却不交给钩子派生出的 shell 子进程。没有这一步，
   * AI 派生的 `specrune task start/finish` 拿不到身份，只能降级——不写
   * / 清不掉会话指针。
   *
   * 必须同时拦两个 shell 工具：POSIX 上是 `bash`，Windows 上是
   * `powershell`（pi 的 ToolName 联合类型里两者并存）。曾只拦 bash，
   * Windows 上整条身份链路断死，这是本次修复的主因。注入语法与引号
   * 转义按目标 shell 分别处理，变量名用 Go 侧权威名 TRELLIS_CONTEXT_ID。
   * 这是身份通道而非工作流注入，子会话里同样保留。
   */
  pi.on?.("tool_call", (event, ctx) => {
    const ev = event as
      | { toolName?: string; input?: Record<string, unknown> }
      | undefined;
    if (!ev || !ev.input) return undefined;
    const command = ev.input.command;
    if (typeof command !== "string" || hasContextExport(command)) return undefined;
    if (ev.toolName === "bash") {
      ev.input.command = `export TRELLIS_CONTEXT_ID=${shellQuote(getKey(event, ctx))}; ${command}`;
    } else if (ev.toolName === "powershell") {
      ev.input.command = `$env:TRELLIS_CONTEXT_ID = ${psQuote(getKey(event, ctx))}; ${command}`;
    }
    return undefined;
  });

  /**
   * 把子代理的失败如实标出去。
   *
   * 不这么做的话，子代理报错但工具结果看起来是成功的，模型会基于
   * 「我检查过了，没问题」继续往下走——这比直接报错危险得多。
   * state 取值：completed / failed / aborted / timeout。
   */
  pi.on?.("tool_result", (event) => {
    const ev = event as
      | { toolName?: string; details?: unknown }
      | undefined;
    if (!ev || ev.toolName !== TOOL_NAME) return undefined;
    const details = ev.details as Record<string, unknown> | undefined;
    if (!details || details.kind !== "specrune-subagent") return undefined;
    const state = String(details.state || "");
    if (state === "failed" || state === "aborted" || state === "timeout") {
      return { isError: true };
    }
    return undefined;
  });

  pi.registerTool?.({
    name: TOOL_NAME,
    label: "SpecRune Subagent",
    description:
      "Dispatch a SpecRune workflow sub-agent (implement / check / research) with the active task's curated context. Blocks until the sub-agent finishes and returns its report.",
    promptGuidelines: [
      "Use specrune_subagent for SpecRune workflow work: implementation goes to specrune-implement, review goes to specrune-check, and investigation goes to specrune-research when the reading spans five or more files, the answers live outside the repository yet affect requirements, or the reading itself would crowd out the main session's context.",
      "Split an oversized investigation into smaller questions, one specrune-research dispatch each; they may run in parallel.",
      "Before each specrune-research dispatch, run specrune dispatch <slug> to record the handed-in inputs as a dispatch slip (.dispatch/<slug>.json) — the ledger the report's evidence card answers to.",
      "The sub-agent already receives the task's curated spec and research context; do not paste file contents into the prompt.",
    ],
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description:
            "Agent name: specrune-implement, specrune-check, or specrune-research.",
        },
        prompt: {
          type: "string",
          description: "Task prompt for the sub-agent.",
        },
        task: {
          type: "string",
          description:
            "Optional task reference. Defaults to the session's active task.",
        },
        timeout: {
          type: "number",
          description:
            "Optional timeout in milliseconds. On expiry the sub-agent is aborted and the result is marked as a timeout.",
        },
      },
      required: ["agent", "prompt"],
    },
    execute: async (
      _id: string,
      input: SubagentInput | undefined,
      signal?: AbortSignal,
      onUpdate?: (r: PiToolResult) => void,
      ctx?: PiContext,
    ): Promise<PiToolResult> => {
      const root = resolveRoot(ctx);
      const requested = normalizeAgent(String(input?.agent || ""));
      const agent = roleOf(requested) ? requested : `specrune-${requested}`;
      const role = roleOf(agent);

      if (!role) {
        return textResult(
          `Unknown agent: ${requested || "(empty)"}.\n` +
            "Available: specrune-implement, specrune-check, specrune-research.",
        );
      }
      if (!hasDefinition(root, agent)) {
        return textResult(
          `No agent definition found for ${agent}.\n` +
            `Expected: ${join(root, ".pi", "agents", `${agent}.md`)}\n` +
            "Run `specrune init --platform pi` to restore the standard agents.",
        );
      }

      const prompt = String(input?.prompt || "").trim();
      if (!prompt) {
        throw new Error("specrune_subagent requires a non-empty prompt");
      }

      // 运输层选择（req:subagents#transport-probe-order）：GG 服务符号 → NB ping/ready，现场探测，GG 结果
      // 不跨派发缓存。探测不到时按成因归因报可操作错误，绝不静默失败。
      const resolution = await resolveTransport(pi);
      if ("error" in resolution) {
        return {
          content: [{ type: "text", text: resolution.error }],
          details: { kind: "specrune-subagent", state: "failed", agent },
          isError: true,
        };
      }

      // ① 编译：异步 execFile，毫秒级。失败即中止，不产生半截派发。
      const args = [
        "context",
        "compile",
        "--role",
        role,
        "--json",
        "--context-key",
        getKey(undefined, ctx),
      ];
      const task = String(input?.task || "").trim();
      if (task) args.push("--task", task);

      onUpdate?.({
        content: [{ type: "text", text: `Compiling context for ${agent}…` }],
      });

      let compiled: { role?: string; task?: string; context?: string; snapshotId?: string };
      try {
        compiled = JSON.parse(await runCli(args, root, CLI_TIMEOUT_MS)) as typeof compiled;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text",
              text: `Failed to compile context for ${agent}: ${message}`,
            },
          ],
          details: { kind: "specrune-subagent", state: "failed", agent },
          isError: true,
        };
      }
      const context = String(compiled.context || "");
      if (!context.trim()) {
        return {
          content: [
            {
              type: "text",
              text: `Context compilation for ${agent} returned an empty block; dispatch aborted.`,
            },
          ],
          details: { kind: "specrune-subagent", state: "failed", agent },
          isError: true,
        };
      }

      // ② 派发：curated context + 用户 prompt，经所选运输层的子会话。
      const description = `${agent}: ${prompt.slice(0, 80)}`;
      onUpdate?.({
        content: [{ type: "text", text: `Dispatching ${agent}…` }],
      });
      const timeoutMs = Number(input?.timeout || 0);
      const outcome = await dispatchSubagent(
        pi,
        resolution.transport,
        agent,
        `${INJECTION_SENTINEL}\n${context}\n\n---\n\n${prompt}`,
        description,
        timeoutMs,
        signal,
        onUpdate,
      );

      const details: Record<string, unknown> = {
        kind: "specrune-subagent",
        state: outcome.state,
        agent,
        subagentId: outcome.subagentId,
        snapshotId: compiled.snapshotId,
        task: String(compiled.task || task || ""),
      };

      if (outcome.state === "completed") {
        const output = String(outcome.result || "").trim();
        return {
          content: [{ type: "text", text: output || `${agent} completed.` }],
          details,
        };
      }

      const reason = String(outcome.error || "").trim();
      let text: string;
      if (outcome.state === "timeout") {
        text = `${agent} timed out after ${Math.floor(timeoutMs)}ms and was aborted.`;
      } else if (outcome.state === "aborted") {
        text = `${agent} was aborted.`;
      } else {
        text = `${agent} failed${reason ? `: ${reason}` : "."}`;
      }
      const partial = String(outcome.result || "").trim();
      if (partial) text += `\n\nPartial output:\n${partial}`;
      return { content: [{ type: "text", text }], details, isError: true };
    },
  });
}

function textResult(text: string): PiToolResult {
  return { content: [{ type: "text", text }] };
}
