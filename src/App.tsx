import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { type AIState, emptyAISnapshot } from '../shared/ai';
import { descendantIds, removePlanFeature, updatePlanFeature } from '../shared/feature-editing';
import {
  emptyFeaturePlan,
  type ProjectFeaturePlan,
  validateFeaturePlan,
} from '../shared/feature-plan';
import type { ProjectCatalog } from '../shared/storage';
import { canRecordVerification, nextVerificationTime } from '../shared/verification';
import { FeatureEditor, VerificationEditor, WorkDetails } from './components/FeatureDialogs';
import type { IconName } from './components/ui';
import { Badge, Brand, Button, Icon, Modal } from './components/ui';
import {
  type Activity,
  type EventKind,
  type Feature,
  initialProtection,
  makeDrafts,
  type Project,
  type Provider,
  type Step,
  steps,
  type Verification,
  type View,
} from './model';
import { FeatureWorkspace } from './pages/FeatureWorkspace';
import {
  type AnalysisDraft,
  AnalysisPage,
  ConfirmPage,
  ConnectionPage,
  ProjectPage,
} from './pages/Setup';
import {
  HistoryPage,
  OverviewPage,
  ProtectionPage,
  TransferPage,
  VerificationPage,
} from './pages/Workspace';

const navigation: { id: View; label: string; icon: IconName }[] = [
  { id: 'overview', label: '작업 대시보드', icon: 'grid' },
  { id: 'features', label: '기능·파일 관리', icon: 'folder' },
  { id: 'verification', label: '기능 검증', icon: 'list' },
  { id: 'protection', label: '보호 정책', icon: 'shield' },
  { id: 'transfer', label: '파일 전송', icon: 'transfer' },
  { id: 'history', label: '실행 이력', icon: 'history' },
];
const AIConsole = lazy(() =>
  import('./components/AIConsole').then((module) => ({ default: module.AIConsole })),
);
const emptyAnalysis: AnalysisDraft = {
  goal: '',
  started: false,
  audience: '',
  scope: ['search', 'progress', 'storage'],
};

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [catalog, setCatalog] = useState<ProjectCatalog>({
    projects: [],
    activeProjectId: null,
    storage: 'memory',
  });
  const [storageLoading, setStorageLoading] = useState(Boolean(window.desktop));
  const [projectSaving, setProjectSaving] = useState(false);
  const [pendingProject, setPendingProject] = useState<Project | null>(null);
  const [step, setStep] = useState<Step>(0);
  const [inWorkspace, setInWorkspace] = useState(false);
  const [view, setView] = useState<View>('overview');
  const [providers, setProviders] = useState<Provider[]>(['Codex']);
  const [protection, setProtection] = useState(initialProtection);
  const [analysis, setAnalysis] = useState(emptyAnalysis);
  const [featurePlan, setFeaturePlan] = useState<ProjectFeaturePlan>(emptyFeaturePlan());
  const features = featurePlan.features;
  const records = featurePlan.verifications;
  const planSaveLock = useRef(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [deleting, setDeleting] = useState<Feature | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [editing, setEditing] = useState<Feature | null>(null);
  const [openedFeature, setOpenedFeature] = useState<string | null>(null);
  const [verifyFeature, setVerifyFeature] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [showProjectSwitch, setShowProjectSwitch] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [toast, setNotice] = useState<{
    message: string;
    tone: 'success' | 'warning' | 'error';
  } | null>(null);
  function setToast(message: string, tone: 'success' | 'warning' | 'error' = 'warning') {
    setNotice({ message, tone });
  }
  const [showAI, setShowAI] = useState(false);
  const [aiStatus, setAIStatus] = useState(emptyAISnapshot);
  const aiLabels: Record<AIState, string> = {
    idle: '연결 전',
    starting: '준비 중',
    running: '실행 중',
    stopping: '정리 중',
    exited: '실행 종료',
    interrupted: '중단됨',
    error: '확인 필요',
  };
  const connectionSummary = aiStatus.id
    ? providers
        .map((provider) =>
          provider === 'Codex' ? `Codex ${aiLabels[aiStatus.state]}` : `${provider} 연결 전`,
        )
        .join(' · ')
    : `${providers.join(' · ')} 연결 전`;
  const includedFeatures = features.filter(
    (feature) => feature.included && feature.kind === 'leaf',
  );
  const aiBusy = ['starting', 'running', 'stopping'].includes(aiStatus.state);
  const currentFeature = features.find((feature) => feature.id === openedFeature);
  const pageKey = `${inWorkspace ? view : step}`;
  const desktopProjectId = project?.desktopId;
  useEffect(() => {
    if (!window.desktop) return;
    let disposed = false;
    void window.desktop
      .listProjects()
      .then(async (saved) => {
        if (disposed) return;
        setCatalog(saved);
        const active = saved.projects.find((p) => p.id === saved.activeProjectId);
        if (active) {
          const result = await window.desktop?.loadFeaturePlan(active.id);
          if (disposed) return;
          if (result?.ok) {
            setProject({
              name: active.name,
              path: active.path,
              desktopId: active.id,
              sample: false,
            });
            setFeaturePlan(result.plan);
          } else
            setNotice({
              message: result?.message ?? '저장된 기능 목록을 불러오지 못했어요.',
              tone: 'warning',
            });
        }
      })
      .catch(() => {
        if (!disposed)
          setCatalog({
            projects: [],
            activeProjectId: null,
            storage: 'unavailable',
            message: '저장된 프로젝트를 조회하지 못했어요. 앱을 다시 실행해 주세요.',
          });
      })
      .finally(() => {
        if (!disposed) setStorageLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  async function reloadProjects() {
    if (!window.desktop) return;
    const saved = await window.desktop.listProjects();
    setCatalog(saved);
    return saved;
  }
  async function restoredProjects(saved: ProjectCatalog) {
    setCatalog(saved);
    const active = saved.projects.find((p) => p.id === saved.activeProjectId);
    if (active && window.desktop) {
      const loaded = await window.desktop.loadFeaturePlan(active.id);
      if (!loaded.ok) {
        setToast(loaded.message);
        return;
      }
      displayProject(
        { name: active.name, path: active.path, desktopId: active.id, sample: false },
        loaded.plan,
      );
    } else displayProject(null);
  }
  useEffect(() => {
    setAIStatus(emptyAISnapshot);
    if (!desktopProjectId || !window.desktop) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const snapshot = await window.desktop?.readAIStatus(desktopProjectId);
        if (!disposed && snapshot) setAIStatus(snapshot);
      } catch {
        /* The conversation window displays connection errors. */
      }
      if (!disposed) timer = setTimeout(poll, 800);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [desktopProjectId]);

  useEffect(() => {
    // Move keyboard focus with the page; keep the initial folder action unobscured.
    document
      .querySelector<HTMLElement>(`[data-page="${pageKey}"] h1`)
      ?.focus({ preventScroll: true });
    document.querySelector('.main-content')?.scrollTo({ top: 0 });
  }, [pageKey]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function addActivity(kind: EventKind, title: string, detail: string) {
    setActivities((items) =>
      [
        ...items,
        { id: crypto.randomUUID(), kind, title, detail, createdAt: new Date().toISOString() },
      ].slice(-100),
    );
  }
  function displayProject(value: Project | null, plan = emptyFeaturePlan()) {
    setShowAI(false);
    setProject(value);
    setPendingProject(null);
    setAnalysis(emptyAnalysis);
    setFeaturePlan(plan);
    setEditing(null);
    setOpenedFeature(null);
    setVerifyFeature(null);
    setDeleting(null);
    setActivities([]);
    setProtection(initialProtection);
    setProviders(['Codex']);
    setStep(0);
    setInWorkspace(false);
    setView('overview');
    if (value) addActivity('settings', '프로젝트 선택', `${value.name}의 화면 흐름을 시작했어요.`);
  }
  async function applyProject(value: Project) {
    if (projectSaving || planSaveLock.current) return;
    setProjectSaving(true);
    try {
      if (value.desktopId && window.desktop) {
        const result = await window.desktop.activateProject(value.desktopId);
        if (!result.ok) {
          setToast(result.message);
          return;
        }
        displayProject(
          {
            name: result.project.name,
            path: result.project.path,
            desktopId: result.project.id,
            sample: false,
          },
          result.plan,
        );
        await reloadProjects();
      } else displayProject(value);
    } catch {
      setToast('프로젝트 선택 결과를 확인하지 못했어요. 저장 목록을 다시 확인해 주세요.', 'error');
    } finally {
      setProjectSaving(false);
    }
  }
  async function startProject() {
    if (!project?.name.trim() || projectSaving) return;
    setProjectSaving(true);
    try {
      if (project.desktopId && window.desktop) {
        const result = await window.desktop.saveProjectName(project.desktopId, project.name);
        if (!result.ok) {
          setToast(result.message);
          return;
        }
        setProject({ ...project, name: result.project.name });
        await reloadProjects();
      }
      setStep(1);
    } catch {
      setToast('저장 결과를 확인하지 못했어요. 이름 입력은 유지했어요.', 'error');
    } finally {
      setProjectSaving(false);
    }
  }
  function chooseProject(value: Project) {
    if (planSaveLock.current) return;
    if (project?.path === value.path && project.sample === value.sample) return;
    if (project && (analysis.goal || features.length)) setPendingProject(value);
    else applyProject(value);
  }
  async function persistPlan(candidate: ProjectFeaturePlan) {
    if (planSaveLock.current) {
      setToast('기능 저장을 마친 뒤 다시 시도해 주세요.');
      return false;
    }
    if (!validateFeaturePlan(candidate)) {
      setToast('기능의 조건·경로·관계 또는 저장 한도를 확인해 주세요.');
      return false;
    }
    if (aiBusy) {
      setToast('AI 실행을 중단하고 정리가 끝난 뒤 기능을 변경해 주세요.');
      return false;
    }
    if (!project?.desktopId || !window.desktop) {
      setFeaturePlan(candidate);
      return true;
    }
    planSaveLock.current = true;
    setPlanSaving(true);
    try {
      const saved = await window.desktop.saveFeaturePlan(project.desktopId, candidate);
      if (!saved.ok) {
        setToast(saved.message);
        return false;
      }
      setFeaturePlan(saved.plan);
      return true;
    } catch {
      setToast('저장 결과를 확인하지 못했어요. 다시 조회해 주세요.', 'error');
      return false;
    } finally {
      planSaveLock.current = false;
      setPlanSaving(false);
    }
  }
  async function generateDrafts() {
    if (!analysis.goal.trim() || !analysis.audience) return;
    const next = makeDrafts(analysis.goal, analysis.scope).map((feature) => ({
      ...feature,
      id: crypto.randomUUID(),
    }));
    if (!(await persistPlan({ features: next, dependencies: [], verifications: [] }))) return;
    setShowRegenerate(false);
    setStep(3);
  }
  function addFeature(kind: 'leaf' | 'group' = 'leaf', parentId: string | null = null) {
    if (planSaveLock.current) return;
    if (features.length >= 100) {
      setToast('기능과 묶음은 합쳐서 100개까지 저장할 수 있어요.');
      return;
    }
    setEditing({
      id: crypto.randomUUID(),
      title: '',
      description: '',
      criteria: '',
      revision: 1,
      included: true,
      kind,
      parentId,
      order: 0,
    });
  }
  async function saveFeature(value: Feature, prerequisiteIds: string[]) {
    const old = features.find((item) => item.id === value.id);
    let updated: ProjectFeaturePlan;
    try {
      updated = updatePlanFeature(featurePlan, value, prerequisiteIds);
    } catch (error) {
      setToast(error instanceof Error ? error.message : '기능을 확인해 주세요.');
      return;
    }
    if (!(await persistPlan(updated))) return;
    setEditing(null);
    addActivity('feature', old ? '기능 내용 수정' : '새 기능 추가', value.title);
    setToast(
      project?.desktopId ? '기능과 완료 조건을 저장했어요.' : '이 창에 기능을 저장했어요.',
      'success',
    );
  }
  async function toggleFeature(id: string) {
    if (planSaveLock.current) return;
    const updated = features.map((item) =>
      item.id === id ? { ...item, included: !item.included } : item,
    );
    await persistPlan({ ...featurePlan, features: updated });
  }
  function openEditor(feature: Feature) {
    if (!planSaveLock.current) setEditing(feature);
  }
  async function deleteFeature() {
    if (!deleting || !(await persistPlan(removePlanFeature(featurePlan, deleting.id)))) return;
    addActivity('feature', '기능 삭제', deleting.title);
    setDeleting(null);
    setOpenedFeature(null);
  }
  function navigate(next: View) {
    setView(next);
    setMobileMenu(false);
  }
  async function recordVerification(
    value: Omit<Verification, 'id' | 'createdAt' | 'featureTitle'>,
  ) {
    const feature = features.find((item) => item.id === value.featureId);
    if (
      !feature?.included ||
      feature.revision !== value.revision ||
      !canRecordVerification(feature, value)
    ) {
      setToast('기능이 바뀌어 검증 결과를 저장하지 못했어요. 현재 기능을 다시 확인해 주세요.');
      return;
    }
    const updated = [
      ...records,
      {
        ...value,
        featureTitle: feature.title,
        id: crypto.randomUUID(),
        createdAt: nextVerificationTime(records),
      },
    ];
    if (!(await persistPlan({ ...featurePlan, verifications: updated }))) return;
    setVerifyFeature(null);
    addActivity(
      'verification',
      value.result === 'passed' ? '검증 통과 기록' : '수정 필요 기록',
      feature.title,
    );
    setToast(
      project?.desktopId ? '검증 결과를 저장했어요.' : '이 창에 검증 결과를 저장했어요.',
      'success',
    );
  }

  return (
    <div className={`app-shell ${mobileMenu ? 'menu-open' : ''}`}>
      <a className="skip-link" href="#main">
        본문으로 건너뛰기
      </a>
      {mobileMenu && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="메뉴 닫기"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className="sidebar" aria-label="주 메뉴">
        <div className="brand-area">
          <Brand />
          <span className="brand-caption">PROJECT WORKSPACE</span>
        </div>
        {inWorkspace && project ? (
          <>
            <button
              type="button"
              className="project-switcher"
              disabled={planSaving}
              onClick={() => setShowProjectSwitch(true)}
            >
              <span className="project-avatar">{project.name.charAt(0)}</span>
              <span>
                <strong>{project.name}</strong>
                <small>개인 프로젝트</small>
              </span>
              <Icon name="down" size={16} />
            </button>
            <span className="nav-label">워크스페이스</span>
            <nav className="workspace-nav">
              {navigation.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => navigate(item.id)}
                  className={view === item.id ? 'active' : ''}
                  aria-current={view === item.id ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={19} />
                  <span>{item.label}</span>
                  {item.id === 'verification' && records.length > 0 && (
                    <span className="nav-count">{records.length}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-connection">
              <span className="status-dot" />
              <span>{connectionSummary}</span>
            </div>
          </>
        ) : (
          <>
            <span className="nav-label">프로젝트 시작하기</span>
            <nav className="setup-nav" aria-label="시작 단계">
              {steps.map((label, index) => (
                <button
                  type="button"
                  key={label}
                  className={`${index === step ? 'active' : ''} ${index < step ? 'completed' : ''}`}
                  disabled={index > step}
                  aria-current={index === step ? 'step' : undefined}
                  onClick={() => {
                    setStep(index as Step);
                    setMobileMenu(false);
                  }}
                >
                  <span className="step-number">
                    {index < step ? (
                      <Icon name="check" size={14} />
                    ) : (
                      String(index + 1).padStart(2, '0')
                    )}
                  </span>
                  <span>{label}</span>
                  {index === step && <span className="step-current" />}
                </button>
              ))}
            </nav>
            <div className="setup-destination">
              <Icon name="grid" size={17} />
              <span>준비가 끝나면 작업 대시보드로</span>
            </div>
            <div className="sidebar-tip">
              <span className="tip-line" />
              <p>
                아이디어에 집중하세요.
                <br />
                다음 단계는 함께 정리할게요.
              </p>
            </div>
          </>
        )}
        <div className="sidebar-footer">
          <button
            type="button"
            onClick={() => {
              setShowHelp(true);
              setMobileMenu(false);
            }}
          >
            <Icon name="help" size={18} />
            <span>이 화면 사용 안내</span>
          </button>
          <div className="workspace-identity">
            <span className="identity-avatar">나</span>
            <div>
              <strong>개인 워크스페이스</strong>
              <span>졸업작품 프로토타입</span>
            </div>
            <span className="version-label">v0.1</span>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <button
            type="button"
            className="icon-button mobile-menu-button"
            aria-label="메뉴 열기"
            aria-expanded={mobileMenu}
            onClick={() => setMobileMenu(!mobileMenu)}
          >
            <Icon name="menu" />
          </button>
          <div className="breadcrumbs">
            <span>{inWorkspace ? project?.name : '새 프로젝트'}</span>
            <Icon name="chevron" size={13} />
            <strong>
              {inWorkspace ? navigation.find((item) => item.id === view)?.label : steps[step]}
            </strong>
          </div>
          <div className="topbar-right">
            {project?.desktopId && providers.includes('Codex') && (
              <Button variant="ghost" onClick={() => setShowAI(true)} icon="code">
                AI 대화
              </Button>
            )}
            <Badge>화면 프로토타입</Badge>
            <button
              type="button"
              className="icon-button"
              aria-label="프로토타입 안내"
              onClick={() => setShowHelp(true)}
            >
              <Icon name="help" size={19} />
            </button>
          </div>
        </header>
        <main id="main" className="main-content">
          <div
            data-page={pageKey}
            className={`page-container ${inWorkspace ? 'dashboard-container' : ''}`}
          >
            {!inWorkspace && (
              <div className="page-progress">
                <span>프로젝트 준비</span>
                <span>
                  <strong>{step + 1}</strong> / 4
                </span>
                <div className="step-dashes" aria-hidden="true">
                  {steps.map((label, index) => (
                    <i key={label} className={index <= step ? 'filled' : ''} />
                  ))}
                </div>
              </div>
            )}
            {!inWorkspace && step === 0 && (
              <ProjectPage
                project={project}
                catalog={catalog}
                loading={storageLoading || projectSaving || planSaving}
                onRestored={restoredProjects}
                onSelect={chooseProject}
                onName={(name) => setProject((value) => (value ? { ...value, name } : value))}
                onNext={startProject}
              />
            )}
            {!inWorkspace && step === 1 && (
              <>
                {
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setInWorkspace(true);
                      setView('features');
                    }}
                  >
                    {features.length ? '저장한 기능 이어서 열기' : '기능 직접 정리하기'}
                  </Button>
                }
                <ConnectionPage
                  connectionSummary={connectionSummary}
                  actualProject={Boolean(project?.desktopId)}
                  onOpenAI={() => setShowAI(true)}
                  providers={providers}
                  onToggleProvider={(provider) => {
                    setProviders((selected) =>
                      selected.includes(provider)
                        ? selected.filter((item) => item !== provider)
                        : [...selected, provider],
                    );
                  }}
                  protection={protection}
                  onProtection={(draft) => {
                    setProtection(draft);
                    addActivity(
                      'settings',
                      '보호 설정안 저장',
                      '실제 보호 적용 전의 설정안을 수정했어요.',
                    );
                  }}
                  onBack={() => setStep(0)}
                  onNext={() => {
                    if (providers.length === 0) return;
                    addActivity(
                      'settings',
                      'AI 도구 선택',
                      aiStatus.id
                        ? `선택한 AI: ${providers.join(', ')}. Codex 실행 상태: ${aiLabels[aiStatus.state]}.`
                        : `선택한 AI: ${providers.join(', ')}. 실제 연결은 아직 하지 않았어요.`,
                    );
                    setStep(2);
                  }}
                />
              </>
            )}
            {!inWorkspace && step === 2 && (
              <AnalysisPage
                value={analysis}
                onChange={setAnalysis}
                onBack={() => setStep(1)}
                onNext={() => {
                  if (features.length) setShowRegenerate(true);
                  else void generateDrafts();
                }}
              />
            )}
            {!inWorkspace && step === 3 && (
              <ConfirmPage
                features={features.filter((item) => item.kind === 'leaf')}
                busy={planSaving}
                onEdit={openEditor}
                onToggle={(id) => void toggleFeature(id)}
                onAdd={() => addFeature()}
                onBack={() => setStep(2)}
                onNext={() => {
                  if (includedFeatures.length) {
                    setInWorkspace(true);
                    setView('overview');
                    addActivity(
                      'feature',
                      '프로젝트 기능 확정',
                      `${includedFeatures.length}개 기능을 첫 버전의 범위로 정했어요.`,
                    );
                  }
                }}
              />
            )}
            {inWorkspace && project && view === 'overview' && (
              <OverviewPage
                project={project}
                features={includedFeatures}
                records={records}
                onOpen={(feature) => {
                  if (!planSaveLock.current) setOpenedFeature(feature.id);
                }}
                onVerification={() => navigate('verification')}
                onAdd={() => addFeature()}
              />
            )}
            {inWorkspace && project && view === 'features' && (
              <FeatureWorkspace
                key={project.desktopId ?? project.path}
                project={project}
                plan={featurePlan}
                busy={planSaving || aiBusy}
                onEdit={openEditor}
                onDelete={setDeleting}
                onAdd={addFeature}
                onLink={(feature, path) =>
                  void saveFeature(
                    { ...feature, relatedPaths: [...(feature.relatedPaths ?? []), path] },
                    featurePlan.dependencies
                      .filter((edge) => edge.featureId === feature.id)
                      .map((edge) => edge.prerequisiteId),
                  )
                }
              />
            )}
            {inWorkspace && view === 'verification' && (
              <VerificationPage
                features={features}
                records={records}
                persisted={Boolean(project?.desktopId)}
                onRecord={() => setVerifyFeature('')}
              />
            )}
            {inWorkspace && view === 'protection' && (
              <ProtectionPage
                draft={protection}
                providers={providers}
                onSave={(draft) => {
                  setProtection(draft);
                  addActivity(
                    'settings',
                    '보호 설정안 수정',
                    `${draft.paths.length}개 경로를 지정했어요. 실제 보호는 적용 전이에요.`,
                  );
                }}
              />
            )}
            {inWorkspace && view === 'transfer' && <TransferPage />}
            {inWorkspace && view === 'history' && <HistoryPage activities={activities} />}
            <footer className="page-bottom">
              <span>
                <span className="tiny-logo">ORBIT</span>차근차근, 만드는 즐거움
              </span>
              <span>
                {project?.desktopId
                  ? '기능·완료 조건·검증 결과는 프로젝트에 저장됩니다'
                  : '예시 프로젝트의 내용은 이 창에서만 유지됩니다'}
              </span>
            </footer>
          </div>
        </main>
      </div>
      {toast && (
        <div
          className={`toast toast--${toast.tone}`}
          data-tone={toast.tone}
          role="status"
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
        >
          <Icon
            name={
              toast.tone === 'success' ? 'check' : toast.tone === 'warning' ? 'warning' : 'error'
            }
            size={19}
          />
          <span className="sr-only">
            {toast.tone === 'success' ? '성공: ' : toast.tone === 'warning' ? '주의: ' : '오류: '}
          </span>
          {toast.message}
        </div>
      )}
      {showAI && project && (
        <Suspense fallback={<span role="status">AI 대화 화면을 여는 중이에요.</span>}>
          <AIConsole project={project} onClose={() => setShowAI(false)} />
        </Suspense>
      )}
      {editing && (
        <FeatureEditor
          key={editing.id}
          feature={editing}
          plan={featurePlan}
          busy={planSaving}
          onClose={() => {
            if (!planSaveLock.current) setEditing(null);
          }}
          onSave={saveFeature}
        />
      )}
      {currentFeature && (
        <WorkDetails
          feature={currentFeature}
          onClose={() => setOpenedFeature(null)}
          onEdit={() => {
            if (planSaveLock.current) return;
            openEditor(currentFeature);
            setOpenedFeature(null);
          }}
          onVerify={() => {
            setVerifyFeature(currentFeature.id);
            setOpenedFeature(null);
          }}
        />
      )}
      {verifyFeature !== null && (
        <VerificationEditor
          features={includedFeatures}
          initialId={verifyFeature || undefined}
          busy={planSaving}
          onSave={recordVerification}
          onClose={() => {
            if (!planSaveLock.current) setVerifyFeature(null);
          }}
        />
      )}
      {showRegenerate && (
        <Modal
          title="저장한 기능 초안이 있어요"
          busy={planSaving}
          onClose={() => {
            if (!planSaveLock.current) setShowRegenerate(false);
          }}
        >
          <p className="dialog-copy">
            직접 수정한 내용을 유지하거나, 현재 요구분석으로 새 예시 초안을 만들 수 있어요. 새로
            만들면 기존 기능·묶음·선행 관계와 검증 기록을 삭제하고 새 초안으로 대체해요.
          </p>
          <div className="modal-actions">
            <Button variant="secondary" disabled={planSaving} onClick={generateDrafts}>
              새 초안으로 바꾸기
            </Button>
            <Button
              disabled={planSaving}
              onClick={() => {
                setShowRegenerate(false);
                setStep(3);
              }}
            >
              기존 초안 유지
            </Button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="기능을 삭제할까요?"
          busy={planSaving}
          onClose={() => {
            if (!planSaveLock.current) setDeleting(null);
          }}
        >
          <p className="dialog-copy">
            <strong>{deleting.title}</strong>과 하위 항목을 포함한{' '}
            {descendantIds(featurePlan, deleting.id).size}개 항목, 연결된 선행 관계와 검증 기록을
            함께 삭제해요. 이 기능을 선행 조건으로 쓰던 기능은 재검증해야 해요. 실제 파일은 그대로
            남아요.
          </p>
          {aiBusy && <p role="status">AI 실행을 중단하고 정리가 끝난 뒤 삭제해 주세요.</p>}
          <div className="modal-actions">
            <Button variant="ghost" disabled={planSaving} onClick={() => setDeleting(null)}>
              삭제 취소
            </Button>
            <Button disabled={planSaving || aiBusy} onClick={() => void deleteFeature()}>
              삭제 확정
            </Button>
          </div>
        </Modal>
      )}
      {pendingProject && (
        <Modal
          title="프로젝트를 바꿀까요?"
          busy={projectSaving}
          onClose={() => setPendingProject(null)}
        >
          <p className="dialog-copy">
            현재 창의 요구분석 입력을 정리하고 <strong>{pendingProject.name}</strong>을 엽니다.
            기능·완료 조건·검증 기록은 각 프로젝트에 저장돼 다시 선택하면 불러와요.
          </p>
          <div className="modal-actions">
            <Button
              variant="ghost"
              disabled={projectSaving}
              onClick={() => setPendingProject(null)}
            >
              현재 프로젝트 유지
            </Button>
            <Button disabled={projectSaving} onClick={() => applyProject(pendingProject)}>
              프로젝트 바꾸기
            </Button>
          </div>
        </Modal>
      )}
      {showProjectSwitch && (
        <Modal title="프로젝트 선택으로 이동" onClose={() => setShowProjectSwitch(false)}>
          <p className="dialog-copy">
            현재 프로젝트는 그대로 유지돼요. 다른 폴더를 선택하면 새 프로젝트로 바꾸기 전에 다시
            안내해요.
          </p>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setShowProjectSwitch(false)}>
              대시보드에 머물기
            </Button>
            <Button
              onClick={() => {
                setShowProjectSwitch(false);
                setInWorkspace(false);
                setStep(0);
                setMobileMenu(false);
              }}
            >
              프로젝트 선택으로
            </Button>
          </div>
        </Modal>
      )}
      {showHelp && (
        <Modal title="ORBIT에서 프로젝트 시작하기" onClose={() => setShowHelp(false)}>
          <p className="dialog-copy">
            프로젝트 폴더를 정하고, 함께할 AI를 선택한 뒤, 아이디어를 작은 기능으로 나누어 보세요.
          </p>
          <ol className="help-steps">
            {[...steps, '작업 대시보드에서 기능 확인·검증'].map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ol>
          <div className="help-note">
            <h3>현재 사용할 수 있는 것</h3>
            <p>
              데스크톱 폴더 선택, 화면 이동, 예시 요구분석, 기능 편집과 검증 기록을 사용할 수
              있어요.
            </p>
            <h3>아직 연결되지 않은 것</h3>
            <p>
              기능별 AI 실행, 파일 접근 차단, 기기 간 전송은 준비 중이에요. 실제 프로젝트의
              기능·검증은 저장되며, 예시 프로젝트와 요구분석 입력은 이 창에서만 유지돼요.
            </p>
          </div>
          <div className="modal-actions">
            <Button onClick={() => setShowHelp(false)}>프로젝트로 돌아가기</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
