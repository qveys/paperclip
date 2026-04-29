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
import deAgents from "./locales/de-DE/agents.json";
import deAuth from "./locales/de-DE/auth.json";
import deCli from "./locales/de-DE/cli.json";
import deCommon from "./locales/de-DE/common.json";
import deCore from "./locales/de-DE/core.json";
import deDashboard from "./locales/de-DE/dashboard.json";
import deErrors from "./locales/de-DE/errors.json";
import deForms from "./locales/de-DE/forms.json";
import deIssues from "./locales/de-DE/issues.json";
import deModals from "./locales/de-DE/modals.json";
import dePlugins from "./locales/de-DE/plugins.json";
import deProjects from "./locales/de-DE/projects.json";
import deSettings from "./locales/de-DE/settings.json";
import esAgents from "./locales/es-ES/agents.json";
import esAuth from "./locales/es-ES/auth.json";
import esCli from "./locales/es-ES/cli.json";
import esCommon from "./locales/es-ES/common.json";
import esCore from "./locales/es-ES/core.json";
import esDashboard from "./locales/es-ES/dashboard.json";
import esErrors from "./locales/es-ES/errors.json";
import esForms from "./locales/es-ES/forms.json";
import esIssues from "./locales/es-ES/issues.json";
import esModals from "./locales/es-ES/modals.json";
import esPlugins from "./locales/es-ES/plugins.json";
import esProjects from "./locales/es-ES/projects.json";
import esSettings from "./locales/es-ES/settings.json";
import jaAgents from "./locales/ja-JP/agents.json";
import jaAuth from "./locales/ja-JP/auth.json";
import jaCli from "./locales/ja-JP/cli.json";
import jaCommon from "./locales/ja-JP/common.json";
import jaCore from "./locales/ja-JP/core.json";
import jaDashboard from "./locales/ja-JP/dashboard.json";
import jaErrors from "./locales/ja-JP/errors.json";
import jaForms from "./locales/ja-JP/forms.json";
import jaIssues from "./locales/ja-JP/issues.json";
import jaModals from "./locales/ja-JP/modals.json";
import jaPlugins from "./locales/ja-JP/plugins.json";
import jaProjects from "./locales/ja-JP/projects.json";
import jaSettings from "./locales/ja-JP/settings.json";
import zhAgents from "./locales/zh-CN/agents.json";
import zhAuth from "./locales/zh-CN/auth.json";
import zhCli from "./locales/zh-CN/cli.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhCore from "./locales/zh-CN/core.json";
import zhDashboard from "./locales/zh-CN/dashboard.json";
import zhErrors from "./locales/zh-CN/errors.json";
import zhForms from "./locales/zh-CN/forms.json";
import zhIssues from "./locales/zh-CN/issues.json";
import zhModals from "./locales/zh-CN/modals.json";
import zhPlugins from "./locales/zh-CN/plugins.json";
import zhProjects from "./locales/zh-CN/projects.json";
import zhSettings from "./locales/zh-CN/settings.json";

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

export const SUPPORTED_LANGUAGES = ["en", "fr-FR", "de-DE", "es-ES", "ja-JP", "zh-CN"] as const;

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
  "de-DE": {
    core: deCore,
    dashboard: deDashboard,
    issues: deIssues,
    agents: deAgents,
    plugins: dePlugins,
    settings: deSettings,
    auth: deAuth,
    errors: deErrors,
    forms: deForms,
    modals: deModals,
    common: deCommon,
    cli: deCli,
    projects: deProjects,
  },
  "es-ES": {
    core: esCore,
    dashboard: esDashboard,
    issues: esIssues,
    agents: esAgents,
    plugins: esPlugins,
    settings: esSettings,
    auth: esAuth,
    errors: esErrors,
    forms: esForms,
    modals: esModals,
    common: esCommon,
    cli: esCli,
    projects: esProjects,
  },
  "ja-JP": {
    core: jaCore,
    dashboard: jaDashboard,
    issues: jaIssues,
    agents: jaAgents,
    plugins: jaPlugins,
    settings: jaSettings,
    auth: jaAuth,
    errors: jaErrors,
    forms: jaForms,
    modals: jaModals,
    common: jaCommon,
    cli: jaCli,
    projects: jaProjects,
  },
  "zh-CN": {
    core: zhCore,
    dashboard: zhDashboard,
    issues: zhIssues,
    agents: zhAgents,
    plugins: zhPlugins,
    settings: zhSettings,
    auth: zhAuth,
    errors: zhErrors,
    forms: zhForms,
    modals: zhModals,
    common: zhCommon,
    cli: zhCli,
    projects: zhProjects,
  },
};
