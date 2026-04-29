import enAgents from "./locales/en/agents.json";
import enAuth from "./locales/en/auth.json";
import enCli from "./locales/en/cli.json";
import enCommon from "./locales/en/common.json";
import enCore from "./locales/en/core.json";
import enDashboard from "./locales/en/dashboard.json";
import enErrors from "./locales/en/errors.json";
import enForms from "./locales/en/forms.json";
import enIssues from "./locales/en/issues.json";
import enModals from "./locales/en/modals.json";
import enPlugins from "./locales/en/plugins.json";
import enProjects from "./locales/en/projects.json";
import enSettings from "./locales/en/settings.json";
import frAgents from "./locales/fr-FR/agents.json";
import frAuth from "./locales/fr-FR/auth.json";
import frCli from "./locales/fr-FR/cli.json";
import frCommon from "./locales/fr-FR/common.json";
import frCore from "./locales/fr-FR/core.json";
import frDashboard from "./locales/fr-FR/dashboard.json";
import frErrors from "./locales/fr-FR/errors.json";
import frForms from "./locales/fr-FR/forms.json";
import frIssues from "./locales/fr-FR/issues.json";
import frModals from "./locales/fr-FR/modals.json";
import frPlugins from "./locales/fr-FR/plugins.json";
import frProjects from "./locales/fr-FR/projects.json";
import frSettings from "./locales/fr-FR/settings.json";

export const NAMESPACES = [
  "core",
  "dashboard",
  "issues",
  "agents",
  "plugins",
  "settings",
  "auth",
  "errors",
  "forms",
  "modals",
  "common",
  "cli",
  "projects",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export const SUPPORTED_LANGUAGES = ["en", "fr-FR"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const bundledResources: Record<
  SupportedLanguage,
  Record<Namespace, unknown>
> = {
  en: {
    core: enCore,
    dashboard: enDashboard,
    issues: enIssues,
    agents: enAgents,
    plugins: enPlugins,
    settings: enSettings,
    auth: enAuth,
    errors: enErrors,
    forms: enForms,
    modals: enModals,
    common: enCommon,
    cli: enCli,
    projects: enProjects,
  },
  "fr-FR": {
    core: frCore,
    dashboard: frDashboard,
    issues: frIssues,
    agents: frAgents,
    plugins: frPlugins,
    settings: frSettings,
    auth: frAuth,
    errors: frErrors,
    forms: frForms,
    modals: frModals,
    common: frCommon,
    cli: frCli,
    projects: frProjects,
  },
};
