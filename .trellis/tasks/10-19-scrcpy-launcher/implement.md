# scrcpy 投屏入口 - 执行计划

按 "Rust 查找与会话 -> 设置 -> 模块 -> 设置分区 -> 规范 -> 真机" 推进.

## 阶段 1: Rust 查找, 解析与 argv

- [ ] `commands/mirror.rs`: `detect_scrcpy` (自定义路径 / PATH / 常见位置, `--version` 解析, 2.0 门槛), `parse_scrcpy_extra_args`, argv 生成.
- [ ] `error_codes.rs`: `mirror.*` 和 `settings.invalidScrcpyPath`.
- [ ] 单元测试:
  - [ ] 版本解析: `scrcpy 5.0.1 <https://...>`, `scrcpy 2.0`, `scrcpy 1.25`, 无法解析的输出.
  - [ ] 查找顺序: 自定义路径无效不回退; PATH 优先于常见位置; 都没有时 `notFound` (查找函数注入 "存在且可执行" 判断, 不依赖本机文件).
  - [ ] 额外参数: 空白, 单双引号, 引号内空格, Windows 路径反斜杠保留, 未闭合引号, 各禁止参数的三种写法 (`-s X`, `--serial=X`, `-sX`), 允许 `--max-size=800` 等普通参数.
  - [ ] argv: 三个预设, 每个开关, 仅查看时去掉三个依赖控制的参数, 额外参数在最后, 首两个参数始终是 `-s serial`.

验证: `cargo test --manifest-path src-tauri/Cargo.toml mirror`.

## 阶段 2: Rust 会话

- [ ] `start_mirror` / `stop_mirror` / `list_mirror_sessions` / `shutdown_mirror_sessions`, `mirror-exit` 事件.
- [ ] `ADB` 与 `LD_LIBRARY_PATH` 环境, Windows `CREATE_NO_WINDOW`.
- [ ] 按 serial 的启动锁, 有界 stderr 缓冲, 退出码映射, ERROR 行提取 (含 NSLog 前缀).
- [ ] `lib.rs`: 注册命令; `RunEvent::Exit` 中在 `shutdown_embedded_adb_server` 之前调用 `shutdown_mirror_sessions`.
- [ ] 单元测试:
  - [ ] 退出码映射: 0 / 2 / 1 / 由应用停止 / 信号.
  - [ ] ERROR 行提取: 普通 `ERROR: x`, NSLog 前缀, 无 ERROR 行时取最后 5 行, 超长行截断.
  - [ ] 同一 serial 重复启动返回 `alreadyRunning`; 过期 session_id 的 stop 不影响新会话.
  - [ ] 用测试替身进程 (例如 `sh -c 'echo "ERROR: boom" >&2; exit 1'`, Windows 下跳过) 验证监控任务回收和事件内容.

验证:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

Windows 交叉检查跑不通时记录具体报错作为阻塞点.

## 阶段 3: 前端设置与运行时 store

- [ ] `lib/settings.ts`: `mirror` 偏好, 默认值, 解码与校验.
- [ ] `lib/settingsSections.ts`: `mirror` 分区和 4 行 (`modified` 判断), `sectionResetPlan("mirror")`.
- [ ] `lib/tauri.ts`: 5 个命令, `onMirrorExit`, `pickScrcpyExecutable`.
- [ ] `store/mirror.ts`, App 根部的会话恢复与事件订阅, 检测请求序号.
- [ ] `lib/toolLayout.ts` / `lib/toolModules.tsx`: `mirror` 模块, 参考码 A-10, 默认顺序放在 `recording` 之后.
- [ ] i18n: 设置分区, 模块, 状态, 安装指引, 错误码 (中英文).
- [ ] `scripts/screenshots/mock-tauri.js`: 检测结果可切换 (可用 / 未找到 / 过旧 / 路径无效), 会话启动, `mirror-exit` 推送.
- [ ] vitest:
  - [ ] 设置: 默认值, 非法 `scrcpyPath` / `extraArgs` / 预设, 重启持久化, 分区重置和全局重置.
  - [ ] 分区顺序与 SSR 渲染 7 个分区; `normalizeToolOrder` 把 `mirror` 插到默认位置.
  - [ ] store: 过期 `mirror-exit` 被忽略, 检测过期结果被丢弃, 会话恢复.

