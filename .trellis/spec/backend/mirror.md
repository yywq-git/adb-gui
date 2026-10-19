# scrcpy Mirroring Launcher

## 1. Scope / Trigger

- Apply when changing scrcpy discovery, version checks, argv generation, extra-argument parsing, mirroring sessions, the `mirror-exit` event, application-exit cleanup, or the frontend store and tool module that consume them.
- Applies across `src-tauri/src/commands/mirror.rs`, `src-tauri/src/lib.rs`, `src/lib/tauri.ts`, `src/lib/mirror.ts`, `src/store/mirror.ts`, `src/hooks/useMirrorRuntime.ts`, `src/components/MirrorTool.tsx` and `src/components/settings/sections/MirrorSection.tsx`.
- scrcpy is an external program the user installed. The application finds it, builds argv, starts, stops and reaps it, and shows the result. It never renders video, controls the scrcpy window, bundles or downloads scrcpy.
- Use [Error Handling](./error-handling.md) for payload rules and [Settings and Clipboard](../frontend/settings-clipboard.md) for the `mirror` preference group.

## 2. Signatures

- `detect_scrcpy(custom_path: Option<String>) -> Result<ScrcpyInfo, AppError>` (async)
- `parse_scrcpy_extra_args(text: String) -> Result<Vec<String>, AppError>`
- `start_mirror(app, serial: String, request: MirrorRequest) -> Result<MirrorSessionInfo, AppError>` (async)
- `stop_mirror(serial: String, session_id: u64) -> Result<(), AppError>` (async)
- `list_mirror_sessions() -> Vec<MirrorSessionInfo>`
- `shutdown_mirror_sessions() -> Result<(), AppError>`, called from `RunEvent::Exit`
- `ScrcpyInfo { path, version, source: "custom" | "path" | "known" }`
- `MirrorRequest { scrcpyPath: string | null, preset: "standard" | "saver" | "high", options: { turnScreenOff, stayAwake, showTouches, alwaysOnTop, noAudio, viewOnly }, extraArgs: string }` (camelCase on the wire)
- `MirrorSessionInfo { serial, session_id }`; event `mirror-exit`: `MirrorExit { serial, session_id, outcome: "closed" | "stopped" | "disconnected" | "failed", error: AppError | null }`
- Frontend bridge: `detectScrcpy`, `parseScrcpyExtraArgs`, `startMirror`, `stopMirror`, `listMirrorSessions`, `onMirrorExit`, `pickScrcpyExecutable`.
- Frontend store: `createMirrorStore(api)` / `useMirrorStore` with `detection`, `sessions`, `lastExit`, `ensureDetected`, `detect`, `start`, `stop`, `restore`, `acceptExit`.

## 3. Contracts

### Discovery and version

- `custom_path = Some(p)`: `p` must be absolute and an existing executable file; otherwise `mirror.customPathInvalid { path }`. Never fall back to automatic lookup.
- `custom_path = None`: search absolute `PATH` entries for `scrcpy` / `scrcpy.exe` in process (relative entries are skipped), then the platform list in order, then `mirror.notFound`:
  - macOS: `/opt/homebrew/bin/scrcpy`, `/usr/local/bin/scrcpy`, `/opt/local/bin/scrcpy` (a Finder-launched app does not inherit the shell PATH)
  - Linux: `/usr/local/bin/scrcpy`, `/usr/bin/scrcpy`, `/snap/bin/scrcpy`
  - Windows: `%LOCALAPPDATA%\Microsoft\WinGet\Links\scrcpy.exe`, `%USERPROFILE%\scoop\shims\scrcpy.exe`, `%ProgramData%\chocolatey\bin\scrcpy.exe`
- `locate_scrcpy(custom, path_dirs, known, is_executable)` takes the executable predicate as a parameter so lookup order is tested without host files.
- Run `scrcpy --version` with a 5-second timeout and parse only the first stdout line with `^scrcpy (\d+)\.(\d+)(\.\d+)?`. scrcpy 2.0 is the minimum (`--video-bit-rate`, `--no-audio` and friends start there; Ubuntu 22.04 ships 1.21).
- `start_mirror` detects again on every start with the request's `scrcpyPath`; the frontend's cached detection is presentation only.

### Extra arguments

