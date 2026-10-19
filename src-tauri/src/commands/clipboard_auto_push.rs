use crate::error::AppError;
#[cfg(not(any(target_os = "macos", windows)))]
use crate::error_codes as codes;
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::{AppHandle, State};

/// Each target change starts a new generation. A watcher keeps working only
/// while its generation is current, so A -> B -> A never writes to a stale target.
#[derive(Default)]
pub struct AutoPushState {
    generation: Arc<AtomicU64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    serial: String,
}

#[tauri::command]
pub fn set_clipboard_auto_push(
    app: AppHandle,
    state: State<'_, AutoPushState>,
    target: Option<Target>,
) -> Result<u64, AppError> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(target) = target {
        start(app, &state, generation, target)?;
    }
    Ok(generation)
}

#[tauri::command]
pub fn get_clipboard_auto_push_support() -> bool {
    cfg!(any(target_os = "macos", windows))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn start(
    _app: AppHandle,
    _state: &AutoPushState,
    _generation: u64,
    _target: Target,
) -> Result<(), AppError> {
    Err(AppError::new(codes::CLIPBOARD_AUTO_PUSH_UNSUPPORTED))
}

// The baseline is read before the command returns: content copied before the
// target was set is never pushed, content copied afterwards is a change.
#[cfg(any(target_os = "macos", windows))]
fn start(
    app: AppHandle,
    state: &AutoPushState,
    generation: u64,
    target: Target,
) -> Result<(), AppError> {
    let baseline = native::change_count();
    let io = native::NativeIo {
        app,
        serial: target.serial,
        generation,
        current: state.generation.clone(),
    };
    tauri::async_runtime::spawn(watcher::run(io, baseline));
    Ok(())
}

#[cfg(any(target_os = "macos", windows))]
mod native {
    use super::watcher::{ChangeCount, HostRead, Io, Status, StatusEvent};
    use crate::commands::clipboard;
    use crate::{adb, error::AppError, error_codes as codes};
    use std::future::Future;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    const STATUS_EVENT: &str = "clipboard-auto-push";
    const POLL_INTERVAL: Duration = Duration::from_millis(500);

    #[cfg(target_os = "macos")]
    pub(super) fn change_count() -> Option<ChangeCount> {
        objc2::rc::autoreleasepool(|_| {
            Some(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as ChangeCount)
        })
    }

    #[cfg(windows)]
    pub(super) fn change_count() -> Option<ChangeCount> {
        // SAFETY: takes no arguments and only reads the window station counter.
        let count =
            unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() };
        // Zero means this session has no clipboard access; read nothing.
        (count != 0).then_some(ChangeCount::from(count))
    }

    // arboard is the library behind the clipboard plugin. Its typed error tells
    // a clipboard without text apart from a failed read; the plugin only keeps
    // the English message.
    fn read_host_text() -> HostRead {
        let failed = |error: arboard::Error| {
            AppError::new(codes::CLIPBOARD_HOST_READ_FAILED).detail(error.to_string())
        };
        match arboard::Clipboard::new().map_err(failed)?.get_text() {
            Ok(text) => Ok(Some(text)),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(error) => Err(failed(error)),
        }
    }

    pub(super) struct NativeIo {
        pub(super) app: AppHandle,
        pub(super) serial: String,
        pub(super) generation: u64,
        pub(super) current: Arc<AtomicU64>,
    }

    impl Io for NativeIo {
        type Helper = clipboard::PreparedHelper;

        fn is_current(&self) -> bool {
            self.current.load(Ordering::SeqCst) == self.generation
                && !adb::is_shutting_down(&self.app)
        }

        fn change_count(&self) -> Option<ChangeCount> {
            change_count()
        }

        fn wait(&self) -> impl Future<Output = ()> + Send {
            tokio::time::sleep(POLL_INTERVAL)
        }

        async fn read_text(&self) -> HostRead {
            tauri::async_runtime::spawn_blocking(read_host_text)
                .await
                .map_err(|error| {
                    AppError::new(codes::CLIPBOARD_HOST_READ_FAILED).detail(error.to_string())
                })
                .and_then(|read| read)
        }

        fn prepare(&self) -> impl Future<Output = Result<Self::Helper, AppError>> + Send {
            clipboard::prepare(&self.app, &self.serial)
        }

        async fn submit(&self, helper: Self::Helper, text: &str) -> Result<(), AppError> {
            let request = clipboard::encode_request(Some(text))?;
            clipboard::submit(helper, &request, true).await.map(|_| ())
        }

        // The frontend filters by generation again: a target change can land
        // between this check and delivery.
        fn emit(&self, status: Status) {
            if !self.is_current() {
                return;
            }
            let event = StatusEvent {
                generation: self.generation,
                at: chrono::Utc::now().timestamp_millis(),
                status: &status,
            };
            if let Err(error) = self.app.emit(STATUS_EVENT, event) {
                eprintln!("failed to emit clipboard auto push status: {error}");
            }
        }
    }
}

