import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace, Issue, Project, ProjectWorkspace } from "@paperclipai/shared";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CopyText } from "../components/CopyText";
import { ExecutionWorkspaceCloseDialog } from "../components/ExecutionWorkspaceCloseDialog";
import { agentsApi } from "../api/agents";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { IssuesList } from "../components/IssuesList";
import { PageTabBar } from "../components/PageTabBar";
import {
  buildWorkspaceRuntimeControlSections,
  WorkspaceRuntimeControls,
  type WorkspaceRuntimeControlRequest,
} from "../components/WorkspaceRuntimeControls";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useT } from "../i18n/hooks/useT";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, issueUrl, projectRouteRef, projectWorkspaceUrl } from "../lib/utils";

type WorkspaceFormState = {
  name: string;
  cwd: string;
  repoUrl: string;
  baseRef: string;
  branchName: string;
  providerRef: string;
  provisionCommand: string;
  teardownCommand: string;
  cleanupCommand: string;
  inheritRuntime: boolean;
  workspaceRuntime: string;
};

type ExecutionWorkspaceTab = "configuration" | "runtime_logs" | "issues";

function resolveExecutionWorkspaceTab(pathname: string, workspaceId: string): ExecutionWorkspaceTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const executionWorkspacesIndex = segments.indexOf("execution-workspaces");
  if (executionWorkspacesIndex === -1 || segments[executionWorkspacesIndex + 1] !== workspaceId) return null;
  const tab = segments[executionWorkspacesIndex + 2];
  if (tab === "issues") return "issues";
  if (tab === "runtime-logs") return "runtime_logs";
  if (tab === "configuration") return "configuration";
  return null;
}

function executionWorkspaceTabPath(workspaceId: string, tab: ExecutionWorkspaceTab) {
  const segment = tab === "runtime_logs" ? "runtime-logs" : tab;
  return `/execution-workspaces/${workspaceId}/${segment}`;
}

function isSafeExternalUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function readText(value: string | null | undefined) {
  return value ?? "";
}

function formatJson(value: Record<string, unknown> | null | undefined) {
  if (!value || Object.keys(value).length === 0) return "";
  return JSON.stringify(value, null, 2);
}

function normalizeText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseWorkspaceRuntimeJson(value: string, t?: (key: string) => string) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true as const, value: null as Record<string, unknown> | null };

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false as const,
        error: t ? t("executionWorkspaceDetail.runtimeCommandsJsonMustBeObject") : "Workspace commands JSON must be a JSON object.",
      };
    }
    return { ok: true as const, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : (t ? t("executionWorkspaceDetail.invalidJson") : "Invalid JSON."),
    };
  }
}

function formStateFromWorkspace(workspace: ExecutionWorkspace): WorkspaceFormState {
  return {
    name: workspace.name,
    cwd: readText(workspace.cwd),
    repoUrl: readText(workspace.repoUrl),
    baseRef: readText(workspace.baseRef),
    branchName: readText(workspace.branchName),
    providerRef: readText(workspace.providerRef),
    provisionCommand: readText(workspace.config?.provisionCommand),
    teardownCommand: readText(workspace.config?.teardownCommand),
    cleanupCommand: readText(workspace.config?.cleanupCommand),
    inheritRuntime: !workspace.config?.workspaceRuntime,
    workspaceRuntime: formatJson(workspace.config?.workspaceRuntime),
  };
}

