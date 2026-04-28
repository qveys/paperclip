import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import type { DevServerHealthStatus } from "../api/health";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

function formatRelativeTimestamp(value: string | null, t: TFunction<"core">): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return t("devRestartBanner.justNow", { defaultValue: "just now" });
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) {
    return t("devRestartBanner.minutesAgo", { defaultValue: "{{count}}m ago", count: deltaMinutes });
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return t("devRestartBanner.hoursAgo", { defaultValue: "{{count}}h ago", count: deltaHours });
  }
  const deltaDays = Math.round(deltaHours / 24);
  return t("devRestartBanner.daysAgo", { defaultValue: "{{count}}d ago", count: deltaDays });
}

function describeReason(devServer: DevServerHealthStatus, t: TFunction<"core">): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return t("devRestartBanner.reasonBoth", {
      defaultValue: "backend files changed and migrations are pending",
    });
  }
  if (devServer.reason === "pending_migrations") {
    return t("devRestartBanner.reasonMigrations", {
      defaultValue: "pending migrations need a fresh boot",
    });
  }
  return t("devRestartBanner.reasonChanges", {
    defaultValue: "backend files changed since this server booted",
  });
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const { t } = useTranslation("core");
  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt, t);
  const sample = devServer.changedPathsSample.slice(0, 3);

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{t("devRestartBanner.restartRequired", { defaultValue: "Restart Required" })}</span>
            {devServer.autoRestartEnabled ? (
              <span className="rounded-full bg-amber-900/10 px-2 py-0.5 text-[10px] tracking-[0.14em] dark:bg-amber-100/10">
                {t("devRestartBanner.autoRestartOn", { defaultValue: "Auto-Restart On" })}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {describeReason(devServer, t)}
            {changedAt ? ` · ${t("devRestartBanner.updated", { defaultValue: "updated {{time}}", time: changedAt })}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span>
                {t("devRestartBanner.changed", { defaultValue: "Changed" })}: {sample.join(", ")}
                {devServer.changedPathCount > sample.length
                  ? t("devRestartBanner.moreCount", {
                      defaultValue: " +{{count}} more",
                      count: devServer.changedPathCount - sample.length,
                    })
                  : ""}
              </span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span>
                {t("devRestartBanner.pendingMigrations", { defaultValue: "Pending migrations" })}:{" "}
                {devServer.pendingMigrations.slice(0, 2).join(", ")}
                {devServer.pendingMigrations.length > 2
                  ? t("devRestartBanner.moreCount", {
                      defaultValue: " +{{count}} more",
                      count: devServer.pendingMigrations.length - 2,
                    })
                  : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span>
                {t("devRestartBanner.waitingForIdle", {
                  count: devServer.activeRunCount,
                  defaultValue_one: "Waiting for {{count}} live run to finish",
                  defaultValue_other: "Waiting for {{count}} live runs to finish",
                })}
              </span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>
                {t("devRestartBanner.autoRestartWill", {
                  defaultValue: "Auto-restart will trigger when the instance is idle",
                })}
              </span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>
                {t("devRestartBanner.restartAfterPrefix", { defaultValue: "Restart" })} <code>pnpm dev:once</code>{" "}
                {t("devRestartBanner.restartAfterSuffix", {
                  defaultValue: "after the active work is safe to interrupt",
                })}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