验证: `pnpm test`, `pnpm build`.

## 阶段 4: 模块与设置分区 UI

- [ ] `components/MirrorTool.tsx`: 按状态表渲染按钮和状态行, 预设切换, 跳转设置, 安装指引链接.
- [ ] `components/settings/sections/MirrorSection.tsx`: 路径行, 画质, 选项 (仅查看时禁用三个开关), 额外参数 (防抖解析, 行内错误).
- [ ] 组件测试: 每种状态的文案 (中英文), 失败不调用 `showToast`, 模块与设置的预设写同一 action, 仅查看禁用逻辑.

浏览器冒烟 (内置浏览器 + mock, 1200x800 与 900x600, 亮/暗):

- [ ] 工具页 A-10 各状态 (可用, 投屏中, 未找到, 过旧, 启动失败长错误) 无横向溢出.
- [ ] 设置 > 投屏 4 行渲染, 锚点导航包含新分区, 额外参数错误提示, 分区重置.
- [ ] `smoke.mjs` 的 `SECTIONS` 增加 `mirror` 并补断言; `pnpm test:browser` 通过.

## 阶段 5: 规范

- [ ] 新增 `.trellis/spec/backend/mirror.md`, 在 `backend/index.md` 登记.
- [ ] `.trellis/spec/frontend/settings-clipboard.md`: 7 个分区, `mirror` 偏好与重置.

## 阶段 6: 打包应用真机验证 (macOS + Homebrew scrcpy 5.0.1 + Redmi K70)

构建: `pnpm tauri build --bundles app -c '{"bundle":{"createUpdaterArtifacts":false}}'`, 安装到 `/Applications`, 从 Finder / LaunchServices 启动 (验证非 shell PATH 环境).

- [ ] 模块显示 scrcpy 可用, 设置显示 `/opt/homebrew/bin/scrcpy`, 版本 5.0.1, 来源 "常见位置".
- [ ] 开始投屏 -> scrcpy 窗口显示手机画面; 同时打开 logcat 和性能面板, 投屏前后 logcat 流不中断 (`adb` server 未重启).
- [ ] 模块停止 -> 窗口关闭, 无错误; 直接关闭 scrcpy 窗口 -> 模块显示已关闭.
- [ ] 三个预设各启动一次; 窗口置顶, 关闭音频, 仅查看, 息屏投屏分别生效.
- [ ] 额外参数 `--window-title="ADB GUI test"` 生效; `--bogus` 显示 scrcpy 错误; `-s abc` 在设置里即时报错.
- [ ] 自定义路径指向不存在文件 -> 路径错误, 不回退; 恢复自动后恢复可用.
- [ ] 投屏中拔掉 USB -> 显示设备已断开.
- [ ] 无线连接的设备投屏 (若条件允许).
- [ ] 投屏中退出应用 -> scrcpy 窗口关闭, 无残留 scrcpy 进程 (`pgrep scrcpy`).
- [ ] 重启应用后预设, 开关, 额外参数保持.
- [ ] 测试结束恢复用户原有设置.

未覆盖项在测试记录中写明: Windows, Linux 真机; 第二台设备同时投屏 (若无第二台设备).

## 风险文件

- `src-tauri/src/lib.rs` 退出流程: 清理顺序错误会导致 scrcpy 残留或 adb 关闭卡住.
- `src/lib/settingsSections.ts` 与 `smoke.mjs`: 分区数变化影响现有锚点, 重置和冒烟断言.
- `src/lib/toolLayout.ts`: 新模块插入已保存的布局, 需覆盖已有用户的顺序归一化.

## 继续实现前需要确认

- 无. 产品决策见 PRD "已确认决策".
