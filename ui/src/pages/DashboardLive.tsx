import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RadioTower } from "lucide-react";
import { Link } from "@/lib/router";
import { useT } from "@/i18n/hooks/useT";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

const DASHBOARD_LIVE_RUN_LIMIT = 50;

export function DashboardLive() {
  const { t } = useTranslation("dashboard");
  const { t: tx } = useT("dashboard");
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: t("nav.dashboard"), href: "/dashboard" },
      { label: t("liveRunWidget.title") },
    ]);
  }, [setBreadcrumbs, t]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={t(companies.length === 0 ? "liveRunWidget.createCompany" : "liveRunWidget.selectCompany")}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {tx("nav.dashboard")}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{tx("liveRunWidget.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tx("liveRunWidget.description")}
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          {t("liveRunWidget.showingUpTo", { limit: DASHBOARD_LIVE_RUN_LIMIT })}
        </div>
      </div>

      <ActiveAgentsPanel
        companyId={selectedCompanyId}
        title={t("liveRunWidget.activeRecent")}
        minRunCount={DASHBOARD_LIVE_RUN_LIMIT}
        fetchLimit={DASHBOARD_LIVE_RUN_LIMIT}
        cardLimit={DASHBOARD_LIVE_RUN_LIMIT}
        gridClassName="gap-3 md:grid-cols-2 2xl:grid-cols-3"
        cardClassName="h-[420px]"
        emptyMessage={t("liveRunWidget.noRuns")}
        queryScope="dashboard-live"
        showMoreLink={false}
      />
    </div>
  );
}
