import deDeAgents from "./locales/de-DE/agents.json";
import deDeAuth from "./locales/de-DE/auth.json";
import deDeCli from "./locales/de-DE/cli.json";
import deDeCommon from "./locales/de-DE/common.json";
import deDeCore from "./locales/de-DE/core.json";
import deDeDashboard from "./locales/de-DE/dashboard.json";
import deDeErrors from "./locales/de-DE/errors.json";
import deDeForms from "./locales/de-DE/forms.json";
import deDeIssues from "./locales/de-DE/issues.json";
import deDeModals from "./locales/de-DE/modals.json";
import deDePlugins from "./locales/de-DE/plugins.json";
import deDeSettings from "./locales/de-DE/settings.json";

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
import enSettings from "./locales/en/settings.json";

import esEsAgents from "./locales/es-ES/agents.json";
import esEsAuth from "./locales/es-ES/auth.json";
import esEsCli from "./locales/es-ES/cli.json";
import esEsCommon from "./locales/es-ES/common.json";
import esEsCore from "./locales/es-ES/core.json";
import esEsDashboard from "./locales/es-ES/dashboard.json";
import esEsErrors from "./locales/es-ES/errors.json";
import esEsForms from "./locales/es-ES/forms.json";
import esEsIssues from "./locales/es-ES/issues.json";
import esEsModals from "./locales/es-ES/modals.json";
import esEsPlugins from "./locales/es-ES/plugins.json";
import esEsSettings from "./locales/es-ES/settings.json";

import frFrAgents from "./locales/fr-FR/agents.json";
import frFrAuth from "./locales/fr-FR/auth.json";
import frFrCli from "./locales/fr-FR/cli.json";
import frFrCommon from "./locales/fr-FR/common.json";
import frFrCore from "./locales/fr-FR/core.json";
import frFrDashboard from "./locales/fr-FR/dashboard.json";
import frFrErrors from "./locales/fr-FR/errors.json";
import frFrForms from "./locales/fr-FR/forms.json";
import frFrIssues from "./locales/fr-FR/issues.json";
import frFrModals from "./locales/fr-FR/modals.json";
import frFrPlugins from "./locales/fr-FR/plugins.json";
import frFrSettings from "./locales/fr-FR/settings.json";

import jaJpAgents from "./locales/ja-JP/agents.json";
import jaJpAuth from "./locales/ja-JP/auth.json";
import jaJpCli from "./locales/ja-JP/cli.json";
import jaJpCommon from "./locales/ja-JP/common.json";
import jaJpCore from "./locales/ja-JP/core.json";
import jaJpDashboard from "./locales/ja-JP/dashboard.json";
import jaJpErrors from "./locales/ja-JP/errors.json";
import jaJpForms from "./locales/ja-JP/forms.json";
import jaJpIssues from "./locales/ja-JP/issues.json";
import jaJpModals from "./locales/ja-JP/modals.json";
import jaJpPlugins from "./locales/ja-JP/plugins.json";
import jaJpSettings from "./locales/ja-JP/settings.json";

import zhCnAgents from "./locales/zh-CN/agents.json";
import zhCnAuth from "./locales/zh-CN/auth.json";
import zhCnCli from "./locales/zh-CN/cli.json";
import zhCnCommon from "./locales/zh-CN/common.json";
import zhCnCore from "./locales/zh-CN/core.json";
import zhCnDashboard from "./locales/zh-CN/dashboard.json";
import zhCnErrors from "./locales/zh-CN/errors.json";
import zhCnForms from "./locales/zh-CN/forms.json";
import zhCnIssues from "./locales/zh-CN/issues.json";
import zhCnModals from "./locales/zh-CN/modals.json";
import zhCnPlugins from "./locales/zh-CN/plugins.json";
import zhCnSettings from "./locales/zh-CN/settings.json";

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
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export const SUPPORTED_LANGUAGES = [
  "en",
  "fr-FR",
  "zh-CN",
  "ja-JP",
  "es-ES",
  "de-DE",
] as const;

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
  },
  "fr-FR": {
    core: frFrCore,
    dashboard: frFrDashboard,
    issues: frFrIssues,
    agents: frFrAgents,
    plugins: frFrPlugins,
    settings: frFrSettings,
    auth: frFrAuth,
    errors: frFrErrors,
    forms: frFrForms,
    modals: frFrModals,
    common: frFrCommon,
    cli: frFrCli,
  },
  "zh-CN": {
    core: zhCnCore,
    dashboard: zhCnDashboard,
    issues: zhCnIssues,
    agents: zhCnAgents,
    plugins: zhCnPlugins,
    settings: zhCnSettings,
    auth: zhCnAuth,
    errors: zhCnErrors,
    forms: zhCnForms,
    modals: zhCnModals,
    common: zhCnCommon,
    cli: zhCnCli,
  },
  "ja-JP": {
    core: jaJpCore,
    dashboard: jaJpDashboard,
    issues: jaJpIssues,
    agents: jaJpAgents,
    plugins: jaJpPlugins,
    settings: jaJpSettings,
    auth: jaJpAuth,
    errors: jaJpErrors,
    forms: jaJpForms,
    modals: jaJpModals,
    common: jaJpCommon,
    cli: jaJpCli,
  },
  "es-ES": {
    core: esEsCore,
    dashboard: esEsDashboard,
    issues: esEsIssues,
    agents: esEsAgents,
    plugins: esEsPlugins,
    settings: esEsSettings,
    auth: esEsAuth,
    errors: esEsErrors,
    forms: esEsForms,
    modals: esEsModals,
    common: esEsCommon,
    cli: esEsCli,
  },
  "de-DE": {
    core: deDeCore,
    dashboard: deDeDashboard,
    issues: deDeIssues,
    agents: deDeAgents,
    plugins: deDePlugins,
    settings: deDeSettings,
    auth: deDeAuth,
    errors: deDeErrors,
    forms: deDeForms,
    modals: deDeModals,
    common: deDeCommon,
    cli: deDeCli,
  },
};
