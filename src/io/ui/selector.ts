/**
 * 通用终端选择器 —— ↑↓ 方向键导航、Enter 确认。
 *
 * 不漂移的核心策略：
 *   ① 进入选择器时用 \x1b[s 保存光标位置作为锚点（在 banner 之后）。
 *   ② 每次重绘：\x1b[u 恢复到锚点 → \x1b[0J 清除锚点到屏幕末尾 → 重新打印。
 *      锚点上方（banner 等）由终端记住绝对位置，物理上不可能被动到。
 *   ③ 每行用 fitWidth 裁剪到终端宽度内，防止 wrap 导致内容错乱。
 *   不再依赖"回退 N 行"计数（任何 wrap / 终端差异都会导致回退不到位）。
 */
export type SelectorChoice<T = string> = {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
};

interface SelectorTheme {
  accent: string;
  dim: string;
  reset: string;
  bold: string;
}

const defaultTheme: SelectorTheme = {
  accent: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

const DESC_MAX = 30;

/**
 * 把文本裁剪到指定"可见宽度"（忽略 ANSI 颜色码，中文/全角按 2 宽度计）。
 * 保证输出的每一行都不会触发终端自动换行（wrap），从而：
 *   打印行数 == 物理行数 → 光标回退精确 → 选择器不漂移。
 */
function fitWidth(text: string, maxWidth: number): string {
  let out = '';
  let width = 0;
  let inAnsi = false;   // 是否正在累积 ANSI 转义序列
  let ansiBuf = '';     // 累积中的 ANSI 序列

  for (const ch of text) {
    if (inAnsi) {
      ansiBuf += ch;
      if (ch === 'm') {        // ANSI 序列结束（如 \x1b[36m）
        inAnsi = false;
        out += ansiBuf;
        ansiBuf = '';
      }
      continue; // ANSI 序列本身不计宽度
    }
    if (ch === '\x1b') {
      inAnsi = true;
      ansiBuf = '\x1b';
      continue;
    }
    const w = ch.charCodeAt(0) > 0xFF ? 2 : 1; // 中文/全角 = 2 列
    if (width + w > maxWidth) break;           // 超宽截断（丢弃剩余）
    out += ch;
    width += w;
  }
  if (inAnsi) out += ansiBuf; // 兜底：补上未闭合的 ANSI 序列，避免颜色泄漏到后续行
  return out;
}

export async function selectFromList<T = string>(
  options: SelectorChoice<T>[],
  title?: string,
  theme: SelectorTheme = defaultTheme,
  pageSize = 8,
): Promise<T | undefined> {
  if (!process.stdin.isTTY) {
    return options.find(o => !o.disabled)?.value;
  }

  const savedDataListeners = process.stdin.rawListeners('data') as Array<(...args: unknown[]) => void>;
  process.stdin.removeAllListeners('data');
  const savedKeypressListeners = process.stdin.rawListeners('keypress') as Array<(...args: unknown[]) => void>;
  process.stdin.removeAllListeners('keypress');

  try {
    return await new Promise<T | undefined>((resolve) => {
      const wasRaw = process.stdin.isRaw;
      if (!wasRaw) process.stdin.setRawMode(true);
      process.stdin.resume();

      let selected = 0;
      let pageOffset = 0;

      function buildRows(): string[] {
        const rows: string[] = [];
        if (title) {
          rows.push(`  ${theme.bold}${title}${theme.reset}`);
          rows.push(`  ${theme.dim}${'─'.repeat(40)}${theme.reset}`);
        }
        const startIdx = pageOffset;
        const endIdx = Math.min(startIdx + pageSize, options.length);
        for (let i = startIdx; i < endIdx; i++) {
          const opt = options[i];
          const marker = i === selected ? '❯' : ' ';
          const num = `${i + 1}`.padStart(2); // 全局序号，跨页连续（第2页从9开始）
          const label = opt.disabled
            ? `${theme.dim}${opt.label} (不可用)${theme.reset}`
            : i === selected
              ? `${theme.accent}${opt.label}${theme.reset}`
              : opt.label;
          const desc = opt.description
            ? ` ${theme.dim}${opt.description.slice(0, DESC_MAX)}${theme.reset}`
            : '';
          rows.push(`  ${marker} ${num} ${label}${desc}`);
        }
        if (options.length > pageSize) {
          const totalPages = Math.ceil(options.length / pageSize);
          const curPage = Math.floor(pageOffset / pageSize) + 1;
          rows.push(`  ${theme.dim}第 ${curPage}/${totalPages} 页${theme.reset}`);
        }
        rows.push(`  ${theme.dim}↑↓ 切换  Enter 确认  Ctrl+C 取消${theme.reset}`);
        return rows;
      }

      /**
       * 完整绘制到终端。
       *
       * 不漂移的关键：不再用"回退 N 行"计数（任何 wrap / 终端差异都会导致回退不到位）。
       * 改用终端的光标位置保存/恢复 + 清屏重绘：
       *   ① \x1b[s 保存锚点：进入选择器时保存一次，锚点在 banner 之后
       *   ② \x1b[u 恢复锚点：每次重绘都回到同一绝对位置
       *   ③ \x1b[0J 清除从锚点到屏幕末尾的全部内容（旧选择器）
       *   ④ 重新打印新内容
       * 锚点上方（banner 等）由终端记住绝对位置，物理上不可能被动到。
       */
      function render(): void {
        process.stdout.write('\x1b[u');  // 恢复锚点（banner 之后）
        process.stdout.write('\x1b[0J'); // 清除锚点之后的所有内容
        const rows = buildRows();
        const maxLineWidth = (process.stdout.columns ?? 80) - 1;
        for (let i = 0; i < rows.length; i++) {
          process.stdout.write(fitWidth(rows[i], maxLineWidth));
          if (i < rows.length - 1) process.stdout.write('\n');
        }
      }

      // 进入选择器：保存锚点（当前光标位置 = 选择器顶部），隐藏光标，首次渲染
      process.stdout.write('\x1b[s');
      process.stdout.write('\x1b[?25l');
      render();

      const onData = (chunk: Buffer) => {
        const str = chunk.toString();
        let changed = false;

        if (str === '\x1b[A') {
          const old = selected;
          do {
            selected = (selected - 1 + options.length) % options.length;
          } while (options[selected].disabled && selected !== old);
          // 从第一项循环到末尾 → 跳到最后一页的页首
          if (old === 0 && selected > old) {
            const lastPageStart = Math.floor((options.length - 1) / pageSize) * pageSize;
            pageOffset = lastPageStart;
          } else if (selected < pageOffset) {
            // 上移到上一页 → 跳到 selected 所在页的页首
            pageOffset = Math.floor(selected / pageSize) * pageSize;
          }
          changed = true;
        } else if (str === '\x1b[B') {
          const old = selected;
          do {
            selected = (selected + 1) % options.length;
          } while (options[selected].disabled && selected !== old);
          // 从最后一项翻到第一项 → 跳到第一页
          if (old === options.length - 1 && selected < old) {
            pageOffset = 0;
          } else if (selected >= pageOffset + pageSize) {
            // selected 超出当前页可见区 → 跳到 selected 所在页的页首
            pageOffset = Math.floor(selected / pageSize) * pageSize;
          }
          changed = true;
        } else if (str === '\x1b[D') {
          // 上一页：pageOffset 减一页（回到上一页页首）
          if (pageOffset > 0) {
            pageOffset = Math.max(0, pageOffset - pageSize);
            selected = pageOffset;
            changed = true;
          }
        } else if (str === '\x1b[C') {
          // 下一页：pageOffset 加一页（跳到下一页页首）
          if (pageOffset + pageSize < options.length) {
            pageOffset += pageSize;
            selected = pageOffset;
            changed = true;
          }
        } else if (/^[1-9]$/.test(str)) {
          const num = parseInt(str, 10);
          const idx = num - 1; // 全局序号：显示什么数字就选中第几项
          if (idx < options.length && !options[idx].disabled) {
            selected = idx;
            finish(options[selected].value);
          }
          return;
        } else if (str === '\r' || str === '\n') {
          if (!options[selected].disabled) {
            finish(options[selected].value);
          }
          return;
        } else if (str === '\x03') {
          finish(undefined);
          return;
        }

        if (changed) {
          render();
        }
      };

      const finish = (result: T | undefined) => {
        process.stdin.removeListener('data', onData);
        if (!wasRaw) process.stdin.setRawMode(false);
        // 恢复锚点 → 清除选择器内容 → 光标停在锚点（banner 之后），调用方可继续
        process.stdout.write('\x1b[u');
        process.stdout.write('\x1b[0J');
        process.stdout.write('\x1b[?25h');
        resolve(result);
      };

      process.stdin.on('data', onData);
    });
  } finally {
    for (const listener of savedDataListeners) {
      process.stdin.on('data', listener);
    }
    for (const listener of savedKeypressListeners) {
      process.stdin.on('keypress', listener);
    }
  }
}
