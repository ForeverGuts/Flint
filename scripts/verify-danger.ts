/**
 * verify-danger.ts —— 危险命令拦截（ROADMAP 10.9.2）
 *
 * 验什么（手段与行为分开钉）：
 *   ① 词法层 —— 切段（`&&` `||` `;` `|` `&` 换行）、剥引号、命令词取基名、一层 shell 包装展开
 *   ② 目标归一 —— `~` / `$HOME` / `%USERPROFILE%` / 结尾 `*` 截断 / MSYS `/c/...` 展开 /
 *      "文件系统根"与"本身或祖先"两个路径代数
 *   ③ 删除类判据（A 类）—— 该拒的逐形状；**反例逐形状**（误拦是这条闸最大的风险：
 *      误拦会让人把闸关掉，那比不拦更坏）
 *   ④ 写裸设备 / 格式化（B 类）
 *   ⑤ 关机 / 重启 / fork 炸弹（C 类）
 *   ⑥ fail-open 与注入边界 —— 非 bash 工具、args 形状不对、空串、变量拼装判不出来；
 *      以及**三个注入参数真的被用上**（cwd / home / platform 不是摆设）
 *   ⑦ 源码守护 —— 三个闸在 main.ts 里的**顺序**、注册时机、判据零项目依赖、
 *      三条判据各自校验命令词（这条是回归守卫，见下）、包装**只展开一层**
 *   ⑧ **真目录 + 真链路** —— mkdtemp 造出一棵真树当 cwd/home（证明祖先判定不是字符串巧合）、
 *      真 PromptEventEmitter 上按 main.ts 同形的三闸链跑一遍（含"契约闸优先于危险闸"的行为顺序）
 *
 * ⚠ 有一条判据是**探针第一次跑就逮出来的**，值得单说：
 *   `judgeDelete` 最初**没有校验命令词**是不是删除类，于是"任何命令只要有一个 `/` 一类的参数"
 *   都会被误判成删除 —— `echo "rm -rf /"`、`prettier --write .`、`format C:` 三条同时中招
 *   （它们的共同点是"别人手里的参数长得像路径"）。G7 现在按**意图**钉住它：
 *   三条判据的第一行必须各自校验命令词，而不是靠调用方记得先判。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-danger.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SYSTEM_DIRS,
  commandWord,
  expandTarget,
  findDangerousCommand,
  guardDangerousCommand,
  isFilesystemRoot,
  isSelfOrAncestor,
  splitSegments,
  unquote,
  unwrapShell,
  type DangerContext,
} from '../src/permission/danger.js';
import { decodeDeny } from '../src/loop/tool-hooks.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { charterLock, guardContractWrite } from '../src/project/charter.js';
import { routeBashGitRead } from '../src/git/route.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 判据的注入上下文（真实机器上的 cwd/home）—— ⑥ 段会换成临时目录，证明参数真被用上 */
const REAL: DangerContext = { cwd: process.cwd(), home: os.homedir(), platform: process.platform };

/** 一句话判定：命中返回类别名，没命中返回 null */
const hitOf = (cmd: string, ctx: DangerContext = REAL): string | null =>
  findDangerousCommand(cmd, ctx)?.kind ?? null;

/* ── ① 词法层 ── */
console.log('── ① 词法层（切段 / 剥引号 / 命令词 / 包装展开）──');

check('A1 按 `&&` 切段', splitSegments('a && b').length === 2);
check('A2 按 `||` 切段', splitSegments('a || b').length === 2);
check('A3 按 `;` 切段', splitSegments('a; b').length === 2);
check('A4 按 `|` 切段', splitSegments('a | b').length === 2);
check('A5 按 `&` 切段（后台运算）', splitSegments('a & b').length === 2);
check('A6 按换行切段（多行命令）', splitSegments('a\nb').length === 2);
check('A7 `&&` 不被拆成两个 `&`（顺序承重：长运算先匹配）', splitSegments('a && b').length === 2);
check('A8 `||` 不被拆成两个 `|`', splitSegments('a || b').length === 2);
check('A9 没有分隔符时是一段', splitSegments('rm -rf x').length === 1);
check('A10 换行里混着 `&&` 也切干净', splitSegments('a &&\nb').length === 2);

