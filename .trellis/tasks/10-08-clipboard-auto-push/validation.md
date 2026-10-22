# 剪贴板自动推送验收

## 2026-10-21 本地验收基线

- 源码: `main`, `dd4bee4`, 测试前工作区干净.
- 主机: macOS 27.0.1 (26A434), arm64.
- 设备: Redmi K70 / Xiaomi 23113RKC6C, Android 16 / API 36, USB, serial `275179f2`.
- 应用: 0.1.11 release 测试包, `pnpm tauri build --bundles app -c '{"bundle":{"createUpdaterArtifacts":false}}'`, 构建缓存置于 `/Users/qi/.cache/adb-gui-acceptance-target`.
- 安装到 `/Applications/ADB GUI.app`, 本地 ad-hoc 签名后 `codesign --verify --deep --strict` 通过, 通过 LaunchServices `open` 启动.
- 应用可执行文件 SHA-256: `80da99a59a62f78cf9832ab690800c09074b823d79fa65b3ae668742e100c03f`.
- 原应用, WebKit 设置, 电脑完整剪贴板以及手机完整 ClipData 已备份. 手机原剪贴板为空. 所有样例为人工测试文本, 不记录原剪贴板正文.

## 已验证结果

| 场景 | 结果与证据 |
| --- | --- |
| 默认关闭 | 原生模块开关为 off. 电脑复制测试文本后, 独立 DEX get 确认手机 sentinel 保持不变. |
| 开启基线 | 开启后显示正在监听; 开启之前的电脑内容未推送. |
| 新复制文本 | 中文及 emoji 原样到达手机; 从 pbcopy 到独立 DEX get 比对通过为 723 ms, 另一次为 666 ms. |
| 去重 | 成功后单独改写手机为 sentinel, 再复制同一电脑文本; 手机保留 sentinel, 模块成功时间仍为 10:14:37. |
| 快速复制 | 间隔 40 ms 连续复制 5 段, 手机最终为第 5 段. |
| 超限 | 262145 字节时原生模块显示超过 256 KiB, 未推送, 手机仍为上一成功样例. |
| 非文本 | 电脑剪贴板只含图片时原生模块显示不是文本, 未推送, 手机仍为上一成功样例. |
| 自动反馈 | 上述自动成功与跳过均只有模块状态行更新, 无 toast. |
| 前端回归 | `pnpm test`: 61 文件, 637 测试通过. TypeScript / Vite production build 通过. |
| macOS 后端回归 | release 测试 runner 的 182 项测试通过, 0.87 秒, 执行设 60 秒硬超时; `cargo fmt --check` 通过. |
| 最小化 | 10:15:40 最小化, 10:20:59 在 TextEdit 全选并实际复制新样例, 未切回 ADB GUI, 独立 DEX get 比对成功. |
| 完全遮挡 | TextEdit 全屏遮挡 ADB GUI 后实际复制另一段文本, 手机回读一致. |
| 设置同步和重置 | 原生设置通用行与模块共享开关; 通用分区重置及带确认框的全局重置均恢复关闭. |
| 重启恢复 | 正常退出再通过 LaunchServices 启动, 开关保持开启并恢复监听, 新样例 692 ms 到达手机. |
| A -> B -> A | 第二目标为只读模式的 Pixel_10 模拟器, Android 17 / API 37 / emulator-5554. 切换时目标 sentinel 保留; 显式再复制相同文本后只写入新目标, 回读同时证明旧手机不变. 切回真机后同一文本能再推送, 593 / 1027 ms. |
| 手动双向 | 自动关闭时, 原生按钮电脑 -> 手机及手机 -> 电脑均完成中文和 emoji 传输, 分别用独立 DEX get 和 pbpaste 比对. |
| 重启基线 | 退出应用后先设置手机 sentinel 和另一份电脑文本, 重启恢复监听后手机仍保留 sentinel, 未补推旧内容. |
| USB 断开与重连 | 用户物理拔掉 USB 后, adb 设备列表为空, 模块显示等待设备在线. 离线期间复制新样例, 插回解锁后手机仍保留断线前 sentinel, 不补推离线复制; 新复制 734 ms 成功. |
| 锁屏 | `KEYCODE_SLEEP` 后显示未推送: 手机已锁屏, 无 toast, 独立 DEX 也返回 locked. 用户手动解锁后手机仍为上次成功内容, 失败内容未自动补发; 再复制新文本 714 ms 成功. 未修改锁屏配置或绕过解锁. |

