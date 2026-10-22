# scrcpy 投屏入口 - 技术设计

## 1. 设计原则

- scrcpy 是外部程序, 本应用只负责找到它, 组装参数, 启动, 停止, 回收进程和展示结果. 不解析视频, 不控制窗口.
- 参数拼写和 scrcpy 版本知识只放在 Rust: 前端传结构化选项, Rust 生成 argv. 前端不拼命令行.
- 不经过 shell: 用 `Command::new(scrcpy).args(argv)` 启动, 额外参数先在 Rust 里切分成 argv.
- scrcpy 必须和应用共用同一个 adb (`ADB` 环境变量), 否则两个 adb 客户端会互相重启 server.
- 每个失败都显式: 找不到, 版本过旧, 自定义路径无效, 参数无效, 启动失败, 运行中断开. 自定义路径无效时不回退到自动查找.

拒绝的方案:

- 打包或下载 scrcpy: 用户决策, 本期不做.
- 前端拼接命令字符串交给 shell 执行: 注入风险, 且 Windows 和 Unix 引号规则不同.
- 只依赖 PATH 查找: macOS 从 Finder 启动时拿不到 Homebrew 路径.
- 通过 stdout 判断窗口已显示: 依赖 scrcpy 日志文本, 版本间不稳定. 以进程存活为准.

## 2. 职责划分

| 层 | 职责 |
| --- | --- |
| `lib/settings.ts` | 持久化 `mirror` 偏好. |
| `store/mirror.ts` (运行时) | scrcpy 检测结果, 各设备会话, 各设备最近一次结束结果. |
| `components/MirrorTool.tsx` (A-10) | 开始/停止, 画质预设, 状态行, 跳转设置. |
| `components/settings/sections/MirrorSection.tsx` | scrcpy 路径, 画质, 开关, 额外参数. |
| `lib/tauri.ts` | 命令和事件封装, 文件选择对话框. |
| `src-tauri/src/commands/mirror.rs` | 查找与版本检测, 额外参数切分, argv 生成, 会话注册表, 退出监控, 停止, 应用退出清理. |

## 3. 设置

```ts
type MirrorPreset = "standard" | "saver" | "high";
interface MirrorOptions {
  turnScreenOff: boolean; stayAwake: boolean; showTouches: boolean;
  alwaysOnTop: boolean; noAudio: boolean; viewOnly: boolean;
}
interface MirrorPreferences {
  preset: MirrorPreset;
  options: MirrorOptions;
  extraArgs: string;            // 原样保存, 解析在 Rust
  scrcpyPath: string | null;    // null = 自动查找
}
defaultSettings().mirror = { preset: "standard", options: 全部 false, extraArgs: "", scrcpyPath: null };
```

- 解码用现有 `choice` / `flag` 工具; `scrcpyPath` 校验非空, 不含 NUL, 绝对路径, 否则 `settings.invalidScrcpyPath`. `extraArgs` 校验为字符串且不含 NUL 和换行, 否则 `settings.invalidField`.
- 新字段缺省取默认值, 不提升 `SETTINGS_VERSION`.
- 新分区 `mirror` 加入 `SettingsSection` 和 `SETTINGS_SECTIONS`, 放在 `capture` 之后. `sectionResetPlan("mirror")` 恢复整个 `mirror` 组.

## 4. Rust

### 4.1 命令

```rust
#[tauri::command] async fn detect_scrcpy(custom_path: Option<String>) -> Result<ScrcpyInfo, AppError>
#[tauri::command] fn parse_scrcpy_extra_args(text: String) -> Result<Vec<String>, AppError>
#[tauri::command] async fn start_mirror(app, serial: String, request: MirrorRequest) -> Result<MirrorSessionInfo, AppError>
#[tauri::command] async fn stop_mirror(serial: String, session_id: u64) -> Result<(), AppError>
#[tauri::command] fn list_mirror_sessions() -> Vec<MirrorSessionInfo>
pub async fn shutdown_mirror_sessions() -> Result<(), AppError>   // RunEvent::Exit 调用

struct ScrcpyInfo { path: String, version: String, source: "custom" | "path" | "known" }
struct MirrorRequest { scrcpy_path: Option<String>, preset: MirrorPreset, options: MirrorOptions, extra_args: String }
struct MirrorSessionInfo { serial: String, session_id: u64 }
// 事件 "mirror-exit"
struct MirrorExit { serial: String, session_id: u64, outcome: "closed" | "stopped" | "disconnected" | "failed", error: Option<AppErrorPayload> }
```

### 4.2 查找与版本

