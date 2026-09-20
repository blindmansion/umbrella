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
  createdAt: number;
};

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
  setGuildRepo(guildId: string, repo: string): Promise<GuildRepoRecord>;
  getGuildRepo(guildId: string): Promise<GuildRepoRecord | undefined>;
  clearGuildRepo(guildId: string): Promise<void>;
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
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  create(opts: {
    env: Record<string, string>;
    idleTimeoutMinutes: number;
    networkIsolation?: "PRIVATE" | "ISOLATED";
  }): Promise<SandboxHandle>;
  connect(id: string): Promise<SandboxHandle>;
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
  recentTurns(msg: IncomingMessage): Promise<ConversationTurn[]>;
}

export type IntentAction =
  | "chat"
  | "create_task"
  | "reset"
  | "close"
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

export interface GitHubClient {
  fetchMetadata(ref: GitHubReference): Promise<GitHubMetadata>;
  fetchDefaultBranch(repo: RepoReference): Promise<string | undefined>;
  fetchOpenIssues(repo: RepoReference): Promise<GitHubIssue[]>;
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
};

export type Deps = {
  store: StateStore;
  chat: ChatPlatform;
  sandboxes: SandboxProvider;
  classifier?: IntentClassifier;
  github: GitHubClient;
  config: CoreConfig;
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
  | { type: "model"; channelId: string; threadId?: string; model?: string }
  | {
      type: "repo";
      guildId: string;
      action: "show" | "set" | "clear";
      repo?: string;
    };

export type CommandResult = {
  ok: boolean;
  message: string;
  channelId?: string;
};
