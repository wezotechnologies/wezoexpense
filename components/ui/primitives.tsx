import type { ComponentProps, ReactNode } from "react";

/**
 * Shared presentational primitives for the Wezo design system (spec 4):
 * rounded-lg cards, hairline borders, generous spacing, minimal chrome.
 *
 * None of these declare "use client" — they hold no state and no handlers, so
 * they compose into both Server and Client Components. Interactive widgets live
 * in their own files with an explicit "use client".
 */

/**
 * Joins class names, dropping anything falsy. Takes `unknown` so guards like
 * `cond && "class"` type-check whatever `cond` happens to be.
 */
export function cx(...parts: unknown[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" ");
}

// --------------------------------------------------------------------------
// Button
// --------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors " +
  "disabled:opacity-45 disabled:pointer-events-none select-none whitespace-nowrap";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-contrast hover:bg-accent-strong font-semibold",
  secondary:
    "bg-surface-2 text-ink border border-line hover:border-ink-muted/60",
  ghost: "text-ink-muted hover:text-ink hover:bg-surface-2",
  danger: "bg-expense text-white hover:brightness-110",
  success: "bg-income text-white hover:brightness-110",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  // >= 40px tall so every control is a comfortable touch target (spec 9).
  sm: "h-9 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...props}
    />
  );
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"a"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <a
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...props}
    />
  );
}

// --------------------------------------------------------------------------
// Surfaces
// --------------------------------------------------------------------------

export function Card({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cx(
        "rounded-lg border border-line bg-surface",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-start justify-between gap-4 border-b border-line px-4 py-3 sm:px-5",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// --------------------------------------------------------------------------
// Form fields
// --------------------------------------------------------------------------

const CONTROL =
  "w-full rounded-lg border border-line bg-surface-2 px-3 text-ink " +
  "placeholder:text-ink-muted/70 transition-colors " +
  "hover:border-ink-muted/40 focus:border-accent focus:outline-none " +
  "disabled:opacity-50 disabled:cursor-not-allowed";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(CONTROL, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea className={cx(CONTROL, "min-h-20 py-2", className)} {...props} />
  );
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cx(CONTROL, "h-10 pr-8 appearance-none cursor-pointer", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23A1A1A1' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.6rem center",
        backgroundSize: "0.85rem",
      }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cx("block text-xs font-medium text-ink-muted", className)}
      {...props}
    />
  );
}

/** Label + control + optional hint/error, with ids wired for screen readers. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="ml-0.5 text-expense">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-expense" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-muted/80">{hint}</p>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------
// Feedback
// --------------------------------------------------------------------------

type BadgeTone =
  | "neutral"
  | "income"
  | "expense"
  | "pending"
  | "approved"
  | "rejected"
  | "info"
  | "accent";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-ink-muted border-line",
  income: "bg-income/12 text-income border-income/30",
  expense: "bg-expense/12 text-expense border-expense/30",
  pending: "bg-pending/12 text-pending border-pending/30",
  approved: "bg-approved/12 text-approved border-approved/30",
  rejected: "bg-rejected/12 text-rejected border-rejected/30",
  info: "bg-info/12 text-info border-info/30",
  accent: "bg-accent-soft text-accent border-accent/30",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "warning" | "error" | "success" | "accent";
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-info/30 bg-info/10 text-info",
    warning: "border-pending/30 bg-pending/10 text-pending",
    error: "border-expense/30 bg-expense/10 text-expense",
    success: "border-income/30 bg-income/10 text-income",
    accent: "border-accent/30 bg-accent-soft text-accent",
  } as const;

  return (
    <div
      className={cx("rounded-lg border px-3 py-2.5 text-sm", tones[tone], className)}
      role={tone === "error" ? "alert" : "status"}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? (
        <div className={cx("text-ink/90", title && "mt-0.5")}>{children}</div>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon ? <div className="mb-1 text-ink-muted/60">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-xs text-ink-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx("animate-spin", className ?? "h-4 w-4")}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        className="opacity-25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Thin separator that matches the hairline border language. */
export function Divider({ className }: { className?: string }) {
  return <div className={cx("h-px w-full bg-line", className)} />;
}