```text
custom_path = Some(p): p 必须存在且可执行, 否则 mirror.customPathInvalid (不回退)
custom_path = None:
  1. PATH: Unix `which scrcpy`, Windows `where scrcpy` (同 which_adb)
  2. 常见位置 (按顺序, 第一个存在且可执行的):
     macOS:   /opt/homebrew/bin/scrcpy, /usr/local/bin/scrcpy, /opt/local/bin/scrcpy
     Linux:   /usr/local/bin/scrcpy, /usr/bin/scrcpy, /snap/bin/scrcpy
     Windows: %LOCALAPPDATA%\Microsoft\WinGet\Links\scrcpy.exe,
              %USERPROFILE%\scoop\shims\scrcpy.exe,
              %ProgramData%\chocolatey\bin\scrcpy.exe
  3. 都没有: mirror.notFound
版本: `scrcpy --version` (5 秒超时), 第一行匹配 ^scrcpy (\d+)\.(\d+)(\.\d+)?
  解析失败 -> mirror.versionUnreadable; < 2.0 -> mirror.tooOld { version }
```

- 查找顺序是显式的发现规则, 结果带 `source`, 界面显示实际使用的路径.
- `start_mirror` 每次启动前重新检测 (使用请求里的 `scrcpy_path`), 不依赖前端缓存的检测结果.

### 4.3 额外参数切分

- 规则: 空白分隔; 单引号或双引号包住的部分作为一个参数的一部分 (引号本身去掉); 不处理反斜杠转义, 这样 Windows 路径 `C:\a\b` 原样保留.
- 未闭合的引号 -> `mirror.extraArgsUnclosedQuote`.
- 禁止的参数 (精确匹配, 以及 `--x=value` 形式和短参数 `-sSERIAL` 形式): `-s`, `--serial`, `-d`, `--select-usb`, `-e`, `--select-tcpip`, `--tcpip`, `--otg` -> `mirror.extraArgsForbidden { option }`.
- 设置行输入时 (300 ms 防抖) 调用 `parse_scrcpy_extra_args` 显示行内错误; `start_mirror` 再次解析, 以 Rust 结果为准. 前端不实现第二个解析器.

### 4.4 argv 生成

```text
["-s", serial]
+ preset:  standard -> []
           saver    -> ["--max-size=1024", "--video-bit-rate=4M", "--max-fps=30"]
           high     -> ["--video-bit-rate=16M"]
+ options: alwaysOnTop -> --always-on-top
           noAudio     -> --no-audio
           viewOnly    -> --no-control
           !viewOnly && turnScreenOff -> --turn-screen-off
           !viewOnly && stayAwake     -> --stay-awake
           !viewOnly && showTouches   -> --show-touches
+ extra args (追加在最后, scrcpy 中后出现的参数覆盖前面的)
```

- 仅查看时不传依赖控制的三个参数: 实测与 `--no-control` 同时传会启动失败. 界面同时把这三个开关显示为不可用, 存储值保留, 关闭仅查看后恢复.

### 4.5 进程与会话

- 环境: `ADB=<adb::resolve_adb_path>`; 若 adb 是 Linux 内置版本, 同时设置 `LD_LIBRARY_PATH`, 与 `adb::prepare_command` 规则一致. Windows 用 `CREATE_NO_WINDOW` 隐藏控制台, SDL 窗口照常显示.
- 注册表 `LazyLock<Mutex<HashMap<String, MirrorSession>>>`, 键为 serial. 同一 serial 已有会话 -> `mirror.alreadyRunning`. 启动锁按 serial, 防止双击产生两个进程 (同 logcat 的 `LOGCAT_START_LOCKS`).
- stdout 丢弃, stderr 读入有界环形缓冲 (最近 40 行, 每行截断 512 字节).
- 监控任务 `child.wait()` 后从注册表移除 (按 session_id 核对), 发 `mirror-exit`:
  - 被 `stop_mirror` 或应用退出终止 -> `stopped`
  - 退出码 0 -> `closed`
  - 退出码 2 -> `disconnected`
  - 其他 -> `failed`, `mirror.exitFailed { code }`, detail 为缓冲中含 `ERROR: ` 的行 (取 `ERROR: ` 之后的文本, 去掉 NSLog 前缀); 没有 ERROR 行时取最后 5 行.
- `stop_mirror`: 核对 session_id, 标记 "由应用停止", 发送终止信号 (Unix SIGTERM, 3 秒后仍在则 SIGKILL; Windows `TerminateProcess`), 由监控任务统一回收和发事件.
- `shutdown_mirror_sessions`: 在 `RunEvent::Exit` 中先于 `shutdown_embedded_adb_server` 调用, 终止所有会话并等待回收 (总时限 5 秒).

## 5. 前端

### 5.1 store `useMirrorStore` (不持久化)

```ts
{
  detection: { status: "idle" | "detecting" } | { status: "ready"; info: ScrcpyInfo } | { status: "error"; error: AppErrorPayload };
  sessions: Record<serial, { sessionId: number; starting: boolean }>;
  lastExit: Record<serial, { outcome: MirrorOutcome; error?: AppErrorPayload; at: number }>;
}
```

