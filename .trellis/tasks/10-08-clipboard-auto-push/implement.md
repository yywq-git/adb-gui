# 剪贴板自动推送 - 执行计划

按 "Rust 推送链路 -> 前端设置与绑定 -> 模块 UI -> 规范与真机" 推进. 每阶段结束都要能独立验证.

## 阶段 1: Rust 写入流程拆分 (不改行为)

- [ ] `commands/clipboard.rs`: `run` 拆为 `prepare(app, serial)` 和 `submit(helper, request, is_set)`, `run` 组合两者. 校验和编码仍在提交前, 共用 `validate_text`.
- [ ] 现有 clipboard 单元测试全部通过, 不改测试断言.

验证: `cargo test --manifest-path src-tauri/Cargo.toml clipboard`.
回滚点: 本阶段可单独提交; 出问题直接回退该提交.

## 阶段 2: Rust 自动推送模块

- [ ] `Cargo.toml`: macOS 目标依赖加 `objc2-app-kit` (0.3, `NSPasteboard` feature, 与依赖树版本一致); `windows-sys` 加 `Win32_System_DataExchange`.
- [ ] `commands/clipboard_auto_push.rs`:
  - [ ] `change_count()` 平台实现 (macOS / Windows), Linux 不编译该函数; 确认 `NSPasteboard` 线程约束.
  - [ ] 托管状态 `Mutex<{ generation, target }>`; `set_clipboard_auto_push`, `get_clipboard_auto_push_support` 命令.
  - [ ] 后台任务: 500 ms 轮询, 基线, 读文本 (`spawn_blocking` + 插件 `ClipboardExt::read_text`), 256 KiB 检查, 同代哈希去重, 提交前 / 提交后核对 generation, 状态事件.
  - [ ] 把 "计数源 / 读文本 / 写入" 抽成可注入依赖, 循环逻辑做成可单测的纯状态机, 不在测试里起 adb.
- [ ] `error_codes.rs`: `CLIPBOARD_AUTO_PUSH_UNSUPPORTED`, `CLIPBOARD_HOST_READ_FAILED`.
- [ ] `lib.rs`: 注册状态和两个命令.

单元测试 (Rust):

- [ ] 启动时记录基线, 基线之前的内容不推送.
- [ ] 计数变化 -> 推送一次; 计数不变 -> 不读取文本.
- [ ] 同代内同一文本不重复推送; 换代后同一文本会推送.
- [ ] 推送期间计数多次变化 -> 结束后只推最新文本.
- [ ] 失败后不重试同一计数; 再次变化后可推送; 失败不更新去重哈希.
- [ ] `prepare` 之后 generation 已变 -> 不调用 `submit`, 不发事件.
- [ ] `submit` 返回时 generation 已变 -> 不发事件.
- [ ] 空文本 / 非文本 -> `skipped(no_text)`; 超限 -> `skipped(too_large)`, 都不调用写入.
- [ ] 事件序列化不含文本字段.

验证:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

Windows 目标若本机未安装, 先 `rustup target add x86_64-pc-windows-msvc`; 若 `cargo check` 因 C 依赖无法交叉编译, 记录阻塞点, 由 CI Windows 构建兜底验证, 不跳过不说明.

## 阶段 3: 前端设置, 绑定与状态

- [ ] `lib/settings.ts`: `clipboard: { autoPush }`, 默认值, 解码 (`flag`). 不提升版本.
- [ ] `lib/settingsSections.ts`: `general` 增加 `clipboardAutoPush` 行 (标签, 说明, `modified`); 确认 `sectionResetPlan("general")` 覆盖它.
- [ ] `lib/tauri.ts`: `setClipboardAutoPush`, `getClipboardAutoPushSupport`, `onClipboardAutoPushStatus`, 事件类型.
- [ ] `store/clipboardAutoPush.ts`: 运行时 store (不持久化), generation 过滤, 状态推导.
- [ ] `hooks/useClipboardAutoPush.ts`: 目标推导, 过期返回丢弃, 卸载停止; 在 `App.tsx` 根部挂载.
- [ ] i18n: `settings.rows.clipboardAutoPush.*`, `tools.clipboardTool.autoPush.*` 中英文; 新错误码进 `backend-en.ts`, `backend-zh-CN.ts`, `backendErrorContract.ts`.
- [ ] `scripts/screenshots/mock-tauri.js`: 新命令和事件的 mock, 支持切换 `supported`.

单元测试 (vitest):

