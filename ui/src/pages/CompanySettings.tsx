import { ChangeEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_ADAPTER_TYPES,
  getAdapterEnvironmentSupport,
  type Environment,
  type EnvironmentProbeResult,
  type JsonSchema,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Settings, Check, Download, Upload } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { JsonSchemaForm, getDefaultValues, validateJsonSchemaForm } from "@/components/JsonSchemaForm";
import {
  Field,
  ToggleField,
  HintIcon,
  adapterLabels,
} from "../components/agent-config-primitives";
import { useTranslation } from "react-i18next";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

type EnvironmentFormState = {
  name: string;
  description: string;
  driver: "local" | "ssh" | "sandbox";
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshRemoteWorkspacePath: string;
  sshPrivateKey: string;
  sshPrivateKeySecretId: string;
  sshKnownHosts: string;
  sshStrictHostKeyChecking: boolean;
  sandboxProvider: string;
  sandboxConfig: Record<string, unknown>;
};

const ENVIRONMENT_SUPPORT_ROWS = AGENT_ADAPTER_TYPES.map((adapterType) => ({
  adapterType,
  support: getAdapterEnvironmentSupport(adapterType),
}));

function buildEnvironmentPayload(form: EnvironmentFormState) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    driver: form.driver,
    config:
      form.driver === "ssh"
        ? {
            host: form.sshHost.trim(),
            port: Number.parseInt(form.sshPort || "22", 10) || 22,
            username: form.sshUsername.trim(),
            remoteWorkspacePath: form.sshRemoteWorkspacePath.trim(),
            privateKey: form.sshPrivateKey.trim() || null,
            privateKeySecretRef:
              form.sshPrivateKey.trim().length > 0 || !form.sshPrivateKeySecretId
                ? null
                : { type: "secret_ref" as const, secretId: form.sshPrivateKeySecretId, version: "latest" as const },
            knownHosts: form.sshKnownHosts.trim() || null,
            strictHostKeyChecking: form.sshStrictHostKeyChecking,
          }
        : form.driver === "sandbox"
          ? {
              provider: form.sandboxProvider.trim(),
              ...form.sandboxConfig,
            }
          : {},
  } as const;
}

function createEmptyEnvironmentForm(): EnvironmentFormState {
  return {
    name: "",
    description: "",
    driver: "ssh",
    sshHost: "",
    sshPort: "22",
    sshUsername: "",
    sshRemoteWorkspacePath: "",
    sshPrivateKey: "",
    sshPrivateKeySecretId: "",
    sshKnownHosts: "",
    sshStrictHostKeyChecking: true,
    sandboxProvider: "",
    sandboxConfig: {},
  };
}

function readSshConfig(environment: Environment) {
  const config = environment.config ?? {};
  return {
    host: typeof config.host === "string" ? config.host : "",
    port:
      typeof config.port === "number"
        ? String(config.port)
        : typeof config.port === "string"
          ? config.port
          : "22",
    username: typeof config.username === "string" ? config.username : "",
    remoteWorkspacePath:
      typeof config.remoteWorkspacePath === "string" ? config.remoteWorkspacePath : "",
    privateKey: "",
    privateKeySecretId:
      config.privateKeySecretRef &&
      typeof config.privateKeySecretRef === "object" &&
      !Array.isArray(config.privateKeySecretRef) &&
      typeof (config.privateKeySecretRef as { secretId?: unknown }).secretId === "string"
        ? String((config.privateKeySecretRef as { secretId: string }).secretId)
        : "",
    knownHosts: typeof config.knownHosts === "string" ? config.knownHosts : "",
    strictHostKeyChecking:
      typeof config.strictHostKeyChecking === "boolean"
        ? config.strictHostKeyChecking
        : true,
  };
}

function readSandboxConfig(environment: Environment) {
  const config = environment.config ?? {};
  const { provider: rawProvider, ...providerConfig } = config;
  return {
    provider: typeof rawProvider === "string" && rawProvider.trim().length > 0
      ? rawProvider
        : "fake",
    config: providerConfig,
  };
}

function normalizeJsonSchema(schema: unknown): JsonSchema | null {
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as JsonSchema
    : null;
}

