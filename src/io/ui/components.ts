/**
 * 组件树 —— 自研极简组件系统（方案 2）。
 * 调用方：TreeUI（TTY 模式）
 * 服务于：声明式构建 UI，每个组件 render(width) 返回行数组，递归拼接成整屏
 *
 * 组件树结构（类比 DOM）：
 *   Container（容器）         = <div>，装子组件
 *   Text（文本）              = <p>，单行/多行文本
 *   SelectList（选择器）      = <select>，↑↓ 导航选项
 *   根 Container = 整屏内容
 *
 * 渲染：根 render(width) → 递归调用每个子组件的 render → 行数组拼接
 * 差分：TreeUI 把根渲染出的行数组交给 Screen.render() 差分写入
 */
import { fitWidth } from './fit-width.js';

/* ════════════════════════════════════════════════════════════════════════════
   组件接口
   ════════════════════════════════════════════════════════════════════════════ */

export interface Component {
  /** 渲染成行数组（每行宽度不超过 width） */
  render(width: number): string[];
}

/* ════════════════════════════════════════════════════════════════════════════
   Container —— 容器组件（垂直拼接子组件）
   ════════════════════════════════════════════════════════════════════════════ */

export class Container implements Component {
  private children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  /** 移除子组件（选择器结束后移除 selectBox） */
  removeChild(component: Component): void {
    const idx = this.children.indexOf(component);
    if (idx !== -1) this.children.splice(idx, 1);
  }

  clear(): void {
    this.children = [];
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      const childLines = child.render(width);
      for (const line of childLines) {
        lines.push(line);
      }
    }
    return lines;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   Text —— 文本组件（支持多行，自动换行，每行 fitWidth 截断）
   ════════════════════════════════════════════════════════════════════════════ */

export class Text implements Component {
  constructor(private text: string) {}

  /** 更新文本内容 */
  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    // 按 \n 切行，每行 fitWidth 截断到 width
    const rawLines = this.text.split('\n');
    const maxLineWidth = Math.max(1, width - 1);
    const result: string[] = [];
    for (const raw of rawLines) {
      // 简单折行：超过 maxLineWidth 的文本截断（不折行，保持行数稳定）
      result.push(fitWidth(raw, maxLineWidth));
    }
    return result;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   SelectList —— 选择器组件（↑↓ 导航，Enter 确认）
   ════════════════════════════════════════════════════════════════════════════ */

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export class SelectList implements Component {
  /** 当前选中项索引 */
  private selected = 0;
  /** 当前页偏移 */
  private pageOffset = 0;
  /** 每页显示条数 */
  readonly pageSize: number;

  constructor(
    private items: SelectItem[],
    private title?: string,
    pageSize = 8,
  ) {
    this.pageSize = pageSize;
  }

  /** 当前选中的值 */
  get value(): string {
    return this.items[this.selected]?.value ?? '';
  }

  /** 当前选中索引 */
  get selectedIndex(): number {
    return this.selected;
  }

  /**
   * 处理按键。
   * 返回 { changed: boolean, done?: string }：
   *   - changed=true 表示选中项/页面变化，需重绘
   *   - done 为选中值（Enter 确认）或 'cancel'（Ctrl+C 取消）
   */
  handleInput(data: string): { changed: boolean; done?: string } {
    if (data === '\x1b[A') {
      // ↑
      const old = this.selected;
      do {
        this.selected = (this.selected - 1 + this.items.length) % this.items.length;
      } while (this.items[this.selected].disabled && this.selected !== old);
      this.ensureSelectedVisible();
      return { changed: true };
    }
    if (data === '\x1b[B') {
      // ↓
      const old = this.selected;
      do {
        this.selected = (this.selected + 1) % this.items.length;
      } while (this.items[this.selected].disabled && this.selected !== old);
      this.ensureSelectedVisible();
      return { changed: true };
    }
    if (data === '\x1b[D') {
      // ← 上一页
      if (this.pageOffset > 0) {
        this.pageOffset = Math.max(0, this.pageOffset - this.pageSize);
        this.selected = this.pageOffset;
        return { changed: true };
      }
      return { changed: false };
    }
    if (data === '\x1b[C') {
      // → 下一页
      if (this.pageOffset + this.pageSize < this.items.length) {
        this.pageOffset += this.pageSize;
        this.selected = this.pageOffset;
        return { changed: true };
      }
      return { changed: false };
    }
    // Enter 确认
    if (data === '\r' || data === '\n') {
      if (!this.items[this.selected].disabled) {
        return { changed: false, done: this.value };
      }
      return { changed: false };
    }
    // Ctrl+C 取消
    if (data === '\x03') {
      return { changed: false, done: 'cancel' };
    }
    return { changed: false };
  }

  /**
   * 确保 selected 在当前页可见范围内；否则翻到它所在的页。
   * 修复：↑ 从第一项 wrap 到末项时，selected 跑到当前页之外，
   * 旧逻辑只查 selected < pageOffset，导致不翻页、箭头消失、按久循环回原页。
   */
  private ensureSelectedVisible(): void {
    if (this.selected < this.pageOffset || this.selected >= this.pageOffset + this.pageSize) {
      this.pageOffset = Math.floor(this.selected / this.pageSize) * this.pageSize;
    }
  }

  /** 按数字键跳转（全局序号） */
  handleNumber(num: number): boolean {
    const idx = num - 1;
    if (idx < this.items.length && !this.items[idx].disabled) {
      this.selected = idx;
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const maxLineWidth = Math.max(1, width - 1);

    if (this.title) {
      lines.push(fitWidth(`  ${this.title}`, maxLineWidth));
      lines.push(fitWidth(`  ${'─'.repeat(40)}`, maxLineWidth));
    }

    const startIdx = this.pageOffset;
    const endIdx = Math.min(startIdx + this.pageSize, this.items.length);
    for (let i = startIdx; i < endIdx; i++) {
      const item = this.items[i];
      const marker = i === this.selected ? '❯' : ' ';
      const num = String(i + 1).padStart(2);
      const label = item.disabled
        ? `${item.label} (不可用)`
        : i === this.selected
          ? `\x1b[36m${item.label}\x1b[0m`
          : item.label;
      const desc = item.description ? ` \x1b[2m${item.description.slice(0, 30)}\x1b[0m` : '';
      lines.push(fitWidth(`  ${marker} ${num} ${label}${desc}`, maxLineWidth));
    }

    if (this.items.length > this.pageSize) {
      const totalPages = Math.ceil(this.items.length / this.pageSize);
      const curPage = Math.floor(this.pageOffset / this.pageSize) + 1;
      lines.push(fitWidth(`  \x1b[2m第 ${curPage}/${totalPages} 页\x1b[0m`, maxLineWidth));
    }

    lines.push(fitWidth(`  \x1b[2m↑↓ 切换  Enter 确认  Ctrl+C 取消\x1b[0m`, maxLineWidth));
    return lines;
  }
}