- Rust is the only parser. Split on Unicode whitespace; single or double quotes group text and are removed; backslashes are ordinary characters so `C:\a\b` survives. An unclosed quote is `mirror.extraArgsUnclosedQuote`.
- Device selection belongs to the application. scrcpy uses `getopt_long`, which accepts unambiguous long-option abbreviations and bundled short flags (verified on scrcpy 5.0.1: `--ser=X`, `--tcp`, `--ot` and `-Sd` all select a device). Reject, as `mirror.extraArgsForbidden { option }`:
  - a long option whose name before `=` is a prefix of `serial`, `select-usb`, `select-tcpip`, `tcpip` or `otg` (`option` is the typed `--name`);
  - a short cluster containing `s`, `d` or `e` before the first value-taking short option `b`, `m`, `p`, `r`, `s` or `V` (`-sX`, `-Sd`, `-wte` reject; `-m1024`, `-bd` pass).
- A value that begins with `-` and follows a long option as a separate argument is scanned as an option; use `--opt=value` for such values.
- The settings row calls `parse_scrcpy_extra_args` after a 300 ms debounce and shows the error inline; `start_mirror` parses again and its result is authoritative.

### argv and environment

- argv is `["-s", serial]`, then the preset (`standard` none; `saver` `--max-size=1024 --video-bit-rate=4M --max-fps=30`; `high` `--video-bit-rate=16M`), then `--always-on-top`, `--no-audio`, `--no-control` (view only), then `--turn-screen-off`, `--stay-awake`, `--show-touches` only when view only is off, then the extra arguments. scrcpy lets later arguments override earlier ones.
- scrcpy refuses to start when `--no-control` is combined with the three control options, so they are omitted, not merely disabled in the UI; their stored values survive.
- Spawn without a shell: `adb::new_async_command(path).args(argv)` (hidden console on Windows), `stdin` null, `stdout` null, `stderr` piped, `kill_on_drop(true)`.
- Set `ADB=<adb::resolve_adb_path>`. A second adb client of another version restarts the adb server and cuts Logcat and metrics streams. When that adb is the bundled Linux binary, also set `LD_LIBRARY_PATH` from `adb::embedded_linux_lib_dir`, exactly as `adb::prepare_command` does.

### Sessions and exit

- One session per serial; different serials run concurrently. Starts are serialized by a per-serial tokio mutex; a registered serial is `mirror.alreadyRunning`. Session ids increase globally.
- The registry is a `std::sync::Mutex<HashMap<serial, MirrorSession>>` that is never held across an await. A shutdown gate closed under the same lock rejects late registrations with `mirror.shuttingDown`; a rejected child is killed and reaped before returning.
- One monitor task owns each child. It reads stderr into a bounded tail (last 40 lines, each cut to 512 bytes on a UTF-8 boundary), waits for exit or a stop request, unregisters the matching session id, emits `mirror-exit`, then marks the session exited.
- Outcome: stop requested by the application (stop command or exit) -> `stopped`; code 0 -> `closed` (window closed); code 2 -> `disconnected` with `mirror.disconnected`; other code -> `failed` with `mirror.exitFailed { code }`; no code (Unix signal not sent by us) -> `failed` with `mirror.terminated`; wait error -> `failed` with `mirror.waitFailed`.
- Diagnostic `detail`: the text after `ERROR: ` from every matching stderr line, accepting the macOS NSLog prefix `YYYY-MM-DD HH:MM:SS.mmm scrcpy[pid:tid] `. getopt messages such as `unrecognized option '--bogus'` carry no prefix, so without ERROR lines use the last 5 non-empty lines.
- `stop_mirror(serial, session_id)` with a stale id is a no-op success. Otherwise it requests a stop and waits up to 5 seconds for the monitor: Unix sends SIGTERM (scrcpy cleans up like closing its window) and SIGKILL after 3 seconds; Windows terminates the process. Timeout -> `mirror.stopFailed`.
- `RunEvent::Exit` calls `shutdown_mirror_sessions` after Logcat and metrics shutdown and before `adb::shutdown_embedded_adb_server`, because scrcpy needs the adb server while it cleans up. It closes the gate, stops every session and waits up to 5 seconds in total; failures aggregate into `mirror.stopAllFailed { failed, total }`.

### Frontend

