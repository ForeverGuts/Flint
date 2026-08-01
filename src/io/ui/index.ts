/**
 * UI 主类 —— 管理所有 UI 组件和事件路由。
 *
 * 消息框设计（无竖线，完全避免错位）：
 *
 *   ┌── YOU ──────────────────────────┐
 *     用户输入文本
 *   └──────────────────────────────────┘
 *
 *   ┌── TS AGENT ─────────────────────┐
 *     AI 回复文本（每行缩进 2 空格）
 *   └──────────────────────────────────┘
 */
import type { Runtime } from '../../runtime/runtime.js';
import { StatusIndicator } from './status.js';

export { StatusIndicator } from './status.js';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightWhite: '\x1b[97m',
  bgBrightGreen: '\x1b[102m',
  bgGreen: '\x1b[42m',
};

const BOX_W = 48;
const INDENT = 2;

/** 上边框：┌── 标签 ────────┐ */
function top(color: string, label: string, labelColor: string): string {
  const fill = '─'.repeat(Math.max(0, BOX_W - label.length - 4));
  return `${' '.repeat(INDENT)}${color}┌${'─'.repeat(2)}${C.reset}${labelColor}${label}${C.reset}${color}${fill}┐${C.reset}`;
}

/** 下边框：└──────────────────┘ */
function bot(color: string): string {
  return `${' '.repeat(INDENT)}${color}└${'─'.repeat(BOX_W - 2)}┘${C.reset}`;
}

export class TerminalUI {
  private spinner = new StatusIndicator();
  private isNewResponse = true;
  /** 流式输出是否处于"行首"（跨片维护，保证每行缩进正确，杜绝顶格/空段错位） */
  private atLineStart = false;
  private lastUsage: { current: { totalTokens: number }; total: { totalTokens: number } } | null = null;

  /* ── 启动 Banner ── */

  showBanner(info: {
    model: string;
    baseUrl: string;
    sessionMsgs: number;
    toolCount: number;
    cmdCount: number;
    skillCount: number;
  }): void {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
    const nodeVersion = process.version;
    const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : 'macOS';
    const cwd = process.cwd().split(/[/\\]/).pop() || '';
    const leftCol = 14;
    const pad = (s: string) => s.padEnd(leftCol);

    const backendLabel = info.baseUrl.includes('opencode') ? 'OpenCode Go'
      : info.baseUrl.includes('deepseek') ? 'DeepSeek'
      : info.baseUrl.includes('127.0.0.1') ? 'CC Switch'
      : info.baseUrl || 'local';

    console.log();
    console.log(`${' '.repeat(INDENT)}${C.bgGreen}${C.bold}${C.white}   ◆  Ts Agent v0.1.0  ◆   ${C.reset}`);
    console.log(`${' '.repeat(INDENT)}${C.green}${C.dim}${'━'.repeat(BOX_W)}${C.reset}`);
    console.log(`${' '.repeat(INDENT)}${C.dim}${pad('Backend')}${C.reset}   ${backendLabel}`);
    console.log(`${' '.repeat(INDENT)}${C.dim}${pad('Model')}${C.reset}   ${C.bold}${info.model}${C.reset}`);
    console.log(`${' '.repeat(INDENT)}${C.dim}${pad('Mode')}${C.reset}   ${C.bold}REPL${C.reset}  │  ${C.dim}tools${C.reset} ${info.toolCount}  ${C.dim}skills${C.reset} ${info.skillCount}  ${C.dim}cmds${C.reset} ${info.cmdCount}`);
    const sessionStatus = info.sessionMsgs > 0 ? `${C.bold}${info.sessionMsgs}${C.reset} msgs` : `${C.dim}new session${C.reset}`;
    console.log(`${' '.repeat(INDENT)}${C.dim}${pad('Session')}${C.reset}   ${sessionStatus}  │  ${C.dim}${dateStr} ${timeStr}${C.reset}`);
    console.log(`${' '.repeat(INDENT)}${C.dim}${pad('Runtime')}${C.reset}   Node${nodeVersion}  ·  ${platform}  ·  ${C.dim}${cwd}${C.reset}`);
    console.log(`${' '.repeat(INDENT)}${C.green}${'─'.repeat(BOX_W)}${C.reset}`);
    console.log(`${' '.repeat(INDENT)}${C.dim}${C.italic}  /help  ·  /exit  ·  /clear  ·  /model  ·  /usage${C.reset}`);
    console.log(`${' '.repeat(INDENT)}${C.green}${'─'.repeat(BOX_W)}${C.reset}`);
    console.log();
  }

  /* ── 用户输入框 ── */