check('A11 剥成对双引号', unquote('"C:/"') === 'C:/');
check('A12 剥成对单引号', unquote("'/etc'") === '/etc');
check('A13 剥**半个**引号（`cmd /c` 展开后的残留形态）', unquote('C:\\"') === 'C:\\');
check('A14 中间有引号不动它（那是数据）', unquote('a"b') === 'a"b');

check('A15 命令词取基名（`/sbin/reboot` 与 `reboot` 同判）', commandWord('/sbin/reboot') === 'reboot');
check('A16 命令词去 Windows 可执行后缀', commandWord('C:\\Windows\\System32\\format.EXE') === 'format');
check('A17 命令词小写化', commandWord('RM') === 'rm');
check('A18 命令词剥引号（`"rd` 这种碎片形态）', commandWord('"rd') === 'rd');

check('A19 包装展开：`bash -c`', unwrapShell('bash -c "rm -rf /"') === '"rm -rf /"');
check('A20 包装展开：`cmd /c`', unwrapShell('cmd /c "rd /s /q C:\\"') === '"rd /s /q C:\\"');
check('A21 包装展开：`powershell -Command`（大小写不敏感）', unwrapShell('powershell -Command Remove-Item -Recurse C:\\') === 'Remove-Item -Recurse C:\\');
check('A22 包装展开：`sh -c`', unwrapShell('sh -c "mkfs.ext4 /dev/sdb"') === '"mkfs.ext4 /dev/sdb"');
check('A23 不是包装就返回 null', unwrapShell('npm run build') === null);
check('A24 包装器单独出现（没有 -c）不展开', unwrapShell('bash scripts/build.sh') === null);
check('A25 包装器在**段首**才算（`echo bash -c "rm -rf /"` 里的那是数据）',
  unwrapShell('echo bash -c "rm -rf /"') === null);
check('A26 `-c` 后面为空不展开', unwrapShell('bash -c ') === null);

/* ── ② 目标归一 ── */
console.log('── ② 目标归一（家目录写法 / 通配截断 / 路径代数）──');

const tmpHome = path.join(os.tmpdir(), 'pretend-home');
const ctxTmp: DangerContext = { cwd: path.join(tmpHome, 'proj', 'app'), home: tmpHome, platform: process.platform };

check('B1 `~` 归到家目录（用注入的 home，不是真 home）',
  expandTarget('~', ctxTmp) === path.resolve(tmpHome));
check('B2 `~/x` 归到家目录下', expandTarget('~/x', ctxTmp) === path.resolve(tmpHome, 'x'));
check('B3 `$HOME` 归到家目录', expandTarget('$HOME', ctxTmp) === path.resolve(tmpHome));
check('B4 `$HOME/x` 归到家目录下', expandTarget('$HOME/x', ctxTmp) === path.resolve(tmpHome, 'x'));
check('B5 `%USERPROFILE%` 归到家目录（Windows 方言）', expandTarget('%USERPROFILE%', ctxTmp) === path.resolve(tmpHome));
check('B6 其它带变量的写法**判不出来**（fail-open）', expandTarget('$DIR', ctxTmp) === null);
check('B7 命令替换**判不出来**', expandTarget('$(pwd)', ctxTmp) === null);
check('B8 反引号替换**判不出来**', expandTarget('`pwd`', ctxTmp) === null);
check('B9 结尾 `*` 截断（`/*` 就是 `/`）', expandTarget('/*', ctxTmp) === path.resolve('/'));
check('B10 单纯一个 `*` 截成空 → 判不出来（`rm -rf *` 刻意放过）', expandTarget('*', ctxTmp) === null);
check('B11 目录内通配 `dist/*` 归到 dist', expandTarget('dist/*', ctxTmp) === path.resolve(ctxTmp.cwd, 'dist'));

check('B12 文件系统根：当前盘的根', isFilesystemRoot(path.parse(process.cwd()).root) === true);
check('B13 盘根的正斜杠写法同样算根', isFilesystemRoot('C:/') === true);
check('B14 UNC 共享根算根', isFilesystemRoot('//server/share/') === true);
check('B15 UNC 共享下的子目录**不**算根', isFilesystemRoot('//server/share/sub') === false);
check('B16 普通目录不算根', isFilesystemRoot(path.resolve(process.cwd(), 'src')) === false);