- [ ] 设置: 缺省为 `false`, 非布尔报 `settings.invalidField`, 重启持久化, general 分区重置和全局重置恢复为 `false`.
- [ ] 目标推导: 关闭 / 设置不可用 / 设备离线 / 不支持 -> `null`; A -> B -> A 产生三次调用; 同一 `contextKey` 重渲染不重复调用.
- [ ] 过期的 `setClipboardAutoPush` 返回不覆盖新 generation; 旧 generation 事件被忽略.
- [ ] 卸载时调用 `setClipboardAutoPush(null)` 并释放事件监听.

验证: `pnpm test`, `pnpm build`.

## 阶段 4: 模块 UI 与设置行

- [ ] `ClipboardTool.tsx`: 开关行 (`Switch`, 整行可点, 调用 settings `update("clipboard", ...)`), 状态行 (`role="status"`), 禁用条件.
- [ ] `GeneralSection.tsx`: `SettingSwitchRow id="clipboardAutoPush"`, 不支持时禁用并替换说明.
- [ ] 组件测试: 每种状态的文案 (中英文), 开关与设置行写同一个 action, 不支持时两处都禁用, 失败状态不调用 `showToast`.
- [ ] `ToolLocalization.test.tsx` / SSR 设置测试覆盖新行.

浏览器冒烟 (内置浏览器 + `mock-tauri.js`, 1200x800 与 900x600, 亮/暗):

- [ ] 工具页剪贴板模块: 开关切换, 状态行 (监听中 / 已推送 / 锁屏失败 / 超限) 显示, 无横向溢出.
- [ ] 设置 > 通用: 新行显示, 与模块开关同步, 分区重置恢复关闭.
- [ ] `supported=false` 时两处禁用并显示暂不支持.
- [ ] `smoke.mjs` 增加上述断言, `pnpm test:browser` 通过.

## 阶段 5: 规范更新

- [ ] `.trellis/spec/frontend/settings-clipboard.md`: 修订 "不轮询" 契约, 增加自动推送设置, 目标推导, generation 过滤, 测试要求.
- [ ] `.trellis/spec/backend/clipboard.md`: 增加自动推送小节和 `prepare` / `submit` 拆分说明.

## 阶段 6: 打包应用真机验证 (macOS + Redmi K70)

构建: `pnpm tauri build --bundles app -c '{"bundle":{"createUpdaterArtifacts":false}}'`, 安装到 `/Applications`, 用 LaunchServices 启动.

- [ ] 开关默认关闭; 关闭时复制文本, 手机剪贴板不变.
- [ ] 打开开关, 当时剪贴板里的内容不推送.
- [ ] 在 TextEdit / 浏览器复制新文本, 不切回本应用, 2 秒内手机剪贴板变为该文本 (`adb shell` 读取或手机粘贴确认).
- [ ] 重复复制同一文本不再推送 (状态时间不变); 连续快速复制 5 段, 手机得到最后一段.
- [ ] 本应用最小化 5 分钟以上, 复制新文本仍推送成功; 被其他窗口完全遮挡时同样成功.
- [ ] 手机锁屏 -> 复制 -> 模块显示锁屏原因, 无 toast; 解锁后复制新文本成功.
- [ ] 复制图片 -> 显示 "不是文本"; 复制超过 256 KiB 文本 -> 显示超限, 手机剪贴板不变.
- [ ] 拔掉 USB -> 显示等待设备在线; 重新插上 -> 不推送已有内容, 新复制可推送.
- [ ] 重启应用, 开关保持打开且自动恢复监听.
- [ ] 手动 "推送到手机" / "复制到电脑" 行为不变.
- [ ] `defaults write com.qi.adb-gui EnablePasteboardPrivacyDeveloperPreview -bool yes` 后重启应用复制文本, 记录是否出现系统提示及选项; 测试后 `defaults delete com.qi.adb-gui EnablePasteboardPrivacyDeveloperPreview`.
- [ ] 测试结束恢复用户原有设置 (`adb-gui-settings`) 和手机剪贴板.

未覆盖项必须在测试记录中写明: Windows 真机, Linux 真机 (只验证禁用态), 无线连接.

## 风险文件

- `src-tauri/src/commands/clipboard.rs`: 拆分可能改变手动写入的错误映射 (`write_failure`), 阶段 1 用现有测试兜住.
- `src/lib/settings.ts`: 解码新增字段, 错误时整个设置不可用, 必须有缺省值测试.
- `src/App.tsx`: 根部挂载 hook, 注意 StrictMode 双调用下的过期返回丢弃.

## 继续实现前需要确认

- 无. 4 项产品决策已在 PRD "已确认决策" 中记录.
