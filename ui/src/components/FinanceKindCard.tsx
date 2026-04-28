import type { FinanceByKind } from "@paperclipai/shared";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { financeEventKindDisplayName, formatCents } from "@/lib/utils";

interface FinanceKindCardProps {
  rows: FinanceByKind[];
}

export function FinanceKindCard({ rows }: FinanceKindCardProps) {
  const { t } = useTranslation("dashboard");

  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-base">
          {t("costs.financeByKind.title", { defaultValue: "Financial event mix" })}
        </CardTitle>
        <CardDescription>
          {t("costs.financeByKind.description", {
            defaultValue: "Account-level charges grouped by event kind.",
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("costs.financeByKind.empty", { defaultValue: "No finance events in this period." })}
          </p>
        ) : (
          rows.map((row) => (
            <div
              key={row.eventKind}
              className="flex items-center justify-between gap-3 border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{financeEventKindDisplayName(row.eventKind)}</div>
                <div className="text-xs text-muted-foreground">
                  {t("costs.financeByKind.eventBillerCounts", {
                    defaultValue: "{{events}} · {{billers}}",
                    events: t("costs.financeByKind.eventCount", {
                      count: row.eventCount,
                      defaultValue_one: "{{count}} event",
                      defaultValue_other: "{{count}} events",
                    }),
                    billers: t("costs.financeByKind.billerCount", {
                      count: row.billerCount,
                      defaultValue_one: "{{count}} biller",
                      defaultValue_other: "{{count}} billers",
                    }),
                  })}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div className="text-sm font-medium">{formatCents(row.netCents)}</div>
                <div className="text-xs text-muted-foreground">
                  {t("costs.financeByKind.debitsValue", {
                    defaultValue: "{{amount}} debits",
                    amount: formatCents(row.debitCents),
                  })}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
