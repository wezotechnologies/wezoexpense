"use client";

import { useRouter } from "next/navigation";

import { Input } from "@/components/ui/primitives";

/** Month selector that keeps its value in the URL, so views are linkable. */
export function MonthPicker({
  month,
  basePath,
  label = "Month",
}: {
  month: string;
  basePath: string;
  label?: string;
}) {
  const router = useRouter();

  return (
    <label className="flex items-center gap-2">
      <span className="text-[11px] font-medium text-ink-muted">{label}</span>
      <Input
        type="month"
        value={month}
        onChange={(e) => {
          const value = e.target.value;
          router.push(value ? `${basePath}?month=${value}` : basePath);
        }}
        className="w-40"
      />
    </label>
  );
}
