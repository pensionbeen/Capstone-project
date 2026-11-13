import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AIReply, type AISnapshot, activeAIStates, emptyAISnapshot } from '../../shared/ai.js';
import { generationPrompt, parseGeneratedPlan } from '../../shared/feature-generation.js';
import type { StoredFeature } from '../../shared/feature-plan.js';
import {
  type FeatureSessionAction,
  type FeatureSessionContext,
  featureContextMatches,
  validFeatureSessionInput,
} from '../../shared/feature-session.js';
import type { LocalProject } from '../../shared/local-api.js';
import { protectionUnavailable } from '../../shared/protection.js';
import {
  type RequirementsAction,
  requirementsPrompt,
  validRequirementsInput,
} from '../../shared/requirements.js';
import { inspectDirectory } from '../policy.js';
import { codexArguments, inspectCodex, installedCodex } from './codex.js';
import { OutputBuffer, promptIsValid, rejected, sizeIsValid, UUID } from './contracts.js';
import {
  checkFeaturePaths,
  featureSessionPrompt,
  storedFeatureContext,
} from './feature-context.js';
import { ProcessAudit, type ProcessIdentity, processSnapshot } from './process-audit.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function readGeneratedResponse(path: string) {
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 128 * 1024)
      throw new Error('GENERATION_RESPONSE_SIZE');
    const buffer = Buffer.alloc(128 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 128 * 1024) throw new Error('GENERATION_RESPONSE_SIZE');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}
interface Driver {
  file: string;
  args: string[];
  inspectHeader: boolean;
}
interface Dependencies {
  inspect?: typeof inspectCodex;
  launchHold?: () => string | null;
  // Synchronous trusted DB read lets us recheck immediately before committing a turn.
  loadFeature?: (projectId: string, featureId: string) => StoredFeature | undefined;
  checkFeaturePaths?: typeof checkFeaturePaths;
  prepare?: (
    cwd: string,
    prompt: string,
    conversation?: string,
    resultFile?: string,
  ) => Promise<Driver>;
  snapshot?: () => Promise<ProcessIdentity[]>;
  hostExecutable?: string;
}
const messages: Record<string, string> = {
  PROTECTION_UNVERIFIED: protectionUnavailable,
  OUTPUT_LIMIT: '출력 한도를 넘어 실행을 중단했어요. 요청을 작게 나누어 주세요.',
  HEADER_CONFIG_MISMATCH: '요청한 Codex 실행 설정과 실제 표시가 달라 실행을 중단했어요.',
  HEADER_UNCONFIRMED: 'Codex 실행 설정을 확인하지 못해 실행을 중단했어요.',
  SESSION_TIMEOUT: '실행 시간 한도에 도달해 중단했어요. 요청을 작게 나누어 주세요.',
  LOGIN_NOT_READY: 'Codex 설치·로그인 상태를 다시 확인해 주세요.',
  PROJECT_UNAVAILABLE: '선택한 프로젝트 폴더를 열 수 없어요. 폴더를 다시 선택해 주세요.',
  FEATURE_CHANGED:
    '기능의 내용·완료 조건·관련 경로가 바뀌었어요. 최신 기능으로 새 대화를 시작해 주세요.',
  FEATURE_PATH_UNAVAILABLE:
    '기능의 관련 경로 또는 프로젝트 폴더를 열 수 없어요. 없는 경로·링크·프로젝트 밖 경로는 사용할 수 없어요.',
};