function buildWorkspacePatch(initialState: WorkspaceFormState, nextState: WorkspaceFormState, t?: (key: string) => string) {
  const patch: Record<string, unknown> = {};
  const configPatch: Record<string, unknown> = {};

  const maybeAssign = (
    key: keyof Pick<WorkspaceFormState, "name" | "cwd" | "repoUrl" | "baseRef" | "branchName" | "providerRef">,
  ) => {
    if (initialState[key] === nextState[key]) return;
    patch[key] = key === "name" ? (normalizeText(nextState[key]) ?? initialState.name) : normalizeText(nextState[key]);
  };

  maybeAssign("name");
  maybeAssign("cwd");
  maybeAssign("repoUrl");
  maybeAssign("baseRef");
  maybeAssign("branchName");
  maybeAssign("providerRef");

  const maybeAssignConfigText = (key: keyof Pick<WorkspaceFormState, "provisionCommand" | "teardownCommand" | "cleanupCommand">) => {
    if (initialState[key] === nextState[key]) return;
    configPatch[key] = normalizeText(nextState[key]);
  };

  maybeAssignConfigText("provisionCommand");
  maybeAssignConfigText("teardownCommand");
  maybeAssignConfigText("cleanupCommand");

  if (initialState.inheritRuntime !== nextState.inheritRuntime || initialState.workspaceRuntime !== nextState.workspaceRuntime) {
    if (nextState.inheritRuntime) {
      configPatch.workspaceRuntime = null;
    } else {
      const parsed = parseWorkspaceRuntimeJson(nextState.workspaceRuntime, t);
      if (!parsed.ok) throw new Error(parsed.error);
      configPatch.workspaceRuntime = parsed.value;
    }
  }

  if (Object.keys(configPatch).length > 0) {
    patch.config = configPatch;
  }

  return patch;
}

function validateForm(form: WorkspaceFormState, t?: (key: string) => string) {
  const repoUrl = normalizeText(form.repoUrl);
  if (repoUrl) {
    try {
      new URL(repoUrl);
    } catch {
      return t ? t("executionWorkspaceDetail.repoUrlMustBeValid") : "Repo URL must be a valid URL.";
    }
  }

  if (!form.inheritRuntime) {
    const runtimeJson = parseWorkspaceRuntimeJson(form.workspaceRuntime, t);
    if (!runtimeJson.ok) {
      return runtimeJson.error;
    }
  }

  return null;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground sm:text-right">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 py-1.5 sm:flex-row sm:items-start sm:gap-3">
      <div className="shrink-0 text-xs text-muted-foreground sm:w-32">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

function StatusPill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground", className)}>
      {children}
    </div>
  );
}

function MonoValue({ value, copy }: { value: string; copy?: boolean }) {
  const { t } = useTranslation("core");
  return (
    <div className="inline-flex max-w-full items-start gap-2">
      <span className="break-all font-mono text-xs">{value}</span>
      {copy ? (
        <CopyText text={value} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel={t("executionWorkspaceDetail.copiedLabel")}>
          <Copy className="h-3.5 w-3.5" />
        </CopyText>
      ) : null}
    </div>
  );
}

function WorkspaceLink({
  project,
  workspace,
}: {
  project: Project;
  workspace: ProjectWorkspace;
}) {
  return <Link to={projectWorkspaceUrl(project, workspace.id)} className="hover:underline">{workspace.name}</Link>;
}

