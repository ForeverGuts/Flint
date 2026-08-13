/**
 * Input 事件处理器示例（非命令，纯演示）。
 * 调用方：main.ts（通过 runtime.onInput 注册）
 */
export function demoInputHandler(text: string):
  | { action: 'continue' }
  | { action: 'transform'; text: string }
  | { action: 'handled' } {
  if (text.startsWith('@@')) {
    return { action: 'handled' };
  }
  if (text.startsWith('/ask ')) {
    return { action: 'transform', text: text.replace('/ask ', '') + '？' };
  }
  return { action: 'continue' };
}