check('B17 自己算自己的祖先', isSelfOrAncestor('/a/b', '/a/b') === true);
check('B18 上级算祖先', isSelfOrAncestor('/a', '/a/b/c') === true);
check('B19 下级**不**算祖先（方向不能反）', isSelfOrAncestor('/a/b/c', '/a') === false);
check('B20 兄弟不算祖先', isSelfOrAncestor('/a/x', '/a/y') === false);
check('B21 同前缀但不同目录不算祖先（逐段比，不是字符串前缀）',
  isSelfOrAncestor('/a/bc', '/a/b') === false);

check('B22 Windows 下 MSYS 写法 `/c/...` 展开成盘符路径',
  expandTarget('/c/Users/x', { ...ctxTmp, platform: 'win32' }) === path.resolve('C:/Users/x'));
check('B23 非 Windows 平台**不**展开 MSYS 写法（方言是注入的）',
  expandTarget('/c/Users/x', { ...ctxTmp, platform: 'linux' }) === path.resolve(ctxTmp.cwd, '/c/Users/x'));
check('B24 单字母以外的根目录不会被误认成盘符（`/etc`）',
  expandTarget('/etc', { ...ctxTmp, platform: 'win32' }) === path.resolve('C:/etc'));

/* ── ③ 删除类判据（A 类）── */
console.log('── ③ 删除类判据：目标是不是"一棵树的根" ──');

const K_DEL = '删除整棵树';
check('C1 `rm -rf /` 拒（文件系统根）', hitOf('rm -rf /') === K_DEL);
check('C2 `rm -rf /*` 拒（通配截断后仍是根）', hitOf('rm -rf /*') === K_DEL);
check('C3 盘根 `rm -rf C:/` 拒', hitOf(`rm -rf ${path.parse(process.cwd()).root}`) === K_DEL);
check('C4 `rm -rf ~` 拒（家目录本身）', hitOf('rm -rf ~') === K_DEL);
check('C5 `rm -rf $HOME` 拒', hitOf('rm -rf $HOME') === K_DEL);
check('C6 `rm -rf %USERPROFILE%` 拒', hitOf('rm -rf %USERPROFILE%') === K_DEL);
check('C7 `rm -rf .` 拒（删的就是 cwd 本身）', hitOf('rm -rf .') === K_DEL);
check('C8 `rm -rf ..` 拒（删的是 cwd 的上级）', hitOf('rm -rf ..') === K_DEL);
check('C9 `rm -rf ../..` 拒（再往上一级也是上级）', hitOf('rm -rf ../..') === K_DEL);
check('C10 绝对路径写 cwd 拒', hitOf(`rm -rf ${process.cwd()}`) === K_DEL);
check('C11 绝对路径写 cwd 的上级拒', hitOf(`rm -rf ${path.dirname(process.cwd())}`) === K_DEL);
check('C12 复合命令里第二段命中照样拒', hitOf('cd /tmp && rm -rf /') === K_DEL);
check('C13 反斜杠写法同样命中（Windows 手写）',
  hitOf(`rm -rf ${process.cwd().replace(/\//g, '\\')}`) === K_DEL);
check('C14 系统目录本身拒（`/etc`）', hitOf('rm -rf /etc') === K_DEL);
check('C15 系统目录本身拒（`C:/Windows`）', hitOf('rm -rf C:/Windows') === K_DEL);
check('C16 `rd /s /q <盘根>` 拒（cmd.exe 形态）',
  hitOf(`rd /s /q ${path.parse(process.cwd()).root}`) === K_DEL);
check('C17 `rmdir /s /q <cwd>` 拒', hitOf(`rmdir /s /q ${process.cwd()}`) === K_DEL);
check('C18 `remove-item -recurse <家目录>` 拒（PowerShell 形态）', hitOf('remove-item -recurse ~') === K_DEL);
check('C19 大小写混写照样拒', hitOf('RM -RF /') === K_DEL);
check('C20 **看目标不看旗标**：不带 `-r` 的同样拒（`rm C:/` 也是灾难，只是会失败）',
  hitOf(`rm ${path.parse(process.cwd()).root}`) === K_DEL);