- `useMirrorStore` is runtime state only. `useMirrorRuntime()` at the App root subscribes to `mirror-exit` first, then calls `restore()` (`list_mirror_sessions`), so a reloaded page reattaches to open scrcpy windows. The tool module may be hidden while sessions end.
- `acceptExit` ignores an exit whose session id differs from the stored one. An exit for a serial that is starting or unknown is buffered and applied when the start or list response names that session id, so an immediate failure cannot leave a phantom session.
- A start failure is stored in `lastExit` and rendered beside the start button; it never raises a toast. A start failure with a discovery code also updates `detection`.
- The `mirror-exit` event, not the stop response, ends a session in the store.
- `ensureDetected(path)` detects once per stored path; detection results carry the path and a request number so stale results are dropped.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Custom path relative, missing, a directory or not executable | `mirror.customPathInvalid { path }`, no fallback |
| Nothing in PATH or the platform list | `mirror.notFound` |
| `--version` cannot spawn, or prints an unparsable first line | `mirror.versionUnreadable` with raw output/OS error in `detail` |
| `--version` exceeds 5 seconds | `mirror.versionTimeout` |
| Version below 2.0 | `mirror.tooOld { version, minimum }` |
| Unclosed quote / device selector in extra arguments | `mirror.extraArgsUnclosedQuote` / `mirror.extraArgsForbidden { option }` |
| Same serial already registered | `mirror.alreadyRunning` |
| Start during application exit | `mirror.shuttingDown`; the spawned child is killed and reaped |
| adb path unavailable or scrcpy spawn failure | `mirror.startFailed` with the adb error as cause or the OS error as detail |
| Exit code 0 / 2 / other / signal | `closed` / `disconnected` / `failed` + `exitFailed { code }` / `failed` + `terminated` |
| Stop with a stale session id | `Ok(())`, the current session keeps running |
| Process still alive 5 seconds after a stop request | `mirror.stopFailed`; the store returns the session to running with `stopError` |

## 5. Good/Base/Bad Cases

- Good: a Finder-launched macOS app finds `/opt/homebrew/bin/scrcpy` with source `known` and starts it with `ADB` set to the application's adb, so Logcat keeps streaming.
- Good: `--bogus` starts scrcpy, which exits 1; the module shows `unrecognized option '--bogus'` next to the start button.
- Base: two devices mirror at once; switching the selected device shows that device's session or last result.
- Bad: falling back to PATH when the configured scrcpy path is wrong; the user would mirror with a binary they did not choose.
- Bad: matching only `-s`, `--serial=` and `-sX`; `--ser=X` or `-Sd` would make scrcpy mirror another device while the app tracks the first.
- Bad: passing the extra-arguments string to a shell or splitting it again in TypeScript.

## 6. Tests Required

- Rust unit tests: version lines (`scrcpy 5.0.1 <...>`, `2.0`, `1.25`, garbage); lookup order with an injected predicate (custom invalid without fallback, relative custom path, PATH before known locations, relative PATH entries skipped, not found); splitting (whitespace, both quotes, quotes inside a word, empty quoted arguments, Windows backslashes, unclosed quotes); every forbidden form including abbreviations and bundles plus allowed options; argv for each preset and option, view-only omission and extra arguments last; request/event serde shape; stderr tail bounds and UTF-8 truncation; ERROR extraction with NSLog prefix and fallback; exit mapping for 0/2/1/stopped/signal/wait error; registry duplicates, stale ids and the shutdown gate.
- Process tests (Unix, `/bin/sh` doubles): failed exit with `ERROR: boom`, closed, disconnected, duplicate serial rejection, shutdown of two sessions then rejection, stale stop, SIGTERM-ignoring child escalated to SIGKILL, spawn failure.
- Frontend: store early exits for start and restore, stale exits, stale detection, start failure without toast, discovery failure updating detection, stop failure; view-model mapping for every state; SSR rendering of every module state in both languages; one shared preset control writing `update("mirror", ...)`; view-only chips disabled with stored values kept.
- Browser smoke (`pnpm test:browser`): A-10 not found / too old / invalid path / running / long failure / disconnected without horizontal overflow at 900x600 and 1200x800 in both themes and languages; settings anchor, four rows, inline extra-argument error and section reset.
- Real device (packaged app, LaunchServices on macOS): Finder-launched discovery, Logcat continuity during mirroring, stop and window close, each preset and option, `--bogus`, `-s abc`, invalid custom path, USB unplug, exit cleanup with `pgrep scrcpy`.

## 7. Wrong vs Correct

### Wrong

```rust
// Shell parsing, PATH-only lookup and a second adb client.
Command::new("sh").arg("-c").arg(format!("scrcpy -s {serial} {extra_args}")).spawn()?;
```

### Correct

```rust
let extra_args = parse_extra_args(&request.extra_args)?;
let scrcpy = detect(request.scrcpy_path.as_deref()).await?;
let mut command = adb::new_async_command(&scrcpy.path);
command.args(build_mirror_args(&serial, request.preset, &request.options, extra_args));
command.env("ADB", &adb_path);
```