#[cfg(any(target_os = "macos", windows, test))]
mod watcher {
    use crate::commands::clipboard::MAX_TEXT_BYTES;
    use crate::error::AppError;
    use serde::Serialize;
    use std::future::Future;
    use std::hash::{BuildHasher, RandomState};

    pub(super) type ChangeCount = i64;
    /// `Ok(None)` means the clipboard holds no text representation.
    pub(super) type HostRead = Result<Option<String>, AppError>;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "snake_case")]
    pub(super) enum SkipReason {
        NoText,
        TooLarge,
    }

    /// Status only. Clipboard text never enters an event.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    pub(super) enum Status {
        Watching,
        Pushing,
        Pushed,
        Skipped { reason: SkipReason },
        Failed { error: AppError },
    }

    #[derive(Clone, Serialize)]
    pub(super) struct StatusEvent<'a> {
        pub(super) generation: u64,
        pub(super) at: i64,
        #[serde(flatten)]
        pub(super) status: &'a Status,
    }

    /// Side effects of one watcher generation, injected so the loop runs in tests
    /// without a clipboard or adb.
    pub(super) trait Io {
        type Helper: Send;
        fn is_current(&self) -> bool;
        fn change_count(&self) -> Option<ChangeCount>;
        fn wait(&self) -> impl Future<Output = ()> + Send;
        fn read_text(&self) -> impl Future<Output = HostRead> + Send;
        fn prepare(&self) -> impl Future<Output = Result<Self::Helper, AppError>> + Send;
        /// Must start the write before its first await.
        fn submit(
            &self,
            helper: Self::Helper,
            text: &str,
        ) -> impl Future<Output = Result<(), AppError>> + Send;
        fn emit(&self, status: Status);
    }

    enum Decision {
        Push { text: String, hash: u64 },
        Duplicate,
        Skip(SkipReason),
        Fail(AppError),
    }

    struct Watcher {
        last_seen: Option<ChangeCount>,
        // Keyed per generation; only a hash of the last pushed text is kept.
        hasher: RandomState,
        last_pushed: Option<u64>,
    }

    impl Watcher {
        fn new(baseline: Option<ChangeCount>) -> Self {
            Self {
                last_seen: baseline,
                hasher: RandomState::new(),
                last_pushed: None,
            }
        }

        // Only a change from a known count is new content. An unknown baseline
        // adopts the first known count instead of pushing what is already there.
        fn observe(&mut self, count: Option<ChangeCount>) -> bool {
            let Some(count) = count else {
                return false;
            };
            let changed = self.last_seen.is_some_and(|seen| seen != count);
            self.last_seen = Some(count);
            changed
        }

        fn classify(&self, read: HostRead) -> Decision {
            match read {
                Err(error) => Decision::Fail(error),
                Ok(None) => Decision::Skip(SkipReason::NoText),
                Ok(Some(text)) if text.is_empty() => Decision::Skip(SkipReason::NoText),
                Ok(Some(text)) if text.len() > MAX_TEXT_BYTES => {
                    Decision::Skip(SkipReason::TooLarge)
                }
                Ok(Some(text)) => {
                    let hash = self.hasher.hash_one(&text);
                    if self.last_pushed == Some(hash) {
                        Decision::Duplicate
                    } else {
                        Decision::Push { text, hash }
                    }
                }
            }
        }
    }

    /// Polls the change count and pushes the newest text. Copies made during a
    /// push collapse into one later read, and a failed copy is never retried.
    pub(super) async fn run<I: Io>(io: I, baseline: Option<ChangeCount>) {
        let mut watcher = Watcher::new(baseline);
        if !io.is_current() {
            return;
        }
        io.emit(Status::Watching);
        loop {
            io.wait().await;
            if !io.is_current() {
                return;
            }
            if !watcher.observe(io.change_count()) {
                continue;
            }
            let read = io.read_text().await;
            if !io.is_current() {
                return;
            }
            let (text, hash) = match watcher.classify(read) {
                Decision::Push { text, hash } => (text, hash),
                Decision::Duplicate => continue,
                Decision::Skip(reason) => {
                    io.emit(Status::Skipped { reason });
                    continue;
                }
                Decision::Fail(error) => {
                    io.emit(Status::Failed { error });
                    continue;
                }
            };
            io.emit(Status::Pushing);
            let helper = match io.prepare().await {
                Ok(helper) => helper,
                Err(error) => {
                    if !io.is_current() {
                        return;
                    }
                    io.emit(Status::Failed { error });
                    continue;
                }
            };
            // No await between this check and the helper start inside `submit`.
            if !io.is_current() {
                return;
            }
            let result = io.submit(helper, &text).await;
            if !io.is_current() {
                return;
            }
            match result {
                Ok(()) => {
                    watcher.last_pushed = Some(hash);
                    io.emit(Status::Pushed);
                }
                Err(error) => io.emit(Status::Failed { error }),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::error_codes as codes;
        use std::collections::VecDeque;
        use std::sync::Mutex;

        enum Clip {
            Text(String),
            NonText,
            ReadError,
        }

        fn text(value: &str) -> Clip {
            Clip::Text(value.into())
        }

        struct FakeState {
            current: bool,
            count: ChangeCount,
            content: HostRead,
            // One entry per poll; the script ends the generation when it runs out.
            polls: VecDeque<Vec<Clip>>,
            copies_during_submit: VecDeque<Vec<Clip>>,
            prepare_errors: VecDeque<Option<AppError>>,
            submit_errors: VecDeque<Option<AppError>>,
            stale_after_prepare: bool,
            stale_after_submit: bool,
            reads: usize,
            prepared: usize,
            submitted: Vec<String>,
            events: Vec<Status>,
        }

        struct Fake(Mutex<FakeState>);

        impl Fake {
            fn new(polls: Vec<Vec<Clip>>) -> Self {
                Self(Mutex::new(FakeState {
                    current: true,
                    count: 7,
                    content: Ok(Some("before".into())),
                    polls: polls.into(),
                    copies_during_submit: VecDeque::new(),
                    prepare_errors: VecDeque::new(),
                    submit_errors: VecDeque::new(),
                    stale_after_prepare: false,
                    stale_after_submit: false,
                    reads: 0,
                    prepared: 0,
                    submitted: Vec::new(),
                    events: Vec::new(),
                }))
            }

            fn with(self, change: impl FnOnce(&mut FakeState)) -> Self {
                change(&mut self.0.lock().unwrap());
                self
            }

            /// Starts a new generation with the same clipboard and a new script.
            fn next_generation(&self, polls: Vec<Vec<Clip>>) {
                let mut state = self.0.lock().unwrap();
                state.current = true;
                state.polls = polls.into();
                state.events.clear();
            }

            fn baseline(&self) -> Option<ChangeCount> {
                Some(self.0.lock().unwrap().count)
            }
        }

        impl FakeState {
            fn copy(&mut self, clips: Vec<Clip>) {
                for clip in clips {
                    self.count += 1;
                    self.content = match clip {
                        Clip::Text(text) => Ok(Some(text)),
                        Clip::NonText => Ok(None),
                        Clip::ReadError => Err(AppError::new(codes::CLIPBOARD_HOST_READ_FAILED)),
                    };
                }
            }
        }

        impl Io for &Fake {
            type Helper = ();

            fn is_current(&self) -> bool {
                self.0.lock().unwrap().current
            }

            fn change_count(&self) -> Option<ChangeCount> {
                Some(self.0.lock().unwrap().count)
            }

            fn wait(&self) -> impl Future<Output = ()> + Send {
                let mut state = self.0.lock().unwrap();
                match state.polls.pop_front() {
                    Some(clips) => state.copy(clips),
                    None => state.current = false,
                }
                async {}
            }

            fn read_text(&self) -> impl Future<Output = HostRead> + Send {
                let mut state = self.0.lock().unwrap();
                state.reads += 1;
                let content = state.content.clone();
                async { content }
            }

            fn prepare(&self) -> impl Future<Output = Result<(), AppError>> + Send {
                let mut state = self.0.lock().unwrap();
                state.prepared += 1;
                if state.stale_after_prepare {
                    state.current = false;
                }
                let result = match state.prepare_errors.pop_front().flatten() {
                    Some(error) => Err(error),
                    None => Ok(()),
                };
                async { result }
            }

            fn submit(
                &self,
                _helper: (),
                text: &str,
            ) -> impl Future<Output = Result<(), AppError>> + Send {
                let mut state = self.0.lock().unwrap();
                state.submitted.push(text.into());
                if let Some(clips) = state.copies_during_submit.pop_front() {
                    state.copy(clips);
                }
                if state.stale_after_submit {
                    state.current = false;
                }
                let result = match state.submit_errors.pop_front().flatten() {
                    Some(error) => Err(error),
                    None => Ok(()),
                };
                async { result }
            }

            fn emit(&self, status: Status) {
                self.0.lock().unwrap().events.push(status);
            }
        }

        async fn watch(fake: &Fake) {
            run(fake, fake.baseline()).await;
        }

        fn locked() -> AppError {
            AppError::new(codes::CLIPBOARD_LOCKED)
        }

        #[tokio::test]
        async fn content_from_before_the_baseline_is_never_pushed() {
            let fake = Fake::new(vec![vec![], vec![]]);
            watch(&fake).await;
            let state = fake.0.lock().unwrap();
            assert_eq!(state.reads, 0);
            assert!(state.submitted.is_empty());
            assert_eq!(state.events, [Status::Watching]);
        }

        #[tokio::test]
        async fn a_changed_count_pushes_once_and_an_unchanged_count_reads_nothing() {
            let fake = Fake::new(vec![vec![text("a")], vec![], vec![]]);
            watch(&fake).await;
            let state = fake.0.lock().unwrap();
            assert_eq!(state.reads, 1);
            assert_eq!(state.submitted, ["a"]);
            assert_eq!(
                state.events,
                [Status::Watching, Status::Pushing, Status::Pushed]
            );
        }

        #[tokio::test]
        async fn the_same_text_is_pushed_once_per_generation() {
            let fake = Fake::new(vec![vec![text("a")], vec![text("a")]]);
            watch(&fake).await;
            {
                let state = fake.0.lock().unwrap();
                assert_eq!(state.reads, 2);
                assert_eq!(state.submitted, ["a"]);
                assert_eq!(
                    state.events,
                    [Status::Watching, Status::Pushing, Status::Pushed]
                );
            }
            fake.next_generation(vec![vec![text("a")]]);
            watch(&fake).await;
            let state = fake.0.lock().unwrap();
            assert_eq!(state.submitted, ["a", "a"]);
            assert_eq!(
                state.events,
                [Status::Watching, Status::Pushing, Status::Pushed]
            );
        }

        #[tokio::test]
        async fn copies_during_a_push_collapse_into_the_newest_text() {
            let fake = Fake::new(vec![vec![text("a")], vec![]]).with(|state| {
                state.copies_during_submit = vec![vec![text("b"), text("c"), text("d")]].into();
            });
            watch(&fake).await;
            let state = fake.0.lock().unwrap();
            assert_eq!(state.reads, 2);
            assert_eq!(state.submitted, ["a", "d"]);
        }

        #[tokio::test]
        async fn a_failed_write_is_not_retried_and_does_not_mark_the_text_as_pushed() {
            let fake = Fake::new(vec![vec![text("a")], vec![], vec![text("a")]])
                .with(|state| state.submit_errors = vec![Some(locked())].into());
            watch(&fake).await;
            let state = fake.0.lock().unwrap();
            assert_eq!(state.reads, 2);
            assert_eq!(state.submitted, ["a", "a"]);
            assert_eq!(
                state.events,
                [
                    Status::Watching,
                    Status::Pushing,
                    Status::Failed { error: locked() },
                    Status::Pushing,
                    Status::Pushed,
                ]
            );
        }

        #[tokio::test]
        async fn a_failed_preparation_reports_and_waits_for_the_next_copy() {
            let failure = AppError::new(codes::CLIPBOARD_PREPARE_DEX_FAILED);
            let fake = Fake::new(vec![vec![text("a")], vec![], vec![text("b")]])
                .with(|state| state.prepare_errors = vec![Some(failure.clone())].into());
            watch(&fake).await;
            let state = fake.0.lock().unwrap();
            assert_eq!(state.prepared, 2);
            assert_eq!(state.submitted, ["b"]);
            assert_eq!(
                state.events,
                [
                    Status::Watching,
                    Status::Pushing,
                    Status::Failed { error: failure },
                    Status::Pushing,
                    Status::Pushed,
                ]
            );
        }

        #[tokio::test]
        async fn a_generation_change_during_preparation_submits_nothing() {
            let fake = Fake::new(vec![vec![text("a")], vec![text("b")]])
                .with(|state| state.stale_after_prepare = true);
            watch(&fake).await;
            let state = fake.0.lock().unwrap();
            assert_eq!(state.prepared, 1);
            assert!(state.submitted.is_empty());
            assert_eq!(state.events, [Status::Watching, Status::Pushing]);
        }

        #[tokio::test]
        async fn a_generation_change_during_preparation_failure_reports_nothing() {
            let fake = Fake::new(vec![vec![text("a")]]).with(|state| {
                state.stale_after_prepare = true;
                state.prepare_errors = vec![Some(locked())].into();
            });
            watch(&fake).await;
            assert_eq!(
                fake.0.lock().unwrap().events,
                [Status::Watching, Status::Pushing]
            );
        }

        #[tokio::test]
        async fn a_generation_change_during_a_write_reports_nothing() {
            for error in [None, Some(locked())] {
                let fake = Fake::new(vec![vec![text("a")], vec![text("b")]]).with(|state| {
                    state.stale_after_submit = true;
                    state.submit_errors = vec![error].into();
                });
                watch(&fake).await;
                let state = fake.0.lock().unwrap();
                assert_eq!(state.submitted, ["a"]);
                assert_eq!(state.events, [Status::Watching, Status::Pushing]);
            }
        }

        #[tokio::test]
        async fn empty_non_text_oversized_and_unreadable_copies_are_never_written() {
            let fake = Fake::new(vec![
                vec![text("")],
                vec![Clip::NonText],
                vec![Clip::Text("x".repeat(MAX_TEXT_BYTES + 1))],
                vec![Clip::ReadError],
            ]);
            watch(&fake).await;
            let state = fake.0.lock().unwrap();
            assert_eq!(state.reads, 4);
            assert_eq!(state.prepared, 0);
            assert!(state.submitted.is_empty());
            assert_eq!(
                state.events,
                [
                    Status::Watching,
                    Status::Skipped {
                        reason: SkipReason::NoText
                    },
                    Status::Skipped {
                        reason: SkipReason::NoText
                    },
                    Status::Skipped {
                        reason: SkipReason::TooLarge
                    },
                    Status::Failed {
                        error: AppError::new(codes::CLIPBOARD_HOST_READ_FAILED)
                    },
                ]
            );
        }

        #[tokio::test]
        async fn text_at_the_size_limit_is_pushed() {
            let limit = "中".repeat(MAX_TEXT_BYTES / 3) + &"x".repeat(MAX_TEXT_BYTES % 3);
            assert_eq!(limit.len(), MAX_TEXT_BYTES);
            let fake = Fake::new(vec![vec![Clip::Text(limit.clone())]]);
            watch(&fake).await;
            assert_eq!(fake.0.lock().unwrap().submitted, [limit]);
        }

        #[tokio::test]
        async fn a_stale_generation_never_starts_watching() {
            let fake = Fake::new(vec![vec![text("a")]]).with(|state| state.current = false);
            watch(&fake).await;
            let state = fake.0.lock().unwrap();
            assert!(state.events.is_empty());
            assert_eq!(state.reads, 0);
        }

        #[test]
        fn an_unknown_count_reads_nothing_and_adopts_the_first_known_count() {
            let mut watcher = Watcher::new(None);
            assert!(!watcher.observe(None));
            assert!(!watcher.observe(Some(3)));
            assert!(!watcher.observe(Some(3)));
            assert!(!watcher.observe(None));
            assert!(watcher.observe(Some(4)));
            let mut watcher = Watcher::new(Some(3));
            assert!(!watcher.observe(Some(3)));
            assert!(watcher.observe(Some(9)));
        }

        #[test]
        fn status_events_carry_no_clipboard_text() {
            let statuses = [
                Status::Watching,
                Status::Pushing,
                Status::Pushed,
                Status::Skipped {
                    reason: SkipReason::NoText,
                },
                Status::Skipped {
                    reason: SkipReason::TooLarge,
                },
                Status::Failed { error: locked() },
            ];
            let json: Vec<_> = statuses
                .iter()
                .map(|status| {
                    serde_json::to_value(StatusEvent {
                        generation: 3,
                        at: 1_700_000_000_000,
                        status,
                    })
                    .unwrap()
                })
                .collect();
            for event in &json {
                for key in event.as_object().unwrap().keys() {
                    assert!(
                        ["generation", "at", "kind", "reason", "error"].contains(&key.as_str()),
                        "{key}"
                    );
                }
            }
            assert_eq!(
                json[3],
                serde_json::json!({ "generation": 3, "at": 1_700_000_000_000_i64, "kind": "skipped", "reason": "no_text" })
            );
            assert_eq!(
                json[5],
                serde_json::json!({ "generation": 3, "at": 1_700_000_000_000_i64, "kind": "failed", "error": { "code": codes::CLIPBOARD_LOCKED } })
            );
            assert_eq!(json[0]["kind"], "watching");
            assert_eq!(json[2]["kind"], "pushed");
        }
    }
}