// 反例组：误拦是这条闸最大的风险
check('C21 反例：项目内的 `rm -rf node_modules` 放行', hitOf('rm -rf node_modules') === null);
check('C22 反例：`rm -rf ./build` 放行', hitOf('rm -rf ./build') === null);
check('C23 反例：`rm -rf dist/*` 放行（通配在目录内）', hitOf('rm -rf dist/*') === null);
check('C24 反例：临时目录 `rm -rf /tmp/build` 放行', hitOf('rm -rf /tmp/build') === null);
check('C25 反例：cwd 的**兄弟**目录放行', hitOf('rm -rf ../other-project') === null);
check('C26 反例：cwd 的**下级**放行（方向不能反）', hitOf('rm -rf ./src/generated') === null);
check('C27 反例：`rm -rf *` 放行（通配范围判不出来，刻意不拦）', hitOf('rm -rf *') === null);
check('C28 反例：`del dist\\bundle.js` 放行（cmd 形态、目标不是根）', hitOf('del dist\\bundle.js') === null);
check('C29 反例：`echo "rm -rf /"` 放行（那是**数据**不是命令）', hitOf('echo "rm -rf /"') === null);
check('C30 反例：`git commit -m "rm -rf /"` 放行（同上）', hitOf('git commit -m "rm -rf /"') === null);
check('C31 反例：`prettier --write .` 放行（`.` 是它的参数，不是删除目标）', hitOf('prettier --write .') === null);
check('C32 反例：`grep shutdown src/` 放行（命令词是 grep）', hitOf('grep shutdown src/') === null);
check('C33 反例：`git log --grep=reboot` 放行', hitOf('git log --grep=reboot') === null);
check('C34 反例：`npm run clean` 放行（真正的删除在脚本里，看不到）', hitOf('npm run clean') === null);
check('C35 反例：`mkdir -p /tmp/x && rm -rf /tmp/x` 放行', hitOf('mkdir -p /tmp/x && rm -rf /tmp/x') === null);
check('C36 反例：系统目录的**子目录**放行（只认"整棵树的根"）', hitOf('rm -rf /usr/local/myapp/build') === null);
check('C37 反例：家目录的**子目录**放行（那是 10.9.3 的活，本条判不出来）',
  hitOf(`rm -rf ${path.join(os.homedir(), 'Documents')}`) === null);
check('C38 反例：`rd /s /q build` 放行', hitOf('rd /s /q build') === null);
check('C39 反例：重定向当目标不算（`rm -rf x > log` 的目标是 x）',
  hitOf('rm -rf node_modules > build.log') === null);
check('C40 MSYS 写法（Git Bash / 终端拖出来的形式）指向 cwd 的上级也拒',
  hitOf(`rm -rf /c${path.dirname(process.cwd()).slice(2).replace(/\\/g, '/')}`) === K_DEL);
check('C41 反例：旗标不是目标（`-rf` 解出来是 `cwd/-rf`，不是任何一棵树的根）',
  hitOf('rm -rf -rf') === null);
// ⚠ 这两条盯的是"根判据与祖先判据**不重合**的那一半"。本机 cwd 在 C 盘上，
//   所以 `rm -rf /` 一类会**同时**被两条判据命中 —— 只测它们的话，把根判据整个删掉
//   套件照样全绿（变异 M03 实测如此）。另起一个盘 / UNC 共享才只有根判据看得见。
check('C42 别的盘的盘根也拒（本机 cwd 不在那个盘上 → 只有"根"这条判据拦得住）',
  hitOf(`rm -rf ${process.platform === 'win32' ? 'Q' : ''}:/`) === K_DEL);
check('C43 UNC 共享根也拒（同样只有"根"这条判据拦得住）',
  hitOf('rm -rf //server/share') === K_DEL);
// ⚠ C44 连着踩了两脚，值得记下来：
//   ① 它存在的理由：本机 cwd 恰好在家目录**下**，`rm -rf ~` 会被"祖先"那条顺带拦下 ——
//      不把 cwd 挪出去，这条判据就是没有鉴别力的（变异 M04 实测）。
//   ② 第一版把 cwd 挪到 `os.tmpdir()`，**在 Windows 上等于没挪**：`tmpdir` 就是
//      `C:\Users\<user>\AppData\Local\Temp`，仍在家目录之下，于是断言照样由"祖先"喂饱、
//      照样是假绿（变异 M04 第二轮又照出来一次）。改成挪到**家目录所在盘/根的另一个子目录**
//      （`<root>/elsewhere/x`，与 `<root>/Users/<user>` 互为兄弟），并把"cwd 与 home 互不为祖先"
//      这条前置**写进同一个断言**，免得下次再被环境悄悄喂饱。
const outsideHome = path.join(path.parse(os.homedir()).root, 'elsewhere', 'x');
check('C44 家目录本身拒 —— cwd 与 home **互不为祖先**（前置，否则断言没有鉴别力）',
  !isSelfOrAncestor(os.homedir(), outsideHome) && !isSelfOrAncestor(outsideHome, os.homedir()));
