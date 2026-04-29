import type { Resource, ResourceLanguage } from "i18next";

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

export const SUPPORTED_LANGUAGES = ["en"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

type LanguageCatalog = Record<Namespace, ResourceLanguage>;

export const bundledResources = {
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
} as const satisfies Record<SupportedLanguage, LanguageCatalog> & Resource;
