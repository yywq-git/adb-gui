import { create } from "zustand";
import { toAppError } from "@/i18n/errors";
import {
  DETECTION_ERROR_CODES,
  type MirrorDetection,
  type MirrorLastExit,
  type MirrorSession,
} from "@/lib/mirror";
import {
  detectScrcpy,
  listMirrorSessions,
  startMirror,
  stopMirror,
  type MirrorExit,
  type MirrorRequest,
  type MirrorSessionInfo,
  type ScrcpyInfo,
} from "@/lib/tauri";

export interface MirrorApi {
  detect: (customPath: string | null) => Promise<ScrcpyInfo>;
  start: (serial: string, request: MirrorRequest) => Promise<MirrorSessionInfo>;
  stop: (serial: string, sessionId: number) => Promise<void>;
  list: () => Promise<MirrorSessionInfo[]>;
  now: () => number;
}

interface MirrorState {
  detection: MirrorDetection;
  // Keyed by serial: scrcpy allows one window per device in this app.
  sessions: Readonly<Record<string, MirrorSession>>;
  lastExit: Readonly<Record<string, MirrorLastExit>>;
  ensureDetected: (scrcpyPath: string | null) => void;
  detect: (scrcpyPath: string | null) => Promise<void>;
  start: (serial: string, request: () => MirrorRequest) => Promise<void>;
  stop: (serial: string) => Promise<void>;
  restore: () => Promise<void>;
  acceptExit: (exit: MirrorExit) => void;
}

// Runtime only: sessions belong to processes, not to the settings file.
export function createMirrorStore(api: MirrorApi) {
  let detectRequest = 0;
  // An exit can overtake the start or list response that names its session.
  const earlyExits = new Map<string, MirrorExit>();

  return create<MirrorState>((set, get) => {
    function record(exit: MirrorExit): MirrorLastExit {
      return { outcome: exit.outcome, error: exit.error, at: api.now() };
    }

    function end(state: MirrorState, exit: MirrorExit): Partial<MirrorState> {
      const sessions = { ...state.sessions };
      delete sessions[exit.serial];
      return { sessions, lastExit: { ...state.lastExit, [exit.serial]: record(exit) } };
    }

    return {
      detection: { status: "idle" },
      sessions: {},
      lastExit: {},
      ensureDetected: (scrcpyPath) => {
        const { detection } = get();
        if (detection.status === "idle" || detection.scrcpyPath !== scrcpyPath) {
          void get().detect(scrcpyPath);
        }
      },
      detect: async (scrcpyPath) => {
        const request = ++detectRequest;
        set({ detection: { status: "detecting", scrcpyPath } });
        try {
          const info = await api.detect(scrcpyPath);
          if (request === detectRequest) {
            set({ detection: { status: "ready", scrcpyPath, info } });
          }
        } catch (error) {
          if (request === detectRequest) {
            set({ detection: { status: "error", scrcpyPath, error: toAppError(error) } });
          }
        }
      },
      start: async (serial, readRequest) => {
        if (get().sessions[serial]) return;
        // Whatever was buffered for this serial belongs to an ended session.
        earlyExits.delete(serial);
        set((state) => {
          const lastExit = { ...state.lastExit };
          delete lastExit[serial];
          return { sessions: { ...state.sessions, [serial]: { phase: "starting" } }, lastExit };
        });
        let request: MirrorRequest | null = null;
        try {
          request = readRequest();
          const { session_id: sessionId } = await api.start(serial, request);
          const early = earlyExits.get(serial);
          if (early?.session_id === sessionId) {
            earlyExits.delete(serial);
            set((state) => end(state, early));
            return;
          }
          set((state) =>
            state.sessions[serial]?.phase === "starting"
              ? {
                  sessions: {
                    ...state.sessions,
                    [serial]: { phase: "running", sessionId, stopError: null },
                  },
                }
              : {},
          );
        } catch (failure) {
          const error = toAppError(failure);
          const scrcpyPath = request?.scrcpyPath ?? null;
          const detectionFailed = request !== null && DETECTION_ERROR_CODES.has(error.code);
          if (detectionFailed) detectRequest += 1;
          set((state) => {
            const sessions = { ...state.sessions };
            delete sessions[serial];
            return {
              sessions,
              lastExit: {
                ...state.lastExit,
                [serial]: { outcome: "failed", error, at: api.now() },
              },
              // Rust detects again on every start; keep the module's guidance in step.
              ...(detectionFailed
                ? { detection: { status: "error", scrcpyPath, error } as const }
                : {}),
            };
          });
        }
      },
      stop: async (serial) => {
        const session = get().sessions[serial];
        if (session?.phase !== "running") return;
        const { sessionId } = session;
        set((state) => ({
          sessions: { ...state.sessions, [serial]: { phase: "stopping", sessionId } },
        }));
        try {
          // The mirror-exit event, not this response, ends the session.
          await api.stop(serial, sessionId);
        } catch (failure) {
          const stopError = toAppError(failure);
          set((state) => {
            const current = state.sessions[serial];
            return current?.phase === "stopping" && current.sessionId === sessionId
              ? {
                  sessions: {
                    ...state.sessions,
                    [serial]: { phase: "running", sessionId, stopError },
                  },
                }
              : {};
          });
        }
      },
      restore: async () => {
        const running = await api.list();
        set((state) => {
          const sessions = { ...state.sessions };
          const lastExit = { ...state.lastExit };
          for (const { serial, session_id: sessionId } of running) {
            if (sessions[serial]) continue;
            const early = earlyExits.get(serial);
            if (early?.session_id === sessionId) {
              earlyExits.delete(serial);
              lastExit[serial] = record(early);
              continue;
            }
            sessions[serial] = { phase: "running", sessionId, stopError: null };
          }
          return { sessions, lastExit };
        });
      },
      acceptExit: (exit) => {
        const session = get().sessions[exit.serial];
        if (!session || session.phase === "starting") {
          earlyExits.set(exit.serial, exit);
          return;
        }
        if (session.sessionId !== exit.session_id) return;
        set((state) => end(state, exit));
      },
    };
  });
}

export const useMirrorStore = createMirrorStore({
  detect: detectScrcpy,
  start: startMirror,
  stop: stopMirror,
  list: listMirrorSessions,
  now: () => Date.now(),
});
