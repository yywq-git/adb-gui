# scrcpy 投屏入口验收

## 2026-10-21 本地验收基线

- 源码: `main`, `dd4bee4`, 测试前工作区干净.
- 主机: macOS 27.0.1 (26A434), arm64.
- 真机: Redmi K70 / Xiaomi 23113RKC6C, Android 16 / API 36, USB, serial `275179f2`.
- scrcpy: Homebrew 5.0.1, `/opt/homebrew/bin/scrcpy`.
- 应用: 0.1.11 release 测试包, `pnpm tauri build --bundles app -c '{"bundle":{"createUpdaterArtifacts":false}}'`, 构建缓存置于 `/Users/qi/.cache/adb-gui-acceptance-target`.
- 安装到 `/Applications/ADB GUI.app`, 本地 ad-hoc 签名后 `codesign --verify --deep --strict` 通过, 通过 LaunchServices `open` 启动.
- 应用可执行文件 SHA-256: `80da99a59a62f78cf9832ab690800c09074b823d79fa65b3ae668742e100c03f`.
- 原应用和 WebKit 设置已备份, 完成验收后恢复原偏好.

## 已验证结果

- 原生启动成功, 设备在线, A-10 开始投屏按钮可用.
- 前端回归: `pnpm test` 61 文件, 637 测试通过; TypeScript / Vite production build 通过.
- macOS release 编译通过, 补上此前云端缺少 Apple SDK 的原生编译证据.
- macOS release 测试 runner: 182 项通过, 0.87 秒, 执行设 60 秒硬超时; `cargo fmt --check` 通过. cargo 二次编译曾触及 60 秒上限, 详情见剪贴板任务验收中的检查命令说明.

| 场景 | 结果与证据 |
| --- | --- |
| 非 shell PATH | 通过 `open --env PATH=/usr/bin:/bin:/usr/sbin:/sbin` 启动; 核对应用进程 PATH, 设置显示 `/opt/homebrew/bin/scrcpy`, 5.0.1, 来源常见位置. |
| 画面和控制 | 用户提供 `ADB GUI acceptance` 窗口截图, 并明确确认有画面且可正常操作. |
| 参数持久化 | 重启后省流, 窗口置顶, 关闭音频和带引号窗口标题均保持. |
| 省流 | 实际 argv 为 `--max-size=1024 --video-bit-rate=4M --max-fps=30`, 并带置顶, 无音频和自定义标题. |
| 标准 | 实际录得 H.264, 1440x3200, 28 帧, 4.035 秒; `--time-limit=4` 正常结束后原生模块显示已关闭, 可重新开始. |
| 高清和仅查看 | 实际 argv 含 `--video-bit-rate=16M --no-control`, 不含息屏/唤醒/触摸三项参数; 三项 UI 禁用但存储勾选保留. 产物 H.264, 1440x3200, 50 帧, 13.476 秒. |
| 息屏/唤醒/触摸 | 关闭仅查看后原勾选恢复可用; 实际 argv 含三项开关. `show_touches=1`, `mStayOn=true`; SurfaceFlinger 的物理 Internal 显示 `powerMode=Off`, scrcpy Virtual Display 为 On. 录得 121 帧, 29.095 秒. |
| 停止及状态恢复 | 模块停止后对应 scrcpy PID 消失, 另一个设备会话继续存活; 息屏结束物理显示恢复 On, `show_touches=0`. |
| adb 与连续采集 | 实际 scrcpy 的 `ADB` 为应用同一路径. 投屏前后的 adb server PID 85268, 原 Logcat PID 178 和 metrics PID 179 均未变; 性能持续更新, 原生 Logcat 查询收到投屏期间的 `mirror-logcat-continuity-20261021` 标记. |
| 双设备 | 真机与模拟器实际同时有两个 scrcpy 子进程 (446 / 998), serial 分别正确; 选择设备后模块显示各自会话. |
| 错误参数 | `--bogus` 真实退出码 1, 模块显示 unrecognized option; `-s abc` 行内报错且模块启动再次拒绝; 未闭合引号行内报错. |
| 旧版本 | 受控 `--version` 探针返回 1.21, 原生设置和模块显示需要 2.0+, 开始按钮禁用. 探针不用于证明真实投屏. |
| 自定义路径错误 | 将受控探针移走后重新检测, 显示文件不存在或不可执行, 不回退到已安装的 Homebrew scrcpy; 恢复自动后正常可用. |
| 直接关闭窗口 | 用户按提示点击 `ADB GUI close test` 红色关闭按钮; 模块显示已关闭, 恢复开始按钮, 核对对应真机 scrcpy 子进程已回收. |
| 传输中断 | 在模拟器会话运行时执行 `adb -s emulator-5554 reconnect device`; 原 scrcpy PID 998 消失, 重新选中该设备后模块显示设备已断开. 录屏产物 H.264, 456x1024, 528 帧, 468.768 秒. |
| 应用退出 | 两个活动 scrcpy 会话和采集进程同时存在时正常 Cmd+Q; 退出后原应用 PID 99714, 两个 scrcpy PID 2156 / 2210, adb 子进程 2191 / 2192 均消失. 逐 PID 检查无残留. |
| 真机物理拔插 | 用户拔掉 USB 并保持断开后, adb 列表为空, scrcpy PID 2659 已回收, 模块禁用开始; 插回后显示上次设备已断开, 可重新开始. |
| 关闭音频 | 所有验收录屏 (标准/高清/息屏/模拟器) 用 ffprobe 核对均只有 video stream, 没有 audio stream. |

## 模拟器环境问题

- 用户的模拟器投屏截图出现 System UI 无响应. `am_anr` 事件确认发生在 10:17:30 冷启动阶段, 原因为 `com.android.systemui` 未及时完成启动; 模拟器投屏于 10:31 才启动. 时间证据排除本次投屏启动触发这次 ANR.
- 模拟器以 `-no-window -no-audio -no-snapshot -read-only` 启动, 不保存本次状态. 返回主页后继续测试; 不把该 ANR 记为本应用故障或跳过不说明.

## 结项范围

- macOS 打包应用 + Redmi K70 USB 真机的必需验收完成, 双设备并发使用 Android 17 只读模拟器补验.
- Windows/Linux 原生运行, 无线投屏和第二台物理手机未覆盖. 未安装分支由既有单测/浏览器冒烟覆盖; 1.21 版本分支使用受控探针, 未安装真实旧版 scrcpy.
- 本轮没有修改产品代码, 不需要新增或改写已有实现契约. 既有跨平台风险和 2026-10-19 的历史验证记录保留.

## 恢复与清理

- 正常退出和异常授权受阻实例的进程均按记录 PID 核对回收. 最终没有本轮 ADB GUI, scrcpy, 模拟器, crashpad/netsimd 或测试采集子进程.
- 原 WebKit 全部 localStorage 与备份逐字节相同; 电脑完整剪贴板和手机原空剪贴板已恢复. 手机三项临时设置恢复为原值.
- 本轮构建缓存, 验收录屏, 探针, 备份和文稿已清理; 两个设备端测试 DEX 已删除. 测试前存在的系统 adb server 保留.
- `/Applications/ADB GUI.app` 保留验收过的 0.1.11 测试版, 签名校验通过, 应用已退出.