export class SessionManager {
  private projects = new Map<string, string>();
  private projectNames = new Map<string, string>();
  private projectId: string | null = null;
  private state = { ...emptyAISnapshot };
  private output = new OutputBuffer();
  private conversation?: string;
  private host?: ChildProcess;
  private lifetime?: Promise<void>;
  private pendingFeature?: { projectId: string; cancelled: boolean };
  private featurePreparation?: Promise<AIReply>;
  private stopRequested = false;
  private shutdownRequested = false;
  private cols = 100;
  private rows = 28;
  private lastResize = 0;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  diagnostic: {
    reason: string | null;
    owned: ProcessIdentity[];
    uncertain: (ProcessIdentity & { observedParent: ProcessIdentity | null })[];
  } = { reason: null, owned: [], uncertain: [] };
  private lastStatus = 0;
  private availability?: ReturnType<typeof inspectCodex>;
  private availabilityPending = false;
  private probeCleanupUnconfirmed = false;
  private availabilityAbort?: AbortController;
  private readonly dependencies: Dependencies;

  constructor(dependencies: Dependencies = {}) {
    this.dependencies = dependencies;
  }
  launchHold() {
    try {
      return this.dependencies.launchHold?.() ?? null;
    } catch {
      return protectionUnavailable;
    }
  }
  get busy() {
    return Boolean(this.pendingFeature) || activeAIStates.includes(this.state.state);
  }

  listProjects() {
    return [...this.projects].map(([id, path]) => ({
      id,
      name: this.projectNames.get(id) ?? (basename(path) || parse(path).root),
      path,
    }));
  }

  hasProject(id: string) {
    return this.projects.has(id);
  }

  get canChangeProjects() {
    return !this.busy && !this.shutdownRequested && this.state.cleanupConfirmed;
  }
  get canChangeProtection() {
    return this.canChangeProjects && !this.availabilityPending;
  }
  async stopForProtection() {
    this.availabilityAbort?.abort();
    if (this.pendingFeature) this.pendingFeature.cancelled = true;
    if (this.projectId && activeAIStates.includes(this.state.state)) this.stop(this.projectId);
    await Promise.all([this.availability, this.featurePreparation, this.lifetime]);
    return this.state.cleanupConfirmed;
  }
  replaceProjects(projects: LocalProject[], resetSession = false) {
    if (!this.canChangeProjects) return false;
    this.projects = new Map(projects.map((p) => [p.id, p.path]));
    this.projectNames = new Map(projects.map((p) => [p.id, p.name]));
    if (resetSession) {
      this.projectId = null;
      this.state = { ...emptyAISnapshot };
      this.output = new OutputBuffer();
      this.conversation = undefined;
    }
    return true;
  }