## macOS 隐私预览: 授权交互未完成

- 测试前 `EnablePasteboardPrivacyDeveloperPreview` 不存在. 临时设为 true, 重启打包应用, 自动监听恢复, 复制新文本后 4 秒内未观察到推送.
- 原生 UI 工具读取和截图均超时. `sample` 显示主线程进入 `CFPasteboardShowApprovalDialogIfNecessaryForPasteboard` / `NSPasteboardInstallPrevalidationCallbacks` 的系统授权流程. 用户反馈没有看到可用提示或未允许. 未获得完成授权的证据, 不将此项记为通过, 不推断已接受或已拒绝.
- 删除测试用 defaults key 恢复原配置. 回收受阻应用 PID 2265 和其 adb 子进程 2293 / 2294, 逐 PID 确认消失; 重启后原生 UI 恢复响应, 常规环境再次推送成功, 807 ms.
- 保留为兼容性/人工授权验证待办. 不修改 TCC, 不绕过剪贴板权限, 不新增自动重试或业务降级.

## 2026-10-22 隐私预览复测: 系统预览不显示授权界面

基线: 同一源码 `dd4bee4` 重新构建 release 包, 可执行文件 SHA-256 与 10-21 一致 (`80da99a5...c03f`). 旧包移入废纸篓后安装到 `/Applications`, ad-hoc 签名, 标识 `com.qi.adb-gui`, `codesign --verify --deep --strict` 通过. macOS 27.0.1 (26A434), Redmi K70 USB.

ADB GUI 复现:

- 开启 `EnablePasteboardPrivacyDeveloperPreview` 后启动, 打开自动推送, 模块显示正在监听. 电脑剪贴板变化后手机未收到内容, 2 分钟后仍未变化.
- `sample` 证据: 读取线程停在 `read_host_text` -> arboard `stringForType` -> `CFPasteboardCopyData` -> `_onqueue_CFPasteboardShowApprovalDialogIfNecessaryForPasteboard` -> `dispatch_block_wait`; 主线程停在 `CFPasteboardMainRunLoopPerformBlockSync` -> `NSPasteboardInstallPrevalidationCallbacks` -> `HIRunLoopSemaphore wait` 的嵌套 runloop. 主线程不再处理普通事件, 所以 UI 和辅助功能查询无响应.
- `CGWindowListCopyWindowInfo` 列出全系统窗口: 应用只有主窗口, UserNotificationCenter / CoreServicesUIAgent 等没有新窗口, 屏幕上没有授权提示. 统一日志只有 `data requested for type public.utf8-plain-text`, pboard 无对应审批记录. 通过 `open` 激活应用后同样没有提示.

最小 AppKit 探针对照 (独立 bundle id, 只用 `NSPasteboard`, 每 500 ms 查 changeCount):

| 组合 | 结果 |
| --- | --- |
| 后台线程读取, 应用在前台 | 调用 `accessBehavior` 时主线程即停在同一个 `HIRunLoopSemaphore wait`, 没有授权窗口 |
| 主线程直接 `string(forType:)`, 应用在前台, ad-hoc 签名 | 停在 read start, 没有授权窗口 |
| 同上, Apple Development 签名 (有 Team ID) | 停在 read start, 没有授权窗口 |

- 系统设置 > 隐私与安全性中没有"粘贴"或"从其他 App 粘贴"面板, 27.0.1 只有开发者预览开关这一条路径.

结论:

