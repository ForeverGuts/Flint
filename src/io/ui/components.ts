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

  /**
   * 按位插入子组件（index 越界时退化为追加）。
   * 调用方：TreeUI.endReply（流式框封口时把💭/⏳摘要补挂到正文之前）
   * 服务于：内容已成型后仍需在中部插行，避免整框重建带来的跳变
   */
  insertChild(component: Component, index: number): void {
    const at = Math.max(0, Math.min(index, this.children.length));
    this.children.splice(at, 0, component);
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
  /** 分组名（如 "内置" / "自定义"），渲染时组前插标题 */
  group?: string;
  /** 多选模式下该项是否已勾选 */
  selected?: boolean;
}

export class SelectList implements Component {
  /** 当前选中项索引（相对过滤后的列表） */
  private selected = 0;
  /** 当前页偏移 */
  private pageOffset = 0;
  /** 每页显示条数 */
  readonly pageSize: number;
  /** 搜索词（非空时过滤选项） */
  private search = '';
  /** 是否多选（默认单选，向后兼容） */
  private multi: boolean;

  constructor(
    private items: SelectItem[],
    private title?: string,
    pageSize = 8,
    multi = false,
  ) {
    this.pageSize = pageSize;
    this.multi = multi;
  }

  /** 当前可见列表（搜索过滤后的子集） */
  private get visibleItems(): SelectItem[] {
    if (!this.search) return this.items;
    const q = this.search.toLowerCase();
    return this.items.filter((it) => it.label.toLowerCase().includes(q));
  }

  /** 当前选中的值 */
  get value(): string {
    return this.visibleItems[this.selected]?.value ?? '';
  }

  /** 当前选中索引 */
  get selectedIndex(): number {
    return this.selected;
  }

  /** 多选模式：获取所有已勾选值 */
  get selectedValues(): string[] {
    return this.items.filter((it) => it.selected).map((it) => it.value);
  }

  /**
   * 处理按键。
   * 返回 { changed: boolean, done?: string | string[] }：
   *   - changed=true 表示选中项/页面/搜索变化，需重绘
   *   - done 为选中值（Enter 确认，多选时为数组）或 'cancel'（Ctrl+C 取消）
   */
  handleInput(data: string): { changed: boolean; done?: string | string[] } {
    const list = this.visibleItems;

    // 多选模式：空格切换勾选（优先于搜索字符判定）
    if (data === ' ' && this.multi) {
      const item = list[this.selected];
      if (item && !item.disabled) {
        item.selected = !item.selected;
        return { changed: true };
      }
      return { changed: false };
    }

    // 搜索模式：普通字符进搜索词（过滤列表；空格在多选时已被上方消费）
    if (data.length === 1 && data.charCodeAt(0) >= 0x20 && data !== '\x7f') {
      this.search += data;
      this.selected = 0;
      this.pageOffset = 0;
      return { changed: true };
    }
    // 退格：删搜索词最后一个字符
    if (data === '\x7f' || data === '\x08') {
      if (this.search) {
        this.search = this.search.slice(0, -1);
        this.selected = 0;
        this.pageOffset = 0;
        return { changed: true };
      }
      return { changed: false };
    }
    // 清空搜索（Esc）
    if (data === '\x1b') {
      if (this.search) {
        this.search = '';
        this.selected = 0;
        this.pageOffset = 0;
        return { changed: true };
      }
      return { changed: false };
    }

    if (data === '\x1b[A') {
      // ↑（在过滤后的列表里导航）
      const old = this.selected;
      do {
        this.selected = (this.selected - 1 + list.length) % list.length;
      } while (list[this.selected]?.disabled && this.selected !== old);
      this.ensureSelectedVisible();
      return { changed: true };
    }
    if (data === '\x1b[B') {
      // ↓
      const old = this.selected;
      do {
        this.selected = (this.selected + 1) % list.length;
      } while (list[this.selected]?.disabled && this.selected !== old);
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
      if (this.pageOffset + this.pageSize < list.length) {
        this.pageOffset += this.pageSize;
        this.selected = this.pageOffset;
        return { changed: true };
      }
      return { changed: false };
    }
    // Enter 确认（多选返回勾选集，单选返回选中值）
    if (data === '\r' || data === '\n') {
      const item = list[this.selected];
      if (item && !item.disabled) {
        if (this.multi) {
          return { changed: false, done: this.selectedValues };
        }
        return { changed: false, done: item.value };
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
    const list = this.visibleItems;
    if (this.selected < this.pageOffset || this.selected >= this.pageOffset + this.pageSize) {
      this.pageOffset = Math.floor(this.selected / this.pageSize) * this.pageSize;
    }
    void list;
  }

  /** 按数字键跳转（全局序号） */
  handleNumber(num: number): boolean {
    const list = this.visibleItems;
    const idx = num - 1;
    if (idx < list.length && !list[idx].disabled) {
      this.selected = idx;
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const maxLineWidth = Math.max(1, width - 1);
    const list = this.visibleItems;

    if (this.title) {
      lines.push(fitWidth(`  ${this.title}`, maxLineWidth));
      lines.push(fitWidth(`  ${'─'.repeat(40)}`, maxLineWidth));
    }

    // 搜索框（搜索激活时显示）
    if (this.search) {
      lines.push(fitWidth(`  🔍 ${this.search}`, maxLineWidth));
    }

    // 分组渲染：遍历可见项，组切换时插组标题
    const startIdx = this.pageOffset;
    const endIdx = Math.min(startIdx + this.pageSize, list.length);
    let lastGroup: string | undefined;
    for (let i = startIdx; i < endIdx; i++) {
      const item = list[i];
      // 分组标题（组变化时插一行）
      if (item.group && item.group !== lastGroup) {
        lines.push(fitWidth(`  \x1b[2m─ ${item.group} ─\x1b[0m`, maxLineWidth));
        lastGroup = item.group;
      }
      const marker = i === this.selected ? '❯' : ' ';
      const num = String(i + 1).padStart(2);
      // 多选勾选标记
      const check = this.multi ? (item.selected ? '☑ ' : '☐ ') : '';
      const label = item.disabled
        ? `${item.label} (不可用)`
        : i === this.selected
          ? `\x1b[36m${check}${item.label}\x1b[0m`
          : `${check}${item.label}`;
      const desc = item.description ? ` \x1b[2m${item.description.slice(0, 30)}\x1b[0m` : '';
      lines.push(fitWidth(`  ${marker} ${num} ${label}${desc}`, maxLineWidth));
    }

    if (list.length > this.pageSize) {
      const totalPages = Math.ceil(list.length / this.pageSize);
      const curPage = Math.floor(this.pageOffset / this.pageSize) + 1;
      lines.push(fitWidth(`  \x1b[2m第 ${curPage}/${totalPages} 页\x1b[0m`, maxLineWidth));
    }

    const hint = this.multi
      ? '↑↓ 移动  Space 勾选  Enter 确认  Ctrl+C 取消'
      : '↑↓ 切换  Enter 确认  Ctrl+C 取消';
    lines.push(fitWidth(`  \x1b[2m${hint}${this.search ? '  输入搜索' : ''}\x1b[0m`, maxLineWidth));
    return lines;
  }
}