function summarizeSandboxConfig(config: Record<string, unknown>): string | null {
  for (const key of ["template", "image", "region", "workspacePath"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function SupportMark({ supported }: { supported: boolean }) {
  const { t } = useTranslation();
  return supported ? (
    <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
      <Check className="h-3 w-3" />
      {t("companySettings.environment.support.yes", { defaultValue: "Yes" })}
    </span>
  ) : (
    <span className="text-muted-foreground">{t("companySettings.environment.support.no", { defaultValue: "No" })}</span>
  );
}

export function CompanySettings() {
  const { t } = useTranslation();
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [editingEnvironmentId, setEditingEnvironmentId] = useState<string | null>(null);
  const [environmentForm, setEnvironmentForm] = useState<EnvironmentFormState>(createEmptyEnvironmentForm);
  const [probeResults, setProbeResults] = useState<Record<string, EnvironmentProbeResult | null>>({});

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;

  const { data: environments } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.environments.list(selectedCompanyId) : ["environments", "none"],
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && environmentsEnabled,
  });
  const { data: environmentCapabilities } = useQuery({
    queryKey: selectedCompanyId ? ["environment-capabilities", selectedCompanyId] : ["environment-capabilities", "none"],
    queryFn: () => environmentsApi.capabilities(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && environmentsEnabled,
  });

  const { data: secrets } = useQuery({
    queryKey: selectedCompanyId ? ["company-secrets", selectedCompanyId] : ["company-secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createOpenClawInvitePrompt(selectedCompanyId!),
    onSuccess: async (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const absoluteUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;
      setSnippetCopied(false);
      setSnippetCopyDelightId(0);
      let snippet: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null
        });
      } catch {
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: null,
          testResolutionUrl: null
        });
      }
      setInviteSnippet(snippet);
      try {
        await navigator.clipboard.writeText(snippet);
        setSnippetCopied(true);
        setSnippetCopyDelightId((prev) => prev + 1);
        setTimeout(() => setSnippetCopied(false), 2000);
      } catch {
        /* clipboard may not be available */
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(selectedCompanyId!)
      });
    },
    onError: (err) => {
      setInviteError(
        err instanceof Error
          ? err.message
          : t("companySettings.invites.failedToCreateInvite", { defaultValue: "Failed to create invite" })
      );
    }
  });

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  const environmentMutation = useMutation({
    mutationFn: async (form: EnvironmentFormState) => {
      const body = buildEnvironmentPayload(form);

      if (editingEnvironmentId) {
        return await environmentsApi.update(editingEnvironmentId, body);
      }

      return await environmentsApi.create(selectedCompanyId!, body);
    },
    onSuccess: async (environment) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.environments.list(selectedCompanyId!),
      });
      setEditingEnvironmentId(null);
      setEnvironmentForm(createEmptyEnvironmentForm());
      pushToast({
        title: editingEnvironmentId
          ? t("companySettings.environment.toast.updated", { defaultValue: "Environment updated" })
          : t("companySettings.environment.toast.created", { defaultValue: "Environment created" }),
        body: t("companySettings.environment.toast.readyBody", {
          defaultValue: "{{name}} is ready.",
          name: environment.name,
        }),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companySettings.environment.toast.saveFailed", { defaultValue: "Failed to save environment" }),
        body: error instanceof Error ? error.message : t("companySettings.environment.toast.saveFailedBody", { defaultValue: "Environment save failed." }),
        tone: "error",
      });
    },
  });

  const environmentProbeMutation = useMutation({
    mutationFn: async (environmentId: string) => await environmentsApi.probe(environmentId),
    onSuccess: (probe, environmentId) => {
      setProbeResults((current) => ({
        ...current,
        [environmentId]: probe,
      }));
      pushToast({
        title: probe.ok
          ? t("companySettings.environment.toast.probePassed", { defaultValue: "Environment probe passed" })
          : t("companySettings.environment.toast.probeFailed", { defaultValue: "Environment probe failed" }),
        body: probe.summary,
        tone: probe.ok ? "success" : "error",
      });
    },
    onError: (error, environmentId) => {
      const failedEnvironment = (environments ?? []).find((environment) => environment.id === environmentId);
      setProbeResults((current) => ({
        ...current,
        [environmentId]: {
          ok: false,
          driver: failedEnvironment?.driver ?? "local",
          summary: error instanceof Error
            ? error.message
            : t("companySettings.environment.toast.probeFailedBody", { defaultValue: "Environment probe failed." }),
          details: null,
        },
      }));
      pushToast({
        title: t("companySettings.environment.toast.probeFailed", { defaultValue: "Environment probe failed" }),
        body: error instanceof Error ? error.message : t("companySettings.environment.toast.probeFailedBody", { defaultValue: "Environment probe failed." }),
        tone: "error",
      });
    },
  });

  const draftEnvironmentProbeMutation = useMutation({
    mutationFn: async (form: EnvironmentFormState) => {
      const body = buildEnvironmentPayload(form);
      return await environmentsApi.probeConfig(selectedCompanyId!, body);
    },
    onSuccess: (probe) => {
      pushToast({
        title: probe.ok
          ? t("companySettings.environment.toast.draftProbePassed", { defaultValue: "Draft probe passed" })
          : t("companySettings.environment.toast.draftProbeFailed", { defaultValue: "Draft probe failed" }),
        body: probe.summary,
        tone: probe.ok ? "success" : "error",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companySettings.environment.toast.draftProbeFailed", { defaultValue: "Draft probe failed" }),
        body: error instanceof Error ? error.message : t("companySettings.environment.toast.probeFailedBody", { defaultValue: "Environment probe failed." }),
        tone: "error",
      });
    },
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
    setEditingEnvironmentId(null);
    setEnvironmentForm(createEmptyEnvironmentForm());
    setProbeResults({});
  }, [selectedCompanyId]);

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("companySettings.breadcrumb.company", { defaultValue: "Company" }), href: "/dashboard" },
      { label: t("companySettings.breadcrumb.settings", { defaultValue: "Settings" }) }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name, t]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("companySettings.states.noCompanySelected", { defaultValue: "No company selected. Select a company from the switcher above." })}
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null
    });
  }

  function handleEditEnvironment(environment: Environment) {
    setEditingEnvironmentId(environment.id);
    if (environment.driver === "ssh") {
      const ssh = readSshConfig(environment);
      setEnvironmentForm({
        ...createEmptyEnvironmentForm(),
        name: environment.name,
        description: environment.description ?? "",
        driver: "ssh",
        sshHost: ssh.host,
        sshPort: ssh.port,
        sshUsername: ssh.username,
        sshRemoteWorkspacePath: ssh.remoteWorkspacePath,
        sshPrivateKey: ssh.privateKey,
        sshPrivateKeySecretId: ssh.privateKeySecretId,
        sshKnownHosts: ssh.knownHosts,
        sshStrictHostKeyChecking: ssh.strictHostKeyChecking,
      });
      return;
    }

    if (environment.driver === "sandbox") {
      const sandbox = readSandboxConfig(environment);
      setEnvironmentForm({
        ...createEmptyEnvironmentForm(),
        name: environment.name,
        description: environment.description ?? "",
        driver: "sandbox",
        sandboxProvider: sandbox.provider,
        sandboxConfig: sandbox.config,
      });
      return;
    }

    setEnvironmentForm({
      ...createEmptyEnvironmentForm(),
      name: environment.name,
      description: environment.description ?? "",
      driver: "local",
    });
  }

  function handleCancelEnvironmentEdit() {
    setEditingEnvironmentId(null);
    setEnvironmentForm(createEmptyEnvironmentForm());
  }

  const discoveredPluginSandboxProviders = Object.entries(environmentCapabilities?.sandboxProviders ?? {})
    .filter(([provider, capability]) => provider !== "fake" && capability.supportsRunExecution)
    .map(([provider, capability]) => ({
      provider,
      displayName: capability.displayName || provider,
      description: capability.description,
      configSchema: normalizeJsonSchema(capability.configSchema),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const sandboxCreationEnabled = discoveredPluginSandboxProviders.length > 0;
  const sandboxSupportVisible = sandboxCreationEnabled;
  const pluginSandboxProviders =
    environmentForm.sandboxProvider.trim().length > 0 &&
    environmentForm.sandboxProvider !== "fake" &&
    !discoveredPluginSandboxProviders.some((provider) => provider.provider === environmentForm.sandboxProvider)
      ? [
          ...discoveredPluginSandboxProviders,
          { provider: environmentForm.sandboxProvider, displayName: environmentForm.sandboxProvider, description: undefined, configSchema: null },
        ]
      : discoveredPluginSandboxProviders;

  const selectedSandboxProvider = pluginSandboxProviders.find(
    (provider) => provider.provider === environmentForm.sandboxProvider,
  ) ?? null;
  const selectedSandboxSchema = selectedSandboxProvider?.configSchema ?? null;
  const sandboxConfigErrors =
    environmentForm.driver === "sandbox" && selectedSandboxSchema
      ? validateJsonSchemaForm(selectedSandboxSchema as any, environmentForm.sandboxConfig)
      : {};

  useEffect(() => {
    if (environmentForm.driver !== "sandbox") return;
    if (environmentForm.sandboxProvider.trim().length > 0 && environmentForm.sandboxProvider !== "fake") return;
    const firstProvider = discoveredPluginSandboxProviders[0]?.provider;
    if (!firstProvider) return;
    const firstSchema = discoveredPluginSandboxProviders[0]?.configSchema;
    setEnvironmentForm((current) => (
      current.driver !== "sandbox" || (current.sandboxProvider.trim().length > 0 && current.sandboxProvider !== "fake")
        ? current
        : {
            ...current,
            sandboxProvider: firstProvider,
            sandboxConfig: firstSchema ? getDefaultValues(firstSchema as any) : {},
          }
    ));
  }, [discoveredPluginSandboxProviders, environmentForm.driver, environmentForm.sandboxProvider]);

  const environmentFormValid =
    environmentForm.name.trim().length > 0 &&
    (environmentForm.driver !== "ssh" ||
      (
        environmentForm.sshHost.trim().length > 0 &&
        environmentForm.sshUsername.trim().length > 0 &&
        environmentForm.sshRemoteWorkspacePath.trim().length > 0
      )) &&
    (environmentForm.driver !== "sandbox" ||
      environmentForm.sandboxProvider.trim().length > 0 &&
      environmentForm.sandboxProvider !== "fake" &&
      Object.keys(sandboxConfigErrors).length === 0);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("companySettings.title", { defaultValue: "Company Settings" })}</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.general", { defaultValue: "General" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field
            label={t("companySettings.general.companyNameLabel", { defaultValue: "Company name" })}
            hint={t("companySettings.general.companyNameHint", { defaultValue: "The display name for your company." })}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label={t("companySettings.general.descriptionLabel", { defaultValue: "Description" })}
            hint={t("companySettings.general.descriptionHint", { defaultValue: "Optional description shown in the company profile." })}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder={t("companySettings.general.descriptionPlaceholder", { defaultValue: "Optional company description" })}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.appearance", { defaultValue: "Appearance" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label={t("companySettings.appearance.logoLabel", { defaultValue: "Logo" })}
                hint={t("companySettings.appearance.logoHint", { defaultValue: "Upload a PNG, JPEG, WEBP, GIF, or SVG logo image." })}
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending
                          ? t("companySettings.appearance.removingLogo", { defaultValue: "Removing..." })
                          : t("companySettings.appearance.removeLogo", { defaultValue: "Remove logo" })}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : t("companySettings.appearance.logoUploadFailed", { defaultValue: "Logo upload failed" }))}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">
                      {t("companySettings.appearance.uploadingLogo", { defaultValue: "Uploading logo..." })}
                    </span>
                  )}
                </div>
              </Field>
              <Field
                label={t("companySettings.appearance.brandColorLabel", { defaultValue: "Brand color" })}
                hint={t("companySettings.appearance.brandColorHint", { defaultValue: "Sets the hue for the company icon. Leave empty for auto-generated color." })}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder={t("companySettings.appearance.auto", { defaultValue: "Auto" })}
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      {t("companySettings.appearance.clear", { defaultValue: "Clear" })}
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim()}
          >
            {generalMutation.isPending
              ? t("companySettings.actions.saving", { defaultValue: "Saving..." })
              : t("companySettings.actions.saveChanges", { defaultValue: "Save changes" })}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">{t("companySettings.states.saved", { defaultValue: "Saved" })}</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : t("companySettings.errors.failedToSave", { defaultValue: "Failed to save" })}
            </span>
          )}
        </div>
      )}

      {environmentsEnabled ? (
      <div className="space-y-4" data-testid="company-settings-environments-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.environments", { defaultValue: "Environments" })}
        </div>
        <div className="space-y-4 rounded-md border border-border px-4 py-4">
          <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {t("companySettings.environment.helpText", {
              defaultValue: "Environment choices use the same adapter support matrix as agent defaults. SSH is always available for remote-managed adapters, and sandbox environments appear only when a run-capable sandbox provider plugin is installed.",
            })}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-xs">
              <caption className="sr-only">
                {t("companySettings.environment.supportCaption", { defaultValue: "Environment support by adapter" })}
              </caption>
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t("companySettings.environment.adapter", { defaultValue: "Adapter" })}</th>
                  <th className="px-3 py-2 font-medium">{t("companySettings.environment.local", { defaultValue: "Local" })}</th>
                  <th className="px-3 py-2 font-medium">{t("companySettings.environment.ssh", { defaultValue: "SSH" })}</th>
                  {sandboxSupportVisible ? (
                    <th className="px-3 py-2 font-medium">{t("companySettings.environment.sandbox", { defaultValue: "Sandbox" })}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {(environmentCapabilities?.adapters.map((support) => ({
                  adapterType: support.adapterType,
                  support,
                })) ?? ENVIRONMENT_SUPPORT_ROWS).map(({ adapterType, support }) => (
                  <tr key={adapterType}>
                    <td className="py-2 pr-3 font-medium">
                      {adapterLabels[adapterType] ?? adapterType}
                    </td>
                    <td className="px-3 py-2">
                      <SupportMark supported={support.drivers.local === "supported"} />
                    </td>
                    <td className="px-3 py-2">
                      <SupportMark supported={support.drivers.ssh === "supported"} />
                    </td>
                    {sandboxSupportVisible ? (
                      <td className="px-3 py-2">
                        <SupportMark
                          supported={discoveredPluginSandboxProviders.some((provider) =>
                            support.sandboxProviders[provider.provider] === "supported")}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3">
            {(environments ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">
                {t("companySettings.environment.noneSaved", { defaultValue: "No environments saved for this company yet." })}
              </div>
            ) : (
              (environments ?? []).map((environment) => {
                const probe = probeResults[environment.id] ?? null;
                const isEditing = editingEnvironmentId === environment.id;
                return (
                  <div
                    key={environment.id}
                    className="rounded-md border border-border/70 px-3 py-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">
                          {environment.name} <span className="text-muted-foreground">· {environment.driver}</span>
                        </div>
                        {environment.description ? (
                          <div className="text-xs text-muted-foreground">{environment.description}</div>
                        ) : null}
                        {environment.driver === "ssh" ? (
                          <div className="text-xs text-muted-foreground">
                            {typeof environment.config.host === "string"
                              ? environment.config.host
                              : t("companySettings.environment.sshHost", { defaultValue: "SSH host" })}{" "}
                            ·{" "}
                            {typeof environment.config.username === "string"
                              ? environment.config.username
                              : t("companySettings.environment.user", { defaultValue: "user" })}
                          </div>
                        ) : environment.driver === "sandbox" ? (
                          <div className="text-xs text-muted-foreground">
                            {(() => {
                              const provider =
                                typeof environment.config.provider === "string"
                                  ? environment.config.provider
                                  : t("companySettings.environment.sandbox", { defaultValue: "sandbox" });
                              const displayName =
                                environmentCapabilities?.sandboxProviders?.[provider]?.displayName ?? provider;
                              const summary = summarizeSandboxConfig(environment.config as Record<string, unknown>);
                              return t("companySettings.environment.sandboxProviderSummary", {
                                defaultValue: "{{displayName}} sandbox provider{{suffix}}",
                                displayName,
                                suffix: summary ? ` · ${summary}` : "",
                              });
                            })()}
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("companySettings.environment.runsOnHost", { defaultValue: "Runs on this Paperclip host." })}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {environment.driver !== "local" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => environmentProbeMutation.mutate(environment.id)}
                            disabled={environmentProbeMutation.isPending}
                          >
                            {environmentProbeMutation.isPending
                              ? t("companySettings.environment.testing", { defaultValue: "Testing..." })
                              : environment.driver === "ssh"
                                ? t("companySettings.environment.testConnection", { defaultValue: "Test connection" })
                                : t("companySettings.environment.testProvider", { defaultValue: "Test provider" })}
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleEditEnvironment(environment)}
                        >
                          {isEditing
                            ? t("companySettings.environment.editing", { defaultValue: "Editing" })
                            : t("companySettings.environment.edit", { defaultValue: "Edit" })}
                        </Button>
                      </div>
                    </div>
                    {probe ? (
                      <div
                        className={
                          probe.ok
                            ? "mt-3 rounded border border-green-500/30 bg-green-500/5 px-2.5 py-2 text-xs text-green-700"
                            : "mt-3 rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
                        }
                      >
                        <div className="font-medium">{probe.summary}</div>
                        {probe.details?.error && typeof probe.details.error === "string" ? (
                          <div className="mt-1 font-mono text-[11px]">{probe.details.error}</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t border-border/60 pt-4">
            <div className="mb-3 text-sm font-medium">
              {editingEnvironmentId
                ? t("companySettings.environment.editEnvironment", { defaultValue: "Edit environment" })
                : t("companySettings.environment.addEnvironment", { defaultValue: "Add environment" })}
            </div>
            <div className="space-y-3">
              <Field
                label={t("companySettings.environment.nameLabel", { defaultValue: "Name" })}
                hint={t("companySettings.environment.nameHint", { defaultValue: "Operator-facing name for this execution target." })}
              >
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  type="text"
                  value={environmentForm.name}
                  onChange={(e) => setEnvironmentForm((current) => ({ ...current, name: e.target.value }))}
                />
              </Field>
              <Field
                label={t("companySettings.environment.descriptionLabel", { defaultValue: "Description" })}
                hint={t("companySettings.environment.descriptionHint", { defaultValue: "Optional note about what this machine is for." })}
              >
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  type="text"
                  value={environmentForm.description}
                  onChange={(e) => setEnvironmentForm((current) => ({ ...current, description: e.target.value }))}
                />
              </Field>
              <Field
                label={t("companySettings.environment.driverLabel", { defaultValue: "Driver" })}
                hint={t("companySettings.environment.driverHint", { defaultValue: "Local runs on this host. SSH stores a remote machine target. Sandbox stores plugin-backed provider config on the shared environment seam." })}
              >
                <select
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  value={environmentForm.driver}
                  onChange={(e) =>
                    setEnvironmentForm((current) => ({
                      ...current,
                      sandboxProvider:
                        e.target.value === "sandbox"
                          ? current.sandboxProvider.trim() || discoveredPluginSandboxProviders[0]?.provider || ""
                          : current.sandboxProvider,
                      sandboxConfig:
                        e.target.value === "sandbox"
                          ? (
                              current.sandboxProvider.trim().length > 0 && current.driver === "sandbox"
                                ? current.sandboxConfig
                                : discoveredPluginSandboxProviders[0]?.configSchema
                                  ? getDefaultValues(discoveredPluginSandboxProviders[0].configSchema as any)
                                  : {}
                            )
                          : current.sandboxConfig,
                      driver:
                        e.target.value === "local"
                          ? "local"
                          : e.target.value === "sandbox"
                            ? "sandbox"
                            : "ssh",
                    }))}
                >
                  <option value="ssh">{t("companySettings.environment.ssh", { defaultValue: "SSH" })}</option>
                  {sandboxCreationEnabled || environmentForm.driver === "sandbox" ? (
                    <option value="sandbox">{t("companySettings.environment.sandbox", { defaultValue: "Sandbox" })}</option>
                  ) : null}
                  <option value="local">{t("companySettings.environment.local", { defaultValue: "Local" })}</option>
                </select>
              </Field>

              {environmentForm.driver === "ssh" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <Field
                    label={t("companySettings.environment.ssh.hostLabel", { defaultValue: "Host" })}
                    hint={t("companySettings.environment.ssh.hostHint", { defaultValue: "DNS name or IP address for the remote machine." })}
                  >
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      value={environmentForm.sshHost}
                      onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshHost: e.target.value }))}
                    />
                  </Field>
                  <Field
                    label={t("companySettings.environment.ssh.portLabel", { defaultValue: "Port" })}
                    hint={t("companySettings.environment.ssh.portHint", { defaultValue: "Defaults to 22." })}
                  >
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="number"
                      min={1}
                      max={65535}
                      value={environmentForm.sshPort}
                      onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshPort: e.target.value }))}
                    />
                  </Field>
                  <Field
                    label={t("companySettings.environment.ssh.usernameLabel", { defaultValue: "Username" })}
                    hint={t("companySettings.environment.ssh.usernameHint", { defaultValue: "SSH login user." })}
                  >
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      value={environmentForm.sshUsername}
                      onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshUsername: e.target.value }))}
                    />
                  </Field>
                  <Field
                    label={t("companySettings.environment.ssh.remotePathLabel", { defaultValue: "Remote workspace path" })}
                    hint={t("companySettings.environment.ssh.remotePathHint", { defaultValue: "Absolute path that Paperclip will verify during SSH connection tests." })}
                  >
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      type="text"
                      placeholder={t("companySettings.environment.ssh.remotePathPlaceholder", { defaultValue: "/Users/paperclip/workspace" })}
                      value={environmentForm.sshRemoteWorkspacePath}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({ ...current, sshRemoteWorkspacePath: e.target.value }))}
                    />
                  </Field>
                  <Field
                    label={t("companySettings.environment.ssh.privateKeyLabel", { defaultValue: "Private key" })}
                    hint={t("companySettings.environment.ssh.privateKeyHint", { defaultValue: "Optional PEM private key. Leave blank to rely on the server's SSH agent or default keychain." })}
                  >
                    <div className="space-y-2">
                      <select
                        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                        value={environmentForm.sshPrivateKeySecretId}
                        onChange={(e) =>
                          setEnvironmentForm((current) => ({
                            ...current,
                            sshPrivateKeySecretId: e.target.value,
                            sshPrivateKey: e.target.value ? "" : current.sshPrivateKey,
                          }))}
                      >
                        <option value="">{t("companySettings.environment.ssh.noSavedSecret", { defaultValue: "No saved secret" })}</option>
                        {(secrets ?? []).map((secret) => (
                          <option key={secret.id} value={secret.id}>{secret.name}</option>
                        ))}
                      </select>
                      <textarea
                        className="h-32 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                        value={environmentForm.sshPrivateKey}
                        disabled={!!environmentForm.sshPrivateKeySecretId}
                        onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshPrivateKey: e.target.value }))}
                      />
                    </div>
                  </Field>
                  <Field
                    label={t("companySettings.environment.ssh.knownHostsLabel", { defaultValue: "Known hosts" })}
                    hint={t("companySettings.environment.ssh.knownHostsHint", { defaultValue: "Optional known_hosts block used when strict host key checking is enabled." })}
                  >
                    <textarea
                      className="h-32 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                      value={environmentForm.sshKnownHosts}
                      onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshKnownHosts: e.target.value }))}
                    />
                  </Field>
                  <div className="md:col-span-2">
                    <ToggleField
                      label={t("companySettings.environment.ssh.strictHostKeyCheckingLabel", { defaultValue: "Strict host key checking" })}
                      hint={t("companySettings.environment.ssh.strictHostKeyCheckingHint", { defaultValue: "Keep this on unless you deliberately want probe-time host key acceptance disabled." })}
                      checked={environmentForm.sshStrictHostKeyChecking}
                      onChange={(checked) =>
                        setEnvironmentForm((current) => ({ ...current, sshStrictHostKeyChecking: checked }))}
                    />
                  </div>
                </div>
              ) : null}

              {environmentForm.driver === "sandbox" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <Field
                    label={t("companySettings.environment.sandbox.providerLabel", { defaultValue: "Provider" })}
                    hint={t("companySettings.environment.sandbox.providerHint", { defaultValue: "Installed run-capable sandbox provider plugins appear here." })}
                  >
                    <select
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      value={environmentForm.sandboxProvider}
                      onChange={(e) => {
                        const nextProviderKey = e.target.value;
                        const nextProvider = pluginSandboxProviders.find((provider) => provider.provider === nextProviderKey) ?? null;
                        setEnvironmentForm((current) => ({
                          ...current,
                          sandboxProvider: nextProviderKey,
                          sandboxConfig:
                            current.sandboxProvider === nextProviderKey
                              ? current.sandboxConfig
                              : nextProvider?.configSchema
                                ? getDefaultValues(nextProvider.configSchema as any)
                                : {},
                        }));
                      }}
                    >
                      {pluginSandboxProviders.map((provider) => (
                        <option key={provider.provider} value={provider.provider}>
                          {provider.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="md:col-span-2 space-y-3">
                    {selectedSandboxProvider?.description ? (
                      <div className="text-xs text-muted-foreground">
                        {selectedSandboxProvider.description}
                      </div>
                    ) : null}
                    {selectedSandboxSchema ? (
                      <JsonSchemaForm
                        schema={selectedSandboxSchema as any}
                        values={environmentForm.sandboxConfig}
                        onChange={(values) =>
                          setEnvironmentForm((current) => ({ ...current, sandboxConfig: values }))}
                        errors={sandboxConfigErrors}
                      />
                    ) : (
                      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        {t("companySettings.environment.sandbox.noAdditionalConfig", {
                          defaultValue: "This provider does not declare additional configuration fields.",
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => environmentMutation.mutate(environmentForm)}
                  disabled={environmentMutation.isPending || !environmentFormValid}
                >
                  {environmentMutation.isPending
                    ? editingEnvironmentId
                      ? t("companySettings.environment.actions.saving", { defaultValue: "Saving..." })
                      : t("companySettings.environment.actions.creating", { defaultValue: "Creating..." })
                    : editingEnvironmentId
                      ? t("companySettings.environment.actions.saveEnvironment", { defaultValue: "Save environment" })
                      : t("companySettings.environment.actions.createEnvironment", { defaultValue: "Create environment" })}
                </Button>
                {editingEnvironmentId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCancelEnvironmentEdit}
                    disabled={environmentMutation.isPending}
                  >
                    {t("companySettings.environment.actions.cancel", { defaultValue: "Cancel" })}
                  </Button>
                ) : null}
                {environmentForm.driver !== "local" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => draftEnvironmentProbeMutation.mutate(environmentForm)}
                    disabled={draftEnvironmentProbeMutation.isPending || !environmentFormValid}
                  >
                    {draftEnvironmentProbeMutation.isPending
                      ? t("companySettings.environment.actions.testing", { defaultValue: "Testing..." })
                      : t("companySettings.environment.actions.testDraft", { defaultValue: "Test draft" })}
                  </Button>
                ) : null}
                {environmentMutation.isError ? (
                  <span className="text-xs text-destructive">
                    {environmentMutation.error instanceof Error
                      ? environmentMutation.error.message
                      : t("companySettings.environment.errors.failedToSave", { defaultValue: "Failed to save environment" })}
                  </span>
                ) : null}
                {draftEnvironmentProbeMutation.data ? (
                  <span className={draftEnvironmentProbeMutation.data.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
                    {draftEnvironmentProbeMutation.data.summary}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
      ) : null}

      {/* Hiring */}
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.hiring", { defaultValue: "Hiring" })}
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label={t("companySettings.hiring.requireApprovalLabel", { defaultValue: "Require board approval for new hires" })}
            hint={t("companySettings.hiring.requireApprovalHint", { defaultValue: "New agent hires stay pending until approved by board." })}
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      {/* Invites */}
      <div className="space-y-4" data-testid="company-settings-invites-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.invites", { defaultValue: "Invites" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {t("companySettings.invites.generateHint", { defaultValue: "Generate an OpenClaw agent invite snippet." })}
            </span>
            <HintIcon text={t("companySettings.invites.generateHintTooltip", { defaultValue: "Creates a short-lived OpenClaw agent invite and renders a copy-ready prompt." })} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="company-settings-invites-generate-button"
              size="sm"
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending
                ? t("companySettings.invites.generating", { defaultValue: "Generating..." })
                : t("companySettings.invites.generatePrompt", { defaultValue: "Generate OpenClaw Invite Prompt" })}
            </Button>
          </div>
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}
          {inviteSnippet && (
            <div
              className="rounded-md border border-border bg-muted/30 p-2"
              data-testid="company-settings-invites-snippet"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  {t("companySettings.invites.promptTitle", { defaultValue: "OpenClaw Invite Prompt" })}
                </div>
                {snippetCopied && (
                  <span
                    key={snippetCopyDelightId}
                    className="flex items-center gap-1 text-xs text-green-600 animate-pulse"
                  >
                    <Check className="h-3 w-3" />
                    {t("companySettings.invites.copied", { defaultValue: "Copied" })}
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1.5">
                <textarea
                  data-testid="company-settings-invites-snippet-textarea"
                  className="h-[28rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                  value={inviteSnippet}
                  readOnly
                />
                <div className="flex justify-end">
                  <Button
                    data-testid="company-settings-invites-copy-button"
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteSnippet);
                        setSnippetCopied(true);
                        setSnippetCopyDelightId((prev) => prev + 1);
                        setTimeout(() => setSnippetCopied(false), 2000);
                      } catch {
                        /* clipboard may not be available */
                      }
                    }}
                  >
                    {snippetCopied
                      ? t("companySettings.invites.copiedSnippet", { defaultValue: "Copied snippet" })
                      : t("companySettings.invites.copySnippet", { defaultValue: "Copy snippet" })}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.companyPackages", { defaultValue: "Company Packages" })}
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("companySettings.companyPackages.movedNoticePrefix", {
              defaultValue: "Import and export have moved to dedicated pages accessible from the ",
            })}
            <a href="/org" className="underline hover:text-foreground">
              {t("companySettings.companyPackages.orgChart", { defaultValue: "Org Chart" })}
            </a>
            {t("companySettings.companyPackages.movedNoticeSuffix", { defaultValue: " header." })}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <a href="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.companyPackages.export", { defaultValue: "Export" })}
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.companyPackages.import", { defaultValue: "Import" })}
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          {t("companySettings.sections.dangerZone", { defaultValue: "Danger Zone" })}
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("companySettings.dangerZone.archiveHint", {
              defaultValue: "Archive this company to hide it from the sidebar. This persists in the database.",
            })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                selectedCompany.status === "archived"
              }
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  t("companySettings.dangerZone.archiveConfirm", {
                    defaultValue: 'Archive company "{{name}}"? It will be hidden from the sidebar.',
                    name: selectedCompany.name,
                  })
                );
                if (!confirmed) return;
                const nextCompanyId =
                  companies.find(
                    (company) =>
                      company.id !== selectedCompanyId &&
                      company.status !== "archived"
                  )?.id ?? null;
                archiveMutation.mutate({
                  companyId: selectedCompanyId,
                  nextCompanyId
                });
              }}
            >
              {archiveMutation.isPending
                ? t("companySettings.dangerZone.archiving", { defaultValue: "Archiving..." })
                : selectedCompany.status === "archived"
                ? t("companySettings.dangerZone.alreadyArchived", { defaultValue: "Already archived" })
                : t("companySettings.dangerZone.archiveCompany", { defaultValue: "Archive company" })}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : t("companySettings.dangerZone.failedToArchive", { defaultValue: "Failed to archive company" })}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function buildAgentSnippet(input: AgentSnippetInput) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((u) => `- ${u}`).join("\n")
      : "- (No candidate URLs available yet.)";

  const connectivityBlock =
    candidateUrls.length === 0
      ? `No candidate URLs are available. Ask your user to configure a reachable hostname in Paperclip, then retry.
Suggested steps:
- choose a hostname that resolves to the Paperclip host from your runtime
- run: pnpm paperclipai allowed-hostname <host>
- restart Paperclip
- verify with: curl -fsS http://<host>:3100/api/health
- regenerate this invite snippet`
      : `If none are reachable, ask your user to add a reachable hostname in Paperclip, restart, and retry.
Suggested command:
- pnpm paperclipai allowed-hostname <host>
Then verify with: curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\nYou MUST test Paperclip-to-gateway reachability, call: ${resolutionTestUrl}?url=<urlencoded-gateway-url> (using the hostname that worked above). Do not assume your 172.x is necessarily reachable from Paperclip. Test it. `
    : "";

  return `You're invited to join a Paperclip organization.

The URLs you should try are:
${candidateList}

Connectivity guidance:
If you are running on a different machine than Paperclip, Paperclip must be reachable at one of the hostnames used above.
Verify the hostname works from your runtime with: GET <base-url>/api/health

${connectivityBlock}

For your "agentName", just use your own agent name (OpenClaw or whatever your name is) and send it directly.
You also need to send a gateway URL that Paperclip can access. Check your config and include that URL.${resolutionLine}

---

This onboarding flow is for OpenClaw Gateway.
When you submit the join request, use:
- \`adapterType: "openclaw_gateway"\`
- \`agentDefaultsPayload.url\` as your \`ws://\` or \`wss://\` gateway URL
- \`agentDefaultsPayload.headers["x-openclaw-token"]\` with your gateway token
- (legacy accepted) \`agentDefaultsPayload.headers["x-openclaw-auth"]\`
- Keep device auth enabled (recommended). If \`devicePrivateKeyPem\` is omitted, Paperclip will generate and persist one during join so pairing approvals remain stable.
- Only use \`disableDeviceAuth=true\` for special environments where pairing cannot be completed.

Do NOT use \`/v1/responses\` or \`/hooks/*\` in this join flow.

Before you do anything, please respond to your user that you understand the instructions and you're going to work on them. Then do the step above in another session called "paperclip-onboarding" and then tell your user when you're done. Update your user in intermediate steps along the way so they know what's going on.

Then after you've connected to Paperclip (exchanged keys etc.) you MUST review and follow the onboarding instructions in onboarding.txt they give you.

`;
}

function buildCandidateOnboardingUrls(input: AgentSnippetInput): string[] {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: AgentSnippetInput): string | null {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution"
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}