check('C44b 家目录本身拒 —— 只有"家目录"这条判据看得见它（cwd 已挪到家目录之外）',
  hitOf('rm -rf ~', { ...REAL, cwd: outsideHome }) === K_DEL);
check('C45 反例：cmd 旗标 `/f /s /q` 不是目标（`del /f /s /q dist` 是正常清理，'
+ '不许把 `/s` 当成 S 盘根 —— 这条钉着 isSlashFlag 的 `/x` 那一支）',
  hitOf('del /f /s /q dist') === null);
check('C46 **已知过度拦截**（写下来而不是装作没有）：`rm -rf /s` 会被判成 S 盘根'
+ '—— MSYS 展开的代价，见文件头「已知代价」',
  hitOf('rm -rf /s') === K_DEL);

// ⚠ 这条钉的是**文案**，而套件里其余各条只判 `kind` —— 它是 demo 真跑一遍才照出来的：
//   `rm -rf ~` 在家目录恰好是 cwd 祖先的情形下（`~/proj` 这种布局很常见）会被"祖先"那条先接住，
//   拒因于是写成"目标是当前工作目录的上级：C:\Users\31075"。话没说错，但用户打的是 `~`，
//   读到"上级"只会更糊涂 —— 重叠时应当让**更具体**的那条身份赢。
const nestHome = path.join(outsideHome, 'home');
const ctxNest: DangerContext = {
  cwd: path.join(nestHome, 'proj', 'app'), home: nestHome, platform: process.platform,
};
check('C47 家目录恰落在 cwd 祖先链上时，拒因必须说"家目录本身"（前置：确实重叠着）',
  isSelfOrAncestor(nestHome, ctxNest.cwd) && path.resolve(nestHome) !== path.resolve(ctxNest.cwd)
  && (findDangerousCommand('rm -rf ~', ctxNest)?.detail ?? '').includes('家目录本身'));

/* ── ④ 写裸设备 / 格式化（B 类）── */
console.log('── ④ 写裸设备 / 格式化 ──');

const K_DEV = '写裸设备 / 格式化';
check('D1 `mkfs` 拒', hitOf('mkfs /dev/sdb1') === K_DEV);
check('D2 `mkfs.ext4` 拒（带后缀）', hitOf('mkfs.ext4 /dev/sdb1') === K_DEV);
check('D3 `fdisk` 拒', hitOf('fdisk /dev/sda') === K_DEV);
check('D4 `parted` 拒', hitOf('parted /dev/sda mklabel gpt') === K_DEV);
check('D5 `wipefs` 拒', hitOf('wipefs -a /dev/sdb') === K_DEV);
check('D6 `diskpart` 拒', hitOf('diskpart') === K_DEV);
check('D7 `format C:` 拒', hitOf('format C:') === K_DEV);
check('D8 `dd of=/dev/sda` 拒', hitOf('dd if=/dev/zero of=/dev/sda bs=1M') === K_DEV);
check('D9 `dd of=/dev/nvme0n1` 拒', hitOf('dd if=x of=/dev/nvme0n1') === K_DEV);
check('D10 重定向到裸设备拒', hitOf('cat img > /dev/sdb') === K_DEV);
check('D11 反例：`dd of=/dev/null` 放行（正当的基准写法）',
  hitOf('dd if=/dev/zero of=/dev/null bs=1M count=10') === null);
check('D12 反例：`dd of=./disk.img` 放行（目标是普通文件）', hitOf('dd if=/dev/zero of=./disk.img bs=1M') === null);
// ⚠ 这条最初写的是 `prettier --check format` —— 命令词是 `prettier`，压根走不到 `format` 那支，
//   于是它只是在重复 C31，而 `judgeDevice` 里那行"`format` 必须带盘符"的守卫**没有断言看得见**
//   （变异 M29 拿掉那行，套件照绿）。改成真打靶：`format` 当命令词、参数不是盘符。
check('D13 反例：`format` 不带**盘符**放行（`--check .` 这类是别的工具的子命令，不是格式化）',
  hitOf('format --check .') === null && hitOf('prettier --check format') === null);
