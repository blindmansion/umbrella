export type TaskKind = "planning" | "feature" | "bugfix" | "review";
export type TaskStatus = "provisioning" | "ready" | "archived";

export type TaskRecord = {
  channelId: string;
  kind: TaskKind;
  repo: string;
  refNumber: number | null;
  branch: string;
  sandboxId: string | null;
  status: TaskStatus;
  configHash: string | null;
  statusMessageId: string | null;
  model: string | null;
  context: string | null;
  /** Discord user whose dashboard configuration provisioned this task. */
  createdBy: string | null;
  createdAt: number;
};

/** Per-user dashboard configuration. The GitHub token is never included. */
export type UserSettingsRecord = {
  userId: string;
  userName: string | null;
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
  /** Non-sensitive suffix of the stored token, e.g. `••••1234`. */
  tokenHint: string | null;
  hasToken: boolean;
  createdAt: number;
  updatedAt: number;
};

/** The encrypted-at-rest portion of a user's configuration. */
export type UserSecretRecord = {
  userId: string;
  /** base64url(iv || AES-256-GCM ciphertext+tag). */
  encryptedToken: string;
  updatedAt: number;
};

export type UserSettingsUpdate = {
  userName?: string | null;
  gitAuthorName?: string | null;
  gitAuthorEmail?: string | null;
  encryptedToken?: string | null;
  tokenHint?: string | null;
  updatedAt: number;
};

export type MagicLinkRecord = {
  nonce: string;
  guildId: string;
  guildName: string | null;
  userId: string;
  userName: string | null;
  isAdmin: boolean;
  expiresAt: number;
  consumedAt: number | null;
  createdAt: number;
};

/**
 * The credentials a sandbox should use, resolved per task creator. A missing
 * value falls back to the global environment.
 */
export type SandboxUserConfig = {
  gitAuthorName?: string | null;
  gitAuthorEmail?: string | null;
  githubToken?: string | null;
  /** Changes whenever the user's stored configuration changes. */
  version: number;
};

export type CredentialResolver = (
  task: TaskRecord,
) => Promise<SandboxUserConfig | undefined>;

export type SessionRecord = {
  threadId: string;
  channelId: string;
  openCodeSessionId: string | null;
  model: string | null;
  worktreePath: string | null;
  branch: string | null;
  createdBy: string | null;
  createdAt: number;
};

export type GuildRepoRecord = {
  guildId: string;
  repo: string;
  createdAt: number;
};

export type TaskUpdate = Partial<
  Pick<
    TaskRecord,
    | "kind"
    | "repo"
    | "refNumber"
    | "branch"
    | "sandboxId"
    | "status"
    | "configHash"
    | "statusMessageId"
    | "model"
    | "context"
  >
>;

export interface StateStore {
  close(): Promise<void>;
  createTask(task: TaskRecord): Promise<void>;
  getTask(channelId: string): Promise<TaskRecord | undefined>;
  updateTask(
    channelId: string,
    update: TaskUpdate,
  ): Promise<TaskRecord | undefined>;
  listActiveTasks(): Promise<TaskRecord[]>;
  deleteTask(channelId: string): Promise<void>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(threadId: string): Promise<SessionRecord | undefined>;
  updateSessionOpenCodeId(
    threadId: string,
    openCodeSessionId: string | null,
  ): Promise<SessionRecord | undefined>;
  updateSessionModel(
    threadId: string,
    model: string | null,
  ): Promise<SessionRecord | undefined>;
  updateSessionWorktree(
    threadId: string,
    workspace: { path: string; branch: string },
  ): Promise<SessionRecord | undefined>;
  listSessionsForChannel(channelId: string): Promise<SessionRecord[]>;
  clearSessionsForChannel(channelId: string): Promise<void>;
  clearSessionOpenCodeIdsForChannel(channelId: string): Promise<void>;
  setGuildRepo(guildId: string, repo: string): Promise<GuildRepoRecord>;
  getGuildRepo(guildId: string): Promise<GuildRepoRecord | undefined>;
  clearGuildRepo(guildId: string): Promise<void>;
  getUserSettings(userId: string): Promise<UserSettingsRecord | undefined>;
  listUserSettings(): Promise<UserSettingsRecord[]>;
  upsertUserSettings(
    userId: string,
    update: UserSettingsUpdate,
  ): Promise<UserSettingsRecord>;
  getUserSecret(userId: string): Promise<UserSecretRecord | undefined>;
  createMagicLink(link: MagicLinkRecord): Promise<void>;
  /** Atomically consumes a nonce, returning its record once. */
  consumeMagicLink(
    nonce: string,
    now: number,
  ): Promise<MagicLinkRecord | undefined>;
  deleteExpiredMagicLinks(now: number): Promise<void>;
}

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ExecHandle = Promise<ExecResult> & {
  sessionName?: Promise<string>;
};

export interface SandboxHandle {
  id: string;
  exec(command: string, opts?: ExecOptions): ExecHandle;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Capture the sandbox's disk under a reusable name. */
  checkpoint(name: string): Promise<void>;
  destroy(): Promise<void>;
}

export type SandboxCheckpoint = { id: string; key: string };

export type SandboxCreateOptions = {
  env: Record<string, string>;
  idleTimeoutMinutes: number;
  networkIsolation?: "PRIVATE" | "ISOLATED";
};