- 应用启动时调用 `list_mirror_sessions` 恢复会话 (网页刷新后进程仍在), 并订阅 `mirror-exit`. 订阅放在 App 根部, 因为模块可能被隐藏, 而事件需要更新所有设备的状态.
- `mirror-exit` 的 session_id 与 store 中不一致时忽略 (过期事件).
- 检测在 `mirror.scrcpyPath` 变化, 首次显示模块或设置分区, 点击 "重新检测" 时执行; 用请求序号丢弃过期结果.

### 5.2 模块 A-10 "投屏" (`mirror`)

```text
┌ 投屏 A-10 ─────────────────────────────┐
│ [▶ 开始投屏]                            │  h-9, 主按钮, 运行中变为 [■ 停止投屏]
│ [标准][省流][高清]                      │  SegmentedControl, h-8, 写同一个 settings action
│ ● 投屏中 · Redmi K70                    │  状态行, role=status, 11px
│ 更多参数 →                              │  openSettings("mirror")
└─────────────────────────────────────────┘
```

| 状态 | 按钮 | 状态行 |
| --- | --- | --- |
| 非 Tauri / 无在线设备 | 禁用 | 未连接设备 (同其他模块) |
| 检测中 | 禁用 | 正在查找 scrcpy… |
| 未找到 | 禁用 | 未找到 scrcpy · 安装指引 (打开官方说明) + 各平台一行命令提示 |
| 版本过旧 | 禁用 | scrcpy {version} 过旧, 需要 2.0+ |
| 自定义路径无效 | 禁用 | scrcpy 路径无效 · 去设置 |
| 可用, 未运行 | 开始投屏 | 无, 或上次结果: 已关闭 / 设备已断开 / 启动失败: {ERROR 文本} |
| 启动中 | 禁用 (spinner) | 正在启动… |
| 运行中 | 停止投屏 | 投屏中 |

- 安装指引: macOS `brew install scrcpy`, Windows `winget install --exact Genymobile.scrcpy`, Linux "使用官方发布包". 链接通过 opener 打开 `https://github.com/Genymobile/scrcpy#get-the-app`.
- 失败不弹 toast, 留在状态行, 按钮恢复为 "开始投屏" 作为重试.
- 状态只针对当前选中设备; 其他设备的会话继续运行.
- 900x600 和 240px 最小列宽下不能横向溢出; 错误文本换行显示, 最多 3 行, 完整内容放在 `title`.

### 5.3 设置 > 投屏

| 行 | 控件 | 说明 |
| --- | --- | --- |
| scrcpy | stacked 行: 检测结果 (路径, 版本, 来源) + [选择文件] [恢复自动] [重新检测] | 自定义路径无效时显示错误 |
| 画质 | `SegmentedControl` 标准 / 省流 / 高清 | 与模块同一 action |
| 选项 | `ChipGroup` 6 项 | 仅查看开启时, 息屏投屏 / 保持唤醒 / 显示触摸 显示为不可用并附说明 |
| 额外参数 | stacked 行, 单行等宽输入 | 300 ms 防抖调用 Rust 解析, 行内错误; 说明: 追加在以上参数之后, 不能指定设备 |

- 文件选择通过 `lib/tauri.ts` 的 `pickScrcpyExecutable()` (plugin-dialog `open`), 浏览器预览不伪造路径.

## 6. 错误码

`mirror.notFound`, `mirror.customPathInvalid`, `mirror.versionUnreadable`, `mirror.tooOld`, `mirror.extraArgsUnclosedQuote`, `mirror.extraArgsForbidden`, `mirror.startFailed` (spawn 失败), `mirror.alreadyRunning`, `mirror.exitFailed`, `mirror.disconnected`, `mirror.stopFailed`, `settings.invalidScrcpyPath`.
同步 `error_codes.rs`, `backend-en.ts`, `backend-zh-CN.ts`, `backendErrorContract.ts`.

## 7. 平台差异与风险

- macOS: Homebrew scrcpy 自带 scrcpy-server, 不需要额外配置. 应用未签名公证, 启动外部程序不受影响.
- Windows: winget 的 Links 目录是符号链接, 直接执行即可. 本机无法实测, 用交叉编译检查 + 发布后反馈.
- Linux: 若应用 adb 是内置版本, 设置的 `LD_LIBRARY_PATH` 也会作用于 scrcpy 自身, 可能与其依赖的库冲突. 本机无法实测, 记录为风险, 用户遇到时可在 PATH 中提供系统 adb.
- `--version` 输出格式若未来变化, 版本解析失败会明确报错, 不猜测.

## 8. 规范修订

- 新增 `.trellis/spec/backend/mirror.md`: 查找顺序, 版本门槛, argv 生成, 额外参数规则, `ADB` 环境, 会话与退出码映射, 退出清理.
- `settings-clipboard.md`: 设置分区由 6 个变为 7 个, `mirror` 偏好与分区重置.
- `scripts/screenshots/smoke.mjs`: `SECTIONS` 增加 `mirror`.

## 9. 回滚

- 模块和设置分区可整体移除; `mirror` 设置字段保留无害.
- Rust `commands/mirror.rs` 独立, 移除命令注册和退出清理调用即可.