function ExecutionWorkspaceIssuesList({
  companyId,
  workspaceId,
  issues,
  isLoading,
  error,
  project,
}: {
  companyId: string;
  workspaceId: string;
  issues: Issue[];
  isLoading: boolean;
  error: Error | null;
  project: Project | null;
}) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByExecutionWorkspace(companyId, workspaceId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      if (project?.id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, project.id) });
      }
    },
  });

  const projectOptions = useMemo(
    () => (project ? [{ id: project.id, name: project.name, workspaces: project.workspaces ?? [] }] : undefined),
    [project],
  );

  return (
    <IssuesList
      issues={issues}
      isLoading={isLoading}
      error={error}
      agents={agents}
      projects={projectOptions}
      liveIssueIds={liveIssueIds}
      projectId={project?.id}
      viewStateKey="paperclip:execution-workspace-issues-view"
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

export function ExecutionWorkspaceDetail() {
  const { t } = useTranslation("core");
  const { t: tx } = useT("core");
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const [form, setForm] = useState<WorkspaceFormState | null>(null);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [runtimeActionErrorMessage, setRuntimeActionErrorMessage] = useState<string | null>(null);
  const [runtimeActionMessage, setRuntimeActionMessage] = useState<string | null>(null);
  const activeTab = workspaceId ? resolveExecutionWorkspaceTab(location.pathname, workspaceId) : null;

  const workspaceQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId!),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const workspace = workspaceQuery.data ?? null;

  const projectQuery = useQuery({
    queryKey: workspace ? [...queryKeys.projects.detail(workspace.projectId), workspace.companyId] : ["projects", "detail", "__pending__"],
    queryFn: () => projectsApi.get(workspace!.projectId, workspace!.companyId),
    enabled: Boolean(workspace?.projectId),
  });
  const project = projectQuery.data ?? null;

  const sourceIssueQuery = useQuery({
    queryKey: workspace?.sourceIssueId ? queryKeys.issues.detail(workspace.sourceIssueId) : ["issues", "detail", "__none__"],
    queryFn: () => issuesApi.get(workspace!.sourceIssueId!),
    enabled: Boolean(workspace?.sourceIssueId),
  });
  const sourceIssue = sourceIssueQuery.data ?? null;

  const derivedWorkspaceQuery = useQuery({
    queryKey: workspace?.derivedFromExecutionWorkspaceId
      ? queryKeys.executionWorkspaces.detail(workspace.derivedFromExecutionWorkspaceId)
      : ["execution-workspaces", "detail", "__none__"],
    queryFn: () => executionWorkspacesApi.get(workspace!.derivedFromExecutionWorkspaceId!),
    enabled: Boolean(workspace?.derivedFromExecutionWorkspaceId),
  });
  const derivedWorkspace = derivedWorkspaceQuery.data ?? null;
  const linkedIssuesQuery = useQuery({
    queryKey: workspace
      ? queryKeys.issues.listByExecutionWorkspace(workspace.companyId, workspace.id)
      : ["issues", "__execution-workspace__", "__none__"],
    queryFn: () => issuesApi.list(workspace!.companyId, { executionWorkspaceId: workspace!.id }),
    enabled: Boolean(workspace?.companyId),
  });
  const linkedIssues = linkedIssuesQuery.data ?? [];

  const linkedProjectWorkspace = useMemo(
    () => project?.workspaces.find((item) => item.id === workspace?.projectWorkspaceId) ?? null,
    [project, workspace?.projectWorkspaceId],
  );
  const inheritedRuntimeConfig = linkedProjectWorkspace?.runtimeConfig?.workspaceRuntime ?? null;
  const effectiveRuntimeConfig = workspace?.config?.workspaceRuntime ?? inheritedRuntimeConfig;
  const runtimeConfigSource =
    workspace?.config?.workspaceRuntime
      ? "execution_workspace"
      : inheritedRuntimeConfig
        ? "project_workspace"
        : "none";

  const initialState = useMemo(() => (workspace ? formStateFromWorkspace(workspace) : null), [workspace]);
  const isDirty = Boolean(form && initialState && JSON.stringify(form) !== JSON.stringify(initialState));
  const projectRef = project ? projectRouteRef(project) : workspace?.projectId ?? "";

  useEffect(() => {
    if (!workspace?.companyId || workspace.companyId === selectedCompanyId) return;
    setSelectedCompanyId(workspace.companyId, { source: "route_sync" });
  }, [workspace?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    if (!workspace) return;
    setForm(formStateFromWorkspace(workspace));
    setErrorMessage(null);
    setRuntimeActionErrorMessage(null);
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    const crumbs = [
      { label: t("projectDetail.projectsBreadcrumb"), href: "/projects" },
      ...(project ? [{ label: project.name, href: `/projects/${projectRef}` }] : []),
      ...(project ? [{ label: t("projectDetail.workspacesTab"), href: `/projects/${projectRef}/workspaces` }] : []),
      { label: workspace.name },
    ];
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, workspace, project, projectRef, t]);

  const updateWorkspace = useMutation({
    mutationFn: (patch: Record<string, unknown>) => executionWorkspacesApi.update(workspace!.id, patch),
    onSuccess: (nextWorkspace) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(nextWorkspace.id), nextWorkspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(nextWorkspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(nextWorkspace.id) });
      if (project) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
      }
      if (sourceIssue) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(sourceIssue.id) });
      }
      setErrorMessage(null);
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : t("executionWorkspaceDetail.failedToSave"));
    },
  });
  const workspaceOperationsQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.workspaceOperations(workspaceId!),
    queryFn: () => executionWorkspacesApi.listWorkspaceOperations(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const controlRuntimeServices = useMutation({
    mutationFn: (request: WorkspaceRuntimeControlRequest) =>
      executionWorkspacesApi.controlRuntimeCommands(workspace!.id, request.action, request),
    onSuccess: (result, request) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(result.workspace.id), result.workspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(result.workspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(result.workspace.projectId) });
      setRuntimeActionErrorMessage(null);
      setRuntimeActionMessage(
        request.action === "run"
          ? t("executionWorkspaceDetail.workspaceJobCompleted")
          : request.action === "stop"
            ? t("executionWorkspaceDetail.workspaceServiceStopped")
            : request.action === "restart"
              ? t("executionWorkspaceDetail.workspaceServiceRestarted")
              : t("executionWorkspaceDetail.workspaceServiceStarted"),
      );
    },
    onError: (error) => {
      setRuntimeActionMessage(null);
      setRuntimeActionErrorMessage(error instanceof Error ? error.message : t("executionWorkspaceDetail.failedToControl"));
    },
  });

  if (workspaceQuery.isLoading) return <p className="text-sm text-muted-foreground">{tx("executionWorkspaceDetail.loading")}</p>;
  if (workspaceQuery.error) {
    return (
      <p className="text-sm text-destructive">
        {workspaceQuery.error instanceof Error ? workspaceQuery.error.message : t("executionWorkspaceDetail.failedToLoad")}
      </p>
    );
  }
  if (!workspace || !form || !initialState) return null;

  const canRunWorkspaceCommands = Boolean(workspace.cwd);
  const canStartRuntimeServices = Boolean(effectiveRuntimeConfig) && canRunWorkspaceCommands;
  const runtimeControlSections = buildWorkspaceRuntimeControlSections({
    runtimeConfig: effectiveRuntimeConfig,
    runtimeServices: workspace.runtimeServices ?? [],
    canStartServices: canStartRuntimeServices,
    canRunJobs: canRunWorkspaceCommands,
    t,
  });
  const pendingRuntimeAction = controlRuntimeServices.isPending ? controlRuntimeServices.variables ?? null : null;

  if (workspaceId && activeTab === null) {
    let cachedTab: ExecutionWorkspaceTab = "configuration";
    try {
      const storedTab = localStorage.getItem(`paperclip:execution-workspace-tab:${workspaceId}`);
      if (storedTab === "issues" || storedTab === "configuration" || storedTab === "runtime_logs") {
        cachedTab = storedTab;
      }
    } catch {}
    return <Navigate to={executionWorkspaceTabPath(workspaceId, cachedTab)} replace />;
  }

  const handleTabChange = (tab: ExecutionWorkspaceTab) => {
    try {
      localStorage.setItem(`paperclip:execution-workspace-tab:${workspace.id}`, tab);
    } catch {}
    navigate(executionWorkspaceTabPath(workspace.id, tab));
  };

  const saveChanges = () => {
    const validationError = validateForm(form, t);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    let patch: Record<string, unknown>;
    try {
      patch = buildWorkspacePatch(initialState, form, t);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("executionWorkspaceDetail.failedToBuildUpdate"));
      return;
    }

    if (Object.keys(patch).length === 0) return;
    updateWorkspace.mutate(patch);
  };

  return (
    <>
      <div className="space-y-4 overflow-hidden sm:space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to={project ? `/projects/${projectRef}/workspaces` : "/projects"}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              {tx("executionWorkspaceDetail.backToWorkspaces")}
            </Link>
          </Button>
          <StatusPill>{workspace.mode}</StatusPill>
          <StatusPill>{workspace.providerType}</StatusPill>
          <StatusPill className={workspace.status === "active" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : undefined}>
            {workspace.status}
          </StatusPill>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {tx("executionWorkspaceDetail.executionWorkspaceLabel")}
          </div>
          <h1 className="truncate text-xl font-semibold sm:text-2xl">{workspace.name}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {tx("executionWorkspaceDetail.description")}
            <span className="hidden sm:inline"> {tx("executionWorkspaceDetail.descriptionExtended")}</span>
          </p>
        </div>

        <Card className="rounded-none">
          <CardHeader>
            <CardTitle>{tx("executionWorkspaceDetail.servicesAndJobs")}</CardTitle>
            <CardDescription>
              {tx("executionWorkspaceDetail.sourceLabel")}: {runtimeConfigSource === "execution_workspace"
                ? t("executionWorkspaceDetail.runtimeConfigSource.executionWorkspace")
                : runtimeConfigSource === "project_workspace"
                  ? t("executionWorkspaceDetail.runtimeConfigSource.projectWorkspace")
                  : t("executionWorkspaceDetail.runtimeConfigSource.none")}
            </CardDescription>
          </CardHeader>
          <CardContent>
          <WorkspaceRuntimeControls
            sections={runtimeControlSections}
            isPending={controlRuntimeServices.isPending}
            pendingRequest={pendingRuntimeAction}
            serviceEmptyMessage={
              effectiveRuntimeConfig
                ? t("executionWorkspaceDetail.noServicesStarted")
                : t("executionWorkspaceDetail.noRuntimeConfig")
            }
            jobEmptyMessage={t("executionWorkspaceDetail.noJobsConfigured")}
            disabledHint={
              canStartRuntimeServices
                ? null
                : t("executionWorkspaceDetail.disabledHint")
            }
            onAction={(request) => controlRuntimeServices.mutate(request)}
          />
          {runtimeActionErrorMessage ? <p className="mt-4 text-sm text-destructive">{runtimeActionErrorMessage}</p> : null}
          {!runtimeActionErrorMessage && runtimeActionMessage ? <p className="mt-4 text-sm text-muted-foreground">{runtimeActionMessage}</p> : null}
          </CardContent>
        </Card>

        <Tabs value={activeTab ?? "configuration"} onValueChange={(value) => handleTabChange(value as ExecutionWorkspaceTab)}>
          <PageTabBar
            items={[
              { value: "configuration", label: t("executionWorkspaceDetail.tabConfiguration") },
              { value: "runtime_logs", label: t("executionWorkspaceDetail.tabRuntimeLogs") },
              { value: "issues", label: t("executionWorkspaceDetail.tabIssues") },
            ]}
            align="start"
            value={activeTab ?? "configuration"}
            onValueChange={(value) => handleTabChange(value as ExecutionWorkspaceTab)}
          />
        </Tabs>

        {activeTab === "configuration" ? (
          <div className="space-y-4 sm:space-y-6">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>{tx("executionWorkspaceDetail.workspaceSettings")}</CardTitle>
                <CardDescription>
                  {tx("executionWorkspaceDetail.workspaceSettingsDescription")}
                </CardDescription>
                <CardAction>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full rounded-none sm:w-auto"
                    onClick={() => setCloseDialogOpen(true)}
                    disabled={workspace.status === "archived"}
                  >
                    {tx(workspace.status === "cleanup_failed" ? "executionWorkspaceDetail.retryClose" : "executionWorkspaceDetail.closeWorkspace")}
                  </Button>
                </CardAction>
              </CardHeader>

              <CardContent>

              <div className="space-y-6">
                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{tx("executionWorkspaceDetail.sectionGeneral")}</div>
                  <Field label={t("executionWorkspaceDetail.workspaceName")}>
                    <Input
                      value={form.name}
                      onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
                      placeholder={t("executionWorkspaceDetail.workspaceNamePlaceholder")}
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{tx("executionWorkspaceDetail.sectionSourceControl")}</div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("executionWorkspaceDetail.fieldBranchName")} hint={t("executionWorkspaceDetail.hintBranchName")}>
                      <Input
                        className="font-mono"
                        value={form.branchName}
                        onChange={(event) => setForm((current) => current ? { ...current, branchName: event.target.value } : current)}
                        placeholder={t("executionWorkspaceDetail.placeholderBranchName")}
                      />
                    </Field>

                    <Field label={t("executionWorkspaceDetail.fieldBaseRef")}>
                      <Input
                        className="font-mono"
                        value={form.baseRef}
                        onChange={(event) => setForm((current) => current ? { ...current, baseRef: event.target.value } : current)}
                        placeholder={t("executionWorkspaceDetail.placeholderBaseRef")}
                      />
                    </Field>
                  </div>

                  <Field label={t("executionWorkspaceDetail.fieldRepoUrl")}>
                    <Input
                      value={form.repoUrl}
                      onChange={(event) => setForm((current) => current ? { ...current, repoUrl: event.target.value } : current)}
                      placeholder={t("executionWorkspaceDetail.placeholderRepoUrl")}
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{tx("executionWorkspaceDetail.sectionPaths")}</div>
                  <Field label={t("executionWorkspaceDetail.fieldWorkingDirectory")}>
                    <Input
                      className="font-mono"
                      value={form.cwd}
                      onChange={(event) => setForm((current) => current ? { ...current, cwd: event.target.value } : current)}
                      placeholder={t("executionWorkspaceDetail.placeholderWorkingDirectory")}
                    />
                  </Field>

                  <Field label={t("executionWorkspaceDetail.fieldProviderPath")}>
                    <Input
                      className="font-mono"
                      value={form.providerRef}
                      onChange={(event) => setForm((current) => current ? { ...current, providerRef: event.target.value } : current)}
                      placeholder={t("executionWorkspaceDetail.placeholderProviderPath")}
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{tx("executionWorkspaceDetail.sectionLifecycleCommands")}</div>
                  <Field label={t("executionWorkspaceDetail.fieldProvisionCommand")} hint={t("executionWorkspaceDetail.hintProvisionCommand")}>
                    <Textarea
                      className="min-h-20 font-mono"
                      value={form.provisionCommand}
                      onChange={(event) => setForm((current) => current ? { ...current, provisionCommand: event.target.value } : current)}
                      placeholder={t("executionWorkspaceDetail.placeholderProvisionCommand")}
                    />
                  </Field>

                  <Field label={t("executionWorkspaceDetail.fieldTeardownCommand")} hint={t("executionWorkspaceDetail.hintTeardownCommand")}>
                    <Textarea
                      className="min-h-20 font-mono"
                      value={form.teardownCommand}
                      onChange={(event) => setForm((current) => current ? { ...current, teardownCommand: event.target.value } : current)}
                      placeholder={t("executionWorkspaceDetail.placeholderTeardownCommand")}
                    />
                  </Field>

                  <Field label={t("executionWorkspaceDetail.fieldCleanupCommand")} hint={t("executionWorkspaceDetail.hintCleanupCommand")}>
                    <Textarea
                      className="min-h-16 font-mono"
                      value={form.cleanupCommand}
                      onChange={(event) => setForm((current) => current ? { ...current, cleanupCommand: event.target.value } : current)}
                      placeholder={t("executionWorkspaceDetail.placeholderCleanupCommand")}
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{tx("executionWorkspaceDetail.sectionRuntimeConfig")}</div>
                  <div className="rounded-md border border-dashed border-border/70 bg-background px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <div className="text-sm font-medium text-foreground">
                          {tx("executionWorkspaceDetail.runtimeConfigSourceLabel")}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {runtimeConfigSource === "execution_workspace"
                            ? t("executionWorkspaceDetail.runtimeConfigSourceOverride")
                            : runtimeConfigSource === "project_workspace"
                              ? t("executionWorkspaceDetail.runtimeConfigSourceInherited")
                              : t("executionWorkspaceDetail.runtimeConfigSourceNone")}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        className="w-full sm:w-auto"
                        size="sm"
                        disabled={!linkedProjectWorkspace?.runtimeConfig?.workspaceRuntime}
                        onClick={() =>
                          setForm((current) => current ? {
                            ...current,
                            inheritRuntime: true,
                            workspaceRuntime: "",
                          } : current)
                        }
                      >
                        {tx("executionWorkspaceDetail.resetToInherit")}
                      </Button>
                    </div>
                  </div>

                  <details className="rounded-md border border-dashed border-border/70 bg-background px-4 py-3">
                    <summary className="cursor-pointer text-sm font-medium">{tx("executionWorkspaceDetail.advancedRuntimeJson")}</summary>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {tx("executionWorkspaceDetail.advancedRuntimeJsonDescription")}
                    </p>
                    <div className="mt-3">
                      <Field label={t("executionWorkspaceDetail.fieldWorkspaceCommandsJson")} hint={t("executionWorkspaceDetail.hintWorkspaceCommandsJson")}>
                        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                          <input
                            id="inherit-runtime-config"
                            type="checkbox"
                            className="rounded border-border"
                            checked={form.inheritRuntime}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setForm((current) => {
                                if (!current) return current;
                                if (!checked && !current.workspaceRuntime.trim() && inheritedRuntimeConfig) {
                                  return { ...current, inheritRuntime: checked, workspaceRuntime: formatJson(inheritedRuntimeConfig) };
                                }
                                return { ...current, inheritRuntime: checked };
                              });
                            }}
                          />
                          <label htmlFor="inherit-runtime-config">{tx("executionWorkspaceDetail.inheritRuntimeConfig")}</label>
                        </div>
                        <Textarea
                          className="min-h-64 font-mono sm:min-h-96"
                          value={form.workspaceRuntime}
                          onChange={(event) => setForm((current) => current ? { ...current, workspaceRuntime: event.target.value } : current)}
                          disabled={form.inheritRuntime}
                          placeholder={'{\n  "commands": [\n    {\n      "id": "web",\n      "name": "web",\n      "kind": "service",\n      "command": "pnpm dev",\n      "cwd": ".",\n      "port": { "type": "auto" }\n    },\n    {\n      "id": "db-migrate",\n      "name": "db:migrate",\n      "kind": "job",\n      "command": "pnpm db:migrate",\n      "cwd": "."\n    }\n  ]\n}'}
                        />
                      </Field>
                    </div>
                  </details>
                </div>
              </div>

              <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <Button className="w-full sm:w-auto" disabled={!isDirty || updateWorkspace.isPending} onClick={saveChanges}>
                  {updateWorkspace.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {tx("executionWorkspaceDetail.saveChanges")}
                </Button>
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={!isDirty || updateWorkspace.isPending}
                  onClick={() => {
                    setForm(initialState);
                    setErrorMessage(null);
                    setRuntimeActionErrorMessage(null);
                    setRuntimeActionMessage(null);
                  }}
                >
                  {tx("executionWorkspaceDetail.reset")}
                </Button>
                {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
                {!errorMessage && !isDirty ? <p className="text-sm text-muted-foreground">{tx("executionWorkspaceDetail.noUnsavedChanges")}</p> : null}
              </div>
              </CardContent>
            </Card>

            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>{tx("executionWorkspaceDetail.workspaceContext")}</CardTitle>
                <CardDescription>{tx("executionWorkspaceDetail.linkedObjectsDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
              <DetailRow label={t("executionWorkspaceDetail.detailProject")}>
                {project ? <Link to={`/projects/${projectRef}`} className="hover:underline">{project.name}</Link> : <MonoValue value={workspace.projectId} />}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailProjectWorkspace")}>
                {project && linkedProjectWorkspace ? (
                  <WorkspaceLink project={project} workspace={linkedProjectWorkspace} />
                ) : workspace.projectWorkspaceId ? (
                  <MonoValue value={workspace.projectWorkspaceId} />
                ) : (
                  t("executionWorkspaceDetail.noneLabel")
                )}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailSourceIssue")}>
                {sourceIssue ? (
                  <Link to={issueUrl(sourceIssue)} className="hover:underline">
                    {sourceIssue.identifier ?? sourceIssue.id} · {sourceIssue.title}
                  </Link>
                ) : workspace.sourceIssueId ? (
                  <MonoValue value={workspace.sourceIssueId} />
                ) : (
                  t("executionWorkspaceDetail.noneLabel")
                )}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailDerivedFrom")}>
                {derivedWorkspace ? (
                  <Link to={executionWorkspaceTabPath(derivedWorkspace.id, "configuration")} className="hover:underline">
                    {derivedWorkspace.name}
                  </Link>
                ) : workspace.derivedFromExecutionWorkspaceId ? (
                  <MonoValue value={workspace.derivedFromExecutionWorkspaceId} />
                ) : (
                  t("executionWorkspaceDetail.noneLabel")
                )}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailWorkspaceId")}>
                <MonoValue value={workspace.id} />
              </DetailRow>
              </CardContent>
            </Card>

            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>{tx("executionWorkspaceDetail.concreteLocation")}</CardTitle>
                <CardDescription>{tx("executionWorkspaceDetail.pathsAndRefsDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
              <DetailRow label={t("executionWorkspaceDetail.detailWorkingDir")}>
                {workspace.cwd ? <MonoValue value={workspace.cwd} copy /> : t("executionWorkspaceDetail.noneLabel")}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailProviderRef")}>
                {workspace.providerRef ? <MonoValue value={workspace.providerRef} copy /> : t("executionWorkspaceDetail.noneLabel")}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailRepoUrl")}>
                {workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? (
                  <div className="inline-flex max-w-full items-start gap-2">
                    <a href={workspace.repoUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 break-all hover:underline">
                      {workspace.repoUrl}
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                    <CopyText text={workspace.repoUrl} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel={t("executionWorkspaceDetail.copiedLabel")}>
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </div>
                ) : workspace.repoUrl ? (
                  <MonoValue value={workspace.repoUrl} copy />
                ) : (
                  t("executionWorkspaceDetail.noneLabel")
                )}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailBaseRef")}>
                {workspace.baseRef ? <MonoValue value={workspace.baseRef} copy /> : t("executionWorkspaceDetail.noneLabel")}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailBranch")}>
                {workspace.branchName ? <MonoValue value={workspace.branchName} copy /> : t("executionWorkspaceDetail.noneLabel")}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailOpened")}>{formatDateTime(workspace.openedAt)}</DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailLastUsed")}>{formatDateTime(workspace.lastUsedAt)}</DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.detailCleanup")}>
                {workspace.cleanupEligibleAt
                  ? `${formatDateTime(workspace.cleanupEligibleAt)}${workspace.cleanupReason ? ` · ${workspace.cleanupReason}` : ""}`
                  : t("executionWorkspaceDetail.notScheduled")}
              </DetailRow>
              </CardContent>
            </Card>
          </div>
        ) : activeTab === "runtime_logs" ? (
          <Card className="rounded-none">
            <CardHeader>
              <CardTitle>{tx("executionWorkspaceDetail.runtimeAndCleanupLogs")}</CardTitle>
              <CardDescription>{tx("executionWorkspaceDetail.recentOperationsDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
            {workspaceOperationsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">{tx("executionWorkspaceDetail.loadingOperations")}</p>
            ) : workspaceOperationsQuery.error ? (
              <p className="text-sm text-destructive">
                {workspaceOperationsQuery.error instanceof Error
                  ? workspaceOperationsQuery.error.message
                  : t("executionWorkspaceDetail.failedToLoadOperations")}
              </p>
            ) : workspaceOperationsQuery.data && workspaceOperationsQuery.data.length > 0 ? (
              <div className="space-y-3">
                {workspaceOperationsQuery.data.map((operation) => (
                  <div key={operation.id} className="rounded-none border border-border/80 bg-background px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">{operation.command ?? operation.phase}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatDateTime(operation.startedAt)}
                          {operation.finishedAt ? ` → ${formatDateTime(operation.finishedAt)}` : ""}
                        </div>
                        {operation.stderrExcerpt ? (
                          <div className="whitespace-pre-wrap break-words text-xs text-destructive">{operation.stderrExcerpt}</div>
                        ) : operation.stdoutExcerpt ? (
                          <div className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{operation.stdoutExcerpt}</div>
                        ) : null}
                      </div>
                      <StatusPill className="self-start">{operation.status}</StatusPill>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{tx("executionWorkspaceDetail.noOperationsRecorded")}</p>
            )}
            </CardContent>
          </Card>
        ) : (
          <ExecutionWorkspaceIssuesList
            companyId={workspace.companyId}
            workspaceId={workspace.id}
            issues={linkedIssues}
            isLoading={linkedIssuesQuery.isLoading}
            error={linkedIssuesQuery.error as Error | null}
            project={project}
          />
        )}
      </div>
      <ExecutionWorkspaceCloseDialog
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        currentStatus={workspace.status}
        open={closeDialogOpen}
        onOpenChange={setCloseDialogOpen}
        onClosed={(nextWorkspace) => {
          queryClient.setQueryData(queryKeys.executionWorkspaces.detail(nextWorkspace.id), nextWorkspace);
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(nextWorkspace.id) });
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(nextWorkspace.id) });
          if (project) {
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(project.companyId, { projectId: project.id }) });
          }
          if (sourceIssue) {
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(sourceIssue.id) });
          }
        }}
      />
    </>
  );
}