  registerProject(path: string) {
    if (this.busy || this.shutdownRequested) return null;
    for (const [id, existing] of this.projects) if (existing === path) return id;
    const id = randomUUID();
    this.projects.set(id, path);
    if (this.projects.size > 16) {
      const old = [...this.projects.keys()].find((key) => key !== this.projectId && key !== id);
      if (old) this.projects.delete(old);
    }
    return id;
  }
  availabilityStatus() {
    const hold = this.launchHold();
    if (hold) return Promise.resolve({ status: 'error' as const, message: hold });
    if (this.probeCleanupUnconfirmed)
      return Promise.resolve({
        status: 'error' as const,
        cleanupUnconfirmed: true,
        message: '이전 로그인 확인의 종료가 확인되지 않아 새 조회를 차단했어요.',
      });
    if (this.shutdownRequested)
      return Promise.resolve({ status: 'error' as const, message: '앱 실행을 정리하고 있어요.' });
    if (!this.availability || (!this.availabilityPending && Date.now() - this.lastStatus > 5000)) {
      this.lastStatus = Date.now();
      this.availabilityPending = true;
      this.availabilityAbort = new AbortController();
      this.availability = (this.dependencies.inspect ?? inspectCodex)(this.availabilityAbort.signal)
        .then((result) => {
          if (result.cleanupUnconfirmed) {
            this.probeCleanupUnconfirmed = true;
            this.state.cleanupConfirmed = false;
            if (this.pendingFeature) this.pendingFeature.cancelled = true;
            if (activeAIStates.includes(this.state.state) && this.projectId)
              this.stop(this.projectId);
            else {
              this.state.state = 'error';
              this.state.message = result.message;
            }
          }
          return result;
        })
        .finally(() => {
          this.availabilityPending = false;
        });
    }
    return this.availability;
  }
  read(projectId: string, after: number): AISnapshot {
    if (projectId !== this.projectId) return { ...emptyAISnapshot, chunks: [] };
    return {
      ...this.state,
      featureContext: this.state.featureContext
        ? {
            ...this.state.featureContext,
            relatedPaths: [...this.state.featureContext.relatedPaths],
          }
        : null,
      outputId: this.output.id,
      chunks: this.output.read(after),
      retainedBytes: this.output.bytes,
      firstSequence: this.output.chunks[0]?.sequence ?? this.output.next,
      nextSequence: this.output.next,
      truncated: this.output.truncated,
      conversationReady: Boolean(this.conversation) && this.state.cleanupConfirmed,
    };
  }
  submit(projectId: string, prompt: string): AIReply {
    const hold = this.launchHold();
    if (hold) return rejected(hold);
    if (this.projectId === projectId && this.state.purpose !== 'chat')
      return rejected('현재 대화에 연결된 화면에서 답변하거나 새 일반 대화를 시작해 주세요.');
    return this.startTurn(projectId, prompt, 'chat', null, false);
  }
  feature(
    projectId: string,
    action: FeatureSessionAction,
    featureId: string,
    expectedRevision: number,
    input: string,
    expectedOutputId: string | null,
    expectedRunId: string | null,
  ): Promise<AIReply> {
    const hold = this.launchHold();
    if (hold) return Promise.resolve(rejected(hold));
    if (
      typeof projectId !== 'string' ||
      !UUID.test(projectId) ||
      typeof featureId !== 'string' ||
      !UUID.test(featureId) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      expectedRevision > 2147483647 ||
      !validFeatureSessionInput(action, input) ||
      !(
        expectedOutputId === null ||
        (typeof expectedOutputId === 'string' && UUID.test(expectedOutputId))
      ) ||
      !(expectedRunId === null || (typeof expectedRunId === 'string' && UUID.test(expectedRunId)))
    )
      return Promise.resolve(
        rejected('기능과 버전을 확인하고 요청은 2,000자 이내로 입력해 주세요.'),
      );
    if (this.busy || this.shutdownRequested || !this.state.cleanupConfirmed)
      return Promise.resolve(rejected('현재 실행과 정리가 끝난 뒤 기능 대화를 시작해 주세요.'));
    if (!this.sessionMatches(projectId, expectedOutputId, expectedRunId))
      return Promise.resolve(
        rejected('대화 상태가 바뀌었어요. 최신 상태를 확인한 뒤 다시 시도해 주세요.'),
      );
    const cwd = this.projects.get(projectId);
    if (!cwd || !this.dependencies.loadFeature)
      return Promise.resolve(rejected('저장된 프로젝트와 기능을 다시 불러와 주세요.'));
    const pending = { projectId, cancelled: false };
    this.pendingFeature = pending;
    const preparation = this.prepareFeature(
      pending,
      cwd,
      action,
      featureId,
      expectedRevision,
      input,
      expectedOutputId,
      expectedRunId,
    ).finally(() => {
      if (this.pendingFeature === pending) this.pendingFeature = undefined;
      if (this.featurePreparation === preparation) this.featurePreparation = undefined;
    });
    this.featurePreparation = preparation;
    return preparation;
  }
  private sessionMatches(projectId: string, outputId: string | null, runId: string | null) {
    const current = this.read(projectId, Number.MAX_SAFE_INTEGER);
    return current.outputId === outputId && current.id === runId;
  }
  private featureStillCurrent(projectId: string, cwd: string, context: FeatureSessionContext) {
    const feature = this.dependencies.loadFeature?.(projectId, context.featureId);
    if (
      this.projects.get(projectId) !== cwd ||
      !feature ||
      !featureContextMatches(feature, context)
    )
      throw new Error('FEATURE_CHANGED');
  }
  private async prepareFeature(
    pending: { projectId: string; cancelled: boolean },
    cwd: string,
    action: FeatureSessionAction,
    featureId: string,
    expectedRevision: number,
    input: string,
    expectedOutputId: string | null,
    expectedRunId: string | null,
  ): Promise<AIReply> {
    const projectId = pending.projectId;
    try {
      const feature = this.dependencies.loadFeature?.(projectId, featureId);
      const context = storedFeatureContext(feature, featureId, expectedRevision);
      if (
        action === 'answer' &&
        (this.projectId !== projectId ||
          this.state.purpose !== 'feature' ||
          !this.state.featureContext ||
          !this.conversation ||
          !feature ||
          !featureContextMatches(feature, this.state.featureContext))
      )
        return rejected(
          '이 기능과 같은 조건으로 이어갈 대화가 없어요. 새 기능 대화를 시작해 주세요.',
        );
      const prompt = featureSessionPrompt(action, context, input);
      if (!promptIsValid(prompt))
        return rejected(
          '기능 내용·관련 경로·요청을 합친 메시지가 8,000자 한도를 넘거나 허용되지 않는 문자를 포함해요. 내용을 줄이거나 수정해 주세요. 일부 내용을 생략해 보내지 않았어요.',
        );
      await (this.dependencies.checkFeaturePaths ?? checkFeaturePaths)(cwd, context.relatedPaths);
      if (pending.cancelled || this.shutdownRequested || this.pendingFeature !== pending)
        return rejected('기능 대화 준비가 취소됐어요. 실행하지 않았어요.');
      this.featureStillCurrent(projectId, cwd, context);
      if (!this.sessionMatches(projectId, expectedOutputId, expectedRunId))
        return rejected('대화 상태가 바뀌었어요. 최신 상태를 확인한 뒤 다시 시도해 주세요.');
      // No await between releasing the reservation and acquiring startTurn's running state.
      this.pendingFeature = undefined;
      return this.startTurn(
        projectId,
        prompt,
        'feature',
        null,
        action === 'start',
        false,
        false,
        context,
      );
    } catch (error) {
      return rejected(
        messages[error instanceof Error ? error.message : ''] ??
          '저장된 기능을 확인하지 못했어요. 최신 기능을 다시 불러와 주세요.',
      );
    }
  }
  requirements(projectId: string, action: RequirementsAction, input: string): AIReply {
    const hold = this.launchHold();
    if (hold) return rejected(hold);
    if (!validRequirementsInput(action, input))
      return rejected('목표는 1~2,000자, 답변·정정은 1~6,000자로 입력해 주세요.');
    if (action === 'answer' && !this.state.requirementsGoalConfirmed)
      return rejected(
        '목표 요청이 끝나지 않았어요. 목표를 다시 보내 질문을 받은 뒤 답변해 주세요.',
      );
    if (
      action !== 'start' &&
      (this.projectId !== projectId ||
        this.state.purpose !== 'requirements' ||
        !this.state.requirementsGoal ||
        !this.conversation)
    )
      return rejected('이어서 보낼 요구분석 대화가 없어요. 목표를 다시 보내 시작해 주세요.');
    const reply = this.startTurn(
      projectId,
      requirementsPrompt(action, input),
      'requirements',
      action === 'answer' ? this.state.requirementsGoal : input,
      action === 'start',
      action === 'answer' && this.state.requirementsGoalConfirmed,
    );
    return reply.ok
      ? { ...reply, runId: this.state.id ?? undefined, outputId: this.output.id }
      : reply;
  }
  generate(projectId: string): AIReply {
    const hold = this.launchHold();
    if (hold) return rejected(hold);
    if (
      this.projectId !== projectId ||
      this.state.purpose !== 'requirements' ||
      !this.state.requirementsGoalConfirmed ||
      !this.conversation
    )
      return rejected('목표와 질문·답변 대화를 마친 뒤 기능 초안을 만들어 주세요.');
    return this.startTurn(
      projectId,
      generationPrompt,
      'requirements',
      this.state.requirementsGoal,
      false,
      true,
      true,
    );
  }
  private startTurn(
    projectId: string,
    prompt: string,
    purpose: AISnapshot['purpose'],
    requirementsGoal: string | null,
    fresh: boolean,
    requirementsGoalConfirmed = false,
    generate = false,
    featureContext: FeatureSessionContext | null = null,
  ): AIReply {
    const cwd = this.projects.get(projectId);
    if (!cwd) return rejected('앱에서 실제 프로젝트 폴더를 선택해 주세요.');
    if (!promptIsValid(prompt)) return rejected('메시지를 1~8,000자로 입력해 주세요.');
    if (this.shutdownRequested || this.busy)
      return rejected('현재 실행을 중단하거나 끝난 뒤 메시지를 보내 주세요.');
    if (!this.state.cleanupConfirmed)
      return rejected(
        '이전 실행의 정리가 확인되지 않아 새 실행을 막았어요. 앱을 닫기 전에 실행 상태를 확인해 주세요.',
      );
    if (fresh || this.projectId !== projectId) {
      this.output = new OutputBuffer();
      this.conversation = undefined;
    }
    this.projectId = projectId;
    this.stopRequested = false;
    this.state = {
      ...emptyAISnapshot,
      purpose,
      featureContext,
      requirementsGoal,
      requirementsGoalConfirmed,
      generationState: generate ? 'running' : 'idle',
      generationMessage: generate ? '대화에서 기능과 완료 조건을 정리하고 있어요.' : '',
      id: randomUUID(),
      state: 'starting',
      message: 'Codex 실행을 준비하고 있어요.',
      cleanupConfirmed: false,
    };
    this.lifetime = this.run(cwd, prompt, generate, featureContext);
    return { ok: true, runId: this.state.id ?? undefined, outputId: this.output.id };
  }
  stop(projectId: string): AIReply {
    // Preparation has no new run ID yet. A stop can only target a published active turn.
    // shutdown cancels preparation directly; an older turn's stop must not cancel it.
    if (projectId !== this.projectId || !activeAIStates.includes(this.state.state))
      return rejected('현재 실행 중인 대화가 없어요.');
    this.stopRequested = true;
    this.state.state = 'stopping';
    this.state.message = '중단 요청을 보냈어요. 로컬 실행이 정리되는지 확인하고 있어요.';
    this.send({ type: 'stop' });
    return { ok: true };
  }
  reset(projectId: string): AIReply {
    if (this.busy || !this.state.cleanupConfirmed)
      return rejected('실행이 정리된 뒤 새 대화를 시작해 주세요.');
    if (!this.projects.has(projectId)) return rejected('프로젝트를 다시 선택해 주세요.');
    this.projectId = projectId;
    this.conversation = undefined;
    this.output = new OutputBuffer();
    this.state = { ...emptyAISnapshot };
    return { ok: true };
  }
  resize(projectId: string, cols: number, rows: number): AIReply {
    if (this.busy && projectId !== this.projectId)
      return rejected('실행 중인 프로젝트의 화면 크기만 변경할 수 있어요.');
    if (!this.projects.has(projectId) || !sizeIsValid(cols, rows))
      return rejected('화면 크기를 확인할 수 없어요.');
    this.cols = cols;
    this.rows = rows;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(
      () => {
        this.lastResize = Date.now();
        if (projectId === this.projectId)
          this.send({ type: 'resize', cols: this.cols, rows: this.rows });
      },
      Math.max(0, 100 - (Date.now() - this.lastResize)),
    );
    return { ok: true };
  }
  async shutdown() {
    this.shutdownRequested = true;
    clearTimeout(this.resizeTimer);
    this.availabilityAbort?.abort();
    if (this.projectId && this.busy) this.stop(this.projectId);
    if (this.pendingFeature) this.pendingFeature.cancelled = true;
    await this.featurePreparation;
    await this.lifetime;
    await this.availability;
    return this.state.cleanupConfirmed;
  }
  private send(message: object) {
    if (this.host?.connected) this.host.send(message, () => {});
  }