check('D14 反例：`mkfs` 出现在别的词里不算（词边界）', hitOf('echo mkfsfoo') === null);

/* ── ⑤ 关机 / 重启 / fork 炸弹（C 类）── */
console.log('── ⑤ 关机 / 重启 / fork 炸弹 ──');

const K_POW = '关机 / 重启 / fork 炸弹';
check('E1 `shutdown` 拒（POSIX）', hitOf('shutdown -h now') === K_POW);
check('E2 `shutdown /s /t 0` 拒（cmd /s 形式不被当路径）', hitOf('shutdown /s /t 0') === K_POW);
check('E3 `reboot` 拒', hitOf('reboot') === K_POW);
check('E4 `/sbin/reboot` 拒（按基名判）', hitOf('/sbin/reboot') === K_POW);
check('E5 `halt` 拒', hitOf('halt -p') === K_POW);
check('E6 `poweroff` 拒', hitOf('poweroff') === K_POW);
check('E7 `init 0` 拒', hitOf('init 0') === K_POW);
check('E8 `init 6` 拒', hitOf('init 6') === K_POW);
check('E9 fork 炸弹（经典写法）拒', hitOf(':(){ :|:& };:') === K_POW);
check('E10 fork 炸弹：空白变形也拒', hitOf(':() { : | : & } ; :') === K_POW);
check('E11 反例：`init 3` 放行（不是关机 / 重启的运行级）', hitOf('init 3') === null);
check('E12 反例：命令词是别的、参数里有 reboot 放行', hitOf('systemctl status reboot') === null);
check('E13 反例：`npm run reboot-local` 放行', hitOf('npm run reboot-local') === null);

/* ── ⑥ fail-open 与注入边界 ── */
console.log('── ⑥ fail-open 与注入边界 ──');

check('F1 非 bash 工具一律放行（write 工具传命令串也不管）',
  guardDangerousCommand('write', { command: 'rm -rf /' }, REAL) === undefined);
check('F2 args 为 null → 放行', guardDangerousCommand('bash', null, REAL) === undefined);
check('F3 args 是字符串 → 放行', guardDangerousCommand('bash', 'rm -rf /', REAL) === undefined);
check('F4 args 是数字 → 放行', guardDangerousCommand('bash', 42, REAL) === undefined);
check('F5 没有 command 字段 → 放行', guardDangerousCommand('bash', { description: 'x' }, REAL) === undefined);
check('F6 command 非字符串 → 放行', guardDangerousCommand('bash', { command: 42 }, REAL) === undefined);
check('F7 command 是空串 → 放行', guardDangerousCommand('bash', { command: '' }, REAL) === undefined);
check('F8 command 纯空白 → 放行', guardDangerousCommand('bash', { command: '   ' }, REAL) === undefined);
check('F9 命中时返回 deny 契约（而不是抛异常）',
  guardDangerousCommand('bash', { command: 'rm -rf /' }, REAL)?.action === 'deny');
check('F10 拒因非空且带类别名',
  (guardDangerousCommand('bash', { command: 'rm -rf /' }, REAL)?.reason ?? '').includes('删除整棵树'));
check('F11 拒因明说**没被执行**', (guardDangerousCommand('bash', { command: 'rm -rf /' }, REAL)?.reason ?? '').includes('没有被执行'));
check('F12 拒因交代了边界（护栏不是沙箱）',
  (guardDangerousCommand('bash', { command: 'rm -rf /' }, REAL)?.reason ?? '').includes('护栏不是沙箱'));
check('F13 拒因给了"进程外执行"这条出路',
  (guardDangerousCommand('bash', { command: 'rm -rf /' }, REAL)?.reason ?? '').includes('他自己的终端里'));

check('F14 变量拼装的删除目标判不出来（fail-open，边界写在文件头）',
  hitOf('rm -rf $TARGET') === null);
check('F15 变量拼装的家目录写法判不出来', hitOf('rm -rf $MYHOME/x') === null);
check('F16 参数注入生效：cwd 换成别处后原来的 cwd 不再命中',
  findDangerousCommand(`rm -rf ${process.cwd()}`, { ...REAL, cwd: os.tmpdir() }) === null);