export interface SandboxProvider {
  create(opts: SandboxCreateOptions): Promise<SandboxHandle>;
  connect(id: string): Promise<SandboxHandle>;
  /** Boot a sandbox from a checkpoint captured with `checkpoint`. */
  restore(name: string, opts: SandboxCreateOptions): Promise<SandboxHandle>;
  listCheckpoints(): Promise<SandboxCheckpoint[]>;
  deleteCheckpoint(id: string): Promise<void>;
}

export type ConversationTurn = {
  author: string;
  content: string;
  isBot: boolean;
};

export type IncomingMessage = {
  id: string;
  guildId: string;
  guildName: string;
  channelId: string;
  threadId?: string;
  authorId: string;
  authorName: string;
  text: string;
  botMentioned: boolean;
};

export type MessageRef = {
  id: string;
  channelId: string;
};

export interface ChatPlatform {
  reply(to: IncomingMessage, text: string): Promise<MessageRef>;
  send(channelOrThreadId: string, text: string): Promise<MessageRef>;
  edit(ref: MessageRef, text: string): Promise<void>;
  pin(ref: MessageRef): Promise<void>;
  startThread(from: IncomingMessage, name: string): Promise<string>;
  createTaskChannel(opts: {
    guildId: string;
    category: string;
    name: string;
    reason: string;
  }): Promise<string>;
  archiveThreads(channelId: string): Promise<void>;
  /**
   * Freeze a completed task channel so no further work happens in it, archiving
   * its threads while preserving channel history.
   */
  archiveChannel(channelId: string): Promise<void>;
  recentTurns(msg: IncomingMessage): Promise<ConversationTurn[]>;
  /**
   * The full conversation in a thread, oldest first. Used to seed a fresh
   * session when a stored OpenCode session can't be resumed.
   */
  transcript(
    threadId: string,
    options?: { excludeId?: string; limit?: number },
  ): Promise<ConversationTurn[]>;
}

export type IntentAction =
  | "chat"
  | "create_task"
  | "reset"
  | "close"
  | "done"
  | "ignore";
export type IntentSurface = "task_channel" | "thread" | "other";
export type IntentContext = {
  surface: IntentSurface;
  botMentioned: boolean;
  taskActive: boolean;
  hasSession: boolean;
  recentTurns: ConversationTurn[];
  latest: ConversationTurn;
};
export type IntentClassification = {
  directedAtBot: number;
  action: IntentAction;
  confidence: number;
};

export interface IntentClassifier {
  classify(
    context: IntentContext,
  ): Promise<IntentClassification | undefined>;
}

export type GitHubReference = {
  owner: string;
  name: string;
  number: number;
  urlKind: "issue" | "pull";
};
export type RepoReference = { owner: string; name: string };
export type GitHubMetadata = {
  title?: string;
  body?: string;
  headRef?: string;
  defaultBranch?: string;
};
export type GitHubIssue = { number: number; title: string; url: string };
export type GitHubReferenceState = {
  /** Whether the issue or pull request is still open. */
  state: "open" | "closed";
  /** Pull requests only: whether the pull request was merged. */
  merged: boolean;
};

export interface GitHubClient {
  fetchMetadata(ref: GitHubReference): Promise<GitHubMetadata>;
  fetchDefaultBranch(repo: RepoReference): Promise<string | undefined>;
  fetchOpenIssues(repo: RepoReference): Promise<GitHubIssue[]>;
  /**
   * Look up the current open/closed state of a linked issue or pull request.
   * Returns `undefined` when the state can't be determined, so callers leave
   * the task untouched rather than closing it by mistake.
   */
  fetchReferenceState(
    ref: GitHubReference,
  ): Promise<GitHubReferenceState | undefined>;
}

export type CoreConfig = {
  model: string;
  sandboxEnv: Record<string, string>;
  configHash: string;
  githubToken?: string;
  tracing?: {
    endpoint: string;
    apiKey?: string;
    logContent: boolean;
  };
  networkIsolation?: "PRIVATE" | "ISOLATED";
  intentConfidenceThreshold?: number;
  /** Public dashboard base URL and shared signing secret. */
  dashboard?: {
    url: string;
    secret: string;
  };
};

export type Deps = {
  store: StateStore;
  chat: ChatPlatform;
  sandboxes: SandboxProvider;
  classifier?: IntentClassifier;
  github: GitHubClient;
  config: CoreConfig;
  credentials?: CredentialResolver;
  clock?: () => number;
};

export type Command =
  | {
      type: "task";
      guildId: string;
      guildName: string;
      actorId: string;
      actorName: string;
      reference?: GitHubReference;
      repo?: string;
      kind?: TaskKind;
      branch?: string;
      prompt?: string;
    }
  | { type: "close"; channelId: string }
  | { type: "done"; channelId: string }
  | { type: "model"; channelId: string; threadId?: string; model?: string }
  | {
      type: "repo";
      guildId: string;
      action: "show" | "set" | "clear";
      repo?: string;
    }
  | {
      type: "configure";
      guildId: string;
      guildName: string | null;
      userId: string;
      userName: string | null;
      isAdmin: boolean;
    };

export type CommandResult = {
  ok: boolean;
  message: string;
  channelId?: string;
};
