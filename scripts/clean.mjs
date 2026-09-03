/**
 * 清除构建产物 —— 跨平台替代原先 package.json 里的 `rm -rf dist`。
 *
 * 为什么不用 rm：那是 POSIX 命令，Windows 的 cmd/PowerShell 下根本跑不通
 * （原 `clean` 脚本在本项目的主力开发环境上一直是坏的）。
 * fs.rmSync 的 recursive + force 组合等价于 rm -rf：目录不存在也不报错。
 *
 * 运行：node scripts/clean.mjs   （或 npm run clean）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['dist'];

for (const t of TARGETS) {
  const full = path.join(ROOT, t);
  const existed = fs.existsSync(full);
  fs.rmSync(full, { recursive: true, force: true });
  console.log(existed ? `已清除 ${t}/` : `${t}/ 本来就不存在，跳过`);
}