  private async run(
    cwd: string,
    prompt: string,
    generate = false,
    featureContext: FeatureSessionContext | null = null,
  ) {
    const projectId = this.projectId;
    const snapshot = this.dependencies.snapshot ?? processSnapshot;
    let audit: ProcessAudit | undefined;
    let host: ChildProcess | undefined;
    let closed = false;
    let hostExited = false;
    let ready = false;
    let started = false;
    let ptyPid: number | undefined;
    let result: { code: number | null; outputDrained: boolean } | undefined;
    let failure: string | undefined;
    let stopAt = 0;
    let outputBytes = 0;
    let diagnosticBytes = 0;
    let ownerDisposed = false;
    let resultDirectory: string | undefined;
    let resultFile: string | undefined;
    const fail = (reason: string) => {
      failure ||= reason;
    };
    try {
      if ((await inspectDirectory(cwd)).status !== 'selected')
        throw new Error('PROJECT_UNAVAILABLE');
      if (this.stopRequested) return;
      if (generate) {
        resultDirectory = await mkdtemp(join(tmpdir(), 'orbit-feature-draft-'));
        resultFile = join(resultDirectory, 'response.json');
      }
      const driver = this.dependencies.prepare
        ? await this.dependencies.prepare(cwd, prompt, this.conversation, resultFile)
        : await (async () => {
            if ((await this.availabilityStatus()).status !== 'ready')
              throw new Error('LOGIN_NOT_READY');
            return {
              file: await installedCodex(),
              args: codexArguments(cwd, prompt, this.conversation, resultFile),
              inspectHeader: true,
            };
          })();
      if (this.stopRequested) return;
      const baseline = await snapshot();
      if (this.stopRequested) return;
      if (featureContext && projectId) {
        await (this.dependencies.checkFeaturePaths ?? checkFeaturePaths)(
          cwd,
          featureContext.relatedPaths,
        );
        if (this.stopRequested) return;
        this.featureStillCurrent(projectId, cwd, featureContext);
      }
      if (this.launchHold()) throw new Error('PROTECTION_UNVERIFIED');
      host = spawn(
        this.dependencies.hostExecutable ?? process.execPath,
        [fileURLToPath(new URL('./pty-host.js', import.meta.url))],
        {
          cwd,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      this.host = host;
      host.once('error', () => fail('HOST_START_FAILED'));
      host.once('exit', () => {
        hostExited = true;
      });
      host.once('close', () => {
        closed = true;
      });
      if (!host.pid) throw new Error('HOST_START_FAILED');
      audit = new ProcessAudit(baseline, host.pid, process.pid);
      const unexpectedOutput = (data: Buffer) => {
        diagnosticBytes += data.length;
        fail('HOST_DIAGNOSTIC');
        if (diagnosticBytes > 65536) this.send({ type: 'stop' });
      };
      host.stdout?.on('data', unexpectedOutput);
      host.stderr?.on('data', unexpectedOutput);
      host.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) {
          fail('HOST_PROTOCOL');
          return;
        }
        const data = message as Record<string, unknown>;
        if (data.type === 'ready' && !ready) ready = true;
        else if (data.type === 'started' && started && !ptyPid && Number.isSafeInteger(data.pid)) {
          ptyPid = Number(data.pid);
          if (!this.stopRequested) {
            this.state.state = 'running';
            this.state.message = 'Codex가 실행 중이에요. 출력이 없어도 실행 상태를 유지해요.';
          }
        } else if (
          data.type === 'output' &&
          started &&
          typeof data.data === 'string' &&
          data.data.length <= 4096 &&
          sizeIsValid(data.cols, data.rows)
        ) {
          outputBytes += Buffer.byteLength(data.data);
          if (outputBytes > 9 * 1024 * 1024) fail('OUTPUT_LIMIT');
          else this.output.append(data.data, Number(data.cols), Number(data.rows));
          this.send({ type: 'ack', bytes: Buffer.byteLength(data.data) });
        } else if (
          data.type === 'header' &&
          typeof data.conversation === 'string' &&
          UUID.test(data.conversation)
        ) {
          if (this.conversation && this.conversation !== data.conversation)
            fail('CONVERSATION_MISMATCH');
          else this.conversation = data.conversation;
        } else if (
          data.type === 'exit' &&
          !result &&
          (data.code === null || Number.isInteger(data.code))
        ) {
          result = {
            code: data.code as number | null,
            outputDrained: data.outputDrained === true || data.cancelledBeforeStart === true,
          };
          if (typeof data.reason === 'string') fail(data.reason);
        } else if (data.type === 'fault')
          fail(typeof data.reason === 'string' ? data.reason : 'HOST_FAULT');
        else fail('HOST_PROTOCOL');
      });
      const deadline = Date.now() + 10 * 60 * 1000;
      const startupDeadline = Date.now() + 30000;
      while (!result) {
        if (hostExited || closed) throw new Error('HOST_EXITED_EARLY');
        audit.observe(await snapshot());
        if (audit.uncertain) fail('PROCESS_OWNERSHIP_UNCONFIRMED');
        if (ready && !started && !this.stopRequested && !failure) {
          if (featureContext && projectId) {
            await (this.dependencies.checkFeaturePaths ?? checkFeaturePaths)(
              cwd,
              featureContext.relatedPaths,
            );
            if (this.stopRequested) continue;
            this.featureStillCurrent(projectId, cwd, featureContext);
          }
          if (this.launchHold()) throw new Error('PROTECTION_UNVERIFIED');
          started = true;
          this.send({ type: 'start', ...driver, cwd, cols: this.cols, rows: this.rows });
        }
        if (!ptyPid && Date.now() > startupDeadline) fail('HOST_START_TIMEOUT');
        if (Date.now() > deadline) fail('SESSION_TIMEOUT');
        if ((failure || this.stopRequested) && !stopAt) {
          stopAt = Date.now();
          this.state.state = 'stopping';
          this.send({ type: 'stop' });
        }
        if (stopAt && Date.now() - stopAt > 11000)
          throw new Error(failure ?? 'PTY_EXIT_UNCONFIRMED');
        await sleep(250);
      }
      audit.observe(await snapshot());
      if (!result.outputDrained) fail('OUTPUT_DRAIN_UNCONFIRMED');
      if (ptyPid && !audit.observed(ptyPid)) fail('PTY_IDENTITY_UNCONFIRMED');
    } catch (error) {
      fail(error instanceof Error ? error.message : 'SESSION_FAILED');
      this.send({ type: 'stop' });
      if (host && !result && !hostExited) {
        const deadline = Date.now() + 5000;
        while (!result && !hostExited && Date.now() < deadline) await sleep(100);
      }
    } finally {
      let cleanup = !host;
      if (host) {
        // Only our live ChildProcess handle is terminated; never a process name or arbitrary PID.
        if (!hostExited && host.pid) {
          try {
            ownerDisposed = host.kill();
          } catch {
            fail('HOST_DISPOSE_FAILED');
          }
        }
        const closeDeadline = Date.now() + 4000;
        while (!closed && Date.now() < closeDeadline) await sleep(100);
        if (!closed || (!hostExited && host.pid)) fail('HOST_CLOSE_UNCONFIRMED');
        if (!host.pid && closed) cleanup = true;
        if (audit) {
          const deadline = Date.now() + 5000;
          try {
            do {
              audit.observe(await snapshot());
              if (!audit.uncertain && audit.alive().length === 0) {
                cleanup = true;
                break;
              }
              await sleep(200);
            } while (Date.now() < deadline);
          } catch {
            fail('PROCESS_AUDIT_FAILED');
          }
        }
        if (!ownerDisposed && !hostExited && host.pid) cleanup = false;
        host.stdout?.destroy();
        host.stderr?.destroy();
        if (!closed) {
          host.unref();
          host.channel?.unref();
        }
      }
      this.host = undefined;
      this.diagnostic = {
        reason: failure ?? null,
        owned: [...(audit?.owned.values() ?? [])],
        uncertain: [...(audit?.uncertainProcesses.values() ?? [])],
      };
      this.state.cleanupConfirmed = cleanup && (!host || closed) && !this.probeCleanupUnconfirmed;
      this.state.exitCode = result?.code ?? null;
      if (generate) {
        this.state.generationState = 'error';
        this.state.generationMessage =
          '기능 초안을 만들지 못했어요. 기존 기능은 그대로예요. 대화를 확인하고 다시 시도해 주세요.';
        if (
          this.state.cleanupConfirmed &&
          !failure &&
          !this.stopRequested &&
          result?.code === 0 &&
          resultFile
        ) {
          try {
            const text = await readGeneratedResponse(resultFile);
            const candidate = parseGeneratedPlan(text, randomUUID);
            if (candidate.ok) {
              this.state.generatedPlan = candidate.plan;
              this.state.generationState = 'ready';
              this.state.generationMessage =
                '초안을 확인하고 고친 뒤 적용해 주세요. 아직 저장하지 않았어요.';
            } else this.state.generationMessage = candidate.message;
          } catch {
            this.state.generationMessage =
              'AI의 기능 목록 응답을 읽지 못했어요. 기존 기능은 그대로예요. 다시 생성해 주세요.';
          }
        }
        if (resultFile && resultDirectory) {
          try {
            await unlink(resultFile).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
            await rmdir(resultDirectory);
          } catch {
            this.state.generatedPlan = null;
            this.state.generationState = 'error';
            this.state.generationMessage =
              '임시 응답 파일을 정리하지 못했어요. 앱 실행 환경을 확인해 주세요.';
          }
        }
      }
      if (!this.state.cleanupConfirmed) {
        this.state.state = 'error';
        this.state.message =
          '실행 정리가 확인되지 않았어요. 새 실행을 차단했어요. 앱 종료 안내를 따라 주세요.';
        this.conversation = undefined;
      } else if (failure) {
        this.state.state = 'error';
        this.state.message =
          messages[failure] ??
          '실행을 마치지 못했어요. 로컬 프로세스는 정리했어요. 출력을 확인한 뒤 다시 시도해 주세요.';
        if (failure.includes('HEADER') || failure.includes('CONVERSATION'))
          this.conversation = undefined;
      } else if (this.stopRequested) {
        this.state.state = 'interrupted';
        this.state.message = '로컬 실행을 중단하고 정리했어요. 대화를 이어서 보낼 수 있어요.';
      } else {
        this.state.state = result?.code === 0 ? 'exited' : 'error';
        if (result?.code === 0 && this.state.purpose === 'requirements')
          this.state.requirementsGoalConfirmed = true;
        this.state.message =
          result?.code === 0
            ? this.state.purpose === 'feature'
              ? '기능 대화 실행이 끝났어요. 기능 검증 완료를 뜻하지 않아요. 결과와 완료 조건을 확인해 주세요.'
              : '실행이 끝났어요. 결과를 확인하고 다음 메시지를 보내세요.'
            : 'Codex가 오류로 종료됐어요. 아래 출력을 확인해 주세요. 로컬 프로세스는 정리했어요.';
      }
    }
  }
}
