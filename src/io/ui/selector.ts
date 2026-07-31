/**
 * 通用终端选择器 —— ↑↓ 方向键导航、Enter 确认。
 *
 * 不漂移的核心策略：
 *   固定输出行数 = pageSize + RESERVED_EXTRA（预留额外行），
 *   不足的用空行 \x1b[2K 填充。每次重绘都输出相同行数，
 *   回退相同行数，不会因内容行数变化而漂移。
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
/** 标题 + 分隔线 + 页码 + 提示行 + 保险空行 */
const RESERVED_EXTRA = 6;

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
      /** 固定输出区域高度，永不改变 */
      const FIXED_LINES = pageSize + RESERVED_EXTRA;

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
          const num = `${i - startIdx + 1}`.padStart(2);
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
       * 每次输出恰好 FIXED_LINES 行，不足的用空行填充。
       */
      function render(): void {
        const rows = buildRows();
        // 逐行输出，每行先 \r\x1b[2K 清空，再写内容
        for (let i = 0; i < FIXED_LINES; i++) {
          if (i < rows.length) {
            process.stdout.write(`\r\x1b[2K${rows[i]}`);
          } else {
            process.stdout.write(`\r\x1b[2K`); // 空行填充，覆盖旧内容
          }
          if (i < FIXED_LINES - 1) {
            process.stdout.write('\n');
          }
        }
        // 回退到区域顶部，为下一次重绘做准备
        process.stdout.write(`\x1b[${FIXED_LINES}A`);
      }

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
          // 从第一项循环到末尾 → 跳到最后一页
          if (old === 0 && selected > old) {
            pageOffset = options.length > pageSize ? options.length - pageSize : 0;
          } else if (selected < pageOffset) {
            pageOffset = Math.max(0, pageOffset - pageSize);
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
            pageOffset = Math.min(options.length - pageSize, pageOffset + pageSize);
          }
          changed = true;
        } else if (str === '\x1b[D') {
          if (pageOffset > 0) {
            pageOffset = Math.max(0, pageOffset - pageSize);
            selected = pageOffset;
            changed = true;
          }
        } else if (str === '\x1b[C') {
          if (pageOffset + pageSize < options.length) {
            pageOffset = Math.min(options.length - pageSize, pageOffset + pageSize);
            selected = pageOffset;
            changed = true;
          }
        } else if (/^[1-9]$/.test(str)) {
          const num = parseInt(str, 10);
          const idx = pageOffset + num - 1;
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
        // 清空整个选择区域
        process.stdout.write(`\x1b[${FIXED_LINES}A`);
        for (let i = 0; i < FIXED_LINES; i++) {
          process.stdout.write('\r\x1b[2K');
          if (i < FIXED_LINES - 1) process.stdout.write('\x1b[B');
        }
        process.stdout.write(`\x1b[${FIXED_LINES}A`);
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