check('F17 参数注入生效：`~` 走的是注入的 home',
  (findDangerousCommand('rm -rf ~', { ...REAL, home: path.join(os.tmpdir(), 'zzz') })?.detail ?? '').includes('zzz'));
check('F18 参数注入生效：platform 换成 linux 后 MSYS 写法不再展开成盘符',
  findDangerousCommand(`rm -rf /c${path.dirname(process.cwd()).slice(2)}`, { ...REAL, platform: 'linux' }) === null);
check('F19 注入的 cwd 与 platform=win32 组合下，MSYS 写法能命中',
  findDangerousCommand(`rm -rf /c${process.cwd().slice(2).replace(/\\/g, '/')}`, { ...REAL, platform: 'win32' }) !== null);

/* ── ⑦ 源码守护 ── */
console.log('── ⑦ 源码守护 ──');

const dangerSrc = fs.readFileSync(path.join(ROOT, 'src/permission/danger.ts'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('G1 判据零**项目**依赖（import 只指向 node: 内置）',
  (dangerSrc.match(/^import .*from '([^']+)'/gm) ?? [])
    .every((line) => /from '(node:|\.\.\/loop\/tool-hooks\.js')/.test(line)));
check('G2 判据不碰 fs、不起进程（纯函数）',
  !/child_process|node:fs|readFileSync|existsSync/.test(stripComments(dangerSrc)));
check('G3 main.ts 里三个闸的**顺序**：契约闸 → 危险闸 → git 路由',
  mainSrc.indexOf('guardContractWrite(') < mainSrc.indexOf('guardDangerousCommand(')
  && mainSrc.indexOf('guardDangerousCommand(') < mainSrc.indexOf('routeBashGitRead('));
check('G4 危险闸的注册时机仍在装载扩展**之前**（否则扩展会排在核心之后）',
  mainSrc.indexOf("events.on('before_tool_call'") < mainSrc.indexOf('await loadExtensions('));
check('G5 main.ts 走的是工厂导出的那个实现（不是就地写一份箭头函数）',
  /import \{ guardDangerousCommand \} from '\.\.\/permission\/danger\.js'/.test(mainSrc));
check('G6 危险闸只被 main.ts 接线一处（判据不散成多份实现）',
  fs.readdirSync(path.join(ROOT, 'src/harness')).length > 0
  && (dangerSrc.match(/export function guardDangerousCommand/g) ?? []).length === 1);

// ⚠ 回归守卫：三条判据的第一行必须各自校验命令词 —— 少了它，"任何带 `/` 参数的命令"都会被误判
check('G7 三条判据**各自**校验命令词（不依赖调用方记得先判）',
  /function judgeDelete[\s\S]{0,400}?if \(!DELETE_WORDS\.has\(word\)\) return null;/.test(dangerSrc)
  && /function judgePower[\s\S]{0,200}?if \(POWER_WORDS\.has\(word\)\)/.test(dangerSrc)
  && /function judgeDevice[\s\S]{0,300}?word\.startsWith\('mkfs'\)/.test(dangerSrc));
check('G8 包装**只展开一层**（depth 到 1 就停，不做递归）',
  dangerSrc.includes('if (depth === 0)') && dangerSrc.includes('findDangerousCommand(inner, ctx, 1)'));
check('G9 命令词取的是**段首**（不是"出现在命令串里"）',
  /const word = commandWord\(tokens\[0\]!\)/.test(dangerSrc));
check('G10 系统目录表只有一处定义（唯一真相源）',
  (dangerSrc.match(/export const SYSTEM_DIRS/g) ?? []).length === 1);
check('G11 fork 炸弹判据在**整串**上（不切段：它的分隔符与 shell 的混在一起）',
  /FORK_BOMB\.test\(command\.replace/.test(dangerSrc));
// ⚠ 这条**必须**在 stripComments 之后判 —— 曾经写成直接查原文，结果源码里那句
//   解释性注释（"最后一段「护栏不是沙箱」是刻意保留的"）把它**喂饱了**，
//   等于一条没有活性的断言（变异 M18 当场证明：把拒因里那句删掉它照绿）。
//   本仓记过的"源码文本断言会误伤注释"，这是第六次踩，形态换成"被注释救了"。
const dangerCode = stripComments(dangerSrc);
check('G12 拒因里的两处边界声明都在**代码里**（剥掉注释后仍有）',
  dangerCode.includes('没有被执行') && dangerCode.includes('护栏不是沙箱'));

/* ── ⑧ 真目录 + 真链路 ── */
console.log('── ⑧ 真目录 + 真 PromptEventEmitter 链路 ──');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danger-'));
const tree = {
  home: path.join(tmp, 'home'),
  get proj() { return path.join(this.home, 'proj'); },
  get app() { return path.join(this.proj, 'app'); },
  get sibling() { return path.join(this.home, 'other'); },
};
try {
  fs.mkdirSync(path.join(tree.app, 'sub'), { recursive: true });
  fs.mkdirSync(tree.sibling, { recursive: true });
  const ctxTree: DangerContext = { cwd: tree.app, home: tree.home, platform: process.platform };

  check('H1 真目录：`..` 命中（删的是 proj，真实存在的那棵树）',
    hitOf('rm -rf ..', ctxTree) === K_DEL);
  check('H2 真目录：`../..` 命中（就是 home 本身）', hitOf('rm -rf ../..', ctxTree) === K_DEL);
  check('H3 真目录：`. ` 命中（cwd 自己）', hitOf('rm -rf .', ctxTree) === K_DEL);
  check('H4 真目录：绝对路径写 app 命中', hitOf(`rm -rf ${tree.app}`, ctxTree) === K_DEL);
  check('H5 真目录：下级 `sub` **不**命中', hitOf('rm -rf sub', ctxTree) === null);
  check('H6 真目录：兄弟目录（home 下的 other）**不**命中', hitOf(`rm -rf ${tree.sibling}`, ctxTree) === null);
  check('H7 真目录：整体删掉 tmp 命中（它是 app 的上级）', hitOf(`rm -rf ${tmp}`, ctxTree) === K_DEL);
  check('H8 真目录：`~` 归到注入的 home 并命中', hitOf('rm -rf ~', ctxTree) === K_DEL);

  // 真链路：按 main.ts 同形的**三闸链**接在真总线上
  const bus = new PromptEventEmitter();
  bus.on('before_tool_call', (event) => {
    const e = event as { name?: unknown; args?: unknown };
    const toolName = typeof e.name === 'string' ? e.name : '';
    const contract = guardContractWrite(toolName, e.args, charterLock.isUnlocked());
    if (contract) return contract;
    const danger = guardDangerousCommand(toolName, e.args);
    if (danger) return danger;
    return routeBashGitRead(toolName, e.args);
  });
  charterLock.reset();

  const emit = async (command: string): Promise<string> =>
    decodeDeny(await bus.emitHook('before_tool_call', { name: 'bash', args: { command } })).reason;

  const rDanger = await emit('rm -rf /');
  check('H9 真链路：危险命令经总线被拦，理由是危险命令那一条',
    rDanger.includes('[危险命令拦截]'));
  check('H10 真链路：普通删除放行（返回 undefined → 理由为空）', (await emit('rm -rf node_modules')) === '');
  const rRouter = await emit('git status');
  check('H11 真链路：git 路由仍生效（插入第三道闸没把它挤掉）', rRouter.includes('git 工具'));
  const rContract = await emit('cat .flint/CHARTER.md');
  check('H12 真链路：契约闸仍生效且**优先**（`cat` 不是危险命令，命中的必须是契约那条）',
    rContract.includes('契约') && !rContract.includes('[危险命令拦截]'));
  // 行为级顺序证明：同一条命令同时命中两道闸 → 先到的那个给理由
  const rBoth = await emit('rm -rf / && cat .flint/CHARTER.md');
  check('H13 真链路：同时命中契约闸与危险闸时**契约闸先给理由**（顺序是行为的，不只是源码位置）',
    rBoth.includes('契约') && !rBoth.includes('[危险命令拦截]'));
  const rWrapper = await emit('bash -c "rm -rf /"');
  check('H14 真链路：包装形态也能拦（`bash -c` 展开一层）', rWrapper.includes('[危险命令拦截]'));
  check('H15 真链路：真 cwd 参与判定（本仓目录被删要拦）',
    (await emit(`rm -rf ${process.cwd()}`)).includes('[危险命令拦截]'));
  check('H16 真链路：没注册钩子时返回 undefined（向后兼容）',
    (await new PromptEventEmitter().emitHook('before_tool_call', { name: 'bash', args: { command: 'rm -rf /' } })) === undefined);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
if (failed > 0) process.exit(1);