- 本机 macOS 27.0.1 的剪贴板隐私开发者预览本身不显示授权界面: 任何程序化读取都会无限等待, 与读取线程, 前台状态和签名方式无关. 这不是 ADB GUI 的缺陷, 本机也无法完成"授权后复测", 此项不记为通过.
- 遗留风险: 如果以后系统正式启用读取授权, AppKit 会把授权同步投递到主线程等待用户回答. 自动推送在后台线程读取, 授权期间主线程同样会被占用; 届时需要在正式版本上重新验证授权提示, 允许和拒绝三种路径, 以及 `accessBehavior` 在 always allow / always deny 下的表现.
- 恢复默认配置后, 新安装的包正常推送: 中文和 emoji 916 ms 到达手机 (含回读轮询开销), 独立 DEX 回读一致. 空文本被判为"最近一次复制不是文本, 未推送", 行为正确.

恢复与清理:

- 删除 `com.qi.adb-gui` 的预览 key, 以及两个探针 domain; 探针应用已从 LaunchServices 注销, 进程逐个确认退出.
- 被卡住的实例 PID 5804 用 SIGTERM 回收; 它留下的 adb 子进程 5850 / 5851 单独回收. 回归实例正常退出, 子进程 6661 / 6662 / 6858 均已消失.
- WebKit 数据从测试前备份恢复, 与备份 `diff -r` 一致 (测试期间 localStorage 写入的开关已还原). 电脑剪贴板 4 个类型逐字节恢复.
- 手机上的探针 DEX 已删除. 手机剪贴板原本为空, 现在保留测试文本 `privacy-preview-regression-02 中文 ✅`; 设备端没有可用的清空命令, 辅助程序也只支持 get / set.
- `/Applications/ADB GUI.app` 为本次安装的 0.1.11 测试包, 应用已退出; 旧包在废纸篓中, 未清空. 备份保存在 `/Users/qi/.cache/adb-gui/backups/20261022-privacy-preview`.

## 任务进度与未覆盖范围

- 常规 macOS + USB 真机路径完成, 所有 PRD 常规验收项已有原生或自动化证据.
- 保留 `in_progress`: 隐私预览下尚无完成系统授权的证据, 后续在可用的系统提示/许可环境中复测. 不宣称该实验设置下可正常推送.
- 2026-10-22 复测确认: 27.0.1 的系统预览本身不显示授权界面, 最小 AppKit 探针同样卡住, 本机无法完成该项. 见上方复测小节.
- Windows/Linux 原生运行, 无线连接和第二台物理手机未覆盖; 设备切换使用 Android 17 模拟器补验. Linux 禁用态由既有自动化覆盖.

## 恢复与清理

- 自动推送先关闭, 再正常退出最终应用实例. 最终应用 PID 2496 与采集子进程 3049 已回收.
- 原 WebKit 数据恢复后, 所有 localStorage 的键和值与测试前备份逐字节相等, 包含原设置和 UI 布局.
- 电脑完整 pasteboard 的类型与字节恢复后再次比对相同; 手机完整 ClipData 恢复为原来的空状态, 独立 DEX get 返回 no_text.
- 手机 `stay_on_while_plugged_in=0`, `show_touches=0`, `screen_off_timeout=300000` 均核对为原值. 隐私预览 key 恢复为不存在.
- 模拟器及 crashpad/netsimd 辅助进程全部退出. 只删除本轮创建的两个设备端 DEX, 临时构建缓存, 录屏, 探针, 备份和测试文稿; 不清理用户既有缓存或系统 adb server.
- `/Applications/ADB GUI.app` 保留本轮验收的 0.1.11 测试版, 签名校验通过, 应用处于退出状态.

## 检查命令说明

- 非交互 shell 没有设置 `LANG` 时, `pbcopy` 遇到非 ASCII 文本会写入空串. 用命令行准备中文样例前先设 `LANG=en_US.UTF-8`, 否则会被应用正确判为"不是文本".
- Rust 先用 `cargo test --release --no-run` 编译. 随后的 cargo 调用重新编译应用并触及 60 秒上限, 测试尚未开始; 改为直接执行已编译的 `release/deps/adb_gui_lib-*` runner, 仍设置 60 秒上限, 182 项全部通过. 不把编译超时记成业务测试失败或测试通过.