  showUserInput(text: string): void {
    const label = ' YOU ';
    console.log(top(C.blue, label, `${C.bold}${C.brightBlue}`));
    const maxW = BOX_W - 4;
    if (text.length > maxW) {
      for (let i = 0; i < text.length; i += maxW) {
        console.log(`${' '.repeat(INDENT)}  ${C.brightWhite}${text.slice(i, i + maxW)}${C.reset}`);
      }
    } else {
      console.log(`${' '.repeat(INDENT)}  ${C.brightWhite}${text}${C.reset}`);
    }
    console.log(bot(C.blue));
  }

  /* ── 事件绑定 ── */

  attach(runtime: Runtime): void {
    runtime.subscribe((event) => {
      switch (event.type) {
        case 'thinking': {
          this.spinner.stop();
          const phaseMap: Record<string, string> = {
            analyzing: '⏳ 思考中...',
            compressing: '📦 压缩上下文中...',
            calling_tools: '🔧 调用工具...',
            streaming: '💬 生成中...',
          };
          this.spinner.start(phaseMap[event.phase] ?? `⏳ ${event.phase}...`);
          break;
        }

        case 'stream_text': {
          if (this.isNewResponse) {
            this.spinner.stop();
            const label = ' TS AGENT ';
            console.log(top(C.green, label, `${C.bold}${C.brightGreen}`));
            this.atLineStart = true; // 新回复从行首开始
            this.isNewResponse = false;
          }

          // 逐片写入，跨片维护"是否在行首"状态，保证每行都有正确缩进。
          // 不能只对片内 \n 做 replace —— 一片结尾是 \n 时，下一片开头是文字，
          // 若不记录状态，下一片就顶格写了（这就是空段/顶格的根源）。
          const indent = `${' '.repeat(INDENT)}  `;
          const text = event.text;
          let i = 0;
          // 若当前在行首，先补缩进
          if (this.atLineStart) {
            process.stdout.write(indent);
          }
          while (i < text.length) {
            const nl = text.indexOf('\n', i);
            if (nl === -1) {
              // 没有换行：写剩余，更新 atLineStart = 是否以 \n 结尾
              process.stdout.write(text.slice(i));
              this.atLineStart = false;
              break;
            }
            // 遇到换行：写 [i..nl] 不含 \n，输出 \n，行首标记置真
            process.stdout.write(text.slice(i, nl) + '\n');
            this.atLineStart = true;
            // 下一个片段若还有内容，需要补缩进（除非又是空行）
            if (nl + 1 < text.length && text[nl + 1] !== '\n') {
              process.stdout.write(indent);
            } else if (nl + 1 < text.length) {
              // 连续换行（空行）：不补缩进，直接留空行
            }
            i = nl + 1;
          }
          break;
        }

        case 'tool_execution_start': {
          this.spinner.stop();
          const args = event.args ? JSON.stringify(event.args).slice(0, 60) : '';
          const label = ` ${event.name.toUpperCase()} `;
          console.log(`\n${top(C.yellow, label, `${C.bold}${C.brightYellow}`)}`);
          if (args) {
            console.log(`${' '.repeat(INDENT)}  ${C.dim}${args}${C.reset}`);
          }
          this.spinner.start(`等待 ${event.name} 完成...`);
          break;
        }

        case 'tool_execution_end': {
          this.spinner.stop();
          const resultStr = typeof event.result === 'string' ? event.result.slice(0, 80) : '';
          const isOk = resultStr.includes('✅') || resultStr.includes('[OK]');
          const isErr = resultStr.includes('❌') || resultStr.includes('失败') || resultStr.includes('[ERROR]');
          const color = isErr ? C.red : isOk ? C.green : C.dim;
          console.log(`${' '.repeat(INDENT)}  ${color}${resultStr}${C.reset}`);
          console.log(bot(C.yellow));
          break;
        }

        case 'usage':
          this.lastUsage = event;
          break;

        case 'agent_end': {
          this.spinner.stop();
          console.log();
          console.log(bot(C.green));
          if (this.lastUsage) {
            const u = this.lastUsage;
            console.log(`${' '.repeat(INDENT)}${C.dim}⚡ ${u.current.totalTokens} tokens  · 累计 ${u.total.totalTokens}${C.reset}`);
            this.lastUsage = null;
          }
          console.log();
          this.isNewResponse = true;
          this.atLineStart = false;
          break;
        }

        case 'error':
          this.spinner.stop();
          console.log(top(C.red, ' ERROR ', `${C.bold}${C.brightRed}`));
          console.log(`${' '.repeat(INDENT)}  ${C.red}${event.message}${C.reset}`);
          console.log(bot(C.red));
          break;
      }
    });
  }

  detach(): void {
    this.spinner.stop();
  }
}
